#!/usr/bin/env node
/**
 * One-time read-only mainnet capture for the Pook localnet.
 *
 * Reads MAINNET_RPC_URL (a mainnet RPC endpoint) and JUPITER_API_KEY from the environment.
 * Never prints either value or writes them to disk.
 *
 * Captures:
 *   - Jupiter v6 + real classic-AMM USDC->SOL and SOL->USDC swap routes + venue programs + pool/tick accounts
 *   - Kamino Lend program + Main Market + USDC & SOL reserves + their vaults/mints/oracles
 *   - Jito Stake Pool program + Jito stake pool + JitoSOL mint + validator list + reserve stake
 *   - Mainnet SPL Token, Token-2022, Associated Token Program, Lighthouse
 *   - USDC mint with its mint authority rewritten to a local test keypair (localnet/mint-authority.json)
 *   - Inactive mainnet feature list for the validator
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = path.join(__dirname, "accounts");
const PROGRAMS_DIR = path.join(__dirname, "programs");
const ROUTES_DIR = path.join(__dirname, "routes");
const MINT_AUTH_PATH = path.join(__dirname, "mint-authority.json");
const MANIFEST_PATH = path.join(__dirname, "manifest.json");

const POOK_PROGRAM_ID = "7qvNkZjiikySgCNbr8jbWbUziVka3Rw1NLwcxwmwwRwd";

// Well-known mainnet addresses (verified on chain during capture)
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const BPF_LOADER_2 = "BPFLoader2111111111111111111111111111111111";
const BPF_LOADER_1 = "BPFLoader1111111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const KAMINO_LEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const KAMINO_FARMS = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KAMINO_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
const KAMINO_SOL_RESERVE = "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";
const SCOPE_ORACLE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";
const JITO_STAKE_POOL_PROGRAM = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
const JITO_STAKE_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

function base58Decode(str) {
  let bytes = [0];
  for (const ch of str) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) throw new Error(`Invalid base58 char: ${ch}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function base58Encode(buf) {
  let leadingZeros = 0;
  for (const byte of buf) {
    if (byte !== 0) break;
    leadingZeros++;
  }
  if (leadingZeros === buf.length) {
    return "1".repeat(leadingZeros);
  }
  const digits = [0];
  for (let idx = leadingZeros; idx < buf.length; idx++) {
    let carry = buf[idx];
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

function ensureMintAuthority() {
  if (!fs.existsSync(MINT_AUTH_PATH)) {
    execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", MINT_AUTH_PATH], {
      stdio: "ignore",
    });
  }
  const pubkey = execFileSync("solana-keygen", ["pubkey", MINT_AUTH_PATH], { encoding: "utf8" }).trim();
  return pubkey;
}

function pookProgramId() {
  return POOK_PROGRAM_ID;
}

// Compute a PDA off-chain using `solana find-program-derived-address`
function findPda(programId, seeds) {
  const args = ["find-program-derived-address", programId, ...seeds];
  const out = execFileSync("solana", args, { encoding: "utf8" }).trim().split(/\r?\n/);
  return out[0].trim();
}

function findAta(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return findPda(ATA_PROGRAM, [`pubkey:${owner}`, `pubkey:${tokenProgram}`, `pubkey:${mint}`]);
}

// Local validator rent minimum: 6,960 lamports/byte * (len + 128)
function localRentMinimum(dataLen) {
  return (dataLen + 128) * 6960;
}

// Trim ELF only down to `e_shoff + e_shnum * e_shentsize` (never strip section header zeros)
function trimElfPreservingHeaders(buf) {
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    return buf;
  }
  const eShoff = Number(buf.readBigUInt64LE(40));
  const eShentsize = buf.readUInt16LE(58);
  const eShnum = buf.readUInt16LE(60);
  const exactEnd = eShoff + eShentsize * eShnum;
  if (exactEnd > 64 && exactEnd <= buf.length) {
    return buf.subarray(0, exactEnd);
  }
  return buf;
}

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getMultipleAccountsChunked(rpcUrl, addresses) {
  const unique = [...new Set(addresses)];
  const map = new Map();
  let slot = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const res = await rpcCall(rpcUrl, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
    if (!slot) slot = res.context.slot;
    chunk.forEach((addr, idx) => {
      if (res.value[idx]) map.set(addr, res.value[idx]);
    });
  }
  return { slot, accounts: map };
}

async function fetchJupiterRoute(jupKey, inputMint, outputMint, amount, takerPubkey, destinationTokenAccount) {
  const quoteUrl = new URL("https://api.jup.ag/swap/v1/quote");
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", String(amount));
  quoteUrl.searchParams.set("slippageBps", "100");
  quoteUrl.searchParams.set("dexes", "Whirlpool,Raydium CLMM,Meteora DLMM");
  quoteUrl.searchParams.set("onlyDirectRoutes", "true");
  quoteUrl.searchParams.set("maxAccounts", "26");

  const qRes = await fetch(quoteUrl, { headers: { "x-api-key": jupKey } });
  if (!qRes.ok) {
    throw new Error(`Jupiter quote HTTP ${qRes.status}: ${await qRes.text()}`);
  }
  const quoteResponse = await qRes.json();

  const body = {
    quoteResponse,
    userPublicKey: takerPubkey,
    wrapAndUnwrapSol: false,
    useSharedAccounts: false,
    skipUserAccountsRpcCalls: true,
    dynamicComputeUnitLimit: false,
    ...(destinationTokenAccount ? { destinationTokenAccount } : {}),
  };
  const sRes = await fetch("https://api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": jupKey },
    body: JSON.stringify(body),
  });
  if (!sRes.ok) {
    throw new Error(`Jupiter swap-instructions HTTP ${sRes.status}: ${await sRes.text()}`);
  }
  const swapInstructions = await sRes.json();
  return { quoteResponse, swapInstructions };
}

// Parse pubkeys inside Kamino Reserve (verified against klend programs/klend/src/state/reserve.rs)
function extractKaminoReserveAccounts(buf) {
  const pubkeys = [];
  if (buf.length < 5256) return pubkeys;
  // Header + ReserveLiquidity:
  //   32: lending_market, 64: farm_collateral, 96: farm_debt
  //   128: liq.mint_pubkey, 160: liq.supply_vault, 192: liq.fee_vault
  // ReserveCollateral (offset 2560):
  //   2560: collateral.mint_pubkey, 2600: collateral.supply_vault
  // ReserveConfig.token_info (offset 5032):
  //   5112: scope_configuration.price_feed
  //   5160: switchboard_configuration.price_aggregator
  //   5192: switchboard_configuration.twap_aggregator
  //   5224: pyth_configuration.price
  for (const off of [32, 64, 96, 128, 160, 192, 2560, 2600, 5112, 5160, 5192, 5224]) {
    const pk = base58Encode(buf.subarray(off, off + 32));
    if (pk !== SYSTEM_PROGRAM) pubkeys.push(pk);
  }
  return pubkeys;
}

// Parse key pubkeys inside SPL StakePool (Jito)
function extractStakePoolAccounts(buf) {
  // StakePool borsh layout:
  // account_type (1)
  // manager (32) [1..33]
  // staker (32) [33..65]
  // stake_deposit_authority (32) [65..97]
  // stake_withdraw_bump_seed (1) [97]
  // validator_list (32) [98..130]
  // reserve_stake (32) [130..162]
  // pool_mint (32) [162..194]
  // manager_fee_account (32) [194..226]
  // token_program_id (32) [226..258]
  const pubkeys = [];
  if (buf.length < 258) return pubkeys;
  for (const off of [1, 33, 65, 98, 130, 162, 194, 226]) {
    const pk = base58Encode(buf.subarray(off, off + 32));
    if (pk !== SYSTEM_PROGRAM) pubkeys.push(pk);
  }
  return pubkeys;
}

function writeAccountJson(addr, acct) {
  const raw = Buffer.from(acct.data[0], "base64");
  const minRent = localRentMinimum(raw.length);
  const lamports = Math.max(Number(acct.lamports), minRent);
  const obj = {
    pubkey: addr,
    account: {
      lamports,
      data: [raw.toString("base64"), "base64"],
      owner: acct.owner,
      executable: Boolean(acct.executable),
      rentEpoch: 0,
      space: raw.length,
    },
  };
  fs.writeFileSync(path.join(ACCOUNTS_DIR, `${addr}.json`), JSON.stringify(obj, null, 2));
}

async function main() {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  const jupKey = process.env.JUPITER_API_KEY;
  if (!rpcUrl || !jupKey) throw new Error("Missing MAINNET_RPC_URL or JUPITER_API_KEY");

  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.mkdirSync(PROGRAMS_DIR, { recursive: true });
  fs.mkdirSync(ROUTES_DIR, { recursive: true });

  const mintAuthority = ensureMintAuthority();
  const pookId = pookProgramId();
  const stagePda = findPda(pookId, ["string:stage"]);
  const stageUsdcAta = findAta(stagePda, USDC_MINT);
  const stageWsolAta = findAta(stagePda, WSOL_MINT);

  console.log("Pook program ID:", pookId);
  console.log("Stage PDA:", stagePda);
  console.log("Stage USDC ATA:", stageUsdcAta);
  console.log("Stage WSOL ATA:", stageWsolAta);
  console.log("Local USDC mint authority:", mintAuthority);

  // 1. Fetch real Jupiter routes (USDC -> SOL and SOL -> USDC)
  console.log("Fetching Jupiter USDC -> SOL route...");
  const usdcToSol = await fetchJupiterRoute(
    jupKey,
    USDC_MINT,
    WSOL_MINT,
    10_000_000, // 10 USDC
    stagePda,
    stageWsolAta
  );
  console.log(
    "  USDC->SOL route:",
    usdcToSol.quoteResponse.routePlan.map((r) => r.swapInfo.label).join(" -> "),
    "in:", usdcToSol.quoteResponse.inAmount,
    "out:", usdcToSol.quoteResponse.outAmount,
    "accounts:", usdcToSol.swapInstructions.swapInstruction.accounts.length
  );

  await new Promise((r) => setTimeout(r, 400));

  console.log("Fetching Jupiter SOL -> USDC route...");
  const solToUsdc = await fetchJupiterRoute(
    jupKey,
    WSOL_MINT,
    USDC_MINT,
    100_000_000, // 0.1 SOL
    stagePda,
    stageUsdcAta
  );
  console.log(
    "  SOL->USDC route:",
    solToUsdc.quoteResponse.routePlan.map((r) => r.swapInfo.label).join(" -> "),
    "in:", solToUsdc.quoteResponse.inAmount,
    "out:", solToUsdc.quoteResponse.outAmount,
    "accounts:", solToUsdc.swapInstructions.swapInstruction.accounts.length
  );

  fs.writeFileSync(path.join(ROUTES_DIR, "jupiter-usdc-to-sol.json"), JSON.stringify(usdcToSol, null, 2));
  fs.writeFileSync(path.join(ROUTES_DIR, "jupiter-sol-to-usdc.json"), JSON.stringify(solToUsdc, null, 2));

  // 2. Collect all candidate addresses (routes + Kamino + Jito + core programs)
  const wantedAddresses = new Set([
    USDC_MINT,
    WSOL_MINT,
    JITOSOL_MINT,
    JUPITER_V6,
    KAMINO_LEND,
    KAMINO_FARMS,
    KAMINO_MAIN_MARKET,
    KAMINO_USDC_RESERVE,
    KAMINO_SOL_RESERVE,
    SCOPE_ORACLE_PRICES,
    JITO_STAKE_POOL_PROGRAM,
    JITO_STAKE_POOL,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ATA_PROGRAM,
    LIGHTHOUSE_PROGRAM,
  ]);

  const skipStage = new Set([stagePda, stageUsdcAta, stageWsolAta, SYSTEM_PROGRAM]);
  for (const route of [usdcToSol, solToUsdc]) {
    const ix = route.swapInstructions.swapInstruction;
    wantedAddresses.add(ix.programId);
    for (const acc of ix.accounts) {
      if (!skipStage.has(acc.pubkey)) wantedAddresses.add(acc.pubkey);
    }
    for (const lut of route.swapInstructions.addressLookupTableAddresses || []) {
      wantedAddresses.add(lut);
    }
  }

  // 3. First pass getMultipleAccounts
  console.log(`Fetching ${wantedAddresses.size} mainnet accounts (pass 1)...`);
  const pass1 = await getMultipleAccountsChunked(rpcUrl, [...wantedAddresses]);

  // Discover secondary accounts (programdata for upgradeable programs, Kamino vaults, Jito pool accounts)
  const secondary = new Set();
  const upgradeablePrograms = new Map(); // programId -> programDataAddr
  const nonUpgradeablePrograms = new Set();

  function inspectAccount(addr, acct) {
    const data = Buffer.from(acct.data[0], "base64");
    if (acct.executable) {
      if (acct.owner === BPF_LOADER_UPGRADEABLE && data.length >= 36 && data.readUInt32LE(0) === 2) {
        const programDataAddr = base58Encode(data.subarray(4, 36));
        upgradeablePrograms.set(addr, programDataAddr);
        secondary.add(programDataAddr);
      } else if (acct.owner === BPF_LOADER_2 || acct.owner === BPF_LOADER_1) {
        nonUpgradeablePrograms.add(addr);
      }
    }
    // Also fetch owner program if it's not a native/system/token program
    if (
      acct.owner &&
      acct.owner !== SYSTEM_PROGRAM &&
      acct.owner !== BPF_LOADER_UPGRADEABLE &&
      acct.owner !== BPF_LOADER_2 &&
      acct.owner !== BPF_LOADER_1 &&
      acct.owner !== TOKEN_PROGRAM &&
      acct.owner !== TOKEN_2022_PROGRAM &&
      !acct.owner.startsWith("NativeLoader") &&
      !acct.owner.startsWith("AddressLookupTab")
    ) {
      secondary.add(acct.owner);
    }
  }

  for (const [addr, acct] of pass1.accounts.entries()) {
    inspectAccount(addr, acct);
  }

  // Extract Kamino reserve vaults & Jito stake pool accounts
  for (const resAddr of [KAMINO_USDC_RESERVE, KAMINO_SOL_RESERVE]) {
    const acct = pass1.accounts.get(resAddr);
    if (acct) {
      for (const pk of extractKaminoReserveAccounts(Buffer.from(acct.data[0], "base64"))) {
        secondary.add(pk);
      }
    }
  }
  const jitoAcct = pass1.accounts.get(JITO_STAKE_POOL);
  if (jitoAcct) {
    for (const pk of extractStakePoolAccounts(Buffer.from(jitoAcct.data[0], "base64"))) {
      secondary.add(pk);
    }
  }

  // Fetch secondary accounts + any programdata for newly discovered owner programs
  const toFetch2 = [...secondary].filter((a) => !pass1.accounts.has(a));
  const allAccounts = new Map(pass1.accounts);
  if (toFetch2.length > 0) {
    console.log(`Fetching ${toFetch2.length} secondary accounts (pass 2)...`);
    const pass2 = await getMultipleAccountsChunked(rpcUrl, toFetch2);
    const tertiary = new Set();
    for (const [addr, acct] of pass2.accounts.entries()) {
      allAccounts.set(addr, acct);
      const data = Buffer.from(acct.data[0], "base64");
      if (acct.executable && acct.owner === BPF_LOADER_UPGRADEABLE && data.length >= 36 && data.readUInt32LE(0) === 2) {
        const pd = base58Encode(data.subarray(4, 36));
        upgradeablePrograms.set(addr, pd);
        if (!allAccounts.has(pd)) tertiary.add(pd);
      }
    }
    if (tertiary.size > 0) {
      console.log(`Fetching ${tertiary.size} programdata accounts (pass 3)...`);
      const pass3 = await getMultipleAccountsChunked(rpcUrl, [...tertiary]);
      for (const [addr, acct] of pass3.accounts.entries()) {
        allAccounts.set(addr, acct);
      }
    }
  }

  // 4. Write programs (.so) and non-program accounts (.json)
  const programManifest = [];
  const skippedProgramData = new Set(upgradeablePrograms.values());
  const builtInSkip = new Set([
    SYSTEM_PROGRAM,
    "Sysvar1111111111111111111111111111111111111",
    "SysvarRent111111111111111111111111111111111",
    "SysvarC1ock11111111111111111111111111111111",
    "Sysvar1nstructions1111111111111111111111111",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
    "ComputeBudget111111111111111111111111111111",
    "AddressLookupTab1e1111111111111111111111111",
    "Stake11111111111111111111111111111111111111",
    "Config1111111111111111111111111111111111111",
    "Vote111111111111111111111111111111111111111",
  ]);

  for (const [progId, pdAddr] of upgradeablePrograms.entries()) {
    const pdAcct = allAccounts.get(pdAddr);
    if (!pdAcct) {
      console.warn(`Warning: missing programdata ${pdAddr} for ${progId}`);
      continue;
    }
    const raw = Buffer.from(pdAcct.data[0], "base64");
    if (raw.length <= 45) continue;
    const elf = trimElfPreservingHeaders(raw.subarray(45));
    const soPath = path.join(PROGRAMS_DIR, `${progId}.so`);
    fs.writeFileSync(soPath, elf);
    const sha256 = crypto.createHash("sha256").update(elf).digest("hex");
    programManifest.push({ address: progId, kind: "upgradeable", file: `${progId}.so`, size: elf.length, sha256 });
    console.log(`  Program (upgradeable) ${progId}: ${elf.length} B (sha256 ${sha256.slice(0, 12)}...)`);
  }

  for (const progId of nonUpgradeablePrograms) {
    const acct = allAccounts.get(progId);
    if (!acct) continue;
    const raw = Buffer.from(acct.data[0], "base64");
    const elf = trimElfPreservingHeaders(raw);
    const soPath = path.join(PROGRAMS_DIR, `${progId}.so`);
    fs.writeFileSync(soPath, elf);
    const sha256 = crypto.createHash("sha256").update(elf).digest("hex");
    programManifest.push({ address: progId, kind: "bpf", file: `${progId}.so`, size: elf.length, sha256 });
    console.log(`  Program (bpf)         ${progId}: ${elf.length} B (sha256 ${sha256.slice(0, 12)}...)`);
  }

  let accountCount = 0;
  for (const [addr, acct] of allAccounts.entries()) {
    if (upgradeablePrograms.has(addr) || nonUpgradeablePrograms.has(addr) || skippedProgramData.has(addr)) {
      continue;
    }
    if (builtInSkip.has(addr)) continue;
    if (acct.executable) continue; // skip any native loader executables

    // Reproducible localnet fixture patching:
    // 1. Rewrite USDC mint authority to local test keypair.
    // 2. Patch Jito Stake Pool `last_update_epoch` (offset 274..282) to localnet epoch 0.
    // 3. Patch Kamino Reserves' `last_update` (slot=0, stale=1, timestamp=0),
    //    `market_price_last_updated_ts=0`, and generous `max_age_price/twap_seconds`
    //    so `refresh_reserve` reads the captured Scope prices cleanly on the localnet clock.
    // 4. Patch Scope `OraclePrices` entries' `last_updated_slot=0` and keep timestamps valid.
    if (addr === USDC_MINT) {
      const raw = Buffer.from(acct.data[0], "base64");
      const mintAuthBytes = base58Decode(mintAuthority);
      raw.writeUInt32LE(1, 0); // COption::Some
      mintAuthBytes.copy(raw, 4); // bytes 4..36
      writeAccountJson(addr, { ...acct, data: [raw.toString("base64"), "base64"] });
      console.log(`  Patched USDC mint authority -> ${mintAuthority}`);
    } else if (addr === JITO_STAKE_POOL) {
      const raw = Buffer.from(acct.data[0], "base64");
      const oldEpoch = raw.readBigUInt64LE(274);
      raw.writeBigUInt64LE(0n, 274); // last_update_epoch = 0 (localnet starting epoch)
      writeAccountJson(addr, { ...acct, data: [raw.toString("base64"), "base64"] });
      console.log(`  Patched Jito Stake Pool last_update_epoch: ${oldEpoch} -> 0`);
    } else if (addr === KAMINO_USDC_RESERVE || addr === KAMINO_SOL_RESERVE) {
      const raw = Buffer.from(acct.data[0], "base64");
      const oldSlot = raw.readBigUInt64LE(16);
      raw.writeBigUInt64LE(0n, 16); // last_update.slot = 0
      raw[24] = 1; // last_update.stale = true
      raw.writeUInt32LE(0, 28); // last_update.timestamp = 0
      raw.writeBigUInt64LE(0n, 264); // liquidity.market_price_last_updated_ts = 0
      raw.writeBigUInt64LE(1_000_000_000n, 5096); // token_info.max_age_price_seconds
      raw.writeBigUInt64LE(1_000_000_000n, 5104); // token_info.max_age_twap_seconds
      writeAccountJson(addr, { ...acct, data: [raw.toString("base64"), "base64"] });
      console.log(`  Patched Kamino reserve ${addr}: slot ${oldSlot} -> 0, stale=1, max_age=1e9s`);
    } else if (addr === SCOPE_ORACLE_PRICES) {
      const raw = Buffer.from(acct.data[0], "base64");
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      let patchedEntries = 0;
      for (let i = 0; i < 512; i++) {
        const off = 40 + i * 56;
        if (off + 56 > raw.length) break;
        const val = raw.readBigUInt64LE(off);
        if (val !== 0n) {
          raw.writeBigUInt64LE(0n, off + 16); // last_updated_slot = 0
          const ts = raw.readBigUInt64LE(off + 24);
          if (ts > nowSec || ts === 0n) {
            raw.writeBigUInt64LE(nowSec, off + 24); // unix_timestamp <= localnet clock
          }
          patchedEntries++;
        }
      }
      writeAccountJson(addr, { ...acct, data: [raw.toString("base64"), "base64"] });
      console.log(`  Patched Scope OraclePrices (${patchedEntries} non-zero entries: slot -> 0)`);
    } else {
      writeAccountJson(addr, acct);
    }
    accountCount++;
  }

  const manifest = {
    captureSlot: pass1.slot,
    capturedAtUtc: new Date().toISOString(),
    pookProgramId: pookId,
    stagePda,
    stageUsdcAta,
    stageWsolAta,
    usdcMintAuthority: mintAuthority,
    programs: programManifest,
    accountCount,
    routes: {
      usdcToSol: {
        file: "routes/jupiter-usdc-to-sol.json",
        inAmount: usdcToSol.quoteResponse.inAmount,
        outAmount: usdcToSol.quoteResponse.outAmount,
        otherAmountThreshold: usdcToSol.quoteResponse.otherAmountThreshold,
        venues: usdcToSol.quoteResponse.routePlan.map((r) => r.swapInfo.label),
      },
      solToUsdc: {
        file: "routes/jupiter-sol-to-usdc.json",
        inAmount: solToUsdc.quoteResponse.inAmount,
        outAmount: solToUsdc.quoteResponse.outAmount,
        otherAmountThreshold: solToUsdc.quoteResponse.otherAmountThreshold,
        venues: solToUsdc.quoteResponse.routePlan.map((r) => r.swapInfo.label),
      },
    },
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Capture complete at slot ${pass1.slot}: ${programManifest.length} programs, ${accountCount} accounts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
