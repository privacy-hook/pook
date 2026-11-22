import {
  ApiClientError,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_TREE_ID,
  INSTRUCTIONS_SYSVAR_ID,
  POOK_TAGS,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE_ADDRESS,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  WSOL_MINT,
  bytesToDecimalField,
  createClient,
  encodeCloseSeatIxData,
  encodeLeaveIxData,
  encodeOpenSeatIxData,
  encodeRunIxData,
  fromBase58,
  fromBase64,
  fromHex,
  isNativeSolMint,
  sha256Be,
  toBase64,
  toHex,
  toProgramMintBytes,
  type AuthorFeesResponse,
  type CallOptions,
  type ClientOptions,
  type ConfigResponse,
  type HealthResponse,
  type HookDetailResponse,
  type HookDraft,
  type HooksPage,
  type HooksQuery,
  type ParseIdlRequest,
  type ParsedIdlResponse,
  type PookApiClient,
  type PublicBalanceResponse,
  type QuoteRequest,
  type QuoteResponse,
  type RelaySubmissionResponse,
  type RunsPage,
  type RunsQuery,
  type SeatPosition,
  type SimulateHookResponse,
  type StatsResponse,
  type TxBuildResponse,
  type TxStatusResponse,
} from '@pook/contract'
import { defineHook, type DefineHookInput, type HookDefinition } from './define-hook.js'
import {
  AssetRegistry,
  LocalKeys,
  ProofInputUtxo,
  Wallet,
  authorityIdentityFieldDec,
  buildKaminoOpenSeatSetup,
  buildRingsEnterTransact,
  clearScanState,
  createSprClient,
  defaultKeyDerivation,
  defaultNoteScanner,
  defaultProver,
  defaultProverTeeForCluster,
  deriveAtaAddress,
  deriveAuthorFeesPda,
  deriveAuthorityPda,
  deriveConfigPda,
  deriveOneTimePdaKeys,
  deriveProgramOwnerZeroAddress,
  deriveRingsWalletKeys,
  deriveSeatCommitmentBytes,
  deriveSeatPda,
  deriveSppSplInterfaceWithBump,
  deriveSeatSecretBytes,
  deriveSeatStatePda,
  deriveStagePda,
  hashBytes,
  initializePoseidon,
  kitAddress,
  proveProgramAndSpp,
  resolveRingsRecipientAddress,
  toProgramWalletUtxo,
  type CircuitArtifactCache,
  type DecryptedNote,
  type HolderKeys,
  type KeyDerivationSeam,
  type NoteScannerSeam,
  type ProverSeam,
  type ProverTee,
  type WalletSigner,
} from './seams.js'
import type { PookWasmModule } from './wasm-types.js'

export type PookConfig = ClientOptions & {
  apiUrl: string
  /** Optional direct relayer service URL (defaults to apiUrl's /v1/relayer/* proxy). */
  relayerUrl?: string
  /** Optional direct prover service URL (defaults to apiUrl's /v1/prover/* proxy). */
  proverUrl?: string
  /** Optional TEE attestation policy override for the Rings prover (defaults to Helius's signed mainnet/devnet policy when cluster is mainnet/devnet, plain on localnet). */
  proverTee?: ProverTee
  /** Optional direct Photon indexer URL (defaults to apiUrl's /v1/photon proxy). */
  photonUrl?: string
  /** Optional direct Solana RPC URL (only needed in Node scripts when resolving unknown asset IDs). */
  rpcUrl?: string
  /** Compiled Pook Xark WASM module (`wasm/web` in browser, `wasm/node` in Node). */
  wasm?: PookWasmModule
  signer?: WalletSigner
  keys?: HolderKeys
  keyDerivation?: KeyDerivationSeam
  noteScanner?: NoteScannerSeam
  prover?: ProverSeam
}

export type RunStage = 'quoting' | 'opening_seat' | 'proving' | 'relayed' | 'confirmed'

export type RunParams = {
  /** Input asset mint (also accepted as `mintIn`). */
  in?: string
  mintIn?: string
  /** Output asset mint (also accepted as `mintOut`). */
  out?: string
  mintOut?: string
  /** Amount in base units (decimal string or bigint). */
  amount: string | bigint
  /** Caller-supplied minimum output in base units; required for custom hooks without a built-in resolver when the hook produces an output asset. */
  minimumOut?: string | bigint
  slippageBps?: number
  seat?: string
  args?: Record<string, string>
  onStage?: (stage: RunStage, detail?: unknown) => void
  signal?: AbortSignal
}

export type RunTimings = {
  quoteMs: number
  scanMs: number
  witnessMs: number
  artifactLoadMs: number
  appProofMs: number
  sppProofMs: number
  relayMs: number
  confirmMs: number
  totalMs: number
}

export type RunResult = {
  quote: QuoteResponse
  relay: RelaySubmissionResponse
  signature: string | null
  /** Seat address used for the run (populated when running a seat hook or auto-opening a seat). */
  seat?: string | null
  /** Transaction signature of the auto-opened seat when `run()` opened a seat on the first seat run. */
  openSeatSignature?: string | null
  /** Per-stage wall timings (milliseconds) for chain-mode runs. */
  timings?: RunTimings
}

export type OpenSeatOptions =
  | number
  | {
      seatIndex?: number
      protocol?: 'kamino' | 'none'
      lendingMarket?: string
      signal?: AbortSignal
    }

export type EnterStage = 'building' | 'proving' | 'signing' | 'submitted' | 'confirmed'

export type EnterParams = {
  source?: 'wallet' | 'rings'
  mint: string
  amount: string | bigint
  signer?: WalletSigner
  onStage?: (stage: EnterStage, detail?: unknown) => void
  signal?: AbortSignal
}

export type EnterResult = {
  build: TxBuildResponse
  tx: TxStatusResponse
  signature: string | null
}

export type LeaveStage = 'quoting' | 'proving' | 'relayed' | 'confirmed'

export type LeaveParams = {
  mint: string
  amount: string | bigint
  /** Public Solana wallet address (when destinationType === 'wallet') or registered Rings wallet address / 64-char hex owner hash (when destinationType === 'rings'). */
  destination: string
  destinationType?: 'wallet' | 'rings'
  /** Optional when destinationType === 'rings' and destination is a raw 64-char hex owner hash: recipient 32-byte view tag (base58). */
  destinationViewTag?: string
  onStage?: (stage: LeaveStage, detail?: unknown) => void
  signal?: AbortSignal
}

export type LeaveResult = {
  relay: RelaySubmissionResponse
  signature: string | null
}

export type SeatActionResult = {
  relay: RelaySubmissionResponse
  seatAddress: string | null
  seatCommitmentHex: string
  signature: string | null
}

export type AssetBalance = {
  mint: string
  symbol: string
  decimals: number
  amount: string
  noteCount: number
}

export type BalanceResult = {
  assets: AssetBalance[]
  notes: DecryptedNote[]
  asOf: string
}

export type ActivityItem = {
  id: string
  kind: 'enter' | 'run' | 'leave'
  hookId?: string
  mint: string
  symbol: string
  decimals: number
  amount: string
  signature: string
  slot: string
  timestamp: string
}

export type PublishHookParams = {
  hook: HookDraft | HookDefinition
  signer?: WalletSigner
  onStage?: (stage: EnterStage, detail?: unknown) => void
  signal?: AbortSignal
}

export type SimulateHookParams = {
  hook: HookDraft | HookDefinition
  sampleAmountIn: string | bigint
  sampleMintIn?: string
  sampleMintOut?: string
  sampleArgs?: Record<string, string>
  /** A token account holding the input asset; the simulation moves `sampleAmountIn` from it to the stage first. */
  sampleFundFrom?: string
  signal?: AbortSignal
}

export type ClaimAuthorFeesParams = {
  hookIds: string[]
  mint?: string
  signer?: WalletSigner
  onStage?: (stage: EnterStage, detail?: unknown) => void
  signal?: AbortSignal
}

const toUnits = (amount: string | bigint) => (typeof amount === 'bigint' ? amount.toString() : amount)

function requireSigner(signer?: WalletSigner): WalletSigner {
  if (!signer) {
    throw new ApiClientError(401, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Connect a wallet signer to continue.',
        retryable: false,
        stage: 'wallet',
      },
    })
  }
  return signer
}

function makeDummyProgramUtxo(treeId = DEFAULT_TREE_ID) {
  const dummy = ProofInputUtxo.dummy(undefined, treeId)
  return {
    utxo: {
      owner: dummy.utxo.owner.toBytes(),
      asset: { asset: dummy.utxo.asset, assetId: 1n },
      amount: 0n,
      blinding: dummy.utxo.blinding,
      data: { records: [] },
    },
    nullifierPubkey: dummy.nullifierPublicKey,
    utxoHash: dummy.hash(),
    nullifier: dummy.nullifier(),
    treeId,
    leafIndex: 0n,
  }
}

function buildAssetRegistryFromNotes(notes: readonly DecryptedNote[]): AssetRegistry {
  const registry = new AssetRegistry()
  for (const n of notes) {
    if (!n.assetRegistryEntries) continue
    for (const [assetId, mint] of n.assetRegistryEntries) {
      try {
        registry.register(assetId, kitAddress(mint))
      } catch {
        // Ignore already-registered or conflicting duplicate entries
      }
    }
  }
  return registry
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pollTxUntilSettled(
  client: PookApiClient,
  initial: TxStatusResponse,
  signal?: AbortSignal,
  timeoutMs = 45_000,
): Promise<TxStatusResponse> {
  let current = initial
  const deadline = Date.now() + timeoutMs
  while ((current.status === 'built' || current.status === 'submitted' || current.status === 'unconfirmed') && Date.now() < deadline) {
    await pause(400)
    current = await client.txStatus(current.id, { signal })
  }
  return current
}

async function pollRelayUntilSettled(
  client: PookApiClient,
  initial: RelaySubmissionResponse,
  signal?: AbortSignal,
  timeoutMs = 60_000,
): Promise<RelaySubmissionResponse> {
  let current = initial
  const deadline = Date.now() + timeoutMs
  while ((current.status === 'accepted' || current.status === 'submitted') && Date.now() < deadline) {
    await pause(500)
    current = await client.relayStatus(current.relayId, { signal })
  }
  return current
}

async function signAndSubmitBuild(
  client: PookApiClient,
  build: TxBuildResponse,
  signer: WalletSigner,
  onStage?: (stage: EnterStage, detail?: unknown) => void,
  signal?: AbortSignal,
  deferConfirmed = false,
): Promise<TxStatusResponse> {
  onStage?.('signing', build)
  let signed: { signedTransactionBase64?: string; signature?: string }
  if (signer.signTransaction) {
    try {
      signed = await signer.signTransaction(build.transactionBase64)
    } catch (error) {
      throw new ApiClientError(400, {
        error: {
          code: 'WALLET_REJECTED',
          message: error instanceof Error ? error.message : 'Wallet rejected the transaction.',
          retryable: false,
          stage: 'wallet_rejected',
        },
      })
    }
  } else {
    signed = { signedTransactionBase64: build.transactionBase64 }
  }
  onStage?.('submitted', signed)
  const submitted = await client.submitTx(
    {
      buildId: build.buildId,
      signedTransactionBase64: signed.signedTransactionBase64,
      signature: signed.signature,
    },
    { signal },
  )
  const polled = await pollTxUntilSettled(client, submitted, signal)
  const settled: TxStatusResponse = {
    ...polled,
    signature: polled.signature ?? submitted.signature ?? signed.signature ?? null,
  }
  if (!deferConfirmed && (settled.status === 'confirmed' || settled.status === 'finalized')) {
    onStage?.('confirmed', settled)
  }
  return settled
}

export function createPook(config: PookConfig) {
  const {
    apiUrl,
    relayerUrl,
    proverUrl,
    proverTee,
    photonUrl,
    rpcUrl = `${config.apiUrl.replace(/\/+$/, '')}/v1/rpc`,
    wasm,
    signer: initialSigner,
    keys: initialKeys,
    keyDerivation = defaultKeyDerivation,
    noteScanner = defaultNoteScanner,
    prover = defaultProver,
    ...httpOptions
  } = config
  const fetcher = httpOptions.fetch ?? globalThis.fetch.bind(globalThis)
  const client = createClient(apiUrl, httpOptions)
  const relayerClient = relayerUrl ? createClient(relayerUrl, httpOptions) : client
  let currentSigner = initialSigner
  let holderKeys = initialKeys ?? null
  let ringsWalletKeys: { wallet: string; keys: LocalKeys } | null = null
  let cachedConfig: ConfigResponse | null = null
  let cachedSprPromise: Promise<Awaited<ReturnType<typeof createSprClient>>> | null = null
  let sessionNotes: DecryptedNote[] | null = null
  let nextNoteIndex = 0
  let nextSeatIndex = 0
  const artifactCache: CircuitArtifactCache = new Map()
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  function clearRingsWalletKeys() {
    if (!ringsWalletKeys) return
    try {
      ringsWalletKeys.keys.destroy()
    } catch {
      // ignore already destroyed
    }
    ringsWalletKeys = null
  }

  function getSprClient(cluster?: string | null) {
    if (!cachedSprPromise) {
      const resolvedTee = proverTee ?? defaultProverTeeForCluster(cluster ?? cachedConfig?.cluster)
      cachedSprPromise = createSprClient({
        indexerUrl: photonUrl ?? client.photonUrl(),
        proverUrl: proverUrl ? `${proverUrl.replace(/\/+$/, '')}/v1/prover/spp` : client.proverSppUrl(),
        ...(resolvedTee ? { proverTee: resolvedTee } : {}),
        solanaRpcUrl: rpcUrl ?? client.rpcUrl(),
      })
    }
    return cachedSprPromise
  }

  async function loadConfig(signal?: AbortSignal): Promise<ConfigResponse> {
    if (cachedConfig && cachedConfig.status !== 'waiting') return cachedConfig
    cachedConfig = await client.config({ signal })
    return cachedConfig
  }

  async function ensureKeys(signer?: WalletSigner, signal?: AbortSignal): Promise<HolderKeys> {
    if (holderKeys) return holderKeys
    const activeSigner = requireSigner(signer ?? currentSigner)
    const netCfg = await loadConfig(signal)
    holderKeys = await keyDerivation.derive(activeSigner, netCfg.authorityPda ?? undefined)
    return holderKeys
  }

  async function scanNotes(options?: { signer?: WalletSigner; signal?: AbortSignal; force?: boolean }): Promise<DecryptedNote[]> {
    const keys = await ensureKeys(options?.signer, options?.signal)
    const netCfg = await loadConfig(options?.signal)
    const spr = netCfg.status === 'fixture' ? undefined : await getSprClient(netCfg.cluster)
    const notes = await noteScanner.scan(client, keys, {
      config: netCfg,
      wasm,
      spr,
      photonUrl,
      proverUrl,
      proverTee,
      rpcUrl,
      signal: options?.signal,
    })
    sessionNotes = notes
    let maxIdx = -1
    let maxSeat = -1
    for (const n of notes) {
      if (n.keyIndex !== undefined && n.keyIndex > maxIdx) maxIdx = n.keyIndex
      if (n.seatIndex !== undefined && n.seatIndex > maxSeat) maxSeat = n.seatIndex
    }
    if (maxIdx + 1 > nextNoteIndex) nextNoteIndex = maxIdx + 1
    if (maxSeat + 1 > nextSeatIndex) nextSeatIndex = maxSeat + 1
    return notes
  }

  async function waitForPhotonIndexed(netCfg: ConfigResponse, signature: string | null | undefined, signal?: AbortSignal) {
    if (!signature || netCfg.status === 'fixture') return
    try {
      const spr = await getSprClient()
      await Promise.race([
        spr.confirmPrivateTransaction(signature as Parameters<typeof spr.confirmPrivateTransaction>[0], undefined, signal ? { signal } : undefined),
        pause(12_000),
      ])
    } catch {
      await pause(800)
    }
  }

  function allocNoteIndex(): number {
    return nextNoteIndex++
  }

  function pickInputNotes(notes: readonly DecryptedNote[], mint: string, amountNeeded: bigint): DecryptedNote[] {
    const targetIsSol = isNativeSolMint(mint)
    const spendable = notes
      .filter((n) => !n.spent && n.kind === 'balance' && (targetIsSol ? isNativeSolMint(n.mint) : n.mint === mint))
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
    if (!spendable.length) {
      throw new ApiClientError(422, {
        error: { code: 'INSUFFICIENT_BALANCE', message: 'No spendable private notes for this asset.', retryable: false, stage: 'validation' },
      })
    }
    const single = spendable.find((n) => BigInt(n.amount) >= amountNeeded)
    if (single) return [single]
    if (spendable.length >= 2 && BigInt(spendable[0]!.amount) + BigInt(spendable[1]!.amount) >= amountNeeded) {
      return [spendable[0]!, spendable[1]!]
    }
    throw new ApiClientError(422, {
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient private balance across up to two notes.', retryable: false, stage: 'validation' },
    })
  }

  const pook = {
    client,

    setSigner(signer: WalletSigner | undefined) {
      currentSigner = signer
      if (!signer || (holderKeys && holderKeys.wallet !== signer.publicKey)) {
        clearScanState(holderKeys)
        clearRingsWalletKeys()
        holderKeys = null
        sessionNotes = null
      }
    },

    async unlock(signer?: WalletSigner): Promise<HolderKeys> {
      const activeSigner = requireSigner(signer ?? currentSigner)
      currentSigner = activeSigner
      const netCfg = await loadConfig()
      clearScanState(holderKeys)
      clearRingsWalletKeys()
      holderKeys = await keyDerivation.derive(activeSigner, netCfg.authorityPda ?? undefined)
      sessionNotes = null
      return holderKeys
    },

    lock() {
      clearScanState(holderKeys)
      clearRingsWalletKeys()
      holderKeys = null
      sessionNotes = null
    },

    isUnlocked(): boolean {
      return holderKeys !== null
    },

    // Public registry, runs, config, health
    health: (call?: CallOptions): Promise<HealthResponse> => client.health(call),
    config: (call?: CallOptions): Promise<ConfigResponse> => client.config(call),
    stats: (call?: CallOptions): Promise<StatsResponse> => client.stats(call),
    hooks: (query?: Partial<HooksQuery>, call?: CallOptions): Promise<HooksPage> => client.hooks(query, call),
    hook: (id: string, call?: CallOptions): Promise<HookDetailResponse> => client.hook(id, call),
    quote: (hookId: string, body: QuoteRequest, call?: CallOptions): Promise<QuoteResponse> => client.quote(hookId, body, call),
    runs: (query?: Partial<RunsQuery>, call?: CallOptions): Promise<RunsPage> => client.runs(query, call),
    runsStreamUrl: (query?: { hookId?: string; fixture?: string; session?: string }) => client.runsStreamUrl(query),
    parseIdl: (body: ParseIdlRequest, call?: CallOptions): Promise<ParsedIdlResponse> => client.parseIdl(body, call),
    authorFees: (wallet: string, call?: CallOptions): Promise<AuthorFeesResponse> => client.authorFees(wallet, call),

    /** Read the connected wallet's public SOL or SPL balance (shown beside Enter). */
    async publicBalance(mint?: string, options?: { wallet?: string; signer?: WalletSigner; signal?: AbortSignal }): Promise<PublicBalanceResponse> {
      const walletAddr = options?.wallet ?? options?.signer?.publicKey ?? currentSigner?.publicKey
      if (!walletAddr) {
        throw new ApiClientError(401, {
          error: { code: 'UNAUTHORIZED', message: 'Connect a wallet to read public balance.', retryable: false, stage: 'wallet' },
        })
      }
      return client.publicBalance(walletAddr, mint ? { mint } : {}, { signal: options?.signal })
    },

    defineHook,

    /**
     * Run any published hook against the holder's private balance in one call:
     * quote -> (auto-open seat if first seat run) -> prove (Xark WASM + Rings SPP in chain mode) -> relay -> follow.
     */
    async run(hookId: string, params: RunParams): Promise<RunResult> {
      const tRun0 = nowMs()
      const mintIn = params.in ?? params.mintIn
      const mintOut = params.out ?? params.mintOut
      const amountIn = toUnits(params.amount)
      const netCfg = await loadConfig(params.signal)
      const hookDetail = (await client.hook(hookId, { signal: params.signal })).hook

      let activeSeat = params.seat
      let openSeatSignature: string | null = null
      // One-press first seat run: when running a seat hook with no seat supplied, open the seat
      // (with Kamino setup CPIs when protocol is kamino) inside this call, reporting `opening_seat`.
      if (hookDetail.kind === 'seat' && !activeSeat) {
        params.onStage?.('opening_seat')
        const opened = await this.openSeat({
          protocol: hookDetail.protocol === 'kamino' ? 'kamino' : 'none',
          signal: params.signal,
        })
        if (opened.relay.status === 'failed' || opened.relay.status === 'expired') {
          throw new ApiClientError(422, {
            error: opened.relay.error ?? {
              code: 'RELAY_REFUSED',
              message: 'Failed to open seat before running seat hook.',
              retryable: true,
              stage: 'relay',
            },
          })
        }
        activeSeat = opened.seatAddress ?? undefined
        openSeatSignature = opened.signature ?? null
        sessionNotes = null
      }

      params.onStage?.('quoting')
      const tQuote0 = nowMs()
      const quote = await client.quote(
        hookId,
        {
          mintIn,
          mintOut,
          amountIn,
          ...(params.minimumOut !== undefined ? { minimumOut: toUnits(params.minimumOut) } : {}),
          slippageBps: params.slippageBps ?? 50,
          seatAddress: activeSeat,
          args: params.args,
        },
        { signal: params.signal },
      )
      const quoteMs = Math.round(nowMs() - tQuote0)

      params.onStage?.('proving', quote)
      const expiryUnixTs = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000))

      // Fixture mode path (round 1 contract compatibility)
      if (netCfg.status === 'fixture' || !wasm || !netCfg.programId) {
        const [appProof, sppProof] = await Promise.all([
          prover.prove(
            client,
            {
              circuit: 'run',
              hookId,
              inputsJson: JSON.stringify({
                hookId,
                amountIn: quote.amountIn,
                minimumOut: quote.minimumOut,
                relayerFee: quote.fees.relayerFeeAmount,
                expiryUnixTs: expiryUnixTs.toString(),
                ownerHash: holderKeys?.ownerHash ?? 'unlocked_fixture_owner',
              }),
            },
            { signal: params.signal },
          ),
          prover.prove(
            client,
            {
              circuit: 'spp_transact',
              hookId,
              inputsJson: JSON.stringify({ amountIn: quote.amountIn, expiryUnixTs: expiryUnixTs.toString() }),
            },
            { signal: params.signal },
          ),
        ])
        const transactDataBase64 = toBase64(
          new TextEncoder().encode(JSON.stringify({ hookId, privateTxHash: appProof.privateTxHashHex, expiryUnixTs: expiryUnixTs.toString() })),
        )
        const fixtureRelayer = quote.relayer ?? quote.chainPreview.visible.relayer
        const relayAccepted = await relayerClient.relayRun(
          {
            hookId,
            quoteId: quote.quoteId,
            appProofBase64: appProof.proofBase64,
            sppProofBase64: sppProof.proofBase64,
            transactDataBase64,
            resolvedAccounts: quote.resolvedAccounts.map((a) => a.address),
            resolvedDataBase64: quote.resolvedDataBase64,
            companionInstructions: quote.companionInstructions,
            setupInstructions: quote.setupInstructions,
            instructionDataBase64: toBase64(Uint8Array.of(POOK_TAGS.RUN)),
            accounts: [{ pubkey: fixtureRelayer, isWritable: true, isSigner: true }],
            mintIn: quote.mintIn ?? undefined,
            mintOut: quote.mintOut ?? undefined,
            amountIn: quote.amountIn,
            minimumOut: quote.minimumOut,
            relayerFee: quote.fees.relayerFeeAmount,
            expiryUnixTs: expiryUnixTs.toString(),
            seatAddress: activeSeat,
          },
          { signal: params.signal },
        )
        params.onStage?.('relayed', relayAccepted)
        const relay = await pollRelayUntilSettled(relayerClient, relayAccepted, params.signal)
        if (relay.status === 'confirmed' || relay.status === 'finalized') params.onStage?.('confirmed', relay)
        return { quote, relay, signature: relay.signature, seat: activeSeat ?? null, openSeatSignature }
      }

      // Real chain mode: Xark WASM + Rings SPP + exact pook::run binary assembly
      await initializePoseidon()
      const keys = await ensureKeys(undefined, params.signal)
      const tScan0 = nowMs()
      const notes = sessionNotes ?? (await scanNotes({ signal: params.signal }))
      const scanMs = Math.round(nowMs() - tScan0)
      const assetRegistry = buildAssetRegistryFromNotes(notes)
      const programId = netCfg.programId
      const [, authorityBump] = await deriveAuthorityPda(programId)
      const [stagePda, stageBump] = await deriveStagePda(programId)
      const [configPda] = await deriveConfigPda(programId)

      const quoteRelayer = quote.relayer ?? quote.chainPreview.visible.relayer
      let relayerPayer = quoteRelayer
      let relayerFeeAmount = quote.fees.relayerFeeAmount
      if (relayerUrl) {
        const customRelayerQuote = await relayerClient.relayerQuote(
          { kind: 'run', mint: quote.mintOut ?? quote.mintIn ?? WSOL_MINT, hookId },
          { signal: params.signal },
        )
        relayerPayer = customRelayerQuote.relayer
        relayerFeeAmount = quote.mintOut ? customRelayerQuote.feeAmount : '0'
      }
      const setupInstructions =
        relayerPayer !== quoteRelayer && quote.setupInstructions?.length
          ? quote.setupInstructions.map((ix) => ({
              ...ix,
              accounts: ix.accounts.map((a) => (a.pubkey === quoteRelayer ? { ...a, pubkey: relayerPayer } : a)),
            }))
          : quote.setupInstructions
      // A run that spends input names an output owner even with no mint out: the program returns
      // any input the target left unused to it (Kamino rounding, a repay overpayment).
      const hasMintIn = BigInt(quote.amountIn) > 0n
      const hasMintOut = Boolean(quote.mintOut)
      const inIsSol = hasMintIn && isNativeSolMint(quote.mintIn)
      const outIsSol = hasMintOut && isNativeSolMint(quote.mintOut)
      const tokenProgramIn = quote.tokenProgramIn ?? SPL_TOKEN_PROGRAM_ID
      const tokenProgramOut = quote.tokenProgramOut ?? SPL_TOKEN_PROGRAM_ID

      const isSeatHook = hookDetail.kind === 'seat'
      const runKind = !isSeatHook ? 'Flow' : hasMintIn ? 'SeatFund' : 'SeatAction'
      const circuitName = runKind === 'Flow' ? 'run' : runKind === 'SeatFund' ? 'seat_fund' : 'seat_action'

      let seatCommitmentBytes: Uint8Array = new Uint8Array(32)
      let seatPdaForRun = stagePda
      let seatNote: DecryptedNote | undefined
      let seatKeyObj: Awaited<ReturnType<typeof deriveOneTimePdaKeys>> | null = null
      let nextSeatKeys: Awaited<ReturnType<typeof deriveOneTimePdaKeys>> | null = null
      if (isSeatHook) {
        seatNote = notes.find((n) => !n.spent && n.kind === 'seat' && (!activeSeat || n.seatAddress === activeSeat))
        if (!seatNote || !seatNote.walletUtxo || seatNote.seatIndex === undefined || seatNote.keyIndex === undefined) {
          throw new ApiClientError(422, {
            error: { code: 'NOT_FOUND', message: 'No active seat note found. Open a seat first.', retryable: false, stage: 'build' },
          })
        }
        seatCommitmentBytes = deriveSeatCommitmentBytes(keys.seed, seatNote.seatIndex, wasm)
        const [derivedSeatPda] = await deriveSeatPda(programId, seatCommitmentBytes)
        seatPdaForRun = derivedSeatPda
        seatKeyObj = await deriveOneTimePdaKeys(keys, seatNote.keyIndex)
        nextSeatKeys = await deriveOneTimePdaKeys(keys, allocNoteIndex())
      }

      const tokenStageOwner = isSeatHook ? seatPdaForRun : stagePda
      const stageInForSpp = !hasMintIn || inIsSol ? stagePda : await deriveAtaAddress(tokenStageOwner, quote.mintIn!, tokenProgramIn)
      const stageInForHook = inIsSol && hookDetail.wrapSolIn ? await deriveAtaAddress(tokenStageOwner, WSOL_MINT, tokenProgramIn) : stageInForSpp
      const stageOutForHook = !hasMintOut
        ? stagePda
        : outIsSol && hookDetail.unwrapSolOut
          ? await deriveAtaAddress(tokenStageOwner, WSOL_MINT, tokenProgramOut)
          : outIsSol
            ? stagePda
            : await deriveAtaAddress(tokenStageOwner, quote.mintOut!, tokenProgramOut)

      const changeIdx = allocNoteIndex()
      const outputIdx = allocNoteIndex()
      const changeKeys = await deriveOneTimePdaKeys(keys, changeIdx)
      const outputKeys = await deriveOneTimePdaKeys(keys, outputIdx)

      const spr = await getSprClient()

      const picked = hasMintIn ? pickInputNotes(notes, quote.mintIn!, BigInt(quote.amountIn)) : []
      const input0 = picked[0]
      const input1 = picked[1]
      const input0Idx = input0?.keyIndex ?? 0
      const input1Idx = input1?.keyIndex
      const input0Keys = await deriveOneTimePdaKeys(keys, input0Idx)
      const input1Keys = input1Idx !== undefined ? await deriveOneTimePdaKeys(keys, input1Idx) : null

      const hookAddr = quote.hookAddress ?? hookDetail.address
      const hookHashDec = bytesToDecimalField(hashBytes(fromBase58(hookAddr)))
      const callHashDec = bytesToDecimalField(fromHex(quote.callHashHex ?? '00'.repeat(32)))
      const authorityIdentity = authorityIdentityFieldDec(keys.authorityPda)

      const [splIfIn] = hasMintIn && !inIsSol ? await deriveSppSplInterfaceWithBump(netCfg.ringsProgramId, quote.mintIn!) : [null, 0]
      const [splIfOut, outSplInterfaceBump] = hasMintOut && !outIsSol ? await deriveSppSplInterfaceWithBump(netCfg.ringsProgramId, quote.mintOut!) : [null, 0]

      const toProgUtxo = (n: DecryptedNote, k: Awaited<ReturnType<typeof deriveOneTimePdaKeys>>) =>
        toProgramWalletUtxo(n.walletUtxo!, {
          nullifierPublicKey: k.nullifierPublicKey,
          treeId: DEFAULT_TREE_ID,
          assets: assetRegistry,
        })

      const authIndices = [
        ...(input0 ? [input0Idx] : []),
        ...(input1Idx !== undefined ? [input1Idx] : []),
        ...(seatNote?.keyIndex !== undefined ? [seatNote.keyIndex] : []),
      ]
      const senderIndex = authIndices[0] ?? 0
      const senderKeysForWasm = await deriveOneTimePdaKeys(keys, senderIndex)

      const proven = await proveProgramAndSpp({
        client,
        wasm,
        circuit: circuitName,
        wasmBuild: () => {
          if (runKind === 'Flow') {
            return wasm.runTransaction(
              {
                private: {
                  txContext: { outputTreeId: DEFAULT_TREE_ID },
                  input0: toProgUtxo(input0!, input0Keys),
                  nullifierSecret0: input0Keys.nfFieldDec,
                  input1: input1 && input1Keys ? toProgUtxo(input1, input1Keys) : makeDummyProgramUtxo(),
                  nullifierSecret1: input1Keys ? input1Keys.nfFieldDec : '0',
                  changeOwner: changeKeys.shieldedAddress.toBytes(),
                  stageInAccount: Array.from(fromBase58(stageInForSpp)),
                },
                public: {
                  authorityIdentity,
                  hookHash: hookHashDec,
                  callHash: callHashDec,
                  amountIn: BigInt(quote.amountIn),
                  minOut: BigInt(quote.minimumOut),
                  outputOwnerHash: hasMintOut || hasMintIn ? bytesToDecimalField(outputKeys.ownerHashBytes) : '0',
                  relayerFee: BigInt(relayerFeeAmount),
                  expiry: expiryUnixTs,
                },
              },
              senderKeysForWasm.shieldedAddress.toBytes(),
              relayerPayer,
            )
          }
          const seatSecret = Array.from(deriveSeatSecretBytes(keys.seed, seatNote!.seatIndex!))
          if (runKind === 'SeatFund') {
            return wasm.seatFundTransaction(
              {
                private: {
                  txContext: { outputTreeId: DEFAULT_TREE_ID },
                  seatInput: toProgUtxo(seatNote!, seatKeyObj!),
                  seatSecret,
                  seatNullifierSecret: seatKeyObj!.nfFieldDec,
                  nextSeatOwner: nextSeatKeys!.shieldedAddress.toBytes(),
                  input0: toProgUtxo(input0!, input0Keys),
                  nullifierSecret0: input0Keys.nfFieldDec,
                  input1: input1 && input1Keys ? toProgUtxo(input1, input1Keys) : makeDummyProgramUtxo(),
                  nullifierSecret1: input1Keys ? input1Keys.nfFieldDec : '0',
                  changeOwner: changeKeys.shieldedAddress.toBytes(),
                  stageInAccount: Array.from(fromBase58(stageInForSpp)),
                },
                public: {
                  authorityIdentity,
                  seatCommitment: bytesToDecimalField(seatCommitmentBytes),
                  hookHash: hookHashDec,
                  callHash: callHashDec,
                  amountIn: BigInt(quote.amountIn),
                  minOut: BigInt(quote.minimumOut),
                  outputOwnerHash: hasMintOut || hasMintIn ? bytesToDecimalField(outputKeys.ownerHashBytes) : '0',
                  relayerFee: BigInt(relayerFeeAmount),
                  expiry: expiryUnixTs,
                },
              },
              senderKeysForWasm.shieldedAddress.toBytes(),
              relayerPayer,
            )
          }
          return wasm.seatActionTransaction(
            {
              private: {
                txContext: { outputTreeId: DEFAULT_TREE_ID },
                seatInput: toProgUtxo(seatNote!, seatKeyObj!),
                seatSecret,
                seatNullifierSecret: seatKeyObj!.nfFieldDec,
                nextSeatOwner: nextSeatKeys!.shieldedAddress.toBytes(),
              },
              public: {
                authorityIdentity,
                seatCommitment: bytesToDecimalField(seatCommitmentBytes),
                hookHash: hookHashDec,
                callHash: callHashDec,
                minOut: BigInt(quote.minimumOut),
                outputOwnerHash: hasMintOut ? bytesToDecimalField(outputKeys.ownerHashBytes) : '0',
                relayerFee: BigInt(relayerFeeAmount),
                expiry: expiryUnixTs,
              },
            },
            senderKeysForWasm.shieldedAddress.toBytes(),
            relayerPayer,
          )
        },
        keys,
        senderIndex,
        authIndices,
        expiryUnixTs,
        payer: relayerPayer,
        tree: netCfg.stateTree,
        withdrawal: !hasMintIn
          ? undefined
          : inIsSol
            ? { kind: 'sol', recipient: kitAddress(stageInForSpp) }
            : {
                kind: 'spl',
                mint: kitAddress(quote.mintIn!),
                splTokenInterface: kitAddress(splIfIn!),
                recipientTokenAccount: kitAddress(stageInForSpp),
                tokenProgram: kitAddress(tokenProgramIn),
              },
        spr,
        walletRegistry: assetRegistry,
        artifactCache,
        fetcher,
        proverBaseUrl: proverUrl,
        signal: params.signal,
      })

      const callerData = quote.callerDataBase64 ? fromBase64(quote.callerDataBase64) : new Uint8Array(0)
      const callerRemainingWritable = Uint8Array.from(quote.callerRemainingWritable ?? [])
      const ixData = encodeRunIxData(
        {
          kind: runKind,
          proof: proven.appProof,
          authorityBump,
          stageBump,
          amountIn: BigInt(quote.amountIn),
          minOut: BigInt(quote.minimumOut),
          outputOwnerHash: hasMintOut || hasMintIn ? outputKeys.ownerHashBytes : new Uint8Array(32),
          relayerFee: BigInt(relayerFeeAmount),
          expiry: expiryUnixTs,
          seatCommitment: seatCommitmentBytes,
          mintIn: hasMintIn ? toProgramMintBytes(quote.mintIn) : new Uint8Array(32),
          mintOut: hasMintOut ? toProgramMintBytes(quote.mintOut) : new Uint8Array(32),
          hasMintOut,
          outSplInterfaceBump,
          sppAccountCount: proven.sppAccounts.length,
          callerData,
          callerRemainingWritable,
        },
        proven.transactBytes,
      )

      // Assemble exact `process_run` account list (mirrors instructions.rs lines 552..629)
      const accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = [
        { pubkey: relayerPayer, isWritable: true, isSigner: true },
        { pubkey: configPda, isWritable: false, isSigner: false },
        { pubkey: hookAddr, isWritable: false, isSigner: false },
        { pubkey: stagePda, isWritable: true, isSigner: false },
        { pubkey: hookDetail.targetProgram, isWritable: false, isSigner: false },
        { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: netCfg.stateTree, isWritable: true, isSigner: false },
        { pubkey: SHIELDED_POOL_PROGRAM_ID, isWritable: false, isSigner: false },
      ]

      if (hasMintIn) {
        if (inIsSol && hookDetail.wrapSolIn) {
          accounts.push(
            { pubkey: tokenProgramIn, isWritable: false, isSigner: false },
            { pubkey: stageInForHook, isWritable: true, isSigner: false },
          )
        } else if (!inIsSol) {
          accounts.push(
            { pubkey: tokenProgramIn, isWritable: false, isSigner: false },
            { pubkey: quote.mintIn!, isWritable: false, isSigner: false },
            { pubkey: stageInForSpp, isWritable: true, isSigner: false },
          )
        }
      }

      const hookAuthor = quote.hookAuthor ?? hookDetail.author
      const feeRecipient = quote.feeRecipient ?? netCfg.feeRecipient ?? relayerPayer
      if (hasMintOut) {
        if (outIsSol) {
          const [afPda] = await deriveAuthorFeesPda(programId, hookAuthor, new Uint8Array(32))
          accounts.push(
            { pubkey: SOL_INTERFACE_ADDRESS, isWritable: true, isSigner: false },
            { pubkey: feeRecipient, isWritable: true, isSigner: false },
            { pubkey: afPda, isWritable: true, isSigner: false },
          )
          if (hookDetail.unwrapSolOut) {
            accounts.push(
              { pubkey: tokenProgramOut, isWritable: false, isSigner: false },
              { pubkey: stageOutForHook, isWritable: true, isSigner: false },
            )
          }
        } else {
          const [afPda] = await deriveAuthorFeesPda(programId, hookAuthor, fromBase58(quote.mintOut!))
          const [afAta, feeRecAta, relAta] = await Promise.all([
            deriveAtaAddress(afPda, quote.mintOut!, tokenProgramOut),
            deriveAtaAddress(feeRecipient, quote.mintOut!, tokenProgramOut),
            deriveAtaAddress(relayerPayer, quote.mintOut!, tokenProgramOut),
          ])
          accounts.push(
            { pubkey: tokenProgramOut, isWritable: false, isSigner: false },
            { pubkey: quote.mintOut!, isWritable: false, isSigner: false },
            { pubkey: stageOutForHook, isWritable: true, isSigner: false },
            { pubkey: String(splIfOut!), isWritable: true, isSigner: false },
            { pubkey: feeRecAta, isWritable: true, isSigner: false },
            { pubkey: afPda, isWritable: true, isSigner: false },
            { pubkey: afAta, isWritable: true, isSigner: false },
            { pubkey: relAta, isWritable: true, isSigner: false },
          )
        }
      }

      if (isSeatHook) {
        const [seatStatePda] = await deriveSeatStatePda(programId, seatCommitmentBytes)
        const [seatPda] = await deriveSeatPda(programId, seatCommitmentBytes)
        accounts.push(
          { pubkey: seatStatePda, isWritable: false, isSigner: false },
          { pubkey: seatPda, isWritable: true, isSigner: false },
        )
      }

      if ((hookDetail.companions?.length ?? hookDetail.companionInstructions.length) > 0) {
        accounts.push({ pubkey: INSTRUCTIONS_SYSVAR_ID, isWritable: false, isSigner: false })
      }

      accounts.push(...proven.sppAccounts)
      accounts.push(...(quote.callerAccounts ?? []))

      changeKeys.pda.destroy()
      outputKeys.pda.destroy()
      input0Keys.pda.destroy()
      input1Keys?.pda.destroy()
      senderKeysForWasm.pda.destroy()
      seatKeyObj?.pda.destroy()
      nextSeatKeys?.pda.destroy()

      const tRelay0 = nowMs()
      const relayAccepted = await relayerClient.relayRun(
        {
          hookId,
          quoteId: quote.quoteId,
          appProofBase64: toBase64(proven.appProof),
          sppProofBase64: toBase64(proven.transactBytes),
          transactDataBase64: toBase64(proven.transactBytes),
          resolvedAccounts: quote.resolvedAccounts.map((a) => a.address),
          resolvedDataBase64: quote.resolvedDataBase64,
          companionInstructions: quote.companionInstructions,
          setupInstructions,
          instructionDataBase64: toBase64(ixData),
          accounts,
          computeUnitLimit: 1_400_000,
          mintIn: quote.mintIn ?? undefined,
          mintOut: quote.mintOut ?? undefined,
          amountIn: quote.amountIn,
          minimumOut: quote.minimumOut,
          relayerFee: relayerFeeAmount,
          expiryUnixTs: expiryUnixTs.toString(),
          seatAddress: params.seat,
        },
        { signal: params.signal },
      )
      const relayMs = Math.round(nowMs() - tRelay0)
      params.onStage?.('relayed', relayAccepted)
      const tConfirm0 = nowMs()
      const relay = await pollRelayUntilSettled(relayerClient, relayAccepted, params.signal)
      if (relay.status === 'confirmed' || relay.status === 'finalized') {
        await waitForPhotonIndexed(netCfg, relay.signature, params.signal)
        sessionNotes = null
        params.onStage?.('confirmed', relay)
      }
      const confirmMs = Math.round(nowMs() - tConfirm0)
      const timings: RunTimings = {
        quoteMs,
        scanMs,
        witnessMs: proven.timings.witnessMs,
        artifactLoadMs: proven.timings.artifactLoadMs,
        appProofMs: proven.timings.appProofMs,
        sppProofMs: proven.timings.sppProofMs,
        relayMs,
        confirmMs,
        totalMs: Math.round(nowMs() - tRun0),
      }
      return { quote, relay, signature: relay.signature, seat: activeSeat ?? seatNote?.seatAddress ?? null, openSeatSignature, timings }
    },

    /** Enter Pook from a public wallet or Rings private balance. */
    async enter(params: EnterParams): Promise<EnterResult> {
      const signer = requireSigner(params.signer ?? currentSigner)
      const keys = await ensureKeys(signer, params.signal)
      const netCfg = await loadConfig(params.signal)
      const source = params.source ?? 'wallet'
      const amountUnits = toUnits(params.amount)
      params.onStage?.('building')

      let outputOwnerHash = keys.ownerHash
      let transactDataBase64: string | undefined
      let transactAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] | undefined

      if (netCfg.status !== 'fixture' && netCfg.authorityPda) {
        if (sessionNotes === null) await scanNotes({ signer, signal: params.signal }).catch(() => [])
        const idx = allocNoteIndex()
        const derived = await deriveOneTimePdaKeys(keys, idx)
        try {
          outputOwnerHash = derived.ownerHashHex
          if (source === 'rings') {
            params.onStage?.('proving')
            const spr = await getSprClient()
            if (!ringsWalletKeys || ringsWalletKeys.wallet !== signer.publicKey) {
              clearRingsWalletKeys()
              const rk = await deriveRingsWalletKeys(signer, spr)
              ringsWalletKeys = { wallet: signer.publicKey, keys: rk }
            }
            const built = await buildRingsEnterTransact({
              ringsKeys: ringsWalletKeys.keys,
              spr,
              payer: signer.publicKey,
              stateTree: netCfg.stateTree,
              mint: params.mint,
              amount: BigInt(amountUnits),
              targetAddress: derived.shieldedAddress,
              signal: params.signal,
            })
            transactDataBase64 = built.transactDataBase64
            transactAccounts = built.transactAccounts
          }
        } finally {
          derived.pda.destroy()
        }
      }

      const build = await client.buildEnter(
        {
          source,
          wallet: signer.publicKey,
          mint: params.mint,
          amount: amountUnits,
          outputOwnerHash,
          outputViewingPkBase64: keys.viewingPkBase64,
          ...(transactDataBase64 ? { transactDataBase64 } : {}),
          ...(transactAccounts ? { transactAccounts } : {}),
        },
        { signal: params.signal },
      )
      const tx = await signAndSubmitBuild(client, build, signer, params.onStage, params.signal, true)
      if (tx.status === 'confirmed' || tx.status === 'finalized') {
        await waitForPhotonIndexed(netCfg, tx.signature, params.signal)
        sessionNotes = null
        params.onStage?.('confirmed', tx)
      }
      return { build, tx, signature: tx.signature }
    },

    /** Leave Pook to a public Solana address or a Rings private balance. */
    async leave(params: LeaveParams): Promise<LeaveResult> {
      const amount = toUnits(params.amount)
      const netCfg = await loadConfig(params.signal)
      params.onStage?.('quoting')
      const relayerQuote = await relayerClient.relayerQuote({ kind: 'leave', mint: params.mint }, { signal: params.signal })

      params.onStage?.('proving', relayerQuote)
      const expiryUnixTs = BigInt(Math.floor(Date.parse(relayerQuote.expiresAt) / 1000))

      if (netCfg.status === 'fixture' || !wasm || !netCfg.programId) {
        const [appProof, sppProof] = await Promise.all([
          prover.prove(
            client,
            {
              circuit: 'leave',
              inputsJson: JSON.stringify({
                mint: params.mint,
                amount,
                destination: params.destination,
                destinationType: params.destinationType ?? 'wallet',
                relayerFee: relayerQuote.feeAmount,
                expiryUnixTs: expiryUnixTs.toString(),
              }),
            },
            { signal: params.signal },
          ),
          prover.prove(
            client,
            {
              circuit: 'spp_transact',
              inputsJson: JSON.stringify({ amount, expiryUnixTs: expiryUnixTs.toString() }),
            },
            { signal: params.signal },
          ),
        ])
        const transactDataBase64 = toBase64(new TextEncoder().encode(JSON.stringify({ leave: true, expiryUnixTs: expiryUnixTs.toString() })))
        const accepted = await relayerClient.relayLeave(
          {
            destinationType: params.destinationType ?? 'wallet',
            destination: params.destination,
            mint: params.mint,
            amount,
            appProofBase64: appProof.proofBase64,
            sppProofBase64: sppProof.proofBase64,
            transactDataBase64,
            instructionDataBase64: toBase64(Uint8Array.of(POOK_TAGS.LEAVE)),
            accounts: [{ pubkey: relayerQuote.relayer, isWritable: true, isSigner: true }],
            relayerFee: relayerQuote.feeAmount,
            expiryUnixTs: expiryUnixTs.toString(),
          },
          { signal: params.signal },
        )
        params.onStage?.('relayed', accepted)
        const relay =
          accepted.status === 'accepted' || accepted.status === 'submitted'
            ? await relayerClient.relayStatus(accepted.relayId, { signal: params.signal })
            : accepted
        if (relay.status === 'confirmed' || relay.status === 'finalized') params.onStage?.('confirmed', relay)
        return { relay, signature: relay.signature }
      }

      // Real chain mode leave
      await initializePoseidon()
      const keys = await ensureKeys(undefined, params.signal)
      const notes = sessionNotes ?? (await scanNotes({ signal: params.signal }))
      const assetRegistry = buildAssetRegistryFromNotes(notes)
      const programId = netCfg.programId
      const [, authorityBump] = await deriveAuthorityPda(programId)
      const [stagePda, stageBump] = await deriveStagePda(programId)
      const isSol = isNativeSolMint(params.mint)
      const leaveKind: 0 | 1 = (params.destinationType ?? 'wallet') === 'rings' ? 1 : 0
      const tokenProgram = SPL_TOKEN_PROGRAM_ID
      const stageInForSpp = isSol ? stagePda : await deriveAtaAddress(stagePda, params.mint, tokenProgram)

      const picked = pickInputNotes(notes, params.mint, BigInt(amount))
      const input0 = picked[0]!
      const input1 = picked[1]
      const input0Idx = input0.keyIndex ?? 0
      const input1Idx = input1?.keyIndex
      const input0Keys = await deriveOneTimePdaKeys(keys, input0Idx)
      const input1Keys = input1Idx !== undefined ? await deriveOneTimePdaKeys(keys, input1Idx) : null
      const changeKeys = await deriveOneTimePdaKeys(keys, allocNoteIndex())

      const [splIf, splInterfaceBump] = !isSol ? await deriveSppSplInterfaceWithBump(netCfg.ringsProgramId, params.mint) : [null, 0]
      const spr = await getSprClient()

      const destAta = leaveKind === 0 && !isSol ? await deriveAtaAddress(params.destination, params.mint, tokenProgram) : params.destination
      let destOwnerHash: Uint8Array = new Uint8Array(32)
      let destViewTag: Uint8Array = new Uint8Array(32)
      if (leaveKind === 1) {
        if (/^[0-9a-fA-F]{64}$/.test(params.destination)) {
          destOwnerHash = fromHex(params.destination)
          destViewTag = params.destinationViewTag ? fromBase58(params.destinationViewTag) : new Uint8Array(32)
        } else {
          const resolvedRecipient = await resolveRingsRecipientAddress(spr, params.destination, params.signal)
          destOwnerHash = resolvedRecipient.ownerHash
          destViewTag = resolvedRecipient.viewTag
        }
      }
      const destHashBytes = leaveKind === 0 ? hashBytes(fromBase58(destAta)) : destOwnerHash
      const destViewTagHashBytes = leaveKind === 1 ? hashBytes(destViewTag) : new Uint8Array(32)

      const proven = await proveProgramAndSpp({
        client,
        wasm,
        circuit: 'leave',
        wasmBuild: () =>
          wasm.leaveTransaction(
            {
              private: {
                txContext: { outputTreeId: DEFAULT_TREE_ID },
                input0: toProgramWalletUtxo(input0.walletUtxo!, {
                  nullifierPublicKey: input0Keys.nullifierPublicKey,
                  treeId: DEFAULT_TREE_ID,
                  assets: assetRegistry,
                }),
                nullifierSecret0: input0Keys.nfFieldDec,
                input1:
                  input1 && input1Keys
                    ? toProgramWalletUtxo(input1.walletUtxo!, {
                        nullifierPublicKey: input1Keys.nullifierPublicKey,
                        treeId: DEFAULT_TREE_ID,
                        assets: assetRegistry,
                      })
                    : makeDummyProgramUtxo(),
                nullifierSecret1: input1Keys ? input1Keys.nfFieldDec : '0',
                changeOwner: changeKeys.shieldedAddress.toBytes(),
                stageInAccount: Array.from(fromBase58(stageInForSpp)),
              },
              public: {
                authorityIdentity: authorityIdentityFieldDec(keys.authorityPda),
                leaveKind,
                destHash: bytesToDecimalField(destHashBytes),
                destViewTagHash: bytesToDecimalField(destViewTagHashBytes),
                amount: BigInt(amount),
                relayerFee: BigInt(relayerQuote.feeAmount),
                expiry: expiryUnixTs,
              },
            },
            input0Keys.shieldedAddress.toBytes(),
            relayerQuote.relayer,
          ),
        keys,
        senderIndex: input0Idx,
        authIndices: [input0Idx, ...(input1Idx !== undefined ? [input1Idx] : [])],
        expiryUnixTs,
        payer: relayerQuote.relayer,
        tree: netCfg.stateTree,
        withdrawal: isSol
          ? { kind: 'sol', recipient: kitAddress(stageInForSpp) }
          : {
              kind: 'spl',
              mint: kitAddress(params.mint),
              splTokenInterface: kitAddress(splIf!),
              recipientTokenAccount: kitAddress(stageInForSpp),
              tokenProgram: kitAddress(tokenProgram),
            },
        spr,
        walletRegistry: assetRegistry,
        artifactCache,
        fetcher,
        proverBaseUrl: proverUrl,
        signal: params.signal,
      })

      const ixData = encodeLeaveIxData(
        {
          proof: proven.appProof,
          authorityBump,
          stageBump,
          leaveKind,
          mint: toProgramMintBytes(params.mint),
          amount: BigInt(amount),
          relayerFee: BigInt(relayerQuote.feeAmount),
          expiry: expiryUnixTs,
          destOwnerHash,
          destViewTag,
          splInterfaceBump: leaveKind === 1 && !isSol ? splInterfaceBump : 0,
          sppAccountCount: proven.sppAccounts.length,
        },
        proven.transactBytes,
      )

      const accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = [
        { pubkey: relayerQuote.relayer, isWritable: true, isSigner: true },
        { pubkey: stagePda, isWritable: true, isSigner: false },
        { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
      ]

      const setupInstructions: { programId: string; accounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]; dataBase64: string }[] = []

      if (leaveKind === 0 && isSol) {
        accounts.push({ pubkey: params.destination, isWritable: true, isSigner: false })
      } else if (leaveKind === 0 && !isSol) {
        const relAta = await deriveAtaAddress(relayerQuote.relayer, params.mint, tokenProgram)
        accounts.push(
          { pubkey: tokenProgram, isWritable: false, isSigner: false },
          { pubkey: params.mint, isWritable: false, isSigner: false },
          { pubkey: stageInForSpp, isWritable: true, isSigner: false },
          { pubkey: destAta, isWritable: true, isSigner: false },
          { pubkey: relAta, isWritable: true, isSigner: false },
        )
        setupInstructions.push(
          {
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: [
              { pubkey: relayerQuote.relayer, isWritable: true, isSigner: true },
              { pubkey: destAta, isWritable: true, isSigner: false },
              { pubkey: params.destination, isWritable: false, isSigner: false },
              { pubkey: params.mint, isWritable: false, isSigner: false },
              { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
              { pubkey: tokenProgram, isWritable: false, isSigner: false },
            ],
            dataBase64: toBase64(Uint8Array.of(1)),
          },
          ...(params.destination !== relayerQuote.relayer
            ? [
                {
                  programId: ASSOCIATED_TOKEN_PROGRAM_ID,
                  accounts: [
                    { pubkey: relayerQuote.relayer, isWritable: true, isSigner: true },
                    { pubkey: relAta, isWritable: true, isSigner: false },
                    { pubkey: relayerQuote.relayer, isWritable: false, isSigner: false },
                    { pubkey: params.mint, isWritable: false, isSigner: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
                    { pubkey: tokenProgram, isWritable: false, isSigner: false },
                  ],
                  dataBase64: toBase64(Uint8Array.of(1)),
                },
              ]
            : []),
        )
      } else if (leaveKind === 1 && isSol) {
        accounts.push(
          { pubkey: netCfg.stateTree, isWritable: true, isSigner: false },
          { pubkey: SHIELDED_POOL_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: SOL_INTERFACE_ADDRESS, isWritable: true, isSigner: false },
        )
      } else {
        const relAta = await deriveAtaAddress(relayerQuote.relayer, params.mint, tokenProgram)
        accounts.push(
          { pubkey: netCfg.stateTree, isWritable: true, isSigner: false },
          { pubkey: SHIELDED_POOL_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: tokenProgram, isWritable: false, isSigner: false },
          { pubkey: params.mint, isWritable: false, isSigner: false },
          { pubkey: stageInForSpp, isWritable: true, isSigner: false },
          { pubkey: String(splIf!), isWritable: true, isSigner: false },
          { pubkey: relAta, isWritable: true, isSigner: false },
        )
        setupInstructions.push({
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          accounts: [
            { pubkey: relayerQuote.relayer, isWritable: true, isSigner: true },
            { pubkey: relAta, isWritable: true, isSigner: false },
            { pubkey: relayerQuote.relayer, isWritable: false, isSigner: false },
            { pubkey: params.mint, isWritable: false, isSigner: false },
            { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
            { pubkey: tokenProgram, isWritable: false, isSigner: false },
          ],
          dataBase64: toBase64(Uint8Array.of(1)),
        })
      }
      accounts.push(...proven.sppAccounts)

      input0Keys.pda.destroy()
      input1Keys?.pda.destroy()
      changeKeys.pda.destroy()

      const accepted = await relayerClient.relayLeave(
        {
          destinationType: params.destinationType ?? 'wallet',
          destination: leaveKind === 1 ? toHex(destOwnerHash) : params.destination,
          mint: params.mint,
          amount,
          appProofBase64: toBase64(proven.appProof),
          sppProofBase64: toBase64(proven.transactBytes),
          transactDataBase64: toBase64(proven.transactBytes),
          setupInstructions,
          instructionDataBase64: toBase64(ixData),
          accounts,
          computeUnitLimit: 600_000,
          relayerFee: relayerQuote.feeAmount,
          expiryUnixTs: expiryUnixTs.toString(),
        },
        { signal: params.signal },
      )
      params.onStage?.('relayed', accepted)
      const relay = await pollRelayUntilSettled(relayerClient, accepted, params.signal)
      if (relay.status === 'confirmed' || relay.status === 'finalized') {
        await waitForPhotonIndexed(netCfg, relay.signature, params.signal)
        sessionNotes = null
        params.onStage?.('confirmed', relay)
      }
      return { relay, signature: relay.signature }
    },

    /** Open a new seat PDA and mint its controlling SeatNote data UTXO (running Kamino setup CPIs by default). */
    async openSeat(options?: OpenSeatOptions): Promise<SeatActionResult> {
      const opts = typeof options === 'number' ? { seatIndex: options } : (options ?? {})
      const protocol = opts.protocol ?? 'kamino'
      const netCfg = await loadConfig(opts.signal)
      const relayerQuote = await relayerClient.relayerQuote({ kind: 'open_seat', mint: WSOL_MINT }, { signal: opts.signal })
      const expiryUnixTs = BigInt(Math.floor(Date.parse(relayerQuote.expiresAt) / 1000))

      if (netCfg.status === 'fixture' || !wasm || !netCfg.programId) {
        const seatIdx = opts.seatIndex ?? nextSeatIndex++
        const commHex = seatIdx.toString(16).padStart(64, '1')
        const accepted = await relayerClient.relayOpenSeat(
          {
            seatCommitmentHex: commHex,
            instructionDataBase64: toBase64(new Uint8Array(16)),
            accounts: [],
            expiryUnixTs: expiryUnixTs.toString(),
          },
          { signal: opts.signal },
        )
        return { relay: accepted, seatAddress: accepted.seatAddress ?? null, seatCommitmentHex: commHex, signature: accepted.signature }
      }

      await initializePoseidon()
      const keys = await ensureKeys(undefined, opts.signal)
      if (sessionNotes === null) await scanNotes({ signal: opts.signal }).catch(() => [])
      const programId = netCfg.programId
      const seatIdx = opts.seatIndex ?? nextSeatIndex++
      const seatNoteKeyIdx = allocNoteIndex()
      const [, authorityBump] = await deriveAuthorityPda(programId)
      const seatCommitment = deriveSeatCommitmentBytes(keys.seed, seatIdx, wasm)
      const [seatStatePda] = await deriveSeatStatePda(programId, seatCommitment)
      const [seatPda] = await deriveSeatPda(programId, seatCommitment)
      const seatOwnerKeys = await deriveOneTimePdaKeys(keys, seatNoteKeyIdx)
      const pdaAddressOwner = await deriveProgramOwnerZeroAddress(keys)
      const wallet = new Wallet({ identity: seatOwnerKeys.shieldedAddress })

      const spr = await getSprClient()

      const proven = await proveProgramAndSpp({
        client,
        wasm,
        circuit: 'seat_open',
        wasmBuild: () =>
          wasm.seatOpenTransaction(
            {
              private: {
                txContext: { outputTreeId: DEFAULT_TREE_ID },
                seatSecret: Array.from(deriveSeatSecretBytes(keys.seed, seatIdx)),
                pdaAddressOwner,
                seatOwner: seatOwnerKeys.shieldedAddress.toBytes(),
              },
              public: {
                authorityIdentity: authorityIdentityFieldDec(keys.authorityPda),
                seatCommitment: bytesToDecimalField(seatCommitment),
                expiry: expiryUnixTs,
              },
            },
            seatOwnerKeys.shieldedAddress.toBytes(),
            relayerQuote.relayer,
          ),
        keys,
        senderIndex: seatNoteKeyIdx,
        authIndices: [seatNoteKeyIdx],
        expiryUnixTs,
        payer: relayerQuote.relayer,
        tree: netCfg.stateTree,
        spr,
        walletRegistry: wallet.registry,
        artifactCache,
        fetcher,
        proverBaseUrl: proverUrl,
        signal: opts.signal,
      })

      const kaminoSetup = protocol === 'kamino' ? await buildKaminoOpenSeatSetup(seatPda, opts.lendingMarket) : null
      const ixData = encodeOpenSeatIxData(
        {
          proof: proven.appProof,
          authorityBump,
          seatCommitment,
          expiry: expiryUnixTs,
          sppAccountCount: proven.sppAccounts.length,
          setupCpis: kaminoSetup?.setupCpis ?? [],
        },
        proven.transactBytes,
      )
      const accounts = [
        { pubkey: relayerQuote.relayer, isWritable: true, isSigner: true },
        { pubkey: seatStatePda, isWritable: true, isSigner: false },
        { pubkey: seatPda, isWritable: true, isSigner: false },
        { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
        ...proven.sppAccounts,
        ...(kaminoSetup?.setupAccounts ?? []),
      ]
      seatOwnerKeys.pda.destroy()

      const accepted = await relayerClient.relayOpenSeat(
        {
          seatCommitmentHex: toHex(seatCommitment),
          seatAddress: seatPda,
          instructionDataBase64: toBase64(ixData),
          accounts,
          computeUnitLimit: kaminoSetup ? 900_000 : 600_000,
          expiryUnixTs: expiryUnixTs.toString(),
        },
        { signal: opts.signal },
      )
      const relay = await pollRelayUntilSettled(relayerClient, accepted, opts.signal)
      if (relay.status === 'confirmed' || relay.status === 'finalized') {
        await waitForPhotonIndexed(netCfg, relay.signature, opts.signal)
        sessionNotes = null
      }
      return { relay, seatAddress: seatPda, seatCommitmentHex: toHex(seatCommitment), signature: relay.signature }
    },

    /** Close an empty seat, burning its SeatNote and returning rent to the opener relayer. */
    async closeSeat(seatAddress: string, options?: { openerRelayer?: string; signal?: AbortSignal }): Promise<SeatActionResult> {
      const netCfg = await loadConfig(options?.signal)
      const relayerQuote = await relayerClient.relayerQuote({ kind: 'close_seat', mint: WSOL_MINT }, { signal: options?.signal })
      const expiryUnixTs = BigInt(Math.floor(Date.parse(relayerQuote.expiresAt) / 1000))

      if (netCfg.status === 'fixture' || !wasm || !netCfg.programId) {
        const commHex = '11'.repeat(32)
        const accepted = await relayerClient.relayCloseSeat(
          {
            seatCommitmentHex: commHex,
            seatAddress,
            instructionDataBase64: toBase64(new Uint8Array(16)),
            accounts: [],
            expiryUnixTs: expiryUnixTs.toString(),
          },
          { signal: options?.signal },
        )
        return { relay: accepted, seatAddress, seatCommitmentHex: commHex, signature: accepted.signature }
      }

      await initializePoseidon()
      const keys = await ensureKeys(undefined, options?.signal)
      const notes = sessionNotes ?? (await scanNotes({ signal: options?.signal }))
      const assetRegistry = buildAssetRegistryFromNotes(notes)
      const seatNote = notes.find((n) => !n.spent && n.kind === 'seat' && n.seatAddress === seatAddress)
      if (!seatNote || !seatNote.walletUtxo || seatNote.seatIndex === undefined || seatNote.keyIndex === undefined) {
        throw new ApiClientError(404, {
          error: { code: 'NOT_FOUND', message: `No active seat note found for ${seatAddress}.`, retryable: false, stage: 'build' },
        })
      }

      const stateResp = await client.seatsState({ seatAddresses: [seatAddress] }, { signal: options?.signal })
      const seatInfo = stateResp.seats.find((s) => s.seatAddress === seatAddress)
      if (seatInfo && (seatInfo.collateral.length > 0 || seatInfo.debt.length > 0 || seatInfo.status === 'open')) {
        throw new ApiClientError(409, {
          error: {
            code: 'SEAT_NOT_EMPTY',
            message: 'Cannot close seat while it still holds open collateral or debt.',
            retryable: false,
            stage: 'validation',
          },
        })
      }
      const openerRelayer = options?.openerRelayer ?? seatInfo?.openerRelayer ?? relayerQuote.relayer

      const programId = netCfg.programId
      const [, authorityBump] = await deriveAuthorityPda(programId)
      const seatCommitment = deriveSeatCommitmentBytes(keys.seed, seatNote.seatIndex, wasm)
      const [seatStatePda] = await deriveSeatStatePda(programId, seatCommitment)
      const [seatPda] = await deriveSeatPda(programId, seatCommitment)
      const seatOwnerKeys = await deriveOneTimePdaKeys(keys, seatNote.keyIndex)

      const spr = await getSprClient()

      const proven = await proveProgramAndSpp({
        client,
        wasm,
        circuit: 'seat_close',
        wasmBuild: () =>
          wasm.seatCloseTransaction(
            {
              private: {
                txContext: { outputTreeId: DEFAULT_TREE_ID },
                seatInput: toProgramWalletUtxo(seatNote.walletUtxo!, {
                  nullifierPublicKey: seatOwnerKeys.nullifierPublicKey,
                  treeId: DEFAULT_TREE_ID,
                  assets: assetRegistry,
                }),
                seatSecret: Array.from(deriveSeatSecretBytes(keys.seed, seatNote.seatIndex!)),
                seatNullifierSecret: seatOwnerKeys.nfFieldDec,
              },
              public: {
                authorityIdentity: authorityIdentityFieldDec(keys.authorityPda),
                seatCommitment: bytesToDecimalField(seatCommitment),
                expiry: expiryUnixTs,
              },
            },
            seatOwnerKeys.shieldedAddress.toBytes(),
            relayerQuote.relayer,
          ),
        keys,
        senderIndex: seatNote.keyIndex,
        authIndices: [seatNote.keyIndex],
        expiryUnixTs,
        payer: relayerQuote.relayer,
        tree: netCfg.stateTree,
        spr,
        walletRegistry: assetRegistry,
        artifactCache,
        fetcher,
        proverBaseUrl: proverUrl,
        signal: options?.signal,
      })

      const ixData = encodeCloseSeatIxData(
        { proof: proven.appProof, authorityBump, seatCommitment, expiry: expiryUnixTs },
        proven.transactBytes,
      )
      const accounts = [
        { pubkey: relayerQuote.relayer, isWritable: true, isSigner: true },
        { pubkey: seatStatePda, isWritable: true, isSigner: false },
        { pubkey: seatPda, isWritable: true, isSigner: false },
        { pubkey: openerRelayer, isWritable: true, isSigner: false },
        { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
        ...proven.sppAccounts,
      ]
      seatOwnerKeys.pda.destroy()

      const accepted = await relayerClient.relayCloseSeat(
        {
          seatCommitmentHex: toHex(seatCommitment),
          seatAddress,
          instructionDataBase64: toBase64(ixData),
          accounts,
          computeUnitLimit: 600_000,
          expiryUnixTs: expiryUnixTs.toString(),
        },
        { signal: options?.signal },
      )
      const relay = await pollRelayUntilSettled(relayerClient, accepted, options?.signal)
      if (relay.status === 'confirmed' || relay.status === 'finalized') {
        await waitForPhotonIndexed(netCfg, relay.signature, options?.signal)
        sessionNotes = null
      }
      return { relay, seatAddress, seatCommitmentHex: toHex(seatCommitment), signature: relay.signature }
    },

    /** Scan and decrypt the holder's private balance locally in the browser. */
    async balance(options?: { signer?: WalletSigner; signal?: AbortSignal }): Promise<BalanceResult> {
      const notes = await scanNotes(options)
      const byMint = new Map<string, { symbol: string; decimals: number; amount: bigint; noteCount: number }>()
      for (const note of notes) {
        if (note.spent || note.kind !== 'balance') continue
        const existing = byMint.get(note.mint)
        if (existing) {
          existing.amount += BigInt(note.amount)
          existing.noteCount += 1
        } else {
          byMint.set(note.mint, {
            symbol: note.symbol,
            decimals: note.decimals,
            amount: BigInt(note.amount),
            noteCount: 1,
          })
        }
      }
      const assets: AssetBalance[] = [...byMint.entries()].map(([mint, v]) => ({
        mint,
        symbol: v.symbol,
        decimals: v.decimals,
        amount: v.amount.toString(),
        noteCount: v.noteCount,
      }))
      return { assets, notes, asOf: new Date().toISOString() }
    },

    /** Discover open seat notes locally and fetch each seat's public protocol position. */
    async seats(options?: { signer?: WalletSigner; signal?: AbortSignal }): Promise<SeatPosition[]> {
      const notes = await scanNotes(options)
      const seatAddresses = [...new Set(notes.filter((n) => !n.spent && n.kind === 'seat' && n.seatAddress).map((n) => n.seatAddress!))]
      if (!seatAddresses.length) return []
      const res = await client.seatsState({ seatAddresses }, { signal: options?.signal })
      return res.seats
    },

    /** Holder's own decrypted history (enters, runs, leaves), newest first. */
    async activity(options?: { signer?: WalletSigner; signal?: AbortSignal }): Promise<ActivityItem[]> {
      const notes = await scanNotes(options)
      return notes
        .map((n) => ({
          id: n.commitment,
          kind: n.action,
          hookId: n.hookId,
          mint: n.mint,
          symbol: n.symbol,
          decimals: n.decimals,
          amount: n.amount,
          signature: n.signature,
          slot: n.slot,
          timestamp: n.timestamp,
        }))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    },

    /** Simulate a hook draft against chain state before publishing. */
    async simulateHook(params: SimulateHookParams): Promise<SimulateHookResponse> {
      const { notes: _notes, ...hook } = params.hook as HookDefinition
      return client.simulateHook(
        {
          hook,
          sampleAmountIn: toUnits(params.sampleAmountIn),
          sampleMintIn: params.sampleMintIn,
          sampleMintOut: params.sampleMintOut,
          sampleArgs: params.sampleArgs,
          sampleFundFrom: params.sampleFundFrom,
        },
        { signal: params.signal },
      )
    },

    /** Build, sign, and submit a publish_hook transaction. */
    async publishHook(params: PublishHookParams): Promise<EnterResult> {
      const signer = requireSigner(params.signer ?? currentSigner)
      const { notes: _notes, ...hook } = params.hook as HookDefinition
      params.onStage?.('building')
      const build = await client.buildPublishHook({ author: signer.publicKey, hook }, { signal: params.signal })
      const tx = await signAndSubmitBuild(client, build, signer, params.onStage, params.signal)
      return { build, tx, signature: tx.signature }
    },

    /** Build, sign, and submit a claim_author_fees transaction for accrued hook fees. */
    async claimAuthorFees(params: ClaimAuthorFeesParams): Promise<EnterResult> {
      const signer = requireSigner(params.signer ?? currentSigner)
      params.onStage?.('building')
      const build = await client.buildClaimAuthorFees(
        signer.publicKey,
        { hookIds: params.hookIds, mint: params.mint },
        { signal: params.signal },
      )
      const tx = await signAndSubmitBuild(client, build, signer, params.onStage, params.signal)
      return { build, tx, signature: tx.signature }
    },
  }

  return pook
}

export type Pook = ReturnType<typeof createPook>

// --- Standalone top-level exports matching PLAN.md SDK surface ---

let defaultInstance: Pook | null = null

export function configurePook(config: PookConfig): Pook {
  defaultInstance = createPook(config)
  return defaultInstance
}

function resolvePook(instance?: Pook): Pook {
  const target = instance ?? defaultInstance
  if (!target) {
    throw new Error('Pook SDK is not configured. Call createPook({ apiUrl }) or configurePook({ apiUrl }) first.')
  }
  return target
}

export const run = (hookId: string, params: RunParams, pook?: Pook) => resolvePook(pook).run(hookId, params)
export const enter = (params: EnterParams, pook?: Pook) => resolvePook(pook).enter(params)
export const leave = (params: LeaveParams, pook?: Pook) => resolvePook(pook).leave(params)
export const openSeat = (options?: { seatIndex?: number; signal?: AbortSignal }, pook?: Pook) => resolvePook(pook).openSeat(options)
export const closeSeat = (seatAddress: string, options?: { openerRelayer?: string; signal?: AbortSignal }, pook?: Pook) =>
  resolvePook(pook).closeSeat(seatAddress, options)
export const balance = (options?: { signer?: WalletSigner; signal?: AbortSignal }, pook?: Pook) => resolvePook(pook).balance(options)
export const publicBalance = (mint?: string, options?: { wallet?: string; signer?: WalletSigner; signal?: AbortSignal }, pook?: Pook) =>
  resolvePook(pook).publicBalance(mint, options)
export const seats = (options?: { signer?: WalletSigner; signal?: AbortSignal }, pook?: Pook) => resolvePook(pook).seats(options)
export const activity = (options?: { signer?: WalletSigner; signal?: AbortSignal }, pook?: Pook) => resolvePook(pook).activity(options)
export const publishHook = (params: PublishHookParams, pook?: Pook) => resolvePook(pook).publishHook(params)
export const simulateHook = (params: SimulateHookParams, pook?: Pook) => resolvePook(pook).simulateHook(params)
export const claimAuthorFees = (params: ClaimAuthorFeesParams, pook?: Pook) => resolvePook(pook).claimAuthorFees(params)
export { defineHook, type DefineHookInput, type HookDefinition }
