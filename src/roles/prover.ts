import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CONTRACT_VERSION, type ProverCircuitArtifact } from '@pook/contract'
import { env, fail } from '../config.js'
import { createApi } from '../engines/server/app.js'
import { createShutdown, onShutdownSignals } from '../engines/server/lifecycle.js'
import { serve } from '../engines/server/serve.js'
import { PROVER_FORWARD_HEADERS } from '../chain/prover-headers.js'

const CIRCUITS = ['run', 'leave', 'seat_open', 'seat_fund', 'seat_action', 'seat_close'] as const
const ALLOWED_FILES = new Set(['circuit.xbc', 'pk.bin', 'vk.bin', 'metadata.json'])

type CachedArtifact = {
  bytes: Buffer
  sha256: string
  contentType: string
}

const artifactCache = new Map<string, CachedArtifact>()

function readArtifact(circuit: string, file: string): CachedArtifact | null {
  if (!CIRCUITS.includes(circuit as (typeof CIRCUITS)[number]) || !ALLOWED_FILES.has(file)) return null
  const key = `${circuit}/${file}`
  const hit = artifactCache.get(key)
  if (hit) return hit
  const fullPath = path.resolve(env.POOK_ARTIFACTS_DIR, circuit, file)
  if (!existsSync(fullPath)) return null
  const bytes = readFileSync(fullPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const contentType = file.endsWith('.json') ? 'application/json' : 'application/octet-stream'
  const entry = { bytes, sha256, contentType }
  artifactCache.set(key, entry)
  return entry
}

function listCircuits(): ProverCircuitArtifact[] {
  return CIRCUITS.map((circuit) => {
    const xbc = readArtifact(circuit, 'circuit.xbc')
    const pk = readArtifact(circuit, 'pk.bin')
    const vk = readArtifact(circuit, 'vk.bin')
    return {
      circuit,
      xbcSha256: xbc?.sha256 ?? null,
      pkSha256: pk?.sha256 ?? null,
      vkSha256: vk?.sha256 ?? null,
      available: Boolean(xbc && pk && vk),
    }
  })
}

export function buildProverApp() {
  const app = createApi({
    origins: env.CORS_ORIGINS,
    allowHeaders: ['Accept', 'X-Sync', 'X-Async', 'Spr-Tee', 'Spr-Tee-Enc', 'Spr-Tee-Ciphertext'],
    exposeHeaders: ['X-Artifact-Sha256', 'Spr-Tee', 'Spr-Tee-Enc', 'Spr-Tee-Ciphertext'],
    contractVersion: CONTRACT_VERSION,
  })

  const sppBase = env.RINGS_PROVER_URL.replace(/\/$/, '')

  app.get('/health', (c) => {
    const circuits = listCircuits()
    const ready = circuits.some((entry) => entry.available)
    return c.json({
      status: ready ? 'ready' : 'waiting',
      role: 'prover',
      artifactsDir: env.POOK_ARTIFACTS_DIR,
      circuitsAvailable: circuits.filter((entry) => entry.available).length,
      sppProverHost: new URL(env.RINGS_PROVER_URL).host, // the host only: a keyed URL never leaves the service
      asOf: new Date().toISOString(),
    })
  })

  app.get('/v1/prover/circuits', (c) => {
    const circuits = listCircuits()
    return c.json({
      status: circuits.some((entry) => entry.available) ? 'ready' : 'waiting',
      circuits,
      asOf: new Date().toISOString(),
    })
  })

  app.get('/v1/prover/circuits/:circuit/:file', (c) => {
    const circuit = c.req.param('circuit')
    const file = c.req.param('file')
    const artifact = readArtifact(circuit, file)
    if (!artifact) {
      return fail('NOT_FOUND', `Circuit artifact "${circuit}/${file}" is not available.`, { stage: 'proving', retryable: true })
    }
    return new Response(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        'content-type': artifact.contentType,
        'x-artifact-sha256': artifact.sha256,
        'cache-control': 'public, max-age=3600, immutable',
      },
    })
  })

  // Proxy Rings SPP prover requests so browsers stay single-origin.
  // If loopback 127.0.0.1 is refused (e.g. localnet prover bound to ::1), retry on [::1].
  app.all('/v1/prover/spp/*', async (c) => {
    const url = new URL(c.req.url)
    const stripped = url.pathname.replace(/^\/v1\/prover\/spp/, '') || '/'
    const method = c.req.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer()
    const headers: Record<string, string> = Object.fromEntries(
      PROVER_FORWARD_HEADERS.flatMap((h) => (c.req.header(h) ? [[h, c.req.header(h)!]] : [])),
    )
    const candidates = [sppBase]
    if (sppBase.includes('://127.0.0.1:')) candidates.push(sppBase.replace('://127.0.0.1:', '://[::1]:'))

    let lastErr: unknown
    for (const base of candidates) {
      try {
        // The base may carry a query (Helius' api-key): append the path, merge the queries.
        const target = new URL(base)
        target.pathname = `${target.pathname.replace(/\/+$/, '')}${stripped === '/' ? '' : stripped}`
        for (const [k, v] of url.searchParams) target.searchParams.set(k, v)
        const upstream = await fetch(target, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(60_000),
        })
        const out = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
        for (const h of ['spr-tee', 'spr-tee-enc', 'spr-tee-ciphertext']) {
          const v = upstream.headers.get(h)
          if (v) out.set(h, v)
        }
        return new Response(upstream.body, { status: upstream.status, headers: out })
      } catch (err) {
        lastErr = err
      }
    }
    console.error(JSON.stringify({ level: 'error', event: 'spp_prover_unreachable', message: lastErr instanceof Error ? lastErr.message : String(lastErr) }))
    return fail('UPSTREAM_UNAVAILABLE', 'Rings SPP prover is unreachable. Retry.', { stage: 'proving', retryable: true })
  })

  return app
}

const app = buildProverApp()
const { server } = serve(app, { port: env.PROVER_PORT, host: env.HOST })
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
