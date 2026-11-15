//! Localnet bootstrap binary called by `localnet/start.sh`.
//!
//! Creates `localnet/keys/{holder,relayer,admin}.json` once (gitignored),
//! funds them and the launch wallet (`AFMxmWEUi1oDVA9SHay9BV4jg1GZHfZPZawt8H8Tk4hW`),
//! mints 10,000 USDC to `holder`, creates stage/fee/relayer/author-fee ATAs,
//! registers USDC/kUSDC/kSOL/JitoSOL on SPP, runs `init_config`, and publishes all
//! nine launch hooks so a fresh localnet comes up ready for the app and tests.

use std::{path::Path, str::FromStr, time::Duration};

use anyhow::{anyhow, Context, Result};
use pook_program::{
    instructions::config::InitConfigArgs,
    pda::{
        find_ata, find_author_fees_pda, find_config_pda, find_hook_pda, find_stage_pda,
        hook_id_hash, SYSTEM_PROGRAM_ID,
    },
};
use pook_sdk::{
    hooks::{
        launch_hooks, JITOSOL_MINT_ID, KAMINO_KSOL_MINT_ID, KAMINO_KUSDC_MINT_ID,
    },
    instructions::{init_config_ix, publish_hook_ix},
};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use spr_client::{fetch_asset_id, ComputeBudgetConfig, Rpc, SolanaRpc, SprClient};
use spr_interface::{
    ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_MINT_TO_DISCRIMINATOR, SPL_TOKEN_PROGRAM_ID,
};
use spr_program::instruction::CreateSplInterface;

const LAUNCH_WALLET_STR: &str = "AFMxmWEUi1oDVA9SHay9BV4jg1GZHfZPZawt8H8Tk4hW";
const USDC_MINT_STR: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HOLDER_USDC_AMOUNT: u64 = 10_000_000_000; // 10,000 USDC (6 decimals)

fn to_addr(pk: Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

fn to_pk(addr: Address) -> Pubkey {
    Pubkey::new_from_array(*addr.as_array())
}

fn ensure_keypair(path: &Path) -> Result<Keypair> {
    if path.exists() {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading keypair {}", path.display()))?;
        let bytes: Vec<u8> = serde_json::from_str(&text)?;
        return Keypair::try_from(bytes.as_slice())
            .map_err(|e| anyhow!("invalid keypair {}: {e:?}", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let kp = Keypair::new();
    let json = serde_json::to_string(&kp.to_bytes().to_vec())?;
    std::fs::write(path, json)?;
    Ok(kp)
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

fn mint_to_ix(mint: Pubkey, dest_ata: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(SPL_TOKEN_MINT_TO_DISCRIMINATOR);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(mint, false),
            AccountMeta::new(dest_ata, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

fn system_transfer_ix(from: Pubkey, to: Pubkey, lamports: u64) -> Instruction {
    let mut data = [0u8; 12];
    data[0..4].copy_from_slice(&2u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: Pubkey::new_from_array(SYSTEM_PROGRAM_ID),
        accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)],
        data: data.to_vec(),
    }
}

fn send_ixs(
    client: &SprClient<SolanaRpc>,
    ixs: &[Instruction],
    signers: &[&dyn Signer],
    cu_limit: u32,
) -> Result<()> {
    let payer = signers[0].pubkey();
    client
        .rpc()
        .create_and_send_transaction(ixs, payer, signers, ComputeBudgetConfig::new(cu_limit))
        .map_err(|e| anyhow!("send tx: {e:?}"))?;
    Ok(())
}

fn ensure_sol_balance(
    client: &SprClient<SolanaRpc>,
    rpc_url: &str,
    pubkey: Pubkey,
    target_lamports: u64,
) -> Result<()> {
    let current = client.rpc().get_balance(pubkey).unwrap_or(0);
    if current >= target_lamports {
        return Ok(());
    }
    let rpc = solana_rpc_client::rpc_client::RpcClient::new(rpc_url.to_string());
    let needed = target_lamports - current;
    let _ = rpc
        .request_airdrop(&pubkey, needed)
        .map_err(|e| anyhow!("airdrop {pubkey}: {e:?}"))?;
    for _ in 0..60 {
        if client.rpc().get_balance(pubkey).unwrap_or(0) >= target_lamports {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(anyhow!("airdrop timed out for {pubkey}"))
}

fn ensure_spl_interface(
    client: &SprClient<SolanaRpc>,
    payer: &Keypair,
    mint: Pubkey,
) -> Result<u64> {
    let mint_addr = to_addr(mint);
    if let Ok(id) = fetch_asset_id(client.rpc(), mint_addr) {
        return Ok(id);
    }
    let ix = CreateSplInterface {
        authority: payer.pubkey(),
        mint,
        token_program: Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID),
    }
    .instruction();
    send_ixs(client, &[ix], &[payer], 400_000)?;
    fetch_asset_id(client.rpc(), mint_addr).map_err(|e| anyhow!("fetch_asset_id({mint}): {e:?}"))
}

fn main() -> Result<()> {
    let rpc_url = std::env::var("POOK_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:20820".into());
    let photon_url =
        std::env::var("POOK_PHOTON_URL").unwrap_or_else(|_| "http://127.0.0.1:20813".into());
    let prover_url =
        std::env::var("POOK_PROVER_URL").unwrap_or_else(|_| "http://127.0.0.1:20814".into());

    let localnet_dir = std::env::var("POOK_LOCALNET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../localnet"));
    let keys_dir = localnet_dir.join("keys");

    let holder = ensure_keypair(&keys_dir.join("holder.json"))?;
    let relayer = ensure_keypair(&keys_dir.join("relayer.json"))?;
    let admin = ensure_keypair(&keys_dir.join("admin.json"))?;
    let mint_authority = ensure_keypair(&localnet_dir.join("mint-authority.json"))?;
    let launch_wallet = Pubkey::from_str(LAUNCH_WALLET_STR)?;

    let client: SprClient<SolanaRpc> = SprClient::from_urls_allowing_insecure_http(
        SolanaRpc::new(rpc_url.clone()),
        &photon_url,
        &prover_url,
        None,
    );

    println!("Localnet setup:");
    println!("  program_id:    {}", pook_program::ID);
    println!("  holder:        {}", holder.pubkey());
    println!("  relayer:       {}", relayer.pubkey());
    println!("  admin:         {}", admin.pubkey());
    println!("  launch_wallet: {launch_wallet}");

    // 1. Fund wallets with SOL.
    ensure_sol_balance(&client, &rpc_url, holder.pubkey(), 100_000_000_000)?;
    ensure_sol_balance(&client, &rpc_url, relayer.pubkey(), 100_000_000_000)?;
    ensure_sol_balance(&client, &rpc_url, admin.pubkey(), 10_000_000_000)?;
    ensure_sol_balance(&client, &rpc_url, mint_authority.pubkey(), 2_000_000_000)?;
    ensure_sol_balance(&client, &rpc_url, launch_wallet, 1_000_000_000)?;

    // 2. Fund stage PDA rent reserve and create required SPL ATAs.
    let (stage_pda, _) = find_stage_pda();
    let stage_pk = to_pk(stage_pda);
    let usdc_mint = Pubkey::from_str(USDC_MINT_STR)?;
    let kusdc_mint = to_pk(KAMINO_KUSDC_MINT_ID);
    let ksol_mint = to_pk(KAMINO_KSOL_MINT_ID);
    let jitosol_mint = to_pk(JITOSOL_MINT_ID);

    if client.rpc().get_balance(stage_pk).unwrap_or(0) < 50_000_000 {
        send_ixs(
            &client,
            &[system_transfer_ix(admin.pubkey(), stage_pk, 50_000_000)],
            &[&admin],
            200_000,
        )?;
    }

    // Create ATAs in small batches.
    let spl_mints = [usdc_mint, kusdc_mint, ksol_mint, jitosol_mint];
    for mint in spl_mints {
        let (af_pda, _) = find_author_fees_pda(&admin.pubkey().to_bytes(), &mint.to_bytes());
        let ixs = vec![
            create_ata_idempotent_ix(admin.pubkey(), stage_pk, mint),
            create_ata_idempotent_ix(admin.pubkey(), launch_wallet, mint),
            create_ata_idempotent_ix(admin.pubkey(), relayer.pubkey(), mint),
            create_ata_idempotent_ix(admin.pubkey(), to_pk(af_pda), mint),
        ];
        send_ixs(&client, &ixs, &[&admin], 400_000)?;
    }

    // Create holder USDC ATA and mint 10,000 USDC if balance is below target.
    let (holder_usdc_ata, _) =
        find_ata(&holder.pubkey().to_bytes(), &usdc_mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
    send_ixs(
        &client,
        &[create_ata_idempotent_ix(admin.pubkey(), holder.pubkey(), usdc_mint)],
        &[&admin],
        200_000,
    )?;
    let current_usdc = client
        .rpc()
        .get_account(to_pk(holder_usdc_ata))
        .ok()
        .flatten()
        .filter(|a| a.data.len() >= 72)
        .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
        .unwrap_or(0);
    if current_usdc < HOLDER_USDC_AMOUNT {
        send_ixs(
            &client,
            &[mint_to_ix(
                usdc_mint,
                to_pk(holder_usdc_ata),
                mint_authority.pubkey(),
                HOLDER_USDC_AMOUNT - current_usdc,
            )],
            &[&mint_authority],
            200_000,
        )?;
    }
    println!("  holder USDC:   {} (10,000 USDC)", HOLDER_USDC_AMOUNT);

    // 3. Register SPL interfaces on SPP.
    for (label, mint) in [
        ("USDC", usdc_mint),
        ("kUSDC", kusdc_mint),
        ("kSOL", ksol_mint),
        ("JitoSOL", jitosol_mint),
    ] {
        let asset_id = ensure_spl_interface(&client, &admin, mint)?;
        println!("  SPP interface: {label} -> asset_id={asset_id}");
    }

    // 4. Initialize Pook Config.
    let (config_pda, _) = find_config_pda();
    let run_fee_env = std::env::var("RUN_FEE_BPS").ok().and_then(|v| v.parse::<u16>().ok());
    let author_share_env = std::env::var("AUTHOR_SHARE_BPS")
        .ok()
        .and_then(|v| v.parse::<u16>().ok());
    let run_fee_bps = run_fee_env.unwrap_or(30);
    let author_share_bps = author_share_env.unwrap_or(5000);
    if run_fee_env.is_none() || author_share_env.is_none() {
        println!(
            "  Config fees:   RUN_FEE_BPS={run_fee_bps}, AUTHOR_SHARE_BPS={author_share_bps} (localnet placeholders; set env vars to override)"
        );
    } else {
        println!("  Config fees:   RUN_FEE_BPS={run_fee_bps}, AUTHOR_SHARE_BPS={author_share_bps}");
    }

    if client
        .rpc()
        .get_account(to_pk(config_pda))
        .map_err(|e| anyhow!("{e:?}"))?
        .is_none()
    {
        let ix = init_config_ix(
            to_addr(admin.pubkey()),
            InitConfigArgs {
                fee_recipient: launch_wallet.to_bytes(),
                run_fee_bps,
                author_share_bps,
            },
        )?;
        send_ixs(&client, &[ix], &[&admin], 200_000)?;
        println!("  Config init:   {config_pda}");
    } else {
        println!("  Config init:   already initialized at {config_pda}");
    }

    // 5. Publish all nine launch hooks.
    for args in launch_hooks() {
        let id_hash = hook_id_hash(&args.hook_id).map_err(|e| anyhow!("{e}"))?;
        let (hook_pda, _) = find_hook_pda(&id_hash);
        if client
            .rpc()
            .get_account(to_pk(hook_pda))
            .map_err(|e| anyhow!("{e:?}"))?
            .is_none()
        {
            let (ix, _) = publish_hook_ix(to_addr(admin.pubkey()), &args)?;
            send_ixs(&client, &[ix], &[&admin], 300_000)?;
            println!("  Published hook: {:<28} -> {hook_pda}", args.hook_id);
        } else {
            println!("  Existing hook:  {:<28} -> {hook_pda}", args.hook_id);
        }
    }

    println!("Localnet bootstrap complete.");
    Ok(())
}
