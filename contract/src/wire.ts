// Browser-safe binary codecs, constants, error catalog, call_hash, and fee split math
// matching `program/program/src/` byte for byte.

import { sha256 } from '@noble/hashes/sha2.js'
import { fromBase58, toBase58 } from './encoding.js'

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const INSTRUCTIONS_SYSVAR_ID = 'Sysvar1nstructions1111111111111111111111111'
export const SYSVAR_RENT_ID = 'SysvarRent111111111111111111111111111111111'
export const SHIELDED_POOL_PROGRAM_ID = 'ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW'
export const SOL_INTERFACE_ADDRESS = 'CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE'
export const DEFAULT_RINGS_TREE = '777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor'
export const DEFAULT_TREE_ID = 0
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
export const MARINADE_PROGRAM_ID = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'
export const KAMINO_LEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'
export const KAMINO_FARMS_PROGRAM_ID = 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr'
export const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'
export const NATIVE_SOL_MINT = SYSTEM_PROGRAM_ID // [0u8; 32] in Rings / pook program

export const isNativeSolMint = (mint: string | null | undefined): boolean =>
  mint === NATIVE_SOL_MINT || mint === WSOL_MINT

export const toProgramMintBytes = (mint: string | null | undefined): Uint8Array => {
  if (!mint || isNativeSolMint(mint)) return new Uint8Array(32)
  return fromBase58(mint)
}

export const POOK_TAGS = {
  INIT_CONFIG: 0,
  SET_CONFIG: 1,
  PUBLISH_HOOK: 2,
  ENTER: 3,
  RUN: 4,
  LEAVE: 5,
  OPEN_SEAT: 6,
  CLOSE_SEAT: 7,
  CLAIM_AUTHOR_FEES: 8,
} as const

export const POOK_DISC = {
  CONFIG: new TextEncoder().encode('PKCONFIG'),
  HOOK: new TextEncoder().encode('PKHOOK01'),
  SEAT: new TextEncoder().encode('PKSEAT01'),
  AUTHOR_FEES: new TextEncoder().encode('PKAFEE01'),
} as const

export const POOK_ERROR_NAMES: Record<number, string> = {
  7500: 'InvalidInstructionData',
  7501: 'ConfigAlreadyInitialized',
  7502: 'InvalidConfigAccount',
  7503: 'UnauthorizedAdmin',
  7504: 'InvalidFeeRate',
  7505: 'InvalidHookAccount',
  7506: 'HookAlreadyPublished',
  7507: 'InvalidHookDefinition',
  7508: 'InvalidAuthorityPda',
  7509: 'InvalidStagePda',
  7510: 'InvalidStageTokenAccount',
  7511: 'StageNotEmpty',
  7512: 'ProofVerificationFailed',
  7513: 'HashingFailed',
  7514: 'Expired',
  7515: 'InvalidShieldedPoolProgram',
  7516: 'MissingAuthorityPda',
  7517: 'ForbiddenHookAccount',
  7518: 'TargetProgramMismatch',
  7519: 'SlippageExceeded',
  7520: 'OutputBelowFees',
  7521: 'MintConstraintViolated',
  7522: 'MissingCompanionInstruction',
  7523: 'InvalidFeeRecipient',
  7524: 'InvalidAuthorFeesAccount',
  7525: 'UnauthorizedAuthor',
  7526: 'NothingToClaim',
  7527: 'InvalidSeatAccount',
  7528: 'SeatAlreadyOpen',
  7529: 'SeatNotClosable',
  7530: 'WrongHookKind',
  7531: 'StageLamportsDrained',
  7532: 'InvalidTokenProgram',
  7533: 'InvalidSystemProgram',
  7534: 'InvalidInstructionsSysvar',
  7535: 'Overflow',
  7536: 'InvalidRelayerFee',
  7537: 'InvalidLeaveKind',
  7538: 'InvalidEnterOwnerTag',
  7539: 'CallerAccountsMismatch',
  7540: 'DataSlotOutOfBounds',
}

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const bytesToBigIntBe = (bytes: Uint8Array): bigint => {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

export const bytesToDecimalField = (bytes: Uint8Array): string => bytesToBigIntBe(bytes).toString()

/** SHA-256 with byte 0 cleared to 0x00, matching `spr_hasher::sha256::Sha256BE`. */
export function sha256Be(input: Uint8Array): Uint8Array {
  const digest = sha256(input)
  digest[0] = 0
  return digest
}

export function hookIdHash(hookId: string): Uint8Array {
  return sha256Be(new TextEncoder().encode(hookId))
}

export type WireMintConstraint =
  | { kind: 'None' }
  | { kind: 'Any' }
  | { kind: 'Sol' }
  | { kind: 'Spl'; mint: string }

export type WireDataSlotKind = 'AmountInU64Le' | 'MinOutU64Le' | 'CallerSlice' | 'CallerTail'

export type WireDataSlot = {
  offset: number
  len: number
  kind: WireDataSlotKind
}

export type WireAccountSlotKind =
  | 'Fixed'
  | 'StagePda'
  | 'StageIn'
  | 'StageOut'
  | 'SeatPda'
  | 'Caller'
  | 'CallerRemaining'
  | 'Payer'

export type WireAccountSlot = {
  kind: WireAccountSlotKind
  isWritable: boolean
  isSigner: boolean
  pubkey: string
}

export type WireCompanionRequirement = {
  programId: string
  discriminatorHex: string
  discLen: number
  mustPrecede: boolean
}

export type WirePublishHookArgs = {
  hookId: string
  targetProgram: string
  kind: 'flow' | 'seat'
  mintIn: WireMintConstraint
  mintOut: WireMintConstraint
  wrapSolIn: boolean
  unwrapSolOut: boolean
  dataTemplateHex: string
  dataSlots: WireDataSlot[]
  accountSlots: WireAccountSlot[]
  companions: WireCompanionRequirement[]
}

export type WireConfigAccount = {
  admin: string
  feeRecipient: string
  runFeeBps: number
  authorShareBps: number
  bump: number
}

export type WireHookAccount = WirePublishHookArgs & {
  hookIdHashHex: string
  author: string
  bump: number
}

export type WireAuthorFeesAccount = {
  author: string
  mint: string
  accrued: bigint
  bump: number
}

export type WireSeatAccount = {
  commitmentHex: string
  openerRelayer: string
  openedAt: bigint
  seatPdaBump: number
  bump: number
}

export type WireRunKind = 'Flow' | 'SeatFund' | 'SeatAction'

export type WireRunArgs = {
  kind: WireRunKind
  proof: Uint8Array // 128 bytes: a (32) || b (64) || c (32)
  authorityBump: number
  stageBump: number
  amountIn: bigint
  minOut: bigint
  outputOwnerHash: Uint8Array // 32 bytes
  relayerFee: bigint
  expiry: bigint
  seatCommitment: Uint8Array // 32 bytes
  mintIn: Uint8Array // 32 bytes
  mintOut: Uint8Array // 32 bytes
  hasMintOut: boolean
  outSplInterfaceBump: number
  sppAccountCount: number
  callerData: Uint8Array
  callerRemainingWritable: Uint8Array
}

export type WireLeaveArgs = {
  proof: Uint8Array // 128 bytes
  authorityBump: number
  stageBump: number
  leaveKind: 0 | 1
  mint: Uint8Array // 32 bytes
  amount: bigint
  relayerFee: bigint
  expiry: bigint
  destOwnerHash: Uint8Array // 32 bytes
  destViewTag: Uint8Array // 32 bytes
  splInterfaceBump: number
  sppAccountCount: number
}

export type WireSetupCpiAccount = {
  accountIndex: number
  isWritable: boolean
  isSigner: boolean
}

export type WireSetupCpi = {
  targetProgram: string
  data: Uint8Array
  accounts: WireSetupCpiAccount[]
}

export type WireSeatLifecycleArgs = {
  proof: Uint8Array // 128 bytes
  authorityBump: number
  seatCommitment: Uint8Array // 32 bytes
  expiry: bigint
  /** Used by open_seat: number of verbatim SPP accounts ahead of trailing setup_accounts. */
  sppAccountCount?: number
  /** Used by open_seat: optional protocol initialization CPIs signed by seat_pda + payer. */
  setupCpis?: WireSetupCpi[]
}

// --- Low-level binary reader/writer ---

class BinWriter {
  private chunks: Uint8Array[] = []
  private total = 0

  u8(v: number) {
    this.bytes(Uint8Array.of(v & 0xff))
    return this
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0)
  }
  u16(v: number) {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, v, true)
    this.bytes(b)
    return this
  }
  u32(v: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v, true)
    this.bytes(b)
    return this
  }
  u64(v: bigint) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, v, true)
    this.bytes(b)
    return this
  }
  bytes(b: Uint8Array) {
    this.chunks.push(b)
    this.total += b.length
    return this
  }
  fixed(b: Uint8Array, len: number) {
    if (b.length !== len) throw new Error(`Expected ${len} bytes, got ${b.length}`)
    return this.bytes(b)
  }
  pubkey(addr: string) {
    return this.fixed(fromBase58(addr), 32)
  }
  borshString(s: string) {
    const encoded = new TextEncoder().encode(s)
    return this.u32(encoded.length).bytes(encoded)
  }
  borshBytes(b: Uint8Array) {
    return this.u32(b.length).bytes(b)
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.total)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}

class BinReader {
  private view: DataView
  private off = 0
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  get offset() {
    return this.off
  }
  remaining(): Uint8Array {
    return this.data.subarray(this.off)
  }
  u8(): number {
    if (this.off + 1 > this.data.length) throw new Error('Unexpected EOF reading u8')
    return this.data[this.off++]!
  }
  bool(): boolean {
    const v = this.u8()
    if (v > 1) throw new Error(`Invalid bool byte ${v}`)
    return v === 1
  }
  u16(): number {
    if (this.off + 2 > this.data.length) throw new Error('Unexpected EOF reading u16')
    const v = this.view.getUint16(this.off, true)
    this.off += 2
    return v
  }
  u32(): number {
    if (this.off + 4 > this.data.length) throw new Error('Unexpected EOF reading u32')
    const v = this.view.getUint32(this.off, true)
    this.off += 4
    return v
  }
  u64(): bigint {
    if (this.off + 8 > this.data.length) throw new Error('Unexpected EOF reading u64')
    const v = this.view.getBigUint64(this.off, true)
    this.off += 8
    return v
  }
  i64(): bigint {
    if (this.off + 8 > this.data.length) throw new Error('Unexpected EOF reading i64')
    const v = this.view.getBigInt64(this.off, true)
    this.off += 8
    return v
  }
  fixed(len: number): Uint8Array {
    if (this.off + len > this.data.length) throw new Error(`Unexpected EOF reading ${len} bytes`)
    const out = this.data.slice(this.off, this.off + len)
    this.off += len
    return out
  }
  pubkey(): string {
    return toBase58(this.fixed(32))
  }
  borshString(): string {
    const len = this.u32()
    return new TextDecoder().decode(this.fixed(len))
  }
  borshBytes(): Uint8Array {
    const len = this.u32()
    return this.fixed(len)
  }
}

const DATA_SLOT_KINDS: readonly WireDataSlotKind[] = ['AmountInU64Le', 'MinOutU64Le', 'CallerSlice', 'CallerTail']
const ACCOUNT_SLOT_KINDS: readonly WireAccountSlotKind[] = [
  'Fixed',
  'StagePda',
  'StageIn',
  'StageOut',
  'SeatPda',
  'Caller',
  'CallerRemaining',
  'Payer',
]
const RUN_KINDS: readonly WireRunKind[] = ['Flow', 'SeatFund', 'SeatAction']

function writeMintConstraint(w: BinWriter, c: WireMintConstraint) {
  switch (c.kind) {
    case 'None':
      return w.u8(0)
    case 'Any':
      return w.u8(1)
    case 'Sol':
      return w.u8(2)
    case 'Spl':
      return w.u8(3).pubkey(c.mint)
  }
}

function readMintConstraint(r: BinReader): WireMintConstraint {
  const tag = r.u8()
  if (tag === 0) return { kind: 'None' }
  if (tag === 1) return { kind: 'Any' }
  if (tag === 2) return { kind: 'Sol' }
  if (tag === 3) return { kind: 'Spl', mint: r.pubkey() }
  throw new Error(`Unknown MintConstraint tag ${tag}`)
}

function checkDisc(actual: Uint8Array, expected: Uint8Array, label: string) {
  if (actual.length !== expected.length || actual.some((b, i) => b !== expected[i])) {
    throw new Error(`Invalid ${label} account discriminator`)
  }
}

// --- On-chain account decoders ---

export function decodeConfigAccount(data: Uint8Array): WireConfigAccount {
  const r = new BinReader(data)
  checkDisc(r.fixed(8), POOK_DISC.CONFIG, 'Config')
  return {
    admin: r.pubkey(),
    feeRecipient: r.pubkey(),
    runFeeBps: r.u16(),
    authorShareBps: r.u16(),
    bump: r.u8(),
  }
}

export function decodeHookAccount(data: Uint8Array): WireHookAccount {
  const r = new BinReader(data)
  checkDisc(r.fixed(8), POOK_DISC.HOOK, 'Hook')
  const hookIdHashHex = toHex(r.fixed(32))
  const hookId = r.borshString()
  const author = r.pubkey()
  const targetProgram = r.pubkey()
  const kindTag = r.u8()
  const kind = kindTag === 0 ? 'flow' : kindTag === 1 ? 'seat' : (() => { throw new Error(`Unknown HookKind ${kindTag}`) })()
  const mintIn = readMintConstraint(r)
  const mintOut = readMintConstraint(r)
  const wrapSolIn = r.bool()
  const unwrapSolOut = r.bool()
  const dataTemplateHex = toHex(r.borshBytes())
  const dataSlotCount = r.u32()
  const dataSlots: WireDataSlot[] = []
  for (let i = 0; i < dataSlotCount; i++) {
    const offset = r.u16()
    const len = r.u16()
    const kindIdx = r.u8()
    const slotKind = DATA_SLOT_KINDS[kindIdx]
    if (!slotKind) throw new Error(`Unknown DataSlotKind ${kindIdx}`)
    dataSlots.push({ offset, len, kind: slotKind })
  }
  const accountSlotCount = r.u32()
  const accountSlots: WireAccountSlot[] = []
  for (let i = 0; i < accountSlotCount; i++) {
    const kindIdx = r.u8()
    const slotKind = ACCOUNT_SLOT_KINDS[kindIdx]
    if (!slotKind) throw new Error(`Unknown AccountSlotKind ${kindIdx}`)
    const isWritable = r.bool()
    const isSigner = r.bool()
    const pubkey = r.pubkey()
    accountSlots.push({ kind: slotKind, isWritable, isSigner, pubkey })
  }
  const companionCount = r.u32()
  const companions: WireCompanionRequirement[] = []
  for (let i = 0; i < companionCount; i++) {
    const programId = r.pubkey()
    const disc = r.fixed(8)
    const discLen = r.u8()
    const mustPrecede = r.bool()
    companions.push({ programId, discriminatorHex: toHex(disc.subarray(0, discLen)), discLen, mustPrecede })
  }
  const bump = r.u8()
  return {
    hookIdHashHex,
    hookId,
    author,
    targetProgram,
    kind,
    mintIn,
    mintOut,
    wrapSolIn,
    unwrapSolOut,
    dataTemplateHex,
    dataSlots,
    accountSlots,
    companions,
    bump,
  }
}

export function decodeAuthorFeesAccount(data: Uint8Array): WireAuthorFeesAccount {
  const r = new BinReader(data)
  checkDisc(r.fixed(8), POOK_DISC.AUTHOR_FEES, 'AuthorFees')
  return {
    author: r.pubkey(),
    mint: r.pubkey(),
    accrued: r.u64(),
    bump: r.u8(),
  }
}

export function decodeSeatAccount(data: Uint8Array): WireSeatAccount {
  const r = new BinReader(data)
  checkDisc(r.fixed(8), POOK_DISC.SEAT, 'Seat')
  return {
    commitmentHex: toHex(r.fixed(32)),
    openerRelayer: r.pubkey(),
    openedAt: r.i64(),
    seatPdaBump: r.u8(),
    bump: r.u8(),
  }
}

// --- Instruction data encoders & decoders ---

export function encodeInitConfigIxData(args: { feeRecipient: string; runFeeBps: number; authorShareBps: number }): Uint8Array {
  return new BinWriter()
    .u8(POOK_TAGS.INIT_CONFIG)
    .pubkey(args.feeRecipient)
    .u16(args.runFeeBps)
    .u16(args.authorShareBps)
    .finish()
}

export function encodeSetConfigIxData(args: { admin: string; feeRecipient: string; runFeeBps: number; authorShareBps: number }): Uint8Array {
  return new BinWriter()
    .u8(POOK_TAGS.SET_CONFIG)
    .pubkey(args.admin)
    .pubkey(args.feeRecipient)
    .u16(args.runFeeBps)
    .u16(args.authorShareBps)
    .finish()
}

export function encodePublishHookIxData(args: WirePublishHookArgs): Uint8Array {
  const w = new BinWriter()
    .u8(POOK_TAGS.PUBLISH_HOOK)
    .borshString(args.hookId)
    .pubkey(args.targetProgram)
    .u8(args.kind === 'flow' ? 0 : 1)
  writeMintConstraint(w, args.mintIn)
  writeMintConstraint(w, args.mintOut)
  w.bool(args.wrapSolIn)
    .bool(args.unwrapSolOut)
    .borshBytes(fromHex(args.dataTemplateHex))
    .u32(args.dataSlots.length)
  for (const s of args.dataSlots) {
    const idx = DATA_SLOT_KINDS.indexOf(s.kind)
    if (idx < 0) throw new Error(`Invalid DataSlotKind ${s.kind}`)
    w.u16(s.offset).u16(s.len).u8(idx)
  }
  w.u32(args.accountSlots.length)
  for (const s of args.accountSlots) {
    const idx = ACCOUNT_SLOT_KINDS.indexOf(s.kind)
    if (idx < 0) throw new Error(`Invalid AccountSlotKind ${s.kind}`)
    w.u8(idx).bool(s.isWritable).bool(s.isSigner).pubkey(s.pubkey || SYSTEM_PROGRAM_ID)
  }
  w.u32(args.companions.length)
  for (const c of args.companions) {
    const raw = fromHex(c.discriminatorHex)
    const padded = new Uint8Array(8)
    padded.set(raw.subarray(0, 8))
    w.pubkey(c.programId).fixed(padded, 8).u8(c.discLen).bool(c.mustPrecede)
  }
  return w.finish()
}

export function decodePublishHookIxData(data: Uint8Array): WirePublishHookArgs {
  const r = new BinReader(data)
  if (r.u8() !== POOK_TAGS.PUBLISH_HOOK) throw new Error('Expected PUBLISH_HOOK tag')
  const hookId = r.borshString()
  const targetProgram = r.pubkey()
  const kindTag = r.u8()
  const kind = kindTag === 0 ? 'flow' : 'seat'
  const mintIn = readMintConstraint(r)
  const mintOut = readMintConstraint(r)
  const wrapSolIn = r.bool()
  const unwrapSolOut = r.bool()
  const dataTemplateHex = toHex(r.borshBytes())
  const dataSlotCount = r.u32()
  const dataSlots: WireDataSlot[] = []
  for (let i = 0; i < dataSlotCount; i++) {
    const offset = r.u16()
    const len = r.u16()
    const slotKind = DATA_SLOT_KINDS[r.u8()]
    if (!slotKind) throw new Error('Unknown DataSlotKind')
    dataSlots.push({ offset, len, kind: slotKind })
  }
  const accountSlotCount = r.u32()
  const accountSlots: WireAccountSlot[] = []
  for (let i = 0; i < accountSlotCount; i++) {
    const slotKind = ACCOUNT_SLOT_KINDS[r.u8()]
    if (!slotKind) throw new Error('Unknown AccountSlotKind')
    const isWritable = r.bool()
    const isSigner = r.bool()
    const pubkey = r.pubkey()
    accountSlots.push({ kind: slotKind, isWritable, isSigner, pubkey })
  }
  const companionCount = r.u32()
  const companions: WireCompanionRequirement[] = []
  for (let i = 0; i < companionCount; i++) {
    const programId = r.pubkey()
    const disc = r.fixed(8)
    const discLen = r.u8()
    const mustPrecede = r.bool()
    companions.push({ programId, discriminatorHex: toHex(disc.subarray(0, discLen)), discLen, mustPrecede })
  }
  return { hookId, targetProgram, kind, mintIn, mintOut, wrapSolIn, unwrapSolOut, dataTemplateHex, dataSlots, accountSlots, companions }
}

export function encodeEnterPublicIxData(args: {
  kind: { type: 'sol' } | { type: 'spl'; splInterfaceBump: number }
  authorityBump: number
  ownerHash: Uint8Array
  amount: bigint
}): Uint8Array {
  const w = new BinWriter().u8(POOK_TAGS.ENTER).u8(0)
  if (args.kind.type === 'sol') w.u8(0)
  else w.u8(1).u8(args.kind.splInterfaceBump)
  return w.u8(args.authorityBump).fixed(args.ownerHash, 32).u64(args.amount).finish()
}

export function encodeEnterPrivateIxData(authorityBump: number, transactBytes: Uint8Array): Uint8Array {
  return new BinWriter().u8(POOK_TAGS.ENTER).u8(1).u8(authorityBump).bytes(transactBytes).finish()
}

export function encodeRunIxData(args: WireRunArgs, transactBytes: Uint8Array): Uint8Array {
  const kindIdx = RUN_KINDS.indexOf(args.kind)
  if (kindIdx < 0) throw new Error(`Invalid RunKind ${args.kind}`)
  return new BinWriter()
    .u8(POOK_TAGS.RUN)
    .u8(kindIdx)
    .fixed(args.proof, 128)
    .u8(args.authorityBump)
    .u8(args.stageBump)
    .u64(args.amountIn)
    .u64(args.minOut)
    .fixed(args.outputOwnerHash, 32)
    .u64(args.relayerFee)
    .u64(args.expiry)
    .fixed(args.seatCommitment, 32)
    .fixed(args.mintIn, 32)
    .fixed(args.mintOut, 32)
    .bool(args.hasMintOut)
    .u8(args.outSplInterfaceBump)
    .u8(args.sppAccountCount)
    .u16(args.callerData.length)
    .bytes(args.callerData)
    .u8(args.callerRemainingWritable.length)
    .bytes(args.callerRemainingWritable)
    .bytes(transactBytes)
    .finish()
}

export function decodeRunIxData(data: Uint8Array): { args: WireRunArgs; transactBytes: Uint8Array } {
  const r = new BinReader(data)
  if (r.u8() !== POOK_TAGS.RUN) throw new Error('Expected RUN tag')
  const kind = RUN_KINDS[r.u8()]
  if (!kind) throw new Error('Unknown RunKind')
  const proof = r.fixed(128)
  const authorityBump = r.u8()
  const stageBump = r.u8()
  const amountIn = r.u64()
  const minOut = r.u64()
  const outputOwnerHash = r.fixed(32)
  const relayerFee = r.u64()
  const expiry = r.u64()
  const seatCommitment = r.fixed(32)
  const mintIn = r.fixed(32)
  const mintOut = r.fixed(32)
  const hasMintOut = r.bool()
  const outSplInterfaceBump = r.u8()
  const sppAccountCount = r.u8()
  const callerDataLen = r.u16()
  const callerData = r.fixed(callerDataLen)
  const remLen = r.u8()
  const callerRemainingWritable = r.fixed(remLen)
  const transactBytes = r.remaining()
  return {
    args: {
      kind,
      proof,
      authorityBump,
      stageBump,
      amountIn,
      minOut,
      outputOwnerHash,
      relayerFee,
      expiry,
      seatCommitment,
      mintIn,
      mintOut,
      hasMintOut,
      outSplInterfaceBump,
      sppAccountCount,
      callerData,
      callerRemainingWritable,
    },
    transactBytes,
  }
}

export function encodeLeaveIxData(args: WireLeaveArgs, transactBytes: Uint8Array): Uint8Array {
  return new BinWriter()
    .u8(POOK_TAGS.LEAVE)
    .fixed(args.proof, 128)
    .u8(args.authorityBump)
    .u8(args.stageBump)
    .u8(args.leaveKind)
    .fixed(args.mint, 32)
    .u64(args.amount)
    .u64(args.relayerFee)
    .u64(args.expiry)
    .fixed(args.destOwnerHash, 32)
    .fixed(args.destViewTag, 32)
    .u8(args.splInterfaceBump)
    .u8(args.sppAccountCount)
    .bytes(transactBytes)
    .finish()
}

export function decodeLeaveIxData(data: Uint8Array): { args: WireLeaveArgs; transactBytes: Uint8Array } {
  const r = new BinReader(data)
  if (r.u8() !== POOK_TAGS.LEAVE) throw new Error('Expected LEAVE tag')
  const proof = r.fixed(128)
  const authorityBump = r.u8()
  const stageBump = r.u8()
  const leaveKind = r.u8() as 0 | 1
  const mint = r.fixed(32)
  const amount = r.u64()
  const relayerFee = r.u64()
  const expiry = r.u64()
  const destOwnerHash = r.fixed(32)
  const destViewTag = r.fixed(32)
  const splInterfaceBump = r.u8()
  const sppAccountCount = r.u8()
  return {
    args: { proof, authorityBump, stageBump, leaveKind, mint, amount, relayerFee, expiry, destOwnerHash, destViewTag, splInterfaceBump, sppAccountCount },
    transactBytes: r.remaining(),
  }
}

export function encodeOpenSeatIxData(args: WireSeatLifecycleArgs, transactBytes: Uint8Array): Uint8Array {
  const setupCpis = args.setupCpis ?? []
  const w = new BinWriter()
    .u8(POOK_TAGS.OPEN_SEAT)
    .fixed(args.proof, 128)
    .u8(args.authorityBump)
    .fixed(args.seatCommitment, 32)
    .u64(args.expiry)
    .u8(args.sppAccountCount ?? 0)
    .u8(setupCpis.length)
  for (const cpi of setupCpis) {
    w.pubkey(cpi.targetProgram).u16(cpi.data.length).bytes(cpi.data).u8(cpi.accounts.length)
    for (const acc of cpi.accounts) {
      w.u8(acc.accountIndex).bool(acc.isWritable).bool(acc.isSigner)
    }
  }
  return w.bytes(transactBytes).finish()
}

export function encodeCloseSeatIxData(args: WireSeatLifecycleArgs, transactBytes: Uint8Array): Uint8Array {
  return new BinWriter()
    .u8(POOK_TAGS.CLOSE_SEAT)
    .fixed(args.proof, 128)
    .u8(args.authorityBump)
    .fixed(args.seatCommitment, 32)
    .u64(args.expiry)
    .bytes(transactBytes)
    .finish()
}

export function decodeSeatLifecycleIxData(data: Uint8Array): { tag: number; args: WireSeatLifecycleArgs; transactBytes: Uint8Array } {
  const r = new BinReader(data)
  const tag = r.u8()
  const proof = r.fixed(128)
  const authorityBump = r.u8()
  const seatCommitment = r.fixed(32)
  const expiry = r.u64()
  if (tag === POOK_TAGS.OPEN_SEAT) {
    const sppAccountCount = r.u8()
    const cpiCount = r.u8()
    const setupCpis: WireSetupCpi[] = []
    for (let i = 0; i < cpiCount; i++) {
      const targetProgram = r.pubkey()
      const dataLen = r.u16()
      const cpiData = r.fixed(dataLen)
      const accCount = r.u8()
      const accounts: WireSetupCpiAccount[] = []
      for (let j = 0; j < accCount; j++) {
        accounts.push({ accountIndex: r.u8(), isWritable: r.bool(), isSigner: r.bool() })
      }
      setupCpis.push({ targetProgram, data: cpiData, accounts })
    }
    return { tag, args: { proof, authorityBump, seatCommitment, expiry, sppAccountCount, setupCpis }, transactBytes: r.remaining() }
  }
  return { tag, args: { proof, authorityBump, seatCommitment, expiry }, transactBytes: r.remaining() }
}

export function encodeClaimAuthorFeesIxData(mint: string | null): Uint8Array {
  return new BinWriter().u8(POOK_TAGS.CLAIM_AUTHOR_FEES).fixed(toProgramMintBytes(mint), 32).finish()
}

export function decodeClaimAuthorFeesIxData(data: Uint8Array): { mint: string } {
  const r = new BinReader(data)
  if (r.u8() !== POOK_TAGS.CLAIM_AUTHOR_FEES) throw new Error('Expected CLAIM_AUTHOR_FEES tag')
  return { mint: r.pubkey() }
}

// --- CPI resolution, call_hash, and fee split (exact match with Rust program) ---

export function resolveCpiData(
  dataTemplateHex: string,
  dataSlots: readonly WireDataSlot[],
  amountIn: bigint,
  minOut: bigint,
  callerData: Uint8Array,
): Uint8Array {
  let out = Array.from(fromHex(dataTemplateHex))
  let callerCursor = 0

  for (const slot of dataSlots) {
    const off = slot.offset
    const len = slot.len
    if (slot.kind === 'AmountInU64Le' || slot.kind === 'MinOutU64Le') {
      const end = off + 8
      if (end > out.length) throw new Error(`DataSlot ${slot.kind} out of bounds (${end} > ${out.length})`)
      const b = new Uint8Array(8)
      new DataView(b.buffer).setBigUint64(0, slot.kind === 'AmountInU64Le' ? amountIn : minOut, true)
      for (let i = 0; i < 8; i++) out[off + i] = b[i]!
    } else if (slot.kind === 'CallerSlice') {
      const srcEnd = callerCursor + len
      const dstEnd = off + len
      if (srcEnd > callerData.length || dstEnd > out.length) throw new Error('DataSlot CallerSlice out of bounds')
      for (let i = 0; i < len; i++) out[off + i] = callerData[callerCursor + i]!
      callerCursor = srcEnd
    } else if (slot.kind === 'CallerTail') {
      const tail = callerData.subarray(callerCursor)
      if (len > 0 && tail.length > len) throw new Error('DataSlot CallerTail exceeds max len')
      for (let i = 0; i < tail.length; i++) out.push(tail[i]!)
      callerCursor = callerData.length
    }
  }

  if (callerCursor !== callerData.length) {
    throw new Error(`Unconsumed callerData bytes (${callerCursor} != ${callerData.length})`)
  }
  return Uint8Array.from(out)
}

export function computeCallHash(
  targetProgram: string,
  hasMintOut: boolean,
  mintOut: string | null,
  cpiData: Uint8Array,
  cpiMetas: readonly { pubkey: string; isWritable: boolean; isSigner: boolean }[],
): Uint8Array {
  const w = new BinWriter()
    .bytes(new TextEncoder().encode('PKCALL01'))
    .pubkey(targetProgram)
    .bool(hasMintOut)
    .fixed(hasMintOut ? toProgramMintBytes(mintOut) : new Uint8Array(32), 32)
    .u32(cpiData.length)
    .bytes(cpiData)
    .u16(cpiMetas.length)
  for (const m of cpiMetas) {
    w.pubkey(m.pubkey).bool(m.isWritable).bool(m.isSigner)
  }
  return sha256Be(w.finish())
}

/** Exact fee split matching on-chain `compute_fee_split` (protocol share rounded down). */
export function computeFeeSplit(deltaOut: bigint, runFeeBps: number, authorShareBps: number) {
  const runFee = (deltaOut * BigInt(runFeeBps)) / 10_000n
  const protocolBps = BigInt(10_000 - authorShareBps)
  const protocolFee = (runFee * protocolBps) / 10_000n
  const authorFee = runFee - protocolFee
  return { runFee, protocolFee, authorFee }
}
