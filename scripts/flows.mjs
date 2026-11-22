#!/usr/bin/env node
/**
 * Pook end-to-end flow runner covering PLAN.md Flows 1 to 8, all nine launch hooks, and Flow 9:
 * Jupiter Lend supply and withdraw (needs `jupiter.lend.*` published, as `init.sh` does).
 *
 * Drives `@pook/sdk` in Node (loading `program/wasm/node/pook_program.js` in chain mode)
 * against local API, prover, relayer, and Solana RPC. After each step, asserts the resulting state
 * and verifies that the holder wallet public key never appears in any relayed transaction's accounts.
 * Fails loudly on the first broken step with the stage and program error name.
 *
 * Usage:
 *   node scripts/flows.mjs
 *
 * Environment overrides:
 *   API_URL             (default http://127.0.0.1:20810)
 *   PROVER_URL          (default http://127.0.0.1:20812)
 *   SOLANA_RPC_URL      (default http://127.0.0.1:20820)
 *   PHOTON_URL          (default http://127.0.0.1:20813)
 *   HOLDER_KEYPAIR_PATH (default localnet/keys/holder.json)
 *   AUTHOR_KEYPAIR_PATH (default localnet/keys/admin.json)
 *   FLOWS               (optional comma-separated list, default "1,2,3,4,5,6,7,8,9")
 */

import assert from 'node:assert/strict'
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { createKeyPairFromBytes, getBase64EncodedWireTransaction, signTransaction } from '@solana/kit'
import {
  ApiClientError,
  SOL_MINT,
  buildDepositTransaction,
  buildRegistrationTransaction,
  createPook,
  createSprClient,
  deriveRingsWalletKeys,
  kitAddress,
} from '../sdk/dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:20810'
const PROVER_URL = process.env.PROVER_URL ?? 'http://127.0.0.1:20812'
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:20820'
const PHOTON_URL = process.env.PHOTON_URL ?? 'http://127.0.0.1:20813'
const HOLDER_KEYPAIR_PATH =
  process.env.HOLDER_KEYPAIR_PATH ?? path.resolve(backendDir, 'localnet/keys/holder.json')
const AUTHOR_KEYPAIR_PATH =
  process.env.AUTHOR_KEYPAIR_PATH ?? path.resolve(backendDir, 'localnet/keys/admin.json')

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
const KUSDC_MINT = 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D'
const JLUSDC_MINT = '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D'
const JLSOL_MINT = '2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU'

const selectedFlows = new Set(
  (process.env.FLOWS ?? '1,2,3,4,5,6,7,8,9')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),
)

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function loadKeypair(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

function makeWalletAdapter(keypair, isFixture = false) {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32))
  const privKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  return {
    publicKey: keypair.publicKey.toBase58(),
    async signMessage(message) {
      return new Uint8Array(cryptoSign(null, Buffer.from(message), privKey))
    },
    async signTransaction(unsignedBase64) {
      if (isFixture) return { signedTransactionBase64: unsignedBase64 }
      const tx = VersionedTransaction.deserialize(Buffer.from(unsignedBase64, 'base64'))
      tx.sign([keypair])
      return { signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64') }
    },
  }
}

async function rpcCall(method, params) {
  const resp = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await resp.json()
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`)
  return json.result
}

/**
 * Fetches a confirmed transaction (v0 or v1) and asserts that the holder wallet public key
 * does NOT appear anywhere in its static or loaded account keys.
 */
async function assertNoHolderWalletInTx(signature, holderPubkey, label) {
  if (!signature) throw new Error(`${label}: missing transaction signature`)
  const tx = await rpcCall('getTransaction', [
    signature,
    { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 },
  ])
  assert.ok(tx, `${label}: transaction ${signature} was not found on RPC`)
  const staticKeys = tx.transaction?.message?.accountKeys ?? []
  const loadedWritable = tx.meta?.loadedAddresses?.writable ?? []
  const loadedReadonly = tx.meta?.loadedAddresses?.readonly ?? []
  const allKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly]
  assert.ok(
    !allKeys.includes(holderPubkey),
    `${label}: PRIVACY VIOLATION - holder wallet ${holderPubkey} appeared in tx ${signature} account keys`,
  )
  const cu = tx.meta?.computeUnitsConsumed ?? '?'
  console.log(`  [privacy ok] ${label} tx=${signature} CU=${cu} (${allKeys.length} keys, holder absent)`)
}

async function logPublicTxCu(signature, label) {
  if (!signature) return
  try {
    const tx = await rpcCall('getTransaction', [
      signature,
      { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 },
    ])
    console.log(`  [tx] ${label} tx=${signature} CU=${tx?.meta?.computeUnitsConsumed ?? '?'}`)
  } catch {
    console.log(`  [tx] ${label} tx=${signature}`)
  }
}

function assertRelayConfirmed(relay, stepName) {
  if (relay.status === 'confirmed' || relay.status === 'finalized') return
  const err = relay.error
  const prog = err?.programError ? `${err.programError.name} (#${err.programError.number ?? '?'})` : 'none'
  throw new Error(
    `step=${stepName} status=${relay.status} stage=${err?.stage ?? 'relay'} code=${err?.code ?? 'UNKNOWN'} programError=${prog} message=${err?.message ?? 'Relay did not confirm'}`,
  )
}

const stepTimings = []
const runStartMs = performance.now()

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

async function runStep(stepName, fn) {
  const t0 = performance.now()
  try {
    const out = await fn()
    const elapsedMs = Math.round(performance.now() - t0)
    stepTimings.push({ stepName, elapsedMs })
    console.log(`  [time] ${stepName}: ${fmtMs(elapsedMs)}`)
    return out
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - t0)
    if (err instanceof ApiClientError) {
      const e = err.body?.error
      const prog = e?.programError ? `${e.programError.name} (#${e.programError.number ?? '?'})` : 'none'
      console.error(
        `\n[FAIL] step=${stepName} elapsed=${fmtMs(elapsedMs)} http=${err.status} stage=${e?.stage ?? 'unknown'} code=${e?.code ?? 'UNKNOWN'} programError=${prog} message=${e?.message ?? err.message}`,
      )
    } else {
      const cause = err && typeof err === 'object' && 'cause' in err && err.cause ? ` cause=${err.cause instanceof Error ? err.cause.message : String(err.cause)}` : ''
      console.error(`\n[FAIL] step=${stepName} elapsed=${fmtMs(elapsedMs)} message=${err instanceof Error ? err.message : String(err)}${cause}`)
      if (err instanceof Error && err.stack) console.error(err.stack)
    }
    process.exit(1)
  }
}

async function loadNodeWasm() {
  const wasmPath = path.resolve(backendDir, 'program/wasm/node/pook_program.js')
  return import(pathToFileURL(wasmPath).href)
}

async function signAndSendKitTx(unsignedTx, keypair, rpcUrl) {
  const cryptoKeyPair = await createKeyPairFromBytes(keypair.secretKey)
  const signed = await signTransaction([cryptoKeyPair], unsignedTx)
  const wireBase64 = getBase64EncodedWireTransaction(signed)
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [wireBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }],
    }),
  })
  const json = await resp.json()
  if (json.error) throw new Error(`sendTransaction failed: ${json.error.message ?? JSON.stringify(json.error)}`)
  return json.result
}

function balanceOf(bal, mint) {
  const hit = bal.assets.find((a) => a.mint === mint)
  return hit ? BigInt(hit.amount) : 0n
}

function largestSpendableNoteOf(bal, mint) {
  let max = 0n
  for (const n of bal.notes ?? []) {
    if (!n.spent && n.kind === 'balance' && n.mint === mint) {
      const amt = BigInt(n.amount)
      if (amt > max) max = amt
    }
  }
  return max
}

async function main() {
  const holder = loadKeypair(HOLDER_KEYPAIR_PATH)
  const holderPubkey = holder.publicKey.toBase58()
  const author = existsSync(AUTHOR_KEYPAIR_PATH) ? loadKeypair(AUTHOR_KEYPAIR_PATH) : holder
  const authorPubkey = author.publicKey.toBase58()
  const freshWallet = Keypair.generate().publicKey.toBase58()
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed')

  console.log('Pook Flows Runner (PLAN.md Flows 1 to 8, all 9 launch hooks)')
  console.log(`  API:    ${API_URL}`)
  console.log(`  Prover: ${PROVER_URL}`)
  console.log(`  RPC:    ${SOLANA_RPC_URL}`)
  console.log(`  Holder: ${holderPubkey}`)
  console.log(`  Author: ${authorPubkey}`)

  const healthResp = await fetch(`${API_URL}/health`)
  assert.equal(healthResp.status, 200, 'API /health must return 200')
  const health = await healthResp.json()
  const isChain = health.status === 'ready'
  const isFixture = health.status === 'fixture'
  assert.ok(isChain || isFixture, `API must be ready or fixture, got ${health.status}`)
  console.log(`  API status: ${health.status} (programId: ${health.programId ?? 'none'})`)

  const sessionHeaders = isFixture ? { 'X-Fixture-Session': `flows_${Date.now().toString(36)}` } : undefined
  const wasm = isChain ? await loadNodeWasm() : undefined
  const holderSigner = makeWalletAdapter(holder, isFixture)
  const pook = createPook({
    apiUrl: API_URL,
    // As the app does: prover, Photon and Solana RPC through the API unless overridden in env.
    ...(process.env.PROVER_URL ? { proverUrl: PROVER_URL } : {}),
    ...(process.env.PHOTON_URL ? { photonUrl: PHOTON_URL } : {}),
    ...(process.env.SOLANA_RPC_URL ? { rpcUrl: SOLANA_RPC_URL } : {}),
    headers: sessionHeaders,
    signer: holderSigner,
    wasm,
  })

  const sprRpcUrl = process.env.SOLANA_RPC_URL ?? `${API_URL.replace(/\/+$/, '')}/v1/rpc`
  const sprIndexerUrl = process.env.PHOTON_URL ?? `${API_URL.replace(/\/+$/, '')}/v1/photon`
  const sprProverUrl = process.env.PROVER_URL
    ? `${PROVER_URL.replace(/\/+$/, '')}/v1/prover/spp`
    : `${API_URL.replace(/\/+$/, '')}/v1/prover/spp`

  let holderRingsReady = false
  async function ensureHolderRingsRegisteredAndFunded(depositLamports = 0n) {
    if (!isChain) return
    const spr = await createSprClient({
      indexerUrl: sprIndexerUrl,
      proverUrl: sprProverUrl,
      solanaRpcUrl: sprRpcUrl,
    })
    const ringsKeys = await deriveRingsWalletKeys(holderSigner, spr)
    try {
      const ownerAddr = kitAddress(holderPubkey)
      if (!holderRingsReady) {
        const regTx = await buildRegistrationTransaction({
          client: spr,
          owner: ownerAddr,
          payer: ownerAddr,
          address: ringsKeys.address(),
        })
        if (regTx) {
          const regSig = await signAndSendKitTx(regTx, holder, sprRpcUrl)
          await spr.confirmTransaction(regSig)
          console.log(`  [rings] registered holder in Rings User Registry: ${regSig}`)
        }
        holderRingsReady = true
      }
      if (depositLamports > 0n) {
        const depTx = await buildDepositTransaction({
          client: spr,
          feePayer: ownerAddr,
          depositor: ownerAddr,
          recipient: ringsKeys.address(),
          asset: SOL_MINT,
          amount: depositLamports,
        })
        const depSig = await signAndSendKitTx(depTx, holder, sprRpcUrl)
        await spr.confirmPrivateTransaction(depSig)
        console.log(`  [rings] funded holder Rings balance (+${depositLamports.toString()} lamports): ${depSig}`)
      }
    } finally {
      ringsKeys.destroy()
    }
  }

  const authorPook = createPook({
    apiUrl: API_URL,
    // As the app does: prover, Photon and Solana RPC through the API unless overridden in env.
    ...(process.env.PROVER_URL ? { proverUrl: PROVER_URL } : {}),
    ...(process.env.PHOTON_URL ? { photonUrl: PHOTON_URL } : {}),
    ...(process.env.SOLANA_RPC_URL ? { rpcUrl: SOLANA_RPC_URL } : {}),
    headers: sessionHeaders,
    signer: makeWalletAdapter(author, isFixture),
    wasm,
  })

  const keys = await runStep('unlock', () => pook.unlock())
  console.log(`  Unlocked Rings keys (ownerHash=${keys.ownerHash.slice(0, 16)}...)`)

  const publicSol = await runStep('public_balance', () => pook.publicBalance(WSOL_MINT))
  console.log(`  Public SOL balance: ${publicSol.amount} lamports`)

  const statsBefore = await runStep('stats_before', () => pook.stats())
  let expectedNewRuns = 0

  // Flow 1: Enter from public wallet (USDC and SOL) + Enter from Rings private balance
  if (selectedFlows.has(1)) {
    await runStep('flow1_enter_usdc_sol', async () => {
      console.log('\n[Flow 1a] Enter from public wallet (USDC + SOL)')
      const enterUsdc = await pook.enter({ source: 'wallet', mint: USDC_MINT, amount: '20000000' })
      assert.equal(enterUsdc.tx.status, 'confirmed', 'USDC enter must confirm')
      if (isChain) await logPublicTxCu(enterUsdc.signature, 'enter_usdc')
      const enterSol = await pook.enter({ source: 'wallet', mint: WSOL_MINT, amount: '500000000' })
      assert.equal(enterSol.tx.status, 'confirmed', 'SOL enter must confirm')
      if (isChain) await logPublicTxCu(enterSol.signature, 'enter_sol')
      const bal = await pook.balance()
      assert.ok(balanceOf(bal, USDC_MINT) > 0n, 'Private USDC balance must be > 0 after enter')
      assert.ok(balanceOf(bal, WSOL_MINT) > 0n, 'Private SOL balance must be > 0 after enter')
      console.log(`  [ok] Public enter confirmed; balances: ${bal.assets.map((b) => `${b.amount} ${b.symbol}`).join(', ')}`)
    })

    await runStep('flow1b_enter_from_rings', async () => {
      console.log('\n[Flow 1b] Enter from Rings private balance (SOL)')
      const beforeBal = await pook.balance()
      const solBefore = balanceOf(beforeBal, WSOL_MINT)
      if (isChain) {
        await ensureHolderRingsRegisteredAndFunded(150_000_000n)
      }
      const stages = []
      const enterRings = await pook.enter({
        source: 'rings',
        mint: WSOL_MINT,
        amount: '100000000',
        onStage: (s) => stages.push(s),
      })
      assert.equal(enterRings.tx.status, 'confirmed', 'Rings enter must confirm')
      assert.ok(enterRings.signature, 'Rings enter must return a transaction signature')
      assert.equal(stages[stages.length - 1], 'confirmed', `Expected confirmed as final stage, got [${stages.join(', ')}]`)
      if (isChain) {
        assert.ok(stages.includes('proving'), `Expected onStage('proving') during Rings enter, got [${stages.join(', ')}]`)
        await logPublicTxCu(enterRings.signature, 'enter_rings_sol')
        const afterBal = await pook.balance()
        const solAfter = balanceOf(afterBal, WSOL_MINT)
        assert.ok(solAfter >= solBefore + 100_000_000n, `Private SOL balance must increase by 100000000 after Rings enter (before=${solBefore}, after=${solAfter})`)
      }
      console.log(`  [ok] Rings enter confirmed (stages: ${stages.join(' -> ')}): ${enterRings.signature}`)
    })
  }

  // Flow 2: Jupiter swap both ways + Kamino supply/withdraw
  if (selectedFlows.has(2)) {
    await runStep('flow2_jupiter_swap_usdc_to_sol', async () => {
      console.log('\n[Flow 2a] jupiter.swap USDC -> SOL')
      const res = await pook.run('jupiter.swap', { in: USDC_MINT, out: WSOL_MINT, amount: '10000000', slippageBps: 100 })
      assertRelayConfirmed(res.relay, 'jupiter.swap USDC->SOL')
      if (isChain) await assertNoHolderWalletInTx(res.signature, holderPubkey, 'jupiter.swap USDC->SOL')
      expectedNewRuns += 1
      if (res.timings) {
        const t = res.timings
        console.log(
          `  [stages] jupiter.swap USDC->SOL: quote=${fmtMs(t.quoteMs)} scan=${fmtMs(t.scanMs)} witness=${fmtMs(t.witnessMs)} artifactLoad=${fmtMs(t.artifactLoadMs)} appProof=${fmtMs(t.appProofMs)} sppProof=${fmtMs(t.sppProofMs)} relay=${fmtMs(t.relayMs)} confirm=${fmtMs(t.confirmMs)} total=${fmtMs(t.totalMs)}`,
        )
      }
      console.log(`  [ok] jupiter.swap USDC -> SOL confirmed: ${res.signature}`)
    })

    await runStep('flow2_jupiter_swap_sol_to_usdc', async () => {
      console.log('\n[Flow 2b] jupiter.swap SOL -> USDC')
      const res = await pook.run('jupiter.swap', { in: WSOL_MINT, out: USDC_MINT, amount: '100000000', slippageBps: 100 })
      assertRelayConfirmed(res.relay, 'jupiter.swap SOL->USDC')
      if (isChain) await assertNoHolderWalletInTx(res.signature, holderPubkey, 'jupiter.swap SOL->USDC')
      expectedNewRuns += 1
      if (res.timings) {
        const t = res.timings
        console.log(
          `  [stages] jupiter.swap SOL->USDC: quote=${fmtMs(t.quoteMs)} scan=${fmtMs(t.scanMs)} witness=${fmtMs(t.witnessMs)} artifactLoad=${fmtMs(t.artifactLoadMs)} appProof=${fmtMs(t.appProofMs)} sppProof=${fmtMs(t.sppProofMs)} relay=${fmtMs(t.relayMs)} confirm=${fmtMs(t.confirmMs)} total=${fmtMs(t.totalMs)}`,
        )
      }
      console.log(`  [ok] jupiter.swap SOL -> USDC confirmed: ${res.signature}`)
    })

    await runStep('flow2_kamino_supply_and_withdraw', async () => {
      console.log('\n[Flow 2c] kamino.supply (USDC -> kUSDC) then kamino.withdraw (kUSDC -> USDC)')
      const sup = await pook.run('kamino.supply', { in: USDC_MINT, out: KUSDC_MINT, amount: '5000000', slippageBps: 100 })
      assertRelayConfirmed(sup.relay, 'kamino.supply')
      if (isChain) await assertNoHolderWalletInTx(sup.signature, holderPubkey, 'kamino.supply')
      expectedNewRuns += 1

      const balAfterSupply = await pook.balance()
      const largestKUsdc = largestSpendableNoteOf(balAfterSupply, KUSDC_MINT)
      const kUsdcBal = balanceOf(balAfterSupply, KUSDC_MINT)
      const withdrawAmt = largestKUsdc > 0n ? largestKUsdc : kUsdcBal > 0n ? kUsdcBal : BigInt(sup.quote.minimumOut || '4000000')

      const wd = await pook.run('kamino.withdraw', { in: KUSDC_MINT, out: USDC_MINT, amount: withdrawAmt, slippageBps: 100 })
      assertRelayConfirmed(wd.relay, 'kamino.withdraw')
      if (isChain) await assertNoHolderWalletInTx(wd.signature, holderPubkey, 'kamino.withdraw')
      expectedNewRuns += 1
      console.log(`  [ok] kamino.supply (${sup.signature?.slice(0, 12)}...) and kamino.withdraw (${wd.signature?.slice(0, 12)}...) confirmed`)
    })
  }

  // Flow 3: Jito stake then unstake
  if (selectedFlows.has(3)) {
    await runStep('flow3_jito_stake_and_unstake', async () => {
      console.log('\n[Flow 3] jito.stake (SOL -> JitoSOL) then jito.unstake (JitoSOL -> SOL)')
      const staked = await pook.run('jito.stake', { in: WSOL_MINT, out: JITOSOL_MINT, amount: '100000000', slippageBps: 100 })
      assertRelayConfirmed(staked.relay, 'jito.stake')
      if (isChain) await assertNoHolderWalletInTx(staked.signature, holderPubkey, 'jito.stake')
      expectedNewRuns += 1

      const balAfterStake = await pook.balance()
      const largestJito = largestSpendableNoteOf(balAfterStake, JITOSOL_MINT)
      const jitoBal = balanceOf(balAfterStake, JITOSOL_MINT)
      const unstakeAmt = largestJito > 0n ? largestJito : jitoBal > 0n ? jitoBal : BigInt(staked.quote.minimumOut || '80000000')

      const unstaked = await pook.run('jito.unstake', { in: JITOSOL_MINT, out: WSOL_MINT, amount: unstakeAmt, slippageBps: 100 })
      assertRelayConfirmed(unstaked.relay, 'jito.unstake')
      if (isChain) await assertNoHolderWalletInTx(unstaked.signature, holderPubkey, 'jito.unstake')
      expectedNewRuns += 1
      console.log(`  [ok] jito.stake (${staked.signature?.slice(0, 12)}...) and jito.unstake (${unstaked.signature?.slice(0, 12)}...) confirmed`)
    })
  }

  // Flow 4: Seat lifecycle as the app does it (one-press deposit opens seat -> borrow -> repay -> withdraw -> closeSeat)
  if (selectedFlows.has(4)) {
    await runStep('flow4_seat_lifecycle', async () => {
      console.log('\n[Flow 4] Private Kamino Seat Lifecycle (one-press deposit -> borrow -> repay -> withdraw -> closeSeat)')
      const stages = []
      const dep = await pook.run('kamino.collateral.deposit', {
        in: WSOL_MINT,
        amount: '100000000',
        onStage: (s) => stages.push(s),
      })
      assertRelayConfirmed(dep.relay, 'kamino.collateral.deposit')
      assert.ok(stages.includes('opening_seat'), `Expected onStage('opening_seat') during first seat run, got [${stages.join(', ')}]`)
      assert.ok(
        stages.indexOf('opening_seat') < stages.indexOf('proving'),
        `Expected opening_seat before proving, got [${stages.join(', ')}]`,
      )
      const seatAddr = dep.seat
      assert.ok(seatAddr, 'First seat deposit must return opened seat address as result.seat')
      if (isChain && dep.openSeatSignature) await assertNoHolderWalletInTx(dep.openSeatSignature, holderPubkey, 'openSeat (auto)')
      if (isChain) await assertNoHolderWalletInTx(dep.signature, holderPubkey, 'kamino.collateral.deposit')
      expectedNewRuns += 1

      const seatsAfterDeposit = await pook.seats()
      const seat1 = seatsAfterDeposit.find((s) => s.seatAddress === seatAddr)
      assert.ok(seat1, `Seat ${seatAddr} must appear in seats()`)
      assert.ok(seat1.collateral.length > 0, `Seat ${seatAddr} must report deposited collateral after deposit`)
      console.log(`  [ok] Auto-opened seat ${seatAddr} (stages: ${stages.join(' -> ')}); collateral=${seat1.collateral.map((c) => `${c.amount} ${c.symbol}`).join(', ')}`)

      // Borrow USDC against deposited SOL collateral
      const bor = await pook.run('kamino.borrow', { out: USDC_MINT, amount: '1000000', seat: seatAddr })
      assertRelayConfirmed(bor.relay, 'kamino.borrow')
      if (isChain) await assertNoHolderWalletInTx(bor.signature, holderPubkey, 'kamino.borrow')
      expectedNewRuns += 1

      const seatsAfterBorrow = await pook.seats()
      const seat2 = seatsAfterBorrow.find((s) => s.seatAddress === seatAddr)
      assert.ok(seat2 && seat2.debt.length > 0, `Seat ${seatAddr} must report borrowed debt after borrow`)
      console.log(`  [ok] kamino.borrow confirmed; debt=${seat2.debt.map((d) => `${d.amount} ${d.symbol}`).join(', ')} health=${seat2.healthFactor ?? 'n/a'}`)

      // Repay borrowed USDC (add a small buffer so any accrued interest is covered; Kamino caps repayment at exact debt)
      const debtAmt = BigInt(seat2.debt[0].amount) + (isChain ? 10_000n : 0n)
      const rep = await pook.run('kamino.repay', { in: USDC_MINT, amount: debtAmt, seat: seatAddr })
      assertRelayConfirmed(rep.relay, 'kamino.repay')
      if (isChain) await assertNoHolderWalletInTx(rep.signature, holderPubkey, 'kamino.repay')
      expectedNewRuns += 1
      console.log(`  [ok] kamino.repay confirmed: ${rep.signature}`)

      // Withdraw all collateral
      const wd = await pook.run('kamino.collateral.withdraw', {
        out: WSOL_MINT,
        amount: isChain ? '18446744073709551615' : seat1.collateral[0].amount,
        seat: seatAddr,
        args: { withdrawAll: 'true' },
      })
      assertRelayConfirmed(wd.relay, 'kamino.collateral.withdraw')
      if (isChain) await assertNoHolderWalletInTx(wd.signature, holderPubkey, 'kamino.collateral.withdraw')
      expectedNewRuns += 1
      console.log(`  [ok] kamino.collateral.withdraw confirmed: ${wd.signature}`)

      // Close seat and verify rent returns to opening relayer
      const openerRelayer = seat1.openerRelayer
      const openerBefore = isChain && openerRelayer ? await connection.getBalance(new PublicKey(openerRelayer), 'confirmed') : null
      const closed = await pook.closeSeat(seatAddr, { openerRelayer: openerRelayer ?? undefined })
      assertRelayConfirmed(closed.relay, 'closeSeat')
      if (isChain) {
        await assertNoHolderWalletInTx(closed.signature, holderPubkey, 'closeSeat')
        if (openerRelayer && openerBefore !== null) {
          const openerAfter = await connection.getBalance(new PublicKey(openerRelayer), 'confirmed')
          assert.ok(openerAfter >= openerBefore, `Opener relayer ${openerRelayer} should receive seat rent back on close`)
        }
      }
      const seatsAfterClose = await pook.seats()
      const seatClosed = seatsAfterClose.find((s) => s.seatAddress === seatAddr)
      assert.ok(!seatClosed || seatClosed.status === 'closed', 'Closed seat must no longer be active in seats()')
      const stateAfterClose = await pook.client.seatsState({ seatAddresses: [seatAddr] })
      const closedRecord = stateAfterClose.seats.find((s) => s.seatAddress === seatAddr)
      assert.ok(!closedRecord || closedRecord.status === 'closed', 'Closed seat must report status=closed in seatsState')
      console.log(`  [ok] closeSeat confirmed (${closed.signature}); seat closed and rent returned to opener relayer`)
    })
  }

  // Flow 5: Leave to a public address AND to a Rings private balance
  if (selectedFlows.has(5)) {
    await runStep('flow5_leave_public_and_rings', async () => {
      console.log('\n[Flow 5] Leave to fresh public wallet + Leave to Rings private balance')
      const leavePub = await pook.leave({
        destinationType: 'wallet',
        destination: freshWallet,
        mint: WSOL_MINT,
        amount: '50000000',
      })
      assertRelayConfirmed(leavePub.relay, 'leave_public')
      if (isChain) {
        await assertNoHolderWalletInTx(leavePub.signature, holderPubkey, 'leave_public')
        const freshBal = await connection.getBalance(new PublicKey(freshWallet), 'confirmed')
        assert.ok(freshBal > 0, `Fresh destination wallet ${freshWallet} must receive SOL`)
      }
      console.log(`  [ok] Public leave confirmed to ${freshWallet}: ${leavePub.signature}`)

      const destOwnerHash = keys.ownerHash
      const destViewTag = new PublicKey(randomBytes(32)).toBase58()
      const leaveRings = await pook.leave({
        destinationType: 'rings',
        destination: destOwnerHash,
        destinationViewTag: destViewTag,
        mint: WSOL_MINT,
        amount: '25000000',
      })
      assertRelayConfirmed(leaveRings.relay, 'leave_rings_raw')
      if (isChain) await assertNoHolderWalletInTx(leaveRings.signature, holderPubkey, 'leave_rings_raw')
      console.log(`  [ok] Rings private leave (raw ownerHash) confirmed: ${leaveRings.signature}`)

      if (isChain) {
        // Ensure holder is registered in the Rings User Registry before leaving by wallet address.
        await ensureHolderRingsRegisteredAndFunded(0n)
        // Unregistered wallet must fail clearly before proving.
        let unregErr = null
        try {
          await pook.leave({
            destinationType: 'rings',
            destination: freshWallet,
            mint: WSOL_MINT,
            amount: '25000000',
          })
        } catch (err) {
          unregErr = err
        }
        assert.ok(unregErr instanceof ApiClientError && unregErr.body?.error?.code === 'NOT_FOUND', `Expected NOT_FOUND for unregistered Rings recipient, got ${String(unregErr)}`)
      }
      const leaveRingsWallet = await pook.leave({
        destinationType: 'rings',
        destination: holderPubkey,
        mint: WSOL_MINT,
        amount: '25000000',
      })
      assertRelayConfirmed(leaveRingsWallet.relay, 'leave_rings_wallet')
      if (isChain) await assertNoHolderWalletInTx(leaveRingsWallet.signature, holderPubkey, 'leave_rings_wallet')
      console.log(`  [ok] Rings private leave (by Solana wallet address ${holderPubkey.slice(0, 8)}...) confirmed: ${leaveRingsWallet.signature}`)
    })
  }

  // Flow 6: Publish a custom hook outside the launch set and run it with caller-supplied minimumOut
  if (selectedFlows.has(6)) {
    await runStep('flow6_publish_and_run_custom_hook', async () => {
      console.log('\n[Flow 6] Publish a custom hook outside the launch set and run with caller-supplied minimumOut')
      const customId = `custom.jito_stake_${Date.now().toString(36)}`
      const refQuote = await pook.quote('jito.stake', {
        mintIn: WSOL_MINT,
        mintOut: JITOSOL_MINT,
        amountIn: '50000000',
      })
      const refAddr = (idx, fallback) => refQuote.resolvedAccounts[idx]?.address ?? fallback
      const jitoPool = refAddr(0, 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb')
      const withdrawAuth = refAddr(1, '6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS')
      const reserveStake = refAddr(2, 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL')
      const managerFee = refAddr(5, 'feeeFLLsam6xZJFc6UQFrHqkvVt4jfmVvi2BRLkUZ4i')

      const draft = {
        id: customId,
        protocol: 'custom',
        protocolName: 'Custom Stake Flow',
        label: 'Custom Jito Stake',
        description: 'Custom hook outside the launch set exercising caller-supplied minimumOut and args.',
        kind: 'flow',
        targetProgram: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
        instructionName: 'DepositSol',
        discriminator: '0e',
        mintInConstraint: { kind: 'Sol' },
        mintOutConstraint: { kind: 'Spl', mint: JITOSOL_MINT },
        wrapSolIn: false,
        unwrapSolOut: false,
        dataTemplate: {
          baseHex: '0e' + '00'.repeat(8),
          slots: [{ name: 'lamports', kind: 'amount_in', offset: 1, length: 8, type: 'u64', label: 'SOL amount (lamports)' }],
        },
        accountsTemplate: [
          { index: 0, name: 'stakePool', role: 'fixed', address: jitoPool, writable: true, signer: false },
          { index: 1, name: 'stakePoolWithdrawAuthority', role: 'fixed', address: withdrawAuth, writable: false, signer: false },
          { index: 2, name: 'reserveStakeAccount', role: 'caller_supplied', writable: true, signer: false },
          { index: 3, name: 'fundingAccount', role: 'stage_authority', writable: true, signer: true },
          { index: 4, name: 'destinationPoolAccount', role: 'stage_out', writable: true, signer: false },
          { index: 5, name: 'managerFeeAccount', role: 'caller_supplied', writable: true, signer: false },
          { index: 6, name: 'referralPoolAccount', role: 'stage_out', writable: true, signer: false },
          { index: 7, name: 'poolMint', role: 'fixed', address: JITOSOL_MINT, writable: true, signer: false },
          { index: 8, name: 'systemProgram', role: 'program', address: '11111111111111111111111111111111', writable: false, signer: false },
          { index: 9, name: 'tokenProgram', role: 'program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', writable: false, signer: false },
        ],
        mintIn: WSOL_MINT,
        mintOut: JITOSOL_MINT,
        assetInSymbol: 'SOL',
        assetOutSymbol: 'JitoSOL',
      }
      const pub = await pook.publishHook({ hook: draft })
      assert.equal(pub.tx.status, 'confirmed', `publishHook must confirm, got ${pub.tx.status}`)
      if (isChain) await logPublicTxCu(pub.signature, 'publish_hook')
      const fetched = await pook.hook(customId)
      assert.equal(fetched.hook.id, customId, 'Published hook must be readable via GET /v1/hooks/:id')
      assert.equal(fetched.hook.label, draft.label, 'Published hook must preserve draft label')
      assert.equal(fetched.hook.description, draft.description, 'Published hook must preserve draft description')
      assert.equal(fetched.hook.protocolName, draft.protocolName, 'Published hook must preserve draft protocolName')
      assert.equal(fetched.hook.instructionName, draft.instructionName, 'Published hook must preserve draft instructionName')
      assert.equal(fetched.hook.accountsTemplate.length, draft.accountsTemplate.length, 'Published hook must preserve accountsTemplate length')
      assert.equal(fetched.hook.accountsTemplate[2]?.name, 'reserveStakeAccount', 'Published hook must preserve named accounts')
      assert.equal(fetched.hook.dataTemplate.slots.length, 1, 'Published hook must preserve dataTemplate slots')
      assert.ok(fetched.hook.formFields.length > 0, 'Published hook must have formFields (derived or provided)')
      console.log(`  [ok] Published custom hook ${customId} (${fetched.hook.address}, label="${fetched.hook.label}"): ${pub.signature}`)

      const customArgs = {
        reserveStakeAccount: reserveStake,
        managerFeeAccount: managerFee,
        account_2: reserveStake,
        account_5: managerFee,
        slot_2: reserveStake,
        slot_5: managerFee,
      }
      // Quoting a custom hook with mintOut without minimumOut must return VALIDATION_ERROR naming minimumOut.
      let missingMinOutErr = null
      try {
        await pook.quote(customId, {
          mintIn: WSOL_MINT,
          mintOut: JITOSOL_MINT,
          amountIn: '50000000',
          args: customArgs,
        })
      } catch (err) {
        missingMinOutErr = err
      }
      assert.ok(
        missingMinOutErr instanceof ApiClientError &&
          missingMinOutErr.body?.error?.code === 'VALIDATION_ERROR' &&
          missingMinOutErr.body?.error?.message?.includes('minimumOut'),
        `Expected VALIDATION_ERROR naming minimumOut when omitted, got ${String(missingMinOutErr)}`,
      )
      console.log(`  [ok] Custom hook quote rejected missing minimumOut with VALIDATION_ERROR`)

      const customMinOut = '30000000'
      const customRun = await pook.run(customId, {
        in: WSOL_MINT,
        out: JITOSOL_MINT,
        amount: '50000000',
        minimumOut: customMinOut,
        args: customArgs,
      })
      assert.equal(customRun.quote.minimumOutFromCaller, true, 'Custom hook quote must set minimumOutFromCaller=true')
      assert.equal(customRun.quote.minimumOut, customMinOut, 'Custom hook quote must echo caller minimumOut')
      assertRelayConfirmed(customRun.relay, 'custom_hook_run')
      if (isChain) await assertNoHolderWalletInTx(customRun.signature, holderPubkey, 'custom_hook_run')
      expectedNewRuns += 1
      console.log(`  [ok] Custom hook ${customId} run confirmed with caller minimumOut=${customMinOut}: ${customRun.signature}`)
    })
  }

  // Flow 7: Claim author's share as the hooks' author
  if (selectedFlows.has(7)) {
    await runStep('flow7_claim_author_fees', async () => {
      console.log('\n[Flow 7] Claim author fees as the hooks author')
      const fees = await authorPook.authorFees(authorPubkey)
      const claimable = fees.hooks.filter((h) => BigInt(h.claimableAmount) > 0n)
      if (claimable.length > 0) {
        const claimMint = claimable[0].mint
        const claimForMint = claimable.filter((h) => h.mint === claimMint)
        const claim = await authorPook.claimAuthorFees({
          hookIds: claimForMint.map((h) => h.hookId),
          mint: claimMint,
        })
        assert.equal(claim.tx.status, 'confirmed', `claimAuthorFees must confirm, got ${claim.tx.status}`)
        if (isChain) await logPublicTxCu(claim.signature, `claim_author_fees(${claimMint.slice(0, 6)})`)
        const after = await authorPook.authorFees(authorPubkey)
        const stillClaimable = after.hooks.filter(
          (h) => h.mint === claimMint && claimForMint.some((c) => c.hookId === h.hookId) && BigInt(h.claimableAmount) > 0n,
        )
        assert.equal(stillClaimable.length, 0, 'Claimed author fees must drop to 0')
        console.log(`  [ok] Claimed author fees for ${claimForMint.length} hook(s) on mint ${claimMint}: ${claim.signature}`)
      } else {
        console.log(`  [ok] Author fees checked for ${authorPubkey} (${fees.hooks.length} rows; 0 claimable while run_fee_bps=0)`)
      }
    })
  }

  // Flow 8: Crank waiting while POOK_MINT unset + public feed & stats count runs
  // Flow 9: Jupiter Lend supply then withdraw, for USDC and SOL
  if (selectedFlows.has(9)) {
    await runStep('flow9_jupiter_lend_supply_and_withdraw', async () => {
      for (const [asset, earn, amount] of [
        [USDC_MINT, JLUSDC_MINT, '5000000'],
        [WSOL_MINT, JLSOL_MINT, '100000000'],
      ]) {
        console.log(`\n[Flow 9] jupiter.lend.supply (${asset.slice(0, 4)} -> ${earn.slice(0, 4)}) then jupiter.lend.withdraw`)
        const earnBefore = balanceOf(await pook.balance(), earn)
        const sup = await pook.run('jupiter.lend.supply', { in: asset, out: earn, amount, slippageBps: 100 })
        assertRelayConfirmed(sup.relay, 'jupiter.lend.supply')
        if (isChain) await assertNoHolderWalletInTx(sup.signature, holderPubkey, 'jupiter.lend.supply')
        expectedNewRuns += 1

        const bal = await pook.balance()
        if (isChain) {
          assert.equal(String(balanceOf(bal, earn) - earnBefore), sup.relay.netOut, 'relay netOut is what landed in the private balance')
        }
        const shares = largestSpendableNoteOf(bal, earn)
        assert.ok(shares > 0n, `Expected an earn-token note after jupiter.lend.supply, got ${shares}`)
        const wd = await pook.run('jupiter.lend.withdraw', { in: earn, out: asset, amount: shares, slippageBps: 100 })
        assertRelayConfirmed(wd.relay, 'jupiter.lend.withdraw')
        if (isChain) await assertNoHolderWalletInTx(wd.signature, holderPubkey, 'jupiter.lend.withdraw')
        expectedNewRuns += 1
        console.log(`  [ok] supply ${amount} -> ${shares} shares (${sup.signature?.slice(0, 12)}...), withdraw (${wd.signature?.slice(0, 12)}...) confirmed`)
      }
    })
  }

  if (selectedFlows.has(8)) {
    await runStep('flow8_crank_waiting_and_feed_stats', async () => {
      console.log('\n[Flow 8] Crank waiting check + public stats and runs feed')
      const cfg = await pook.config()
      if (!process.env.POOK_MINT) {
        assert.equal(cfg.pookMint, null, 'Config must report pookMint=null while POOK_MINT is unset (crank stays waiting)')
      }
      const [stats, runs, hooks] = await Promise.all([
        pook.stats(),
        pook.runs({ limit: 50 }),
        pook.hooks({ limit: 50 }),
      ])
      assert.ok(hooks.items.length >= 9, `Expected at least 9 launch hooks, got ${hooks.items.length}`)
      assert.ok(
        stats.runsCount >= statsBefore.runsCount + expectedNewRuns,
        `Expected stats.runsCount >= ${statsBefore.runsCount + expectedNewRuns}, got ${stats.runsCount}`,
      )
      for (const run of runs.items) {
        assert.notEqual(run.relayer, holderPubkey, 'Public runs feed must never leak holder wallet as relayer')
        assert.notEqual(run.stageAuthority, holderPubkey, 'Public runs feed must never leak holder wallet as stageAuthority')
      }
      console.log(
        `  [ok] Crank waiting (pookMint=${cfg.pookMint ?? 'null'}); stats: hooks=${stats.hooksCount}, runs=${stats.runsCount} (+${stats.runsCount - statsBefore.runsCount}), activeSeats=${stats.activeSeatsCount}`,
      )
    })
  }

  const totalMs = Math.round(performance.now() - runStartMs)
  console.log('\n--- Timing Summary ---')
  for (const s of stepTimings) {
    console.log(`  ${s.stepName.padEnd(36)} ${fmtMs(s.elapsedMs)}`)
  }
  console.log(`  ${'TOTAL'.padEnd(36)} ${fmtMs(totalMs)}`)
  console.log('\nAll selected flows completed and verified.')
}

main()
