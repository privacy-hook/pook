import { PrismaClient, type Prisma } from '@prisma/client'
import { PublicKey } from '@solana/web3.js'
import {
  WSOL_MINT,
  computeFeeSplit,
  hookIdHash,
  isNativeSolMint,
  toHex,
  type PublicRun,
} from '@pook/contract'
import { env, rpcUrlForCluster } from '../config.js'
import { assetMeta } from '../chain/accounts.js'
import { resolveHookDisplay } from '../chain/hook-metadata.js'
import { findAuthorityPda, findConfigPda, findStagePda } from '../chain/pda.js'
import { pookProgramDecoder } from '../chain/pook-decoder.js'
import type { DecodedInstruction, DecodedTransaction } from '../engines/indexer/decoder.js'
import { Indexer } from '../engines/indexer/indexer.js'
import { logsStream } from '../engines/indexer/logs-stream.js'
import { PrismaIndexStore } from '../engines/indexer/prisma-store.js'
import { httpRpc } from '../engines/indexer/rpc.js'
import { SessionLease } from '../engines/indexer/session-lease.js'
import { descendants } from '../engines/indexer/token-flows.js'
import { runWorker } from '../engines/indexer/worker.js'
import { createRpc } from '../engines/rpc/client.js'
import { createDatabase } from '../engines/server/db.js'
import { createShutdown, onShutdownSignals } from '../engines/server/lifecycle.js'
import { createReadiness, programProbe, readinessKey, waitingForConfig } from '../engines/server/readiness.js'
import { loadLaunchHooks } from '../../hooks/index.js'

const launchMetaById = new Map(loadLaunchHooks().map((h) => [h.id, h]))

type PookFact =
  | {
      kind: 'init_config'
      runFeeBps: number
      authorShareBps: number
      feeRecipient: string
      admin: string
    }
  | {
      kind: 'set_config'
      runFeeBps: number | null
      authorShareBps: number | null
      feeRecipient: string | null
      admin: string | null
    }
  | {
      kind: 'publish_hook'
      hookId: string
      hookAddress: string
      author: string
      targetProgram: string
      hookKind: string
      mintInConstraint: { kind: string; mint?: string }
      mintOutConstraint: { kind: string; mint?: string }
      wrapSolIn: boolean
      unwrapSolOut: boolean
      dataTemplateHex: string
      dataSlots: unknown[]
      accountSlots: unknown[]
      companions: unknown[]
    }
  | {
      kind: 'run'
      hookAddress: string
      runKind: string
      mintIn: string | null
      mintOut: string | null
      amountIn: string
      amountOut: string
      relayerFee: string
      stageAuthority: string
      relayer: string
      feeRecipient: string
      authorFeesPda: string
    }
  | {
      kind: 'open_seat'
      seatAddress: string
      commitmentHex: string
      openerRelayer: string
    }
  | {
      kind: 'close_seat'
      seatAddress: string
      commitmentHex: string
    }
  | {
      kind: 'claim_author_fees'
      author: string
      mint: string
    }

type TxFacts = { items: PookFact[] }

function extractFacts(tx: DecodedTransaction, programId: string): TxFacts {
  const items: PookFact[] = []
  for (const ix of tx.instructions) {
    if (ix.programId !== programId || !ix.name || !ix.args) continue
    const a = ix.args as Record<string, unknown>
    const acc = ix.namedAccounts

    if (ix.name === 'init_config') {
      items.push({
        kind: 'init_config',
        runFeeBps: Number(a.runFeeBps ?? 0),
        authorShareBps: Number(a.authorShareBps ?? 0),
        feeRecipient: String(a.feeRecipient),
        admin: String(a.admin),
      })
    } else if (ix.name === 'set_config') {
      items.push({
        kind: 'set_config',
        runFeeBps: a.runFeeBps != null ? Number(a.runFeeBps) : null,
        authorShareBps: a.authorShareBps != null ? Number(a.authorShareBps) : null,
        feeRecipient: a.feeRecipient != null ? String(a.feeRecipient) : null,
        admin: a.admin != null ? String(a.admin) : null,
      })
    } else if (ix.name === 'publish_hook') {
      items.push({
        kind: 'publish_hook',
        hookId: String(a.hookId),
        hookAddress: acc.hookPda ?? '',
        author: acc.author ?? '',
        targetProgram: String(a.targetProgram),
        hookKind: String(a.kind),
        mintInConstraint: JSON.parse(String(a.mintIn)),
        mintOutConstraint: JSON.parse(String(a.mintOut)),
        wrapSolIn: Boolean(a.wrapSolIn),
        unwrapSolOut: Boolean(a.unwrapSolOut),
        dataTemplateHex: String(a.dataTemplateHex ?? ''),
        dataSlots: JSON.parse(String(a.dataSlots ?? '[]')),
        accountSlots: JSON.parse(String(a.accountSlots ?? '[]')),
        companions: JSON.parse(String(a.companions ?? '[]')),
      })
    } else if (ix.name === 'run') {
      const amountOut = measureRunOutput(tx, ix, a)
      items.push({
        kind: 'run',
        hookAddress: acc.hookPda ?? '',
        runKind: String(a.kind ?? 'flow'),
        mintIn: a.mintIn ? String(a.mintIn) : null,
        mintOut: a.hasMintOut && a.mintOut ? String(a.mintOut) : null,
        amountIn: String(a.amountIn ?? '0'),
        amountOut,
        relayerFee: String(a.relayerFee ?? '0'),
        stageAuthority: acc.stagePda ?? '',
        relayer: acc.relayerPayer ?? '',
        feeRecipient: acc.feeRecipient ?? '',
        authorFeesPda: acc.authorFeesPda ?? '',
      })
    } else if (ix.name === 'open_seat') {
      items.push({
        kind: 'open_seat',
        seatAddress: acc.seatPda ?? '',
        commitmentHex: String(a.commitmentHex ?? ''),
        openerRelayer: acc.relayerPayer ?? '',
      })
    } else if (ix.name === 'close_seat') {
      items.push({
        kind: 'close_seat',
        seatAddress: acc.seatPda ?? '',
        commitmentHex: String(a.commitmentHex ?? ''),
      })
    } else if (ix.name === 'claim_author_fees') {
      const mintStr = String(a.mint ?? 'SOL')
      items.push({
        kind: 'claim_author_fees',
        author: acc.author ?? '',
        mint: mintStr === 'SOL' ? WSOL_MINT : mintStr,
      })
    }
  }
  return { items }
}

/** Measures actual output amount from token flows under the `pook::run` instruction, falling back to minOut. */
function measureRunOutput(tx: DecodedTransaction, ix: DecodedInstruction, args: Record<string, unknown>): string {
  const hasMintOut = Boolean(args.hasMintOut)
  if (!hasMintOut) return '0'
  const mintOut = args.mintOut ? String(args.mintOut) : null
  const flows = descendants(tx, ix)
  if (mintOut && !isNativeSolMint(mintOut)) {
    const stagePda = ix.namedAccounts.stagePda
    const toStage = flows.filter((f) => f.kind === 'transfer' && f.mint === mintOut && f.destination && f.authority !== stagePda)
    if (toStage.length) {
      return toStage.reduce((sum, f) => sum + BigInt(f.amountRaw), 0n).toString()
    }
  }
  return String(args.minOut ?? '0')
}

async function applyFacts(
  tx: Prisma.TransactionClient,
  row: { signature: string; slot: number; blockTime: Date | null; failed: boolean; facts: TxFacts | null },
  programId: PublicKey,
) {
  if (row.failed || !row.facts?.items.length) return
  const blockTime = row.blockTime ?? new Date()
  const slotBig = BigInt(row.slot)
  const [authorityPda] = findAuthorityPda(programId)

  for (const fact of row.facts.items) {
    if (fact.kind === 'init_config') {
      await tx.protocolConfig.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          programId: programId.toBase58(),
          authorityPda: authorityPda.toBase58(),
          runFeeBps: fact.runFeeBps,
          authorShareBps: fact.authorShareBps,
          feeRecipient: fact.feeRecipient,
          admin: fact.admin,
          updatedSlot: slotBig,
        },
        update: {
          programId: programId.toBase58(),
          authorityPda: authorityPda.toBase58(),
          runFeeBps: fact.runFeeBps,
          authorShareBps: fact.authorShareBps,
          feeRecipient: fact.feeRecipient,
          admin: fact.admin,
          updatedSlot: slotBig,
        },
      })
    } else if (fact.kind === 'set_config') {
      await tx.protocolConfig.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          programId: programId.toBase58(),
          authorityPda: authorityPda.toBase58(),
          runFeeBps: fact.runFeeBps,
          authorShareBps: fact.authorShareBps,
          feeRecipient: fact.feeRecipient,
          admin: fact.admin,
          updatedSlot: slotBig,
        },
        update: {
          ...(fact.runFeeBps !== null ? { runFeeBps: fact.runFeeBps } : {}),
          ...(fact.authorShareBps !== null ? { authorShareBps: fact.authorShareBps } : {}),
          ...(fact.feeRecipient !== null ? { feeRecipient: fact.feeRecipient } : {}),
          ...(fact.admin !== null ? { admin: fact.admin } : {}),
          updatedSlot: slotBig,
        },
      })
    } else if (fact.kind === 'publish_hook') {
      const launchMeta = launchMetaById.get(fact.hookId) ?? null
      const draftMeta = await tx.hookDraftMetadata.findUnique({ where: { hookId: fact.hookId } }).catch(() => null)
      const resolved = resolveHookDisplay({
        onChain: {
          hookId: fact.hookId,
          kind: fact.hookKind,
          targetProgram: fact.targetProgram,
          mintIn: fact.mintInConstraint as Parameters<typeof resolveHookDisplay>[0]['onChain']['mintIn'],
          mintOut: fact.mintOutConstraint as Parameters<typeof resolveHookDisplay>[0]['onChain']['mintOut'],
          wrapSolIn: fact.wrapSolIn,
          unwrapSolOut: fact.unwrapSolOut,
          dataTemplateHex: fact.dataTemplateHex,
          dataSlots: fact.dataSlots as Parameters<typeof resolveHookDisplay>[0]['onChain']['dataSlots'],
          accountSlots: fact.accountSlots as Parameters<typeof resolveHookDisplay>[0]['onChain']['accountSlots'],
          companions: fact.companions as Parameters<typeof resolveHookDisplay>[0]['onChain']['companions'],
          author: fact.author,
        },
        launchMeta,
        draftMeta,
      })
      await tx.hook.upsert({
        where: { id: fact.hookId },
        create: {
          id: fact.hookId,
          address: fact.hookAddress,
          hookIdHash: toHex(hookIdHash(fact.hookId)),
          protocol: resolved.protocol,
          protocolName: resolved.protocolName,
          label: resolved.label,
          description: resolved.description,
          kind: fact.hookKind,
          targetProgram: fact.targetProgram,
          instructionName: resolved.instructionName,
          discriminator: resolved.discriminator,
          mintInConstraint: fact.mintInConstraint as Prisma.InputJsonValue,
          mintOutConstraint: fact.mintOutConstraint as Prisma.InputJsonValue,
          wrapSolIn: fact.wrapSolIn,
          unwrapSolOut: fact.unwrapSolOut,
          dataTemplateHex: fact.dataTemplateHex,
          dataSlots: fact.dataSlots as Prisma.InputJsonValue,
          accountSlots: fact.accountSlots as Prisma.InputJsonValue,
          companions: fact.companions as Prisma.InputJsonValue,
          dataTemplate: resolved.dataTemplate as Prisma.InputJsonValue,
          accountsTemplate: resolved.accountsTemplate as Prisma.InputJsonValue,
          companionInstructions: resolved.companionInstructions as Prisma.InputJsonValue,
          formFields: resolved.formFields as Prisma.InputJsonValue,
          mintIn: resolved.mintIn,
          mintOut: resolved.mintOut,
          assetInSymbol: resolved.assetInSymbol,
          assetOutSymbol: resolved.assetOutSymbol,
          author: fact.author,
          immutable: true,
          publishSignature: row.signature,
          publishedSlot: slotBig,
          publishedAt: blockTime,
        },
        update: {},
      })
    } else if (fact.kind === 'run') {
      const hook = await tx.hook.findUnique({ where: { address: fact.hookAddress } })
      if (!hook) continue
      const cfg = await tx.protocolConfig.findUnique({ where: { id: 'singleton' } })
      const feeBasis = BigInt(fact.amountOut) > 0n ? BigInt(fact.amountOut) : BigInt(fact.amountIn)
      const split =
        cfg?.runFeeBps != null && cfg?.authorShareBps != null
          ? computeFeeSplit(feeBasis, cfg.runFeeBps, cfg.authorShareBps)
          : { runFee: 0n, authorFee: 0n, protocolFee: 0n }

      const inAsset = assetMeta(fact.mintIn)
      const outAsset = assetMeta(fact.mintOut)
      const existing = await tx.hookRun.findUnique({ where: { signature: row.signature } })
      if (existing) continue

      await tx.hookRun.create({
        data: {
          signature: row.signature,
          slot: slotBig,
          hookId: hook.id,
          hookAddress: hook.address,
          protocol: hook.protocol,
          kind: hook.kind,
          mintIn: fact.mintIn,
          assetInSymbol: inAsset?.symbol ?? hook.assetInSymbol,
          amountIn: fact.amountIn,
          mintOut: fact.mintOut,
          assetOutSymbol: outAsset?.symbol ?? hook.assetOutSymbol,
          amountOut: fact.amountOut,
          runFeeAmount: split.runFee.toString(),
          authorFeeAmount: split.authorFee.toString(),
          protocolFeeAmount: split.protocolFee.toString(),
          relayerFeeAmount: fact.relayerFee,
          stageAuthority: fact.stageAuthority,
          relayer: fact.relayer,
          status: 'confirmed',
          blockTime,
        },
      })

      await tx.hook.update({
        where: { id: hook.id },
        data: {
          runsCount: { increment: 1 },
          volumeIn: (BigInt(hook.volumeIn) + BigInt(fact.amountIn)).toString(),
          volumeOut: (BigInt(hook.volumeOut) + BigInt(fact.amountOut)).toString(),
          lastRunAt: blockTime,
        },
      })

      if (split.authorFee > 0n) {
        const feeMint = fact.mintOut ?? fact.mintIn ?? WSOL_MINT
        const feeAsset = assetMeta(feeMint)
        const ledgerId = `${hook.author}:${hook.id}:${feeMint}`
        const prev = await tx.authorFeeLedger.findUnique({ where: { id: ledgerId } })
        if (prev) {
          await tx.authorFeeLedger.update({
            where: { id: ledgerId },
            data: {
              claimableAmount: (BigInt(prev.claimableAmount) + split.authorFee).toString(),
              totalEarnedAmount: (BigInt(prev.totalEarnedAmount) + split.authorFee).toString(),
            },
          })
        } else {
          await tx.authorFeeLedger.create({
            data: {
              id: ledgerId,
              author: hook.author,
              hookId: hook.id,
              hookAddress: hook.address,
              mint: feeMint,
              assetSymbol: feeAsset?.symbol ?? null,
              decimals: feeAsset?.decimals ?? 9,
              claimableAmount: split.authorFee.toString(),
              totalEarnedAmount: split.authorFee.toString(),
            },
          })
        }
      }

      const publicRun: PublicRun = {
        signature: row.signature,
        slot: slotBig.toString(),
        hookId: hook.id,
        hookAddress: hook.address,
        protocol: hook.protocol,
        kind: hook.kind,
        mintIn: fact.mintIn,
        assetInSymbol: inAsset?.symbol ?? hook.assetInSymbol,
        amountIn: fact.amountIn,
        mintOut: fact.mintOut,
        assetOutSymbol: outAsset?.symbol ?? hook.assetOutSymbol,
        amountOut: fact.amountOut,
        runFeeAmount: split.runFee.toString(),
        relayerFeeAmount: fact.relayerFee,
        stageAuthority: fact.stageAuthority,
        relayer: fact.relayer,
        status: 'confirmed',
        timestamp: blockTime.toISOString(),
      }
      await tx.$executeRaw`SELECT pg_notify('pook_runs', ${JSON.stringify(publicRun)})`
    } else if (fact.kind === 'open_seat') {
      await tx.seat.upsert({
        where: { address: fact.seatAddress },
        create: {
          address: fact.seatAddress,
          commitment: fact.commitmentHex,
          openerRelayer: fact.openerRelayer,
          protocol: 'kamino',
          status: 'open',
          openedSignature: row.signature,
          openedSlot: slotBig,
          openedAt: blockTime,
        },
        update: {
          commitment: fact.commitmentHex,
          openerRelayer: fact.openerRelayer,
          status: 'open',
        },
      })
    } else if (fact.kind === 'close_seat') {
      await tx.seat.updateMany({
        where: { address: fact.seatAddress },
        data: {
          status: 'closed',
          closedSignature: row.signature,
          closedAt: blockTime,
        },
      })
    } else if (fact.kind === 'claim_author_fees') {
      await tx.authorFeeLedger.updateMany({
        where: { author: fact.author, mint: fact.mint },
        data: {
          claimableAmount: '0',
          lastClaimedAt: blockTime,
        },
      })
    }
  }
}

const databaseUrl = env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for the indexer role.')

const database = createDatabase(databaseUrl, (adapter) => new PrismaClient({ adapter }))
const rpcUrl = rpcUrlForCluster(env)
const rpc = createRpc({
  url: rpcUrl,
  service: 'pook-indexer',
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

let worker: ReturnType<typeof runWorker> | undefined

const { shutdown } = createShutdown(async () => {
  await worker?.stop()
  await readiness.stop()
  await database.close()
})
onShutdownSignals(shutdown)

await readiness.start()
console.log(JSON.stringify({ level: 'info', event: 'indexer_waiting', status: readiness.status(), programId: env.POOK_PROGRAM_ID ?? null }))
await readiness.waitUntilReady()

const programId = new PublicKey(env.POOK_PROGRAM_ID!)
const [configPda] = findConfigPda(programId)
const [stagePda] = findStagePda(programId)

const store = new PrismaIndexStore<TxFacts, Prisma.TransactionClient>(database.db, { lock: 'pook:indexer:apply' })
const indexer = new Indexer<TxFacts, Prisma.TransactionClient>({
  rpc: httpRpc(rpcUrl),
  store,
  programs: [pookProgramDecoder(programId.toBase58())],
  addresses: [programId.toBase58(), configPda.toBase58(), stagePda.toBase58()],
  facts: (tx) => extractFacts(tx, programId.toBase58()),
  apply: (tx, row) => applyFacts(tx, row, programId),
  stream: env.CLUSTER === 'localnet' ? logsStream({ rpcUrl, wsUrl: env.SOLANA_WS_URL }) : undefined,
  pollMs: env.CLUSTER === 'localnet' ? 1_500 : 10_000,
  log: (entry) => console.log(JSON.stringify({ level: 'info', role: 'indexer', ...entry })),
})

const lease = new SessionLease({
  connectionString: databaseUrl,
  name: 'pook:indexer:leader',
  onLost: () => console.log(JSON.stringify({ level: 'warn', event: 'indexer_lease_lost' })),
})

worker = runWorker({
  lease,
  job: indexer,
  intervalMs: 5_000,
  log: (entry) => console.log(JSON.stringify({ level: 'info', role: 'indexer', ...entry })),
})
console.log(JSON.stringify({ level: 'info', event: 'indexer_started', programId: programId.toBase58() }))
