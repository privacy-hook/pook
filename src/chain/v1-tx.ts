import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address as KitAddress,
  type Instruction as KitInstruction,
  type KeyPairSigner,
} from '@solana/kit'
import type { Keypair } from '@solana/web3.js'
import { firstProgramFailure, type ErrorRegistry } from '../engines/tx/server/failure.js'
import type { Rpc } from '../engines/rpc/client.js'

export type RawInstructionInput = {
  programId: string
  accounts: readonly { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  data: Uint8Array
}

export type V1Config = {
  computeUnitLimit?: number
  priorityFeeLamports?: bigint
  loadedAccountsDataSizeLimit?: number
}

export type V1CompiledResult = {
  wireBase64: string
  signature: string
  blockhash: string
  lastValidBlockHeight: bigint
}

export type V1SimulationResult = {
  passed: boolean
  unitsConsumed: number | null
  logs: string[]
  programFailure: ReturnType<typeof firstProgramFailure>
  rawErr: unknown
}

export async function signerFromKeypair(keypair: Keypair): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(keypair.secretKey)
}

function toKitRole(isWritable: boolean, isSigner: boolean): AccountRole {
  if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER
  if (isSigner) return AccountRole.READONLY_SIGNER
  if (isWritable) return AccountRole.WRITABLE
  return AccountRole.READONLY
}

function toKitInstruction(ix: RawInstructionInput): KitInstruction<KitAddress> {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((acc) => ({
      address: address(acc.pubkey),
      role: toKitRole(acc.isWritable, acc.isSigner),
    })),
    data: ix.data,
  }
}

/**
 * Compiles and signs a Solana Transaction v1 message with the relayer as fee payer.
 * Uses `@solana/kit` v1 message config (CU limit, priority fee, loaded accounts limit) so large
 * proof instructions land cleanly on validators that support v1 transactions (Solana 3.x / Rings).
 */
export async function compileAndSignV1Transaction(options: {
  rpc: Rpc
  payer: KeyPairSigner
  instructions: readonly RawInstructionInput[]
  config?: V1Config
}): Promise<V1CompiledResult> {
  const { rpc, payer, instructions, config = {} } = options
  const bhResp = await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number | string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])
  const blockhash = bhResp.value.blockhash
  const lastValidBlockHeight = BigInt(bhResp.value.lastValidBlockHeight)

  const kitInstructions = instructions.map(toKitInstruction)
  const txMessage = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]['blockhash'],
          lastValidBlockHeight,
        },
        m,
      ),
    (m) =>
      setTransactionMessageConfig(
        {
          computeUnitLimit: config.computeUnitLimit ?? 1_400_000,
          loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit ?? 64 * 1024 * 1024,
          priorityFeeLamports: config.priorityFeeLamports ?? 0n,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(kitInstructions, m),
  )

  const compiled = compileTransaction(txMessage)
  const signed = await signTransaction([payer.keyPair], compiled)
  const wireBase64 = getBase64EncodedWireTransaction(signed)
  const signature = getSignatureFromTransaction(signed)

  return { wireBase64, signature, blockhash, lastValidBlockHeight }
}

/** Simulates a base64 wire transaction (v0 or v1) and decodes any first program error. */
export async function simulateWireTransaction(options: {
  rpc: Rpc
  wireBase64: string
  sigVerify?: boolean
  registry?: ErrorRegistry
}): Promise<V1SimulationResult> {
  const resp = await options.rpc.call<{
    value: { err: unknown; logs?: string[] | null; unitsConsumed?: number | string | null }
  }>('simulateTransaction', [
    options.wireBase64,
    {
      encoding: 'base64',
      sigVerify: options.sigVerify ?? true,
      replaceRecentBlockhash: !(options.sigVerify ?? true),
      commitment: 'confirmed',
    },
  ])
  const logs = resp.value.logs ?? []
  const unitsConsumed = resp.value.unitsConsumed !== undefined && resp.value.unitsConsumed !== null ? Number(resp.value.unitsConsumed) : null
  if (resp.value.err) {
    return {
      passed: false,
      unitsConsumed,
      logs,
      programFailure: firstProgramFailure(logs, options.registry),
      rawErr: resp.value.err,
    }
  }
  return {
    passed: true,
    unitsConsumed,
    logs,
    programFailure: null,
    rawErr: null,
  }
}

/** Sends a signed base64 wire transaction (v1) via JSON-RPC `sendTransaction`. */
export async function sendWireTransaction(rpc: Rpc, wireBase64: string): Promise<string> {
  return rpc.call<string>('sendTransaction', [
    wireBase64,
    {
      encoding: 'base64',
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: 'confirmed',
    },
  ])
}

export type FollowV1Status =
  | { status: 'confirmed'; slot: bigint }
  | { status: 'failed'; slot: bigint | null; logs: string[]; programFailure: ReturnType<typeof firstProgramFailure> }
  | { status: 'expired' }
  | { status: 'submitted' }

/** Reconciles one step of a relayed v1 transaction (or polls briefly). */
export async function reconcileV1Transaction(options: {
  rpc: Rpc
  signature: string
  wireBase64?: string
  lastValidBlockHeight?: bigint
  registry?: ErrorRegistry
}): Promise<FollowV1Status> {
  const { rpc, signature, wireBase64, lastValidBlockHeight, registry } = options
  const statusResp = await rpc.call<{
    value: ({ slot: number | string; err: unknown; confirmationStatus?: string | null } | null)[]
  }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
  const st = statusResp.value[0]
  if (st?.err) {
    const tx = await rpc
      .call<{ meta?: { logMessages?: string[] | null } | null } | null>('getTransaction', [
        signature,
        { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 },
      ])
      .catch(() => null)
    const logs = tx?.meta?.logMessages ?? []
    return {
      status: 'failed',
      slot: BigInt(st.slot),
      logs,
      programFailure: firstProgramFailure(logs, registry),
    }
  }
  if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
    return { status: 'confirmed', slot: BigInt(st.slot) }
  }
  if (!st && lastValidBlockHeight !== undefined) {
    const height = BigInt(await rpc.call<number | string>('getBlockHeight', [{ commitment: 'confirmed' }]))
    if (height > lastValidBlockHeight) {
      return { status: 'expired' }
    }
    if (wireBase64) {
      await sendWireTransaction(rpc, wireBase64).catch(() => {})
    }
  }
  return { status: 'submitted' }
}
