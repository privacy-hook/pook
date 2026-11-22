// Buyback and burn of the protocol share. The crank's only input is what the program paid Config's fee
// recipient in runs, as the indexer counted it from each run (buyback_fee: accrued - spent per asset).
// The wallet's balances are never an input: the owner's own SOL, tokens and POOK sit in the same wallet,
// and transfers into it from anywhere else never count. Each pass swaps at most what is owed per asset
// (and at most what the account holds), and burns exactly the POOK its own swap delivered, read from
// that swap transaction, never the standing POOK balance.
import { PrismaClient } from '@prisma/client'
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createTransferCheckedInstruction,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import { WSOL_MINT } from '@pook/contract'
import { env, rpcUrlForCluster } from '../config.js'
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

/** Lamports kept back for the crank's own transaction fees when an owed SOL fee is swapped. */
const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n
/** Owed amounts below this many base units wait for more runs. */
const MIN_SWAP_UNITS = 10_000n
/** Localnet stand-in rate: POOK base units per input base unit. */
const LOCAL_MAKER_RATE = 1_000n

const databaseUrl = env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for the crank role.')

const database = createDatabase(databaseUrl, (adapter) => new PrismaClient({ adapter }))
const db = database.db
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
const localMaker = env.CLUSTER === 'localnet' && env.CRANK_LOCAL_MAKER ? new PublicKey(env.CRANK_LOCAL_MAKER) : null
const jupiter = createJupiterClient({ apiKey: env.JUPITER_API_KEY })

const journal = crankSigner
  ? createJournal({
      connection: rpc.connection,
      store: prismaKeeperStore(db),
      signer: crankSigner,
      isLeader: () => runtime.isLeader(),
    })
  : null

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', role: 'crank', event, ...fields }))

async function tokenAccount(owner: PublicKey, mint: PublicKey) {
  const tokenProgram = await detectTokenProgram(rpc.connection, mint)
  const [ata] = findAta(owner, mint, tokenProgram)
  const info = await rpc.connection.getAccountInfo(ata, 'confirmed')
  return { ata, tokenProgram, amount: info?.data ? unpackAccount(ata, info, tokenProgram).amount : 0n }
}

/** The swap that turns `amount` of `mint` into POOK for the crank's wallet. */
async function swapInstructionsFor(mint: string, amount: bigint, taker: PublicKey): Promise<TransactionInstruction[]> {
  if (localMaker) return localMakerSwap(mint, amount, taker)
  const quote = await quoteExactIn(jupiter, { inputMint: mint, outputMint: pookMint!, amount, slippageBps: 100 })
  // SOL fees arrive as lamports; Jupiter wraps exactly the quoted amount in and unwraps the rest back.
  const built = await swapInstructions(jupiter, { quote, taker, wrapAndUnwrapSol: mint === WSOL_MINT })
  return [...built.setup, built.swap, ...built.cleanup]
}

/**
 * Localnet stand-in for Jupiter: the input goes to the maker and POOK comes back from the maker's
 * account, which approved the crank as delegate, at a fixed rate. One signer, like a Jupiter swap.
 */
async function localMakerSwap(mint: string, amount: bigint, taker: PublicKey): Promise<TransactionInstruction[]> {
  const maker = localMaker!
  const makerInfo = await rpc.connection.getAccountInfo(maker, 'confirmed')
  if (!makerInfo) throw new Error('CRANK_LOCAL_MAKER account not found.')
  const makerAccount = unpackAccount(maker, makerInfo, makerInfo.owner)
  const pook = await tokenAccount(taker, pookMint!)
  const pookDecimals = unpackMint(pookMint!, await rpc.connection.getAccountInfo(pookMint!, 'confirmed'), pook.tokenProgram).decimals
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(taker, pook.ata, taker, pookMint!, pook.tokenProgram),
  ]
  if (mint === WSOL_MINT) {
    ixs.push(SystemProgram.transfer({ fromPubkey: taker, toPubkey: makerAccount.owner, lamports: amount }))
  } else {
    const input = new PublicKey(mint)
    const inTp = await detectTokenProgram(rpc.connection, input)
    const [takerIn] = findAta(taker, input, inTp)
    const [makerIn] = findAta(makerAccount.owner, input, inTp)
    const decimals = unpackMint(input, await rpc.connection.getAccountInfo(input, 'confirmed'), inTp).decimals
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(taker, makerIn, makerAccount.owner, input, inTp),
      createTransferCheckedInstruction(takerIn, input, makerIn, taker, amount, decimals, [], inTp),
    )
  }
  ixs.push(createTransferCheckedInstruction(maker, pookMint!, pook.ata, taker, amount * LOCAL_MAKER_RATE, pookDecimals, [], pook.tokenProgram))
  return ixs
}

/** POOK that one swap transaction delivered to the crank's wallet: its post minus pre balance in that transaction. */
async function pookDeliveredBy(signature: string, taker: PublicKey): Promise<bigint> {
  const tx = await rpc.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!tx?.meta) throw new Error(`Swap transaction ${signature} is not readable yet.`)
  const sum = (list: typeof tx.meta.postTokenBalances) =>
    (list ?? [])
      .filter((b) => b.mint === pookMint!.toBase58() && b.owner === taker.toBase58())
      .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n)
  const delivered = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances)
  return delivered > 0n ? delivered : 0n
}

/** Records a confirmed swap: what it spent leaves the ledger, what it delivered is what gets burned. */
async function settleSwap(key: string, mint: string, amountIn: bigint, signature: string, taker: PublicKey) {
  const delivered = await pookDeliveredBy(signature, taker)
  await db.$transaction(async (tx) => {
    const swap = await tx.buybackSwap.findUnique({ where: { key } })
    if (swap?.status !== 'planned') return
    const fee = await tx.buybackFee.findUnique({ where: { mint } })
    await tx.buybackFee.update({ where: { mint }, data: { spent: (BigInt(fee!.spent) + amountIn).toString() } })
    await tx.buybackSwap.update({ where: { key }, data: { status: 'swapped', swapSignature: signature, pookDelivered: delivered.toString() } })
  })
  log('buyback_swapped', { key, mint, spent: amountIn.toString(), pookDelivered: delivered.toString(), signature })
}

/** Burns exactly the POOK one swap delivered. */
async function burnFor(key: string, delivered: bigint, taker: PublicKey) {
  if (delivered > 0n) {
    const pook = await tokenAccount(taker, pookMint!)
    const burnKey = `${key}:burn`
    const result = await journal!.execute(burnKey, () => [
      createBurnInstruction(pook.ata, pookMint!, taker, delivered, [], pook.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID),
    ])
    if (result !== 'confirmed') return
    const row = await db.keeperTransaction.findUnique({ where: { key: burnKey } })
    await db.buybackSwap.update({ where: { key }, data: { status: 'burned', burnSignature: row?.signature ?? null } })
  } else {
    await db.buybackSwap.update({ where: { key }, data: { status: 'burned' } })
  }
  log('pook_burned', { key, mint: pookMint!.toBase58(), burnedAmount: delivered.toString() })
}

/** Carries a recorded buyback forward: a planned swap is reconciled with its journal row, a swapped one is burned. */
async function advance(swap: { key: string; mint: string; amountIn: string; status: string; pookDelivered: string | null }, taker: PublicKey) {
  if (swap.status === 'planned') {
    const row = await db.keeperTransaction.findUnique({ where: { key: swap.key } })
    if (!row || row.state === 'failed' || row.state === 'expired') {
      // Nothing moved: the journal never sent it, or it provably never landed.
      if (!row || row.state === 'failed' || (await journal!.follow(swap.key).catch(() => 'gone')) === 'gone') {
        await db.buybackSwap.update({ where: { key: swap.key }, data: { status: 'void' } })
        log('buyback_void', { key: swap.key, mint: swap.mint })
      }
      return
    }
    if (row.state !== 'confirmed' && (await journal!.follow(swap.key)) !== 'confirmed') return
    if (swap.mint === pookMint!.toBase58()) {
      await settleBurnOnly(swap.key, swap.mint, BigInt(swap.amountIn))
    } else {
      await settleSwap(swap.key, swap.mint, BigInt(swap.amountIn), row.signature, taker)
    }
    const settled = await db.buybackSwap.findUnique({ where: { key: swap.key } })
    if (settled?.status === 'swapped') await burnFor(swap.key, BigInt(settled.pookDelivered ?? '0'), taker)
  } else if (swap.status === 'swapped') {
    await burnFor(swap.key, BigInt(swap.pookDelivered ?? '0'), taker)
  }
}

/** A fee paid in POOK itself needs no swap: the owed amount is burned as it is. */
async function settleBurnOnly(key: string, mint: string, amount: bigint) {
  await db.$transaction(async (tx) => {
    const swap = await tx.buybackSwap.findUnique({ where: { key } })
    if (swap?.status !== 'planned') return
    const fee = await tx.buybackFee.findUnique({ where: { mint } })
    await tx.buybackFee.update({ where: { mint }, data: { spent: (BigInt(fee!.spent) + amount).toString() } })
    await tx.buybackSwap.update({ where: { key }, data: { status: 'swapped', pookDelivered: amount.toString() } })
  })
}

/** What may be swapped for one fee asset now: the owed amount, capped by what the account holds. */
async function spendable(mint: string, owed: bigint, taker: PublicKey): Promise<bigint> {
  if (mint === WSOL_MINT) {
    // SOL fees are paid as lamports; only the owed lamports are ever taken, keeping a fee reserve.
    const lamports = BigInt(await rpc.connection.getBalance(taker, 'confirmed'))
    const room = lamports > SOL_FEE_RESERVE_LAMPORTS ? lamports - SOL_FEE_RESERVE_LAMPORTS : 0n
    return owed < room ? owed : room
  }
  const held = (await tokenAccount(taker, new PublicKey(mint))).amount
  return owed < held ? owed : held
}

/**
 * One buyback-and-burn pass:
 * 1. Resume journaled transactions and carry every recorded buyback forward (reconcile, then burn).
 * 2. For each fee asset with protocol share owed, record a planned swap of at most that amount, send
 *    it through the journal, then settle it from its own transaction and burn what it delivered.
 */
async function buybackAndBurnPass() {
  if (!crankSigner || !pookMint || !journal) return
  await journal.resume()
  const taker = crankSigner.publicKey

  const open = await db.buybackSwap.findMany({ where: { status: { in: ['planned', 'swapped'] } }, orderBy: { createdAt: 'asc' } })
  for (const swap of open) await advance(swap, taker)
  const busy = new Set((await db.buybackSwap.findMany({ where: { status: { in: ['planned', 'swapped'] } } })).map((s) => s.mint))

  for (const fee of await db.buybackFee.findMany()) {
    if (busy.has(fee.mint)) continue
    const owed = BigInt(fee.accrued) - BigInt(fee.spent)
    if (owed < MIN_SWAP_UNITS) continue
    const amount = await spendable(fee.mint, owed, taker)
    if (amount < MIN_SWAP_UNITS) continue

    const key = `crank:buyback:${fee.mint}:${Date.now()}`
    await db.buybackSwap.create({ data: { key, mint: fee.mint, amountIn: amount.toString(), status: 'planned' } })
    try {
      if (fee.mint === pookMint.toBase58()) {
        await settleBurnOnly(key, fee.mint, amount)
        await burnFor(key, amount, taker)
        continue
      }
      const result = await journal.execute(key, () => swapInstructionsFor(fee.mint, amount, taker))
      if (result !== 'confirmed') continue // followed on the next pass
      const row = await db.keeperTransaction.findUnique({ where: { key } })
      await settleSwap(key, fee.mint, amount, row!.signature, taker)
      await burnFor(key, BigInt((await db.buybackSwap.findUnique({ where: { key } }))!.pookDelivered ?? '0'), taker)
    } catch (error) {
      // Not journaled (no route, simulation refused): nothing moved, the owed amount waits.
      if (!(await db.keeperTransaction.findUnique({ where: { key } }))) {
        await db.buybackSwap.update({ where: { key }, data: { status: 'void' } })
      }
      log('buyback_skipped', { mint: fee.mint, owed: owed.toString(), message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })
    }
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
log('crank_started', { configured: Boolean(pookMint && crankIntervalMs && crankSigner), readiness: readiness.status(), localMaker: Boolean(localMaker) })
await runtime.run()
