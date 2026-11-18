// Client-side cryptography, key derivation, Photon note scanning/decryption, and proving seams.
// Mirrors `program/sdk/src/notes.rs` and `proof.rs` byte for byte using @heliuslabs/spr.

import { sha256 } from '@noble/hashes/sha2.js'
import {
  address as kitAddress,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address as KitAddress,
} from '@solana/kit'
import {
  LocalKeys,
  LocalShieldedKeys,
  NullifierKey,
  SOL_MINT,
  ShieldedAddress,
  ShieldedPublicKey,
  ViewingKey,
  Wallet,
  buildDepositTransaction,
  buildRegistrationTransaction,
  createSprClient,
  initializePoseidon,
  syncWallet,
  type WalletUtxo,
} from '@heliuslabs/spr'
import { X25519PublicKey, bytes31, bytes32, bytes64, ed25519DerivationMessage } from '@heliuslabs/spr/keypair'
import {
  NullifierKeyProofAuthority,
  SignedTeePolicy,
  type ProofAuthority,
  type ProofService,
  type ProverTee,
  type SprClient,
} from '@heliuslabs/spr/client'
import {
  DEFAULT_TREE_ID,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE,
  SPL_TOKEN_PROGRAM_ID,
  encodeTransactInstructionData,
  type TransactInstructionData,
  type TransactWithdrawal,
} from '@heliuslabs/spr/interface'
import {
  ProgramOwner,
  ShieldedPda,
  decodeProgramTransaction,
  toProgramWalletUtxo,
  transactCpiAccounts,
} from '@heliuslabs/spr/program'
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, encryptConfidentialTransfer } from '@heliuslabs/spr/transaction'
import { fetchUserRecord } from '@heliuslabs/spr/wallet'
import {
  EncryptedScheme,
  asField,
  bytesField,
  confidentialUtxo,
  decodeConfidential,
  decodeIndexedInputs,
  decodeProofless,
  equalBytes,
  fetchSplAssetRegistrations,
  hashBytes,
  poseidon,
  prooflessUtxo,
  readOutputData,
  solanaOwnerIdentity,
  splitEmbeddedKey,
  withTransactionKey,
} from '@heliuslabs/spr/internal'
import {
  ApiClientError,
  KAMINO_LEND_PROGRAM_ID,
  KAMINO_MAIN_MARKET,
  NATIVE_SOL_MINT,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_ID,
  WSOL_MINT,
  bytesToDecimalField,
  fromBase58,
  fromBase64,
  fromHex,
  isNativeSolMint,
  sha256Be,
  toBase58,
  toBase64,
  toHex,
  type ConfigResponse,
  type EncryptedNoteRecord,
  type PookApiClient,
  type ProveRequest,
  type ProveResponse,
  type WireSetupCpi,
} from '@pook/contract'
import type { PookWasmModule, WasmProvingSession } from './wasm-types.js'

/** Off-chain derivation payload signed once by the holder's wallet (mirrors e2e.rs). */
export const RINGS_DERIVE_MESSAGE = 'POOK/derive/v1'

const VIEW_DOMAIN = new TextEncoder().encode('POOK/view/v1')
const NF_DOMAIN = new TextEncoder().encode('POOK/nf/v1')
const SEAT_SECRET_DOMAIN = new TextEncoder().encode('POOK/seat/v1')
const SEAT_DOMAIN_U32_BE = 0x504b5354n // u32::from_be_bytes(*b"PKST")

const addressEncoder = getAddressEncoder()

export type WalletSigner = {
  /** Base58 Solana public key of the connected wallet. */
  publicKey: string
  /** Sign an arbitrary message once to derive holder keys locally. */
  signMessage(message: Uint8Array): Promise<Uint8Array>
  /** Sign a serialized Solana transaction (base64) and return signed base64 or a submitted signature. */
  signTransaction?(transactionBase64: string): Promise<{ signedTransactionBase64?: string; signature?: string }>
}

export type HolderKeys = {
  wallet: string
  /** 64-byte wallet signature seed kept strictly in browser memory. */
  seed: Uint8Array
  authorityPda: string
  ownerHash: string
  viewingPkBase64: string
  nullifierSecretHex: string
  /** Derived Rings viewing secret bytes (32B). */
  viewingSecret: Uint8Array
}

export type DecryptedNote = {
  commitment: string
  treeId: number
  leafIndex: number
  slot: string
  signature: string
  timestamp: string
  kind: 'balance' | 'seat'
  action: 'enter' | 'run' | 'leave'
  hookId?: string
  protocol?: string
  seatAddress?: string
  seatCommitmentHex?: string
  seatIndex?: number
  keyIndex?: number
  mint: string
  symbol: string
  decimals: number
  amount: string
  nullifier: string
  spent: boolean
  /** Underlying @heliuslabs/spr WalletUtxo in chain mode (never serialized to the API). */
  walletUtxo?: WalletUtxo
  /** Synced AssetRegistry entries discovered during Photon scan (mint -> compact assetId). */
  assetRegistryEntries?: readonly (readonly [bigint, string])[]
}

export type KeyDerivationSeam = {
  derive(signer: WalletSigner, authorityPda?: string): Promise<HolderKeys>
}

export type NoteScannerSeam = {
  scan(
    client: PookApiClient,
    keys: HolderKeys,
    options?: {
      config?: ConfigResponse
      ownerTag?: string
      wasm?: PookWasmModule
      spr?: SprClient
      photonUrl?: string
      proverUrl?: string
      proverTee?: ProverTee
      rpcUrl?: string
      signal?: AbortSignal
    },
  ): Promise<DecryptedNote[]>
}

/**
 * Returns Helius's signed TEE attestation policy for mainnet/devnet so prover requests carrying
 * nullifier secrets are HPKE-encrypted to an attested enclave key. Returns undefined on localnet.
 */
export function defaultProverTeeForCluster(cluster?: string | null): ProverTee | undefined {
  if (cluster === 'mainnet') return SignedTeePolicy.forNetwork('mainnet')
  if (cluster === 'devnet') return SignedTeePolicy.forNetwork('devnet')
  return undefined
}

export type ProverSeam = {
  prove(client: PookApiClient, req: ProveRequest, options?: { signal?: AbortSignal }): Promise<ProveResponse>
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function u64Le(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)
  return b
}

export function deriveNullifierSecretBytes(seed: Uint8Array, index: number | bigint): Uint8Array {
  const out = sha256(concatBytes(NF_DOMAIN, seed, u64Le(index)))
  out[0] = 0 // canonical BN254 field element (< Fr::MODULUS)
  return out
}

export function deriveSeatSecretBytes(seed: Uint8Array, seatIndex: number | bigint): Uint8Array {
  return sha256(concatBytes(SEAT_SECRET_DOMAIN, seed, u64Le(seatIndex)))
}

const SEAT_DOMAIN_FIELD_BYTES = (() => {
  const b = new Uint8Array(32)
  new DataView(b.buffer).setUint32(28, Number(SEAT_DOMAIN_U32_BE), false)
  return b
})()

export function deriveSeatCommitmentBytes(seed: Uint8Array, seatIndex: number | bigint, _wasm?: PookWasmModule): Uint8Array {
  const secret = deriveSeatSecretBytes(seed, seatIndex)
  const secretHash = hashBytes(secret)
  return poseidon([SEAT_DOMAIN_FIELD_BYTES, secretHash])
}

export async function derivePookPda(programId: string, seeds: readonly Uint8Array[]): Promise<[string, number]> {
  const [addr, bump] = await getProgramDerivedAddress({
    programAddress: kitAddress(programId),
    seeds: [...seeds],
  })
  return [addr, bump]
}

export async function deriveSppSplInterfaceWithBump(ringsProgramId: string, mint: string): Promise<[string, number]> {
  return derivePookPda(ringsProgramId, [new TextEncoder().encode('spl_asset_vault'), fromBase58(mint)])
}

export async function deriveAuthorityPda(programId: string): Promise<[string, number]> {
  return derivePookPda(programId, [new TextEncoder().encode('authority')])
}

export async function deriveStagePda(programId: string): Promise<[string, number]> {
  return derivePookPda(programId, [new TextEncoder().encode('stage')])
}

export async function deriveConfigPda(programId: string): Promise<[string, number]> {
  return derivePookPda(programId, [new TextEncoder().encode('config')])
}

export async function deriveSeatPda(programId: string, commitment: Uint8Array): Promise<[string, number]> {
  return derivePookPda(programId, [new TextEncoder().encode('seat'), commitment])
}

export async function deriveSeatStatePda(programId: string, commitment: Uint8Array): Promise<[string, number]> {
  return derivePookPda(programId, [new TextEncoder().encode('seat_state'), commitment])
}

export async function deriveAuthorFeesPda(programId: string, author: string, mintBytes: Uint8Array): Promise<[string, number]> {
  return derivePookPda(programId, [new TextEncoder().encode('author_fees'), fromBase58(author), mintBytes])
}

export async function deriveAtaAddress(owner: string, mint: string, tokenProgram: string = SPL_TOKEN_PROGRAM_ID): Promise<string> {
  const [addr] = await getProgramDerivedAddress({
    programAddress: kitAddress('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    seeds: [fromBase58(owner), fromBase58(tokenProgram), fromBase58(mint)],
  })
  return addr
}

const KAMINO_INIT_USER_METADATA_DISC = Uint8Array.from([117, 169, 176, 69, 197, 23, 15, 162])
const KAMINO_INIT_OBLIGATION_DISC = Uint8Array.from([251, 10, 231, 76, 27, 11, 159, 96])

/**
 * Builds Kamino Lend `init_user_metadata` + `init_obligation` setup CPIs and trailing
 * `setup_accounts` matching `program/sdk/src/instructions.rs` `kamino_open_seat_setup`.
 */
export async function buildKaminoOpenSeatSetup(
  seatPda: string,
  lendingMarket: string = KAMINO_MAIN_MARKET,
): Promise<{
  setupCpis: WireSetupCpi[]
  setupAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  userMetadata: string
  obligation: string
}> {
  const seatBytes = fromBase58(seatPda)
  const marketBytes = fromBase58(lendingMarket)
  const zero32 = new Uint8Array(32)
  const [userMetadata] = await derivePookPda(KAMINO_LEND_PROGRAM_ID, [new TextEncoder().encode('user_meta'), seatBytes])
  const [obligation] = await derivePookPda(KAMINO_LEND_PROGRAM_ID, [
    Uint8Array.of(0),
    Uint8Array.of(0),
    seatBytes,
    marketBytes,
    zero32,
    zero32,
  ])

  // Indices relative to open_seat: 0=payer, 1=seat_pda, 2=system_program, 3+=setupAccounts
  const setupAccounts = [
    { pubkey: userMetadata, isWritable: true, isSigner: false }, // 3
    { pubkey: obligation, isWritable: true, isSigner: false }, // 4
    { pubkey: lendingMarket, isWritable: false, isSigner: false }, // 5
    { pubkey: SYSVAR_RENT_ID, isWritable: false, isSigner: false }, // 6
    { pubkey: KAMINO_LEND_PROGRAM_ID, isWritable: false, isSigner: false }, // 7 (None referrer)
    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false }, // 8 (default seed1/seed2)
  ]

  const metaData = new Uint8Array(40)
  metaData.set(KAMINO_INIT_USER_METADATA_DISC, 0)
  const initUserMetadata: WireSetupCpi = {
    targetProgram: KAMINO_LEND_PROGRAM_ID,
    data: metaData,
    accounts: [
      { accountIndex: 1, isWritable: false, isSigner: true },
      { accountIndex: 0, isWritable: true, isSigner: true },
      { accountIndex: 3, isWritable: true, isSigner: false },
      { accountIndex: 7, isWritable: false, isSigner: false },
      { accountIndex: 6, isWritable: false, isSigner: false },
      { accountIndex: 2, isWritable: false, isSigner: false },
    ],
  }

  const obData = new Uint8Array(10)
  obData.set(KAMINO_INIT_OBLIGATION_DISC, 0)
  // tag = 0 (Vanilla), id = 0
  const initObligation: WireSetupCpi = {
    targetProgram: KAMINO_LEND_PROGRAM_ID,
    data: obData,
    accounts: [
      { accountIndex: 1, isWritable: false, isSigner: true },
      { accountIndex: 0, isWritable: true, isSigner: true },
      { accountIndex: 4, isWritable: true, isSigner: false },
      { accountIndex: 5, isWritable: false, isSigner: false },
      { accountIndex: 8, isWritable: false, isSigner: false },
      { accountIndex: 8, isWritable: false, isSigner: false },
      { accountIndex: 3, isWritable: false, isSigner: false },
      { accountIndex: 6, isWritable: false, isSigner: false },
      { accountIndex: 2, isWritable: false, isSigner: false },
    ],
  }

  return {
    setupCpis: [initUserMetadata, initObligation],
    setupAccounts,
    userMetadata,
    obligation,
  }
}

export async function deriveOneTimePdaKeys(keys: HolderKeys, index: number | bigint) {
  await initializePoseidon()
  const nf32 = deriveNullifierSecretBytes(keys.seed, index)
  const nfSecret31 = bytes31(nf32.slice(1, 32))
  const viewSecret32 = bytes32(keys.viewingSecret)
  const nfKey = NullifierKey.fromSecret(nfSecret31)
  const viewKey = ViewingKey.fromBytes(viewSecret32)
  const pda = ShieldedPda.withViewingKey(kitAddress(keys.authorityPda), nfKey, viewKey)
  const shieldedAddress = pda.shieldedAddress()
  const ownerHashBytes = pda.ownerHash()
  const nullifierPublicKey = pda.nullifierPublicKey()
  const localKeys = LocalShieldedKeys.fromKeys({
    address: shieldedAddress,
    viewingKeys: [ViewingKey.fromBytes(viewSecret32)],
    nullifierKey: NullifierKey.fromSecret(nfSecret31),
  })
  return {
    index: Number(index),
    nf32,
    nfFieldDec: bytesToDecimalField(nf32),
    nfKey: NullifierKey.fromSecret(nfSecret31),
    pda,
    shieldedAddress,
    ownerHashBytes,
    ownerHashHex: toHex(ownerHashBytes),
    nullifierPublicKey,
    localKeys,
  }
}

export async function deriveProgramOwnerZeroAddress(keys: HolderKeys): Promise<Uint8Array> {
  await initializePoseidon()
  const viewKey = ViewingKey.fromBytes(bytes32(keys.viewingSecret))
  const programOwner = new ProgramOwner(kitAddress(keys.authorityPda))
  return programOwner.address(viewKey.publicKey()).toBytes()
}

export function authorityIdentityFieldDec(authorityPda: string): string {
  // Mirrors `spr_hasher::primitives::solana_owner_identity(pk) = hash_bytes(0x53 || pk)`.
  return bytesToDecimalField(solanaOwnerIdentity(fromBase58(authorityPda)))
}

/**
 * Default browser-safe key derivation mirroring `HolderKeys::from_wallet_signature`.
 */
export const defaultKeyDerivation: KeyDerivationSeam = {
  async derive(signer, authorityPda = SYSTEM_PROGRAM_ID) {
    await initializePoseidon()
    const sig = await signer.signMessage(new TextEncoder().encode(RINGS_DERIVE_MESSAGE))
    const viewingSecret = sha256(concatBytes(VIEW_DOMAIN, sig))
    const nf0 = deriveNullifierSecretBytes(sig, 0)
    const viewSecret32 = bytes32(viewingSecret)
    const viewingKey = ViewingKey.fromBytes(viewSecret32)
    const viewingPkBase64 = toBase64(viewingKey.publicKey().toBytes())
    const pda = ShieldedPda.withViewingKey(
      kitAddress(authorityPda),
      NullifierKey.fromSecret(bytes31(nf0.slice(1, 32))),
      ViewingKey.fromBytes(viewSecret32),
    )
    const ownerHash = toHex(pda.ownerHash())
    pda.destroy()
    return {
      wallet: signer.publicKey,
      seed: sig,
      authorityPda,
      ownerHash,
      viewingPkBase64,
      nullifierSecretHex: toHex(nf0),
      viewingSecret,
    }
  },
}

const FIXTURE_NOTE_PREFIX = 'POOK_FIXTURE_NOTE:'

function tryDecodeFixtureNote(record: EncryptedNoteRecord): Omit<DecryptedNote, 'spent'> | null {
  try {
    const text = new TextDecoder().decode(fromBase64(record.ciphertextBase64))
    if (!text.startsWith(FIXTURE_NOTE_PREFIX)) return null
    const parsed = JSON.parse(text.slice(FIXTURE_NOTE_PREFIX.length)) as Record<string, unknown>
    return {
      commitment: record.commitment,
      treeId: record.treeId,
      leafIndex: record.leafIndex,
      slot: record.slot,
      signature: record.signature,
      timestamp: record.timestamp,
      kind: parsed.kind === 'seat' ? 'seat' : 'balance',
      action: parsed.action === 'enter' || parsed.action === 'leave' ? parsed.action : 'run',
      hookId: typeof parsed.hookId === 'string' ? parsed.hookId : undefined,
      protocol: typeof parsed.protocol === 'string' ? parsed.protocol : undefined,
      seatAddress: typeof parsed.seatAddress === 'string' ? parsed.seatAddress : undefined,
      seatCommitmentHex: typeof parsed.seatCommitmentHex === 'string' ? parsed.seatCommitmentHex : undefined,
      mint: String(parsed.mint ?? ''),
      symbol: String(parsed.symbol ?? 'UNKNOWN'),
      decimals: Number(parsed.decimals ?? 6),
      amount: String(parsed.amount ?? '0'),
      nullifier: String(parsed.nullifier ?? record.commitment),
    }
  } catch {
    return null
  }
}

/**
 * Multi-key ProofAuthority combining multiple one-time NullifierKeys + ProgramOwner zero key.
 * Completes every input slot whose `circuit.owner` matches any held key and forwards to `proofs`.
 */
export function createMultiKeyProofAuthority(keys: readonly NullifierKey[], proofs: ProofService): ProofAuthority {
  const allKeys = [
    ...keys,
    NullifierKey.fromSecret(bytes31(new Uint8Array(31))),
  ]

  const keyEntries = allKeys.map((k) => {
    const pkField = bytesField(k.publicKey(), 'nullifier public key')
    const secretBytes = k.secretBytes()
    const secret = asField(bytesField(secretBytes, 'nullifier secret'))
    secretBytes.fill(0)
    return { pkField, secret }
  })

  function completeInputSlot<T extends { nullifierSecret?: unknown; isDummy: bigint; ownerPublicKeyHash: bigint; circuit: { owner: bigint } }>(
    input: T,
  ): T {
    if (input.nullifierSecret !== undefined || input.isDummy !== 0n) return input
    for (const entry of keyEntries) {
      const ownerBytes = new Uint8Array(32)
      let a = input.ownerPublicKeyHash
      for (let i = 31; i >= 0; i--) {
        ownerBytes[i] = Number(a & 0xffn)
        a >>= 8n
      }
      const pkBytes = new Uint8Array(32)
      let b = entry.pkField
      for (let i = 31; i >= 0; i--) {
        pkBytes[i] = Number(b & 0xffn)
        b >>= 8n
      }
      const expectedOwner = bytesField(poseidon([ownerBytes, pkBytes]), 'owner')
      if (input.circuit.owner === expectedOwner) {
        return Object.freeze({ ...input, nullifierSecret: entry.secret })
      }
    }
    return input
  }

  const indexedProofs = proofs as ProofService & {
    proveIndexed?(request: unknown, context?: unknown): Promise<unknown>
  }

  const authority = {
    async prove(inputs: Parameters<ProofAuthority['prove']>[0], context?: Parameters<ProofAuthority['prove']>[1]) {
      const completed = Object.freeze({
        ...inputs,
        payload: Object.freeze({
          ...inputs.payload,
          inputs: Object.freeze(inputs.payload.inputs.map((inp) => completeInputSlot(inp as never))),
        }),
      })
      return proofs.prove(completed as never, context)
    },
    async proveMerge(inputs: Parameters<ProofAuthority['proveMerge']>[0], context?: Parameters<ProofAuthority['proveMerge']>[1]) {
      for (const k of allKeys) {
        try {
          return await new NullifierKeyProofAuthority(k, proofs).proveMerge(inputs, context)
        } catch {
          // try next key
        }
      }
      throw new Error('No matching nullifier key for merge')
    },
    async proveIndexed(request: unknown, context?: unknown) {
      const decoded = decodeIndexedInputs(request) as {
        circuit: string
        payload: {
          inputs: readonly { nullifierSecret?: unknown; isDummy: bigint; ownerPublicKeyHash: bigint; circuit: { owner: bigint } }[]
          userNullifierSecret?: unknown
          userNullifierPublicKey?: bigint
        }
      }
      if (decoded.circuit === 'merge') {
        if (decoded.payload.userNullifierSecret === undefined) {
          const hit = keyEntries.find((e) => e.pkField === decoded.payload.userNullifierPublicKey)
          if (hit) {
            return indexedProofs.proveIndexed!(
              { ...decoded, payload: { ...decoded.payload, userNullifierSecret: hit.secret } },
              context,
            )
          }
        }
        return indexedProofs.proveIndexed!(decoded, context)
      }
      const completed = Object.freeze({
        ...decoded,
        payload: Object.freeze({
          ...decoded.payload,
          inputs: Object.freeze(decoded.payload.inputs.map((inp) => completeInputSlot(inp))),
        }),
      })
      return indexedProofs.proveIndexed!(completed, context)
    },
  }
  return authority as unknown as ProofAuthority
}

const MAX_SCAN_GAP = 16
const NULLIFIER_QUERY_CHUNK = 64

type CachedDerivedKey = {
  index: number
  ownerHashHex: string
  nullifierPublicKey: ReturnType<typeof bytes32>
  pda: ShieldedPda
}

type ChainScanState = {
  cacheKey: string
  spr?: SprClient
  registry: AssetRegistry
  registryLoaded: boolean
  txCheckpoint?: bigint
  depositCheckpoint?: bigint
  nfCheckpoint?: bigint
  derivedByIndex: Map<number, CachedDerivedKey>
  indexByOwnerHash: Map<string, number>
  maxDerivedIndex: number
  maxMatchedIndex: number
  maxSeatIndex: number
  spentNullifiers: Set<string>
  notesByCommitment: Map<string, DecryptedNote>
}

const chainScanStates = new WeakMap<HolderKeys, ChainScanState>()

/** Destroys cached PDA key material held for incremental chain scanning when locking/switching keys. */
export function clearScanState(keys: HolderKeys | null | undefined) {
  if (!keys) return
  const state = chainScanStates.get(keys)
  if (!state) return
  for (const d of state.derivedByIndex.values()) {
    try {
      d.pda.destroy()
    } catch {
      // ignore already destroyed
    }
  }
  state.derivedByIndex.clear()
  state.indexByOwnerHash.clear()
  state.notesByCommitment.clear()
  chainScanStates.delete(keys)
}

async function backfillRegistryFromRpc(registry: AssetRegistry, spr: SprClient, signal?: AbortSignal): Promise<number> {
  if (!spr.solanaRpc) return 0
  const regs = await fetchSplAssetRegistrations(
    { solanaRpc: spr.solanaRpc, commitment: spr.commitment ?? 'confirmed' },
    signal ? { signal } : undefined,
  )
  let inserted = 0
  for (const { assetId, mint } of regs) {
    try {
      if (registry.register(assetId, mint)) inserted += 1
    } catch {
      // ignore conflicting duplicate
    }
  }
  return inserted
}

/**
 * Default client-side note scanner seam.
 * - Fixture mode: decodes fixture notes from `/v1/notes` + `/v1/notes/nullifiers`.
 * - Chain mode: single-pass incremental scan per session over Pook's authority PDA tag
 *   (fetching shielded transactions and proofless deposits once per scan from the last slot
 *   checkpoint), decrypting confidential balance and seat notes with the holder's single viewing
 *   key and lazily growing the one-time key index map with no fixed upper cap.
 */
export const defaultNoteScanner: NoteScannerSeam = {
  async scan(client, keys, options) {
    const isFixture = options?.config?.status === 'fixture'
    if (isFixture || !options?.config?.authorityPda) {
      const collected: Omit<DecryptedNote, 'spent'>[] = []
      let cursor: string | undefined
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const page = await client.notes({ ownerTag: options?.ownerTag, cursor, limit: 100 }, { signal: options?.signal })
        for (const record of page.items) {
          const decoded = tryDecodeFixtureNote(record)
          if (decoded) collected.push(decoded)
        }
        if (!page.page.hasMore || !page.page.nextCursor) break
        cursor = page.page.nextCursor
      }
      if (!collected.length) return []
      const { spent } = await client.checkNullifiers({ nullifiers: collected.map((n) => n.nullifier) }, { signal: options?.signal })
      return collected.map((n) => ({ ...n, spent: Boolean(spent[n.nullifier]) }))
    }

    await initializePoseidon()
    const photonUrl = options.photonUrl ?? client.photonUrl()
    const proverUrl = options.proverUrl ?? client.proverSppUrl()
    const cacheKey = `${keys.authorityPda}|${photonUrl}`

    let state = chainScanStates.get(keys)
    if (!state || state.cacheKey !== cacheKey) {
      if (state) clearScanState(keys)
      state = {
        cacheKey,
        registry: new AssetRegistry(),
        registryLoaded: false,
        derivedByIndex: new Map(),
        indexByOwnerHash: new Map(),
        maxDerivedIndex: -1,
        maxMatchedIndex: -1,
        maxSeatIndex: -1,
        spentNullifiers: new Set(),
        notesByCommitment: new Map(),
      }
      chainScanStates.set(keys, state)
    }

    const proverTee = options.proverTee ?? defaultProverTeeForCluster(options.config?.cluster)
    const spr =
      options.spr ??
      state.spr ??
      (state.spr = await createSprClient({
        indexerUrl: photonUrl,
        proverUrl,
        ...(proverTee ? { proverTee } : {}),
        solanaRpcUrl: options.rpcUrl ?? client.rpcUrl(),
      }))

    const ctx = options.signal ? { signal: options.signal } : undefined
    const ownerPk = ShieldedPublicKey.fromPda(kitAddress(keys.authorityPda))
    const authorityTag = ownerPk.confidentialViewTag()
    const assetsByMint = new Map(options.config.supportedAssets.map((a) => [a.mint, a]))

    // 1. Load SPL asset registrations once per session (cached on /v1/rpc).
    if (!state.registryLoaded) {
      await backfillRegistryFromRpc(state.registry, spr, options.signal).catch(() => 0)
      state.registryLoaded = true
    }

    // 2. Single paged fetch per stream since the last seen slot checkpoint.
    type ShieldedEvent = {
      slot: bigint
      txSignature: string
      proofless?: boolean
      txViewingPublicKey?: Parameters<ViewingKey['decryptUtxo']>[1]
      salt?: Uint8Array
      nullifiers: readonly Uint8Array[]
      outputSlots: readonly {
        payload: Uint8Array
        outputContext: { hash: Uint8Array; tree: KitAddress; leafIndex: bigint }
      }[]
    }
    type ProoflessMatch = {
      slot: bigint
      txSignature: string
      txViewingPk?: unknown
      salt?: unknown
      outputSlot: {
        payload: Uint8Array
        outputContext: { hash: Uint8Array; tree: KitAddress; leafIndex: bigint }
      }
    }

    const fetchShieldedEvents = async (): Promise<{ events: ShieldedEvent[]; checkpoint?: bigint }> => {
      const collected: ShieldedEvent[] = []
      const filters = state.txCheckpoint === undefined ? undefined : { slot: { gt: state.txCheckpoint } }
      let paginationToken: string | undefined
      let finalSlot = state.txCheckpoint
      for (;;) {
        const resp = await spr.getShieldedTransactionsByTags(
          {
            tags: [authorityTag],
            limit: 1000,
            ...(filters ? { filters } : {}),
            ...(paginationToken ? { paginationToken } : {}),
          },
          undefined,
          ctx,
        )
        for (const item of resp.data) {
          for (const ev of item.events) {
            if (!(ev as ShieldedEvent).proofless) collected.push(ev as ShieldedEvent)
          }
        }
        finalSlot = resp.context.slot
        if (!resp.paginationToken) break
        paginationToken = resp.paginationToken
      }
      return { events: collected, checkpoint: finalSlot }
    }

    const fetchProoflessOutputs = async (): Promise<{ outputs: ProoflessMatch[]; checkpoint?: bigint }> => {
      const collected: ProoflessMatch[] = []
      const filters = state.depositCheckpoint === undefined ? undefined : { slot: { gt: state.depositCheckpoint } }
      let paginationToken: string | undefined
      let finalSlot = state.depositCheckpoint
      for (;;) {
        const resp = await spr.getEncryptedUtxosByTags(
          {
            tags: [authorityTag],
            limit: 1000,
            ...(filters ? { filters } : {}),
            ...(paginationToken ? { paginationToken } : {}),
          },
          undefined,
          ctx,
        )
        for (const item of resp.data) {
          for (const out of item.outputs) {
            const m = out as unknown as ProoflessMatch
            if (m.txViewingPk === undefined && m.salt === undefined) collected.push(m)
          }
        }
        finalSlot = resp.context.slot
        if (!resp.paginationToken) break
        paginationToken = resp.paginationToken
      }
      return { outputs: collected, checkpoint: finalSlot }
    }

    const [txFetch, depFetch] = await Promise.all([fetchShieldedEvents(), fetchProoflessOutputs()])
    if (txFetch.checkpoint !== undefined) state.txCheckpoint = txFetch.checkpoint
    if (depFetch.checkpoint !== undefined) state.depositCheckpoint = depFetch.checkpoint

    for (const ev of txFetch.events) {
      for (const nf of ev.nullifiers) state.spentNullifiers.add(toHex(nf))
    }

    // 3. Decode new proofless deposits (`enter` and `run` outputs) once using @heliuslabs/spr's decoder.
    type ProoflessCandidate = {
      slot: bigint
      txSignature: string
      commHex: string
      outputContext: { hash: Uint8Array; tree: KitAddress; leafIndex: bigint }
      deposit: ReturnType<typeof decodeProofless>
    }
    const unmatchedDeposits = new Map<string, ProoflessCandidate[]>()
    let registryRefreshedThisScan = false

    for (const m of depFetch.outputs) {
      const commHex = toHex(m.outputSlot.outputContext.hash)
      if (state.notesByCommitment.has(commHex)) continue
      try {
        const frame = readOutputData(m.outputSlot.payload)
        if (frame.encoding !== 'plaintext' || frame.scheme !== EncryptedScheme.proofless) continue
        const deposit = decodeProofless(frame.body)
        if (deposit.ringProgramId !== undefined) continue
        const ownerHex = toHex(deposit.owner)
        let bucket = unmatchedDeposits.get(ownerHex)
        if (!bucket) {
          bucket = []
          unmatchedDeposits.set(ownerHex, bucket)
        }
        bucket.push({
          slot: m.slot,
          txSignature: m.txSignature,
          commHex,
          outputContext: m.outputSlot.outputContext,
          deposit,
        })
      } catch {
        // Ignore undecodable or non-proofless outputs
      }
    }

    // 4. Try-decrypt new confidential outputs once with the holder's single viewing key.
    type ConfidentialCandidate = {
      slot: bigint
      txSignature: string
      commHex: string
      outputContext: { hash: Uint8Array; tree: KitAddress; leafIndex: bigint }
      utxo: ReturnType<typeof confidentialUtxo>
      records: ReturnType<ReturnType<typeof decodeConfidential>['data']['records']>
      isSeat: boolean
    }
    const unmatchedConfidential: ConfidentialCandidate[] = []
    const vk = ViewingKey.fromBytes(bytes32(keys.viewingSecret))
    try {
      for (const ev of txFetch.events) {
        if (!ev.txViewingPublicKey || !ev.salt) continue
        for (let slotIdx = 0; slotIdx < ev.outputSlots.length; slotIdx++) {
          const slot = ev.outputSlots[slotIdx]!
          const commHex = toHex(slot.outputContext.hash)
          if (state.notesByCommitment.has(commHex)) continue
          let dec: ReturnType<typeof decodeConfidential>
          try {
            const frame = readOutputData(slot.payload)
            if (
              frame.encoding !== 'encrypted' ||
              (frame.scheme !== EncryptedScheme.confidential && frame.scheme !== EncryptedScheme.ringConfidential)
            ) {
              continue
            }
            const ct = splitEmbeddedKey(frame.body).rest
            const pt = vk.decryptUtxo(ct, ev.txViewingPublicKey, ev.salt as Parameters<ViewingKey['decryptUtxo']>[2], slotIdx)
            dec = decodeConfidential(pt)
          } catch {
            continue
          }
          if (dec.ringProgramId !== undefined) continue
          let utxo: ReturnType<typeof confidentialUtxo>
          try {
            utxo = confidentialUtxo(dec, ownerPk, state.registry)
          } catch {
            if (!registryRefreshedThisScan) {
              registryRefreshedThisScan = true
              await backfillRegistryFromRpc(state.registry, spr, options.signal).catch(() => 0)
            }
            try {
              utxo = confidentialUtxo(dec, ownerPk, state.registry)
            } catch {
              continue
            }
          }
          const records = dec.data.records()
          unmatchedConfidential.push({
            slot: ev.slot,
            txSignature: ev.txSignature,
            commHex,
            outputContext: slot.outputContext,
            utxo,
            records,
            isSeat: records.some((r) => r.kind === 'utxoData'),
          })
        }
      }
    } finally {
      vk.destroy()
    }

    // 5. Lazy, unbounded one-time key derivation & matching (stops after MAX_SCAN_GAP consecutive unmatched indices).
    const ensureDerived = async (idx: number): Promise<CachedDerivedKey> => {
      const hit = state.derivedByIndex.get(idx)
      if (hit) return hit
      const derived = await deriveOneTimePdaKeys(keys, idx)
      const entry: CachedDerivedKey = {
        index: idx,
        ownerHashHex: derived.ownerHashHex,
        nullifierPublicKey: derived.nullifierPublicKey,
        pda: derived.pda,
      }
      state.derivedByIndex.set(idx, entry)
      state.indexByOwnerHash.set(derived.ownerHashHex, idx)
      if (idx > state.maxDerivedIndex) state.maxDerivedIndex = idx
      return entry
    }

    const ensureMintRegistered = async (rawMint: string) => {
      if (isNativeSolMint(rawMint)) return
      try {
        state.registry.assetId(kitAddress(rawMint))
      } catch {
        if (!registryRefreshedThisScan) {
          registryRefreshedThisScan = true
          await backfillRegistryFromRpc(state.registry, spr, options.signal).catch(() => 0)
        }
      }
    }

    const recordMatchedDeposit = async (d: CachedDerivedKey, cand: ProoflessCandidate) => {
      const utxo = prooflessUtxo(cand.deposit, ownerPk)
      const computedHash = utxo.hash(d.nullifierPublicKey, DEFAULT_TREE_ID, cand.deposit.dataHash, cand.deposit.ringDataHash)
      if (!equalBytes(computedHash, cand.outputContext.hash)) return false

      await ensureMintRegistered(utxo.asset)
      const nullifier = d.pda.nullifier(bytes32(cand.outputContext.hash), utxo.blinding)
      const nfHex = toHex(nullifier)
      const spent = state.spentNullifiers.has(nfHex)
      const rawMint = utxo.asset
      const displayMint = isNativeSolMint(rawMint) ? WSOL_MINT : rawMint
      const assetMeta = assetsByMint.get(displayMint) ?? assetsByMint.get(rawMint)
      const walletUtxo: WalletUtxo = Object.freeze({
        utxo,
        outputContext: Object.freeze({
          hash: bytes32(new Uint8Array(cand.outputContext.hash)),
          tree: cand.outputContext.tree,
          leafIndex: cand.outputContext.leafIndex,
        }),
        nullifier,
        ...(cand.deposit.dataHash ? { dataHash: bytes32(new Uint8Array(cand.deposit.dataHash)) } : {}),
        ...(cand.deposit.ringDataHash ? { ringDataHash: bytes32(new Uint8Array(cand.deposit.ringDataHash)) } : {}),
        spent,
      })

      state.notesByCommitment.set(cand.commHex, {
        commitment: cand.commHex,
        treeId: DEFAULT_TREE_ID,
        leafIndex: Number(cand.outputContext.leafIndex),
        slot: String(cand.slot),
        signature: cand.txSignature,
        timestamp: new Date().toISOString(),
        kind: 'balance',
        action: spent ? 'run' : 'enter',
        keyIndex: d.index,
        mint: displayMint,
        symbol: assetMeta?.symbol ?? (isNativeSolMint(rawMint) ? 'SOL' : 'TOKEN'),
        decimals: assetMeta?.decimals ?? (isNativeSolMint(rawMint) ? 9 : 6),
        amount: utxo.amount.toString(),
        nullifier: nfHex,
        spent,
        walletUtxo,
      })
      if (d.index > state.maxMatchedIndex) state.maxMatchedIndex = d.index
      return true
    }

    const tryMatchConfidential = async (d: CachedDerivedKey, cand: ConfidentialCandidate): Promise<boolean> => {
      if (cand.isSeat) {
        if (!options.wasm || !options.config?.programId) return false
        try {
          const nullifier = d.pda.nullifier(bytes32(cand.outputContext.hash), cand.utxo.blinding)
          const seatUtxo = options.wasm.seatNoteDataUtxo({
            utxo: {
              owner: cand.utxo.owner.toBytes(),
              asset: { asset: cand.utxo.asset, assetId: 1n },
              amount: cand.utxo.amount,
              blinding: cand.utxo.blinding,
              data: { records: [...cand.records] },
            },
            nullifierPubkey: d.nullifierPublicKey,
            utxoHash: cand.outputContext.hash,
            nullifier,
            treeId: DEFAULT_TREE_ID,
            leafIndex: cand.outputContext.leafIndex,
          }) as { utxo: { dataHash?: Uint8Array }; data: { seatSecret: Uint8Array } }

          const dataHash = seatUtxo.utxo.dataHash
          const secret = seatUtxo.data.seatSecret
          const comm = poseidon([SEAT_DOMAIN_FIELD_BYTES, hashBytes(secret)])
          const [seatPda] = await deriveSeatPda(options.config.programId, comm)
          let seatIndex: number | undefined
          const seatSearchLimit = Math.max(64, state.maxSeatIndex + 32)
          for (let s = 0; s < seatSearchLimit; s++) {
            const candSecret = deriveSeatSecretBytes(keys.seed, s)
            if (candSecret.every((b, i) => b === secret[i])) {
              seatIndex = s
              if (s > state.maxSeatIndex) state.maxSeatIndex = s
              break
            }
          }
          const nfHex = toHex(nullifier)
          const spent = state.spentNullifiers.has(nfHex)
          const walletUtxo: WalletUtxo = Object.freeze({
            utxo: cand.utxo,
            outputContext: Object.freeze({
              hash: bytes32(new Uint8Array(cand.outputContext.hash)),
              tree: cand.outputContext.tree,
              leafIndex: cand.outputContext.leafIndex,
            }),
            nullifier,
            ...(dataHash ? { dataHash: bytes32(new Uint8Array(dataHash)) } : {}),
            spent,
          })
          state.notesByCommitment.set(cand.commHex, {
            commitment: cand.commHex,
            treeId: DEFAULT_TREE_ID,
            leafIndex: Number(cand.outputContext.leafIndex),
            slot: String(cand.slot),
            signature: cand.txSignature,
            timestamp: new Date().toISOString(),
            kind: 'seat',
            action: spent ? 'run' : 'enter',
            seatAddress: seatPda,
            seatCommitmentHex: toHex(comm),
            seatIndex,
            keyIndex: d.index,
            mint: WSOL_MINT,
            symbol: 'SEAT',
            decimals: 9,
            amount: '0',
            nullifier: nfHex,
            spent,
            walletUtxo,
          })
          if (d.index > state.maxMatchedIndex) state.maxMatchedIndex = d.index
          return true
        } catch {
          return false
        }
      }

      const computedHash = cand.utxo.hash(d.nullifierPublicKey, DEFAULT_TREE_ID)
      if (!equalBytes(computedHash, cand.outputContext.hash)) return false
      await ensureMintRegistered(cand.utxo.asset)
      const nullifier = d.pda.nullifier(bytes32(cand.outputContext.hash), cand.utxo.blinding)
      const nfHex = toHex(nullifier)
      const spent = state.spentNullifiers.has(nfHex)
      const rawMint = cand.utxo.asset
      const displayMint = isNativeSolMint(rawMint) ? WSOL_MINT : rawMint
      const assetMeta = assetsByMint.get(displayMint) ?? assetsByMint.get(rawMint)
      const walletUtxo: WalletUtxo = Object.freeze({
        utxo: cand.utxo,
        outputContext: Object.freeze({
          hash: bytes32(new Uint8Array(cand.outputContext.hash)),
          tree: cand.outputContext.tree,
          leafIndex: cand.outputContext.leafIndex,
        }),
        nullifier,
        spent,
      })
      state.notesByCommitment.set(cand.commHex, {
        commitment: cand.commHex,
        treeId: DEFAULT_TREE_ID,
        leafIndex: Number(cand.outputContext.leafIndex),
        slot: String(cand.slot),
        signature: cand.txSignature,
        timestamp: new Date().toISOString(),
        kind: 'balance',
        action: spent ? 'run' : 'enter',
        keyIndex: d.index,
        mint: displayMint,
        symbol: assetMeta?.symbol ?? (isNativeSolMint(rawMint) ? 'SOL' : 'TOKEN'),
        decimals: assetMeta?.decimals ?? (isNativeSolMint(rawMint) ? 9 : 6),
        amount: cand.utxo.amount.toString(),
        nullifier: nfHex,
        spent,
        walletUtxo,
      })
      if (d.index > state.maxMatchedIndex) state.maxMatchedIndex = d.index
      return true
    }

    const matchedIndices = new Set<number>()
    const txMatchedIndices = new Map<string, number[]>()
    const anchors: Array<{ slot: bigint; index: number }> = []
    for (const existing of state.notesByCommitment.values()) {
      if (existing.keyIndex !== undefined) {
        matchedIndices.add(existing.keyIndex)
        anchors.push({ slot: BigInt(existing.slot || '0'), index: existing.keyIndex })
      }
    }
    const recordAnchor = (txSig: string, slot: bigint, index: number) => {
      matchedIndices.add(index)
      anchors.push({ slot, index })
      let arr = txMatchedIndices.get(txSig)
      if (!arr) {
        arr = []
        txMatchedIndices.set(txSig, arr)
      }
      arr.push(index)
    }

    // 5a. Match proofless deposits in O(1) via ownerHash map, growing derived keys lazily with no upper cap.
    for (const [ownerHex, bucket] of [...unmatchedDeposits.entries()]) {
      const knownIdx = state.indexByOwnerHash.get(ownerHex)
      if (knownIdx === undefined) continue
      const d = state.derivedByIndex.get(knownIdx)
      if (!d) continue
      for (const cand of bucket) {
        if (await recordMatchedDeposit(d, cand)) recordAnchor(cand.txSignature, cand.slot, d.index)
      }
      unmatchedDeposits.delete(ownerHex)
    }
    while (unmatchedDeposits.size > 0) {
      const nextIdx = state.maxDerivedIndex + 1
      if (nextIdx - state.maxMatchedIndex > MAX_SCAN_GAP) break
      const d = await ensureDerived(nextIdx)
      const depBucket = unmatchedDeposits.get(d.ownerHashHex)
      if (depBucket) {
        for (const cand of depBucket) {
          if (await recordMatchedDeposit(d, cand)) recordAnchor(cand.txSignature, cand.slot, d.index)
        }
        unmatchedDeposits.delete(d.ownerHashHex)
      }
    }

    // 5b. Match confidential outputs (balance change & SeatNotes) in chronological order using
    // same-tx sibling hints and slot-ordered unclaimed-first probing (O(N) instead of O(N^2)).
    unmatchedConfidential.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1
      return a.outputContext.leafIndex < b.outputContext.leafIndex ? -1 : a.outputContext.leafIndex > b.outputContext.leafIndex ? 1 : 0
    })

    for (const cand of unmatchedConfidential) {
      const tried = new Set<number>()
      let matched = false
      const tryIdx = async (idx: number): Promise<boolean> => {
        if (idx < 0 || tried.has(idx)) return false
        tried.add(idx)
        const d = await ensureDerived(idx)
        if (await tryMatchConfidential(d, cand)) {
          recordAnchor(cand.txSignature, cand.slot, idx)
          return true
        }
        return false
      }

      // Priority 1: sibling indices in the exact same transaction (e.g. changeIdx = outputIdx - 1).
      const siblings = txMatchedIndices.get(cand.txSignature)
      if (siblings) {
        for (const sIdx of siblings) {
          for (const delta of [-1, -2, 1, 2]) {
            if (await tryIdx(sIdx + delta)) {
              matched = true
              break
            }
          }
          if (matched) break
        }
      }
      if (matched) continue

      // Priority 2: expand outward from the highest anchor at or before cand.slot over unclaimed indices.
      let hintIdx = -1
      for (const a of anchors) {
        if (a.slot <= cand.slot && a.index > hintIdx) hintIdx = a.index
      }
      const upperProbe = Math.max(state.maxDerivedIndex, state.maxMatchedIndex + MAX_SCAN_GAP)
      const start = Math.max(0, hintIdx + 1)
      for (let dist = 0; !matched; dist++) {
        const hi = start + dist
        const lo = start - 1 - dist
        const hiInRange = hi <= upperProbe
        const loInRange = lo >= 0
        if (!hiInRange && !loInRange) break
        if (hiInRange && !matchedIndices.has(hi) && (await tryIdx(hi))) {
          matched = true
          break
        }
        if (loInRange && !matchedIndices.has(lo) && (await tryIdx(lo))) {
          matched = true
          break
        }
      }
      if (matched) continue

      // Priority 3: lazily grow beyond current maxDerivedIndex up to MAX_SCAN_GAP past maxMatchedIndex.
      while (!matched) {
        const nextIdx = state.maxDerivedIndex + 1
        if (nextIdx - state.maxMatchedIndex > MAX_SCAN_GAP) break
        if (await tryIdx(nextIdx)) {
          matched = true
          break
        }
      }
      if (matched) continue

      // Priority 4 (fallback): check any already-claimed indices in case an older run reused an index.
      for (let idx = state.maxDerivedIndex; idx >= 0; idx--) {
        if (await tryIdx(idx)) {
          matched = true
          break
        }
      }

      // If this confidential note advanced maxMatchedIndex, also sweep any remaining proofless deposits
      // whose index fell inside the newly opened MAX_SCAN_GAP window.
      while (unmatchedDeposits.size > 0) {
        const nextIdx = state.maxDerivedIndex + 1
        if (nextIdx - state.maxMatchedIndex > MAX_SCAN_GAP) break
        const d = await ensureDerived(nextIdx)
        const depBucket = unmatchedDeposits.get(d.ownerHashHex)
        if (depBucket) {
          for (const dep of depBucket) {
            if (await recordMatchedDeposit(d, dep)) recordAnchor(dep.txSignature, dep.slot, d.index)
          }
          unmatchedDeposits.delete(d.ownerHashHex)
        }
      }
    }

    // Final sweep of proofless deposits in case confidential matches raised maxMatchedIndex.
    while (unmatchedDeposits.size > 0) {
      const nextIdx = state.maxDerivedIndex + 1
      if (nextIdx - state.maxMatchedIndex > MAX_SCAN_GAP) break
      const d = await ensureDerived(nextIdx)
      const depBucket = unmatchedDeposits.get(d.ownerHashHex)
      if (depBucket) {
        for (const dep of depBucket) {
          if (await recordMatchedDeposit(d, dep)) recordAnchor(dep.txSignature, dep.slot, d.index)
        }
        unmatchedDeposits.delete(d.ownerHashHex)
      }
    }

    // 6. Update spent status from collected nullifiers plus one batched nullifier check for unspent notes
    // (catches spends whose tx emitted no authority-tagged outputs, e.g. closeSeat or exact-amount leave).
    const unspentNullifierBytes: ReturnType<typeof bytes32>[] = []
    for (const note of state.notesByCommitment.values()) {
      if (!note.spent && state.spentNullifiers.has(note.nullifier)) {
        note.spent = true
        note.action = 'run'
      }
      if (!note.spent && note.walletUtxo) {
        unspentNullifierBytes.push(bytes32(note.walletUtxo.nullifier))
      }
    }

    if (unspentNullifierBytes.length > 0) {
      const filters = state.nfCheckpoint === undefined ? undefined : { slot: { gt: state.nfCheckpoint } }
      let finalNfSlot = state.nfCheckpoint
      for (let off = 0; off < unspentNullifierBytes.length; off += NULLIFIER_QUERY_CHUNK) {
        const chunk = unspentNullifierBytes.slice(off, off + NULLIFIER_QUERY_CHUNK)
        let paginationToken: string | undefined
        for (;;) {
          const resp = await spr.getShieldedTransactionsByNullifiers(
            {
              nullifiers: chunk,
              limit: 1000,
              ...(filters ? { filters } : {}),
              ...(paginationToken ? { paginationToken } : {}),
            },
            undefined,
            ctx,
          )
          for (const item of resp.data) {
            for (const ev of item.events) {
              for (const nf of ev.nullifiers) state.spentNullifiers.add(toHex(nf))
            }
          }
          finalNfSlot = resp.context.slot
          if (!resp.paginationToken) break
          paginationToken = resp.paginationToken
        }
      }
      if (finalNfSlot !== undefined) state.nfCheckpoint = finalNfSlot

      for (const note of state.notesByCommitment.values()) {
        if (!note.spent && state.spentNullifiers.has(note.nullifier)) {
          note.spent = true
          note.action = 'run'
        }
      }
    }

    const registryEntries = state.registry.entries().map(([id, m]) => [id, String(m)] as const)
    const out: DecryptedNote[] = []
    for (const note of state.notesByCommitment.values()) {
      note.assetRegistryEntries = registryEntries
      out.push(note)
    }
    return out
  },
}

/**
 * Default prover seam for fixture mode (chain mode proves locally via Xark WASM + Rings SPP prover).
 */
export const defaultProver: ProverSeam = {
  async prove(_client, req) {
    const digest = sha256(new TextEncoder().encode(`pook_fixture_proof:${req.circuit}:${req.inputsJson}`))
    const proofHex = toHex(digest)
    return {
      proofId: `proof_fixture_${proofHex.slice(0, 12)}`,
      circuit: req.circuit,
      proofBase64: toBase64(new Uint8Array(128).map((_, i) => digest[i % digest.length]!)),
      publicInputsHex: [proofHex],
      privateTxHashHex: proofHex,
      provingMs: 1,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    }
  },
}

// --- Chain-mode Xark WASM + SPP proving helpers ---

export type CircuitArtifactCacheEntry = {
  xbc: Uint8Array
  pk: Uint8Array
  pkSha256: Uint8Array | null
  session?: WasmProvingSession
}

export type CircuitArtifactCache = Map<string, CircuitArtifactCacheEntry>

export async function loadCircuitArtifacts(
  client: PookApiClient,
  circuit: string,
  wasm: PookWasmModule,
  cache: CircuitArtifactCache,
  fetcher: typeof globalThis.fetch,
  proverBaseUrl?: string,
  signal?: AbortSignal,
) {
  const hit = cache.get(circuit)
  if (hit) return hit
  const base = proverBaseUrl ? proverBaseUrl.replace(/\/+$/, '') : null
  const xbcUrl = base ? `${base}/v1/prover/circuits/${circuit}/circuit.xbc` : client.proverArtifactUrl(circuit, 'circuit.xbc')
  const pkUrl = base ? `${base}/v1/prover/circuits/${circuit}/pk.bin` : client.proverArtifactUrl(circuit, 'pk.bin')

  const [xbcRes, pkRes] = await Promise.all([fetcher(xbcUrl, { signal }), fetcher(pkUrl, { signal })])
  if (!xbcRes.ok) throw new Error(`Failed to fetch ${circuit} circuit.xbc (HTTP ${xbcRes.status})`)
  if (!pkRes.ok) throw new Error(`Failed to fetch ${circuit} pk.bin (HTTP ${pkRes.status})`)
  const xbc = new Uint8Array(await xbcRes.arrayBuffer())
  const pk = new Uint8Array(await pkRes.arrayBuffer())
  const shaHeader = pkRes.headers.get('X-Artifact-Sha256')
  const pkSha256 = shaHeader && /^[0-9a-fA-F]{64}$/.test(shaHeader) ? fromHex(shaHeader) : null
  if (pkSha256) wasm.checkProvingKey(pk, pkSha256)
  // Parse circuit.xbc and decompress pk.bin once per circuit for the session so repeat proofs
  // skip row-source building and G1/G2 point decompression.
  const session = wasm.ProvingSession ? new wasm.ProvingSession(xbc, pk) : undefined
  const entry: CircuitArtifactCacheEntry = { xbc, pk, pkSha256, session }
  cache.set(circuit, entry)
  return entry
}

export type ProveProgramTimings = {
  witnessMs: number
  artifactLoadMs: number
  appProofMs: number
  sppProofMs: number
}

export async function proveProgramAndSpp(params: {
  client: PookApiClient
  wasm: PookWasmModule
  circuit: 'run' | 'leave' | 'seat_open' | 'seat_fund' | 'seat_action' | 'seat_close'
  wasmBuild: () => unknown
  keys: HolderKeys
  senderIndex: number
  authIndices: number[]
  expiryUnixTs: bigint
  payer: string
  tree: string
  withdrawal?: TransactWithdrawal
  spr: SprClient
  walletRegistry: Wallet['registry']
  artifactCache: CircuitArtifactCache
  fetcher: typeof globalThis.fetch
  proverBaseUrl?: string
  signal?: AbortSignal
}): Promise<{
  appProof: Uint8Array
  transact: TransactInstructionData
  transactBytes: Uint8Array
  sppAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  timings: ProveProgramTimings
}> {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  await initializePoseidon()
  const tWitness0 = now()
  const sender = await deriveOneTimePdaKeys(params.keys, params.senderIndex)
  const raw = params.wasmBuild() as {
    finalizedTx: unknown
    proofInputs: Record<string, string>
    publicHash: Uint8Array
  }
  const transaction = await decodeProgramTransaction(raw.finalizedTx, params.walletRegistry)
  const witnessMs = Math.round(now() - tWitness0)

  const tArt0 = now()
  const artifacts = await loadCircuitArtifacts(
    params.client,
    params.circuit,
    params.wasm,
    params.artifactCache,
    params.fetcher,
    params.proverBaseUrl,
    params.signal,
  )
  const artifactLoadMs = Math.round(now() - tArt0)

  const tApp0 = now()
  const bundle = artifacts.session
    ? artifacts.session.prove(raw.proofInputs, undefined)
    : params.wasm.prove(artifacts.xbc, artifacts.pk, raw.proofInputs)
  const appProof = params.wasm.compressedProgramProof(bundle.proof)
  bundle.free?.()
  const appProofMs = Math.round(now() - tApp0)

  const tSpp0 = now()
  const sppProofInputs = transaction.encryptWithKeys(sender.pda, { expiryUnixTs: params.expiryUnixTs })
  const authKeys = await Promise.all(params.authIndices.map((i) => deriveOneTimePdaKeys(params.keys, i)))
  const authority = createMultiKeyProofAuthority(authKeys.map((k) => k.nfKey), params.spr.proofService)
  const transact = await params.spr.proveTransact(sppProofInputs, authority)
  const transactBytes = encodeTransactInstructionData(transact)

  const cpiMetas = await transactCpiAccounts({
    payer: kitAddress(params.payer),
    inputTree: kitAddress(params.tree),
    outputTree: kitAddress(params.tree),
    ownerSigners: [],
    signerPdas: [kitAddress(params.keys.authorityPda)],
    withdrawal: params.withdrawal,
    data: transact,
  })
  const sppProofMs = Math.round(now() - tSpp0)

  sender.pda.destroy()
  for (const k of authKeys) k.pda.destroy()

  const sppAccounts = cpiMetas.map((m) => ({
    pubkey: String(m.address),
    isWritable: m.role === 1 || m.role === 3,
    // authority_pda is non-signer at top level (Pook elevates via invoke_signed); payer is signer
    isSigner: String(m.address) === params.payer,
  }))

  return { appProof, transact, transactBytes, sppAccounts, timings: { witnessMs, artifactLoadMs, appProofMs, sppProofMs } }
}

/**
 * Derives the holder's standard Rings wallet keys (`TSPP/derive/v1`) from one wallet signature.
 * Used when entering Pook from a Rings private balance (`source: 'rings'`).
 */
export async function deriveRingsWalletKeys(signer: WalletSigner, spr: SprClient): Promise<LocalKeys> {
  await initializePoseidon()
  const pubkeyBytes = bytes32(fromBase58(signer.publicKey))
  const msg = ed25519DerivationMessage(pubkeyBytes)
  const sig = await signer.signMessage(msg)
  if (sig.length !== 64) {
    throw new ApiClientError(400, {
      error: { code: 'VALIDATION_ERROR', message: 'Wallet signMessage must return a 64-byte Ed25519 signature.', retryable: false, stage: 'wallet' },
    })
  }
  return LocalKeys.fromDerivationSeed(
    {
      solanaPublicKey: kitAddress(signer.publicKey),
      derivationSeed: bytes64(sig),
    },
    spr.proofService,
  )
}

/**
 * Syncs the holder's Rings wallet, spends their Rings notes into a Pook one-time note
 * (`OwnerTag::Inline(authority_pda)`) with change back to their Rings wallet, proves the SPP
 * `transact`, and returns the encoded transact payload and verbatim CPI accounts for `pook::enter`.
 */
export async function buildRingsEnterTransact(params: {
  ringsKeys: LocalKeys
  spr: SprClient
  payer: string
  stateTree: string
  mint: string
  amount: bigint
  targetAddress: ShieldedAddress
  signal?: AbortSignal
}): Promise<{
  transactDataBase64: string
  transactAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
}> {
  await initializePoseidon()
  const ctx = params.signal ? { signal: params.signal } : undefined
  const ringsAddr = params.ringsKeys.address()
  const ringsWallet = new Wallet({ identity: ringsAddr })
  await syncWallet({ wallet: ringsWallet, keys: params.ringsKeys, client: params.spr }, ctx)

  const ringsAsset = isNativeSolMint(params.mint) ? SOL_MINT : kitAddress(params.mint)
  const spendable = ringsWallet
    .utxos()
    .filter((e) => !e.spent && e.utxo.asset === ringsAsset && e.utxo.ringProgramId === undefined && e.utxo.data.records().length === 0)
    .sort((a, b) => (b.utxo.amount > a.utxo.amount ? 1 : b.utxo.amount < a.utxo.amount ? -1 : 0))

  let selected: WalletUtxo[] = []
  const single = spendable.find((e) => e.utxo.amount >= params.amount)
  if (single) {
    selected = [single]
  } else {
    let covered = 0n
    for (const e of spendable) {
      selected.push(e)
      covered += e.utxo.amount
      if (covered >= params.amount || selected.length >= 2) break
    }
    if (covered < params.amount) {
      throw new ApiClientError(422, {
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `Insufficient Rings private balance for ${params.mint}: requested ${params.amount.toString()}, available ${covered.toString()}.`,
          retryable: false,
          stage: 'validation',
        },
      })
    }
  }

  const proofInputsList = selected.map(
    (entry) =>
      new ProofInputUtxo({
        utxo: entry.utxo,
        nullifierPublicKey: ringsAddr.nullifierPublicKey,
        nullifier: entry.nullifier,
        treeId: DEFAULT_TREE_ID,
        ...(entry.dataHash === undefined ? {} : { dataHash: entry.dataHash }),
        ...(entry.ringDataHash === undefined ? {} : { ringDataHash: entry.ringDataHash }),
      }),
  )

  const transfer = new ConfidentialTransfer(ringsAddr, proofInputsList, kitAddress(params.payer))
  transfer.send(params.targetAddress, ringsAsset, params.amount)
  const prepared = transfer.prepare()
  const encrypted = await withTransactionKey(
    params.ringsKeys,
    prepared.firstNullifier,
    (tx) => encryptConfidentialTransfer(tx, { outputs: prepared.outputs, assets: ringsWallet.registry }),
    ctx,
  )
  const sppProofInputs = prepared.finalize({
    txViewingPublicKey: encrypted.txViewingPublicKey,
    salt: encrypted.salt,
    payload: encrypted.payload,
  })

  const transact = await params.spr.proveTransact(sppProofInputs, params.ringsKeys)
  const transactBytes = encodeTransactInstructionData(transact)
  const cpiMetas = await transactCpiAccounts({
    payer: kitAddress(params.payer),
    inputTree: kitAddress(params.stateTree),
    outputTree: kitAddress(params.stateTree),
    ownerSigners: [kitAddress(params.payer)],
    signerPdas: [],
    data: transact,
  })
  const transactAccounts = cpiMetas.map((m) => ({
    pubkey: String(m.address),
    isWritable: m.role === 1 || m.role === 3,
    isSigner: m.role === 2 || m.role === 3,
  }))
  return {
    transactDataBase64: toBase64(transactBytes),
    transactAccounts,
  }
}

/**
 * Resolves a recipient Solana wallet address via the Rings User Registry (`getUserRecords` through
 * `/v1/photon`, with direct PDA fallback via `/v1/rpc`) into `(ownerHash, viewTag)` for `leave`.
 */
export async function resolveRingsRecipientAddress(
  spr: SprClient,
  walletAddress: string,
  signal?: AbortSignal,
): Promise<{ ownerHash: Uint8Array; viewTag: Uint8Array }> {
  await initializePoseidon()
  let ownerAddr: KitAddress
  let pubkeyBytes: ReturnType<typeof bytes32>
  try {
    ownerAddr = kitAddress(walletAddress)
    pubkeyBytes = bytes32(fromBase58(walletAddress))
  } catch {
    throw new ApiClientError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: `Invalid Rings destination "${walletAddress}": provide a registered Solana wallet address or a 64-char hex owner hash.`,
        retryable: false,
        stage: 'validation',
      },
    })
  }

  const ctx = signal ? { signal } : undefined
  const signingPk = ShieldedPublicKey.fromEd25519(pubkeyBytes)

  // Query Photon `getUserRecords` first.
  const lookup = await spr.getUserRecords([ownerAddr], undefined, ctx).catch(() => null)
  const indexedRecord = lookup?.records[0] ?? null
  if (indexedRecord) {
    const shielded = ShieldedAddress.fromPublicKeys(signingPk, indexedRecord.nullifierPublicKey, indexedRecord.viewingPublicKey)
    return {
      ownerHash: new Uint8Array(shielded.ownerHash()),
      viewTag: new Uint8Array(shielded.confidentialViewTag()),
    }
  }

  // Fallback to direct PDA lookup through /v1/rpc for freshly registered wallets.
  const rpcRecord = await fetchUserRecord({ rpc: spr, owner: ownerAddr }, ctx).catch(() => undefined)
  if (rpcRecord) {
    const viewingPk = X25519PublicKey.fromBytes(rpcRecord.viewingPublicKey)
    const shielded = ShieldedAddress.fromPublicKeys(signingPk, rpcRecord.nullifierPublicKey, viewingPk)
    return {
      ownerHash: new Uint8Array(shielded.ownerHash()),
      viewTag: new Uint8Array(shielded.confidentialViewTag()),
    }
  }

  throw new ApiClientError(404, {
    error: {
      code: 'NOT_FOUND',
      message: `Recipient wallet ${walletAddress} is not registered in the Rings user registry.`,
      retryable: false,
      stage: 'validation',
    },
  })
}

export {
  AssetRegistry,
  DEFAULT_TREE_ID,
  LocalKeys,
  NATIVE_SOL_MINT,
  ProofInputUtxo,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE,
  SOL_MINT,
  SPL_TOKEN_PROGRAM_ID,
  ShieldedAddress,
  SignedTeePolicy,
  addressEncoder,
  buildDepositTransaction,
  buildRegistrationTransaction,
  createSprClient,
  hashBytes,
  initializePoseidon,
  kitAddress,
  poseidon,
  solanaOwnerIdentity,
  syncWallet,
  toProgramWalletUtxo,
  Wallet,
}
export type { KitAddress, ProverTee }
