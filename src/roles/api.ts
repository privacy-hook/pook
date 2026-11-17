import { PrismaClient } from '@prisma/client'
import { PublicKey } from '@solana/web3.js'
import pg from 'pg'
import { buildApp } from '../app.js'
import { env, rpcUrlForCluster } from '../config.js'
import { findConfigPda } from '../chain/pda.js'
import { createRpc } from '../engines/rpc/client.js'
import { createDatabase } from '../engines/server/db.js'
import { createShutdown, onShutdownSignals } from '../engines/server/lifecycle.js'
import { createReadiness, programProbe, readinessKey, waitingForConfig } from '../engines/server/readiness.js'
import { serve } from '../engines/server/serve.js'
import { streamEvent } from '../engines/server/sse.js'

async function startRunNotifyListener(databaseUrl: string, onRun: (payload: unknown) => void, signal: AbortSignal) {
  let client: pg.Client | null = null
  const connect = async () => {
    if (signal.aborted) return
    const next = new pg.Client({ connectionString: databaseUrl })
    next.on('notification', (msg) => {
      if (msg.channel !== 'pook_runs' || !msg.payload) return
      try {
        onRun(JSON.parse(msg.payload))
      } catch {
        // Ignore malformed notification payloads.
      }
    })
    next.on('error', () => {
      if (client !== next) return
      client = null
      void next.end().catch(() => {})
      if (!signal.aborted) setTimeout(() => void connect().catch(() => {}), 3_000)
    })
    await next.connect()
    await next.query('LISTEN pook_runs')
    client = next
  }
  await connect().catch(() => {
    if (!signal.aborted) setTimeout(() => void connect().catch(() => {}), 3_000)
  })
  return async () => {
    const c = client
    client = null
    if (c) await c.end().catch(() => {})
  }
}

if (env.MODE === 'fixture') {
  const { app } = buildApp('fixture')
  const { server } = serve(app, { port: env.PORT, host: env.HOST })
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
} else {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required in MODE=chain.')

  const database = createDatabase(databaseUrl, (adapter) => new PrismaClient({ adapter }))
  const rpcUrl = rpcUrlForCluster(env)
  const rpc = createRpc({
    url: rpcUrl,
    service: 'pook-api',
    ...(env.CLUSTER === 'mainnet' ? { rps: 10, scanIntervalMs: 30_000 } : {}),
  })

  const readiness = env.POOK_PROGRAM_ID
    ? createReadiness({
        pool: database.pool,
        key: readinessKey(rpcUrl, [env.POOK_PROGRAM_ID, findConfigPda(new PublicKey(env.POOK_PROGRAM_ID))[0].toBase58()]),
        probe: programProbe(async () => {
          const pid = new PublicKey(env.POOK_PROGRAM_ID!)
          const [configPda] = findConfigPda(pid)
          return rpc.connection.getMultipleAccountsInfo([pid, configPda], 'confirmed')
        }),
      })
    : waitingForConfig()

  let closeListener: (() => Promise<void>) | undefined
  const { app, hub } = buildApp('chain', { db: database.db, rpc, readiness })
  const { server, signal } = serve(app, {
    port: env.PORT,
    host: env.HOST,
    close: async () => {
      await closeListener?.()
      await readiness.stop()
      await database.close()
    },
  })
  // Keep idle keep-alive sockets open past client-side proving/scanning pauses.
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000

  await readiness.start()
  closeListener = await startRunNotifyListener(
    databaseUrl,
    (payload) => hub.publish(streamEvent('run', payload)),
    signal,
  )
}
