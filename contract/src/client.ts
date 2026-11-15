import type { z } from 'zod'
import { createHttp, type CallOptions, type HttpOptions } from './http.js'
import {
  AuthorFeesResponse,
  ClaimAuthorFeesBuildRequest,
  ConfigResponse,
  EncryptedNotesPage,
  EnterBuildRequest,
  HealthResponse,
  HookDetailResponse,
  HooksPage,
  HooksQuery,
  NotesQuery,
  NullifiersCheckRequest,
  NullifiersCheckResponse,
  ParseIdlRequest,
  ParsedIdlResponse,
  ProverCircuitsResponse,
  PublicBalanceQuery,
  PublicBalanceResponse,
  PublishHookBuildRequest,
  QuoteRequest,
  QuoteResponse,
  RelayLeaveRequest,
  RelayRunRequest,
  RelaySeatRequest,
  RelaySubmissionResponse,
  RelayerQuoteQuery,
  RelayerQuoteResponse,
  RunsPage,
  RunsQuery,
  SeatsStateRequest,
  SeatsStateResponse,
  SimulateHookRequest,
  SimulateHookResponse,
  StatsResponse,
  TxBuildResponse,
  TxStatusResponse,
  TxSubmitRequest,
  errors,
} from './schemas.js'

export type ClientOptions = Omit<HttpOptions, 'apiError'>

export function createClient(baseUrl: string, options: ClientOptions = {}) {
  const http = createHttp(baseUrl, { ...options, apiError: errors.ApiError })

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),

    // Health, config, stats
    health: (call?: CallOptions) => http.get('/health', HealthResponse, call),
    config: (call?: CallOptions) => http.get('/v1/config', ConfigResponse, call),
    stats: (call?: CallOptions) => http.get('/v1/stats', StatsResponse, call),

    // Hooks registry
    hooks: (query: z.input<typeof HooksQuery> = {}, call?: CallOptions) => http.get('/v1/hooks', HooksPage, { ...call, query }),
    hook: (id: string, call?: CallOptions) => http.get(`/v1/hooks/${encodeURIComponent(id)}`, HookDetailResponse, call),
    quote: (hookId: string, body: QuoteRequest, call?: CallOptions) =>
      http.post(`/v1/hooks/${encodeURIComponent(hookId)}/quote`, QuoteResponse, body, call),

    // Public runs feed + SSE
    runs: (query: z.input<typeof RunsQuery> = {}, call?: CallOptions) => http.get('/v1/runs', RunsPage, { ...call, query }),
    runsStreamUrl: (query: { hookId?: string; fixture?: string; session?: string } = {}) => http.streamUrl('/v1/runs/stream', query),

    // Public wallet balance (beside Enter)
    publicBalance: (wallet: string, query: PublicBalanceQuery = {}, call?: CallOptions) =>
      http.get(`/v1/wallets/${encodeURIComponent(wallet)}/balance`, PublicBalanceResponse, { ...call, query }),

    // Private notes & seats sync (encrypted blobs; browser decrypts locally)
    notes: (query: z.input<typeof NotesQuery> = {}, call?: CallOptions) => http.get('/v1/notes', EncryptedNotesPage, { ...call, query }),
    checkNullifiers: (body: NullifiersCheckRequest, call?: CallOptions) => http.post('/v1/notes/nullifiers', NullifiersCheckResponse, body, call),
    seatsState: (body: SeatsStateRequest, call?: CallOptions) => http.post('/v1/seats/state', SeatsStateResponse, body, call),
    photonUrl: (method?: string) => http.url(method ? `/v1/photon/${encodeURIComponent(method)}` : '/v1/photon').toString(),
    rpcUrl: () => http.url('/v1/rpc').toString(),

    // Enter & wallet-signed transactions
    buildEnter: (body: EnterBuildRequest, call?: CallOptions) => http.post('/v1/enter/build', TxBuildResponse, body, call),
    submitTx: (body: TxSubmitRequest, call?: CallOptions) => http.post('/v1/tx/submit', TxStatusResponse, body, call),
    txStatus: (id: string, call?: CallOptions) => http.get(`/v1/tx/${encodeURIComponent(id)}`, TxStatusResponse, call),

    // Prover & Relayer (run, leave, seats)
    proverCircuits: (call?: CallOptions) => http.get('/v1/prover/circuits', ProverCircuitsResponse, call),
    proverArtifactUrl: (circuit: string, file: string) =>
      http.url(`/v1/prover/circuits/${encodeURIComponent(circuit)}/${encodeURIComponent(file)}`).toString(),
    proverSppUrl: () => http.url('/v1/prover/spp').toString(),
    relayerQuote: (query: RelayerQuoteQuery, call?: CallOptions) => http.get('/v1/relayer/quote', RelayerQuoteResponse, { ...call, query }),
    relayRun: (body: RelayRunRequest, call?: CallOptions) => http.post('/v1/relayer/run', RelaySubmissionResponse, body, call),
    relayLeave: (body: RelayLeaveRequest, call?: CallOptions) => http.post('/v1/relayer/leave', RelaySubmissionResponse, body, call),
    relayOpenSeat: (body: RelaySeatRequest, call?: CallOptions) => http.post('/v1/relayer/seat/open', RelaySubmissionResponse, body, call),
    relayCloseSeat: (body: RelaySeatRequest, call?: CallOptions) => http.post('/v1/relayer/seat/close', RelaySubmissionResponse, body, call),
    relayStatus: (relayId: string, call?: CallOptions) =>
      http.get(`/v1/relayer/runs/${encodeURIComponent(relayId)}`, RelaySubmissionResponse, call),

    // Hook publishing (/publish)
    parseIdl: (body: ParseIdlRequest, call?: CallOptions) => http.post('/v1/hooks/parse-idl', ParsedIdlResponse, body, call),
    simulateHook: (body: SimulateHookRequest, call?: CallOptions) => http.post('/v1/hooks/simulate', SimulateHookResponse, body, call),
    buildPublishHook: (body: PublishHookBuildRequest, call?: CallOptions) => http.post('/v1/hooks/publish/build', TxBuildResponse, body, call),

    // Author fees
    authorFees: (wallet: string, call?: CallOptions) => http.get(`/v1/authors/${encodeURIComponent(wallet)}/fees`, AuthorFeesResponse, call),
    buildClaimAuthorFees: (wallet: string, body: ClaimAuthorFeesBuildRequest, call?: CallOptions) =>
      http.post(`/v1/authors/${encodeURIComponent(wallet)}/claim/build`, TxBuildResponse, body, call),
  }
}

export type PookApiClient = ReturnType<typeof createClient>
