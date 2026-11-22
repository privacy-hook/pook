import type { Hono } from 'hono'
import { PublicKey } from '@solana/web3.js'
import {
  Address,
  computeFeeSplit,
  ClaimAuthorFeesBuildRequest,
  EnterBuildRequest,
  HookId,
  HooksQuery,
  MARINADE_PROGRAM_ID,
  MSOL_MINT,
  NotesQuery,
  NullifiersCheckRequest,
  ParseIdlRequest,
  ProveRequest,
  PublicBalanceQuery,
  PublishHookBuildRequest,
  QuoteRequest,
  RelayLeaveRequest,
  RelayRunRequest,
  RelaySeatRequest,
  RelayerQuoteQuery,
  RunsQuery,
  SCENARIOS,
  SeatsStateRequest,
  SimulateHookRequest,
  TxSubmitRequest,
  WSOL_MINT,
  errors,
  hookDraftToOnChain,
  isNativeSolMint,
  paginate,
  toBase64,
  type AuthorHookFee,
  type EncryptedNoteRecord,
  type HookDetail,
  type HookFormField,
  type PublicRun,
  type RelaySubmissionResponse,
  type Scenario,
  type SeatPosition,
  type TxStatusResponse,
} from '@pook/contract'
import {
  FIXTURE_ADDRESSES,
  FIXTURE_ASSETS,
  FIXTURE_AUTHOR_SHARE_BPS,
  FIXTURE_RUN_FEE_BPS,
  FIXTURE_AUTHOR_FEES,
  FIXTURE_CONFIG,
  FIXTURE_ERRORS,
  FIXTURE_HEALTH_READY,
  FIXTURE_HEALTH_WAITING,
  FIXTURE_HOOKS,
  FIXTURE_MARINADE_PARSED_IDL,
  FIXTURE_NOTES,
  FIXTURE_PARSED_IDL,
  FIXTURE_QUOTE,
  FIXTURE_RELAY_EXPIRED,
  FIXTURE_RELAY_FAILED,
  FIXTURE_RUNS,
  FIXTURE_SEATS,
  FIXTURE_SIMULATION_FAILED,
  FIXTURE_SIMULATION_PASSED,
  FIXTURE_STATS,
  FIXTURE_STATS_WAITING,
  fixtureAddress,
  fixtureSignature,
  fixtureTransaction,
  toHookSummary,
} from '@pook/contract/fixtures'
import { env, fail } from './config.js'
import { findAuthorityPda, findConfigPda, findHookPda, findStagePda } from './chain/pda.js'
import type { ApiVariables } from './engines/server/app.js'
import { FixtureSessions, fixtureScenario, type FixtureVariables } from './engines/server/fixture.js'
import { readJson, readParam, readQuery } from './engines/server/input.js'
import { EventHub, streamEvent, streamEvents, type StreamEvent } from './engines/server/sse.js'

/** Derives real Pook program ID and canonical PDAs from configured `POOK_PROGRAM_ID`. */
function fixtureProgramAddresses() {
  const programId = new PublicKey(env.POOK_PROGRAM_ID ?? FIXTURE_ADDRESSES.pookProgram)
  const [authorityPda] = findAuthorityPda(programId)
  const [stagePda] = findStagePda(programId)
  const [configPda] = findConfigPda(programId)
  return {
    programId,
    programIdStr: programId.toBase58(),
    authorityPda: authorityPda.toBase58(),
    stagePda: stagePda.toBase58(),
    configPda: configPda.toBase58(),
    hookAddress: (hookId: string) => findHookPda(programId, hookId)[0].toBase58(),
  }
}

type SessionState = {
  hooks: HookDetail[]
  runs: PublicRun[]
  notes: EncryptedNoteRecord[]
  spentNullifiers: Set<string>
  seats: SeatPosition[]
  authorFees: AuthorHookFee[]
  txs: Map<string, TxStatusResponse & { pendingHook?: HookDetail; pendingClaimHookIds?: string[] }>
  relays: Map<string, RelaySubmissionResponse>
  seq: number
}

function createSessionState(scenario: string | null): SessionState {
  const addrs = fixtureProgramAddresses()
  if (scenario === 'waiting' || scenario === 'empty') {
    return {
      hooks: [],
      runs: [],
      notes: [],
      spentNullifiers: new Set(),
      seats: [],
      authorFees: [],
      txs: new Map(),
      relays: new Map(),
      seq: 1,
    }
  }
  const noBalance = scenario === 'no_balance'
  const noSeats = scenario === 'no_seats' || noBalance
  const hooks = structuredClone(FIXTURE_HOOKS).map((h) => ({ ...h, address: addrs.hookAddress(h.id) }))
  const runs = structuredClone(FIXTURE_RUNS).map((r) => ({
    ...r,
    hookAddress: addrs.hookAddress(r.hookId),
    stageAuthority: addrs.stagePda,
  }))
  const notes = noBalance ? [] : structuredClone(FIXTURE_NOTES).map((n) => ({ ...n, ownerTag: addrs.authorityPda }))
  const authorFees = structuredClone(FIXTURE_AUTHOR_FEES.hooks).map((f) => ({ ...f, hookAddress: addrs.hookAddress(f.hookId) }))
  return {
    hooks,
    runs,
    notes,
    spentNullifiers: new Set(),
    seats: noSeats ? [] : structuredClone(FIXTURE_SEATS),
    authorFees,
    txs: new Map(),
    relays: new Map(),
    seq: 1,
  }
}

function assetByMint(mint: string | null | undefined) {
  return FIXTURE_ASSETS.find((a) => a.mint === mint) ?? null
}

function encodeFixtureNote(payload: Record<string, unknown>) {
  return toBase64(new TextEncoder().encode(`POOK_FIXTURE_NOTE:${JSON.stringify(payload)}`))
}

export function registerFixtureRoutes(app: Hono<{ Variables: FixtureVariables<Scenario> & ApiVariables }>, hub = new EventHub<StreamEvent>()) {
  const sessions = new FixtureSessions<SessionState>(createSessionState)

  app.use('*', fixtureScenario({ scenarios: SCENARIOS, errors: FIXTURE_ERRORS, status: errors.status }))

  app.get('/health', (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') return c.json({ ...FIXTURE_HEALTH_WAITING, asOf: new Date().toISOString() })
    const addrs = fixtureProgramAddresses()
    return c.json({ ...FIXTURE_HEALTH_READY, programId: addrs.programIdStr, asOf: new Date().toISOString() })
  })

  app.get('/v1/config', (c) => {
    const scenario = c.get('scenario')
    const now = new Date().toISOString()
    const addrs = fixtureProgramAddresses()
    if (scenario === 'waiting') {
      return c.json({ ...FIXTURE_CONFIG, status: 'waiting', programId: null, authorityPda: null, stagePda: null, configPda: null, asOf: now })
    }
    return c.json({
      ...FIXTURE_CONFIG,
      programId: addrs.programIdStr,
      authorityPda: addrs.authorityPda,
      stagePda: addrs.stagePda,
      configPda: addrs.configPda,
      asOf: now,
    })
  })

  app.get('/v1/stats', (c) => {
    const scenario = c.get('scenario')
    const now = new Date().toISOString()
    if (scenario === 'waiting') return c.json({ ...FIXTURE_STATS_WAITING, asOf: now })
    const state = sessions.get(c, scenario)
    if (scenario === 'empty') {
      return c.json({ status: 'fixture', hooksCount: 0, runsCount: 0, activeSeatsCount: 0, volumeByAsset: [], asOf: now })
    }
    return c.json({
      ...FIXTURE_STATS,
      hooksCount: state.hooks.length,
      runsCount: state.hooks.reduce((sum, h) => sum + h.stats.runsCount, 0),
      activeSeatsCount: state.seats.filter((s) => s.status === 'open').length,
      asOf: now,
    })
  })

  app.get('/v1/hooks', (c) => {
    const scenario = c.get('scenario')
    const query = readQuery(c, HooksQuery)
    const now = new Date().toISOString()
    if (scenario === 'waiting') {
      return c.json({ status: 'waiting', ...paginate([], query, now) })
    }
    const state = sessions.get(c, scenario)
    let items = state.hooks
    if (query.protocol) items = items.filter((h) => h.protocol.toLowerCase() === query.protocol!.toLowerCase())
    if (query.kind) items = items.filter((h) => h.kind === query.kind)
    if (query.q) {
      const term = query.q.toLowerCase()
      items = items.filter(
        (h) =>
          h.id.toLowerCase().includes(term) ||
          h.protocolName.toLowerCase().includes(term) ||
          h.label.toLowerCase().includes(term) ||
          h.description.toLowerCase().includes(term),
      )
    }
    return c.json({ status: 'fixture', ...paginate(items.map(toHookSummary), query, now) })
  })

  app.get('/v1/hooks/:id', (c) => {
    const scenario = c.get('scenario')
    const id = readParam(c, 'id', HookId)
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'read', retryable: true })
    const state = sessions.get(c, scenario)
    const hook = state.hooks.find((h) => h.id === id)
    if (!hook) fail('NOT_FOUND', `Hook "${id}" was not found.`, { stage: 'read' })
    const recentRuns = state.runs.filter((r) => r.hookId === id).slice(0, 10)
    return c.json({ hook, recentRuns, asOf: new Date().toISOString() })
  })

  app.post('/v1/hooks/:id/quote', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true })
    if (scenario === 'no_route') fail('NO_ROUTE', 'No route is available for this asset pair and amount.', { stage: 'build', retryable: true })
    const id = readParam(c, 'id', HookId)
    const body = await readJson(c, QuoteRequest)
    const state = sessions.get(c, scenario)
    const hook = state.hooks.find((h) => h.id === id)
    if (!hook) fail('NOT_FOUND', `Hook "${id}" was not found.`, { stage: 'build' })

    const isBuiltinHook =
      hook.id === 'jupiter.swap' ||
      hook.id === 'jito.stake' ||
      hook.id === 'jito.unstake' ||
      hook.protocol === 'kamino'
    const mintIn =
      body.mintIn ??
      hook.mintIn ??
      (hook.id === 'kamino.borrow' || hook.id === 'kamino.collateral.withdraw' ? null : FIXTURE_ADDRESSES.usdcMint)
    const mintOut =
      body.mintOut ??
      hook.mintOut ??
      (hook.id === 'kamino.collateral.deposit' || hook.id === 'kamino.repay'
        ? null
        : !isBuiltinHook
          ? null
          : hook.id === 'kamino.supply'
            ? FIXTURE_ADDRESSES.kUsdcMint
            : hook.id === 'kamino.withdraw'
              ? FIXTURE_ADDRESSES.usdcMint
              : mintIn === FIXTURE_ADDRESSES.usdcMint
                ? FIXTURE_ADDRESSES.wsolMint
                : FIXTURE_ADDRESSES.usdcMint)
    if (!isBuiltinHook && mintOut !== null && body.minimumOut === undefined) {
      fail(
        'VALIDATION_ERROR',
        `Hook "${hook.id}" has no built-in quote resolver; provide minimumOut (base units of ${mintOut}) in the quote request.`,
        { stage: 'validation' },
      )
    }
    const minimumOutFromCaller = !isBuiltinHook && mintOut !== null
    const inAsset = assetByMint(mintIn)
    const outAsset = assetByMint(mintOut)
    const amountInBig = BigInt(body.amountIn)
    const expectedOutBig =
      mintOut === null
        ? 0n
        : minimumOutFromCaller
          ? BigInt(body.minimumOut!)
          : mintIn === FIXTURE_ADDRESSES.usdcMint && mintOut === FIXTURE_ADDRESSES.wsolMint
            ? (amountInBig * 6033680n) / 1000000n
            : mintIn === FIXTURE_ADDRESSES.wsolMint && mintOut === FIXTURE_ADDRESSES.usdcMint
              ? (amountInBig * 165736n) / 1000000000n
              : mintIn === FIXTURE_ADDRESSES.wsolMint && mintOut === FIXTURE_ADDRESSES.jitoSolMint
                ? (amountInBig * 8738n) / 10000n
                : mintIn === FIXTURE_ADDRESSES.jitoSolMint && mintOut === FIXTURE_ADDRESSES.wsolMint
                  ? (amountInBig * 11444n) / 10000n
                  : isNativeSolMint(mintIn) && mintOut === MSOL_MINT
                    ? (amountInBig * 8122n) / 10000n
                    : mintIn === MSOL_MINT && isNativeSolMint(mintOut)
                      ? (amountInBig * 12312n) / 10000n
                      : amountInBig
    const slippage = BigInt(body.slippageBps)
    const minOutBig = minimumOutFromCaller
      ? BigInt(body.minimumOut!)
      : expectedOutBig > 0n
        ? expectedOutBig - (expectedOutBig * slippage) / 10000n
        : 0n
    const feeAsset = outAsset ?? inAsset
    const relayerFeeBig = mintOut === null ? 0n : feeAsset?.decimals === 9 ? 2_000_000n : 500_000n
    const split = computeFeeSplit(mintOut === null ? 0n : expectedOutBig, FIXTURE_RUN_FEE_BPS, FIXTURE_AUTHOR_SHARE_BPS)
    const minRunFee = computeFeeSplit(mintOut === null ? 0n : minOutBig, FIXTURE_RUN_FEE_BPS, FIXTURE_AUTHOR_SHARE_BPS).runFee
    const netOutBig = expectedOutBig > split.runFee + relayerFeeBig ? expectedOutBig - split.runFee - relayerFeeBig : 0n
    const minimumNetOutBig = minOutBig > minRunFee + relayerFeeBig ? minOutBig - minRunFee - relayerFeeBig : 0n
    const expiresAt = new Date(Date.now() + 90_000).toISOString()
    const quoteId = `quote_${state.seq++}`

    return c.json({
      ...FIXTURE_QUOTE,
      quoteId,
      hookId: hook.id,
      mintIn,
      assetInSymbol: inAsset?.symbol ?? hook.assetInSymbol,
      amountIn: body.amountIn,
      mintOut,
      assetOutSymbol: outAsset?.symbol ?? hook.assetOutSymbol,
      expectedOut: expectedOutBig.toString(),
      minimumOut: minOutBig.toString(),
      ...(minimumOutFromCaller ? { minimumOutFromCaller: true } : {}),
      slippageBps: body.slippageBps,
      fees: {
        runFeeAmount: split.runFee.toString(),
        runFeeBps: FIXTURE_RUN_FEE_BPS,
        authorShareAmount: split.authorFee.toString(),
        authorShareBps: FIXTURE_AUTHOR_SHARE_BPS,
        protocolShareAmount: split.protocolFee.toString(),
        relayerFeeAmount: relayerFeeBig.toString(),
        feeAssetMint: mintOut,
        feeAssetSymbol: outAsset?.symbol ?? hook.assetOutSymbol,
      },
      netOut: netOutBig.toString(),
      minimumNetOut: minimumNetOutBig.toString(),
      chainPreview: {
        visible: {
          hookId: hook.id,
          targetProgram: hook.targetProgram,
          assetIn: inAsset?.symbol ?? hook.assetInSymbol,
          amountIn: body.amountIn,
          assetOut: outAsset?.symbol ?? hook.assetOutSymbol,
          minimumOut: minOutBig.toString(),
          relayer: FIXTURE_ADDRESSES.relayer,
        },
        hidden: FIXTURE_QUOTE.chainPreview.hidden,
      },
      routeSummary: `${inAsset?.symbol ?? 'Asset'} -> ${outAsset?.symbol ?? 'Asset'} via ${hook.protocolName}`,
      expiresAt,
    })
  })

  app.get('/v1/runs', (c) => {
    const scenario = c.get('scenario')
    const query = readQuery(c, RunsQuery)
    const now = new Date().toISOString()
    if (scenario === 'waiting') {
      return c.json({ status: 'waiting', ...paginate([], query, now) })
    }
    const state = sessions.get(c, scenario)
    let items = state.runs
    if (query.hookId) items = items.filter((r) => r.hookId === query.hookId)
    if (query.protocol) items = items.filter((r) => r.protocol === query.protocol)
    return c.json({ status: 'fixture', ...paginate(items, query, now) })
  })

  app.get('/v1/runs/stream', (c) => {
    const scenario = c.get('scenario')
    const hookId = c.req.query('hookId')
    return streamEvents(c, {
      hub,
      filter: (event) => {
        if (!hookId || event.type !== 'run') return true
        const data = event.data as PublicRun | undefined
        return data?.hookId === hookId
      },
      ready: () => ({ status: scenario === 'waiting' ? 'waiting' : 'fixture' }),
    })
  })

  app.get('/v1/notes', (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'scan_failed') {
      fail('SCAN_FAILED', 'Could not scan encrypted notes from the indexer. Retry.', { stage: 'read', retryable: true })
    }
    const query = readQuery(c, NotesQuery)
    const state = sessions.get(c, scenario)
    let items = state.notes
    if (query.ownerTag) items = items.filter((n) => n.ownerTag === query.ownerTag)
    if (query.afterSlot) items = items.filter((n) => BigInt(n.slot) > BigInt(query.afterSlot!))
    return c.json(paginate(items, query))
  })

  app.post('/v1/notes/nullifiers', async (c) => {
    const scenario = c.get('scenario')
    const body = await readJson(c, NullifiersCheckRequest)
    const state = sessions.get(c, scenario)
    const spent = Object.fromEntries(body.nullifiers.map((nf) => [nf, state.spentNullifiers.has(nf)]))
    return c.json({ spent, asOf: new Date().toISOString() })
  })

  app.post('/v1/seats/state', async (c) => {
    const scenario = c.get('scenario')
    const body = await readJson(c, SeatsStateRequest)
    const state = sessions.get(c, scenario)
    const requested = new Set(body.seatAddresses)
    const seats = state.seats.filter((s) => requested.has(s.seatAddress))
    return c.json({ seats, asOf: new Date().toISOString() })
  })

  app.post('/v1/enter/build', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true })
    const body = await readJson(c, EnterBuildRequest)
    const state = sessions.get(c, scenario)
    const buildId = `build_enter_${state.seq++}`
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 60_000).toISOString()
    const asset = assetByMint(body.mint)
    const sig = fixtureSignature(`enter:${buildId}`)
    state.txs.set(buildId, {
      id: buildId,
      action: 'enter',
      status: 'built',
      signature: null,
      slot: null,
      updatedAt: now.toISOString(),
    })
    // Record note upon submission in /v1/tx/submit by stashing metadata in note list right after submit
    state.notes.unshift({
      commitment: `0x${buildId.padEnd(64, '0').slice(0, 64)}`,
      treeId: 0,
      leafIndex: 200 + state.seq,
      slot: String(472512100 + state.seq),
      signature: sig,
      ownerTag: fixtureProgramAddresses().authorityPda,
      ciphertextBase64: encodeFixtureNote({
        kind: 'balance',
        action: 'enter',
        mint: body.mint,
        symbol: asset?.symbol ?? 'TOKEN',
        decimals: asset?.decimals ?? 6,
        amount: body.amount,
        nullifier: `nf_${buildId}`,
      }),
      txViewingPkBase64: body.outputViewingPkBase64 ?? FIXTURE_NOTES[0]!.txViewingPkBase64,
      saltBase64: FIXTURE_NOTES[0]!.saltBase64,
      timestamp: now.toISOString(),
    })

    return c.json({
      buildId,
      action: 'enter',
      transactionBase64: fixtureTransaction(`enter:${buildId}`),
      blockhash: fixtureAddress(`bh:${buildId}`),
      lastValidBlockHeight: String(472512300 + state.seq),
      networkFeeLamports: '5000',
      expiresAt,
    })
  })

  app.post('/v1/tx/submit', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'send', retryable: true })
    const body = await readJson(c, TxSubmitRequest)
    const state = sessions.get(c, scenario)
    const existing = state.txs.get(body.buildId)
    if (!existing) fail('NOT_FOUND', `Transaction build "${body.buildId}" was not found.`, { stage: 'send' })

    const now = new Date().toISOString()
    const signature = body.signature ?? fixtureSignature(`tx:${body.buildId}`)
    const slot = String(472512200 + state.seq++)

    if (existing.pendingHook) {
      const published: HookDetail = { ...existing.pendingHook, publishSignature: signature, publishedAt: now }
      if (!state.hooks.some((h) => h.id === published.id)) {
        state.hooks.unshift(published)
      }
    }
    if (existing.pendingClaimHookIds?.length) {
      const claimed = new Set(existing.pendingClaimHookIds)
      for (const fee of state.authorFees) {
        if (claimed.has(fee.hookId)) {
          fee.claimableAmount = '0'
          fee.lastClaimedAt = now
        }
      }
    }

    const confirmed: TxStatusResponse = {
      id: existing.id,
      action: existing.action,
      status: 'confirmed',
      signature,
      slot,
      updatedAt: now,
    }
    state.txs.set(body.buildId, confirmed)
    state.txs.set(signature, confirmed)
    return c.json(confirmed)
  })

  app.get('/v1/tx/:id', (c) => {
    const scenario = c.get('scenario')
    const id = c.req.param('id')
    const state = sessions.get(c, scenario)
    const tx = state.txs.get(id)
    if (!tx) fail('NOT_FOUND', `Transaction "${id}" was not found.`, { stage: 'read' })
    return c.json(tx)
  })

  app.post('/v1/prover/prove', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'proving', retryable: true })
    const body = await readJson(c, ProveRequest)
    const state = sessions.get(c, scenario)
    const proofId = `proof_${body.circuit}_${state.seq++}`
    return c.json({
      proofId,
      circuit: body.circuit,
      proofBase64: toBase64(new Uint8Array(128).fill(7)),
      publicInputsHex: ['01'.repeat(32)],
      privateTxHashHex: 'ab'.repeat(32),
      provingMs: 285,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
  })

  app.get('/v1/prover/circuits', (c) => {
    const scenario = c.get('scenario')
    const ready = scenario !== 'waiting'
    return c.json({
      status: ready ? 'fixture' : 'waiting',
      circuits: ['run', 'leave', 'seat_open', 'seat_close'].map((circuit) => ({
        circuit,
        xbcSha256: ready ? '11'.repeat(32) : null,
        pkSha256: ready ? '22'.repeat(32) : null,
        vkSha256: ready ? '33'.repeat(32) : null,
        available: ready,
      })),
      asOf: new Date().toISOString(),
    })
  })

  app.post('/v1/photon/:method', (c) => {
    const method = c.req.param('method')
    return c.json({ jsonrpc: '2.0', id: 1, result: { method, items: [], value: [] } })
  })

  app.get('/v1/wallets/:wallet/balance', (c) => {
    const scenario = c.get('scenario')
    const wallet = readParam(c, 'wallet', Address)
    const query = readQuery(c, PublicBalanceQuery)
    const mint = query.mint ?? FIXTURE_ADDRESSES.wsolMint
    const asset = assetByMint(mint)
    const amount =
      scenario === 'no_balance' || scenario === 'empty'
        ? '0'
        : mint === FIXTURE_ADDRESSES.usdcMint
          ? '500000000'
          : mint === FIXTURE_ADDRESSES.jitoSolMint
            ? '1500000000'
            : '4200000000'
    return c.json({
      wallet,
      mint,
      symbol: asset?.symbol ?? null,
      decimals: asset?.decimals ?? 9,
      amount,
      asOf: new Date().toISOString(),
    })
  })

  app.get('/v1/relayer/quote', (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true })
    const query = readQuery(c, RelayerQuoteQuery)
    const asset = assetByMint(query.mint)
    return c.json({
      relayer: FIXTURE_ADDRESSES.relayer,
      mint: query.mint,
      feeAmount: asset?.decimals === 9 ? '2000000' : '500000',
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
  })

  app.post('/v1/relayer/run', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'relay', retryable: true })
    const body = await readJson(c, RelayRunRequest)
    const state = sessions.get(c, scenario)
    const hook = state.hooks.find((h) => h.id === body.hookId)
    if (!hook) fail('NOT_FOUND', `Hook "${body.hookId}" was not found.`, { stage: 'relay' })

    if (scenario === 'run_failed') return c.json({ ...FIXTURE_RELAY_FAILED, hookId: hook.id, updatedAt: new Date().toISOString() }, 201)
    if (scenario === 'run_expired') return c.json({ ...FIXTURE_RELAY_EXPIRED, hookId: hook.id, updatedAt: new Date().toISOString() }, 201)

    const relayId = `relay_run_${state.seq++}`
    const now = new Date().toISOString()
    const signature = fixtureSignature(`relay:${relayId}`)
    const slot = String(472512300 + state.seq)
    const mintIn = body.mintIn ?? hook.mintIn
    const mintOut = body.mintOut ?? hook.mintOut
    const inAsset = assetByMint(mintIn)
    const outAsset = assetByMint(mintOut)
    const amountOut = body.minimumOut === '0' ? body.amountIn : body.minimumOut

    const addrs = fixtureProgramAddresses()
    const runRecord: PublicRun = {
      signature,
      slot,
      hookId: hook.id,
      hookAddress: hook.address,
      protocol: hook.protocol,
      kind: hook.kind,
      mintIn: mintIn ?? null,
      assetInSymbol: inAsset?.symbol ?? hook.assetInSymbol,
      amountIn: body.amountIn,
      mintOut: mintOut ?? null,
      assetOutSymbol: outAsset?.symbol ?? hook.assetOutSymbol,
      amountOut,
      runFeeAmount: computeFeeSplit(BigInt(amountOut), FIXTURE_RUN_FEE_BPS, FIXTURE_AUTHOR_SHARE_BPS).runFee.toString(),
      relayerFeeAmount: body.relayerFee,
      stageAuthority: addrs.stagePda,
      relayer: FIXTURE_ADDRESSES.relayer,
      status: 'confirmed',
      timestamp: now,
    }
    state.runs.unshift(runRecord)
    hook.stats.runsCount += 1
    hook.stats.volumeIn = (BigInt(hook.stats.volumeIn) + BigInt(body.amountIn)).toString()
    hook.stats.volumeOut = (BigInt(hook.stats.volumeOut) + BigInt(amountOut)).toString()
    hook.stats.lastRunAt = now

    // Update fixture seat collateral/debt when running Kamino seat hooks in this session.
    if (hook.kind === 'seat' && body.seatAddress) {
      const seat = state.seats.find((s) => s.seatAddress === body.seatAddress)
      if (seat) {
        if (hook.id === 'kamino.collateral.deposit' && mintIn) {
          const existingCol = seat.collateral.find((a) => a.mint === mintIn)
          if (existingCol) existingCol.amount = (BigInt(existingCol.amount) + BigInt(body.amountIn)).toString()
          else seat.collateral.push({ mint: mintIn, symbol: inAsset?.symbol ?? 'SOL', decimals: inAsset?.decimals ?? 9, amount: body.amountIn, usdValue: '100.00' })
          seat.status = 'open'
        } else if (hook.id === 'kamino.borrow' && mintOut) {
          const existingDebt = seat.debt.find((a) => a.mint === mintOut)
          if (existingDebt) existingDebt.amount = (BigInt(existingDebt.amount) + BigInt(amountOut)).toString()
          else seat.debt.push({ mint: mintOut, symbol: outAsset?.symbol ?? 'USDC', decimals: outAsset?.decimals ?? 6, amount: amountOut, usdValue: '10.00' })
          seat.healthFactor = '2.40'
        } else if (hook.id === 'kamino.repay' && mintIn) {
          const existingDebt = seat.debt.find((a) => a.mint === mintIn)
          if (existingDebt) {
            const rem = BigInt(existingDebt.amount) - BigInt(body.amountIn)
            if (rem <= 0n) seat.debt = seat.debt.filter((a) => a.mint !== mintIn)
            else existingDebt.amount = rem.toString()
          }
          if (!seat.debt.length) seat.healthFactor = null
        } else if (hook.id === 'kamino.collateral.withdraw' && mintOut) {
          const existingCol = seat.collateral.find((a) => a.mint === mintOut)
          if (existingCol) {
            const rem = BigInt(existingCol.amount) - BigInt(amountOut)
            if (rem <= 0n) seat.collateral = seat.collateral.filter((a) => a.mint !== mintOut)
            else existingCol.amount = rem.toString()
          }
          if (!seat.collateral.length && !seat.debt.length) seat.status = 'empty'
        }
        seat.updatedAt = now
      }
    }

    if (mintOut) {
      state.notes.unshift({
        commitment: `0x${relayId.padEnd(64, 'a').slice(0, 64)}`,
        treeId: 0,
        leafIndex: 300 + state.seq,
        slot,
        signature,
        ownerTag: addrs.authorityPda,
        ciphertextBase64: encodeFixtureNote({
          kind: 'balance',
          action: 'run',
          hookId: hook.id,
          mint: mintOut,
          symbol: outAsset?.symbol ?? 'TOKEN',
          decimals: outAsset?.decimals ?? 6,
          amount: amountOut,
          nullifier: `nf_${relayId}`,
        }),
        txViewingPkBase64: FIXTURE_NOTES[0]!.txViewingPkBase64,
        saltBase64: FIXTURE_NOTES[0]!.saltBase64,
        timestamp: now,
      })
    }

    const submission: RelaySubmissionResponse = {
      relayId,
      kind: 'run',
      status: 'confirmed',
      signature,
      slot,
      hookId: hook.id,
      relayerFee: body.relayerFee,
      run: runRecord,
      expiresAt: new Date(Number(body.expiryUnixTs) * 1000).toISOString(),
      updatedAt: now,
    }
    state.relays.set(relayId, submission)
    hub.publish(streamEvent('run', runRecord))
    return c.json(submission, 201)
  })

  app.post('/v1/relayer/leave', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'relay', retryable: true })
    const body = await readJson(c, RelayLeaveRequest)
    const state = sessions.get(c, scenario)

    if (scenario === 'run_failed') return c.json({ ...FIXTURE_RELAY_FAILED, kind: 'leave', hookId: null, updatedAt: new Date().toISOString() }, 201)
    if (scenario === 'run_expired') return c.json({ ...FIXTURE_RELAY_EXPIRED, kind: 'leave', hookId: null, updatedAt: new Date().toISOString() }, 201)

    const relayId = `relay_leave_${state.seq++}`
    const now = new Date().toISOString()
    const signature = fixtureSignature(`leave:${relayId}`)
    const slot = String(472512400 + state.seq)
    const submission: RelaySubmissionResponse = {
      relayId,
      kind: 'leave',
      status: 'confirmed',
      signature,
      slot,
      hookId: null,
      relayerFee: body.relayerFee,
      run: null,
      expiresAt: new Date(Number(body.expiryUnixTs) * 1000).toISOString(),
      updatedAt: now,
    }
    state.relays.set(relayId, submission)
    return c.json(submission, 201)
  })

  app.post('/v1/relayer/seat/open', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'relay', retryable: true })
    const body = await readJson(c, RelaySeatRequest)
    const state = sessions.get(c, scenario)
    const relayId = `relay_seat_open_${state.seq++}`
    const now = new Date().toISOString()
    const signature = fixtureSignature(`seat_open:${relayId}`)
    const slot = String(472512450 + state.seq)
    const seatAddress = body.seatAddress ?? fixtureAddress(`seat:${body.seatCommitmentHex}`)
    if (!state.seats.some((s) => s.seatAddress === seatAddress)) {
      const addrs = fixtureProgramAddresses()
      state.seats.unshift({
        seatAddress,
        commitmentHex: body.seatCommitmentHex,
        openerRelayer: FIXTURE_ADDRESSES.relayer,
        protocol: 'kamino',
        protocolName: 'Kamino',
        obligationAddress: fixtureAddress(`obligation:${seatAddress}`),
        status: 'open',
        collateral: [],
        debt: [],
        depositedValueUsd: '0.00',
        borrowFactorAdjustedDebtUsd: '0.00',
        unhealthyBorrowValueUsd: '0.00',
        healthFactor: null,
        actions: ['kamino.collateral.deposit', 'kamino.borrow', 'kamino.repay', 'kamino.collateral.withdraw'],
        updatedAt: now,
      })
      state.notes.unshift({
        commitment: `0x${body.seatCommitmentHex}`,
        treeId: 0,
        leafIndex: 400 + state.seq,
        slot,
        signature,
        ownerTag: addrs.authorityPda,
        ciphertextBase64: encodeFixtureNote({
          kind: 'seat',
          action: 'run',
          protocol: 'kamino',
          seatAddress,
          seatCommitmentHex: body.seatCommitmentHex,
          mint: WSOL_MINT,
          symbol: 'SOL',
          decimals: 9,
          amount: '0',
          nullifier: `nf_seat_${seatAddress}`,
        }),
        txViewingPkBase64: FIXTURE_NOTES[0]!.txViewingPkBase64,
        saltBase64: FIXTURE_NOTES[0]!.saltBase64,
        timestamp: now,
      })
    }
    const submission: RelaySubmissionResponse = {
      relayId,
      kind: 'open_seat',
      status: 'confirmed',
      signature,
      slot,
      hookId: null,
      seatAddress,
      relayerFee: '0',
      run: null,
      expiresAt: new Date(Number(body.expiryUnixTs) * 1000).toISOString(),
      updatedAt: now,
    }
    state.relays.set(relayId, submission)
    return c.json(submission, 201)
  })

  app.post('/v1/relayer/seat/close', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'relay', retryable: true })
    const body = await readJson(c, RelaySeatRequest)
    const state = sessions.get(c, scenario)
    const relayId = `relay_seat_close_${state.seq++}`
    const now = new Date().toISOString()
    const signature = fixtureSignature(`seat_close:${relayId}`)
    const slot = String(472512460 + state.seq)
    const seatAddress = body.seatAddress ?? fixtureAddress(`seat:${body.seatCommitmentHex}`)
    const existing = state.seats.find((s) => s.seatAddress === seatAddress || s.commitmentHex === body.seatCommitmentHex)
    if (existing) {
      existing.status = 'closed'
      existing.updatedAt = now
    }
    state.spentNullifiers.add(`nf_seat_${seatAddress}`)
    const submission: RelaySubmissionResponse = {
      relayId,
      kind: 'close_seat',
      status: 'confirmed',
      signature,
      slot,
      hookId: null,
      seatAddress,
      relayerFee: '0',
      run: null,
      expiresAt: new Date(Number(body.expiryUnixTs) * 1000).toISOString(),
      updatedAt: now,
    }
    state.relays.set(relayId, submission)
    return c.json(submission, 201)
  })

  app.get('/v1/relayer/runs/:relayId', (c) => {
    const scenario = c.get('scenario')
    const relayId = c.req.param('relayId')
    const state = sessions.get(c, scenario)
    const relay = state.relays.get(relayId)
    if (!relay) fail('NOT_FOUND', `Relayed submission "${relayId}" was not found.`, { stage: 'read' })
    return c.json(relay)
  })

  app.post('/v1/hooks/parse-idl', async (c) => {
    const body = await readJson(c, ParseIdlRequest)
    if (body.idlJson) {
      try {
        const parsed = JSON.parse(body.idlJson) as {
          address?: string
          name?: string
          metadata?: { name?: string; version?: string }
          version?: string
          instructions?: {
            name: string
            discriminator?: number[]
            args?: { name: string; type: unknown }[]
            accounts?: { name: string; writable?: boolean; isMut?: boolean; signer?: boolean; isSigner?: boolean }[]
          }[]
        }
        if (!Array.isArray(parsed.instructions) || parsed.instructions.length === 0) {
          fail('IDL_INVALID', 'The provided IDL JSON has no instructions.', { stage: 'validation' })
        }
        return c.json({
          programId: body.programId ?? parsed.address ?? null,
          programName: parsed.metadata?.name ?? parsed.name ?? 'custom_program',
          version: parsed.metadata?.version ?? parsed.version ?? null,
          instructions: parsed.instructions.map((ix) => {
            const disc = Array.isArray(ix.discriminator)
              ? ix.discriminator.map((b) => b.toString(16).padStart(2, '0')).join('')
              : '00'.repeat(8)
            let offset = disc.length / 2
            const args = (ix.args ?? []).map((a) => {
              const typeStr = typeof a.type === 'string' ? a.type : 'bytes'
              const length = typeStr === 'u8' || typeStr === 'bool' ? 1 : typeStr === 'u16' ? 2 : typeStr === 'u32' ? 4 : typeStr === 'u128' ? 16 : typeStr === 'pubkey' || typeStr === 'publicKey' ? 32 : 8
              const out = { name: a.name, type: typeStr, offset, length }
              offset += length
              return out
            })
            return {
              name: ix.name,
              discriminator: disc,
              args,
              accounts: (ix.accounts ?? []).map((acc, index) => ({
                index,
                name: acc.name,
                writable: Boolean(acc.writable ?? acc.isMut),
                signer: Boolean(acc.signer ?? acc.isSigner),
              })),
            }
          }),
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'ApiFailure') throw error
        fail('IDL_INVALID', 'Could not parse JSON as a Solana program IDL.', { stage: 'validation' })
      }
    }
    if (body.programId === MARINADE_PROGRAM_ID) {
      return c.json(FIXTURE_MARINADE_PARSED_IDL)
    }
    return c.json({ ...FIXTURE_PARSED_IDL, programId: body.programId ?? FIXTURE_PARSED_IDL.programId })
  })

  app.post('/v1/hooks/simulate', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'simulation', retryable: true })
    const body = await readJson(c, SimulateHookRequest)
    if (scenario === 'simulation_failed') {
      return c.json({ ...FIXTURE_SIMULATION_FAILED, accountCount: body.hook.accountsTemplate.length + 10 })
    }
    const addrs = fixtureProgramAddresses()
    const isMarinadeDeposit =
      body.hook.targetProgram === MARINADE_PROGRAM_ID &&
      body.hook.instructionName === 'deposit' &&
      isNativeSolMint(body.hook.mintIn) &&
      body.hook.mintOut === MSOL_MINT
    if (isMarinadeDeposit) {
      return c.json({
        passed: true,
        computeUnits: 198420,
        logs: [
          `Program ${addrs.programIdStr} invoke [1]`,
          'Program log: Instruction: Run',
          'Program log: App proof verified (94702 CU)',
          `Program ${FIXTURE_ADDRESSES.ringsProgram} invoke [2]`,
          'Program log: Instruction: Transact (withdraw SOL to stage)',
          `Program ${FIXTURE_ADDRESSES.ringsProgram} success`,
          `Program ${MARINADE_PROGRAM_ID} invoke [2]`,
          'Program log: Instruction: Deposit',
          `Program ${MARINADE_PROGRAM_ID} success`,
          'Program log: Stage-out minimum check passed (mSOL)',
          `Program ${FIXTURE_ADDRESSES.ringsProgram} invoke [2]`,
          'Program log: Instruction: Deposit (output mSOL note)',
          `Program ${FIXTURE_ADDRESSES.ringsProgram} success`,
          `Program ${addrs.programIdStr} consumed 198420 of 1400000 compute units`,
          `Program ${addrs.programIdStr} success`,
        ],
        estimatedTxBytes: 1520,
        accountCount: body.hook.accountsTemplate.length + 10,
      })
    }
    return c.json({
      ...FIXTURE_SIMULATION_PASSED,
      logs: FIXTURE_SIMULATION_PASSED.logs.map((line) => line.replaceAll(FIXTURE_ADDRESSES.pookProgram, addrs.programIdStr)),
      accountCount: body.hook.accountsTemplate.length + 10,
    })
  })

  app.post('/v1/hooks/publish/build', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true })
    const body = await readJson(c, PublishHookBuildRequest)
    const state = sessions.get(c, scenario)
    if (state.hooks.some((h) => h.id === body.hook.id)) {
      fail('HOOK_ALREADY_EXISTS', `Hook "${body.hook.id}" is already published.`, { stage: 'build' })
    }
    const addrs = fixtureProgramAddresses()
    const onChain = hookDraftToOnChain(body.hook)
    const buildId = `build_publish_${state.seq++}`
    const now = new Date()
    const inAsset = assetByMint(body.hook.mintIn)
    const outAsset = assetByMint(body.hook.mintOut)
    const defaultFormFields: HookFormField[] =
      body.hook.formFields && body.hook.formFields.length > 0
        ? body.hook.formFields
        : [
            {
              name: 'amountIn',
              kind: 'amount',
              label: inAsset ? `Amount (${inAsset.symbol})` : 'Amount',
              required: true,
              placeholder: '1.0',
            },
          ]
    const pendingHook: HookDetail = {
      id: body.hook.id,
      address: addrs.hookAddress(body.hook.id),
      protocol: body.hook.protocol,
      protocolName: body.hook.protocolName,
      label: body.hook.label,
      description: body.hook.description,
      kind: body.hook.kind,
      targetProgram: body.hook.targetProgram,
      instructionName: body.hook.instructionName,
      discriminator: body.hook.discriminator,
      dataTemplate: body.hook.dataTemplate,
      accountsTemplate: body.hook.accountsTemplate,
      companionInstructions: body.hook.companionInstructions ?? [],
      mintInConstraint: onChain.mintIn,
      mintOutConstraint: onChain.mintOut,
      wrapSolIn: onChain.wrapSolIn,
      unwrapSolOut: onChain.unwrapSolOut,
      dataTemplateHex: onChain.dataTemplateHex,
      dataSlots: onChain.dataSlots,
      accountSlots: onChain.accountSlots,
      companions: onChain.companions,
      formFields: defaultFormFields,
      mintIn: body.hook.mintIn,
      mintOut: body.hook.mintOut,
      assetInSymbol: body.hook.assetInSymbol ?? inAsset?.symbol ?? null,
      assetOutSymbol: body.hook.assetOutSymbol ?? outAsset?.symbol ?? null,
      author: body.author,
      authorShareBps: FIXTURE_AUTHOR_SHARE_BPS,
      immutable: true,
      sdkCall: `pook.run("${body.hook.id}", { amount })`,
      stats: { runsCount: 0, volumeIn: '0', volumeOut: '0', lastRunAt: null },
      publishedAt: now.toISOString(),
      publishSignature: fixtureSignature(`publish:${body.hook.id}`),
    }

    state.txs.set(buildId, {
      id: buildId,
      action: 'publish_hook',
      status: 'built',
      signature: null,
      slot: null,
      updatedAt: now.toISOString(),
      pendingHook,
    })

    return c.json({
      buildId,
      action: 'publish_hook',
      transactionBase64: fixtureTransaction(`publish:${body.hook.id}`),
      blockhash: fixtureAddress(`bh:${buildId}`),
      lastValidBlockHeight: String(472512500 + state.seq),
      networkFeeLamports: '5000',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    })
  })

  app.get('/v1/authors/:wallet/fees', (c) => {
    const scenario = c.get('scenario')
    const wallet = readParam(c, 'wallet', Address)
    const state = sessions.get(c, scenario)
    return c.json({
      author: wallet,
      hooks: state.authorFees,
      asOf: new Date().toISOString(),
    })
  })

  app.post('/v1/authors/:wallet/claim/build', async (c) => {
    const scenario = c.get('scenario')
    if (scenario === 'waiting') fail('PROGRAM_UNAVAILABLE', 'The Pook program is not deployed yet.', { stage: 'build', retryable: true })
    readParam(c, 'wallet', Address)
    const body = await readJson(c, ClaimAuthorFeesBuildRequest)
    const state = sessions.get(c, scenario)
    const buildId = `build_claim_${state.seq++}`
    const now = new Date()
    state.txs.set(buildId, {
      id: buildId,
      action: 'claim_author_fees',
      status: 'built',
      signature: null,
      slot: null,
      updatedAt: now.toISOString(),
      pendingClaimHookIds: body.hookIds,
    })
    return c.json({
      buildId,
      action: 'claim_author_fees',
      transactionBase64: fixtureTransaction(`claim:${buildId}`),
      blockhash: fixtureAddress(`bh:${buildId}`),
      lastValidBlockHeight: String(472512600 + state.seq),
      networkFeeLamports: '5000',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    })
  })

  return app
}
