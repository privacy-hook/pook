import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { CONTRACT_VERSION, type Scenario } from '@pook/contract'
import { env, fail } from './config.js'
import { createApi, type ApiVariables } from './engines/server/app.js'
import { pookRpcRelay } from './chain/rpc-relay.js'
import type { FixtureVariables } from './engines/server/fixture.js'
import { EventHub, streamEvents, type StreamEvent } from './engines/server/sse.js'
import { registerFixtureRoutes } from './fixture-routes.js'
import { registerChainRoutes, type ChainAppDeps } from './chain/chain-routes.js'

function loadOpenApi(): Record<string, unknown> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '../../contract/openapi.json'),
    path.resolve(here, '../../../contract/openapi.json'),
  ]
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>
    } catch {
      // try next
    }
  }
  return { openapi: '3.1.0', info: { title: 'Pook API', version: CONTRACT_VERSION }, paths: {} }
}

export function buildApp(mode: 'fixture' | 'chain' = env.MODE, chainDeps?: Omit<ChainAppDeps, 'hub'>) {
  const app = createApi<FixtureVariables<Scenario>>({
    origins: env.CORS_ORIGINS,
    // The Rings client's prover headers (sync/async mode, TEE envelope) ride through /v1/prover.
    allowHeaders: ['X-Fixture', 'X-Fixture-Session', 'Last-Event-ID', 'solana-client', 'Accept', 'X-Sync', 'X-Async', 'Spr-Tee', 'Spr-Tee-Enc', 'Spr-Tee-Ciphertext'],
    exposeHeaders: ['Spr-Tee', 'Spr-Tee-Enc', 'Spr-Tee-Ciphertext'],
    contractVersion: CONTRACT_VERSION,
  })

  const openApi = loadOpenApi()
  app.get('/openapi.json', (c) => c.json(openApi))

  const hub = new EventHub<StreamEvent>()

  if (mode === 'fixture') {
    registerFixtureRoutes(app, hub)
    return { app, hub }
  }

  // Always keep fixture previews mounted under /fixture even in chain mode.
  const previews = new Hono<{ Variables: FixtureVariables<Scenario> & ApiVariables }>()
  registerFixtureRoutes(previews, hub)
  app.route('/fixture', previews)

  if (chainDeps) {
    // The browser's Solana RPC goes through the API, so the provider key stays on the server.
    app.route('/v1/rpc', pookRpcRelay(chainDeps.rpc, () => chainDeps.readiness.status() === 'ready'))
    registerChainRoutes(app, { ...chainDeps, hub })
    return { app, hub }
  }

  // Fallback waiting-only mode when constructed without database/RPC dependencies (e.g. smoke tests).
  app.get('/health', (c) =>
    c.json({
      status: 'waiting',
      programId: env.POOK_PROGRAM_ID ?? null,
      cluster: env.CLUSTER,
      contractVersion: CONTRACT_VERSION,
      asOf: new Date().toISOString(),
    }),
  )

  app.get('/v1/config', (c) =>
    c.json({
      status: 'waiting',
      cluster: env.CLUSTER,
      programId: env.POOK_PROGRAM_ID ?? null,
      authorityPda: null,
      ringsProgramId: env.RINGS_PROGRAM_ID,
      stateTree: env.RINGS_STATE_TREE,
      runFeeBps: env.RUN_FEE_BPS ?? null,
      authorShareBps: env.AUTHOR_SHARE_BPS ?? null,
      feeRecipient: env.FEE_RECIPIENT ?? null,
      pookMint: env.POOK_MINT ?? null,
      relayerUrl: env.RELAYER_URL,
      proverUrl: env.PROVER_URL,
      supportedAssets: [],
      asOf: new Date().toISOString(),
    }),
  )

  app.get('/v1/stats', (c) =>
    c.json({
      status: 'waiting',
      hooksCount: 0,
      runsCount: 0,
      activeSeatsCount: 0,
      volumeByAsset: [],
      asOf: new Date().toISOString(),
    }),
  )

  app.get('/v1/hooks', (c) =>
    c.json({
      status: 'waiting',
      items: [],
      page: { nextCursor: null, hasMore: false },
      asOf: new Date().toISOString(),
    }),
  )

  app.get('/v1/runs', (c) =>
    c.json({
      status: 'waiting',
      items: [],
      page: { nextCursor: null, hasMore: false },
      asOf: new Date().toISOString(),
    }),
  )

  app.get('/v1/runs/stream', (c) => streamEvents(c, { hub, ready: () => ({ status: 'waiting' }) }))
  app.all('/v1/*', () => fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true }))

  return { app, hub }
}
