import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  CONTRACT_VERSION,
  INSTRUCTIONS_SYSVAR_ID,
  KAMINO_FARMS_PROGRAM_ID,
  KAMINO_LEND_PROGRAM_ID,
  KAMINO_MAIN_MARKET,
  POOK_TAGS,
  RelayLeaveRequest,
  RelayRunRequest,
  RelaySeatRequest,
  RelayerQuoteQuery,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_ID,
  WSOL_MINT,
  decodeHookAccount,
  decodeLeaveIxData,
  decodeRunIxData,
  decodeSeatLifecycleIxData,
  fromBase64,
  toHex,
  type RelaySubmissionResponse,
  type WireHookAccount,
  type WireSetupCpi,
} from '@pook/contract'
import { env, fail, relayerFeeForMint, rpcUrlForCluster } from '../config.js'
import { ConfigCache } from '../chain/accounts.js'
import { decodeKaminoObligation } from '../chain/kamino-obligation.js'
import {
  findAta,
  findAuthorFeesPda,
  findConfigPda,
  findSeatPda,
  findSeatStatePda,
  findStagePda,
  pookErrorRegistry,
} from '../chain/pda.js'
import {
  compileAndSignV1Transaction,
  reconcileV1Transaction,
  sendWireTransaction,
  signerFromKeypair,
  simulateWireTransaction,
  type RawInstructionInput,
} from '../chain/v1-tx.js'
import { createRpc } from '../engines/rpc/client.js'
import { createApi } from '../engines/server/app.js'
import { createDatabase } from '../engines/server/db.js'
import { readJson, readQuery } from '../engines/server/input.js'
import { serve } from '../engines/server/serve.js'
import { keypairFromSecret } from '../engines/tx/server/keys.js'

type RelayEntry = {
  response: RelaySubmissionResponse
  wireBase64?: string
  lastValidBlockHeight?: bigint
}

const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58()
const ATA_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
const SPL_TOKEN_ID = TOKEN_PROGRAM_ID.toBase58()
const SPL_TOKEN_2022_ID = TOKEN_2022_PROGRAM_ID.toBase58()
const KAMINO_LEND_PK = new PublicKey(KAMINO_LEND_PROGRAM_ID)
const KAMINO_MAIN_MARKET_PK = new PublicKey(KAMINO_MAIN_MARKET)

const KAMINO_INIT_USER_METADATA_DISC = '75a9b045c5170fa2'
const KAMINO_INIT_OBLIGATION_DISC = 'fb0ae74c1b0b9f60'
const KAMINO_INIT_OBLIGATION_FARMS_DISC = '883f0fbad398a8a4'

function loadRelayerKeypair(): Keypair | null {
  if (!env.RELAYER_SECRET_KEY) return null
  return keypairFromSecret('RELAYER_SECRET_KEY', env.RELAYER_SECRET_KEY)
}

function isAllZero32(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false
  return true
}

function mintBytesToDisplay(bytes: Uint8Array): string {
  return isAllZero32(bytes) ? WSOL_MINT : new PublicKey(bytes).toBase58()
}

function deriveKaminoUserMetadataPda(seatPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('user_meta'), seatPda.toBytes()], KAMINO_LEND_PK)[0]
}

function deriveKaminoObligationPda(seatPda: PublicKey, market: PublicKey = KAMINO_MAIN_MARKET_PK): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), seatPda.toBytes(), market.toBytes(), Buffer.alloc(32), Buffer.alloc(32)],
    KAMINO_LEND_PK,
  )[0]
}

function assertNotExpired(expiry: bigint, label: string) {
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (expiry <= nowSec) {
    return fail('TRANSACTION_EXPIRED', `${label} instruction is already expired.`, {
      stage: 'relay',
      retryable: true,
    })
  }
}

function assertNoRelayerOrSigner(ix: RawInstructionInput, relayerPubkey: string, label: string) {
  for (const acc of ix.accounts) {
    if (acc.pubkey === relayerPubkey) {
      return fail('RELAY_REFUSED', `Relayer refused ${label} instruction referencing relayer key.`, {
        stage: 'relay',
        retryable: false,
      })
    }
    if (acc.isSigner) {
      return fail('RELAY_REFUSED', `Relayer refused ${label} instruction requiring signer ${acc.pubkey}.`, {
        stage: 'relay',
        retryable: false,
      })
    }
  }
}

type AllowedAtaCheck = (owner: string, mint: string, ata: string) => boolean

function validateIdempotentAtaCreate(
  ix: RawInstructionInput,
  relayerPubkey: string,
  seenAtaCreates: Set<string>,
  isAllowed: AllowedAtaCheck,
) {
  if (ix.data.length !== 1 || ix.data[0] !== 1) {
    return fail('RELAY_REFUSED', 'Only AssociatedTokenAccount CreateIdempotent (1) instructions are allowed.', {
      stage: 'relay',
      retryable: false,
    })
  }
  if (ix.accounts.length !== 6) {
    return fail('RELAY_REFUSED', 'Malformed AssociatedTokenAccount CreateIdempotent instruction.', {
      stage: 'relay',
      retryable: false,
    })
  }
  const funder = ix.accounts[0]!
  const ata = ix.accounts[1]!
  const owner = ix.accounts[2]!
  const mint = ix.accounts[3]!
  const sysProg = ix.accounts[4]!
  const tokenProg = ix.accounts[5]!

  if (funder.pubkey !== relayerPubkey || !funder.isSigner) {
    return fail('RELAY_REFUSED', 'ATA create funder must be the relayer signer.', {
      stage: 'relay',
      retryable: false,
    })
  }
  if (sysProg.pubkey !== SYSTEM_PROGRAM_ID) {
    return fail('RELAY_REFUSED', 'ATA create system program account mismatch.', {
      stage: 'relay',
      retryable: false,
    })
  }
  if (tokenProg.pubkey !== SPL_TOKEN_ID && tokenProg.pubkey !== SPL_TOKEN_2022_ID) {
    return fail('RELAY_REFUSED', `ATA create token program ${tokenProg.pubkey} is not allowed.`, {
      stage: 'relay',
      retryable: false,
    })
  }
  for (let i = 1; i < ix.accounts.length; i++) {
    const acc = ix.accounts[i]!
    if (acc.isSigner) {
      return fail('RELAY_REFUSED', `ATA create must not mark account ${i} as signer.`, {
        stage: 'relay',
        retryable: false,
      })
    }
    if (i !== 2 && acc.pubkey === relayerPubkey) {
      return fail('RELAY_REFUSED', 'Relayer key may only appear as ATA funder or owner.', {
        stage: 'relay',
        retryable: false,
      })
    }
  }
  let expectedAta: string
  try {
    expectedAta = findAta(new PublicKey(owner.pubkey), new PublicKey(mint.pubkey), new PublicKey(tokenProg.pubkey))[0].toBase58()
  } catch {
    return fail('RELAY_REFUSED', 'ATA create carries an invalid public key.', {
      stage: 'relay',
      retryable: false,
    })
  }
  if (ata.pubkey !== expectedAta) {
    return fail('RELAY_REFUSED', 'ATA create address does not match derived ATA.', {
      stage: 'relay',
      retryable: false,
    })
  }
  if (!isAllowed(owner.pubkey, mint.pubkey, ata.pubkey)) {
    return fail('RELAY_REFUSED', `Relayer refused ATA create for disallowed owner ${owner.pubkey} and mint ${mint.pubkey}.`, {
      stage: 'relay',
      retryable: false,
    })
  }
  const dedupeKey = `${owner.pubkey}:${mint.pubkey}`
  if (seenAtaCreates.has(dedupeKey)) {
    return fail('RELAY_REFUSED', `Relayer refused duplicate ATA create for ${dedupeKey}.`, {
      stage: 'relay',
      retryable: false,
    })
  }
  seenAtaCreates.add(dedupeKey)
}

function validateKaminoFarmInitIx(
  ix: RawInstructionInput,
  relayerPubkey: string,
  seatPda: string,
  obligationPda: string,
  seenModes: Set<number>,
) {
  if (ix.data.length !== 9 || toHex(ix.data.subarray(0, 8)) !== KAMINO_INIT_OBLIGATION_FARMS_DISC) {
    return fail('RELAY_REFUSED', 'Relayer refused unrecognized Kamino setup instruction.', {
      stage: 'relay',
      retryable: false,
    })
  }
  const mode = ix.data[8]!
  if (mode !== 0 && mode !== 1) {
    return fail('RELAY_REFUSED', `Relayer refused Kamino farm init with invalid mode ${mode}.`, {
      stage: 'relay',
      retryable: false,
    })
  }
  if (seenModes.has(mode)) {
    return fail('RELAY_REFUSED', `Relayer refused duplicate Kamino farm init for mode ${mode}.`, {
      stage: 'relay',
      retryable: false,
    })
  }
  if (ix.accounts.length !== 11) {
    return fail('RELAY_REFUSED', 'Relayer refused Kamino farm init with wrong account count.', {
      stage: 'relay',
      retryable: false,
    })
  }
  const a0 = ix.accounts[0]!
  if (a0.pubkey !== relayerPubkey || !a0.isSigner) {
    return fail('RELAY_REFUSED', 'Kamino farm init account 0 must be the relayer rent payer.', {
      stage: 'relay',
      retryable: false,
    })
  }
  if (
    ix.accounts[1]!.pubkey !== seatPda ||
    ix.accounts[2]!.pubkey !== obligationPda ||
    ix.accounts[7]!.pubkey !== KAMINO_MAIN_MARKET ||
    ix.accounts[8]!.pubkey !== KAMINO_FARMS_PROGRAM_ID ||
    ix.accounts[9]!.pubkey !== SYSVAR_RENT_ID ||
    ix.accounts[10]!.pubkey !== SYSTEM_PROGRAM_ID
  ) {
    return fail('RELAY_REFUSED', 'Kamino farm init accounts do not match the seat obligation and Kamino main market.', {
      stage: 'relay',
      retryable: false,
    })
  }
  for (let i = 1; i < ix.accounts.length; i++) {
    const acc = ix.accounts[i]!
    if (acc.pubkey === relayerPubkey || acc.isSigner) {
      return fail('RELAY_REFUSED', `Relayer refused Kamino farm init with relayer or signer at account ${i}.`, {
        stage: 'relay',
        retryable: false,
      })
    }
  }
  seenModes.add(mode)
}

function validateOpenSeatSetupCpis(
  setupCpis: readonly WireSetupCpi[],
  setupAccounts: readonly { pubkey: string; isWritable: boolean; isSigner: boolean }[],
  relayerPubkey: string,
  seatPda: PublicKey,
) {
  if (setupCpis.length === 0) {
    if (setupAccounts.length !== 0) {
      return fail('RELAY_REFUSED', 'open_seat carries trailing setup accounts without setup_cpis.', {
        stage: 'relay',
        retryable: false,
      })
    }
    return
  }

  for (const acc of setupAccounts) {
    if (acc.pubkey === relayerPubkey || acc.isSigner) {
      return fail('RELAY_REFUSED', 'open_seat setup accounts must not contain the relayer key or extra signers.', {
        stage: 'relay',
        retryable: false,
      })
    }
  }

  const userMetadata = deriveKaminoUserMetadataPda(seatPda).toBase58()
  const obligation = deriveKaminoObligationPda(seatPda, KAMINO_MAIN_MARKET_PK).toBase58()
  const resolveIndex = (idx: number): string | null => {
    if (idx === 0) return relayerPubkey
    if (idx === 1) return seatPda.toBase58()
    if (idx === 2) return SYSTEM_PROGRAM_ID
    const extra = setupAccounts[idx - 3]
    return extra ? extra.pubkey : null
  }

  let sawUserMeta = false
  let sawObligation = false
  const seenFarmModes = new Set<number>()

  for (const cpi of setupCpis) {
    if (cpi.targetProgram !== KAMINO_LEND_PROGRAM_ID) {
      return fail('RELAY_REFUSED', `Relayer refused open_seat setup CPI targeting ${cpi.targetProgram}.`, {
        stage: 'relay',
        retryable: false,
      })
    }
    if (cpi.data.length < 8) {
      return fail('RELAY_REFUSED', 'Relayer refused open_seat setup CPI with short data.', {
        stage: 'relay',
        retryable: false,
      })
    }
    const disc = toHex(cpi.data.subarray(0, 8))

    if (disc === KAMINO_INIT_USER_METADATA_DISC) {
      if (sawUserMeta || cpi.data.length !== 40 || cpi.accounts.length !== 6) {
        return fail('RELAY_REFUSED', 'Relayer refused malformed or duplicate Kamino init_user_metadata setup CPI.', {
          stage: 'relay',
          retryable: false,
        })
      }
      const expected = [
        { pubkey: seatPda.toBase58(), isSigner: true, isPayerSlot: false },
        { pubkey: relayerPubkey, isSigner: true, isPayerSlot: true },
        { pubkey: userMetadata, isSigner: false, isPayerSlot: false },
        { pubkey: KAMINO_LEND_PROGRAM_ID, isSigner: false, isPayerSlot: false },
        { pubkey: SYSVAR_RENT_ID, isSigner: false, isPayerSlot: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isPayerSlot: false },
      ]
      for (let i = 0; i < expected.length; i++) {
        const meta = cpi.accounts[i]!
        const exp = expected[i]!
        const resolved = resolveIndex(meta.accountIndex)
        if (
          resolved !== exp.pubkey ||
          meta.isSigner !== exp.isSigner ||
          (exp.isPayerSlot ? meta.accountIndex !== 0 : meta.accountIndex === 0)
        ) {
          return fail('RELAY_REFUSED', `Kamino init_user_metadata setup CPI account ${i} mismatch.`, {
            stage: 'relay',
            retryable: false,
          })
        }
      }
      sawUserMeta = true
    } else if (disc === KAMINO_INIT_OBLIGATION_DISC) {
      if (sawObligation || cpi.data.length !== 10 || cpi.accounts.length !== 9) {
        return fail('RELAY_REFUSED', 'Relayer refused malformed or duplicate Kamino init_obligation setup CPI.', {
          stage: 'relay',
          retryable: false,
        })
      }
      const expected = [
        { pubkey: seatPda.toBase58(), isSigner: true, isPayerSlot: false },
        { pubkey: relayerPubkey, isSigner: true, isPayerSlot: true },
        { pubkey: obligation, isSigner: false, isPayerSlot: false },
        { pubkey: KAMINO_MAIN_MARKET, isSigner: false, isPayerSlot: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isPayerSlot: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isPayerSlot: false },
        { pubkey: userMetadata, isSigner: false, isPayerSlot: false },
        { pubkey: SYSVAR_RENT_ID, isSigner: false, isPayerSlot: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isPayerSlot: false },
      ]
      for (let i = 0; i < expected.length; i++) {
        const meta = cpi.accounts[i]!
        const exp = expected[i]!
        const resolved = resolveIndex(meta.accountIndex)
        if (
          resolved !== exp.pubkey ||
          meta.isSigner !== exp.isSigner ||
          (exp.isPayerSlot ? meta.accountIndex !== 0 : meta.accountIndex === 0)
        ) {
          return fail('RELAY_REFUSED', `Kamino init_obligation setup CPI account ${i} mismatch.`, {
            stage: 'relay',
            retryable: false,
          })
        }
      }
      sawObligation = true
    } else if (disc === KAMINO_INIT_OBLIGATION_FARMS_DISC) {
      if (cpi.data.length !== 9 || cpi.accounts.length !== 11) {
        return fail('RELAY_REFUSED', 'Relayer refused malformed Kamino init_obligation_farms_for_reserve setup CPI.', {
          stage: 'relay',
          retryable: false,
        })
      }
      const mode = cpi.data[8]!
      if ((mode !== 0 && mode !== 1) || seenFarmModes.has(mode)) {
        return fail('RELAY_REFUSED', `Relayer refused Kamino farm init setup CPI with mode ${mode}.`, {
          stage: 'relay',
          retryable: false,
        })
      }
      const c0 = cpi.accounts[0]!
      if (
        c0.accountIndex !== 0 ||
        !c0.isSigner ||
        resolveIndex(cpi.accounts[1]!.accountIndex) !== seatPda.toBase58() ||
        resolveIndex(cpi.accounts[2]!.accountIndex) !== obligation ||
        resolveIndex(cpi.accounts[7]!.accountIndex) !== KAMINO_MAIN_MARKET ||
        resolveIndex(cpi.accounts[8]!.accountIndex) !== KAMINO_FARMS_PROGRAM_ID ||
        resolveIndex(cpi.accounts[9]!.accountIndex) !== SYSVAR_RENT_ID ||
        resolveIndex(cpi.accounts[10]!.accountIndex) !== SYSTEM_PROGRAM_ID
      ) {
        return fail('RELAY_REFUSED', 'Kamino farm init setup CPI accounts mismatch.', {
          stage: 'relay',
          retryable: false,
        })
      }
      for (let i = 1; i < cpi.accounts.length; i++) {
        const meta = cpi.accounts[i]!
        if (meta.accountIndex === 0 || meta.isSigner) {
          return fail('RELAY_REFUSED', `Kamino farm init setup CPI account ${i} must not be payer or signer.`, {
            stage: 'relay',
            retryable: false,
          })
        }
      }
      seenFarmModes.add(mode)
    } else {
      return fail('RELAY_REFUSED', `Relayer refused unknown Kamino setup CPI discriminator ${disc}.`, {
        stage: 'relay',
        retryable: false,
      })
    }
  }
}

function assertNoExtraSigners(instructions: readonly RawInstructionInput[], relayerPubkey: string) {
  for (const ix of instructions) {
    for (const acc of ix.accounts) {
      if (acc.isSigner && acc.pubkey !== relayerPubkey) {
        return fail('RELAY_REFUSED', `Relayer refused instruction requiring unexpected signer ${acc.pubkey}.`, {
          stage: 'relay',
          retryable: false,
        })
      }
    }
  }
}

const keypair = loadRelayerKeypair()
const relayerSigner = keypair ? await signerFromKeypair(keypair) : null
const relayerPubkey = keypair?.publicKey.toBase58() ?? null
const rpcUrl = rpcUrlForCluster(env)
const rpc = createRpc({
  url: rpcUrl,
  service: 'pook-relayer',
  ...(env.CLUSTER === 'mainnet' ? { rps: 10, scanIntervalMs: 30_000 } : {}),
})
const database = env.DATABASE_URL ? createDatabase(env.DATABASE_URL, (adapter) => new PrismaClient({ adapter })) : null
const registry = env.POOK_PROGRAM_ID ? pookErrorRegistry(env.POOK_PROGRAM_ID) : new Map()
const jobs = new Map<string, RelayEntry>()

const hookCache = new Map<string, WireHookAccount>()
const configCache = env.POOK_PROGRAM_ID ? new ConfigCache(rpc.connection, new PublicKey(env.POOK_PROGRAM_ID), 60_000) : null

async function readHookByAddress(programId: string, hookAddress: string): Promise<WireHookAccount | null> {
  const hit = hookCache.get(hookAddress)
  if (hit) return hit
  let pk: PublicKey
  try {
    pk = new PublicKey(hookAddress)
  } catch {
    return null
  }
  const info = await rpc.connection.getAccountInfo(pk, 'confirmed')
  if (!info || info.owner.toBase58() !== programId) return null
  try {
    const decoded = decodeHookAccount(info.data)
    hookCache.set(hookAddress, decoded)
    return decoded
  } catch {
    return null
  }
}

async function persistRelayJob(
  entry: RelaySubmissionResponse,
  meta: { mintIn?: string | null; mintOut?: string | null; amountIn: string; minimumOut: string; expiryUnixTs: string },
) {
  if (!database) return
  try {
    await database.db.relayJob.upsert({
      where: { id: entry.relayId },
      create: {
        id: entry.relayId,
        kind: entry.kind,
        hookId: entry.hookId ?? null,
        status: entry.status,
        signature: entry.signature,
        slot: entry.slot ? BigInt(entry.slot) : null,
        mintIn: meta.mintIn ?? null,
        mintOut: meta.mintOut ?? null,
        amountIn: meta.amountIn,
        minimumOut: meta.minimumOut,
        relayerFee: entry.relayerFee,
        expiryUnixTs: BigInt(meta.expiryUnixTs),
        errorCode: entry.error?.code ?? null,
        errorMessage: entry.error?.message ?? null,
      },
      update: {
        status: entry.status,
        signature: entry.signature,
        slot: entry.slot ? BigInt(entry.slot) : null,
        errorCode: entry.error?.code ?? null,
        errorMessage: entry.error?.message ?? null,
      },
    })
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', event: 'relay_job_persist_failed', message: err instanceof Error ? err.message : String(err) }))
  }
}

async function submitRelayedV1(options: {
  relayId: string
  kind: 'run' | 'leave' | 'open_seat' | 'close_seat'
  hookId?: string | null
  seatAddress?: string | null
  instructions: RawInstructionInput[]
  computeUnitLimit?: number
  relayerFee: string
  expiryUnixTs: string
  meta: { mintIn?: string | null; mintOut?: string | null; amountIn: string; minimumOut: string }
}): Promise<RelaySubmissionResponse> {
  if (!relayerSigner || !relayerPubkey) {
    return fail('CONFIGURATION_REQUIRED', 'RELAYER_SECRET_KEY is not configured.', { stage: 'relay', retryable: true })
  }
  assertNoExtraSigners(options.instructions, relayerPubkey)

  const compiled = await compileAndSignV1Transaction({
    rpc,
    payer: relayerSigner,
    instructions: options.instructions,
    config: {
      computeUnitLimit: options.computeUnitLimit ?? 1_400_000,
      priorityFeeLamports: 1_000n,
    },
  })

  const sim = await simulateWireTransaction({ rpc, wireBase64: compiled.wireBase64, registry })
  if (!sim.passed) {
    const failedResp: RelaySubmissionResponse = {
      relayId: options.relayId,
      kind: options.kind,
      status: 'failed',
      signature: compiled.signature,
      slot: null,
      hookId: options.hookId ?? null,
      seatAddress: options.seatAddress ?? null,
      relayerFee: options.relayerFee,
      run: null,
      error: {
        code: 'SIMULATION_FAILED',
        message: sim.programFailure?.message ?? sim.programFailure?.name ?? 'Relayed transaction simulation failed.',
        stage: 'simulation',
        retryable: false,
        ...(sim.programFailure
          ? {
              programError: {
                programId: sim.programFailure.address,
                name: sim.programFailure.name ?? 'UnknownProgramError',
                number: sim.programFailure.code ?? 0,
              },
            }
          : {}),
      },
      expiresAt: new Date(Number(options.expiryUnixTs) * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    }
    jobs.set(options.relayId, { response: failedResp })
    await persistRelayJob(failedResp, { ...options.meta, expiryUnixTs: options.expiryUnixTs })
    return fail('SIMULATION_FAILED', failedResp.error!.message, {
      stage: 'simulation',
      retryable: false,
      programError: failedResp.error?.programError,
    })
  }

  await sendWireTransaction(rpc, compiled.wireBase64)

  const now = new Date().toISOString()
  const expiresAt = new Date(Number(options.expiryUnixTs) * 1000).toISOString()
  let finalStatus: RelaySubmissionResponse['status'] = 'submitted'
  let slot: string | null = null
  let errorDetail: RelaySubmissionResponse['error']

  const initial: RelaySubmissionResponse = {
    relayId: options.relayId,
    kind: options.kind,
    status: 'submitted',
    signature: compiled.signature,
    slot: null,
    hookId: options.hookId ?? null,
    seatAddress: options.seatAddress ?? null,
    relayerFee: options.relayerFee,
    run: null,
    expiresAt,
    updatedAt: now,
  }
  jobs.set(options.relayId, { response: initial, wireBase64: compiled.wireBase64, lastValidBlockHeight: compiled.lastValidBlockHeight })
  await persistRelayJob(initial, { ...options.meta, expiryUnixTs: options.expiryUnixTs })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const step = await reconcileV1Transaction({
      rpc,
      signature: compiled.signature,
      wireBase64: compiled.wireBase64,
      lastValidBlockHeight: compiled.lastValidBlockHeight,
      registry,
    })
    if (step.status === 'confirmed') {
      finalStatus = 'confirmed'
      slot = step.slot.toString()
      break
    }
    if (step.status === 'failed') {
      finalStatus = 'failed'
      slot = step.slot?.toString() ?? null
      errorDetail = {
        code: 'CHAIN_REFUSED',
        message: step.programFailure?.message ?? step.programFailure?.name ?? 'Transaction failed on chain.',
        stage: 'confirmation',
        retryable: false,
        ...(step.programFailure
          ? {
              programError: {
                programId: step.programFailure.address,
                name: step.programFailure.name ?? 'UnknownProgramError',
                number: step.programFailure.code ?? 0,
              },
            }
          : {}),
      }
      break
    }
    if (step.status === 'expired') {
      finalStatus = 'expired'
      errorDetail = {
        code: 'TRANSACTION_EXPIRED',
        message: 'Relayed transaction expired before confirmation.',
        stage: 'confirmation',
        retryable: true,
      }
      break
    }
    await new Promise((r) => setTimeout(r, 750))
  }

  const response: RelaySubmissionResponse = {
    relayId: options.relayId,
    kind: options.kind,
    status: finalStatus,
    signature: compiled.signature,
    slot,
    hookId: options.hookId ?? null,
    seatAddress: options.seatAddress ?? null,
    relayerFee: options.relayerFee,
    run: null,
    ...(errorDetail ? { error: errorDetail } : {}),
    expiresAt,
    updatedAt: new Date().toISOString(),
  }
  jobs.set(options.relayId, { response, wireBase64: compiled.wireBase64, lastValidBlockHeight: compiled.lastValidBlockHeight })
  await persistRelayJob(response, { ...options.meta, expiryUnixTs: options.expiryUnixTs })
  return response
}

const app = createApi({
  origins: env.CORS_ORIGINS,
  allowHeaders: ['Accept', 'X-Fixture', 'X-Fixture-Session'],
  contractVersion: CONTRACT_VERSION,
})

app.get('/health', (c) =>
  c.json({
    status: relayerPubkey && env.POOK_PROGRAM_ID ? 'ready' : 'waiting',
    role: 'relayer',
    relayer: relayerPubkey,
    programId: env.POOK_PROGRAM_ID ?? null,
    asOf: new Date().toISOString(),
  }),
)

app.get('/v1/relayer/quote', (c) => {
  if (!relayerPubkey) return fail('CONFIGURATION_REQUIRED', 'RELAYER_SECRET_KEY is not configured.', { stage: 'build', retryable: true })
  const query = readQuery(c, RelayerQuoteQuery)
  const feeAmount = relayerFeeForMint(query.mint, env)
  return c.json({
    relayer: relayerPubkey,
    mint: query.mint,
    feeAmount: feeAmount.toString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  })
})

app.post('/v1/relayer/run', async (c) => {
  if (!env.POOK_PROGRAM_ID) return fail('PROGRAM_UNAVAILABLE', 'POOK_PROGRAM_ID is not configured.', { stage: 'relay', retryable: true })
  if (!relayerPubkey) return fail('CONFIGURATION_REQUIRED', 'RELAYER_SECRET_KEY is not configured.', { stage: 'relay', retryable: true })

  const body = await readJson(c, RelayRunRequest)
  if (!body.instructionDataBase64 || !body.accounts?.length) {
    return fail('VALIDATION_ERROR', 'Chain relayer requires instructionDataBase64 and accounts.', { stage: 'relay' })
  }
  const ixBytes = fromBase64(body.instructionDataBase64)
  if (ixBytes[0] !== POOK_TAGS.RUN) {
    return fail('RELAY_REFUSED', 'Instruction tag must be pook::run (4).', { stage: 'relay' })
  }

  let decoded: ReturnType<typeof decodeRunIxData>
  try {
    decoded = decodeRunIxData(ixBytes)
  } catch (err) {
    return fail('RELAY_REFUSED', `Could not decode pook::run instruction data: ${err instanceof Error ? err.message : String(err)}`, {
      stage: 'relay',
      retryable: false,
    })
  }

  const pid = new PublicKey(env.POOK_PROGRAM_ID)
  const configPda = findConfigPda(pid)[0].toBase58()
  const stagePda = findStagePda(pid)[0].toBase58()
  const accounts = body.accounts

  if (accounts.length < 8) {
    return fail('RELAY_REFUSED', 'pook::run instruction has fewer than 8 required accounts.', { stage: 'relay' })
  }
  if (accounts[0]!.pubkey !== relayerPubkey || !accounts[0]!.isSigner) {
    return fail('RELAY_REFUSED', 'pook::run account 0 must be the relayer signer.', { stage: 'relay' })
  }
  if (accounts[1]!.pubkey !== configPda) {
    return fail('RELAY_REFUSED', 'pook::run account 1 must be the Pook Config PDA.', { stage: 'relay' })
  }
  if (accounts[3]!.pubkey !== stagePda) {
    return fail('RELAY_REFUSED', 'pook::run account 3 must be the Pook Stage PDA.', { stage: 'relay' })
  }
  if (accounts[5]!.pubkey !== SYSTEM_PROGRAM_ID) {
    return fail('RELAY_REFUSED', 'pook::run account 5 must be the System Program.', { stage: 'relay' })
  }
  if (accounts[7]!.pubkey !== env.RINGS_PROGRAM_ID) {
    return fail('RELAY_REFUSED', 'pook::run account 7 must be the Rings Shielded Pool Program.', { stage: 'relay' })
  }

  // Read the Hook account directly from account index 2 of pook::run (cached per address).
  const hookAddr = accounts[2]!.pubkey
  const [onChainHook, onChainConfig] = await Promise.all([
    readHookByAddress(env.POOK_PROGRAM_ID, hookAddr),
    configCache?.read() ?? Promise.resolve(null),
  ])
  if (!onChainHook) {
    return fail('NOT_FOUND', `Hook account ${hookAddr} does not exist on chain.`, { stage: 'relay' })
  }
  if (accounts[4]!.pubkey !== onChainHook.targetProgram) {
    return fail('RELAY_REFUSED', 'pook::run account 4 does not match the on-chain hook target program.', { stage: 'relay' })
  }

  // Refuse hooks that ask for a Payer account slot (none of the launch hooks need one).
  if (onChainHook.accountSlots.some((slot) => slot.kind === 'Payer')) {
    return fail('RELAY_REFUSED', 'Relayer refuses hooks with a Payer account slot.', { stage: 'relay', retryable: false })
  }

  assertNotExpired(decoded.args.expiry, 'pook::run')

  // Derive mints, fee floor, and seat PDA strictly from the decoded instruction data and on-chain Hook.
  const hasMintIn = onChainHook.mintIn.kind !== 'None'
  const inIsSol = isAllZero32(decoded.args.mintIn)
  const mintInDisplay = hasMintIn ? mintBytesToDisplay(decoded.args.mintIn) : null

  const hasMintOut = decoded.args.hasMintOut
  const outIsSol = isAllZero32(decoded.args.mintOut)
  const mintOutDisplay = hasMintOut ? mintBytesToDisplay(decoded.args.mintOut) : null

  if (hasMintOut && mintOutDisplay) {
    const minFee = relayerFeeForMint(mintOutDisplay, env)
    if (decoded.args.relayerFee < minFee) {
      return fail(
        'RELAY_REFUSED',
        `Instruction relayer_fee ${decoded.args.relayerFee.toString()} is below minimum ${minFee.toString()} for ${mintOutDisplay}.`,
        { stage: 'relay', retryable: false },
      )
    }
  }

  const isSeatHook = onChainHook.kind === 'seat'
  if (isSeatHook && decoded.args.kind === 'Flow') {
    return fail('RELAY_REFUSED', 'Seat hook cannot run with Flow run kind.', { stage: 'relay' })
  }
  if (!isSeatHook && decoded.args.kind !== 'Flow') {
    return fail('RELAY_REFUSED', 'Flow hook cannot run with Seat run kind.', { stage: 'relay' })
  }

  const seatStatePda = isSeatHook ? findSeatStatePda(pid, decoded.args.seatCommitment)[0].toBase58() : null
  const seatPdaPk = isSeatHook ? findSeatPda(pid, decoded.args.seatCommitment)[0] : null
  const seatPda = seatPdaPk?.toBase58() ?? null
  const obligationPda = seatPdaPk ? deriveKaminoObligationPda(seatPdaPk, KAMINO_MAIN_MARKET_PK).toBase58() : null

  // Walk exact pook::run account layout to pinpoint spp_accounts and verify relayer key placement.
  let idx = 8
  if (hasMintIn) {
    if (inIsSol && onChainHook.wrapSolIn) idx += 2
    else if (!inIsSol) idx += 3
  }
  let solFeeRecipientIdx = -1
  if (hasMintOut) {
    if (outIsSol) {
      solFeeRecipientIdx = idx + 1
      idx += 3
      if (onChainHook.unwrapSolOut) idx += 2
    } else {
      idx += 8
    }
  }
  if (isSeatHook) {
    if (accounts.length < idx + 2) {
      return fail('RELAY_REFUSED', 'pook::run seat hook instruction is missing seat accounts.', { stage: 'relay' })
    }
    if (accounts[idx]!.pubkey !== seatStatePda || accounts[idx + 1]!.pubkey !== seatPda) {
      return fail('RELAY_REFUSED', 'pook::run seat accounts do not match decoded seat_commitment.', { stage: 'relay' })
    }
    idx += 2
  }
  if (onChainHook.companions.length > 0) {
    if (accounts.length < idx + 1 || accounts[idx]!.pubkey !== INSTRUCTIONS_SYSVAR_ID) {
      return fail('RELAY_REFUSED', 'pook::run hook with companions must pass the Instructions sysvar.', { stage: 'relay' })
    }
    idx += 1
  }

  const sppStart = idx
  const sppEnd = sppStart + decoded.args.sppAccountCount
  if (decoded.args.sppAccountCount === 0 || accounts.length < sppEnd) {
    return fail('RELAY_REFUSED', 'pook::run instruction has truncated SPP account slice.', { stage: 'relay' })
  }
  if (accounts[sppStart]!.pubkey !== relayerPubkey || !accounts[sppStart]!.isSigner) {
    return fail('RELAY_REFUSED', 'pook::run SPP account 0 must be the relayer signer.', { stage: 'relay' })
  }

  const configFeeRecipient = onChainConfig?.feeRecipient ?? env.FEE_RECIPIENT ?? null
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]!
    const isPayerSlot = i === 0 || i === sppStart
    const isSelfFeeRecipient = i === solFeeRecipientIdx && configFeeRecipient === relayerPubkey && !acc.isSigner
    if (acc.isSigner && !isPayerSlot) {
      return fail('RELAY_REFUSED', `pook::run account ${i} must not be a signer.`, { stage: 'relay' })
    }
    if (acc.pubkey === relayerPubkey && !isPayerSlot && !isSelfFeeRecipient) {
      return fail('RELAY_REFUSED', `Relayer key is not allowed at pook::run account index ${i}.`, { stage: 'relay' })
    }
  }

  // Allowed ATA (owner, mint) pairs for this run.
  const allowedAtaByOwner = new Map<string, Set<string>>()
  const allowAta = (owner: string | null | undefined, mint: string | null | undefined) => {
    if (!owner || !mint) return
    let set = allowedAtaByOwner.get(owner)
    if (!set) {
      set = new Set()
      allowedAtaByOwner.set(owner, set)
    }
    set.add(mint)
  }

  const inAtaMint = hasMintIn && (!inIsSol || onChainHook.wrapSolIn) ? (inIsSol ? WSOL_MINT : mintInDisplay) : null
  const outAtaMint = hasMintOut && (!outIsSol || onChainHook.unwrapSolOut) ? (outIsSol ? WSOL_MINT : mintOutDisplay) : null
  allowAta(stagePda, inAtaMint)
  allowAta(stagePda, outAtaMint)
  if (seatPda) {
    allowAta(seatPda, inAtaMint)
    allowAta(seatPda, outAtaMint)
  }
  if (hasMintOut && !outIsSol && mintOutDisplay) {
    const authorFeesPda = findAuthorFeesPda(pid, new PublicKey(onChainHook.author), mintOutDisplay)[0].toBase58()
    allowAta(authorFeesPda, mintOutDisplay)
    allowAta(configFeeRecipient, mintOutDisplay)
    allowAta(relayerPubkey, mintOutDisplay)
  }

  const setupIxs: RawInstructionInput[] = (body.setupInstructions ?? []).map((s) => ({
    programId: s.programId,
    accounts: s.accounts,
    data: fromBase64(s.dataBase64),
  }))
  const compIxs: RawInstructionInput[] = (body.companionInstructions ?? []).map((s) => ({
    programId: s.programId,
    accounts: s.accounts,
    data: fromBase64(s.dataBase64),
  }))
  const runIx: RawInstructionInput = {
    programId: env.POOK_PROGRAM_ID,
    accounts,
    data: ixBytes,
  }

  const seenAtaCreates = new Set<string>()
  const seenKaminoFarmModes = new Set<number>()
  const allowedCompanions = onChainHook.companions

  for (const ix of [...setupIxs, ...compIxs]) {
    if (ix.programId === COMPUTE_BUDGET_ID) {
      assertNoRelayerOrSigner(ix, relayerPubkey, 'ComputeBudget')
      continue
    }
    if (ix.programId === ATA_PROGRAM_ID) {
      validateIdempotentAtaCreate(ix, relayerPubkey, seenAtaCreates, (owner, mint) => Boolean(allowedAtaByOwner.get(owner)?.has(mint)))
      continue
    }
    if (
      isSeatHook &&
      seatPda &&
      obligationPda &&
      ix.programId === KAMINO_LEND_PROGRAM_ID &&
      ix.data.length === 9 &&
      toHex(ix.data.subarray(0, 8)) === KAMINO_INIT_OBLIGATION_FARMS_DISC
    ) {
      validateKaminoFarmInitIx(ix, relayerPubkey, seatPda, obligationPda, seenKaminoFarmModes)
      continue
    }
    const matched = allowedCompanions.some((comp) => {
      if (ix.programId !== comp.programId || ix.data.length < comp.discLen) return false
      const prefix = toHex(ix.data.subarray(0, comp.discLen))
      return prefix === comp.discriminatorHex.slice(0, comp.discLen * 2).toLowerCase()
    })
    if (matched) {
      assertNoRelayerOrSigner(ix, relayerPubkey, `companion (${ix.programId})`)
      continue
    }
    return fail('RELAY_REFUSED', `Relayer refused instruction for disallowed program ${ix.programId}.`, {
      stage: 'relay',
      retryable: false,
    })
  }

  const instructions = [...setupIxs, ...compIxs, runIx]
  const resp = await submitRelayedV1({
    relayId: `relay_run_${randomUUID().slice(0, 12)}`,
    kind: 'run',
    hookId: body.hookId,
    seatAddress: seatPda,
    instructions,
    computeUnitLimit: body.computeUnitLimit,
    relayerFee: decoded.args.relayerFee.toString(),
    expiryUnixTs: decoded.args.expiry.toString(),
    meta: {
      mintIn: mintInDisplay,
      mintOut: mintOutDisplay,
      amountIn: decoded.args.amountIn.toString(),
      minimumOut: decoded.args.minOut.toString(),
    },
  })
  return c.json(resp, 201)
})

app.post('/v1/relayer/leave', async (c) => {
  if (!env.POOK_PROGRAM_ID) return fail('PROGRAM_UNAVAILABLE', 'POOK_PROGRAM_ID is not configured.', { stage: 'relay', retryable: true })
  if (!relayerPubkey) return fail('CONFIGURATION_REQUIRED', 'RELAYER_SECRET_KEY is not configured.', { stage: 'relay', retryable: true })

  const body = await readJson(c, RelayLeaveRequest)
  if (!body.instructionDataBase64 || !body.accounts?.length) {
    return fail('VALIDATION_ERROR', 'Chain relayer requires instructionDataBase64 and accounts.', { stage: 'relay' })
  }
  const ixBytes = fromBase64(body.instructionDataBase64)
  if (ixBytes[0] !== POOK_TAGS.LEAVE) {
    return fail('RELAY_REFUSED', 'Instruction tag must be pook::leave (5).', { stage: 'relay' })
  }

  let decoded: ReturnType<typeof decodeLeaveIxData>
  try {
    decoded = decodeLeaveIxData(ixBytes)
  } catch (err) {
    return fail('RELAY_REFUSED', `Could not decode pook::leave instruction data: ${err instanceof Error ? err.message : String(err)}`, {
      stage: 'relay',
      retryable: false,
    })
  }

  assertNotExpired(decoded.args.expiry, 'pook::leave')

  const pid = new PublicKey(env.POOK_PROGRAM_ID)
  const stagePda = findStagePda(pid)[0].toBase58()
  const isSol = isAllZero32(decoded.args.mint)
  const leaveMint = mintBytesToDisplay(decoded.args.mint)
  const accounts = body.accounts

  const minFee = relayerFeeForMint(leaveMint, env)
  if (decoded.args.relayerFee < minFee) {
    return fail(
      'RELAY_REFUSED',
      `Instruction relayer_fee ${decoded.args.relayerFee.toString()} is below minimum ${minFee.toString()} for ${leaveMint}.`,
      { stage: 'relay', retryable: false },
    )
  }

  if (decoded.args.leaveKind !== 0 && decoded.args.leaveKind !== 1) {
    return fail('RELAY_REFUSED', `Invalid leave_kind ${decoded.args.leaveKind}.`, { stage: 'relay' })
  }
  const sppStart = decoded.args.leaveKind === 0 ? (isSol ? 4 : 8) : isSol ? 6 : 10
  if (decoded.args.sppAccountCount === 0 || accounts.length !== sppStart + decoded.args.sppAccountCount) {
    return fail('RELAY_REFUSED', 'pook::leave account count does not match decoded instruction.', { stage: 'relay' })
  }
  if (accounts[0]!.pubkey !== relayerPubkey || !accounts[0]!.isSigner) {
    return fail('RELAY_REFUSED', 'pook::leave account 0 must be the relayer signer.', { stage: 'relay' })
  }
  if (accounts[1]!.pubkey !== stagePda || accounts[2]!.pubkey !== SYSTEM_PROGRAM_ID) {
    return fail('RELAY_REFUSED', 'pook::leave stage or system program account mismatch.', { stage: 'relay' })
  }
  if (accounts[sppStart]!.pubkey !== relayerPubkey || !accounts[sppStart]!.isSigner) {
    return fail('RELAY_REFUSED', 'pook::leave SPP account 0 must be the relayer signer.', { stage: 'relay' })
  }
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]!
    const isPayerSlot = i === 0 || i === sppStart
    if (acc.isSigner && !isPayerSlot) {
      return fail('RELAY_REFUSED', `pook::leave account ${i} must not be a signer.`, { stage: 'relay' })
    }
    if (acc.pubkey === relayerPubkey && !isPayerSlot) {
      return fail('RELAY_REFUSED', `Relayer key is not allowed at pook::leave account index ${i}.`, { stage: 'relay' })
    }
  }

  const destAtaForPublicSpl = decoded.args.leaveKind === 0 && !isSol ? accounts[6]!.pubkey : null
  const setupIxs: RawInstructionInput[] = (body.setupInstructions ?? []).map((s) => ({
    programId: s.programId,
    accounts: s.accounts,
    data: fromBase64(s.dataBase64),
  }))
  const seenAtaCreates = new Set<string>()
  for (const ix of setupIxs) {
    if (ix.programId === COMPUTE_BUDGET_ID) {
      assertNoRelayerOrSigner(ix, relayerPubkey, 'ComputeBudget')
      continue
    }
    if (ix.programId === ATA_PROGRAM_ID && !isSol) {
      validateIdempotentAtaCreate(ix, relayerPubkey, seenAtaCreates, (owner, mint, ata) => {
        if (mint !== leaveMint) return false
        if (owner === stagePda || owner === relayerPubkey) return true
        return destAtaForPublicSpl !== null && ata === destAtaForPublicSpl
      })
      continue
    }
    return fail('RELAY_REFUSED', `Relayer refused setup instruction for program ${ix.programId} on leave.`, {
      stage: 'relay',
      retryable: false,
    })
  }

  const leaveIx: RawInstructionInput = {
    programId: env.POOK_PROGRAM_ID,
    accounts,
    data: ixBytes,
  }

  const resp = await submitRelayedV1({
    relayId: `relay_leave_${randomUUID().slice(0, 12)}`,
    kind: 'leave',
    instructions: [...setupIxs, leaveIx],
    computeUnitLimit: body.computeUnitLimit,
    relayerFee: decoded.args.relayerFee.toString(),
    expiryUnixTs: decoded.args.expiry.toString(),
    meta: {
      mintIn: leaveMint,
      mintOut: leaveMint,
      amountIn: decoded.args.amount.toString(),
      minimumOut: decoded.args.amount.toString(),
    },
  })
  return c.json(resp, 201)
})

app.post('/v1/relayer/seat/open', async (c) => {
  if (!env.POOK_PROGRAM_ID) return fail('PROGRAM_UNAVAILABLE', 'POOK_PROGRAM_ID is not configured.', { stage: 'relay', retryable: true })
  if (!relayerPubkey) return fail('CONFIGURATION_REQUIRED', 'RELAYER_SECRET_KEY is not configured.', { stage: 'relay', retryable: true })

  const body = await readJson(c, RelaySeatRequest)
  const ixBytes = fromBase64(body.instructionDataBase64)
  if (ixBytes[0] !== POOK_TAGS.OPEN_SEAT) {
    return fail('RELAY_REFUSED', `Instruction tag must match open_seat (${POOK_TAGS.OPEN_SEAT}).`, { stage: 'relay' })
  }

  let decoded: ReturnType<typeof decodeSeatLifecycleIxData>
  try {
    decoded = decodeSeatLifecycleIxData(ixBytes)
  } catch (err) {
    return fail('RELAY_REFUSED', `Could not decode open_seat instruction: ${err instanceof Error ? err.message : String(err)}`, {
      stage: 'relay',
      retryable: false,
    })
  }
  if (decoded.tag !== POOK_TAGS.OPEN_SEAT || decoded.args.sppAccountCount === undefined) {
    return fail('RELAY_REFUSED', 'Expected open_seat instruction.', { stage: 'relay' })
  }

  assertNotExpired(decoded.args.expiry, 'pook::open_seat')

  const pid = new PublicKey(env.POOK_PROGRAM_ID)
  const seatStatePda = findSeatStatePda(pid, decoded.args.seatCommitment)[0].toBase58()
  const seatPdaPk = findSeatPda(pid, decoded.args.seatCommitment)[0]
  const seatPda = seatPdaPk.toBase58()
  const accounts = body.accounts

  const sppCount = decoded.args.sppAccountCount
  const sppEnd = 4 + sppCount
  if (sppCount === 0 || accounts.length < sppEnd) {
    return fail('RELAY_REFUSED', 'open_seat instruction has truncated account list.', { stage: 'relay' })
  }
  if (
    accounts[0]!.pubkey !== relayerPubkey ||
    !accounts[0]!.isSigner ||
    accounts[1]!.pubkey !== seatStatePda ||
    accounts[2]!.pubkey !== seatPda ||
    accounts[3]!.pubkey !== SYSTEM_PROGRAM_ID ||
    accounts[4]!.pubkey !== relayerPubkey ||
    !accounts[4]!.isSigner
  ) {
    return fail('RELAY_REFUSED', 'open_seat fixed accounts do not match relayer and decoded seat_commitment.', { stage: 'relay' })
  }
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]!
    const isPayerSlot = i === 0 || i === 4
    if (acc.isSigner && !isPayerSlot) {
      return fail('RELAY_REFUSED', `open_seat account ${i} must not be a signer.`, { stage: 'relay' })
    }
    if (acc.pubkey === relayerPubkey && !isPayerSlot) {
      return fail('RELAY_REFUSED', `Relayer key is not allowed at open_seat account index ${i}.`, { stage: 'relay' })
    }
  }

  const setupAccounts = accounts.slice(sppEnd)
  validateOpenSeatSetupCpis(decoded.args.setupCpis ?? [], setupAccounts, relayerPubkey, seatPdaPk)

  const seatIx: RawInstructionInput = {
    programId: env.POOK_PROGRAM_ID,
    accounts,
    data: ixBytes,
  }
  const resp = await submitRelayedV1({
    relayId: `relay_open_seat_${randomUUID().slice(0, 12)}`,
    kind: 'open_seat',
    seatAddress: seatPda,
    instructions: [seatIx],
    computeUnitLimit: body.computeUnitLimit,
    relayerFee: '0',
    expiryUnixTs: decoded.args.expiry.toString(),
    meta: { amountIn: '0', minimumOut: '0' },
  })
  return c.json(resp, 201)
})

app.post('/v1/relayer/seat/close', async (c) => {
  if (!env.POOK_PROGRAM_ID) return fail('PROGRAM_UNAVAILABLE', 'POOK_PROGRAM_ID is not configured.', { stage: 'relay', retryable: true })
  if (!relayerPubkey) return fail('CONFIGURATION_REQUIRED', 'RELAYER_SECRET_KEY is not configured.', { stage: 'relay', retryable: true })

  const body = await readJson(c, RelaySeatRequest)
  const ixBytes = fromBase64(body.instructionDataBase64)
  if (ixBytes[0] !== POOK_TAGS.CLOSE_SEAT) {
    return fail('RELAY_REFUSED', `Instruction tag must match close_seat (${POOK_TAGS.CLOSE_SEAT}).`, { stage: 'relay' })
  }

  let decoded: ReturnType<typeof decodeSeatLifecycleIxData>
  try {
    decoded = decodeSeatLifecycleIxData(ixBytes)
  } catch (err) {
    return fail('RELAY_REFUSED', `Could not decode close_seat instruction: ${err instanceof Error ? err.message : String(err)}`, {
      stage: 'relay',
      retryable: false,
    })
  }
  if (decoded.tag !== POOK_TAGS.CLOSE_SEAT) {
    return fail('RELAY_REFUSED', 'Expected close_seat instruction.', { stage: 'relay' })
  }

  assertNotExpired(decoded.args.expiry, 'pook::close_seat')

  const pid = new PublicKey(env.POOK_PROGRAM_ID)
  const seatStatePda = findSeatStatePda(pid, decoded.args.seatCommitment)[0].toBase58()
  const seatPdaPk = findSeatPda(pid, decoded.args.seatCommitment)[0]
  const seatPda = seatPdaPk.toBase58()
  const accounts = body.accounts

  if (accounts.length < 6) {
    return fail('RELAY_REFUSED', 'close_seat instruction has truncated account list.', { stage: 'relay' })
  }
  if (
    accounts[0]!.pubkey !== relayerPubkey ||
    !accounts[0]!.isSigner ||
    accounts[1]!.pubkey !== seatStatePda ||
    accounts[2]!.pubkey !== seatPda ||
    accounts[4]!.pubkey !== SYSTEM_PROGRAM_ID ||
    accounts[5]!.pubkey !== relayerPubkey ||
    !accounts[5]!.isSigner
  ) {
    return fail('RELAY_REFUSED', 'close_seat fixed accounts do not match relayer and decoded seat_commitment.', { stage: 'relay' })
  }
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]!
    const isPayerSlot = i === 0 || i === 5
    const isOpenerRelayerSlot = i === 3 && !acc.isSigner
    if (acc.isSigner && !isPayerSlot) {
      return fail('RELAY_REFUSED', `close_seat account ${i} must not be a signer.`, { stage: 'relay' })
    }
    if (acc.pubkey === relayerPubkey && !isPayerSlot && !isOpenerRelayerSlot) {
      return fail('RELAY_REFUSED', `Relayer key is not allowed at close_seat account index ${i}.`, { stage: 'relay' })
    }
  }

  // Refuse closing a seat while its Kamino obligation still holds collateral or debt.
  const obligationPda = deriveKaminoObligationPda(seatPdaPk, KAMINO_MAIN_MARKET_PK)
  const obligationInfo = await rpc.connection.getAccountInfo(obligationPda, 'confirmed')
  if (obligationInfo && obligationInfo.data.length > 0) {
    const ob = decodeKaminoObligation(obligationInfo.data)
    if (ob && (ob.deposits.length > 0 || ob.borrows.length > 0)) {
      return fail('SEAT_NOT_EMPTY', 'Seat still has open collateral or debt and cannot be closed.', {
        stage: 'relay',
        retryable: false,
      })
    }
  }

  const seatIx: RawInstructionInput = {
    programId: env.POOK_PROGRAM_ID,
    accounts,
    data: ixBytes,
  }
  const resp = await submitRelayedV1({
    relayId: `relay_close_seat_${randomUUID().slice(0, 12)}`,
    kind: 'close_seat',
    seatAddress: seatPda,
    instructions: [seatIx],
    computeUnitLimit: body.computeUnitLimit,
    relayerFee: '0',
    expiryUnixTs: decoded.args.expiry.toString(),
    meta: { amountIn: '0', minimumOut: '0' },
  })
  return c.json(resp, 201)
})

app.get('/v1/relayer/runs/:relayId', async (c) => {
  const relayId = c.req.param('relayId')
  const entry = jobs.get(relayId)
  if (entry) {
    if (entry.response.status === 'submitted' && entry.response.signature) {
      const step = await reconcileV1Transaction({
        rpc,
        signature: entry.response.signature,
        wireBase64: entry.wireBase64,
        lastValidBlockHeight: entry.lastValidBlockHeight,
        registry,
      })
      if (step.status === 'confirmed') {
        entry.response = { ...entry.response, status: 'confirmed', slot: step.slot.toString(), updatedAt: new Date().toISOString() }
      } else if (step.status === 'failed') {
        entry.response = {
          ...entry.response,
          status: 'failed',
          slot: step.slot?.toString() ?? null,
          error: {
            code: 'CHAIN_REFUSED',
            message: step.programFailure?.message ?? step.programFailure?.name ?? 'Transaction failed on chain.',
            stage: 'confirmation',
            retryable: false,
            ...(step.programFailure
              ? {
                  programError: {
                    programId: step.programFailure.address,
                    name: step.programFailure.name ?? 'UnknownProgramError',
                    number: step.programFailure.code ?? 0,
                  },
                }
              : {}),
          },
          updatedAt: new Date().toISOString(),
        }
      } else if (step.status === 'expired') {
        entry.response = {
          ...entry.response,
          status: 'expired',
          error: { code: 'TRANSACTION_EXPIRED', message: 'Relayed transaction expired.', stage: 'confirmation', retryable: true },
          updatedAt: new Date().toISOString(),
        }
      }
    }
    return c.json(entry.response)
  }
  if (database) {
    const row = await database.db.relayJob.findUnique({ where: { id: relayId } })
    if (row) {
      return c.json({
        relayId: row.id,
        kind: row.kind,
        status: row.status,
        signature: row.signature,
        slot: row.slot ? row.slot.toString() : null,
        hookId: row.hookId,
        relayerFee: row.relayerFee,
        run: null,
        expiresAt: new Date(Number(row.expiryUnixTs) * 1000).toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })
    }
  }
  return fail('NOT_FOUND', `Relayed submission "${relayId}" was not found.`, { stage: 'read' })
})

const { server } = serve(app, {
  port: env.RELAYER_PORT,
  host: env.HOST,
  close: async () => {
    await database?.close()
  },
})
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
