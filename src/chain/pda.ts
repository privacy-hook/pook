import { PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  POOK_ERROR_NAMES,
  SOL_INTERFACE_ADDRESS,
  hookIdHash,
  isNativeSolMint,
  toProgramMintBytes,
} from '@pook/contract'
import type { Catalogs } from '../engines/server/program-errors.js'
import type { ErrorRegistry } from '../engines/tx/server/failure.js'
import { TOKEN_ERRORS } from '../engines/tx/server/failure.js'

const enc = new TextEncoder()

export function findAuthorityPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('authority')], programId)
}

export function findStagePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('stage')], programId)
}

export function findConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('config')], programId)
}

export function findHookPda(programId: PublicKey, hookId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('hook'), hookIdHash(hookId)], programId)
}

export function findAuthorFeesPda(programId: PublicKey, author: PublicKey, mint: string | null): [PublicKey, number] {
  const mintBytes = mint === null || isNativeSolMint(mint) ? new Uint8Array(32) : toProgramMintBytes(mint)
  return PublicKey.findProgramAddressSync([enc.encode('author_fees'), author.toBytes(), mintBytes], programId)
}

export function findSeatPda(programId: PublicKey, commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('seat'), commitment], programId)
}

export function findSeatStatePda(programId: PublicKey, commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('seat_state'), commitment], programId)
}

export function findAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)
}

/** SPP SOL pool interface PDA (canonical SOL vault under the Rings program). */
export function findSppSolInterfacePda(_ringsProgramId: PublicKey): [PublicKey, number] {
  return [new PublicKey(SOL_INTERFACE_ADDRESS), 0]
}

/** SPP SPL pool interface PDA: ["spl_asset_vault", mint] under the Rings program. */
export function findSppSplInterfacePda(ringsProgramId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode('spl_asset_vault'), mint.toBytes()], ringsProgramId)
}

/** Builds a tx-engine ErrorRegistry mapping PookError codes 7500..=7540 and SPL Token errors. */
export function pookErrorRegistry(programId: string): ErrorRegistry {
  const pookMap = new Map<number, { name: string; msg?: string }>()
  for (const [codeStr, name] of Object.entries(POOK_ERROR_NAMES)) {
    pookMap.set(Number(codeStr), { name, msg: `Pook program refused the transaction (${name}).` })
  }
  const registry: ErrorRegistry = new Map()
  registry.set(programId, pookMap)
  registry.set(TOKEN_PROGRAM_ID.toBase58(), TOKEN_ERRORS)
  registry.set(TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_ERRORS)
  return registry
}

/** Builds a server-engine Catalogs map for PookError codes. */
export function pookErrorCatalogs(programId: string): Catalogs {
  return {
    [programId]: {
      name: 'Pook',
      errors: Object.entries(POOK_ERROR_NAMES).map(([codeStr, name]) => ({
        code: Number(codeStr),
        name,
        message: `Pook program refused the transaction (${name}).`,
      })),
    },
  }
}
