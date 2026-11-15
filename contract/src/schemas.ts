import { z } from 'zod'
import { defineErrors } from './errors.js'
import { Address, Base64, BaseUnits, Hex, HookId, PageInfo, PageQuery, PositiveU64, Signature, Timestamp, U64, openEnum, page } from './primitives.js'
import { SYSTEM_PROGRAM_ID, WSOL_MINT, isNativeSolMint, type WirePublishHookArgs } from './wire.js'

export { CONTRACT_VERSION } from './version.js'

export const errors = defineErrors({
  NO_ROUTE: 422,
  QUOTE_EXPIRED: 409,
  INSUFFICIENT_BALANCE: 422,
  PROOF_FAILED: 422,
  PROOF_EXPIRED: 409,
  RELAY_REFUSED: 422,
  WALLET_REJECTED: 400,
  IDL_INVALID: 400,
  HOOK_ALREADY_EXISTS: 409,
  SEAT_NOT_EMPTY: 409,
  SCAN_FAILED: 502,
})

export type KnownErrorCode = z.output<typeof errors.KnownErrorCode>
export type ErrorCode = z.output<typeof errors.ErrorCode>
export type ApiError = z.output<typeof errors.ApiError>

export const SCENARIOS = [
  'default',
  'waiting',
  'empty',
  'no_balance',
  'no_seats',
  'no_route',
  'simulation_failed',
  'run_failed',
  'run_expired',
  'scan_failed',
] as const
export type Scenario = (typeof SCENARIOS)[number]

// --- Shared open enums (responses) & strict enums (requests) ---

export const KNOWN_CLUSTERS = ['localnet', 'devnet', 'mainnet'] as const
export const Cluster = openEnum(KNOWN_CLUSTERS)

export const KNOWN_READINESS_STATUSES = ['ready', 'waiting', 'fixture'] as const
export const ReadinessStatus = openEnum(KNOWN_READINESS_STATUSES)

export const KNOWN_HOOK_KINDS = ['flow', 'seat'] as const
export const HookKind = openEnum(KNOWN_HOOK_KINDS)
export const StrictHookKind = z.enum(KNOWN_HOOK_KINDS)

// Display slot enums (Round 1 UI compatibility)
export const KNOWN_DATA_SLOT_KINDS = ['amount_in', 'min_out', 'caller_arg', 'seat_arg'] as const
export const DataSlotKind = openEnum(KNOWN_DATA_SLOT_KINDS)
export const StrictDataSlotKind = z.enum(KNOWN_DATA_SLOT_KINDS)

export const KNOWN_DATA_SLOT_TYPES = ['u8', 'u16', 'u32', 'u64', 'u128', 'bool', 'pubkey', 'bytes'] as const
export const DataSlotType = openEnum(KNOWN_DATA_SLOT_TYPES)
export const StrictDataSlotType = z.enum(KNOWN_DATA_SLOT_TYPES)

export const KNOWN_ACCOUNT_ROLES = [
  'fixed',
  'stage_authority',
  'stage_in',
  'stage_out',
  'seat_pda',
  'caller_supplied',
  'program',
  'sysvar',
  'payer',
] as const
export const AccountRole = openEnum(KNOWN_ACCOUNT_ROLES)
export const StrictAccountRole = z.enum(KNOWN_ACCOUNT_ROLES)

// Canonical on-chain Hook enums (mirroring program/program/src/state.rs)
export const KNOWN_MINT_CONSTRAINT_KINDS = ['None', 'Any', 'Sol', 'Spl'] as const
export const StrictMintConstraint = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('None') }),
  z.strictObject({ kind: z.literal('Any') }),
  z.strictObject({ kind: z.literal('Sol') }),
  z.strictObject({ kind: z.literal('Spl'), mint: Address }),
])
export const MintConstraint = z.object({
  kind: openEnum(KNOWN_MINT_CONSTRAINT_KINDS),
  mint: Address.optional(),
})
export type MintConstraint = z.output<typeof MintConstraint>

export const KNOWN_ONCHAIN_DATA_SLOT_KINDS = ['AmountInU64Le', 'MinOutU64Le', 'CallerSlice', 'CallerTail'] as const
export const StrictOnChainDataSlotKind = z.enum(KNOWN_ONCHAIN_DATA_SLOT_KINDS)
export const OnChainDataSlot = z.object({
  offset: z.number().int(),
  len: z.number().int(),
  kind: openEnum(KNOWN_ONCHAIN_DATA_SLOT_KINDS),
})
export type OnChainDataSlot = z.output<typeof OnChainDataSlot>
export const StrictOnChainDataSlot = z.strictObject({
  offset: z.number().int().min(0).max(256),
  len: z.number().int().min(0).max(256),
  kind: StrictOnChainDataSlotKind,
})

export const KNOWN_ONCHAIN_ACCOUNT_SLOT_KINDS = [
  'Fixed',
  'StagePda',
  'StageIn',
  'StageOut',
  'SeatPda',
  'Caller',
  'CallerRemaining',
  'Payer',
] as const
export const StrictOnChainAccountSlotKind = z.enum(KNOWN_ONCHAIN_ACCOUNT_SLOT_KINDS)
export const OnChainAccountSlot = z.object({
  kind: openEnum(KNOWN_ONCHAIN_ACCOUNT_SLOT_KINDS),
  isWritable: z.boolean(),
  isSigner: z.boolean(),
  pubkey: Address,
})
export type OnChainAccountSlot = z.output<typeof OnChainAccountSlot>
export const StrictOnChainAccountSlot = z.strictObject({
  kind: StrictOnChainAccountSlotKind,
  isWritable: z.boolean(),
  isSigner: z.boolean(),
  pubkey: Address.default(SYSTEM_PROGRAM_ID),
})

export const OnChainCompanion = z.object({
  programId: Address,
  discriminatorHex: Hex,
  discLen: z.number().int(),
  mustPrecede: z.boolean(),
})
export type OnChainCompanion = z.output<typeof OnChainCompanion>
export const StrictOnChainCompanion = z.strictObject({
  programId: Address,
  discriminatorHex: Hex.max(16, 'Companion discriminator must be at most 8 bytes.'),
  discLen: z.number().int().min(0).max(8),
  mustPrecede: z.boolean(),
})

export const KNOWN_RUN_STATUSES = ['confirmed', 'finalized'] as const
export const RunStatus = openEnum(KNOWN_RUN_STATUSES)

export const KNOWN_RELAY_STATUSES = ['accepted', 'submitted', 'confirmed', 'finalized', 'failed', 'expired'] as const
export const RelayStatus = openEnum(KNOWN_RELAY_STATUSES)

export const KNOWN_TX_STATUSES = ['built', 'submitted', 'unconfirmed', 'confirmed', 'finalized', 'failed', 'expired'] as const
export const TxStatus = openEnum(KNOWN_TX_STATUSES)

export const KNOWN_TX_ACTIONS = ['enter', 'publish_hook', 'claim_author_fees'] as const
export const TxAction = openEnum(KNOWN_TX_ACTIONS)

export const KNOWN_SEAT_STATUSES = ['open', 'empty', 'closed'] as const
export const SeatStatus = openEnum(KNOWN_SEAT_STATUSES)

export const KNOWN_FORM_FIELD_KINDS = ['asset_in', 'asset_out', 'amount', 'slippage_bps', 'seat', 'text', 'integer'] as const
export const FormFieldKind = openEnum(KNOWN_FORM_FIELD_KINDS)
export const StrictFormFieldKind = z.enum(KNOWN_FORM_FIELD_KINDS)

// --- Health, Config, Stats ---

export const AssetInfo = z.object({
  mint: Address,
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  isNative: z.boolean().optional(),
})
export type AssetInfo = z.output<typeof AssetInfo>

export const HealthResponse = z.object({
  status: ReadinessStatus,
  programId: Address.nullable(),
  cluster: Cluster,
  contractVersion: z.string(),
  asOf: Timestamp,
})
export type HealthResponse = z.output<typeof HealthResponse>

export const ConfigResponse = z.object({
  status: ReadinessStatus,
  cluster: Cluster,
  programId: Address.nullable(),
  authorityPda: Address.nullable(),
  stagePda: Address.nullable().optional(),
  configPda: Address.nullable().optional(),
  ringsProgramId: Address,
  stateTree: Address,
  /** Undecided configuration point: null while unset; UI shows as not set. */
  runFeeBps: z.number().int().nullable(),
  /** Undecided configuration point: null while unset; UI shows as not set. */
  authorShareBps: z.number().int().nullable(),
  feeRecipient: Address.nullable(),
  pookMint: Address.nullable(),
  relayerUrl: z.string(),
  proverUrl: z.string(),
  photonRelayUrl: z.string().optional(),
  supportedAssets: z.array(AssetInfo),
  asOf: Timestamp,
})
export type ConfigResponse = z.output<typeof ConfigResponse>

export const AssetVolume = z.object({
  mint: Address,
  symbol: z.string(),
  decimals: z.number().int(),
  volume: BaseUnits,
})
export type AssetVolume = z.output<typeof AssetVolume>

export const StatsResponse = z.object({
  status: ReadinessStatus,
  hooksCount: z.number().int(),
  runsCount: z.number().int(),
  activeSeatsCount: z.number().int(),
  volumeByAsset: z.array(AssetVolume),
  asOf: Timestamp,
})
export type StatsResponse = z.output<typeof StatsResponse>

// --- Hook Templates & Registry ---

export const DataSlot = z.object({
  name: z.string(),
  kind: DataSlotKind,
  offset: z.number().int(),
  length: z.number().int(),
  type: DataSlotType,
  label: z.string().optional(),
  description: z.string().optional(),
})
export type DataSlot = z.output<typeof DataSlot>

export const DataTemplate = z.object({
  baseHex: Hex,
  slots: z.array(DataSlot),
})
export type DataTemplate = z.output<typeof DataTemplate>

export const AccountSlot = z.object({
  index: z.number().int(),
  name: z.string(),
  role: AccountRole,
  address: Address.nullable().optional(),
  writable: z.boolean(),
  signer: z.boolean(),
  description: z.string().optional(),
})
export type AccountSlot = z.output<typeof AccountSlot>

export const CompanionInstruction = z.object({
  programId: Address,
  instructionName: z.string(),
  discriminator: Hex,
  position: openEnum(['before', 'after'] as const),
  description: z.string().optional(),
})
export type CompanionInstruction = z.output<typeof CompanionInstruction>

export const HookFormField = z.object({
  name: z.string(),
  kind: FormFieldKind,
  label: z.string(),
  required: z.boolean(),
  defaultValue: z.string().optional(),
  placeholder: z.string().optional(),
})
export type HookFormField = z.output<typeof HookFormField>

export const HookStats = z.object({
  runsCount: z.number().int(),
  volumeIn: BaseUnits,
  volumeOut: BaseUnits,
  lastRunAt: Timestamp.nullable(),
})
export type HookStats = z.output<typeof HookStats>

export const HookSummary = z.object({
  id: z.string(),
  address: Address,
  protocol: z.string(),
  protocolName: z.string(),
  label: z.string(),
  description: z.string(),
  kind: HookKind,
  targetProgram: Address,
  instructionName: z.string(),
  mintIn: Address.nullable(),
  mintOut: Address.nullable(),
  mintInConstraint: MintConstraint.optional(),
  mintOutConstraint: MintConstraint.optional(),
  wrapSolIn: z.boolean().optional(),
  unwrapSolOut: z.boolean().optional(),
  assetInSymbol: z.string().nullable(),
  assetOutSymbol: z.string().nullable(),
  author: Address,
  authorShareBps: z.number().int().nullable(),
  immutable: z.boolean(),
  sdkCall: z.string(),
  stats: HookStats,
  publishedAt: Timestamp,
})
export type HookSummary = z.output<typeof HookSummary>

export const HookDetail = HookSummary.extend({
  discriminator: Hex,
  dataTemplate: DataTemplate,
  accountsTemplate: z.array(AccountSlot),
  companionInstructions: z.array(CompanionInstruction),
  // Canonical on-chain layout mirroring `Hook` in pook-program
  dataTemplateHex: Hex.optional(),
  dataSlots: z.array(OnChainDataSlot).optional(),
  accountSlots: z.array(OnChainAccountSlot).optional(),
  companions: z.array(OnChainCompanion).optional(),
  formFields: z.array(HookFormField),
  publishSignature: Signature,
})
export type HookDetail = z.output<typeof HookDetail>

export const HooksQuery = PageQuery.extend({
  protocol: z.string().min(1).max(32).optional(),
  kind: StrictHookKind.optional(),
  q: z.string().max(64).optional(),
})
export type HooksQuery = z.output<typeof HooksQuery>

export const HooksPage = z.object({
  status: ReadinessStatus,
  items: z.array(HookSummary),
  page: PageInfo,
  asOf: Timestamp,
})
export type HooksPage = z.output<typeof HooksPage>

// --- Public Runs Feed ---

export const PublicRun = z.object({
  signature: Signature,
  slot: U64,
  hookId: z.string(),
  hookAddress: Address,
  protocol: z.string(),
  kind: HookKind,
  mintIn: Address.nullable(),
  assetInSymbol: z.string().nullable(),
  amountIn: BaseUnits,
  mintOut: Address.nullable(),
  assetOutSymbol: z.string().nullable(),
  amountOut: BaseUnits,
  runFeeAmount: BaseUnits,
  relayerFeeAmount: BaseUnits,
  stageAuthority: Address,
  relayer: Address,
  status: RunStatus,
  timestamp: Timestamp,
})
export type PublicRun = z.output<typeof PublicRun>

export const HookDetailResponse = z.object({
  hook: HookDetail,
  recentRuns: z.array(PublicRun),
  asOf: Timestamp,
})
export type HookDetailResponse = z.output<typeof HookDetailResponse>

export const RunsQuery = PageQuery.extend({
  hookId: HookId.optional(),
  protocol: z.string().min(1).max(32).optional(),
})
export type RunsQuery = z.output<typeof RunsQuery>

export const RunsPage = z.object({
  status: ReadinessStatus,
  items: z.array(PublicRun),
  page: PageInfo,
  asOf: Timestamp,
})
export type RunsPage = z.output<typeof RunsPage>

// --- Quotes & Resolvers ---

export const ResolvedAccount = z.object({
  index: z.number().int(),
  name: z.string(),
  address: Address,
  writable: z.boolean(),
  signer: z.boolean(),
})
export type ResolvedAccount = z.output<typeof ResolvedAccount>

export const ResolvedInstruction = z.object({
  programId: Address,
  accounts: z.array(
    z.object({
      pubkey: Address,
      isWritable: z.boolean(),
      isSigner: z.boolean(),
    }),
  ),
  dataBase64: Base64,
})
export type ResolvedInstruction = z.output<typeof ResolvedInstruction>

export const StrictResolvedInstruction = z.strictObject({
  programId: Address,
  accounts: z.array(
    z.strictObject({
      pubkey: Address,
      isWritable: z.boolean(),
      isSigner: z.boolean(),
    }),
  ),
  dataBase64: Base64,
})

export const QuoteRequest = z.strictObject({
  mintIn: Address.optional(),
  mintOut: Address.optional(),
  amountIn: PositiveU64,
  /** Caller-supplied minimum output in base units; required for hooks without a built-in quote resolver when the hook produces an output asset. */
  minimumOut: BaseUnits.optional(),
  slippageBps: z.number().int().min(0).max(5000).default(50),
  seatAddress: Address.optional(),
  args: z.record(z.string(), z.string()).optional(),
})
export type QuoteRequest = z.input<typeof QuoteRequest>

export const QuoteFees = z.object({
  runFeeAmount: BaseUnits,
  runFeeBps: z.number().int().nullable(),
  authorShareAmount: BaseUnits,
  authorShareBps: z.number().int().nullable(),
  protocolShareAmount: BaseUnits,
  relayerFeeAmount: BaseUnits,
  feeAssetMint: Address.nullable(),
  feeAssetSymbol: z.string().nullable(),
})
export type QuoteFees = z.output<typeof QuoteFees>

export const ChainPreview = z.object({
  visible: z.object({
    hookId: z.string(),
    targetProgram: Address,
    assetIn: z.string().nullable(),
    amountIn: BaseUnits,
    assetOut: z.string().nullable(),
    minimumOut: BaseUnits,
    relayer: Address,
  }),
  hidden: z.array(z.string()),
})
export type ChainPreview = z.output<typeof ChainPreview>

export const QuoteResponse = z.object({
  quoteId: z.string(),
  hookId: z.string(),
  hookAddress: Address.optional(),
  hookAuthor: Address.optional(),
  feeRecipient: Address.nullable().optional(),
  relayer: Address.optional(),
  mintIn: Address.nullable(),
  assetInSymbol: z.string().nullable(),
  amountIn: BaseUnits,
  mintOut: Address.nullable(),
  assetOutSymbol: z.string().nullable(),
  tokenProgramIn: Address.optional(),
  tokenProgramOut: Address.optional(),
  expectedOut: BaseUnits,
  minimumOut: BaseUnits,
  /** True when the hook has no built-in quote resolver and minimumOut was supplied by the caller. */
  minimumOutFromCaller: z.boolean().optional(),
  slippageBps: z.number().int(),
  fees: QuoteFees,
  netOut: BaseUnits,
  /** Worst-case net output after run and relayer fees if the trade fills at minimumOut. */
  minimumNetOut: BaseUnits.optional(),
  resolvedAccounts: z.array(ResolvedAccount),
  resolvedDataBase64: Base64,
  /** Canonical on-chain call_hash (32-byte hex, byte 0 cleared) bound by the ZK proof. */
  callHashHex: Hex.optional(),
  /** Caller data stream passed into RunArgs.caller_data. */
  callerDataBase64: Base64.optional(),
  /** Caller accounts slice (Fixed / Caller / CallerRemaining) passed into pook::run. */
  callerAccounts: z
    .array(
      z.object({
        pubkey: Address,
        isWritable: z.boolean(),
        isSigner: z.boolean(),
      }),
    )
    .optional(),
  /** Writable flags (0|1) for CallerRemaining accounts. */
  callerRemainingWritable: z.array(z.number().int()).optional(),
  /** Optional ATA create setup instructions prepended by the relayer before pook::run. */
  setupInstructions: z.array(ResolvedInstruction).optional(),
  companionInstructions: z.array(ResolvedInstruction),
  chainPreview: ChainPreview,
  routeSummary: z.string().nullable(),
  expiresAt: Timestamp,
})
export type QuoteResponse = z.output<typeof QuoteResponse>

// --- Notes & Seats Sync (browser decrypts locally; API never sees holder keys) ---

export const NotesQuery = PageQuery.extend({
  ownerTag: Address.optional(),
  afterSlot: U64.optional(),
})
export type NotesQuery = z.output<typeof NotesQuery>

export const EncryptedNoteRecord = z.object({
  commitment: z.string(),
  treeId: z.number().int(),
  leafIndex: z.number().int(),
  slot: U64,
  signature: Signature,
  ownerTag: Address,
  ciphertextBase64: Base64,
  txViewingPkBase64: Base64,
  saltBase64: Base64,
  timestamp: Timestamp,
})
export type EncryptedNoteRecord = z.output<typeof EncryptedNoteRecord>

export const EncryptedNotesPage = page(EncryptedNoteRecord)
export type EncryptedNotesPage = z.output<typeof EncryptedNotesPage>

export const NullifiersCheckRequest = z.strictObject({
  nullifiers: z.array(z.string().min(1).max(128)).min(1).max(200),
})
export type NullifiersCheckRequest = z.input<typeof NullifiersCheckRequest>

export const NullifiersCheckResponse = z.object({
  spent: z.record(z.string(), z.boolean()),
  asOf: Timestamp,
})
export type NullifiersCheckResponse = z.output<typeof NullifiersCheckResponse>

export const SeatsStateRequest = z.strictObject({
  seatAddresses: z.array(Address).max(50),
})
export type SeatsStateRequest = z.input<typeof SeatsStateRequest>

export const SeatAssetPosition = z.object({
  mint: Address,
  symbol: z.string(),
  decimals: z.number().int(),
  amount: BaseUnits,
  usdValue: z.string().nullable(),
})
export type SeatAssetPosition = z.output<typeof SeatAssetPosition>

export const SeatPosition = z.object({
  seatAddress: Address,
  commitmentHex: Hex.optional(),
  openerRelayer: Address.nullable().optional(),
  protocol: z.string(),
  protocolName: z.string(),
  obligationAddress: Address.nullable(),
  status: SeatStatus,
  collateral: z.array(SeatAssetPosition),
  debt: z.array(SeatAssetPosition),
  depositedValueUsd: z.string().nullable().optional(),
  borrowFactorAdjustedDebtUsd: z.string().nullable().optional(),
  unhealthyBorrowValueUsd: z.string().nullable().optional(),
  healthFactor: z.string().nullable(),
  actions: z.array(z.string()),
  updatedAt: Timestamp,
})
export type SeatPosition = z.output<typeof SeatPosition>

export const SeatsStateResponse = z.object({
  seats: z.array(SeatPosition),
  asOf: Timestamp,
})
export type SeatsStateResponse = z.output<typeof SeatsStateResponse>

// --- Public Wallet Balance (beside Enter) ---

export const PublicBalanceQuery = z.strictObject({
  mint: Address.optional(),
})
export type PublicBalanceQuery = z.input<typeof PublicBalanceQuery>

export const PublicBalanceResponse = z.object({
  wallet: Address,
  mint: Address,
  symbol: z.string().nullable(),
  decimals: z.number().int(),
  amount: BaseUnits,
  asOf: Timestamp,
})
export type PublicBalanceResponse = z.output<typeof PublicBalanceResponse>

// --- Enter & Wallet-Signed Transactions ---

export const EnterBuildRequest = z.strictObject({
  source: z.enum(['wallet', 'rings']),
  wallet: Address,
  mint: Address,
  amount: PositiveU64,
  outputOwnerHash: z.string().min(16).max(128),
  outputViewingPkBase64: Base64.optional(),
  /** When source is 'rings': client-built SPP transact bytes & accounts to forward through pook::enter mode 1. */
  transactDataBase64: Base64.optional(),
  transactAccounts: z
    .array(
      z.strictObject({
        pubkey: Address,
        isWritable: z.boolean(),
        isSigner: z.boolean(),
      }),
    )
    .max(64)
    .optional(),
})
export type EnterBuildRequest = z.input<typeof EnterBuildRequest>

export const TxBuildResponse = z.object({
  buildId: z.string(),
  action: TxAction,
  transactionBase64: Base64,
  blockhash: z.string(),
  lastValidBlockHeight: U64,
  networkFeeLamports: BaseUnits,
  expiresAt: Timestamp,
})
export type TxBuildResponse = z.output<typeof TxBuildResponse>

export const TxSubmitRequest = z
  .strictObject({
    buildId: z.string().min(1).max(128),
    signedTransactionBase64: Base64.optional(),
    signature: Signature.optional(),
  })
  .refine((v) => Boolean(v.signedTransactionBase64 || v.signature), 'Provide signedTransactionBase64 or signature.')
export type TxSubmitRequest = z.input<typeof TxSubmitRequest>

export const TxStatusResponse = z.object({
  id: z.string(),
  action: TxAction.optional(),
  status: TxStatus,
  signature: Signature.nullable(),
  slot: U64.nullable(),
  error: errors.ErrorDetail.optional(),
  updatedAt: Timestamp,
})
export type TxStatusResponse = z.output<typeof TxStatusResponse>

// --- Prover & Relayer (Run, Leave, Seats) ---

export const ProveRequest = z.strictObject({
  circuit: z.enum(['enter', 'run', 'leave', 'seat_open', 'seat_fund', 'seat_action', 'seat_close', 'spp_transact']),
  inputsJson: z.string().min(2).max(262_144),
  hookId: HookId.optional(),
})
export type ProveRequest = z.input<typeof ProveRequest>

export const ProveResponse = z.object({
  proofId: z.string(),
  circuit: openEnum(['enter', 'run', 'leave', 'seat_open', 'seat_fund', 'seat_action', 'seat_close', 'spp_transact'] as const),
  proofBase64: Base64,
  publicInputsHex: z.array(Hex),
  privateTxHashHex: Hex,
  provingMs: z.number().int(),
  expiresAt: Timestamp,
})
export type ProveResponse = z.output<typeof ProveResponse>

export const ProverCircuitArtifact = z.object({
  circuit: z.string(),
  xbcSha256: Hex.nullable(),
  pkSha256: Hex.nullable(),
  vkSha256: Hex.nullable(),
  available: z.boolean(),
})
export type ProverCircuitArtifact = z.output<typeof ProverCircuitArtifact>

export const ProverCircuitsResponse = z.object({
  status: ReadinessStatus,
  circuits: z.array(ProverCircuitArtifact),
  asOf: Timestamp,
})
export type ProverCircuitsResponse = z.output<typeof ProverCircuitsResponse>

export const RelayerQuoteQuery = z.strictObject({
  kind: z.enum(['run', 'leave', 'open_seat', 'close_seat']),
  mint: Address,
  hookId: HookId.optional(),
})
export type RelayerQuoteQuery = z.input<typeof RelayerQuoteQuery>

export const RelayerQuoteResponse = z.object({
  relayer: Address,
  mint: Address,
  feeAmount: BaseUnits,
  expiresAt: Timestamp,
})
export type RelayerQuoteResponse = z.output<typeof RelayerQuoteResponse>

export const StrictAccountMeta = z.strictObject({
  pubkey: Address,
  isWritable: z.boolean(),
  isSigner: z.boolean(),
})

export const RelayRunRequest = z.strictObject({
  hookId: HookId,
  quoteId: z.string().max(128).optional(),
  appProofBase64: Base64,
  sppProofBase64: Base64,
  transactDataBase64: Base64,
  resolvedAccounts: z.array(Address).max(64),
  resolvedDataBase64: Base64,
  companionInstructions: z.array(StrictResolvedInstruction).max(8).optional(),
  setupInstructions: z.array(StrictResolvedInstruction).max(8).optional(),
  /** Full pook::run instruction payload + ordered accounts required by the relayer. */
  instructionDataBase64: Base64,
  accounts: z.array(StrictAccountMeta).min(1).max(64),
  computeUnitLimit: z.number().int().min(100_000).max(1_400_000).optional(),
  mintIn: Address.optional(),
  mintOut: Address.optional(),
  amountIn: BaseUnits,
  minimumOut: BaseUnits,
  relayerFee: BaseUnits,
  expiryUnixTs: U64,
  seatAddress: Address.optional(),
})
export type RelayRunRequest = z.input<typeof RelayRunRequest>

export const RelayLeaveRequest = z.strictObject({
  destinationType: z.enum(['wallet', 'rings']),
  destination: z.string().min(16).max(160),
  mint: Address,
  amount: PositiveU64,
  appProofBase64: Base64,
  sppProofBase64: Base64,
  transactDataBase64: Base64,
  setupInstructions: z.array(StrictResolvedInstruction).max(8).optional(),
  /** Full pook::leave instruction payload + ordered accounts required by the relayer. */
  instructionDataBase64: Base64,
  accounts: z.array(StrictAccountMeta).min(1).max(64),
  computeUnitLimit: z.number().int().min(100_000).max(1_400_000).optional(),
  relayerFee: BaseUnits,
  expiryUnixTs: U64,
})
export type RelayLeaveRequest = z.input<typeof RelayLeaveRequest>

export const RelaySeatRequest = z.strictObject({
  seatCommitmentHex: Hex,
  seatAddress: Address.optional(),
  instructionDataBase64: Base64,
  accounts: z.array(StrictAccountMeta).max(64),
  computeUnitLimit: z.number().int().min(100_000).max(1_400_000).optional(),
  expiryUnixTs: U64,
})
export type RelaySeatRequest = z.input<typeof RelaySeatRequest>

export const RelaySubmissionResponse = z.object({
  relayId: z.string(),
  kind: openEnum(['run', 'leave', 'open_seat', 'close_seat'] as const),
  status: RelayStatus,
  signature: Signature.nullable(),
  slot: U64.nullable(),
  hookId: z.string().nullable().optional(),
  seatAddress: Address.nullable().optional(),
  relayerFee: BaseUnits,
  run: PublicRun.nullable().optional(),
  error: errors.ErrorDetail.optional(),
  expiresAt: Timestamp,
  updatedAt: Timestamp,
})
export type RelaySubmissionResponse = z.output<typeof RelaySubmissionResponse>

// --- Publish Hook (IDL parse, simulate, build) ---

export const ParseIdlRequest = z
  .strictObject({
    programId: Address.optional(),
    idlJson: z.string().min(2).max(524_288).optional(),
  })
  .refine((v) => Boolean(v.programId || v.idlJson), 'Provide a programId or idlJson.')
export type ParseIdlRequest = z.input<typeof ParseIdlRequest>

export const ParsedIdlArg = z.object({
  name: z.string(),
  type: z.string(),
  offset: z.number().int(),
  length: z.number().int(),
})
export type ParsedIdlArg = z.output<typeof ParsedIdlArg>

export const ParsedIdlAccount = z.object({
  index: z.number().int(),
  name: z.string(),
  writable: z.boolean(),
  signer: z.boolean(),
})
export type ParsedIdlAccount = z.output<typeof ParsedIdlAccount>

export const ParsedIdlInstruction = z.object({
  name: z.string(),
  discriminator: Hex,
  args: z.array(ParsedIdlArg),
  accounts: z.array(ParsedIdlAccount),
})
export type ParsedIdlInstruction = z.output<typeof ParsedIdlInstruction>

export const ParsedIdlResponse = z.object({
  programId: Address.nullable(),
  programName: z.string(),
  version: z.string().nullable(),
  instructions: z.array(ParsedIdlInstruction),
})
export type ParsedIdlResponse = z.output<typeof ParsedIdlResponse>

export const StrictDataSlot = z.strictObject({
  name: z.string().min(1).max(64),
  kind: StrictDataSlotKind,
  offset: z.number().int().min(0).max(256),
  length: z.number().int().min(0).max(256),
  type: StrictDataSlotType,
  label: z.string().max(64).optional(),
  description: z.string().max(240).optional(),
})

export const StrictDataTemplate = z.strictObject({
  baseHex: Hex.max(512, 'Data template must be at most 256 bytes.'),
  slots: z.array(StrictDataSlot).max(16),
})

export const StrictAccountSlot = z.strictObject({
  index: z.number().int().min(0).max(47),
  name: z.string().min(1).max(64),
  role: StrictAccountRole,
  address: Address.nullable().optional(),
  writable: z.boolean(),
  signer: z.boolean(),
  description: z.string().max(240).optional(),
})

export const StrictCompanionInstruction = z.strictObject({
  programId: Address,
  instructionName: z.string().min(1).max(64),
  discriminator: Hex.max(16, 'Companion discriminator must be at most 8 bytes.'),
  position: z.enum(['before', 'after']),
  description: z.string().max(240).optional(),
})

export const StrictHookFormField = z.strictObject({
  name: z.string().min(1).max(64),
  kind: StrictFormFieldKind,
  label: z.string().min(1).max(64),
  required: z.boolean(),
  defaultValue: z.string().max(128).optional(),
  placeholder: z.string().max(128).optional(),
})

export const HookDraft = z.strictObject({
  id: HookId,
  protocol: z.string().min(1).max(32),
  protocolName: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  description: z.string().min(1).max(280),
  kind: StrictHookKind,
  targetProgram: Address,
  instructionName: z.string().min(1).max(64),
  discriminator: Hex.max(512),
  dataTemplate: StrictDataTemplate,
  accountsTemplate: z.array(StrictAccountSlot).min(1).max(48),
  companionInstructions: z.array(StrictCompanionInstruction).max(8).optional(),
  // Optional canonical on-chain fields (when present, used verbatim; otherwise derived from dataTemplate/accountsTemplate)
  mintInConstraint: StrictMintConstraint.optional(),
  mintOutConstraint: StrictMintConstraint.optional(),
  wrapSolIn: z.boolean().optional(),
  unwrapSolOut: z.boolean().optional(),
  dataTemplateHex: Hex.max(512, 'Data template must be at most 256 bytes.').optional(),
  dataSlots: z.array(StrictOnChainDataSlot).max(16).optional(),
  accountSlots: z.array(StrictOnChainAccountSlot).max(48).optional(),
  companions: z.array(StrictOnChainCompanion).max(8).optional(),
  formFields: z.array(StrictHookFormField).max(16).optional(),
  mintIn: Address.nullable(),
  mintOut: Address.nullable(),
  assetInSymbol: z.string().max(24).nullable().optional(),
  assetOutSymbol: z.string().max(24).nullable().optional(),
})
export type HookDraft = z.input<typeof HookDraft>
export type HookDraftOutput = z.output<typeof HookDraft>

/** Convert any HookDraft (display-style or canonical on-chain) into exact `PublishHookArgs`. */
export function hookDraftToOnChain(draft: HookDraftOutput): WirePublishHookArgs {
  const mintConstraintFromAddress = (addr: string | null, explicit?: z.output<typeof StrictMintConstraint>): WirePublishHookArgs['mintIn'] => {
    if (explicit) return explicit
    if (addr === null) return { kind: 'Any' }
    if (isNativeSolMint(addr)) return { kind: 'Sol' }
    return { kind: 'Spl', mint: addr }
  }

  const dataSlots: WirePublishHookArgs['dataSlots'] =
    draft.dataSlots ??
    draft.dataTemplate.slots.map((s) => ({
      offset: s.offset,
      len: s.length,
      kind:
        s.kind === 'amount_in'
          ? 'AmountInU64Le'
          : s.kind === 'min_out'
            ? 'MinOutU64Le'
            : s.type === 'bytes' && s.length === 0
              ? 'CallerTail'
              : 'CallerSlice',
    }))

  const accountSlots: WirePublishHookArgs['accountSlots'] =
    draft.accountSlots ??
    draft.accountsTemplate.map((a) => ({
      kind:
        a.role === 'stage_authority'
          ? 'StagePda'
          : a.role === 'stage_in'
            ? 'StageIn'
            : a.role === 'stage_out'
              ? 'StageOut'
              : a.role === 'seat_pda'
                ? 'SeatPda'
                : a.role === 'payer'
                  ? 'Payer'
                  : a.role === 'fixed' || a.role === 'program' || a.role === 'sysvar'
                    ? 'Fixed'
                    : 'Caller',
      isWritable: a.writable,
      isSigner: a.signer,
      pubkey: a.address ?? SYSTEM_PROGRAM_ID,
    }))

  const companions: WirePublishHookArgs['companions'] =
    draft.companions ??
    (draft.companionInstructions ?? []).map((c) => ({
      programId: c.programId,
      discriminatorHex: c.discriminator,
      discLen: Math.min(8, Math.floor(c.discriminator.length / 2)),
      mustPrecede: c.position === 'before',
    }))

  return {
    hookId: draft.id,
    targetProgram: draft.targetProgram,
    kind: draft.kind,
    mintIn: mintConstraintFromAddress(draft.mintIn, draft.mintInConstraint),
    mintOut: mintConstraintFromAddress(draft.mintOut, draft.mintOutConstraint),
    wrapSolIn: draft.wrapSolIn ?? false,
    unwrapSolOut: draft.unwrapSolOut ?? false,
    dataTemplateHex: draft.dataTemplateHex ?? draft.dataTemplate.baseHex,
    dataSlots,
    accountSlots,
    companions,
  }
}

export function displayMintFromConstraint(c: { kind: string; mint?: string }): string | null {
  if (c.kind === 'Spl' && c.mint) return c.mint
  if (c.kind === 'Sol') return WSOL_MINT
  return null
}

export const SimulateHookRequest = z.strictObject({
  hook: HookDraft,
  sampleAmountIn: PositiveU64,
  sampleMintIn: Address.optional(),
  sampleMintOut: Address.optional(),
  sampleArgs: z.record(z.string(), z.string()).optional(),
})
export type SimulateHookRequest = z.input<typeof SimulateHookRequest>

export const SimulateHookResponse = z.object({
  passed: z.boolean(),
  computeUnits: z.number().int().nullable(),
  logs: z.array(z.string()),
  estimatedTxBytes: z.number().int().nullable(),
  accountCount: z.number().int(),
  error: errors.ErrorDetail.optional(),
})
export type SimulateHookResponse = z.output<typeof SimulateHookResponse>

export const PublishHookBuildRequest = z.strictObject({
  author: Address,
  hook: HookDraft,
})
export type PublishHookBuildRequest = z.input<typeof PublishHookBuildRequest>

// --- Author Fees & Claim ---

export const AuthorHookFee = z.object({
  hookId: z.string(),
  hookAddress: Address,
  mint: Address,
  assetSymbol: z.string().nullable(),
  decimals: z.number().int(),
  claimableAmount: BaseUnits,
  totalEarnedAmount: BaseUnits,
  lastClaimedAt: Timestamp.nullable(),
})
export type AuthorHookFee = z.output<typeof AuthorHookFee>

export const AuthorFeesResponse = z.object({
  author: Address,
  hooks: z.array(AuthorHookFee),
  asOf: Timestamp,
})
export type AuthorFeesResponse = z.output<typeof AuthorFeesResponse>

export const ClaimAuthorFeesBuildRequest = z.strictObject({
  hookIds: z.array(HookId).min(1).max(16),
  mint: Address.optional(),
})
export type ClaimAuthorFeesBuildRequest = z.input<typeof ClaimAuthorFeesBuildRequest>
