import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token'
import {
  Address,
  CONTRACT_VERSION,
  ClaimAuthorFeesBuildRequest,
  EnterBuildRequest,
  HookId,
  HooksQuery,
  NotesQuery,
  NullifiersCheckRequest,
  ParseIdlRequest,
  PublicBalanceQuery,
  PublishHookBuildRequest,
  QuoteRequest,
  RunsQuery,
  SeatsStateRequest,
  SimulateHookRequest,
  TxSubmitRequest,
  WSOL_MINT,
  encodeClaimAuthorFeesIxData,
  encodeEnterPrivateIxData,
  encodeEnterPublicIxData,
  encodePublishHookIxData,
  fromBase64,
  fromHex,
  hookDraftToOnChain,
  isNativeSolMint,
  paginate,
  resolveCpiData,
  toBase64,
  type AuthorHookFee,
  type HookDetail,
  type HookSummary,
  type KnownErrorStage,
  type PublicRun,
  type Scenario,
  type TxStatusResponse,
  type WireHookAccount,
} from '@pook/contract'
import { env, fail, relayerFeeForMint } from '../config.js'
import type { Rpc } from '../engines/rpc/client.js'
import type { ApiVariables } from '../engines/server/app.js'
import type { FixtureVariables } from '../engines/server/fixture.js'
import { readJson, readParam, readQuery } from '../engines/server/input.js'
import type { Readiness } from '../engines/server/readiness.js'
import { EventHub, streamEvents, type StreamEvent } from '../engines/server/sse.js'
import { buildUnsignedV0, networkFee } from '../engines/tx/server/build.js'
import { TxError } from '../engines/tx/server/failure.js'
import { refresh, submit, type LedgerDeps } from '../engines/tx/server/ledger.js'
import {
  ConfigCache,
  SUPPORTED_ASSETS,
  assetMeta,
  detectTokenProgram,
  fetchOnChainAnchorIdl,
  parseAnchorIdlJson,
  readAuthorFeesAccount,
  readHookAccount,
  readPublicWalletBalance,
} from './accounts.js'
import {
  findAta,
  findAuthorFeesPda,
  findAuthorityPda,
  findConfigPda,
  findHookPda,
  findSppSolInterfacePda,
  findSppSplInterfacePda,
  findStagePda,
  pookErrorRegistry,
} from './pda.js'
import { resolveHookQuote, resolveSeatPositions } from './resolvers.js'
import { buildOnChainHookDetail, resolveHookDisplay } from './hook-metadata.js'
import { PrismaWalletTxStore } from './tx-store.js'
import { loadLaunchHooks } from '../../hooks/index.js'
import { PROVER_FORWARD_HEADERS } from './prover-headers.js'

export type ChainAppDeps = {
  db: PrismaClient
  rpc: Rpc
  readiness: Readiness
  hub: EventHub<StreamEvent>
}

// The Rings indexer's methods (Photon /{method}, Helius /v1/spr/{method}), read-only.
const PHOTON_ALLOWED_METHODS = new Set([
  'getEncryptedUtxosByTags',
  'getShieldedTransactionsByTags',
  'getShieldedTransactionsBySignature',
  'getShieldedTransactionsByNullifiers',
  'getMerkleProofs',
  'getNonInclusionProofs',
  'getUserRecords',
])

/** The indexer URL for one method: the method is the last path segment, the query (an API key) kept. */
function photonMethodUrl(base: string, method: string): string {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${method}`
  return url.toString()
}

const launchMetaById = new Map(loadLaunchHooks().map((h) => [h.id, h]))

function dbHookToSummary(row: {
  id: string
  address: string
  protocol: string
  protocolName: string
  label: string
  description: string
  kind: string
  targetProgram: string
  instructionName: string
  mintIn: string | null
  mintOut: string | null
  mintInConstraint: unknown
  mintOutConstraint: unknown
  wrapSolIn: boolean
  unwrapSolOut: boolean
  assetInSymbol: string | null
  assetOutSymbol: string | null
  author: string
  immutable: boolean
  runsCount: number
  volumeIn: string
  volumeOut: string
  lastRunAt: Date | null
  publishedAt: Date
}, authorShareBps: number | null): HookSummary {
  return {
    id: row.id,
    address: row.address,
    protocol: row.protocol,
    protocolName: row.protocolName,
    label: row.label,
    description: row.description,
    kind: row.kind,
    targetProgram: row.targetProgram,
    instructionName: row.instructionName,
    mintIn: row.mintIn,
    mintOut: row.mintOut,
    mintInConstraint: row.mintInConstraint as HookSummary['mintInConstraint'],
    mintOutConstraint: row.mintOutConstraint as HookSummary['mintOutConstraint'],
    wrapSolIn: row.wrapSolIn,
    unwrapSolOut: row.unwrapSolOut,
    assetInSymbol: row.assetInSymbol,
    assetOutSymbol: row.assetOutSymbol,
    author: row.author,
    authorShareBps,
    immutable: row.immutable,
    sdkCall: `pook.run("${row.id}", { amount })`,
    stats: {
      runsCount: row.runsCount,
      volumeIn: row.volumeIn,
      volumeOut: row.volumeOut,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    },
    publishedAt: row.publishedAt.toISOString(),
  }
}

function dbHookToDetail(
  row: Parameters<typeof dbHookToSummary>[0] & {
    discriminator: string
    dataTemplate: unknown
    accountsTemplate: unknown
    companionInstructions: unknown
    dataTemplateHex: string
    dataSlots: unknown
    accountSlots: unknown
    companions: unknown
    formFields: unknown
    publishSignature: string
  },
  authorShareBps: number | null,
): HookDetail {
  const rawAccounts = Array.isArray(row.accountsTemplate) ? row.accountsTemplate : []
  const rawAccountSlots = Array.isArray(row.accountSlots) ? row.accountSlots : []
  const rawDataSlots = Array.isArray(row.dataSlots) ? row.dataSlots : []
  const rawFormFields = Array.isArray(row.formFields) ? row.formFields : []
  // Backfill readable derived templates/formFields for hooks indexed without off-chain metadata.
  const needsDerivation =
    (rawAccounts.length === 0 && rawAccountSlots.length > 0) ||
    (rawFormFields.length === 0 && (rawDataSlots.length > 0 || rawAccountSlots.length > 0))
  const derived = needsDerivation
    ? resolveHookDisplay({
        onChain: {
          hookId: row.id,
          kind: row.kind,
          targetProgram: row.targetProgram,
          mintIn: row.mintInConstraint as Parameters<typeof resolveHookDisplay>[0]['onChain']['mintIn'],
          mintOut: row.mintOutConstraint as Parameters<typeof resolveHookDisplay>[0]['onChain']['mintOut'],
          wrapSolIn: row.wrapSolIn,
          unwrapSolOut: row.unwrapSolOut,
          dataTemplateHex: row.dataTemplateHex,
          dataSlots: rawDataSlots as Parameters<typeof resolveHookDisplay>[0]['onChain']['dataSlots'],
          accountSlots: rawAccountSlots as Parameters<typeof resolveHookDisplay>[0]['onChain']['accountSlots'],
          companions: (Array.isArray(row.companions) ? row.companions : []) as Parameters<typeof resolveHookDisplay>[0]['onChain']['companions'],
          author: row.author,
        },
        launchMeta: launchMetaById.get(row.id) ?? null,
        draftMeta: {
          hookId: row.id,
          author: row.author,
          protocol: row.protocol,
          protocolName: row.protocolName,
          label: row.label,
          description: row.description,
          instructionName: row.instructionName,
          discriminator: row.discriminator,
          dataTemplate: row.dataTemplate,
          accountsTemplate: row.accountsTemplate,
          companionInstructions: row.companionInstructions,
          formFields: row.formFields,
          assetInSymbol: row.assetInSymbol,
          assetOutSymbol: row.assetOutSymbol,
        },
      })
    : null
  return {
    ...dbHookToSummary(row, authorShareBps),
    discriminator: row.discriminator,
    dataTemplate: derived ? derived.dataTemplate : (row.dataTemplate as HookDetail['dataTemplate']),
    accountsTemplate: derived ? derived.accountsTemplate : (row.accountsTemplate as HookDetail['accountsTemplate']),
    companionInstructions: derived ? derived.companionInstructions : (row.companionInstructions as HookDetail['companionInstructions']),
    dataTemplateHex: row.dataTemplateHex,
    dataSlots: row.dataSlots as HookDetail['dataSlots'],
    accountSlots: row.accountSlots as HookDetail['accountSlots'],
    companions: row.companions as HookDetail['companions'],
    formFields: derived ? derived.formFields : (row.formFields as HookDetail['formFields']),
    publishSignature: row.publishSignature,
  }
}

function dbRunToPublic(row: {
  signature: string
  slot: bigint
  hookId: string
  hookAddress: string
  protocol: string
  kind: string
  mintIn: string | null
  assetInSymbol: string | null
  amountIn: string
  mintOut: string | null
  assetOutSymbol: string | null
  amountOut: string
  runFeeAmount: string
  relayerFeeAmount: string
  stageAuthority: string
  relayer: string
  status: string
  blockTime: Date
}): PublicRun {
  return {
    signature: row.signature,
    slot: row.slot.toString(),
    hookId: row.hookId,
    hookAddress: row.hookAddress,
    protocol: row.protocol,
    kind: row.kind,
    mintIn: row.mintIn,
    assetInSymbol: row.assetInSymbol,
    amountIn: row.amountIn,
    mintOut: row.mintOut,
    assetOutSymbol: row.assetOutSymbol,
    amountOut: row.amountOut,
    runFeeAmount: row.runFeeAmount,
    relayerFeeAmount: row.relayerFeeAmount,
    stageAuthority: row.stageAuthority,
    relayer: row.relayer,
    status: row.status,
    timestamp: row.blockTime.toISOString(),
  }
}

function normalizeTxStage(stage: string): KnownErrorStage {
  if (stage === 'wallet-rejected') return 'wallet_rejected'
  if (stage === 'wallet-changed') return 'wallet'
  if (stage === 'confirm') return 'confirmation'
  if (
    stage === 'validation' ||
    stage === 'auth' ||
    stage === 'read' ||
    stage === 'upload' ||
    stage === 'build' ||
    stage === 'wallet' ||
    stage === 'wallet_rejected' ||
    stage === 'co_sign' ||
    stage === 'simulation' ||
    stage === 'proving' ||
    stage === 'relay' ||
    stage === 'send' ||
    stage === 'confirmation' ||
    stage === 'expired'
  ) {
    return stage
  }
  return 'send'
}

function mapTxError(error: unknown): never {
  if (error instanceof TxError) {
    const code =
      error.stage === 'simulation'
        ? 'SIMULATION_FAILED'
        : error.stage === 'wallet-changed'
          ? 'VALIDATION_ERROR'
          : error.program?.code != null
            ? 'CHAIN_REFUSED'
            : 'UPSTREAM_UNAVAILABLE'
    const stage = normalizeTxStage(error.stage)
    return fail(code, error.message, {
      stage,
      retryable: error.retryable,
      ...(error.program
        ? {
            programError: {
              programId: error.program.address,
              name: error.program.name ?? 'UnknownProgramError',
              number: error.program.code ?? 0,
            },
          }
        : {}),
    })
  }
  throw error
}

async function fetchRelayerIdentity(): Promise<string> {
  try {
    const resp = await fetch(`${env.RELAYER_URL.replace(/\/$/, '')}/v1/relayer/quote?kind=run&mint=${WSOL_MINT}`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (resp.ok) {
      const json = (await resp.json()) as { relayer?: string }
      if (json.relayer) return json.relayer
    }
  } catch {
    // fallback if relayer is unreachable during quote preview
  }
  return SystemProgram.programId.toBase58()
}

async function proxyUpstream(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) })
  } catch {
    return fail('UPSTREAM_UNAVAILABLE', 'Upstream service could not be reached. Retry.', { stage: 'relay', retryable: true })
  }
}

export function registerChainRoutes(
  app: Hono<{ Variables: FixtureVariables<Scenario> & ApiVariables }>,
  deps: ChainAppDeps,
) {
  const { db, rpc, readiness, hub } = deps
  const programId = env.POOK_PROGRAM_ID ? new PublicKey(env.POOK_PROGRAM_ID) : null
  const ringsProgramId = new PublicKey(env.RINGS_PROGRAM_ID)
  const stateTree = new PublicKey(env.RINGS_STATE_TREE)
  const configCache = programId ? new ConfigCache(rpc.connection, programId) : null
  const errorRegistry = programId ? pookErrorRegistry(programId.toBase58()) : new Map()
  const txStore = new PrismaWalletTxStore(db)

  const ensureReady = (): PublicKey => {
    if (!programId || readiness.status() !== 'ready') {
      return fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true })
    }
    return programId
  }

  const ledgerDeps = (pid: PublicKey): LedgerDeps => ({
    connection: rpc.connection,
    store: txStore,
    action: () => ({
      requiredProgram: pid,
      allowedPrograms: [pid, ComputeBudgetProgram.programId, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, SystemProgram.programId, ringsProgramId],
    }),
    registry: errorRegistry,
  })

  // --- Health, Config, Stats ---

  app.get('/health', (c) =>
    c.json({
      status: readiness.status(),
      programId: env.POOK_PROGRAM_ID ?? null,
      cluster: env.CLUSTER,
      contractVersion: CONTRACT_VERSION,
      asOf: new Date().toISOString(),
    }),
  )

  app.get('/v1/config', async (c) => {
    const status = readiness.status()
    const now = new Date().toISOString()
    const onChainConfig = status === 'ready' && configCache ? await configCache.read().catch(() => null) : null
    const dbConfig = await db.protocolConfig.findUnique({ where: { id: 'singleton' } }).catch(() => null)
    const authorityPda = programId ? findAuthorityPda(programId)[0].toBase58() : null
    const stagePda = programId ? findStagePda(programId)[0].toBase58() : null
    const configPda = programId ? findConfigPda(programId)[0].toBase58() : null

    return c.json({
      status,
      cluster: env.CLUSTER,
      programId: env.POOK_PROGRAM_ID ?? null,
      authorityPda,
      stagePda,
      configPda,
      ringsProgramId: env.RINGS_PROGRAM_ID,
      stateTree: env.RINGS_STATE_TREE,
      runFeeBps: onChainConfig?.runFeeBps ?? dbConfig?.runFeeBps ?? env.RUN_FEE_BPS ?? null,
      authorShareBps: onChainConfig?.authorShareBps ?? dbConfig?.authorShareBps ?? env.AUTHOR_SHARE_BPS ?? null,
      feeRecipient: onChainConfig?.feeRecipient ?? dbConfig?.feeRecipient ?? env.FEE_RECIPIENT ?? null,
      pookMint: env.POOK_MINT ?? null,
      relayerUrl: env.RELAYER_URL,
      proverUrl: env.PROVER_URL,
      photonRelayUrl: '/v1/photon',
      supportedAssets: SUPPORTED_ASSETS,
      asOf: now,
    })
  })

  app.get('/v1/stats', async (c) => {
    const status = readiness.status()
    const now = new Date().toISOString()
    if (status === 'waiting') {
      return c.json({ status: 'waiting', hooksCount: 0, runsCount: 0, activeSeatsCount: 0, volumeByAsset: [], asOf: now })
    }
    const [hooksCount, runsCount, activeSeatsCount, runs] = await Promise.all([
      db.hook.count(),
      db.hookRun.count(),
      db.seat.count({ where: { status: 'open' } }),
      db.hookRun.findMany({ select: { mintIn: true, amountIn: true } }),
    ])
    const totals = new Map<string, bigint>()
    for (const r of runs) {
      if (!r.mintIn) continue
      totals.set(r.mintIn, (totals.get(r.mintIn) ?? 0n) + BigInt(r.amountIn))
    }
    const volumeByAsset = [...totals.entries()].map(([mint, vol]) => {
      const meta = assetMeta(mint)
      return {
        mint,
        symbol: meta?.symbol ?? mint.slice(0, 6),
        decimals: meta?.decimals ?? 6,
        volume: vol.toString(),
      }
    })
    return c.json({ status: 'ready', hooksCount, runsCount, activeSeatsCount, volumeByAsset, asOf: now })
  })

  // --- Hooks & Quotes ---

  app.get('/v1/hooks', async (c) => {
    const status = readiness.status()
    const query = readQuery(c, HooksQuery)
    const now = new Date().toISOString()
    if (status === 'waiting') {
      return c.json({ status: 'waiting', ...paginate([], query, now) })
    }
    const onChainConfig = configCache ? await configCache.read().catch(() => null) : null
    const rows = await db.hook.findMany({
      where: {
        ...(query.protocol ? { protocol: { equals: query.protocol, mode: 'insensitive' } } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.q
          ? {
              OR: [
                { id: { contains: query.q, mode: 'insensitive' } },
                { protocolName: { contains: query.q, mode: 'insensitive' } },
                { label: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ runsCount: 'desc' }, { publishedAt: 'desc' }],
    })
    const items = rows.map((r) => dbHookToSummary(r, onChainConfig?.authorShareBps ?? env.AUTHOR_SHARE_BPS ?? null))
    return c.json({ status: 'ready', ...paginate(items, query, now) })
  })

  app.get('/v1/hooks/:id', async (c) => {
    const pid = ensureReady()
    const id = readParam(c, 'id', HookId)
    const onChainConfig = configCache ? await configCache.read().catch(() => null) : null
    const row = await db.hook.findUnique({ where: { id } })
    if (row) {
      const recent = await db.hookRun.findMany({ where: { hookId: id }, orderBy: { blockTime: 'desc' }, take: 10 })
      return c.json({
        hook: dbHookToDetail(row, onChainConfig?.authorShareBps ?? env.AUTHOR_SHARE_BPS ?? null),
        recentRuns: recent.map(dbRunToPublic),
        asOf: new Date().toISOString(),
      })
    }
    // Fall back to direct on-chain account read if indexer hasn't caught up yet.
    const [onChain, draftMeta] = await Promise.all([
      readHookAccount(rpc.connection, pid, id),
      db.hookDraftMetadata.findUnique({ where: { hookId: id } }).catch(() => null),
    ])
    if (!onChain) return fail('NOT_FOUND', `Hook "${id}" was not found.`, { stage: 'read' })
    const detail = buildOnChainHookDetail({
      address: onChain.address.toBase58(),
      onChain: onChain.account,
      launchMeta: launchMetaById.get(id) ?? null,
      draftMeta,
      authorShareBps: onChainConfig?.authorShareBps ?? env.AUTHOR_SHARE_BPS ?? null,
    })
    return c.json({ hook: detail, recentRuns: [], asOf: new Date().toISOString() })
  })

  app.post('/v1/hooks/:id/quote', async (c) => {
    const pid = ensureReady()
    const id = readParam(c, 'id', HookId)
    const body = await readJson(c, QuoteRequest)
    const onChain = await readHookAccount(rpc.connection, pid, id)
    if (!onChain) return fail('NOT_FOUND', `Hook "${id}" is not published on chain.`, { stage: 'build' })
    const [config, dbRow, draftMeta, relayerPubkey] = await Promise.all([
      configCache!.read(),
      db.hook.findUnique({ where: { id } }).catch(() => null),
      db.hookDraftMetadata.findUnique({ where: { hookId: id } }).catch(() => null),
      fetchRelayerIdentity(),
    ])
    const hookDetail: HookDetail = dbRow
      ? dbHookToDetail(dbRow, config?.authorShareBps ?? null)
      : buildOnChainHookDetail({
          address: onChain.address.toBase58(),
          onChain: onChain.account,
          launchMeta: launchMetaById.get(id) ?? null,
          draftMeta,
          authorShareBps: config?.authorShareBps ?? null,
        })

    const quote = await resolveHookQuote({
      connection: rpc.connection,
      programId: pid,
      hook: hookDetail,
      onChainHook: onChain.account,
      config,
      relayerPubkey,
      request: body,
    })
    return c.json(quote)
  })

  // --- Runs & SSE ---

  app.get('/v1/runs', async (c) => {
    const status = readiness.status()
    const query = readQuery(c, RunsQuery)
    const now = new Date().toISOString()
    if (status === 'waiting') {
      return c.json({ status: 'waiting', ...paginate([], query, now) })
    }
    const rows = await db.hookRun.findMany({
      where: {
        ...(query.hookId ? { hookId: query.hookId } : {}),
        ...(query.protocol ? { protocol: { equals: query.protocol, mode: 'insensitive' } } : {}),
      },
      orderBy: { blockTime: 'desc' },
      take: 500,
    })
    return c.json({ status: 'ready', ...paginate(rows.map(dbRunToPublic), query, now) })
  })

  app.get('/v1/runs/stream', (c) => {
    const hookId = c.req.query('hookId')
    return streamEvents(c, {
      hub,
      filter: (event) => {
        if (!hookId || event.type !== 'run') return true
        const data = event.data as PublicRun | undefined
        return data?.hookId === hookId
      },
      ready: () => ({ status: readiness.status() }),
    })
  })

  // --- Notes, Nullifiers, Photon Relay, Seats, Public Wallet Balance ---

  app.get('/v1/notes', (c) => {
    const query = readQuery(c, NotesQuery)
    // In chain mode, @pook/sdk reads compressed notes directly through /v1/photon/:method.
    return c.json(paginate([], query))
  })

  app.post('/v1/notes/nullifiers', async (c) => {
    const body = await readJson(c, NullifiersCheckRequest)
    const spent: Record<string, boolean> = {}
    for (const nf of body.nullifiers) spent[nf] = false
    return c.json({ spent, asOf: new Date().toISOString() })
  })

  app.post('/v1/photon/:method', async (c) => {
    const method = c.req.param('method')
    if (!PHOTON_ALLOWED_METHODS.has(method)) {
      return fail('VALIDATION_ERROR', `Photon RPC method "${method}" is not allowed.`, { stage: 'read' })
    }
    const bodyText = await c.req.text()
    let params: unknown = {}
    let id: unknown = 1
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as { params?: unknown; id?: unknown }) : {}
      params = parsed.params !== undefined ? parsed.params : parsed
      if (typeof parsed.id === 'string' || typeof parsed.id === 'number') id = parsed.id
    } catch {
      return fail('VALIDATION_ERROR', 'Photon request body must be valid JSON.', { stage: 'read' })
    }
    const upstream = await proxyUpstream(photonMethodUrl(env.PHOTON_URL, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  })

  app.post('/v1/seats/state', async (c) => {
    ensureReady()
    const body = await readJson(c, SeatsStateRequest)
    const rows = body.seatAddresses.length
      ? await db.seat.findMany({ where: { address: { in: body.seatAddresses } } })
      : []
    const seats = await resolveSeatPositions(rpc.connection, rows, body.seatAddresses)
    return c.json({ seats, asOf: new Date().toISOString() })
  })

  app.get('/v1/wallets/:wallet/balance', async (c) => {
    const wallet = new PublicKey(readParam(c, 'wallet', Address))
    const query = readQuery(c, PublicBalanceQuery)
    const mint = query.mint ?? WSOL_MINT
    const balance = await readPublicWalletBalance(rpc.connection, wallet, mint)
    return c.json({
      wallet: wallet.toBase58(),
      ...balance,
      asOf: new Date().toISOString(),
    })
  })

  // --- Wallet-Signed Transaction Builders (Enter, Publish Hook, Claim Author Fees) ---

  app.post('/v1/enter/build', async (c) => {
    const pid = ensureReady()
    const body = await readJson(c, EnterBuildRequest)
    const walletPk = new PublicKey(body.wallet)
    const [, authorityBump] = findAuthorityPda(pid)

    let ix: TransactionInstruction
    if (body.source === 'rings') {
      if (!body.transactDataBase64 || !body.transactAccounts?.length) {
        return fail('VALIDATION_ERROR', 'Rings source enter requires transactDataBase64 and transactAccounts.', { stage: 'build' })
      }
      const data = encodeEnterPrivateIxData(authorityBump, fromBase64(body.transactDataBase64))
      // process_enter_private takes verbatim SPP transact accounts ([payer, outputTree, sppProgram, ...]).
      ix = new TransactionInstruction({
        programId: pid,
        keys: body.transactAccounts.map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        })),
        data: Buffer.from(data),
      })
    } else {
      const ownerHashBytes = fromHex(body.outputOwnerHash)
      if (ownerHashBytes.length !== 32) {
        return fail('VALIDATION_ERROR', 'outputOwnerHash must be a 32-byte hex string.', { stage: 'build' })
      }
      const amount = BigInt(body.amount)
      if (isNativeSolMint(body.mint)) {
        const [solIf] = findSppSolInterfacePda(ringsProgramId)
        const data = encodeEnterPublicIxData({
          kind: { type: 'sol' },
          authorityBump,
          ownerHash: ownerHashBytes,
          amount,
        })
        ix = new TransactionInstruction({
          programId: pid,
          keys: [
            { pubkey: walletPk, isSigner: true, isWritable: true },
            { pubkey: stateTree, isSigner: false, isWritable: true },
            { pubkey: ringsProgramId, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: solIf, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(data),
        })
      } else {
        const mintPk = new PublicKey(body.mint)
        const tokenProgram = await detectTokenProgram(rpc.connection, mintPk)
        const [userAta] = findAta(walletPk, mintPk, tokenProgram)
        const [splIf, splIfBump] = findSppSplInterfacePda(ringsProgramId, mintPk)
        const data = encodeEnterPublicIxData({
          kind: { type: 'spl', splInterfaceBump: splIfBump },
          authorityBump,
          ownerHash: ownerHashBytes,
          amount,
        })
        ix = new TransactionInstruction({
          programId: pid,
          keys: [
            { pubkey: walletPk, isSigner: true, isWritable: true },
            { pubkey: stateTree, isSigner: false, isWritable: true },
            { pubkey: ringsProgramId, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: mintPk, isSigner: false, isWritable: false },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: splIf, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(data),
        })
      }
    }

    try {
      const instructions =
        body.source === 'rings' ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix] : [ix]
      const built = await buildUnsignedV0({
        connection: rpc.connection,
        payer: walletPk,
        instructions,
        registry: errorRegistry,
      })
      const fee = await networkFee(rpc.connection, built).catch(() => ({ total: 5_000n, base: 5_000n, priority: 0n }))
      const buildId = `build_enter_${randomUUID().slice(0, 12)}`
      const expiresAt = new Date(Date.now() + 60_000)
      await txStore.createBuild({
        id: buildId,
        action: 'enter',
        wallet: body.wallet,
        transactionBase64: built.transactionBase64,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        contextSlot: built.contextSlot,
        expiresAt,
      })
      return c.json({
        buildId,
        action: 'enter',
        transactionBase64: built.transactionBase64,
        blockhash: built.blockhash,
        lastValidBlockHeight: String(built.lastValidBlockHeight),
        networkFeeLamports: fee.total.toString(),
        expiresAt: expiresAt.toISOString(),
      })
    } catch (error) {
      return mapTxError(error)
    }
  })

  app.post('/v1/hooks/publish/build', async (c) => {
    const pid = ensureReady()
    const body = await readJson(c, PublishHookBuildRequest)
    const authorPk = new PublicKey(body.author)
    const [hookPda] = findHookPda(pid, body.hook.id)
    const existing = await rpc.connection.getAccountInfo(hookPda, 'confirmed')
    if (existing) {
      return fail('HOOK_ALREADY_EXISTS', `Hook "${body.hook.id}" is already published on chain.`, { stage: 'build' })
    }
    const onChainArgs = hookDraftToOnChain(body.hook)
    const data = encodePublishHookIxData(onChainArgs)
    const ix = new TransactionInstruction({
      programId: pid,
      keys: [
        { pubkey: authorPk, isSigner: true, isWritable: true },
        { pubkey: hookPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    })

    try {
      const built = await buildUnsignedV0({
        connection: rpc.connection,
        payer: authorPk,
        instructions: [ix],
        registry: errorRegistry,
      })
      const fee = await networkFee(rpc.connection, built).catch(() => ({ total: 5_000n, base: 5_000n, priority: 0n }))
      const buildId = `build_publish_${randomUUID().slice(0, 12)}`
      const expiresAt = new Date(Date.now() + 60_000)
      await txStore.createBuild({
        id: buildId,
        action: 'publish_hook',
        wallet: body.author,
        transactionBase64: built.transactionBase64,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        contextSlot: built.contextSlot,
        expiresAt,
      })
      // Persist off-chain display metadata once per hook id (on-chain account remains truth for all on-chain fields).
      await db.hookDraftMetadata
        .upsert({
          where: { hookId: body.hook.id },
          create: {
            hookId: body.hook.id,
            author: body.author,
            protocol: body.hook.protocol,
            protocolName: body.hook.protocolName,
            label: body.hook.label,
            description: body.hook.description,
            instructionName: body.hook.instructionName,
            discriminator: body.hook.discriminator,
            dataTemplate: body.hook.dataTemplate as Prisma.InputJsonValue,
            accountsTemplate: body.hook.accountsTemplate as Prisma.InputJsonValue,
            companionInstructions: (body.hook.companionInstructions ?? []) as Prisma.InputJsonValue,
            formFields: (body.hook.formFields ?? []) as Prisma.InputJsonValue,
            assetInSymbol: body.hook.assetInSymbol ?? null,
            assetOutSymbol: body.hook.assetOutSymbol ?? null,
          },
          update: {},
        })
        .catch(() => {})
      return c.json({
        buildId,
        action: 'publish_hook',
        transactionBase64: built.transactionBase64,
        blockhash: built.blockhash,
        lastValidBlockHeight: String(built.lastValidBlockHeight),
        networkFeeLamports: fee.total.toString(),
        expiresAt: expiresAt.toISOString(),
      })
    } catch (error) {
      return mapTxError(error)
    }
  })

  app.get('/v1/authors/:wallet/fees', async (c) => {
    const pid = ensureReady()
    const wallet = readParam(c, 'wallet', Address)
    const authorPk = new PublicKey(wallet)
    const rows = await db.authorFeeLedger.findMany({ where: { author: wallet } })
    const hooks: AuthorHookFee[] = []
    for (const r of rows) {
      const live = await readAuthorFeesAccount(rpc.connection, pid, authorPk, isNativeSolMint(r.mint) ? null : r.mint).catch(() => null)
      hooks.push({
        hookId: r.hookId,
        hookAddress: r.hookAddress,
        mint: r.mint,
        assetSymbol: r.assetSymbol,
        decimals: r.decimals,
        claimableAmount: live ? live.account.accrued.toString() : r.claimableAmount,
        totalEarnedAmount: r.totalEarnedAmount,
        lastClaimedAt: r.lastClaimedAt ? r.lastClaimedAt.toISOString() : null,
      })
    }
    return c.json({ author: wallet, hooks, asOf: new Date().toISOString() })
  })

  app.post('/v1/authors/:wallet/claim/build', async (c) => {
    const pid = ensureReady()
    const wallet = readParam(c, 'wallet', Address)
    const authorPk = new PublicKey(wallet)
    const body = await readJson(c, ClaimAuthorFeesBuildRequest)

    // Determine mints to claim (explicit mint or all claimable ledger rows for the requested hooks)
    const mints = new Set<string>()
    if (body.mint) {
      mints.add(body.mint)
    } else {
      const ledgers = await db.authorFeeLedger.findMany({
        where: { author: wallet, hookId: { in: body.hookIds } },
      })
      const candidateMints = new Set(ledgers.map((l) => l.mint))
      for (const m of candidateMints) {
        const live = await readAuthorFeesAccount(rpc.connection, pid, authorPk, isNativeSolMint(m) ? null : m).catch(() => null)
        if (live && live.account.accrued > 0n) mints.add(m)
      }
      if (!mints.size) mints.add(WSOL_MINT)
    }

    const instructions: TransactionInstruction[] = []
    for (const mint of mints) {
      if (isNativeSolMint(mint)) {
        const [afPda] = findAuthorFeesPda(pid, authorPk, null)
        instructions.push(
          new TransactionInstruction({
            programId: pid,
            keys: [
              { pubkey: authorPk, isSigner: true, isWritable: true },
              { pubkey: afPda, isSigner: false, isWritable: true },
            ],
            data: Buffer.from(encodeClaimAuthorFeesIxData(null)),
          }),
        )
      } else {
        const mintPk = new PublicKey(mint)
        const tokenProgram = await detectTokenProgram(rpc.connection, mintPk)
        const [afPda] = findAuthorFeesPda(pid, authorPk, mint)
        const [afAta] = findAta(afPda, mintPk, tokenProgram)
        const [destAta] = findAta(authorPk, mintPk, tokenProgram)
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(authorPk, destAta, authorPk, mintPk, tokenProgram))
        instructions.push(
          new TransactionInstruction({
            programId: pid,
            keys: [
              { pubkey: authorPk, isSigner: true, isWritable: true },
              { pubkey: afPda, isSigner: false, isWritable: true },
              { pubkey: tokenProgram, isSigner: false, isWritable: false },
              { pubkey: mintPk, isSigner: false, isWritable: false },
              { pubkey: afAta, isSigner: false, isWritable: true },
              { pubkey: destAta, isSigner: false, isWritable: true },
            ],
            data: Buffer.from(encodeClaimAuthorFeesIxData(mint)),
          }),
        )
      }
    }

    try {
      const built = await buildUnsignedV0({
        connection: rpc.connection,
        payer: authorPk,
        instructions,
        registry: errorRegistry,
      })
      const fee = await networkFee(rpc.connection, built).catch(() => ({ total: 5_000n, base: 5_000n, priority: 0n }))
      const buildId = `build_claim_${randomUUID().slice(0, 12)}`
      const expiresAt = new Date(Date.now() + 60_000)
      await txStore.createBuild({
        id: buildId,
        action: 'claim_author_fees',
        wallet,
        transactionBase64: built.transactionBase64,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        contextSlot: built.contextSlot,
        expiresAt,
      })
      return c.json({
        buildId,
        action: 'claim_author_fees',
        transactionBase64: built.transactionBase64,
        blockhash: built.blockhash,
        lastValidBlockHeight: String(built.lastValidBlockHeight),
        networkFeeLamports: fee.total.toString(),
        expiresAt: expiresAt.toISOString(),
      })
    } catch (error) {
      return mapTxError(error)
    }
  })

  // --- Wallet Tx Submit & Status ---

  app.post('/v1/tx/submit', async (c) => {
    const pid = ensureReady()
    const body = await readJson(c, TxSubmitRequest)
    const existing = await txStore.get(body.buildId)
    if (!existing) {
      return fail('NOT_FOUND', `Transaction build "${body.buildId}" was not found.`, { stage: 'build', retryable: false })
    }
    try {
      const result = await submit(
        ledgerDeps(pid),
        body.signedTransactionBase64
          ? { buildId: body.buildId, mode: 'relay', signedTransactionBase64: body.signedTransactionBase64, idempotencyKey: body.buildId }
          : { buildId: body.buildId, mode: 'wallet-sent', signature: body.signature!, idempotencyKey: body.buildId },
      )
      const row = await txStore.getByIdOrSignature(result.id)
      const resp: TxStatusResponse = {
        id: result.id,
        action: row?.action,
        status: result.status,
        signature: result.signature ?? null,
        slot: null,
        updatedAt: new Date().toISOString(),
      }
      return c.json(resp)
    } catch (error) {
      return mapTxError(error)
    }
  })

  app.get('/v1/tx/:id', async (c) => {
    const pid = ensureReady()
    const id = c.req.param('id')
    const existing = await txStore.getByIdOrSignature(id)
    if (!existing) {
      return fail('NOT_FOUND', `Transaction "${id}" was not found.`, { stage: 'read', retryable: false })
    }
    try {
      const result = await refresh(ledgerDeps(pid), existing.id)
      const row = await txStore.getByIdOrSignature(existing.id)
      const resp: TxStatusResponse = {
        id: result.id,
        action: row?.action,
        status: result.status,
        signature: result.signature ?? null,
        slot: null,
        ...(result.error
          ? {
              error: {
                code:
                  result.status === 'expired'
                    ? 'TRANSACTION_EXPIRED'
                    : result.error.stage === 'simulation'
                      ? 'SIMULATION_FAILED'
                      : 'CHAIN_REFUSED',
                message: result.error.message,
                stage: normalizeTxStage(result.error.stage),
                retryable: result.error.retryable,
                ...(result.error.program
                  ? {
                      programError: {
                        programId: result.error.program.address,
                        name: result.error.program.name ?? 'UnknownProgramError',
                        number: result.error.program.code ?? 0,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        updatedAt: new Date().toISOString(),
      }
      return c.json(resp)
    } catch (error) {
      return mapTxError(error)
    }
  })

  // --- Publish Studio Helpers: Parse IDL & Simulate Target Instruction ---

  app.post('/v1/hooks/parse-idl', async (c) => {
    const body = await readJson(c, ParseIdlRequest)
    if (body.idlJson) {
      return c.json(parseAnchorIdlJson(body.idlJson, body.programId ?? null))
    }
    return c.json(await fetchOnChainAnchorIdl(rpc.connection, body.programId!))
  })

  app.post('/v1/hooks/simulate', async (c) => {
    const pid = ensureReady()
    const body = await readJson(c, SimulateHookRequest)
    const onChainArgs = hookDraftToOnChain(body.hook)
    const [stagePda] = findStagePda(pid)
    const sampleAmount = BigInt(body.sampleAmountIn)
    const callerData = body.sampleArgs?.callerDataHex ? fromHex(body.sampleArgs.callerDataHex) : new Uint8Array(0)
    const cpiData = resolveCpiData(onChainArgs.dataTemplateHex, onChainArgs.dataSlots, sampleAmount, 0n, callerData)

    // Stage-in and stage-out are the stage's token accounts for the hook's mints, as in a run (the stage
    // PDA itself only for native SOL that isn't wrapped); they are created first, so the target sees them.
    // A mint left as Any takes the sample mint named for it.
    const stageToken = (c: (typeof onChainArgs)['mintIn'], wrapped: boolean, sample: string | undefined): PublicKey | null => {
      const mint = c.kind === 'Spl' ? c.mint : c.kind === 'Sol' ? WSOL_MINT : c.kind === 'Any' ? sample : undefined
      if (!mint) return null
      if (isNativeSolMint(mint) && !wrapped) return null
      return new PublicKey(isNativeSolMint(mint) ? WSOL_MINT : mint)
    }
    const stageMints = {
      StageIn: stageToken(onChainArgs.mintIn, onChainArgs.wrapSolIn, body.sampleMintIn),
      StageOut: stageToken(onChainArgs.mintOut, onChainArgs.unwrapSolOut, body.sampleMintOut),
    }
    // The relayer pays for runs, so it pays for the simulation too (the stage keeps only a rent reserve).
    const relayer = await fetchRelayerIdentity()
    const payer = relayer === SystemProgram.programId.toBase58() ? stagePda : new PublicKey(relayer)
    const setupIxs: TransactionInstruction[] = []
    const stageAtas: Partial<Record<'StageIn' | 'StageOut', PublicKey>> = {}
    for (const kind of ['StageIn', 'StageOut'] as const) {
      const mint = stageMints[kind]
      if (!mint) continue
      const tokenProgram = await detectTokenProgram(rpc.connection, mint)
      const [ata] = findAta(stagePda, mint, tokenProgram)
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, stagePda, mint, tokenProgram))
      stageAtas[kind] = ata
    }
    // Funding: the sample input moves into the stage the way a run's withdrawal leg would put it there.
    const stageInAta = stageAtas.StageIn
    if (stageInAta && body.sampleFundFrom) {
      const source = new PublicKey(body.sampleFundFrom)
      const sourceInfo = await rpc.connection.getAccountInfo(source, 'confirmed')
      if (!sourceInfo || sourceInfo.data.length < 72) {
        return fail('VALIDATION_ERROR', 'sampleFundFrom is not a token account.', { stage: 'validation', retryable: false })
      }
      const owner = new PublicKey(sourceInfo.data.subarray(32, 64))
      const mint = stageMints.StageIn!
      const decimals = (await rpc.connection.getParsedAccountInfo(mint, 'confirmed')).value?.data
      const mintDecimals = decimals && 'parsed' in decimals ? Number(decimals.parsed.info.decimals) : 0
      setupIxs.push(createTransferCheckedInstruction(source, mint, stageInAta, owner, sampleAmount, mintDecimals, [], sourceInfo.owner))
    } else if (stageInAta && stageMints.StageIn?.toBase58() === WSOL_MINT && !payer.equals(stagePda)) {
      setupIxs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: stageInAta, lamports: sampleAmount }), createSyncNativeInstruction(stageInAta))
    }
    const stageAccount = (kind: 'StageIn' | 'StageOut'): PublicKey => stageAtas[kind] ?? stagePda

    const keys = onChainArgs.accountSlots
      .filter((s) => s.kind !== 'CallerRemaining')
      .map((slot, idx) => {
        const slotName = body.hook.accountsTemplate[idx]?.name ?? `slot_${idx}`
        const pubkeyStr =
          slot.kind === 'StageIn' || slot.kind === 'StageOut'
            ? stageAccount(slot.kind).toBase58()
            : slot.kind === 'StagePda' || slot.kind === 'SeatPda' || slot.kind === 'Payer'
            ? stagePda.toBase58()
            : slot.kind === 'Fixed'
              ? slot.pubkey
              : (body.sampleArgs?.[slotName] ?? slot.pubkey)
        return {
          pubkey: new PublicKey(pubkeyStr),
          isWritable: slot.isWritable,
          isSigner: slot.isSigner,
        }
      })

    const targetIx = new TransactionInstruction({
      programId: new PublicKey(onChainArgs.targetProgram),
      keys,
      data: Buffer.from(cpiData),
    })

    const latest = await rpc.connection.getLatestBlockhash('confirmed')
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: latest.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...setupIxs, targetIx],
      }).compileToV0Message(),
    )
    const wireBytes = tx.serialize().length
    const stageOut = stageAtas.StageOut
    const sim = await rpc.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      ...(stageOut ? { accounts: { encoding: 'base64' as const, addresses: [stageOut.toBase58()] } } : {}),
    })
    const logs = sim.value.logs ?? []
    const computeUnits = sim.value.unitsConsumed ?? null
    const stageOutData = sim.value.accounts?.[0]?.data?.[0]
    const stageOutAmount = stageOutData ? Buffer.from(stageOutData, 'base64').readBigUInt64LE(64).toString() : undefined

    if (sim.value.err) {
      return c.json({
        passed: false,
        computeUnits,
        logs,
        estimatedTxBytes: wireBytes,
        accountCount: keys.length,
        error: {
          code: 'SIMULATION_FAILED',
          message: 'Target program instruction simulation failed.',
          stage: 'simulation',
          retryable: false,
        },
      })
    }
    return c.json({
      passed: true,
      computeUnits,
      logs,
      estimatedTxBytes: wireBytes,
      accountCount: keys.length,
      ...(stageOutAmount !== undefined ? { stageOutAmount } : {}),
    })
  })

  // --- Prover & Relayer Single-Origin Proxies ---

  const proverBase = env.PROVER_URL.replace(/\/$/, '')
  const relayerBase = env.RELAYER_URL.replace(/\/$/, '')

  app.all('/v1/prover/*', async (c) => {
    const url = new URL(c.req.url)
    const target = `${proverBase}${url.pathname}${url.search}`
    const method = c.req.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer()
    const upstream = await proxyUpstream(target, {
      method,
      headers: Object.fromEntries(
        PROVER_FORWARD_HEADERS.flatMap((h) => (c.req.header(h) ? [[h, c.req.header(h)!]] : [])),
      ),
      body,
    })
    const headers = new Headers()
    for (const h of ['content-type', 'x-artifact-sha256', 'cache-control', 'etag', 'spr-tee', 'spr-tee-enc', 'spr-tee-ciphertext']) {
      const val = upstream.headers.get(h)
      if (val) headers.set(h, val)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  })

  app.all('/v1/relayer/*', async (c) => {
    const url = new URL(c.req.url)
    const target = `${relayerBase}${url.pathname}${url.search}`
    const method = c.req.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer()
    const upstream = await proxyUpstream(target, {
      method,
      headers: {
        ...(c.req.header('content-type') ? { 'content-type': c.req.header('content-type')! } : {}),
      },
      body,
    })
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  })
}
