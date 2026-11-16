import { PublicKey, type Connection } from '@solana/web3.js'
import { SYSTEM_PROGRAM_ID } from '@pook/contract'

const SF_SHIFT = 60n

function readU128LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const lo = view.getBigUint64(offset, true)
  const hi = view.getBigUint64(offset + 8, true)
  return lo + (hi << 64n)
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return view.getBigUint64(offset, true)
}

function readPubkey(buf: Uint8Array, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

export type KaminoObligationDeposit = {
  depositReserve: string
  /** Deposited collateral cToken shares in base units. */
  depositedAmount: bigint
  marketValueSf: bigint
}

export type KaminoObligationBorrow = {
  borrowReserve: string
  /** Borrowed liquidity amount in U68F60 scaled fraction units. */
  borrowedAmountSf: bigint
  /** Borrowed liquidity base units (ceil(borrowedAmountSf / 2^60)). */
  borrowedBaseUnits: bigint
  marketValueSf: bigint
  borrowFactorAdjustedMarketValueSf: bigint
}

export type DecodedKaminoObligation = {
  tag: bigint
  lendingMarket: string
  owner: string
  deposits: KaminoObligationDeposit[]
  borrows: KaminoObligationBorrow[]
  depositedValueSf: bigint
  borrowFactorAdjustedDebtValueSf: bigint
  borrowedAssetsMarketValueSf: bigint
  allowedBorrowValueSf: bigint
  unhealthyBorrowValueSf: bigint
}

export type DecodedKaminoReserve = {
  lendingMarket: string
  farmCollateral: string
  farmDebt: string
  liquidityMint: string
  liquiditySupplyVault: string
  liquidityFeeVault: string
  availableAmount: bigint
  borrowedAmountSf: bigint
  marketPriceSf: bigint
  mintDecimals: number
  accumulatedProtocolFeesSf: bigint
  accumulatedReferrerFeesSf: bigint
  tokenProgram: string
  collateralMint: string
  collateralTotalSupply: bigint
  collateralSupplyVault: string
}

// Byte offsets verified against `Kamino-Finance/klend` (`#[repr(C)]`, 8-byte Anchor discriminator,
// sBPF u128 alignment = 8).
const OB_DEPOSITS_OFFSET = 96
const OB_DEPOSIT_STRIDE = 136
const OB_DEPOSIT_COUNT = 8
const OB_DEPOSITED_VALUE_SF_OFFSET = 1192
const OB_BORROWS_OFFSET = 1208
const OB_BORROW_STRIDE = 200
const OB_BORROW_COUNT = 5
const OB_BF_ADJUSTED_DEBT_SF_OFFSET = 2208
const OB_BORROWED_MARKET_VALUE_SF_OFFSET = 2224
const OB_ALLOWED_BORROW_VALUE_SF_OFFSET = 2240
const OB_UNHEALTHY_BORROW_VALUE_SF_OFFSET = 2256
const OB_MIN_BYTES = 2272

/**
 * Decodes a Kamino Lend `Obligation` account from raw bytes (no Kamino SDK).
 */
export function decodeKaminoObligation(data: Uint8Array): DecodedKaminoObligation | null {
  if (data.length < OB_MIN_BYTES) return null

  const tag = readU64LE(data, 8)
  const lendingMarket = readPubkey(data, 32)
  const owner = readPubkey(data, 64)

  const deposits: KaminoObligationDeposit[] = []
  for (let i = 0; i < OB_DEPOSIT_COUNT; i++) {
    const off = OB_DEPOSITS_OFFSET + i * OB_DEPOSIT_STRIDE
    const depositReserve = readPubkey(data, off)
    const depositedAmount = readU64LE(data, off + 32)
    const marketValueSf = readU128LE(data, off + 40)
    if (depositReserve !== SYSTEM_PROGRAM_ID && depositedAmount > 0n) {
      deposits.push({ depositReserve, depositedAmount, marketValueSf })
    }
  }

  const depositedValueSf = readU128LE(data, OB_DEPOSITED_VALUE_SF_OFFSET)

  const borrows: KaminoObligationBorrow[] = []
  for (let i = 0; i < OB_BORROW_COUNT; i++) {
    const off = OB_BORROWS_OFFSET + i * OB_BORROW_STRIDE
    const borrowReserve = readPubkey(data, off)
    const borrowedAmountSf = readU128LE(data, off + 88)
    const marketValueSf = readU128LE(data, off + 104)
    const borrowFactorAdjustedMarketValueSf = readU128LE(data, off + 120)
    if (borrowReserve !== SYSTEM_PROGRAM_ID && borrowedAmountSf > 0n) {
      const mask = (1n << SF_SHIFT) - 1n
      const borrowedBaseUnits = (borrowedAmountSf + mask) >> SF_SHIFT
      borrows.push({
        borrowReserve,
        borrowedAmountSf,
        borrowedBaseUnits,
        marketValueSf,
        borrowFactorAdjustedMarketValueSf,
      })
    }
  }

  return {
    tag,
    lendingMarket,
    owner,
    deposits,
    borrows,
    depositedValueSf,
    borrowFactorAdjustedDebtValueSf: readU128LE(data, OB_BF_ADJUSTED_DEBT_SF_OFFSET),
    borrowedAssetsMarketValueSf: readU128LE(data, OB_BORROWED_MARKET_VALUE_SF_OFFSET),
    allowedBorrowValueSf: readU128LE(data, OB_ALLOWED_BORROW_VALUE_SF_OFFSET),
    unhealthyBorrowValueSf: readU128LE(data, OB_UNHEALTHY_BORROW_VALUE_SF_OFFSET),
  }
}

const RES_MIN_BYTES = 2632

/**
 * Decodes a Kamino Lend `Reserve` account from raw bytes (no Kamino SDK).
 */
export function decodeKaminoReserve(data: Uint8Array): DecodedKaminoReserve | null {
  if (data.length < RES_MIN_BYTES) return null
  return {
    lendingMarket: readPubkey(data, 32),
    farmCollateral: readPubkey(data, 64),
    farmDebt: readPubkey(data, 96),
    liquidityMint: readPubkey(data, 128),
    liquiditySupplyVault: readPubkey(data, 160),
    liquidityFeeVault: readPubkey(data, 192),
    availableAmount: readU64LE(data, 224),
    borrowedAmountSf: readU128LE(data, 232),
    marketPriceSf: readU128LE(data, 248),
    mintDecimals: Number(readU64LE(data, 272)),
    accumulatedProtocolFeesSf: readU128LE(data, 344),
    accumulatedReferrerFeesSf: readU128LE(data, 360),
    tokenProgram: readPubkey(data, 408),
    collateralMint: readPubkey(data, 2560),
    collateralTotalSupply: readU64LE(data, 2592),
    collateralSupplyVault: readPubkey(data, 2600),
  }
}

/** Converts Kamino cToken collateral shares to underlying liquidity base units. */
export function collateralToLiquidityBaseUnits(collateralAmount: bigint, reserve: DecodedKaminoReserve): bigint {
  if (collateralAmount === 0n || reserve.collateralTotalSupply === 0n) return collateralAmount
  const borrowed = reserve.borrowedAmountSf >> SF_SHIFT
  const protoFees = reserve.accumulatedProtocolFeesSf >> SF_SHIFT
  const refFees = reserve.accumulatedReferrerFeesSf >> SF_SHIFT
  const totalLiquidity = reserve.availableAmount + borrowed - protoFees - refFees
  if (totalLiquidity <= 0n) return collateralAmount
  return (collateralAmount * totalLiquidity) / reserve.collateralTotalSupply
}

/** Formats a Kamino U68F60 scaled fraction (`_sf`) as a USD string with 2 decimal places. */
export function sfToUsdString(sf: bigint): string {
  const cents = (sf * 100n) >> SF_SHIFT
  const whole = cents / 100n
  const frac = (cents % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${frac}`
}

/**
 * Computes health factor as `unhealthyBorrowValueSf / borrowFactorAdjustedDebtValueSf`
 * formatted to 2 decimal places. Returns null when debt is zero.
 */
export function computeKaminoHealthFactor(unhealthyBorrowValueSf: bigint, borrowFactorAdjustedDebtValueSf: bigint): string | null {
  if (borrowFactorAdjustedDebtValueSf === 0n) return null
  const hundredths = (unhealthyBorrowValueSf * 100n) / borrowFactorAdjustedDebtValueSf
  const whole = hundredths / 100n
  const frac = (hundredths % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${frac}`
}

/** Batch-fetches and decodes Kamino reserves via `getMultipleAccountsInfo`. */
export async function fetchKaminoReserves(
  connection: Connection,
  reserveAddresses: readonly string[],
): Promise<Map<string, DecodedKaminoReserve>> {
  const unique = [...new Set(reserveAddresses.filter((a) => a !== SYSTEM_PROGRAM_ID))]
  const out = new Map<string, DecodedKaminoReserve>()
  if (!unique.length) return out
  const infos = await connection.getMultipleAccountsInfo(
    unique.map((a) => new PublicKey(a)),
    'confirmed',
  )
  unique.forEach((addr, idx) => {
    const info = infos[idx]
    if (!info?.data) return
    const parsed = decodeKaminoReserve(info.data)
    if (parsed) out.set(addr, parsed)
  })
  return out
}
