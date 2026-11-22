import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { errors, isNativeSolMint, type KnownErrorCode } from '@pook/contract'
import { address, cluster, host, httpUrl, origins, parseEnv, port, requireWhen, wsUrl } from './engines/server/config.js'
import { failer, type Fail } from './engines/server/errors.js'

const bps = z.coerce.number().int().min(0).max(10_000)
const uintStr = z.string().regex(/^\d+$/)

const here = path.dirname(fileURLToPath(import.meta.url))
const upOne = path.resolve(here, '..')
const backendRoot = path.basename(upOne) === 'dist' ? path.resolve(upOne, '..') : upOne
const defaultArtifactsDir = path.resolve(backendRoot, 'program/artifacts')
const defaultLocalnetRoutesDir = path.resolve(backendRoot, 'localnet/routes')

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
export const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
export const KUSDC_MINT = 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D'
export const KSOL_MINT = '2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1'
export const JLUSDC_MINT = '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D'
export const JLSOL_MINT = '2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU'

const EnvSchema = z
  .object({
    MODE: z.enum(['fixture', 'chain']).default('fixture'),
    CLUSTER: cluster,
    HOST: host(),
    PORT: port(20810),
    RELAYER_PORT: port(20811),
    PROVER_PORT: port(20812),
    CORS_ORIGINS: origins.default([
      'http://127.0.0.1:20800',
      'http://localhost:20800',
      'http://127.0.0.1:20801',
      'http://localhost:20801',
      'https://pook.codes',
    ]),
    DATABASE_URL: z.string().optional(),
    SOLANA_RPC_URL: httpUrl.default('http://127.0.0.1:20820'),
    SOLANA_WS_URL: wsUrl.default('ws://127.0.0.1:20821'),
    PHOTON_URL: httpUrl.default('http://127.0.0.1:20813'),
    RINGS_PROVER_URL: httpUrl.default('http://127.0.0.1:20814'),
    RELAYER_URL: httpUrl.default('http://127.0.0.1:20811'),
    PROVER_URL: httpUrl.default('http://127.0.0.1:20812'),
    POOK_PROGRAM_ID: address.optional(),
    RINGS_PROGRAM_ID: address.default('ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW'),
    RINGS_STATE_TREE: address.default('777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor'),
    LOOKUP_TABLE: address.optional(),
    POOK_ARTIFACTS_DIR: z.string().default(defaultArtifactsDir),
    LOCALNET_ROUTES_DIR: z.string().default(defaultLocalnetRoutesDir),
    RELAYER_FEE_SOL: uintStr.default('2000000'),
    RELAYER_FEE_USDC: uintStr.default('500000'),
    RELAYER_FEE_DEFAULT: uintStr.optional(),
    RELAYER_FEE_MAP: z.string().optional(),
    // Undecided configuration points: stay unset until owner sets them; fail loudly when required.
    RUN_FEE_BPS: bps.optional(),
    AUTHOR_SHARE_BPS: bps.optional(),
    FEE_RECIPIENT: address.optional(),
    POOK_MINT: address.optional(),
    CRANK_INTERVAL_MS: z.coerce.number().int().min(5_000).optional(),
    HELIUS_RPC_URL: httpUrl.optional(),
    JUPITER_API_KEY: z.string().optional(),
    RELAYER_SECRET_KEY: z.string().optional(),
    CRANK_SECRET_KEY: z.string().optional(),
    // Localnet only: a maker POOK token account that approved the crank as delegate, standing in for Jupiter.
    CRANK_LOCAL_MAKER: address.optional(),
  })
  .superRefine(requireWhen('CLUSTER', 'mainnet', ['DATABASE_URL', 'POOK_PROGRAM_ID', 'HELIUS_RPC_URL']))

export const env = parseEnv(EnvSchema)
export type Env = typeof env

export const fail: Fail<KnownErrorCode> = failer(errors.status)

/** Fails loudly when an owner-decided protocol configuration point is unset. */
export function requireConfigValue<T>(name: string, value: T | undefined): T {
  if (value === undefined) {
    return fail('CONFIGURATION_REQUIRED', `Required configuration ${name} is not set.`, { stage: 'build' })
  }
  return value
}

export function rpcUrlForCluster(e: Env = env): string {
  return e.CLUSTER === 'mainnet' && e.HELIUS_RPC_URL ? e.HELIUS_RPC_URL : e.SOLANA_RPC_URL
}

/** Relayer fee in raw base units of the requested mint. Refuses unconfigured mints instead of guessing. */
export function relayerFeeForMint(mint: string, e: Env = env): bigint {
  if (e.RELAYER_FEE_MAP) {
    let parsed: Record<string, string | number>
    try {
      parsed = JSON.parse(e.RELAYER_FEE_MAP) as Record<string, string | number>
    } catch {
      return fail('CONFIGURATION_REQUIRED', 'RELAYER_FEE_MAP is not valid JSON.', { stage: 'build', retryable: false })
    }
    const hit = parsed[mint]
    if (hit !== undefined) return BigInt(hit)
  }
  if (isNativeSolMint(mint) || mint === JITOSOL_MINT || mint === MSOL_MINT || mint === KSOL_MINT || mint === JLSOL_MINT) {
    return BigInt(e.RELAYER_FEE_SOL)
  }
  if (mint === USDC_MINT || mint === KUSDC_MINT || mint === JLUSDC_MINT) {
    return BigInt(e.RELAYER_FEE_USDC)
  }
  return fail(
    'CONFIGURATION_REQUIRED',
    `No relayer fee is configured for mint ${mint}. Add it to RELAYER_FEE_MAP.`,
    { stage: 'build', retryable: false },
  )
}
