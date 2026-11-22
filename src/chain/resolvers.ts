import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PublicKey, type Connection } from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import {
  KAMINO_FARMS_PROGRAM_ID,
  KAMINO_LEND_PROGRAM_ID,
  KAMINO_MAIN_MARKET,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_ID,
  WSOL_MINT,
  computeCallHash,
  computeFeeSplit,
  decodeHookAccount,
  fromBase64,
  fromHex,
  isNativeSolMint,
  resolveCpiData,
  toBase64,
  toHex,
  type HookDetail,
  type QuoteRequest,
  type QuoteResponse,
  type ResolvedAccount,
  type ResolvedInstruction,
  type SeatAssetPosition,
  type SeatPosition,
  type WireConfigAccount,
  type WireHookAccount,
} from '@pook/contract'
import { JITOSOL_MINT, USDC_MINT, env, fail, relayerFeeForMint } from '../config.js'
import { JupiterError, createJupiterClient } from '../engines/jupiter/http.js'
import { pdaSwapInstructions } from '../engines/jupiter/pda-taker.js'
import { minimumOut, quoteExactIn } from '../engines/jupiter/quote.js'
import { writeRouteArgs } from '../engines/jupiter/route-data.js'
import { assetMeta, detectTokenProgram } from './accounts.js'
import {
  collateralToLiquidityBaseUnits,
  computeKaminoHealthFactor,
  decodeKaminoObligation,
  fetchKaminoReserves,
  sfToUsdString,
} from './kamino-obligation.js'
import { findAta, findAuthorFeesPda, findStagePda } from './pda.js'

const JITO_STAKE_POOL = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb')
const JITO_STAKE_POOL_PROGRAM = new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy')
const KAMINO_LEND_PROGRAM = new PublicKey(KAMINO_LEND_PROGRAM_ID)
const KAMINO_FARMS_PROGRAM = new PublicKey(KAMINO_FARMS_PROGRAM_ID)
const KAMINO_MAIN_MARKET_PK = new PublicKey(KAMINO_MAIN_MARKET)
const KAMINO_SOL_RESERVE = new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q')
const KAMINO_USDC_RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59')
const KAMINO_KUSDC_MINT = 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D'
const KAMINO_KSOL_MINT = '2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1'
const SCOPE_ORACLE_PRICES = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH')
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111')
const SYSVAR_RENT = new PublicKey(SYSVAR_RENT_ID)
const SYSTEM_PROGRAM = new PublicKey(SYSTEM_PROGRAM_ID)

// Jupiter Lend (Earn): the lending program and its liquidity layer.
const JUPITER_LEND_PROGRAM = new PublicKey('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9')
const JUPITER_LIQUIDITY_PROGRAM = new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC')
const JUPITER_LENDING_DISC = Buffer.from([135, 199, 82, 16, 249, 131, 182, 241])
/** `token_exchange_price` is fixed point with 12 decimals. */
const JUPITER_EXCHANGE_PRICE_PRECISION = 1_000_000_000_000n

// Kamino Anchor discriminators (sha256("global:<ix>")[0..8])
const KAMINO_REFRESH_RESERVE_DISC = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102])
const KAMINO_REFRESH_OBLIGATION_DISC = Buffer.from([33, 132, 147, 228, 151, 192, 72, 89])
const KAMINO_INIT_OBLIGATION_FARMS_DISC = Buffer.from([136, 63, 15, 186, 211, 152, 168, 164])

type CapturedLocalnetRoute = {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  slippageBps: number
  stagePda: string
  stageInAta?: string
  stageOutAta?: string
  swapInstruction: {
    programId: string
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]
    data: string
  }
  setupInstructions?: {
    programId: string
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]
    data: string
  }[]
}

export type QuoteResolveContext = {
  connection: Connection
  programId: PublicKey
  hook: HookDetail
  onChainHook: WireHookAccount
  config: WireConfigAccount | null
  relayerPubkey: string
  request: QuoteRequest
}

let jupiterClientSingleton: ReturnType<typeof createJupiterClient> | null = null
function getJupiterClient() {
  jupiterClientSingleton ??= createJupiterClient({ apiKey: env.JUPITER_API_KEY })
  return jupiterClientSingleton
}

function serializeSetupIx(ix: ReturnType<typeof createAssociatedTokenAccountIdempotentInstruction>): ResolvedInstruction {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isWritable: k.isWritable,
      isSigner: k.isSigner,
    })),
    dataBase64: toBase64(ix.data),
  }
}

function loadLocalnetJupiterRoute(mintIn: string, mintOut: string): CapturedLocalnetRoute | null {
  const filename =
    mintIn === USDC_MINT && isNativeSolMint(mintOut)
      ? 'jupiter-usdc-to-sol.json'
      : isNativeSolMint(mintIn) && mintOut === USDC_MINT
        ? 'jupiter-sol-to-usdc.json'
        : null
  if (!filename) return null
  const fullPath = path.resolve(env.LOCALNET_ROUTES_DIR, filename)
  try {
    const raw = JSON.parse(readFileSync(fullPath, 'utf8')) as CapturedLocalnetRoute & {
      quoteResponse?: {
        inputMint: string
        outputMint: string
        inAmount: string
        outAmount: string
        otherAmountThreshold: string
        slippageBps: number
      }
      swapInstructions?: {
        swapInstruction: CapturedLocalnetRoute['swapInstruction']
        setupInstructions?: CapturedLocalnetRoute['setupInstructions']
      }
    }
    if (raw.quoteResponse && raw.swapInstructions?.swapInstruction) {
      const ix = raw.swapInstructions.swapInstruction
      return {
        inputMint: raw.quoteResponse.inputMint,
        outputMint: raw.quoteResponse.outputMint,
        inAmount: raw.quoteResponse.inAmount,
        outAmount: raw.quoteResponse.outAmount,
        otherAmountThreshold: raw.quoteResponse.otherAmountThreshold,
        slippageBps: raw.quoteResponse.slippageBps,
        stagePda: ix.accounts[1]?.pubkey ?? raw.stagePda,
        stageInAta: ix.accounts[2]?.pubkey,
        stageOutAta: ix.accounts[3]?.pubkey,
        swapInstruction: ix,
        setupInstructions: raw.swapInstructions.setupInstructions,
      }
    }
    return raw
  } catch {
    return null
  }
}

async function resolveJupiterSwap(ctx: QuoteResolveContext): Promise<{
  mintIn: string
  mintOut: string
  expectedOut: bigint
  minimumOut: bigint
  callerData: Uint8Array
  callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  callerRemainingWritable: number[]
  resolvedAccounts: ResolvedAccount[]
  setupInstructions: ResolvedInstruction[]
  companionInstructions: ResolvedInstruction[]
  routeSummary: string
}> {
  const { connection, programId, request, relayerPubkey } = ctx
  const mintIn = request.mintIn ?? USDC_MINT
  const mintOut = request.mintOut ?? (mintIn === USDC_MINT ? WSOL_MINT : USDC_MINT)
  const amountIn = BigInt(request.amountIn)
  const slippageBps = request.slippageBps ?? 50
  const [stagePda] = findStagePda(programId)
  const relayerPk = new PublicKey(relayerPubkey)

  const tokenProgramIn = await detectTokenProgram(connection, new PublicKey(mintIn))
  const tokenProgramOut = await detectTokenProgram(connection, new PublicKey(mintOut))
  const [stageInAta] = findAta(stagePda, new PublicKey(mintIn), tokenProgramIn)
  const [stageOutAta] = findAta(stagePda, new PublicKey(mintOut), tokenProgramOut)

  const setupInstructions: ResolvedInstruction[] = [
    serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageInAta, stagePda, new PublicKey(mintIn), tokenProgramIn)),
    serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageOutAta, stagePda, new PublicKey(mintOut), tokenProgramOut)),
  ]

  let swapAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  let swapData: Uint8Array
  let expectedOut: bigint
  let minOut: bigint
  let routeSummary: string

  if (env.CLUSTER === 'localnet') {
    const captured = loadLocalnetJupiterRoute(mintIn, mintOut)
    if (!captured) {
      return fail('NO_ROUTE', `No captured localnet Jupiter route for ${mintIn} -> ${mintOut}.`, { stage: 'build', retryable: false })
    }
    const origIn = BigInt(captured.inAmount)
    const origOut = BigInt(captured.outAmount)
    expectedOut = (amountIn * origOut) / (origIn > 0n ? origIn : 1n)
    minOut = minimumOut(expectedOut, slippageBps)

    // Retarget stage PDA and stage ATAs if the deployed POOK_PROGRAM_ID differs from capture time.
    const oldStage = new PublicKey(captured.stagePda)
    const [oldStageIn] = findAta(oldStage, new PublicKey(mintIn), tokenProgramIn)
    const [oldStageOut] = findAta(oldStage, new PublicKey(mintOut), tokenProgramOut)
    const replace = (pk: string): string => {
      if (pk === captured.stagePda) return stagePda.toBase58()
      if (pk === oldStageIn.toBase58() || pk === captured.stageInAta) return stageInAta.toBase58()
      if (pk === oldStageOut.toBase58() || pk === captured.stageOutAta) return stageOutAta.toBase58()
      return pk
    }

    swapAccounts = captured.swapInstruction.accounts.map((a) => ({
      pubkey: replace(a.pubkey),
      isWritable: a.isWritable,
      isSigner: false,
    }))
    const rawData = fromBase64(captured.swapInstruction.data)
    swapData =
      amountIn === origIn && slippageBps === captured.slippageBps
        ? rawData
        : new Uint8Array(writeRouteArgs(rawData, { inAmount: amountIn, quotedOutAmount: expectedOut, slippageBps }))
    routeSummary = `${assetMeta(mintIn)?.symbol ?? 'Token'} -> ${assetMeta(mintOut)?.symbol ?? 'Token'} via Jupiter (localnet)`
  } else {
    const client = getJupiterClient()
    let quote: Awaited<ReturnType<typeof quoteExactIn>>
    let pdaSwap: Awaited<ReturnType<typeof pdaSwapInstructions>>
    try {
      quote = await quoteExactIn(client, {
        inputMint: mintIn,
        outputMint: mintOut,
        amount: amountIn,
        slippageBps,
        maxAccounts: 28,
      })
      pdaSwap = await pdaSwapInstructions(client, {
        quote,
        taker: stagePda,
        payer: relayerPk,
        source: stageInAta,
        destination: stageOutAta,
        useSharedAccounts: false,
      })
    } catch (error) {
      if (error instanceof JupiterError) {
        if (error.code === 'NO_ROUTE') {
          return fail('NO_ROUTE', error.message, { stage: 'build', retryable: false })
        }
        return fail('UPSTREAM_UNAVAILABLE', error.message, { stage: 'build', retryable: error.retryable })
      }
      throw error
    }
    for (const s of pdaSwap.setup) {
      setupInstructions.push({
        programId: s.programId.toBase58(),
        accounts: s.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isWritable: k.isWritable, isSigner: k.isSigner })),
        dataBase64: toBase64(s.data),
      })
    }
    swapAccounts = pdaSwap.swap.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isWritable: k.isWritable,
      isSigner: false,
    }))
    swapData = new Uint8Array(pdaSwap.swap.data)
    expectedOut = quote.outAmount
    minOut = quote.minimumOut
    routeSummary = `${assetMeta(mintIn)?.symbol ?? 'Token'} -> ${assetMeta(mintOut)?.symbol ?? 'Token'} via Jupiter`
  }

  // On-chain `jupiter.swap` account slots:
  // [0] Caller (token_program), [1] StagePda (signer), [2] StageIn (W), [3] StageOut (W), [4] CallerRemaining
  // Therefore callerAccounts = [swapAccounts[0], ...swapAccounts.slice(4)]
  const callerAccounts = [swapAccounts[0]!, ...swapAccounts.slice(4)]
  const callerRemainingWritable = swapAccounts.slice(4).map((a) => (a.isWritable ? 1 : 0))
  const resolvedAccounts: ResolvedAccount[] = swapAccounts.map((a, index) => ({
    index,
    name: index === 0 ? 'token_program' : index === 1 ? 'stage_pda' : index === 2 ? 'stage_in' : index === 3 ? 'stage_out' : `route_account_${index}`,
    address: a.pubkey,
    writable: a.isWritable,
    signer: index === 1,
  }))

  return {
    mintIn,
    mintOut,
    expectedOut,
    minimumOut: minOut,
    callerData: swapData,
    callerAccounts,
    callerRemainingWritable,
    resolvedAccounts,
    setupInstructions,
    companionInstructions: [],
    routeSummary,
  }
}

/**
 * Reads Jito StakePool on-chain state (SPL Stake Pool Borsh layout) to compute live SOL <-> JitoSOL rate
 * and pool accounts (reserve_stake, manager_fee_account, pool_mint, withdraw_authority PDA).
 */
async function readJitoStakePool(connection: Connection): Promise<{
  withdrawAuthority: PublicKey
  reserveStake: PublicKey
  managerFeeAccount: PublicKey
  poolMint: PublicKey
  totalLamports: bigint
  poolTokenSupply: bigint
}> {
  const [withdrawAuthority] = PublicKey.findProgramAddressSync([JITO_STAKE_POOL.toBytes(), Buffer.from('withdraw')], JITO_STAKE_POOL_PROGRAM)
  const info = await connection.getAccountInfo(JITO_STAKE_POOL, 'confirmed')
  if (!info?.data || info.data.length < 274) {
    // Fallback to known mainnet addresses & conservative rate if stake pool account isn't loaded yet.
    return {
      withdrawAuthority,
      reserveStake: new PublicKey('BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL'),
      managerFeeAccount: new PublicKey('feeeFLLsam6xZJFc6UQFrHqkvVt4jfmVvi2BRLkUZ4i'),
      poolMint: new PublicKey(JITOSOL_MINT),
      totalLamports: 1_144_000_000n,
      poolTokenSupply: 1_000_000_000n,
    }
  }
  const data = info.data
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  // SPL StakePool layout:
  // 0: account_type (1)
  // 1..33: manager (32), 33..65: staker (32), 65..97: stake_deposit_authority (32), 97: stake_withdraw_bump_seed (1)
  // 98..130: validator_list (32), 130..162: reserve_stake (32), 162..194: pool_mint (32), 194..226: manager_fee_account (32)
  // 226..258: token_program_id (32), 258..266: total_lamports (u64), 266..274: pool_token_supply (u64)
  const reserveStake = new PublicKey(data.subarray(130, 162))
  const poolMint = new PublicKey(data.subarray(162, 194))
  const managerFeeAccount = new PublicKey(data.subarray(194, 226))
  const totalLamports = view.getBigUint64(258, true)
  const poolTokenSupply = view.getBigUint64(266, true)
  return {
    withdrawAuthority,
    reserveStake,
    managerFeeAccount,
    poolMint,
    totalLamports: totalLamports > 0n ? totalLamports : 1n,
    poolTokenSupply: poolTokenSupply > 0n ? poolTokenSupply : 1n,
  }
}

async function resolveJito(ctx: QuoteResolveContext): Promise<{
  mintIn: string
  mintOut: string
  expectedOut: bigint
  minimumOut: bigint
  callerData: Uint8Array
  callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  callerRemainingWritable: number[]
  resolvedAccounts: ResolvedAccount[]
  setupInstructions: ResolvedInstruction[]
  companionInstructions: ResolvedInstruction[]
  routeSummary: string
}> {
  const { connection, programId, hook, onChainHook, request, relayerPubkey } = ctx
  const isStake = hook.id === 'jito.stake'
  const mintIn = isStake ? WSOL_MINT : JITOSOL_MINT
  const mintOut = isStake ? JITOSOL_MINT : WSOL_MINT
  const amountIn = BigInt(request.amountIn)
  const slippageBps = request.slippageBps ?? 50
  const pool = await readJitoStakePool(connection)
  const [stagePda] = findStagePda(programId)
  const [stageJitoAta] = findAta(stagePda, pool.poolMint, TOKEN_PROGRAM_ID)
  const relayerPk = new PublicKey(relayerPubkey)

  const expectedOut = isStake
    ? (amountIn * pool.poolTokenSupply) / pool.totalLamports
    : (amountIn * pool.totalLamports) / pool.poolTokenSupply
  const minOut = minimumOut(expectedOut, slippageBps)

  const setupInstructions: ResolvedInstruction[] = [
    serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageJitoAta, stagePda, pool.poolMint, TOKEN_PROGRAM_ID)),
  ]

  // Build caller accounts for Fixed/Caller slots declared on-chain
  const callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = []
  const resolvedAccounts: ResolvedAccount[] = []
  const fixedPoolMap: Record<number, PublicKey> = isStake
    ? {
        0: JITO_STAKE_POOL,
        1: pool.withdrawAuthority,
        2: pool.reserveStake,
        3: stagePda,
        4: stageJitoAta,
        5: pool.managerFeeAccount,
        6: stageJitoAta,
        7: pool.poolMint,
        8: SYSTEM_PROGRAM,
        9: TOKEN_PROGRAM_ID,
      }
    : {
        0: JITO_STAKE_POOL,
        1: pool.withdrawAuthority,
        2: stagePda,
        3: stageJitoAta,
        4: pool.reserveStake,
        5: stagePda,
        6: pool.managerFeeAccount,
        7: pool.poolMint,
        8: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
        9: new PublicKey('StakeHistory1111111111111111111111111111111'),
        10: new PublicKey('Stake11111111111111111111111111111111111111'),
        11: TOKEN_PROGRAM_ID,
      }

  onChainHook.accountSlots.forEach((slot, index) => {
    const fallbackPk = fixedPoolMap[index]?.toBase58() ?? slot.pubkey
    const addr =
      slot.kind === 'StagePda'
        ? stagePda.toBase58()
        : slot.kind === 'StageIn'
          ? (isStake ? stagePda.toBase58() : stageJitoAta.toBase58())
          : slot.kind === 'StageOut'
            ? (isStake ? stageJitoAta.toBase58() : stagePda.toBase58())
            : slot.kind === 'Payer'
              ? relayerPubkey
              : slot.kind === 'Fixed'
                ? slot.pubkey
                : fallbackPk
    resolvedAccounts.push({
      index,
      name: hook.accountsTemplate[index]?.name ?? `account_${index}`,
      address: addr,
      writable: slot.isWritable,
      signer: slot.isSigner,
    })
    if (slot.kind === 'Fixed' || slot.kind === 'Caller') {
      callerAccounts.push({ pubkey: addr, isWritable: slot.isWritable, isSigner: false })
    }
  })

  return {
    mintIn,
    mintOut,
    expectedOut,
    minimumOut: minOut,
    callerData: new Uint8Array(0),
    callerAccounts,
    callerRemainingWritable: [],
    resolvedAccounts,
    setupInstructions,
    companionInstructions: [],
    routeSummary: isStake ? 'SOL -> JitoSOL via Jito Stake Pool' : 'JitoSOL -> SOL via Jito Stake Pool',
  }
}

type JupiterLendMarket = {
  mint: PublicKey
  fTokenMint: PublicKey
  lending: PublicKey
  tokenProgram: PublicKey
  tokenExchangePrice: bigint
  rewardsRateModel: PublicKey
  supplyReserve: PublicKey
  supplyPosition: PublicKey
}

/** Lending account by fToken mint; a market never changes its accounts, so one lookup per mint. */
const jupiterLendingByFToken = new Map<string, PublicKey>()

/** Reads one Jupiter Lend market from chain, named by its underlying mint or by its earn token (fToken). */
async function readJupiterLendMarket(connection: Connection, named: PublicKey): Promise<JupiterLendMarket> {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, JUPITER_LEND_PROGRAM)[0]
  const lendingFor = (mint: PublicKey) =>
    pda([Buffer.from('lending'), mint.toBuffer(), pda([Buffer.from('f_token_mint'), mint.toBuffer()]).toBuffer()])
  const decode = (data: Buffer | null | undefined) =>
    data && data.length >= 195 && data.subarray(0, 8).equals(JUPITER_LENDING_DISC) ? data : null

  let lending = lendingFor(named)
  let data = decode((await connection.getAccountInfo(lending, 'confirmed'))?.data)
  if (!data) {
    // Not an underlying asset: find the Lending account whose f_token_mint is this mint.
    let found = jupiterLendingByFToken.get(named.toBase58())
    if (!found) {
      const hits = await connection.getProgramAccounts(JUPITER_LEND_PROGRAM, {
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { dataSize: 196 },
          { memcmp: { offset: 40, bytes: named.toBase58() } },
        ],
      })
      found = hits[0]?.pubkey
      if (found) jupiterLendingByFToken.set(named.toBase58(), found)
    }
    if (found) {
      lending = found
      data = decode((await connection.getAccountInfo(lending, 'confirmed'))?.data)
    }
  }
  if (!data) {
    return fail('NO_ROUTE', `Jupiter Lend has no market for ${named.toBase58()}.`, { stage: 'build', retryable: false })
  }
  const mint = new PublicKey(data.subarray(8, 40))
  return {
    mint,
    fTokenMint: new PublicKey(data.subarray(40, 72)),
    lending,
    tokenProgram: await detectTokenProgram(connection, mint),
    tokenExchangePrice: data.readBigUInt64LE(115),
    rewardsRateModel: new PublicKey(data.subarray(75, 107)),
    supplyReserve: new PublicKey(data.subarray(131, 163)),
    supplyPosition: new PublicKey(data.subarray(163, 195)),
  }
}

/** The Caller accounts of `jupiter.lend.supply` and `jupiter.lend.withdraw` in slot order, and the quote. */
async function resolveJupiterLend(ctx: QuoteResolveContext): Promise<{
  mintIn: string
  mintOut: string
  expectedOut: bigint
  minimumOut: bigint
  callerData: Uint8Array
  callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  callerRemainingWritable: number[]
  resolvedAccounts: ResolvedAccount[]
  setupInstructions: ResolvedInstruction[]
  companionInstructions: ResolvedInstruction[]
  routeSummary: string
}> {
  const { connection, programId, hook, onChainHook, request, relayerPubkey } = ctx
  const isSupply = hook.id === 'jupiter.lend.supply'
  const named = request.mintIn ?? request.mintOut
  if (!named) return fail('VALIDATION_ERROR', 'Choose the asset to supply or withdraw.', { stage: 'validation', retryable: false })
  const market = await readJupiterLendMarket(connection, new PublicKey(isNativeSolMint(named) ? WSOL_MINT : named))
  const amountIn = BigInt(request.amountIn)
  const slippageBps = request.slippageBps ?? 50

  // Shares and assets convert at the stored exchange price; the minimum out leaves room for the update.
  const expectedOut = isSupply
    ? (amountIn * JUPITER_EXCHANGE_PRICE_PRECISION) / market.tokenExchangePrice
    : (amountIn * market.tokenExchangePrice) / JUPITER_EXCHANGE_PRICE_PRECISION
  const minOut = minimumOut(expectedOut, slippageBps)

  const [stagePda] = findStagePda(programId)
  const [stageAsset] = findAta(stagePda, market.mint, market.tokenProgram)
  const [stageFToken] = findAta(stagePda, market.fTokenMint, market.tokenProgram)
  const relayerPk = new PublicKey(relayerPubkey)
  const setupInstructions: ResolvedInstruction[] = [
    serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageAsset, stagePda, market.mint, market.tokenProgram)),
    serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageFToken, stagePda, market.fTokenMint, market.tokenProgram)),
  ]

  const liquidityPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, JUPITER_LIQUIDITY_PROGRAM)[0]
  const liquidity = liquidityPda([Buffer.from('liquidity')])
  const [lendingAdmin] = PublicKey.findProgramAddressSync([Buffer.from('lending_admin')], JUPITER_LEND_PROGRAM)
  const [vault] = findAta(liquidity, market.mint, market.tokenProgram)
  const byName: Record<string, PublicKey> = {
    mint: market.mint,
    lending: market.lending,
    fTokenMint: market.fTokenMint,
    supplyTokenReservesLiquidity: market.supplyReserve,
    lendingSupplyPositionOnLiquidity: market.supplyPosition,
    rateModel: liquidityPda([Buffer.from('rate_model'), market.mint.toBuffer()]),
    vault,
    claimAccount: liquidityPda([Buffer.from('user_claim'), lendingAdmin.toBuffer(), market.mint.toBuffer()]),
    rewardsRateModel: market.rewardsRateModel,
    tokenProgram: market.tokenProgram,
  }

  const callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = []
  const resolvedAccounts: ResolvedAccount[] = []
  onChainHook.accountSlots.forEach((slot, index) => {
    const name = hook.accountsTemplate[index]?.name ?? `account_${index}`
    let addr: string
    if (slot.kind === 'StagePda') addr = stagePda.toBase58()
    else if (slot.kind === 'StageIn') addr = (isSupply ? stageAsset : stageFToken).toBase58()
    else if (slot.kind === 'StageOut') addr = (isSupply ? stageFToken : stageAsset).toBase58()
    else if (slot.kind === 'Fixed') addr = slot.pubkey
    else {
      const pk = byName[name]
      if (!pk) return fail('CONFIGURATION_REQUIRED', `No Jupiter Lend account for slot ${name}.`, { stage: 'build', retryable: false })
      addr = pk.toBase58()
    }
    resolvedAccounts.push({ index, name, address: addr, writable: slot.isWritable, signer: slot.isSigner })
    if (slot.kind === 'Fixed' || slot.kind === 'Caller') {
      callerAccounts.push({ pubkey: addr, isWritable: slot.isWritable, isSigner: false })
    }
  })

  const asset = assetMeta(market.mint.toBase58())?.symbol ?? market.mint.toBase58().slice(0, 4)
  const earn = assetMeta(market.fTokenMint.toBase58())?.symbol ?? `jl${asset}`
  return {
    mintIn: (isSupply ? market.mint : market.fTokenMint).toBase58(),
    mintOut: (isSupply ? market.fTokenMint : market.mint).toBase58(),
    expectedOut,
    minimumOut: minOut,
    callerData: new Uint8Array(0),
    callerAccounts,
    callerRemainingWritable: [],
    resolvedAccounts,
    setupInstructions,
    companionInstructions: [],
    routeSummary: isSupply ? `${asset} -> ${earn} via Jupiter Lend` : `${earn} -> ${asset} via Jupiter Lend`,
  }
}

/** Derives Kamino vanilla Obligation PDA: [0, 0, owner, market, SystemProgram, SystemProgram]. */
export function deriveKaminoObligationPda(owner: PublicKey, market: PublicKey = KAMINO_MAIN_MARKET_PK): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), owner.toBytes(), market.toBytes(), SYSTEM_PROGRAM.toBytes(), SYSTEM_PROGRAM.toBytes()],
    KAMINO_LEND_PROGRAM,
  )
  return pda
}

function deriveKaminoObligationFarmPda(reserveFarmState: PublicKey, obligation: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user'), reserveFarmState.toBytes(), obligation.toBytes()],
    KAMINO_FARMS_PROGRAM,
  )
  return pda
}

function u64LeBytes(value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, value, true)
  return buf
}

async function resolveKamino(ctx: QuoteResolveContext): Promise<{
  mintIn: string | null
  mintOut: string | null
  expectedOut: bigint
  minimumOut: bigint
  callerData: Uint8Array
  callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  callerRemainingWritable: number[]
  resolvedAccounts: ResolvedAccount[]
  setupInstructions: ResolvedInstruction[]
  companionInstructions: ResolvedInstruction[]
  routeSummary: string
}> {
  const { connection, programId, hook, onChainHook, request, relayerPubkey } = ctx
  const [stagePda] = findStagePda(programId)
  const seatPk = request.seatAddress ? new PublicKey(request.seatAddress) : stagePda
  const obligationPda = deriveKaminoObligationPda(seatPk, KAMINO_MAIN_MARKET_PK)
  const amountIn = BigInt(request.amountIn)
  const slippageBps = request.slippageBps ?? 50
  const relayerPk = new PublicKey(relayerPubkey)

  const isSupply = hook.id === 'kamino.supply'
  const isWithdraw = hook.id === 'kamino.withdraw'
  const isColDeposit = hook.id === 'kamino.collateral.deposit'
  const isBorrow = hook.id === 'kamino.borrow'
  const isRepay = hook.id === 'kamino.repay'
  const isColWithdraw = hook.id === 'kamino.collateral.withdraw'

  // Pick the reserve from requested mint (USDC/kUSDC vs SOL/kSOL)
  const hintMint = request.mintIn ?? request.mintOut ?? hook.mintIn ?? hook.mintOut ?? USDC_MINT
  const isUsdcReserve = hintMint === USDC_MINT || hintMint === KAMINO_KUSDC_MINT
  const reservePk = isUsdcReserve ? KAMINO_USDC_RESERVE : KAMINO_SOL_RESERVE

  // Batch-read the target reserve and (for seat hooks) the obligation to discover existing deposit reserves.
  const [reservesMap, obInfo] = await Promise.all([
    fetchKaminoReserves(connection, [reservePk.toBase58(), KAMINO_SOL_RESERVE.toBase58(), KAMINO_USDC_RESERVE.toBase58()]),
    hook.kind === 'seat' ? connection.getAccountInfo(obligationPda, 'confirmed').catch(() => null) : Promise.resolve(null),
  ])
  const reserve = reservesMap.get(reservePk.toBase58())
  const decodedOb = obInfo?.data ? decodeKaminoObligation(obInfo.data) : null

  const liqMint = reserve?.liquidityMint ?? (isUsdcReserve ? USDC_MINT : WSOL_MINT)
  const colMint = reserve?.collateralMint ?? (isUsdcReserve ? KAMINO_KUSDC_MINT : KAMINO_KSOL_MINT)
  const liqTokenProgram = reserve?.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58()
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync([Buffer.from('lma'), KAMINO_MAIN_MARKET_PK.toBytes()], KAMINO_LEND_PROGRAM)

  const mintIn = isBorrow || isColWithdraw ? null : isWithdraw ? colMint : (request.mintIn ?? liqMint)
  const mintOut = isColDeposit || isRepay ? null : isSupply ? colMint : (request.mintOut ?? liqMint)

  // Ensure stage ATAs exist for any SPL/WSOL mints involved (seat_pda owns token stage ATAs for seat hooks).
  const tokenStageOwner = hook.kind === 'seat' ? seatPk : stagePda
  const setupInstructions: ResolvedInstruction[] = []
  const ataMints = new Set<string>()
  for (const m of [mintIn, mintOut]) {
    if (!m) continue
    if (!isNativeSolMint(m) || onChainHook.wrapSolIn || onChainHook.unwrapSolOut) {
      ataMints.add(isNativeSolMint(m) ? WSOL_MINT : m)
    }
  }
  for (const m of ataMints) {
    const mPk = new PublicKey(m)
    const tp = await detectTokenProgram(connection, mPk)
    const [stageAta] = findAta(tokenStageOwner, mPk, tp)
    setupInstructions.push(serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageAta, tokenStageOwner, mPk, tp)))
  }

  // Farm setup + trailing CallerRemaining for seat hooks.
  const isDebtHook = isBorrow || isRepay
  const reserveFarmAddr = isDebtHook ? (reserve?.farmDebt ?? SYSTEM_PROGRAM_ID) : (reserve?.farmCollateral ?? SYSTEM_PROGRAM_ID)
  const hasFarm = reserveFarmAddr !== SYSTEM_PROGRAM_ID
  const obligationFarmPda = hasFarm ? deriveKaminoObligationFarmPda(new PublicKey(reserveFarmAddr), obligationPda) : KAMINO_LEND_PROGRAM

  if (hook.kind === 'seat' && hasFarm) {
    const farmInfo = await connection.getAccountInfo(obligationFarmPda, 'confirmed').catch(() => null)
    if (!farmInfo) {
      setupInstructions.push({
        programId: KAMINO_LEND_PROGRAM.toBase58(),
        accounts: [
          { pubkey: relayerPubkey, isWritable: true, isSigner: true },
          { pubkey: seatPk.toBase58(), isWritable: false, isSigner: false },
          { pubkey: obligationPda.toBase58(), isWritable: false, isSigner: false },
          { pubkey: lendingMarketAuthority.toBase58(), isWritable: false, isSigner: false },
          { pubkey: reservePk.toBase58(), isWritable: true, isSigner: false },
          { pubkey: reserveFarmAddr, isWritable: true, isSigner: false },
          { pubkey: obligationFarmPda.toBase58(), isWritable: true, isSigner: false },
          { pubkey: KAMINO_MAIN_MARKET_PK.toBase58(), isWritable: false, isSigner: false },
          { pubkey: KAMINO_FARMS_PROGRAM.toBase58(), isWritable: false, isSigner: false },
          { pubkey: SYSVAR_RENT.toBase58(), isWritable: false, isSigner: false },
          { pubkey: SYSTEM_PROGRAM.toBase58(), isWritable: false, isSigner: false },
        ],
        dataBase64: toBase64(Buffer.concat([KAMINO_INIT_OBLIGATION_FARMS_DISC, Buffer.from([isDebtHook ? 1 : 0])])),
      })
    }
  }

  // Build companion refresh_reserve (for all active reserves + target reserve) and refresh_obligation.
  const refreshReserveSet = new Set<string>([reservePk.toBase58()])
  const obligationRefreshReserves: string[] = []
  if (decodedOb) {
    for (const d of decodedOb.deposits) {
      refreshReserveSet.add(d.depositReserve)
      obligationRefreshReserves.push(d.depositReserve)
    }
    for (const b of decodedOb.borrows) {
      refreshReserveSet.add(b.borrowReserve)
      obligationRefreshReserves.push(b.borrowReserve)
    }
  }

  const companionInstructions: ResolvedInstruction[] = []
  for (const comp of onChainHook.companions) {
    if (comp.programId !== KAMINO_LEND_PROGRAM.toBase58()) continue
    const discHex = comp.discriminatorHex.slice(0, comp.discLen * 2).toLowerCase()
    if (discHex === KAMINO_REFRESH_RESERVE_DISC.toString('hex')) {
      for (const rAddr of refreshReserveSet) {
        companionInstructions.push({
          programId: KAMINO_LEND_PROGRAM.toBase58(),
          accounts: [
            { pubkey: rAddr, isWritable: true, isSigner: false },
            { pubkey: KAMINO_MAIN_MARKET_PK.toBase58(), isWritable: false, isSigner: false },
            { pubkey: KAMINO_LEND_PROGRAM.toBase58(), isWritable: false, isSigner: false },
            { pubkey: KAMINO_LEND_PROGRAM.toBase58(), isWritable: false, isSigner: false },
            { pubkey: KAMINO_LEND_PROGRAM.toBase58(), isWritable: false, isSigner: false },
            { pubkey: SCOPE_ORACLE_PRICES.toBase58(), isWritable: false, isSigner: false },
          ],
          dataBase64: toBase64(KAMINO_REFRESH_RESERVE_DISC),
        })
      }
    } else if (discHex === KAMINO_REFRESH_OBLIGATION_DISC.toString('hex')) {
      companionInstructions.push({
        programId: KAMINO_LEND_PROGRAM.toBase58(),
        accounts: [
          { pubkey: KAMINO_MAIN_MARKET_PK.toBase58(), isWritable: false, isSigner: false },
          { pubkey: obligationPda.toBase58(), isWritable: true, isSigner: false },
          ...obligationRefreshReserves.map((rAddr) => ({ pubkey: rAddr, isWritable: false, isSigner: false })),
        ],
        dataBase64: toBase64(KAMINO_REFRESH_OBLIGATION_DISC),
      })
    }
  }

  const stageInAddr =
    mintIn && (!isNativeSolMint(mintIn) || onChainHook.wrapSolIn)
      ? findAta(tokenStageOwner, new PublicKey(isNativeSolMint(mintIn) ? WSOL_MINT : mintIn), new PublicKey(liqTokenProgram))[0].toBase58()
      : stagePda.toBase58()
  const stageOutAddr =
    mintOut && (!isNativeSolMint(mintOut) || onChainHook.unwrapSolOut)
      ? findAta(tokenStageOwner, new PublicKey(isNativeSolMint(mintOut) ? WSOL_MINT : mintOut), TOKEN_PROGRAM_ID)[0].toBase58()
      : stagePda.toBase58()

  // Trailing CallerRemaining accounts for seat hooks.
  const remainingMetas: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = []
  if (hook.kind === 'seat') {
    remainingMetas.push(
      { pubkey: hasFarm ? obligationFarmPda.toBase58() : KAMINO_LEND_PROGRAM.toBase58(), isWritable: hasFarm, isSigner: false },
      { pubkey: hasFarm ? reserveFarmAddr : KAMINO_LEND_PROGRAM.toBase58(), isWritable: hasFarm, isSigner: false },
    )
    if (isRepay) {
      remainingMetas.push({ pubkey: lendingMarketAuthority.toBase58(), isWritable: false, isSigner: false })
    }
    remainingMetas.push({ pubkey: KAMINO_FARMS_PROGRAM.toBase58(), isWritable: false, isSigner: false })
    if (isBorrow || isRepay) {
      for (const d of decodedOb?.deposits ?? []) {
        remainingMetas.push({ pubkey: d.depositReserve, isWritable: false, isSigner: false })
      }
    }
  }

  const callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = []
  const callerRemainingWritable: number[] = []
  const resolvedAccounts: ResolvedAccount[] = []

  const seatSlotByIndex: Record<number, string> = isColDeposit
    ? {
        1: obligationPda.toBase58(),
        2: KAMINO_MAIN_MARKET_PK.toBase58(),
        3: lendingMarketAuthority.toBase58(),
        4: reservePk.toBase58(),
        5: liqMint,
        6: reserve?.liquiditySupplyVault ?? SYSTEM_PROGRAM_ID,
        7: colMint,
        8: reserve?.collateralSupplyVault ?? SYSTEM_PROGRAM_ID,
        12: liqTokenProgram,
      }
    : isBorrow
      ? {
          1: obligationPda.toBase58(),
          2: KAMINO_MAIN_MARKET_PK.toBase58(),
          3: lendingMarketAuthority.toBase58(),
          4: reservePk.toBase58(),
          5: liqMint,
          6: reserve?.liquiditySupplyVault ?? SYSTEM_PROGRAM_ID,
          7: reserve?.liquidityFeeVault ?? SYSTEM_PROGRAM_ID,
          10: liqTokenProgram,
        }
      : isRepay
        ? {
            1: obligationPda.toBase58(),
            2: KAMINO_MAIN_MARKET_PK.toBase58(),
            3: reservePk.toBase58(),
            4: liqMint,
            5: reserve?.liquiditySupplyVault ?? SYSTEM_PROGRAM_ID,
            7: liqTokenProgram,
          }
        : isColWithdraw
          ? {
              1: obligationPda.toBase58(),
              2: KAMINO_MAIN_MARKET_PK.toBase58(),
              3: lendingMarketAuthority.toBase58(),
              4: reservePk.toBase58(),
              5: liqMint,
              6: reserve?.collateralSupplyVault ?? SYSTEM_PROGRAM_ID,
              7: colMint,
              8: reserve?.liquiditySupplyVault ?? SYSTEM_PROGRAM_ID,
              12: liqTokenProgram,
            }
          : {}

  const lookupSlotAddr = (slotIndex: number, slotName: string, fallback: string): string => {
    if (request.args?.[slotName]) return request.args[slotName]!
    if (seatSlotByIndex[slotIndex]) return seatSlotByIndex[slotIndex]!
    const n = slotName.toLowerCase()
    if (n.includes('obligation')) return obligationPda.toBase58()
    if (n.includes('market_authority') || n.includes('marketauthority')) return lendingMarketAuthority.toBase58()
    if (n.includes('market')) return KAMINO_MAIN_MARKET_PK.toBase58()
    if (n.includes('fee_receiver') || n.includes('feereceiver')) return reserve?.liquidityFeeVault ?? fallback
    if (n.includes('liquidity_mint') || n.includes('liquiditymint')) return liqMint
    if (n.includes('collateral_mint') || n.includes('collateralmint')) return colMint
    if (n.includes('liquidity_supply') || n.includes('liquiditysupply') || n.includes('source_liquidity') || n.includes('destination_liquidity')) {
      return reserve?.liquiditySupplyVault ?? fallback
    }
    if (n.includes('deposit_collateral') || n.includes('source_collateral') || n.includes('collateral_supply')) {
      return reserve?.collateralSupplyVault ?? fallback
    }
    if (n.includes('reserve')) return reservePk.toBase58()
    if (n.includes('instruction')) return SYSVAR_INSTRUCTIONS.toBase58()
    if (n.includes('liquidity_token_program') || n.includes('liquiditytokenprogram') || n === 'token_program' || n === 'tokenprogram') {
      return liqTokenProgram
    }
    if (n.includes('token_program') || n.includes('tokenprogram')) return TOKEN_PROGRAM_ID.toBase58()
    return fallback
  }

  onChainHook.accountSlots.forEach((slot, index) => {
    const slotName = hook.accountsTemplate[index]?.name ?? `account_${index}`
    if (slot.kind === 'CallerRemaining') {
      remainingMetas.forEach((rem, remIdx) => {
        resolvedAccounts.push({
          index: resolvedAccounts.length,
          name: `remaining_${remIdx}`,
          address: rem.pubkey,
          writable: rem.isWritable,
          signer: false,
        })
        callerAccounts.push(rem)
        callerRemainingWritable.push(rem.isWritable ? 1 : 0)
      })
      return
    }
    let addr = slot.pubkey
    if (slot.kind === 'StagePda') addr = stagePda.toBase58()
    else if (slot.kind === 'StageIn') addr = stageInAddr
    else if (slot.kind === 'StageOut') addr = stageOutAddr
    else if (slot.kind === 'SeatPda') addr = seatPk.toBase58()
    else if (slot.kind === 'Payer') addr = relayerPubkey
    else if (slot.kind === 'Caller') addr = lookupSlotAddr(index, slotName, slot.pubkey)

    resolvedAccounts.push({
      index: resolvedAccounts.length,
      name: slotName,
      address: addr,
      writable: slot.isWritable,
      signer: slot.isSigner,
    })
    if (slot.kind === 'Fixed' || slot.kind === 'Caller') {
      callerAccounts.push({ pubkey: addr, isWritable: slot.isWritable, isSigner: false })
    }
  })

  // Compute expected output & callerData for seat actions (`kamino.borrow` and `kamino.collateral.withdraw` pass u64 LE in callerData).
  let expectedOut = 0n
  let callerData: Uint8Array = new Uint8Array(0)
  if (isSupply && reserve) {
    const liq = collateralToLiquidityBaseUnits(1_000_000n, reserve)
    expectedOut = liq > 0n ? (amountIn * 1_000_000n) / liq : amountIn
  } else if (isWithdraw && reserve) {
    expectedOut = collateralToLiquidityBaseUnits(amountIn, reserve)
  } else if (isBorrow) {
    expectedOut = amountIn
    callerData = u64LeBytes(amountIn)
  } else if (isColWithdraw) {
    // Allow u64::MAX ("18446744073709551615") or explicit collateral amount to withdraw.
    const withdrawAll = amountIn >= 18446744073709551615n || request.args?.withdrawAll === 'true'
    const depositEntry = decodedOb?.deposits.find((d) => d.depositReserve === reservePk.toBase58())
    const colAmount = withdrawAll ? 18446744073709551615n : amountIn
    callerData = u64LeBytes(colAmount)
    const rawCol = depositEntry ? depositEntry.depositedAmount : amountIn
    expectedOut = reserve ? collateralToLiquidityBaseUnits(rawCol, reserve) : rawCol
  } else if (!isColDeposit && !isRepay) {
    expectedOut = amountIn
  }

  return {
    mintIn,
    mintOut,
    expectedOut,
    minimumOut: expectedOut > 0n ? minimumOut(expectedOut, slippageBps) : 0n,
    callerData,
    callerAccounts,
    callerRemainingWritable,
    resolvedAccounts,
    setupInstructions,
    companionInstructions,
    routeSummary: `${hook.label} via Kamino`,
  }
}

function parseRemainingAccountsArg(raw: string | undefined): { pubkey: string; isWritable: boolean; isSigner: boolean }[] {
  if (!raw || !raw.trim()) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as Array<{ pubkey: string; isWritable?: boolean; writable?: boolean }>
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => ({
      pubkey: new PublicKey(item.pubkey).toBase58(),
      isWritable: Boolean(item.isWritable ?? item.writable),
      isSigner: false,
    }))
  }
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const [addr, flags = ''] = entry.split(':')
      return {
        pubkey: new PublicKey(addr!.trim()).toBase58(),
        isWritable: flags.toLowerCase().includes('w'),
        isSigner: false,
      }
    })
}

async function resolveGenericHook(ctx: QuoteResolveContext): Promise<{
  mintIn: string | null
  mintOut: string | null
  expectedOut: bigint
  minimumOut: bigint
  minimumOutFromCaller?: boolean
  callerData: Uint8Array
  callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[]
  callerRemainingWritable: number[]
  resolvedAccounts: ResolvedAccount[]
  setupInstructions: ResolvedInstruction[]
  companionInstructions: ResolvedInstruction[]
  routeSummary: string
}> {
  const { connection, programId, hook, onChainHook, request, relayerPubkey } = ctx
  const [stagePda] = findStagePda(programId)
  const relayerPk = new PublicKey(relayerPubkey)

  const mintIn =
    onChainHook.mintIn.kind === 'None'
      ? null
      : onChainHook.mintIn.kind === 'Sol'
        ? WSOL_MINT
        : onChainHook.mintIn.kind === 'Spl'
          ? onChainHook.mintIn.mint
          : (request.mintIn ?? hook.mintIn ?? null)

  const mintOut =
    onChainHook.mintOut.kind === 'None'
      ? null
      : onChainHook.mintOut.kind === 'Sol'
        ? WSOL_MINT
        : onChainHook.mintOut.kind === 'Spl'
          ? onChainHook.mintOut.mint
          : (request.mintOut ?? hook.mintOut ?? null)

  if (mintOut !== null && request.minimumOut === undefined) {
    fail(
      'VALIDATION_ERROR',
      `Hook "${hook.id}" has no built-in quote resolver; provide minimumOut (base units of ${mintOut}) in the quote request.`,
      { stage: 'validation' },
    )
  }

  const callerMinOut = mintOut !== null ? BigInt(request.minimumOut!) : 0n
  const seatPk = request.seatAddress ? new PublicKey(request.seatAddress) : stagePda
  const tokenStageOwner = hook.kind === 'seat' ? seatPk : stagePda

  const tokenProgramIn = mintIn ? await detectTokenProgram(connection, new PublicKey(mintIn)) : TOKEN_PROGRAM_ID
  const tokenProgramOut = mintOut ? await detectTokenProgram(connection, new PublicKey(mintOut)) : TOKEN_PROGRAM_ID

  const stageInIsToken = Boolean(mintIn && (!isNativeSolMint(mintIn) || onChainHook.wrapSolIn))
  const stageOutIsToken = Boolean(mintOut && (!isNativeSolMint(mintOut) || onChainHook.unwrapSolOut))

  const stageInAddr = stageInIsToken
    ? findAta(tokenStageOwner, new PublicKey(isNativeSolMint(mintIn) ? WSOL_MINT : mintIn!), tokenProgramIn)[0].toBase58()
    : stagePda.toBase58()
  const stageOutAddr = stageOutIsToken
    ? findAta(tokenStageOwner, new PublicKey(isNativeSolMint(mintOut) ? WSOL_MINT : mintOut!), tokenProgramOut)[0].toBase58()
    : stagePda.toBase58()

  // Ensure stage ATAs exist for any SPL or wrapped-SOL stage accounts.
  const setupInstructions: ResolvedInstruction[] = []
  const ataMints = new Map<string, PublicKey>()
  if (stageInIsToken && mintIn) ataMints.set(isNativeSolMint(mintIn) ? WSOL_MINT : mintIn, tokenProgramIn)
  if (stageOutIsToken && mintOut) ataMints.set(isNativeSolMint(mintOut) ? WSOL_MINT : mintOut, tokenProgramOut)
  for (const [m, tp] of ataMints) {
    const mPk = new PublicKey(m)
    const [stageAta] = findAta(tokenStageOwner, mPk, tp)
    setupInstructions.push(serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(relayerPk, stageAta, tokenStageOwner, mPk, tp)))
  }

  const callerAccounts: { pubkey: string; isWritable: boolean; isSigner: boolean }[] = []
  const callerRemainingWritable: number[] = []
  const resolvedAccounts: ResolvedAccount[] = []
  const remainingFromArgs = parseRemainingAccountsArg(request.args?.remainingAccounts)

  onChainHook.accountSlots.forEach((slot, index) => {
    const slotName = hook.accountsTemplate[index]?.name ?? `account_${index}`
    if (slot.kind === 'CallerRemaining') {
      for (const rem of remainingFromArgs) {
        resolvedAccounts.push({
          index: resolvedAccounts.length,
          name: `remaining_${callerRemainingWritable.length}`,
          address: rem.pubkey,
          writable: rem.isWritable,
          signer: false,
        })
        callerAccounts.push(rem)
        callerRemainingWritable.push(rem.isWritable ? 1 : 0)
      }
      return
    }
    const addr =
      slot.kind === 'StagePda'
        ? stagePda.toBase58()
        : slot.kind === 'StageIn'
          ? stageInAddr
          : slot.kind === 'StageOut'
            ? stageOutAddr
            : slot.kind === 'SeatPda'
              ? seatPk.toBase58()
              : slot.kind === 'Payer'
                ? relayerPubkey
                : slot.kind === 'Fixed'
                  ? slot.pubkey
                  : (request.args?.[slotName] ?? request.args?.[`account_${index}`] ?? request.args?.[`slot_${index}`] ?? slot.pubkey)
    resolvedAccounts.push({
      index: resolvedAccounts.length,
      name: slotName,
      address: addr,
      writable: slot.isWritable,
      signer: slot.isSigner,
    })
    if (slot.kind === 'Fixed' || slot.kind === 'Caller') {
      callerAccounts.push({ pubkey: addr, isWritable: slot.isWritable, isSigner: false })
    }
  })

  const callerData = request.args?.callerDataHex ? fromHex(request.args.callerDataHex) : new Uint8Array(0)
  return {
    mintIn,
    mintOut,
    expectedOut: callerMinOut,
    minimumOut: callerMinOut,
    ...(mintOut !== null ? { minimumOutFromCaller: true } : {}),
    callerData,
    callerAccounts,
    callerRemainingWritable,
    resolvedAccounts,
    setupInstructions,
    companionInstructions: [],
    routeSummary: `${hook.label} via ${hook.protocolName}`,
  }
}

/** Resolves a hook quote, computing canonical on-chain `call_hash` and fee splits from live `Config`. */
export async function resolveHookQuote(ctx: QuoteResolveContext): Promise<QuoteResponse> {
  const { connection, hook, onChainHook, config, relayerPubkey, request } = ctx
  const resolved =
    hook.id === 'jupiter.swap'
      ? await resolveJupiterSwap(ctx)
      : hook.id === 'jito.stake' || hook.id === 'jito.unstake'
        ? await resolveJito(ctx)
        : hook.id === 'jupiter.lend.supply' || hook.id === 'jupiter.lend.withdraw'
          ? await resolveJupiterLend(ctx)
          : hook.protocol === 'kamino'
          ? await resolveKamino(ctx)
          : await resolveGenericHook(ctx)

  const amountIn = BigInt(request.amountIn)
  const programAmountIn = resolved.mintIn ? amountIn : 0n
  const feeMint = resolved.mintOut ?? resolved.mintIn ?? WSOL_MINT
  const relayerFee = resolved.mintOut ? relayerFeeForMint(feeMint) : 0n

  const runFeeBps = config ? config.runFeeBps : (env.RUN_FEE_BPS ?? null)
  const authorShareBps = config ? config.authorShareBps : (env.AUTHOR_SHARE_BPS ?? null)
  const feeBasis = resolved.expectedOut > 0n ? resolved.expectedOut : amountIn
  const split =
    runFeeBps !== null && authorShareBps !== null
      ? computeFeeSplit(feeBasis, runFeeBps, authorShareBps)
      : { runFee: 0n, authorFee: 0n, protocolFee: 0n }

  const totalFees = split.runFee + relayerFee
  const netOut = resolved.expectedOut > totalFees ? resolved.expectedOut - totalFees : 0n
  const minSplit =
    resolved.mintOut && runFeeBps !== null && authorShareBps !== null
      ? computeFeeSplit(resolved.minimumOut, runFeeBps, authorShareBps)
      : { runFee: 0n, authorFee: 0n, protocolFee: 0n }
  const minTotalFees = minSplit.runFee + relayerFee
  const minimumNetOut = resolved.mintOut && resolved.minimumOut > minTotalFees ? resolved.minimumOut - minTotalFees : 0n

  // Compute exact CPI data and canonical on-chain call_hash.
  const cpiData = resolveCpiData(onChainHook.dataTemplateHex, onChainHook.dataSlots, programAmountIn, resolved.minimumOut, resolved.callerData)
  const callHash = computeCallHash(
    onChainHook.targetProgram,
    Boolean(resolved.mintOut),
    resolved.mintOut,
    cpiData,
    resolved.resolvedAccounts.map((a) => ({ pubkey: a.address, isWritable: a.writable, isSigner: a.signer })),
  )

  const tokenProgramIn = resolved.mintIn ? (await detectTokenProgram(connection, new PublicKey(resolved.mintIn))).toBase58() : TOKEN_PROGRAM_ID.toBase58()
  const tokenProgramOut = resolved.mintOut ? (await detectTokenProgram(connection, new PublicKey(resolved.mintOut))).toBase58() : TOKEN_PROGRAM_ID.toBase58()

  // A run pays the author's share into the AuthorFees PDA's token account, the protocol share into
  // the fee recipient's, and the relayer fee into the relayer's: all three must exist before an SPL payout.
  const setupInstructions: ResolvedInstruction[] = []
  const seenAtaCreates = new Set<string>()
  const pushSetupIx = (ix: ResolvedInstruction) => {
    if (ix.programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && ix.accounts.length === 6) {
      const ownerAcc = ix.accounts[2]
      const mintAcc = ix.accounts[3]
      if (ownerAcc && mintAcc) {
        const key = `${ownerAcc.pubkey}:${mintAcc.pubkey}`
        if (seenAtaCreates.has(key)) return
        seenAtaCreates.add(key)
      }
    }
    setupInstructions.push(ix)
  }
  for (const ix of resolved.setupInstructions) pushSetupIx(ix)

  const feeRecipient = config?.feeRecipient ?? env.FEE_RECIPIENT ?? null
  if (resolved.mintOut && !isNativeSolMint(resolved.mintOut) && env.POOK_PROGRAM_ID) {
    const mintPk = new PublicKey(resolved.mintOut)
    const tp = new PublicKey(tokenProgramOut)
    const payer = new PublicKey(relayerPubkey)
    const [authorFeesPda] = findAuthorFeesPda(new PublicKey(env.POOK_PROGRAM_ID), new PublicKey(onChainHook.author), resolved.mintOut)
    const owners = [authorFeesPda, ...(feeRecipient ? [new PublicKey(feeRecipient)] : []), payer]
    for (const owner of owners) {
      const [ata] = findAta(owner, mintPk, tp)
      pushSetupIx(serializeSetupIx(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mintPk, tp)))
    }
  }

  const inAsset = assetMeta(resolved.mintIn)
  const outAsset = assetMeta(resolved.mintOut)
  const feeAsset = assetMeta(feeMint)
  const quoteId = `quote_${Date.now().toString(36)}_${toHex(callHash.subarray(1, 5))}`
  const expiresAt = new Date(Date.now() + 300_000).toISOString()

  return {
    quoteId,
    hookId: hook.id,
    hookAddress: hook.address,
    hookAuthor: onChainHook.author,
    feeRecipient,
    relayer: relayerPubkey,
    mintIn: resolved.mintIn,
    assetInSymbol: inAsset?.symbol ?? hook.assetInSymbol,
    amountIn: programAmountIn.toString(),
    mintOut: resolved.mintOut,
    assetOutSymbol: outAsset?.symbol ?? hook.assetOutSymbol,
    tokenProgramIn,
    tokenProgramOut,
    expectedOut: resolved.expectedOut.toString(),
    minimumOut: resolved.minimumOut.toString(),
    ...('minimumOutFromCaller' in resolved && resolved.minimumOutFromCaller ? { minimumOutFromCaller: true } : {}),
    slippageBps: request.slippageBps ?? 50,
    fees: {
      runFeeAmount: split.runFee.toString(),
      runFeeBps,
      authorShareAmount: split.authorFee.toString(),
      authorShareBps,
      protocolShareAmount: split.protocolFee.toString(),
      relayerFeeAmount: relayerFee.toString(),
      feeAssetMint: feeMint,
      feeAssetSymbol: feeAsset?.symbol ?? outAsset?.symbol ?? inAsset?.symbol ?? null,
    },
    netOut: netOut.toString(),
    minimumNetOut: minimumNetOut.toString(),
    resolvedAccounts: resolved.resolvedAccounts,
    resolvedDataBase64: toBase64(cpiData),
    callHashHex: toHex(callHash),
    callerDataBase64: toBase64(resolved.callerData),
    callerAccounts: resolved.callerAccounts,
    callerRemainingWritable: resolved.callerRemainingWritable,
    setupInstructions,
    companionInstructions: resolved.companionInstructions,
    chainPreview: {
      visible: {
        hookId: hook.id,
        targetProgram: hook.targetProgram,
        assetIn: inAsset?.symbol ?? hook.assetInSymbol,
        amountIn: request.amountIn,
        assetOut: outAsset?.symbol ?? hook.assetOutSymbol,
        minimumOut: resolved.minimumOut.toString(),
        relayer: relayerPubkey,
      },
      hidden: ['Holder wallet address', 'Rings spending key', 'Private balances', 'Seat link to holder'],
    },
    routeSummary: resolved.routeSummary,
    expiresAt,
  }
}

/**
 * Reads each seat's Kamino `Obligation` account (and batch-reads referenced `Reserve` accounts)
 * to return real deposited collateral per reserve, borrowed debt per reserve, and health from
 * Kamino's own `deposited_value_sf`, `borrow_factor_adjusted_debt_value_sf`, and
 * `unhealthy_borrow_value_sf` fields.
 */
export async function resolveSeatPositions(
  connection: Connection,
  seatRows: { address: string; commitment: string | null; openerRelayer: string | null; protocol: string; obligationAddress: string | null; status: string }[],
  requestedAddresses: string[],
): Promise<SeatPosition[]> {
  const byAddr = new Map(seatRows.map((s) => [s.address, s]))
  const now = new Date().toISOString()
  if (!requestedAddresses.length) return []

  const obligationPks = requestedAddresses.map((addr) => {
    const row = byAddr.get(addr)
    return row?.obligationAddress ? new PublicKey(row.obligationAddress) : deriveKaminoObligationPda(new PublicKey(addr))
  })
  const obligationInfos = await connection.getMultipleAccountsInfo(obligationPks, 'confirmed').catch(() => obligationPks.map(() => null))
  const decodedList = obligationInfos.map((info) => (info?.data ? decodeKaminoObligation(info.data) : null))

  // Batch-read every Reserve referenced by any active deposit or borrow across all requested seats.
  const reserveAddrs: string[] = []
  for (const ob of decodedList) {
    if (!ob) continue
    for (const d of ob.deposits) reserveAddrs.push(d.depositReserve)
    for (const b of ob.borrows) reserveAddrs.push(b.borrowReserve)
  }
  const reserves = await fetchKaminoReserves(connection, reserveAddrs).catch(() => new Map())

  const out: SeatPosition[] = []
  requestedAddresses.forEach((addr, idx) => {
    const row = byAddr.get(addr)
    const obligationPk = obligationPks[idx]!
    const info = obligationInfos[idx]
    const ob = decodedList[idx]

    const collateral: SeatAssetPosition[] = []
    const debt: SeatAssetPosition[] = []

    if (ob) {
      for (const dep of ob.deposits) {
        const res = reserves.get(dep.depositReserve)
        const mint = res?.liquidityMint ?? dep.depositReserve
        const meta = assetMeta(mint)
        const amount = res ? collateralToLiquidityBaseUnits(dep.depositedAmount, res) : dep.depositedAmount
        collateral.push({
          mint,
          symbol: meta?.symbol ?? mint.slice(0, 6),
          decimals: res?.mintDecimals ?? meta?.decimals ?? 9,
          amount: amount.toString(),
          usdValue: dep.marketValueSf > 0n ? sfToUsdString(dep.marketValueSf) : null,
        })
      }
      for (const bor of ob.borrows) {
        const res = reserves.get(bor.borrowReserve)
        const mint = res?.liquidityMint ?? bor.borrowReserve
        const meta = assetMeta(mint)
        debt.push({
          mint,
          symbol: meta?.symbol ?? mint.slice(0, 6),
          decimals: res?.mintDecimals ?? meta?.decimals ?? 6,
          amount: bor.borrowedBaseUnits.toString(),
          usdValue: bor.marketValueSf > 0n ? sfToUsdString(bor.marketValueSf) : null,
        })
      }
    }

    const hasPosition = collateral.length > 0 || debt.length > 0
    const status =
      row?.status === 'closed'
        ? 'closed'
        : hasPosition
          ? 'open'
          : info && info.data.length > 0
            ? 'empty'
            : 'empty'

    out.push({
      seatAddress: addr,
      commitmentHex: row?.commitment ?? undefined,
      openerRelayer: row?.openerRelayer ?? null,
      protocol: row?.protocol ?? 'kamino',
      protocolName: (row?.protocol ?? 'kamino') === 'kamino' ? 'Kamino' : (row?.protocol ?? 'Protocol'),
      obligationAddress: info ? obligationPk.toBase58() : (row?.obligationAddress ?? null),
      status,
      collateral,
      debt,
      depositedValueUsd: ob ? sfToUsdString(ob.depositedValueSf) : null,
      borrowFactorAdjustedDebtUsd: ob ? sfToUsdString(ob.borrowFactorAdjustedDebtValueSf) : null,
      unhealthyBorrowValueUsd: ob ? sfToUsdString(ob.unhealthyBorrowValueSf) : null,
      // Kamino's cached debt value lags a full repay until the next refresh: no debt rows, no health.
      healthFactor: ob && debt.length > 0 ? computeKaminoHealthFactor(ob.unhealthyBorrowValueSf, ob.borrowFactorAdjustedDebtValueSf) : null,
      actions: ['kamino.collateral.deposit', 'kamino.borrow', 'kamino.repay', 'kamino.collateral.withdraw'],
      updatedAt: now,
    })
  })
  return out
}

export function decodeHookOrThrow(data: Uint8Array): WireHookAccount {
  return decodeHookAccount(data)
}
