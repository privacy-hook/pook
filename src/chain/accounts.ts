import { inflateSync } from 'node:zlib'
import { PublicKey, type Connection } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token'
import {
  MSOL_MINT,
  NATIVE_SOL_MINT,
  WSOL_MINT,
  decodeAuthorFeesAccount,
  decodeConfigAccount,
  decodeHookAccount,
  decodeSeatAccount,
  isNativeSolMint,
  type AssetInfo,
  type ParsedIdlResponse,
  type WireAuthorFeesAccount,
  type WireConfigAccount,
  type WireHookAccount,
  type WireSeatAccount,
} from '@pook/contract'
import { JITOSOL_MINT, USDC_MINT, fail } from '../config.js'
import { findAta, findAuthorFeesPda, findConfigPda, findHookPda, findSeatStatePda } from './pda.js'

export const SUPPORTED_ASSETS: AssetInfo[] = [
  { mint: WSOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9, isNative: true },
  { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  { mint: JITOSOL_MINT, symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9 },
  { mint: MSOL_MINT, symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9 },
  { mint: 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D', symbol: 'kUSDC', name: 'Kamino USDC Collateral', decimals: 6 },
  { mint: '2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1', symbol: 'kSOL', name: 'Kamino SOL Collateral', decimals: 9 },
  { mint: '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D', symbol: 'jlUSDC', name: 'Jupiter Lend USDC', decimals: 6 },
  { mint: '2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU', symbol: 'jlSOL', name: 'Jupiter Lend SOL', decimals: 9 },
]

export function assetMeta(mint: string | null | undefined): AssetInfo | null {
  if (!mint) return null
  if (isNativeSolMint(mint)) return SUPPORTED_ASSETS[0]!
  return SUPPORTED_ASSETS.find((a) => a.mint === mint) ?? null
}

/** 30-second in-process cache for the on-chain Config PDA. */
export class ConfigCache {
  private cached: { value: WireConfigAccount | null; expiresAt: number } | null = null

  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
    private readonly ttlMs = 30_000,
  ) {}

  async read(force = false): Promise<WireConfigAccount | null> {
    const now = Date.now()
    if (!force && this.cached && this.cached.expiresAt > now) return this.cached.value
    const [configPda] = findConfigPda(this.programId)
    const info = await this.connection.getAccountInfo(configPda, 'confirmed')
    const value = info?.data ? decodeConfigAccount(info.data) : null
    this.cached = { value, expiresAt: now + this.ttlMs }
    return value
  }
}

export async function readHookAccount(connection: Connection, programId: PublicKey, hookId: string): Promise<{ address: PublicKey; account: WireHookAccount } | null> {
  const [address] = findHookPda(programId, hookId)
  const info = await connection.getAccountInfo(address, 'confirmed')
  if (!info?.data) return null
  return { address, account: decodeHookAccount(info.data) }
}

export async function readAuthorFeesAccount(
  connection: Connection,
  programId: PublicKey,
  author: PublicKey,
  mint: string | null,
): Promise<{ address: PublicKey; account: WireAuthorFeesAccount; balance: bigint } | null> {
  const [address] = findAuthorFeesPda(programId, author, mint)
  const info = await connection.getAccountInfo(address, 'confirmed')
  if (!info?.data) return null
  const account = decodeAuthorFeesAccount(info.data)
  if (mint === null || isNativeSolMint(mint)) {
    const rent = await connection.getMinimumBalanceForRentExemption(info.data.length)
    const balance = info.lamports > rent ? BigInt(info.lamports - rent) : 0n
    return { address, account, balance }
  }
  const mintPk = new PublicKey(mint)
  const tokenProgram = await detectTokenProgram(connection, mintPk)
  const [ata] = findAta(address, mintPk, tokenProgram)
  const ataInfo = await connection.getAccountInfo(ata, 'confirmed')
  if (!ataInfo?.data) return { address, account, balance: 0n }
  const parsed = unpackAccount(ata, ataInfo, tokenProgram)
  return { address, account, balance: parsed.amount }
}

export async function readSeatAccount(connection: Connection, programId: PublicKey, commitment: Uint8Array): Promise<WireSeatAccount | null> {
  const [seatState] = findSeatStatePda(programId, commitment)
  const info = await connection.getAccountInfo(seatState, 'confirmed')
  if (!info?.data) return null
  return decodeSeatAccount(info.data)
}

export async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  if (mint.toBase58() === WSOL_MINT || mint.toBase58() === NATIVE_SOL_MINT) return TOKEN_PROGRAM_ID
  const info = await connection.getAccountInfo(mint, 'confirmed')
  if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  return TOKEN_PROGRAM_ID
}

export async function readPublicWalletBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: string,
): Promise<{ mint: string; symbol: string | null; decimals: number; amount: string }> {
  const known = assetMeta(mint)
  if (isNativeSolMint(mint)) {
    const lamports = await connection.getBalance(wallet, 'confirmed')
    return { mint: WSOL_MINT, symbol: known?.symbol ?? 'SOL', decimals: 9, amount: BigInt(lamports).toString() }
  }
  const mintPk = new PublicKey(mint)
  const mintInfo = await connection.getAccountInfo(mintPk, 'confirmed')
  const tokenProgram = mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  let decimals = known?.decimals ?? 6
  if (mintInfo?.data) {
    try {
      decimals = unpackMint(mintPk, mintInfo, tokenProgram).decimals
    } catch {
      // keep fallback decimals
    }
  }
  const [ata] = findAta(wallet, mintPk, tokenProgram)
  const ataInfo = await connection.getAccountInfo(ata, 'confirmed')
  if (!ataInfo?.data) {
    return { mint, symbol: known?.symbol ?? null, decimals, amount: '0' }
  }
  const parsed = unpackAccount(ata, ataInfo, tokenProgram)
  return { mint, symbol: known?.symbol ?? null, decimals, amount: parsed.amount.toString() }
}

/** Parse raw Anchor IDL JSON (v0.29 or v0.30+) into Pook's normalized ParsedIdlResponse. */
export function parseAnchorIdlJson(idlJson: string, fallbackProgramId?: string | null): ParsedIdlResponse {
  let parsed: {
    address?: string
    name?: string
    version?: string
    metadata?: { name?: string; version?: string; address?: string }
    instructions?: {
      name: string
      discriminator?: number[]
      args?: { name: string; type: unknown }[]
      accounts?: { name: string; writable?: boolean; isMut?: boolean; signer?: boolean; isSigner?: boolean }[]
    }[]
  }
  try {
    parsed = JSON.parse(idlJson)
  } catch {
    return fail('IDL_INVALID', 'Could not parse JSON as a Solana program IDL.', { stage: 'validation' })
  }
  if (!Array.isArray(parsed.instructions) || parsed.instructions.length === 0) {
    return fail('IDL_INVALID', 'The provided IDL JSON has no instructions.', { stage: 'validation' })
  }
  return {
    programId: fallbackProgramId ?? parsed.address ?? parsed.metadata?.address ?? null,
    programName: parsed.metadata?.name ?? parsed.name ?? 'custom_program',
    version: parsed.metadata?.version ?? parsed.version ?? null,
    instructions: parsed.instructions.map((ix) => {
      const disc = Array.isArray(ix.discriminator)
        ? ix.discriminator.map((b) => b.toString(16).padStart(2, '0')).join('')
        : '00'.repeat(8)
      let offset = disc.length / 2
      const args = (ix.args ?? []).map((a) => {
        const typeStr = typeof a.type === 'string' ? a.type : 'bytes'
        const length =
          typeStr === 'u8' || typeStr === 'i8' || typeStr === 'bool'
            ? 1
            : typeStr === 'u16' || typeStr === 'i16'
              ? 2
              : typeStr === 'u32' || typeStr === 'i32'
                ? 4
                : typeStr === 'u128' || typeStr === 'i128'
                  ? 16
                  : typeStr === 'pubkey' || typeStr === 'publicKey'
                    ? 32
                    : 8
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
  }
}

/** Fetches an Anchor on-chain IDL account (`createWithSeed(base, "anchor:idl", programId)`) and inflates it. */
export async function fetchOnChainAnchorIdl(connection: Connection, programIdStr: string): Promise<ParsedIdlResponse> {
  const programId = new PublicKey(programIdStr)
  const [base] = PublicKey.findProgramAddressSync([], programId)
  const idlAddress = await PublicKey.createWithSeed(base, 'anchor:idl', programId)
  const info = await connection.getAccountInfo(idlAddress, 'confirmed')
  if (!info?.data || info.data.length < 44) {
    return fail('NOT_FOUND', `No on-chain Anchor IDL account found for program ${programIdStr}.`, { stage: 'validation' })
  }
  // Anchor IDL account layout: 8-byte discriminator, 32-byte authority, 4-byte u32 LE data length, zlib bytes.
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength)
  const len = view.getUint32(40, true)
  const compressed = info.data.subarray(44, 44 + len)
  try {
    const raw = inflateSync(compressed).toString('utf8')
    return parseAnchorIdlJson(raw, programIdStr)
  } catch {
    return fail('IDL_INVALID', `On-chain IDL account for ${programIdStr} could not be decompressed.`, { stage: 'validation' })
  }
}
