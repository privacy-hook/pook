// Simulates jupiter.lend.supply and jupiter.lend.withdraw through /v1/hooks/simulate on the chain the
// API reads, for USDC and SOL, and checks the stage's output account holds what the hook produced.
// Usage: API_URL=http://127.0.0.1:20817 node scripts/simulate-jupiter-lend.mjs
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { loadLaunchHooks } from '../dist/hooks/index.js'

const API = process.env.API_URL ?? 'http://127.0.0.1:20817'
const LENDING = new PublicKey('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9')
const LIQ = new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC')
const RRM = new PublicKey('jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar')
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const b = (s) => Buffer.from(s)
const pda = (seeds, p) => PublicKey.findProgramAddressSync(seeds, p)[0]
const lendingAdmin = pda([b('lending_admin')], LENDING)
const liquidity = pda([b('liquidity')], LIQ)

function marketArgs(mintStr) {
  const mint = new PublicKey(mintStr)
  const fTokenMint = pda([b('f_token_mint'), mint.toBuffer()], LENDING)
  const lending = pda([b('lending'), mint.toBuffer(), fTokenMint.toBuffer()], LENDING)
  return {
    fTokenMint: fTokenMint.toBase58(),
    vault: getAssociatedTokenAddressSync(mint, liquidity, true, TOKEN).toBase58(),
    args: {
      mint: mint.toBase58(),
      lending: lending.toBase58(),
      fTokenMint: fTokenMint.toBase58(),
      supplyTokenReservesLiquidity: pda([b('reserve'), mint.toBuffer()], LIQ).toBase58(),
      lendingSupplyPositionOnLiquidity: pda([b('user_supply_position'), mint.toBuffer(), lending.toBuffer()], LIQ).toBase58(),
      rateModel: pda([b('rate_model'), mint.toBuffer()], LIQ).toBase58(),
      vault: getAssociatedTokenAddressSync(mint, liquidity, true, TOKEN).toBase58(),
      claimAccount: pda([b('user_claim'), lendingAdmin.toBuffer(), mint.toBuffer()], LIQ).toBase58(),
      rewardsRateModel: pda([b('lending_rewards_rate_model'), mint.toBuffer()], RRM).toBase58(),
      tokenProgram: TOKEN.toBase58(),
    },
  }
}

const hooks = new Map(loadLaunchHooks().map((h) => [h.id, h]))
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL = 'So11111111111111111111111111111111111111112'
const usdc = marketArgs(USDC)
const sol = marketArgs(WSOL)

const cases = [
  { name: 'supply USDC', hook: 'jupiter.lend.supply', amount: '10000000', mintIn: USDC, mintOut: usdc.fTokenMint, args: usdc.args, fundFrom: usdc.vault },
  { name: 'supply SOL', hook: 'jupiter.lend.supply', amount: '50000000', mintIn: WSOL, mintOut: sol.fTokenMint, args: sol.args },
  { name: 'withdraw USDC', hook: 'jupiter.lend.withdraw', amount: '10000000', mintIn: usdc.fTokenMint, mintOut: USDC, args: usdc.args, fundFrom: process.env.JLUSDC_HOLDER },
  { name: 'withdraw SOL', hook: 'jupiter.lend.withdraw', amount: '50000000', mintIn: sol.fTokenMint, mintOut: WSOL, args: sol.args, fundFrom: process.env.JLSOL_HOLDER },
]

let failed = 0
for (const c of cases) {
  const body = {
    hook: hooks.get(c.hook),
    sampleAmountIn: c.amount,
    sampleMintIn: c.mintIn,
    sampleMintOut: c.mintOut,
    sampleArgs: c.args,
    ...(c.fundFrom ? { sampleFundFrom: c.fundFrom } : {}),
  }
  const res = await fetch(`${API}/v1/hooks/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  const ok = res.ok && json.passed && BigInt(json.stageOutAmount ?? '0') > 0n
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: in ${c.amount}, stage out ${json.stageOutAmount ?? '-'}, ${json.computeUnits ?? '-'} CU, ${json.accountCount ?? '-'} accounts`)
  if (!ok) console.log(JSON.stringify(json.error ?? json, null, 1).slice(0, 600), '\n', (json.logs ?? []).slice(-12).join('\n'))
}
process.exit(failed ? 1 : 0)
