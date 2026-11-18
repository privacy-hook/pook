import { PrismaClient } from '@prisma/client'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createBurnInstruction,
  unpackAccount,
} from '@solana/spl-token'
import { WSOL_MINT } from '@pook/contract'
import { USDC_MINT, env, rpcUrlForCluster } from '../config.js'
import { detectTokenProgram } from '../chain/accounts.js'
import { findAta, findConfigPda } from '../chain/pda.js'
import { SessionLease } from '../engines/indexer/session-lease.js'
import { createJupiterClient } from '../engines/jupiter/http.js'
import { quoteExactIn } from '../engines/jupiter/quote.js'
import { swapInstructions } from '../engines/jupiter/swap.js'
import { createJournal } from '../engines/keeper/journal.js'
import { prismaKeeperStore } from '../engines/keeper/prisma-store.js'
import { createKeeperRuntime } from '../engines/keeper/runtime.js'
import { createScheduler } from '../engines/keeper/scheduler.js'
import { createRpc } from '../engines/rpc/client.js'
import { createDatabase } from '../engines/server/db.js'
import { createShutdown, onShutdownSignals } from '../engines/server/lifecycle.js'
import { createReadiness, programProbe, readinessKey, waitingForConfig } from '../engines/server/readiness.js'
import { keypairFromSecret } from '../engines/tx/server/keys.js'

const MIN_SOL_RESERVE_LAMPORTS = 50_000_000n // keep 0.05 SOL for crank transaction fees
const MIN_SWAP_LAMPORTS = 10_000_000n
const MIN_SWAP_SPL_UNITS = 100_000n

const databaseUrl = env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for the crank role.')

const database = createDatabase(databaseUrl, (adapter) => new PrismaClient({ adapter }))
const rpcUrl = rpcUrlForCluster(env)
const rpc = createRpc({
  url: rpcUrl,
  service: 'pook-crank',
  ...(env.CLUSTER === 'mainnet' ? { rps: 6, scanIntervalMs: 30_000 } : {}),
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

const sessionLease = new SessionLease({
  connectionString: databaseUrl,
  name: 'pook:crank:leader',
})

const keeperLease = {
  acquire: () => sessionLease.acquire(),
  renew: async () => sessionLease.held,
  release: () => sessionLease.release(),
}

const crankSigner = env.CRANK_SECRET_KEY ? keypairFromSecret('CRANK_SECRET_KEY', env.CRANK_SECRET_KEY) : null
const pookMint = env.POOK_MINT ? new PublicKey(env.POOK_MINT) : null
const crankIntervalMs = env.CRANK_INTERVAL_MS ?? null
const jupiter = createJupiterClient({ apiKey: env.JUPITER_API_KEY })

const journal = crankSigner
  ? createJournal({
      connection: rpc.connection,
      store: prismaKeeperStore(database.db),
      signer: crankSigner,
      isLeader: () => runtime.isLeader(),
    })
  : null

async function readPookTokenBalance(owner: PublicKey, mint: PublicKey): Promise<{ ata: PublicKey; tokenProgram: PublicKey; amount: bigint }> {
  const tokenProgram = await detectTokenProgram(rpc.connection, mint)
  const [ata] = findAta(owner, mint, tokenProgram)
  const info = await rpc.connection.getAccountInfo(ata, 'confirmed')
  if (!info?.data) return { ata, tokenProgram, amount: 0n }
  return { ata, tokenProgram, amount: unpackAccount(ata, info, tokenProgram).amount }
}

/**
 * One buyback-and-burn pass:
 * 1. Resume any previously journaled keeper transactions.
 * 2. Check SOL (above reserve) and accrued SPL fee balances (USDC, etc.) held by CRANK_SECRET_KEY.
 * 3. Swap each non-POOK fee balance to POOK_MINT via Jupiter (`engines/jupiter`).
 * 4. Burn the exact POOK token balance delivered into CRANK_SECRET_KEY's POOK ATA.
 */
async function buybackAndBurnPass(now: number) {
  if (!crankSigner || !pookMint || !journal) return
  await journal.resume()

  const epoch = Math.floor(now / (crankIntervalMs ?? 60_000))
  const taker = crankSigner.publicKey
  const beforePook = await readPookTokenBalance(taker, pookMint)

  // Candidate input mints held in the protocol fee recipient wallet.
  const candidates: { mint: string; amount: bigint }[] = []

  const solBalance = BigInt(await rpc.connection.getBalance(taker, 'confirmed'))
  if (solBalance > MIN_SOL_RESERVE_LAMPORTS + MIN_SWAP_LAMPORTS) {
    candidates.push({ mint: WSOL_MINT, amount: solBalance - MIN_SOL_RESERVE_LAMPORTS })
  }

  for (const splMintStr of [USDC_MINT]) {
    if (splMintStr === pookMint.toBase58()) continue
    const splMint = new PublicKey(splMintStr)
    const tp = await detectTokenProgram(rpc.connection, splMint)
    const [ata] = findAta(taker, splMint, tp)
    const info = await rpc.connection.getAccountInfo(ata, 'confirmed')
    if (!info?.data) continue
    const amount = unpackAccount(ata, info, tp).amount
    if (amount >= MIN_SWAP_SPL_UNITS) candidates.push({ mint: splMintStr, amount })
  }

  for (const item of candidates) {
    const swapKey = `crank:swap:${item.mint}:${epoch}`
    await journal.execute(swapKey, async () => {
      const quote = await quoteExactIn(jupiter, {
        inputMint: item.mint,
        outputMint: pookMint,
        amount: item.amount,
        slippageBps: 100,
      })
      const built = await swapInstructions(jupiter, {
        quote,
        taker,
        wrapAndUnwrapSol: item.mint === WSOL_MINT,
      })
      return [...built.setup, built.swap, ...built.cleanup]
    })
  }

  // Burn every POOK token accrued or delivered from swaps.
  const afterPook = await readPookTokenBalance(taker, pookMint)
  const toBurn = afterPook.amount > 0n ? afterPook.amount : 0n
  if (toBurn > 0n) {
    const burnKey = `crank:burn:${pookMint.toBase58()}:${epoch}`
    const delta = afterPook.amount > beforePook.amount ? afterPook.amount - beforePook.amount : afterPook.amount
    await journal.execute(burnKey, (): TransactionInstruction[] => [
      createBurnInstruction(
        afterPook.ata,
        pookMint,
        taker,
        toBurn,
        [],
        afterPook.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      ),
    ])
    console.log(
      JSON.stringify({
        level: 'info',
        role: 'crank',
        event: 'pook_burned',
        mint: pookMint.toBase58(),
        burnedAmount: toBurn.toString(),
        swappedDelta: delta.toString(),
      }),
    )
  }
}

const scheduler = createScheduler(
  [
    {
      name: 'buyback_and_burn',
      everyMs: crankIntervalMs ?? 60_000,
      run: buybackAndBurnPass,
    },
  ],
  {
    backoffMs: 60_000,
    onError: (task, error) =>
      console.error(
        JSON.stringify({
          level: 'error',
          role: 'crank',
          event: 'crank_task_failed',
          task,
          message: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        }),
      ),
  },
)

const runtime = createKeeperRuntime({
  lease: keeperLease,
  leaseMs: 30_000,
  tickMs: Math.min(crankIntervalMs ?? 15_000, 15_000),
  gate: async () => {
    // Stay healthy in `waiting` state while program is undeployed or owner-decided crank config is unset.
    if (readiness.status() !== 'ready') return 'waiting'
    if (!pookMint || !crankIntervalMs || !crankSigner) return 'waiting'
    return 'ready'
  },
  tick: () => scheduler.tick(),
  log: (entry) => console.log(JSON.stringify({ level: 'info', role: 'crank', ...entry })),
})

const { shutdown } = createShutdown(async () => {
  await runtime.stop()
  await readiness.stop()
  await database.close()
})
onShutdownSignals(shutdown)

await readiness.start()
console.log(
  JSON.stringify({
    level: 'info',
    role: 'crank',
    event: 'crank_started',
    configured: Boolean(pookMint && crankIntervalMs && crankSigner),
    readiness: readiness.status(),
  }),
)
await runtime.run()
