#!/usr/bin/env node
/**
 * Read-only mainnet capture of Jupiter Lend (Earn) for the Pook localnet, added beside capture.mjs:
 * the lending and liquidity programs, the lending admin and liquidity singletons, and the USDC and SOL
 * markets (Lending, fToken mint, reserve, supply position, rate model, vault, claim, rewards rate model).
 * Reads MAINNET_RPC_URL (a mainnet RPC endpoint) from the environment and never prints it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// Packages resolve from the repo root's node_modules.
const require = createRequire(path.join(here, '../package.json'))
const { PublicKey } = require('@solana/web3.js')
const { getAssociatedTokenAddressSync } = require('@solana/spl-token')
const rpc = process.env.MAINNET_RPC_URL
if (!rpc) throw new Error('Missing MAINNET_RPC_URL')

const LENDING = new PublicKey('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9')
const LIQ = new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC')
const RRM = new PublicKey('jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar')
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const MINTS = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112']
const b = (s) => Buffer.from(s)
const pda = (seeds, p) => PublicKey.findProgramAddressSync(seeds, p)[0]

async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

function trimElf(buf) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return buf
  const end = Number(buf.readBigUInt64LE(40)) + buf.readUInt16LE(58) * buf.readUInt16LE(60)
  return end > 64 && end <= buf.length ? buf.subarray(0, end) : buf
}

const lendingAdmin = pda([b('lending_admin')], LENDING)
const liquidity = pda([b('liquidity')], LIQ)
const addrs = [lendingAdmin, liquidity]
for (const m of MINTS) {
  const mint = new PublicKey(m)
  const fMint = pda([b('f_token_mint'), mint.toBuffer()], LENDING)
  const lending = pda([b('lending'), mint.toBuffer(), fMint.toBuffer()], LENDING)
  addrs.push(
    fMint,
    lending,
    pda([b('reserve'), mint.toBuffer()], LIQ),
    pda([b('user_supply_position'), mint.toBuffer(), lending.toBuffer()], LIQ),
    pda([b('rate_model'), mint.toBuffer()], LIQ),
    getAssociatedTokenAddressSync(mint, liquidity, true, TOKEN),
    pda([b('user_claim'), lendingAdmin.toBuffer(), mint.toBuffer()], LIQ),
    pda([b('lending_rewards_rate_model'), mint.toBuffer()], RRM),
  )
}

const keys = addrs.map((a) => a.toBase58())
const { value } = await rpcCall('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }])
value.forEach((acct, i) => {
  if (!acct) throw new Error(`missing account ${keys[i]}`)
  const raw = Buffer.from(acct.data[0], 'base64')
  const obj = {
    pubkey: keys[i],
    account: {
      lamports: Math.max(Number(acct.lamports), (raw.length + 128) * 6960),
      data: [raw.toString('base64'), 'base64'],
      owner: acct.owner,
      executable: false,
      rentEpoch: 0,
      space: raw.length,
    },
  }
  fs.writeFileSync(path.join(here, 'accounts', `${keys[i]}.json`), JSON.stringify(obj, null, 2))
})
console.log(`Captured ${keys.length} Jupiter Lend accounts`)

for (const program of [LENDING, LIQ]) {
  const { value: prog } = await rpcCall('getAccountInfo', [program.toBase58(), { encoding: 'base64' }])
  const programData = new PublicKey(Buffer.from(prog.data[0], 'base64').subarray(4, 36))
  const { value: pd } = await rpcCall('getAccountInfo', [programData.toBase58(), { encoding: 'base64' }])
  const elf = trimElf(Buffer.from(pd.data[0], 'base64').subarray(45))
  fs.writeFileSync(path.join(here, 'programs', `${program.toBase58()}.so`), elf)
  console.log(`Program ${program.toBase58()}: ${elf.length} B`)
}
