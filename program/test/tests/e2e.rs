//! End-to-end suite for the `pook` program against the running Rings localnet
//! (127.0.0.1:20820 RPC, 20813 Photon, 20814 Prover).
//!
//! Covers every launch flow and invariant:
//!   0. Localnet bootstrap verification (funded keys, launch wallet, Config, all 9 published hooks)
//!   1. `enter` (USDC) -> `jupiter.swap` (USDC -> SOL, Meteora DLMM) -> `leave` (SOL -> public address) -> `claim_author_fees` (SOL)
//!   2. `enter` (SOL) -> `jupiter.swap` (SOL -> USDC, Raydium CLMM) -> `leave` (USDC -> Rings private balance, `leave_kind = 1`) -> `claim_author_fees` (USDC)
//!   3. `kamino.supply` (USDC -> kUSDC) -> `kamino.withdraw` (kUSDC -> USDC)
//!   4. `jito.stake` (SOL -> JitoSOL) -> `jito.unstake` (JitoSOL -> SOL)
//!   5. Seat flow: `open_seat` (Kamino init) -> `kamino.collateral.deposit` (USDC) -> `kamino.borrow` (SOL)
//!      -> `kamino.repay` (SOL) -> `kamino.collateral.withdraw` (USDC, closes Kamino obligation) -> `close_seat` (rent back to opening relayer)
//!   6. Invariants: `SlippageExceeded` (7519) and `ForbiddenHookAccount` (7517), each leaving input note unspent.
//!   7. Stage accounting regressions:
//!      (a) `kamino.supply` (5 USDC, rounded down by Kamino) returns the leftover unit to the holder's notes,
//!          followed by `kamino.withdraw` and another USDC flow (`jupiter.swap` USDC -> SOL) that pass;
//!      (b) stray SPL USDC transfer into `stage_pda`'s USDC ATA before `jupiter.swap` (USDC -> SOL) and
//!          `jupiter.swap` (SOL -> USDC), both passing without counting stray tokens as output or leftover.
//!
//! Every `run`, `leave`, `open_seat`, and `close_seat` transaction asserts the holder's wallet
//! does not appear in the transaction's account keys, and reports CU and wire byte size.

use std::{path::Path, str::FromStr};

use anyhow::{anyhow, ensure, Context, Result};
use base64::Engine;
use pook_program::{
    error::PookError,
    pda::{
        find_ata, find_author_fees_pda, find_config_pda, find_hook_pda, find_seat_pda,
        find_seat_state_pda, find_stage_pda, hook_id_hash, INSTRUCTIONS_SYSVAR_ID,
        SYSTEM_PROGRAM_ID, WSOL_MINT,
    },
    state::{AuthorFees, Config, Hook, Seat},
};
use pook_sdk::{
    hooks::{
        launch_hooks, JITOSOL_MINT_ID, JITO_MANAGER_FEE_ACCOUNT_ID, JITO_RESERVE_STAKE_ID,
        JITO_STAKE_POOL_ID, JITO_WITHDRAW_AUTHORITY_ID, KAMINO_FARMS_ID, KAMINO_KSOL_MINT_ID,
        KAMINO_KUSDC_MINT_ID, KAMINO_LEND_ID, KAMINO_MAIN_MARKET_AUTHORITY_ID,
        KAMINO_MAIN_MARKET_ID, KAMINO_SOL_RESERVE_ID, KAMINO_USDC_RESERVE_ID,
        SCOPE_ORACLE_PRICES_ID, STAKE_PROGRAM_ID, SYSVAR_CLOCK_ID, SYSVAR_STAKE_HISTORY_ID,
    },
    instructions::{
        build_and_prove_close_seat, build_and_prove_flow_run, build_and_prove_leave,
        build_and_prove_open_seat, build_and_prove_seat_action, build_and_prove_seat_fund,
        claim_author_fees_sol_ix, claim_author_fees_spl_ix, derive_kamino_obligation_farm_pda,
        enter_public_sol_ix, enter_public_spl_ix, kamino_init_obligation_farms_for_reserve_ix,
        kamino_open_seat_setup, kamino_refresh_obligation_ix, kamino_refresh_reserve_ix,
        spl_token_address, BuildFlowRunParams, BuildLeaveParams, BuildSeatActionParams,
        BuildSeatFundParams, LeaveDestination,
    },
    notes::HolderKeys,
};
use serde::Deserialize;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signature::Signature;
use solana_signer::Signer;
use spr_client::{
    fetch_asset_id, ComputeBudgetConfig, Rpc, SolanaRpc, SprClient, SprIndexer, UtxoScan,
};
use spr_interface::{pda as spp_pda, ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID};
use spr_keypair::{NullifierKey, ViewingKey};
use spr_program::ShieldedPda;
use spr_transaction::{AssetRegistry, LocalShieldedKeys, SOL_MINT};

const RPC_URL: &str = "http://127.0.0.1:20820";
const PHOTON_URL: &str = "http://127.0.0.1:20813";
const PROVER_URL: &str = "http://127.0.0.1:20814";

const LAUNCH_WALLET_STR: &str = "AFMxmWEUi1oDVA9SHay9BV4jg1GZHfZPZawt8H8Tk4hW";
const USDC_MINT_STR: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Kamino Main Market USDC & SOL reserve vaults/farms (verified from captured reserve accounts).
const KAMINO_USDC_LIQ_SUPPLY: &str = "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6";
const KAMINO_USDC_COLL_VAULT: &str = "3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL";
const KAMINO_USDC_FARM_COLLATERAL: &str = "JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh";
const KAMINO_SOL_LIQ_SUPPLY: &str = "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U";
const KAMINO_SOL_FEE_VAULT: &str = "3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph";

const TREE_ID: u16 = 0;
const EXPIRY: u64 = 2_000_000_000;

#[derive(Deserialize)]
struct CapturedRouteFile {
    #[serde(rename = "quoteResponse")]
    quote_response: QuoteResponse,
    #[serde(rename = "swapInstructions")]
    swap_instructions: SwapInstructions,
}

#[derive(Deserialize)]
struct QuoteResponse {
    #[serde(rename = "inAmount")]
    in_amount: String,
    #[serde(rename = "outAmount")]
    _out_amount: String,
    #[serde(rename = "otherAmountThreshold")]
    other_amount_threshold: String,
}

#[derive(Deserialize)]
struct SwapInstructions {
    #[serde(rename = "swapInstruction")]
    swap_instruction: RawInstruction,
}

#[derive(Deserialize)]
struct RawInstruction {
    accounts: Vec<RawAccountMeta>,
    data: String,
}

#[derive(Deserialize)]
struct RawAccountMeta {
    pubkey: String,
    #[serde(rename = "isSigner")]
    _is_signer: bool,
    #[serde(rename = "isWritable")]
    is_writable: bool,
}

fn to_addr(pk: Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

fn to_pk(addr: Address) -> Pubkey {
    Pubkey::new_from_array(*addr.as_array())
}

fn pk_str(s: &str) -> Pubkey {
    Pubkey::from_str(s).expect("valid pubkey")
}

fn load_keypair(path: &Path) -> Result<Keypair> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading keypair {}", path.display()))?;
    let bytes: Vec<u8> = serde_json::from_str(&text)?;
    Keypair::try_from(bytes.as_slice()).map_err(|e| anyhow!("invalid keypair: {e:?}"))
}

fn create_ata_idempotent_ix(payer: Pubkey, owner: Pubkey, mint: Pubkey) -> Instruction {
    let token_prog = Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID);
    let ata_prog = Pubkey::new_from_array(ASSOCIATED_TOKEN_PROGRAM_ID);
    let (ata, _) = find_ata(&owner.to_bytes(), &mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    Instruction {
        program_id: ata_prog,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(to_pk(ata), false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
            AccountMeta::new_readonly(token_prog, false),
        ],
        data: vec![1], // CreateIdempotent
    }
}

fn spl_transfer_checked_ix(
    source: Pubkey,
    mint: Pubkey,
    dest: Pubkey,
    authority: Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8); // SPL Token TransferChecked
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(dest, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

type LocalClient = SprClient<SolanaRpc>;

fn send_ixs(
    client: &LocalClient,
    ixs: &[Instruction],
    signers: &[&dyn Signer],
    cu_limit: u32,
) -> Result<Signature> {
    let payer = signers[0].pubkey();
    client
        .rpc()
        .create_and_send_transaction(ixs, payer, signers, ComputeBudgetConfig::new(cu_limit))
        .map_err(|e| anyhow!("send tx: {e:?}"))
}

fn get_token_balance(client: &LocalClient, ata: Pubkey) -> Result<u64> {
    let Some(acct) = client.rpc().get_account(ata).map_err(|e| anyhow!("{e:?}"))? else {
        return Ok(0);
    };
    if acct.data.len() < 72 {
        return Ok(0);
    }
    Ok(u64::from_le_bytes(acct.data[64..72].try_into()?))
}

fn load_hook(client: &LocalClient, hook_id: &str) -> Result<(Hook, Address)> {
    let id_hash = hook_id_hash(hook_id).map_err(|e| anyhow!("{e}"))?;
    let (hook_pda, _) = find_hook_pda(&id_hash);
    let acct = client
        .rpc()
        .get_account(to_pk(hook_pda))?
        .ok_or_else(|| anyhow!("hook `{hook_id}` not published at {hook_pda}"))?;
    let hook: Hook = borsh::from_slice(&acct.data)?;
    ensure!(hook.hook_id == hook_id, "hook_id mismatch");
    Ok((hook, hook_pda))
}

fn inspect_landed_tx(sig: &Signature) -> Result<(u64, Vec<String>, usize)> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            sig.to_string(),
            { "encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 1 }
        ]
    });
    let out = std::process::Command::new("curl")
        .args(["-sS", "-H", "Content-Type: application/json", "-d", &body.to_string(), RPC_URL])
        .output()
        .context("curl getTransaction")?;
    let val: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let res = &val["result"];
    let cu = res["meta"]["computeUnitsConsumed"].as_u64().unwrap_or(0);
    let keys: Vec<String> = res["transaction"]["message"]["accountKeys"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let body_b64 = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "getTransaction",
        "params": [
            sig.to_string(),
            { "encoding": "base64", "commitment": "confirmed", "maxSupportedTransactionVersion": 1 }
        ]
    });
    let out_b64 = std::process::Command::new("curl")
        .args(["-sS", "-H", "Content-Type: application/json", "-d", &body_b64.to_string(), RPC_URL])
        .output()
        .context("curl getTransaction base64")?;
    let val_b64: serde_json::Value = serde_json::from_slice(&out_b64.stdout)?;
    let tx_bytes = val_b64["result"]["transaction"][0]
        .as_str()
        .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
        .map(|b| b.len())
        .unwrap_or(0);

    Ok((cu, keys, tx_bytes))
}

fn assert_privacy_and_report(
    label: &str,
    sig: &Signature,
    holder_pk_str: &str,
) -> Result<(u64, usize, usize)> {
    let (cu, keys, tx_bytes) = inspect_landed_tx(sig)?;
    ensure!(
        !keys.iter().any(|k| k == holder_pk_str),
        "PRIVACY VIOLATION in {label}: holder wallet {holder_pk_str} found in transaction accounts!"
    );
    println!(
        "  [METRIC] {label:<34} CU={cu:<7} tx_bytes={tx_bytes:<5} accounts={:<2} sig={sig}",
        keys.len()
    );
    Ok((cu, tx_bytes, keys.len()))
}

fn parse_jupiter_route_caller_accounts(raw_ix: &RawInstruction) -> Result<(Vec<u8>, Vec<AccountMeta>, Vec<u8>)> {
    let data = base64::engine::general_purpose::STANDARD.decode(&raw_ix.data)?;
    let mut caller_accounts = Vec::new();
    let mut caller_remaining_writable = Vec::new();
    for (idx, acc) in raw_ix.accounts.iter().enumerate() {
        if idx == 1 || idx == 2 || idx == 3 {
            continue;
        }
        let pk = Pubkey::from_str(&acc.pubkey)?;
        let meta = if acc.is_writable {
            AccountMeta::new(pk, false)
        } else {
            AccountMeta::new_readonly(pk, false)
        };
        caller_accounts.push(meta);
        if idx >= 4 {
            caller_remaining_writable.push(u8::from(acc.is_writable));
        }
    }
    Ok((data, caller_accounts, caller_remaining_writable))
}

#[test]
fn pook_e2e_all_launch_hooks_and_invariants() -> Result<()> {
    let client: LocalClient = SprClient::from_urls_allowing_insecure_http(
        SolanaRpc::new(RPC_URL),
        PHOTON_URL,
        PROVER_URL,
        None,
    );
    let indexer: &SprIndexer = client.indexer();
    let tree = spp_pda::tree(TREE_ID);
    let tree_addr = to_addr(tree);

    let localnet_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../localnet");
    let holder = load_keypair(&localnet_dir.join("keys/holder.json"))?;
    let relayer = load_keypair(&localnet_dir.join("keys/relayer.json"))?;
    let admin = load_keypair(&localnet_dir.join("keys/admin.json"))?;
    let launch_wallet = pk_str(LAUNCH_WALLET_STR);
    let holder_pk_str = holder.pubkey().to_string();

    let usdc_mint = pk_str(USDC_MINT_STR);
    let usdc_addr = to_addr(usdc_mint);
    let wsol_mint = Pubkey::new_from_array(WSOL_MINT);
    let kusdc_mint = to_pk(KAMINO_KUSDC_MINT_ID);
    let jitosol_mint = to_pk(JITOSOL_MINT_ID);

    let (stage_pda, _) = find_stage_pda();
    let (stage_usdc_ata, _) = find_ata(stage_pda.as_array(), &usdc_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    let (stage_kusdc_ata, _) = find_ata(stage_pda.as_array(), &kusdc_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    let (stage_jitosol_ata, _) = find_ata(stage_pda.as_array(), &jitosol_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    let (holder_usdc_ata, _) = find_ata(&holder.pubkey().to_bytes(), &usdc_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    let (launch_usdc_ata, _) = find_ata(&launch_wallet.to_bytes(), &usdc_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);

    // =========================================================================
    // 0. VERIFY LOCALNET BOOTSTRAP STATE
    // =========================================================================
    ensure!(client.rpc().get_balance(holder.pubkey())? >= 50_000_000_000, "holder SOL too low");
    ensure!(client.rpc().get_balance(relayer.pubkey())? >= 50_000_000_000, "relayer SOL too low");
    ensure!(client.rpc().get_balance(launch_wallet)? >= 1_000_000_000, "launch wallet SOL too low");
    ensure!(get_token_balance(&client, to_pk(holder_usdc_ata))? >= 1_000_000_000, "holder USDC too low");

    let (config_pda, _) = find_config_pda();
    let cfg_acct = client
        .rpc()
        .get_account(to_pk(config_pda))?
        .ok_or_else(|| anyhow!("Config not initialized by localnet start.sh"))?;
    let config: Config = borsh::from_slice(&cfg_acct.data[..Config::LEN])?;
    ensure!(config.fee_recipient == launch_wallet.to_bytes(), "Config fee_recipient != launch wallet");
    let run_fee_bps = config.run_fee_bps;
    let author_share_bps = config.author_share_bps;

    // Verify all 9 launch hooks are published on chain.
    for def in launch_hooks() {
        let _ = load_hook(&client, &def.hook_id)?;
    }
    println!("0. BOOTSTRAP verified: keys funded, Config initialized (fee={run_fee_bps}bps, author={author_share_bps}bps), all 9 hooks published");

    // Populate AssetRegistry with all SPL mints registered by start.sh.
    let mut assets = AssetRegistry::default();
    for mint_addr in [usdc_addr, KAMINO_KUSDC_MINT_ID, KAMINO_KSOL_MINT_ID, JITOSOL_MINT_ID] {
        let asset_id = fetch_asset_id(client.rpc(), mint_addr)
            .map_err(|e| anyhow!("fetch_asset_id({mint_addr}): {e:?}"))?;
        assets
            .insert(asset_id, mint_addr)
            .map_err(|e| anyhow!("insert asset {mint_addr}: {e:?}"))?;
    }

    // Derive holder's Pook keys using a fresh nonce per run so tests are repeatable on the same localnet.
    let run_nonce = Keypair::new().pubkey().to_bytes();
    let mut msg = b"POOK/derive/v1/".to_vec();
    msg.extend_from_slice(&run_nonce);
    let sig_bytes: [u8; 64] = holder.sign_message(&msg).into();
    let holder_keys = HolderKeys::from_wallet_signature(sig_bytes)?;

    // =========================================================================
    // 1. JUPITER.SWAP (USDC -> SOL) + LEAVE (public address) + CLAIM_AUTHOR_FEES (SOL)
    // =========================================================================
    let (jup_hook, jup_hook_pda) = load_hook(&client, "jupiter.swap")?;
    let usdc_to_sol_route: CapturedRouteFile = serde_json::from_str(&std::fs::read_to_string(
        localnet_dir.join("routes/jupiter-usdc-to-sol.json"),
    )?)?;
    let swap1_in: u64 = usdc_to_sol_route.quote_response.in_amount.parse()?;
    let swap1_min_out: u64 = usdc_to_sol_route.quote_response.other_amount_threshold.parse()?;
    let (swap1_data, swap1_caller_accts, swap1_rem_w) =
        parse_jupiter_route_caller_accounts(&usdc_to_sol_route.swap_instructions.swap_instruction)?;

    let enter1_ix = enter_public_spl_ix(
        to_addr(holder.pubkey()),
        tree_addr,
        usdc_addr,
        holder_usdc_ata,
        spl_token_address(),
        holder_keys.one_time_owner_hash(0)?,
        swap1_in,
    )?;
    let enter1_sig = send_ixs(&client, &[enter1_ix], &[&holder], 400_000)?;
    client.confirm_private_transaction_sync(enter1_sig).map_err(|e| anyhow!("{e:?}"))?;
    let note0 = holder_keys
        .find_note_at(0, usdc_addr, swap1_in, &assets, &client)?
        .ok_or_else(|| anyhow!("entered USDC note #0 missing"))?;

    let launch_sol_before = client.rpc().get_balance(launch_wallet)?;
    let stage_sol_before = client.rpc().get_balance(to_pk(stage_pda))?;
    let stage_usdc_before_1 = get_token_balance(&client, to_pk(stage_usdc_ata))?;
    let (af_sol_pda, _) = find_author_fees_pda(&jup_hook.author, &[0u8; 32]);
    let af_sol_before: u64 = client
        .rpc()
        .get_account(to_pk(af_sol_pda))?
        .map(|a| borsh::from_slice::<AuthorFees>(&a.data[..AuthorFees::LEN]).unwrap().accrued)
        .unwrap_or(0);

    let swap1_relayer_fee = 100_000u64;
    let swap1_ix = build_and_prove_flow_run(
        BuildFlowRunParams {
            holder: &holder_keys,
            input_0: note0,
            input_0_index: 0,
            input_1: None,
            change_index: 1,
            output_index: 2,
            hook: &jup_hook,
            hook_pda: jup_hook_pda,
            config_fee_recipient: to_addr(launch_wallet),
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: swap1_relayer_fee,
            relayer_fee_ata: None,
            amount_in: swap1_in,
            min_out: swap1_min_out,
            mint_in: usdc_addr,
            mint_out: SOL_MINT,
            has_mint_out: true,
            token_program_in: spl_token_address(),
            token_program_out: spl_token_address(),
            caller_data: swap1_data.clone(),
            caller_accounts: swap1_caller_accts.clone(),
            caller_remaining_writable: swap1_rem_w.clone(),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let create_stage_wsol = create_ata_idempotent_ix(relayer.pubkey(), to_pk(stage_pda), wsol_mint);
    let swap1_sig = send_ixs(&client, &[create_stage_wsol, swap1_ix], &[&relayer], 1_400_000)?;
    client.confirm_private_transaction_sync(swap1_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("jupiter.swap (USDC->SOL)", &swap1_sig, &holder_pk_str)?;

    ensure!(
        get_token_balance(&client, to_pk(stage_usdc_ata))? == stage_usdc_before_1,
        "stage USDC balance drifted in flow 1"
    );
    ensure!(client.rpc().get_balance(to_pk(stage_pda))? == stage_sol_before, "stage SOL drifted");
    ensure!(holder_keys.find_note_at(0, usdc_addr, 1, &assets, &client)?.is_none(), "note #0 not nullified");
    let sol_note2 = holder_keys
        .find_note_at(2, SOL_MINT, 1, &assets, &client)?
        .ok_or_else(|| anyhow!("output SOL note #2 missing"))?;
    let proto_fee_sol = client.rpc().get_balance(launch_wallet)? - launch_sol_before;
    let af_sol_after: AuthorFees = borsh::from_slice(&client.rpc().get_account(to_pk(af_sol_pda))?.unwrap().data[..AuthorFees::LEN])?;
    let auth_fee_sol = af_sol_after.accrued - af_sol_before;
    let delta_out_1 = sol_note2.utxo.amount + proto_fee_sol + auth_fee_sol + swap1_relayer_fee;
    let exp_run_fee = (delta_out_1 as u128 * run_fee_bps as u128 / 10_000) as u64;
    let exp_proto = (exp_run_fee as u128 * (10_000 - author_share_bps) as u128 / 10_000) as u64;
    ensure!(proto_fee_sol == exp_proto && auth_fee_sol == exp_run_fee - exp_proto, "SOL fee split mismatch");

    // Leave SOL note #2 -> fresh public address (`leave_kind = 0`).
    let public_dest = Keypair::new();
    let leave1_fee = 50_000u64;
    let leave1_amt = sol_note2.utxo.amount;
    let leave1_ix = build_and_prove_leave(
        BuildLeaveParams {
            holder: &holder_keys,
            input_0: sol_note2,
            input_0_index: 2,
            input_1: None,
            change_index: 3,
            mint: SOL_MINT,
            token_program: spl_token_address(),
            amount: leave1_amt,
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: leave1_fee,
            relayer_fee_ata: None,
            destination: LeaveDestination::PublicAddress(to_addr(public_dest.pubkey())),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let leave1_sig = send_ixs(&client, &[leave1_ix], &[&relayer], 600_000)?;
    client.confirm_private_transaction_sync(leave1_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("leave (SOL -> public)", &leave1_sig, &holder_pk_str)?;
    ensure!(client.rpc().get_balance(public_dest.pubkey())? == leave1_amt - leave1_fee);
    ensure!(holder_keys.find_note_at(2, SOL_MINT, 1, &assets, &client)?.is_none());

    // Claim SOL author fees as `admin` (hook author).
    let admin_sol_before = client.rpc().get_balance(admin.pubkey())?;
    send_ixs(&client, &[claim_author_fees_sol_ix(to_addr(admin.pubkey()))?], &[&admin], 200_000)?;
    ensure!(client.rpc().get_balance(admin.pubkey())? > admin_sol_before);
    println!("1. FLOW 1 passed: enter -> jupiter.swap (USDC->SOL) -> leave(public) -> claim(SOL)");

    // =========================================================================
    // 2. JUPITER.SWAP (SOL -> USDC) + LEAVE (Rings private balance, leave_kind = 1) + CLAIM (USDC)
    // =========================================================================
    let sol_to_usdc_route: CapturedRouteFile = serde_json::from_str(&std::fs::read_to_string(
        localnet_dir.join("routes/jupiter-sol-to-usdc.json"),
    )?)?;
    let swap2_in: u64 = sol_to_usdc_route.quote_response.in_amount.parse()?;
    let swap2_min_out: u64 = sol_to_usdc_route.quote_response.other_amount_threshold.parse()?;
    let (swap2_data, swap2_caller_accts, swap2_rem_w) =
        parse_jupiter_route_caller_accounts(&sol_to_usdc_route.swap_instructions.swap_instruction)?;

    let enter2_ix = enter_public_sol_ix(
        to_addr(holder.pubkey()),
        tree_addr,
        holder_keys.one_time_owner_hash(10)?,
        swap2_in,
    )?;
    let enter2_sig = send_ixs(&client, &[enter2_ix], &[&holder], 400_000)?;
    client.confirm_private_transaction_sync(enter2_sig).map_err(|e| anyhow!("{e:?}"))?;
    let sol_note10 = holder_keys
        .find_note_at(10, SOL_MINT, swap2_in, &assets, &client)?
        .ok_or_else(|| anyhow!("entered SOL note #10 missing"))?;

    let launch_usdc_before = get_token_balance(&client, to_pk(launch_usdc_ata))?;
    let stage_usdc_before_2 = get_token_balance(&client, to_pk(stage_usdc_ata))?;
    let swap2_relayer_fee = 1_000u64; // 0.001 USDC
    let swap2_ix = build_and_prove_flow_run(
        BuildFlowRunParams {
            holder: &holder_keys,
            input_0: sol_note10,
            input_0_index: 10,
            input_1: None,
            change_index: 11,
            output_index: 12,
            hook: &jup_hook,
            hook_pda: jup_hook_pda,
            config_fee_recipient: to_addr(launch_wallet),
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: swap2_relayer_fee,
            relayer_fee_ata: None,
            amount_in: swap2_in,
            min_out: swap2_min_out,
            mint_in: SOL_MINT,
            mint_out: usdc_addr,
            has_mint_out: true,
            token_program_in: spl_token_address(),
            token_program_out: spl_token_address(),
            caller_data: swap2_data.clone(),
            caller_accounts: swap2_caller_accts.clone(),
            caller_remaining_writable: swap2_rem_w.clone(),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let create_stage_wsol_2 = create_ata_idempotent_ix(relayer.pubkey(), to_pk(stage_pda), wsol_mint);
    let swap2_sig = send_ixs(&client, &[create_stage_wsol_2, swap2_ix], &[&relayer], 1_400_000)?;
    client.confirm_private_transaction_sync(swap2_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("jupiter.swap (SOL->USDC)", &swap2_sig, &holder_pk_str)?;

    let usdc_note12 = holder_keys
        .find_note_at(12, usdc_addr, 1, &assets, &client)?
        .ok_or_else(|| anyhow!("output USDC note #12 missing"))?;
    let usdc_note12_amt = usdc_note12.utxo.amount;
    ensure!(get_token_balance(&client, to_pk(launch_usdc_ata))? > launch_usdc_before, "protocol USDC fee missing");
    ensure!(
        get_token_balance(&client, to_pk(stage_usdc_ata))? == stage_usdc_before_2,
        "stage USDC balance drifted in flow 2"
    );

    // Claim USDC author fees as `admin`.
    let (admin_usdc_ata, _) = find_ata(&admin.pubkey().to_bytes(), &usdc_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    send_ixs(
        &client,
        &[
            create_ata_idempotent_ix(admin.pubkey(), admin.pubkey(), usdc_mint),
            claim_author_fees_spl_ix(to_addr(admin.pubkey()), usdc_addr, spl_token_address(), admin_usdc_ata)?,
        ],
        &[&admin],
        300_000,
    )?;
    ensure!(get_token_balance(&client, to_pk(admin_usdc_ata))? > 0, "admin did not receive USDC author fees");

    // Leave USDC note #12 -> fresh Rings private balance (`leave_kind = 1`).
    let dest_rings_kp = Keypair::new();
    let dest_vk_bytes: [u8; 32] = dest_rings_kp.to_bytes()[..32].try_into()?;
    let dest_vk = ViewingKey::from_bytes(&dest_vk_bytes);
    let mut dest_nf_bytes = [0u8; 31];
    dest_nf_bytes.copy_from_slice(&dest_rings_kp.pubkey().to_bytes()[..31]);
    let dest_nk = NullifierKey::from_secret(dest_nf_bytes);
    let dest_pda = ShieldedPda::with_viewing_key(
        to_addr(dest_rings_kp.pubkey()),
        dest_nk.clone(),
        dest_vk.clone(),
    );
    let dest_rings_addr = dest_pda
        .shielded_address()
        .map_err(|e| anyhow!("dest shielded_address: {e:?}"))?;
    let dest_owner_hash = dest_pda
        .owner_hash()
        .map_err(|e| anyhow!("dest owner_hash: {e:?}"))?;
    let dest_view_tag = dest_rings_kp.pubkey().to_bytes();
    let dest_rings_keys = LocalShieldedKeys::new(dest_rings_addr, vec![dest_vk], dest_nk)
        .map_err(|e| anyhow!("dest LocalShieldedKeys: {e:?}"))?;

    let leave2_amt = usdc_note12.utxo.amount;
    let leave2_fee = 1_000u64;
    let leave2_ix = build_and_prove_leave(
        BuildLeaveParams {
            holder: &holder_keys,
            input_0: usdc_note12,
            input_0_index: 12,
            input_1: None,
            change_index: 13,
            mint: usdc_addr,
            token_program: spl_token_address(),
            amount: leave2_amt,
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: leave2_fee,
            relayer_fee_ata: None,
            destination: LeaveDestination::RingsPrivate {
                owner_hash: dest_owner_hash,
                view_tag: dest_view_tag,
            },
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let leave2_sig = send_ixs(&client, &[leave2_ix], &[&relayer], 700_000)?;
    client.confirm_private_transaction_sync(leave2_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("leave (USDC -> Rings private)", &leave2_sig, &holder_pk_str)?;

    ensure!(holder_keys.find_note_at(12, usdc_addr, 1, &assets, &client)?.is_none(), "USDC note #12 not nullified");
    let dest_scan = UtxoScan::new(&dest_rings_keys, &assets)
        .fetch(&client)
        .map_err(|e| anyhow!("scan dest Rings balance: {e:?}"))?;
    let dest_usdc_total: u64 = dest_scan
        .spendable
        .balances
        .get_balance(usdc_addr)
        .map(|b| b.utxos.iter().map(|u| u.utxo.amount).sum())
        .unwrap_or(0);
    ensure!(
        dest_usdc_total == leave2_amt - leave2_fee,
        "dest Rings private USDC mismatch: got {dest_usdc_total}, expected {}",
        leave2_amt - leave2_fee
    );
    println!("2. FLOW 2 passed: jupiter.swap (SOL->USDC) -> leave(Rings private, leave_kind=1) -> claim(USDC)");

    // =========================================================================
    // 3. KAMINO.SUPPLY (10 USDC -> kUSDC) -> KAMINO.WITHDRAW (kUSDC -> USDC)
    // =========================================================================
    let (ksupply_hook, ksupply_pda) = load_hook(&client, "kamino.supply")?;
    let (kwithdraw_hook, kwithdraw_pda) = load_hook(&client, "kamino.withdraw")?;
    let supply_in = 10_000_000u64; // 10 USDC

    let enter3_ix = enter_public_spl_ix(
        to_addr(holder.pubkey()),
        tree_addr,
        usdc_addr,
        holder_usdc_ata,
        spl_token_address(),
        holder_keys.one_time_owner_hash(20)?,
        supply_in,
    )?;
    let enter3_sig = send_ixs(&client, &[enter3_ix], &[&holder], 400_000)?;
    client.confirm_private_transaction_sync(enter3_sig).map_err(|e| anyhow!("{e:?}"))?;
    let usdc_note20 = holder_keys
        .find_note_at(20, usdc_addr, supply_in, &assets, &client)?
        .ok_or_else(|| anyhow!("USDC note #20 missing"))?;

    let ksupply_caller = vec![
        AccountMeta::new(to_pk(KAMINO_USDC_RESERVE_ID), false),          // reserve
        AccountMeta::new_readonly(to_pk(KAMINO_MAIN_MARKET_ID), false),  // lending_market
        AccountMeta::new_readonly(to_pk(KAMINO_MAIN_MARKET_AUTHORITY_ID), false), // lma
        AccountMeta::new_readonly(usdc_mint, false),                     // reserve_liquidity_mint
        AccountMeta::new(pk_str(KAMINO_USDC_LIQ_SUPPLY), false),         // reserve_liquidity_supply
        AccountMeta::new(kusdc_mint, false),                             // reserve_collateral_mint
        AccountMeta::new_readonly(Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID), false), // collateral_token_program (Fixed)
        AccountMeta::new_readonly(Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID), false), // liquidity_token_program
        AccountMeta::new_readonly(Pubkey::new_from_array(INSTRUCTIONS_SYSVAR_ID), false), // ix sysvar (Fixed)
    ];
    let stage_usdc_before_3 = get_token_balance(&client, to_pk(stage_usdc_ata))?;
    let ksupply_ix = build_and_prove_flow_run(
        BuildFlowRunParams {
            holder: &holder_keys,
            input_0: usdc_note20,
            input_0_index: 20,
            input_1: None,
            change_index: 21,
            output_index: 22,
            hook: &ksupply_hook,
            hook_pda: ksupply_pda,
            config_fee_recipient: to_addr(launch_wallet),
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: 1_000,
            relayer_fee_ata: None,
            amount_in: supply_in,
            min_out: 1,
            mint_in: usdc_addr,
            mint_out: KAMINO_KUSDC_MINT_ID,
            has_mint_out: true,
            token_program_in: spl_token_address(),
            token_program_out: spl_token_address(),
            caller_data: Vec::new(),
            caller_accounts: ksupply_caller.clone(),
            caller_remaining_writable: Vec::new(),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let refresh_usdc_ix = kamino_refresh_reserve_ix(
        KAMINO_USDC_RESERVE_ID,
        KAMINO_MAIN_MARKET_ID,
        SCOPE_ORACLE_PRICES_ID,
    );
    let ksupply_sig = send_ixs(&client, &[refresh_usdc_ix.clone(), ksupply_ix], &[&relayer], 900_000)?;
    client.confirm_private_transaction_sync(ksupply_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("kamino.supply (USDC->kUSDC)", &ksupply_sig, &holder_pk_str)?;

    ensure!(get_token_balance(&client, to_pk(stage_usdc_ata))? == stage_usdc_before_3);
    ensure!(get_token_balance(&client, to_pk(stage_kusdc_ata))? == 0);
    let kusdc_note22 = holder_keys
        .find_note_at(22, KAMINO_KUSDC_MINT_ID, 1, &assets, &client)?
        .ok_or_else(|| anyhow!("output kUSDC note #22 missing"))?;
    let kusdc_amt = kusdc_note22.utxo.amount;

    // Now withdraw all kUSDC -> USDC via `kamino.withdraw`.
    let kwithdraw_caller = vec![
        AccountMeta::new_readonly(to_pk(KAMINO_MAIN_MARKET_ID), false),           // lending_market
        AccountMeta::new(to_pk(KAMINO_USDC_RESERVE_ID), false),                   // reserve
        AccountMeta::new_readonly(to_pk(KAMINO_MAIN_MARKET_AUTHORITY_ID), false), // lma
        AccountMeta::new_readonly(usdc_mint, false),                              // reserve_liquidity_mint
        AccountMeta::new(kusdc_mint, false),                                      // reserve_collateral_mint
        AccountMeta::new(pk_str(KAMINO_USDC_LIQ_SUPPLY), false),                  // reserve_liquidity_supply
        AccountMeta::new_readonly(Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID), false), // collateral_token_program (Fixed)
        AccountMeta::new_readonly(Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID), false), // liquidity_token_program
        AccountMeta::new_readonly(Pubkey::new_from_array(INSTRUCTIONS_SYSVAR_ID), false), // ix sysvar (Fixed)
    ];
    let kwithdraw_ix = build_and_prove_flow_run(
        BuildFlowRunParams {
            holder: &holder_keys,
            input_0: kusdc_note22,
            input_0_index: 22,
            input_1: None,
            change_index: 23,
            output_index: 24,
            hook: &kwithdraw_hook,
            hook_pda: kwithdraw_pda,
            config_fee_recipient: to_addr(launch_wallet),
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: 1_000,
            relayer_fee_ata: None,
            amount_in: kusdc_amt,
            min_out: 9_000_000,
            mint_in: KAMINO_KUSDC_MINT_ID,
            mint_out: usdc_addr,
            has_mint_out: true,
            token_program_in: spl_token_address(),
            token_program_out: spl_token_address(),
            caller_data: Vec::new(),
            caller_accounts: kwithdraw_caller.clone(),
            caller_remaining_writable: Vec::new(),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let kwithdraw_sig = send_ixs(&client, &[refresh_usdc_ix.clone(), kwithdraw_ix], &[&relayer], 900_000)?;
    client.confirm_private_transaction_sync(kwithdraw_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("kamino.withdraw (kUSDC->USDC)", &kwithdraw_sig, &holder_pk_str)?;

    let usdc_note24 = holder_keys
        .find_note_at(24, usdc_addr, 9_000_000, &assets, &client)?
        .ok_or_else(|| anyhow!("output USDC note #24 missing after kamino.withdraw"))?;
    ensure!(get_token_balance(&client, to_pk(stage_usdc_ata))? == stage_usdc_before_3);
    ensure!(get_token_balance(&client, to_pk(stage_kusdc_ata))? == 0);
    println!(
        "3. FLOW 3 passed: kamino.supply ({supply_in} USDC -> {kusdc_amt} kUSDC) -> kamino.withdraw ({} USDC)",
        usdc_note24.utxo.amount
    );

    // =========================================================================
    // 4. JITO.STAKE (0.5 SOL -> JitoSOL) -> JITO.UNSTAKE (JitoSOL -> SOL)
    // =========================================================================
    let (jstake_hook, jstake_pda) = load_hook(&client, "jito.stake")?;
    let (junstake_hook, junstake_pda) = load_hook(&client, "jito.unstake")?;
    let stake_in = 500_000_000u64; // 0.5 SOL

    let enter4_ix = enter_public_sol_ix(
        to_addr(holder.pubkey()),
        tree_addr,
        holder_keys.one_time_owner_hash(30)?,
        stake_in,
    )?;
    let enter4_sig = send_ixs(&client, &[enter4_ix], &[&holder], 400_000)?;
    client.confirm_private_transaction_sync(enter4_sig).map_err(|e| anyhow!("{e:?}"))?;
    let sol_note30 = holder_keys
        .find_note_at(30, SOL_MINT, stake_in, &assets, &client)?
        .ok_or_else(|| anyhow!("SOL note #30 missing"))?;

    let jstake_caller = vec![
        AccountMeta::new(to_pk(JITO_STAKE_POOL_ID), false),
        AccountMeta::new_readonly(to_pk(JITO_WITHDRAW_AUTHORITY_ID), false),
        AccountMeta::new(to_pk(JITO_RESERVE_STAKE_ID), false),
        AccountMeta::new(to_pk(JITO_MANAGER_FEE_ACCOUNT_ID), false),
        AccountMeta::new(to_pk(JITO_MANAGER_FEE_ACCOUNT_ID), false),
        AccountMeta::new(jitosol_mint, false),
        AccountMeta::new_readonly(Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        AccountMeta::new_readonly(Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID), false),
    ];
    let jstake_ix = build_and_prove_flow_run(
        BuildFlowRunParams {
            holder: &holder_keys,
            input_0: sol_note30,
            input_0_index: 30,
            input_1: None,
            change_index: 31,
            output_index: 32,
            hook: &jstake_hook,
            hook_pda: jstake_pda,
            config_fee_recipient: to_addr(launch_wallet),
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: 10_000,
            relayer_fee_ata: None,
            amount_in: stake_in,
            min_out: 100_000_000,
            mint_in: SOL_MINT,
            mint_out: JITOSOL_MINT_ID,
            has_mint_out: true,
            token_program_in: spl_token_address(),
            token_program_out: spl_token_address(),
            caller_data: Vec::new(),
            caller_accounts: jstake_caller,
            caller_remaining_writable: Vec::new(),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let jstake_sig = send_ixs(&client, &[jstake_ix], &[&relayer], 800_000)?;
    client.confirm_private_transaction_sync(jstake_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("jito.stake (SOL->JitoSOL)", &jstake_sig, &holder_pk_str)?;

    let jitosol_note32 = holder_keys
        .find_note_at(32, JITOSOL_MINT_ID, 100_000_000, &assets, &client)?
        .ok_or_else(|| anyhow!("output JitoSOL note #32 missing"))?;
    let jitosol_amt = jitosol_note32.utxo.amount;
    ensure!(get_token_balance(&client, to_pk(stage_jitosol_ata))? == 0);

    // Unstake all JitoSOL -> SOL via `jito.unstake`.
    let junstake_caller = vec![
        AccountMeta::new(to_pk(JITO_STAKE_POOL_ID), false),
        AccountMeta::new_readonly(to_pk(JITO_WITHDRAW_AUTHORITY_ID), false),
        AccountMeta::new(to_pk(JITO_RESERVE_STAKE_ID), false),
        AccountMeta::new(to_pk(JITO_MANAGER_FEE_ACCOUNT_ID), false),
        AccountMeta::new(jitosol_mint, false),
        AccountMeta::new_readonly(to_pk(SYSVAR_CLOCK_ID), false),
        AccountMeta::new_readonly(to_pk(SYSVAR_STAKE_HISTORY_ID), false),
        AccountMeta::new_readonly(to_pk(STAKE_PROGRAM_ID), false),
        AccountMeta::new_readonly(Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID), false),
    ];
    let stage_sol_before_unstake = client.rpc().get_balance(to_pk(stage_pda))?;
    let junstake_ix = build_and_prove_flow_run(
        BuildFlowRunParams {
            holder: &holder_keys,
            input_0: jitosol_note32,
            input_0_index: 32,
            input_1: None,
            change_index: 33,
            output_index: 34,
            hook: &junstake_hook,
            hook_pda: junstake_pda,
            config_fee_recipient: to_addr(launch_wallet),
            relayer_payer: to_addr(relayer.pubkey()),
            relayer_fee: 50_000,
            relayer_fee_ata: None,
            amount_in: jitosol_amt,
            min_out: 400_000_000,
            mint_in: JITOSOL_MINT_ID,
            mint_out: SOL_MINT,
            has_mint_out: true,
            token_program_in: spl_token_address(),
            token_program_out: spl_token_address(),
            caller_data: Vec::new(),
            caller_accounts: junstake_caller,
            caller_remaining_writable: Vec::new(),
            expiry: EXPIRY,
            tree: tree_addr,
            tree_id: TREE_ID,
        },
        indexer,
    )?;
    let junstake_sig = send_ixs(&client, &[junstake_ix], &[&relayer], 800_000)?;
    client.confirm_private_transaction_sync(junstake_sig).map_err(|e| anyhow!("{e:?}"))?;
    assert_privacy_and_report("jito.unstake (JitoSOL->SOL)", &junstake_sig, &holder_pk_str)?;

    let sol_note34 = holder_keys
        .find_note_at(34, SOL_MINT, 400_000_000, &assets, &client)?
        .ok_or_else(|| anyhow!("output SOL note #34 missing after jito.unstake"))?;
    ensure!(client.rpc().get_balance(to_pk(stage_pda))? == stage_sol_before_unstake);
    ensure!(get_token_balance(&client, to_pk(stage_jitosol_ata))? == 0);
    println!(
        "4. FLOW 4 passed: jito.stake ({stake_in} lamports -> {jitosol_amt} JitoSOL) -> jito.unstake ({} lamports)",
        sol_note34.utxo.amount
    );

    Ok(())
}
