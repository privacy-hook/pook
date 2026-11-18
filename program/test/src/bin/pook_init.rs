//! Idempotent post-deploy initializer for `pook` on any cluster.
//!
//! Reads chain state first and skips what already exists. Writes only chain-derived fields
//! into `program/deploy/<cluster>.json` (never writes RPC URLs or secret keys).

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use pook_program::{
    instructions::config::InitConfigArgs,
    pda::{
        find_ata, find_author_fees_pda, find_authority_pda, find_config_pda, find_hook_pda,
        find_stage_pda, hook_id_hash, SYSTEM_PROGRAM_ID,
    },
    state::Config,
};
use pook_sdk::{
    hooks::{
        from_hook_json, PublishHookJson, JITOSOL_MINT_ID, KAMINO_KSOL_MINT_ID,
        KAMINO_KUSDC_MINT_ID,
    },
    instructions::{init_config_ix, publish_hook_ix},
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_signer::Signer;
use spr_client::{fetch_asset_id, ComputeBudgetConfig, Rpc, SolanaRpc, SprClient};
use spr_interface::{
    pda as spp_pda, state::ProtocolConfig, ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID,
};
use spr_program::instruction::CreateSplInterface;

const DEFAULT_LAUNCH_WALLET: &str = "AFMxmWEUi1oDVA9SHay9BV4jg1GZHfZPZawt8H8Tk4hW";
const USDC_MINT_STR: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STAGE_MIN_LAMPORTS: u64 = 1_000_000; // >= rent-exempt minimum for 0-byte system PDA

fn to_addr(pk: Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

fn to_pk(addr: Address) -> Pubkey {
    Pubkey::new_from_array(*addr.as_array())
}

fn load_keypair(path: &Path) -> Result<Keypair> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading keypair {}", path.display()))?;
    let bytes: Vec<u8> = serde_json::from_str(&text)?;
    Keypair::try_from(bytes.as_slice())
        .map_err(|e| anyhow!("invalid keypair {}: {e:?}", path.display()))
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
) -> Result<Signature> {
    let payer = signers[0].pubkey();
    client
        .rpc()
        .create_and_send_transaction(ixs, payer, signers, ComputeBudgetConfig::new(cu_limit))
        .map_err(|e| anyhow!("send tx: {e:?}"))
}

/// Wait briefly for an account to become visible on load-balanced RPC nodes after confirmation.
fn get_account_with_retry(
    client: &SprClient<SolanaRpc>,
    pubkey: Pubkey,
    expect_present: bool,
) -> Result<Option<solana_account::Account>> {
    let attempts = if expect_present { 6 } else { 3 };
    for attempt in 0..attempts {
        match client.rpc().get_account(pubkey) {
            Ok(Some(acct)) => return Ok(Some(acct)),
            Ok(None) if !expect_present => return Ok(None),
            Ok(None) | Err(_) if attempt + 1 < attempts => {
                std::thread::sleep(Duration::from_secs(2));
            }
            Ok(None) => return Ok(None),
            Err(e) => return Err(anyhow!("get_account({pubkey}): {e:?}")),
        }
    }
    Ok(None)
}

fn read_spp_spl_permissionless(client: &SprClient<SolanaRpc>) -> Result<bool> {
    let cfg_pda = spp_pda::protocol_config();
    let Some(acct) = get_account_with_retry(client, cfg_pda, false)? else {
        return Ok(false);
    };
    let cfg = ProtocolConfig::from_account_bytes(&acct.data)
        .map_err(|e| anyhow!("parsing SPP ProtocolConfig: {e:?}"))?;
    Ok(cfg.allows_permissionless_spl_interface_creation())
}

struct CliArgs {
    url: String,
    deployer: PathBuf,
    cluster: Option<String>,
    run_fee_bps: Option<u16>,
    author_share_bps: Option<u16>,
    fee_recipient: Pubkey,
    hooks_dir: PathBuf,
    record_path: Option<PathBuf>,
    skip_record: bool,
}

fn parse_args() -> Result<CliArgs> {
    let mut url: Option<String> = None;
    let mut deployer: Option<PathBuf> = None;
    let mut cluster: Option<String> = None;
    let mut run_fee_bps: Option<u16> = None;
    let mut author_share_bps: Option<u16> = None;
    let mut fee_recipient = Pubkey::from_str(DEFAULT_LAUNCH_WALLET)?;
    let mut hooks_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../hooks");
    let mut record_path: Option<PathBuf> = None;
    let mut skip_record = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let next = |args: &mut std::iter::Skip<std::env::Args>, flag: &str| -> Result<String> {
            args.next().ok_or_else(|| anyhow!("missing value for {flag}"))
        };
        match arg.as_str() {
            "--url" => url = Some(next(&mut args, "--url")?),
            "--deployer" => deployer = Some(PathBuf::from(next(&mut args, "--deployer")?)),
            "--cluster" => cluster = Some(next(&mut args, "--cluster")?),
            "--run-fee-bps" => run_fee_bps = Some(next(&mut args, "--run-fee-bps")?.parse()?),
            "--author-share-bps" => {
                author_share_bps = Some(next(&mut args, "--author-share-bps")?.parse()?)
            }
            "--fee-recipient" => fee_recipient = Pubkey::from_str(&next(&mut args, "--fee-recipient")?)?,
            "--hooks-dir" => hooks_dir = PathBuf::from(next(&mut args, "--hooks-dir")?),
            "--record" => record_path = Some(PathBuf::from(next(&mut args, "--record")?)),
            "--skip-record" => skip_record = true,
            "-h" | "--help" => {
                println!(
                    "Usage: pook_init --url <RPC_URL> --deployer <KEYPAIR> [--cluster <NAME>] \\\n  \
                     --run-fee-bps <0..=10000> --author-share-bps <0..=10000> \\\n  \
                     [--fee-recipient <PUBKEY>] [--hooks-dir <DIR>] [--record <JSON>] [--skip-record]"
                );
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }

    let url = url.ok_or_else(|| anyhow!("--url is required"))?;
    let deployer = deployer.ok_or_else(|| anyhow!("--deployer is required"))?;
    Ok(CliArgs {
        url,
        deployer,
        cluster,
        run_fee_bps,
        author_share_bps,
        fee_recipient,
        hooks_dir,
        record_path,
        skip_record,
    })
}

fn infer_cluster(genesis_hash: &str) -> String {
    match genesis_hash {
        "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" => "mainnet-beta".into(),
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" => "devnet".into(),
        _ => "localnet".into(),
    }
}

fn main() -> Result<()> {
    let cli = parse_args()?;
    let deployer = load_keypair(&cli.deployer)?;
    let raw_rpc = RpcClient::new(cli.url.clone());
    let genesis_hash = raw_rpc
        .get_genesis_hash()
        .map_err(|e| anyhow!("get_genesis_hash: {e:?}"))?
        .to_string();
    let cluster = cli.cluster.unwrap_or_else(|| infer_cluster(&genesis_hash));

    // Strict fee rule: required on every cluster except localnet.
    let (run_fee_bps, author_share_bps) = match (cli.run_fee_bps, cli.author_share_bps) {
        (Some(r), Some(a)) => (r, a),
        (r, a) if cluster == "localnet" => {
            let rv = r.unwrap_or(30);
            let av = a.unwrap_or(5000);
            println!(
                "NOTE: using localnet placeholder fee rates RUN_FEE_BPS={rv}, AUTHOR_SHARE_BPS={av}"
            );
            (rv, av)
        }
        _ => bail!(
            "--run-fee-bps and --author-share-bps are required on cluster '{cluster}' (no production defaults)"
        ),
    };
    if run_fee_bps > 10_000 || author_share_bps > 10_000 {
        bail!("fee bps must be <= 10000");
    }

    let client: SprClient<SolanaRpc> = SprClient::from_urls_allowing_insecure_http(
        SolanaRpc::new(cli.url.clone()),
        "http://127.0.0.1:1", // unused by init
        "http://127.0.0.1:1", // unused by init
        None,
    );

    let (authority_pda, _) = find_authority_pda();
    let (stage_pda, _) = find_stage_pda();
    let (config_pda, _) = find_config_pda();

    let bal_start = client.rpc().get_balance(deployer.pubkey())?;
    println!("=== Pook init on {cluster} (genesis={genesis_hash}) ===");
    println!("  program_id:    {}", pook_program::ID);
    println!("  deployer:      {} (balance={bal_start} lamports)", deployer.pubkey());
    println!("  fee_recipient: {}", cli.fee_recipient);
    println!("  fees:          run_fee_bps={run_fee_bps}, author_share_bps={author_share_bps}");

    let mut rent_items: Vec<Value> = Vec::new();
    let mut tx_signatures: BTreeMap<String, String> = BTreeMap::new();

    // 1. Initialize Config (idempotent).
    let config_pk = to_pk(config_pda);
    if let Some(existing) = get_account_with_retry(&client, config_pk, false)? {
        let cfg: Config = borsh::from_slice(&existing.data[..Config::LEN])?;
        println!(
            "  [SKIP] Config already initialized at {config_pda} (admin={}, fee_recipient={}, run_fee_bps={}, author_share_bps={}, rent={} lamports)",
            Address::new_from_array(cfg.admin),
            Address::new_from_array(cfg.fee_recipient),
            cfg.run_fee_bps,
            cfg.author_share_bps,
            existing.lamports
        );
        rent_items.push(json!({
            "kind": "config",
            "address": config_pda.to_string(),
            "bytes": existing.data.len(),
            "lamports": existing.lamports,
            "created": false
        }));
    } else {
        let ix = init_config_ix(
            to_addr(deployer.pubkey()),
            InitConfigArgs {
                fee_recipient: cli.fee_recipient.to_bytes(),
                run_fee_bps,
                author_share_bps,
            },
        )?;
        let sig = send_ixs(&client, &[ix], &[&deployer], 200_000)?;
        let acct = get_account_with_retry(&client, config_pk, true)?
            .ok_or_else(|| anyhow!("Config not visible after init_config"))?;
        println!(
            "  [INIT] Config created at {config_pda} ({} B, rent={} lamports, sig={sig})",
            acct.data.len(),
            acct.lamports
        );
        tx_signatures.insert("init_config".into(), sig.to_string());
        rent_items.push(json!({
            "kind": "config",
            "address": config_pda.to_string(),
            "bytes": acct.data.len(),
            "lamports": acct.lamports,
            "created": true,
            "signature": sig.to_string()
        }));
    }

    // 2. Fund stage_pda rent reserve (idempotent).
    let stage_pk = to_pk(stage_pda);
    let stage_bal = client.rpc().get_balance(stage_pk)?;
    if stage_bal < STAGE_MIN_LAMPORTS {
        let top_up = STAGE_MIN_LAMPORTS - stage_bal;
        let sig = send_ixs(
            &client,
            &[system_transfer_ix(deployer.pubkey(), stage_pk, top_up)],
            &[&deployer],
            100_000,
        )?;
        println!("  [INIT] Funded stage_pda {stage_pda} +{top_up} lamports (sig={sig})");
        tx_signatures.insert("fund_stage_pda".into(), sig.to_string());
        rent_items.push(json!({
            "kind": "stage_pda_reserve",
            "address": stage_pda.to_string(),
            "bytes": 0,
            "lamports": top_up,
            "created": true,
            "signature": sig.to_string()
        }));
    } else {
        println!("  [SKIP] stage_pda {stage_pda} already funded ({stage_bal} lamports)");
        rent_items.push(json!({
            "kind": "stage_pda_reserve",
            "address": stage_pda.to_string(),
            "bytes": 0,
            "lamports": stage_bal,
            "created": false
        }));
    }

    // 3. Create missing ATAs for launch wallet (fee recipient), stage_pda, and deployer AuthorFees PDAs.
    let usdc_mint = Pubkey::from_str(USDC_MINT_STR)?;
    let payout_mints = [
        ("USDC", usdc_mint),
        ("kUSDC", to_pk(KAMINO_KUSDC_MINT_ID)),
        ("kSOL", to_pk(KAMINO_KSOL_MINT_ID)),
        ("JitoSOL", to_pk(JITOSOL_MINT_ID)),
    ];
    let mut ata_records: Vec<Value> = Vec::new();
    for (label, mint) in payout_mints {
        let (af_pda, _) = find_author_fees_pda(&deployer.pubkey().to_bytes(), &mint.to_bytes());
        let owners = [
            ("launch_wallet", cli.fee_recipient),
            ("stage_pda", stage_pk),
            ("author_fees", to_pk(af_pda)),
        ];
        for (role, owner) in owners {
            let (ata, _) = find_ata(&owner.to_bytes(), &mint.to_bytes(), &SPL_TOKEN_PROGRAM_ID);
            let ata_pk = to_pk(ata);
            if let Some(existing) = get_account_with_retry(&client, ata_pk, false)? {
                println!(
                    "  [SKIP] ATA {role}/{label} exists at {ata} ({} B, rent={} lamports)",
                    existing.data.len(),
                    existing.lamports
                );
                ata_records.push(json!({
                    "role": role,
                    "mint": mint.to_string(),
                    "symbol": label,
                    "ata": ata.to_string(),
                    "bytes": existing.data.len(),
                    "lamports": existing.lamports,
                    "created": false
                }));
            } else {
                let sig = send_ixs(
                    &client,
                    &[create_ata_idempotent_ix(deployer.pubkey(), owner, mint)],
                    &[&deployer],
                    200_000,
                )?;
                let acct = get_account_with_retry(&client, ata_pk, true)?
                    .ok_or_else(|| anyhow!("ATA {ata} not visible after creation"))?;
                println!(
                    "  [INIT] Created ATA {role}/{label} at {ata} ({} B, rent={} lamports, sig={sig})",
                    acct.data.len(),
                    acct.lamports
                );
                tx_signatures.insert(format!("ata_{role}_{label}"), sig.to_string());
                ata_records.push(json!({
                    "role": role,
                    "mint": mint.to_string(),
                    "symbol": label,
                    "ata": ata.to_string(),
                    "bytes": acct.data.len(),
                    "lamports": acct.lamports,
                    "created": true,
                    "signature": sig.to_string()
                }));
                rent_items.push(json!({
                    "kind": format!("ata_{role}_{label}"),
                    "address": ata.to_string(),
                    "bytes": acct.data.len(),
                    "lamports": acct.lamports,
                    "created": true,
                    "signature": sig.to_string()
                }));
            }
        }
    }

    // 4. Register missing SPP SPL interfaces when `spl_interface_creation_is_permissionless` allows; else list them.
    let spl_permissionless = read_spp_spl_permissionless(&client)?;
    println!("  SPP spl_interface_creation_is_permissionless = {spl_permissionless}");
    let mut spl_interfaces: Vec<Value> = Vec::new();
    let mut missing_spl_interfaces: Vec<Value> = Vec::new();

    for (label, mint) in payout_mints {
        let mint_addr = to_addr(mint);
        let spl_if_pda = spp_pda::spl_interface(&mint);
        if let Ok(asset_id) = fetch_asset_id(client.rpc(), mint_addr) {
            println!("  [SKIP] SPP SPL interface {label} already registered (asset_id={asset_id}, vault={spl_if_pda})");
            spl_interfaces.push(json!({
                "symbol": label,
                "mint": mint.to_string(),
                "splInterface": spl_if_pda.to_string(),
                "assetId": asset_id,
                "created": false
            }));
        } else if spl_permissionless {
            let bal_before = client.rpc().get_balance(deployer.pubkey())?;
            let ix = CreateSplInterface {
                authority: deployer.pubkey(),
                mint,
                token_program: Pubkey::new_from_array(SPL_TOKEN_PROGRAM_ID),
            }
            .instruction();
            let sig = send_ixs(&client, &[ix], &[&deployer], 400_000)?;
            let bal_after = client.rpc().get_balance(deployer.pubkey())?;
            let spent = bal_before.saturating_sub(bal_after);
            let mut asset_id = 0u64;
            for _ in 0..5 {
                if let Ok(id) = fetch_asset_id(client.rpc(), mint_addr) {
                    asset_id = id;
                    break;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            let vault_acct = get_account_with_retry(&client, spl_if_pda, true)?;
            let vault_bytes = vault_acct.as_ref().map(|a| a.data.len()).unwrap_or(0);
            let vault_rent = vault_acct.as_ref().map(|a| a.lamports).unwrap_or(0);
            println!(
                "  [INIT] Created SPP SPL interface {label}: asset_id={asset_id}, vault={spl_if_pda} ({vault_bytes} B, net_spend={spent} lamports, sig={sig})"
            );
            tx_signatures.insert(format!("spl_interface_{label}"), sig.to_string());
            spl_interfaces.push(json!({
                "symbol": label,
                "mint": mint.to_string(),
                "splInterface": spl_if_pda.to_string(),
                "assetId": asset_id,
                "vaultBytes": vault_bytes,
                "vaultLamports": vault_rent,
                "netSpendLamports": spent,
                "created": true,
                "signature": sig.to_string()
            }));
            rent_items.push(json!({
                "kind": format!("spp_spl_interface_{label}"),
                "address": spl_if_pda.to_string(),
                "bytes": vault_bytes,
                "lamports": spent,
                "created": true,
                "signature": sig.to_string()
            }));
        } else {
            println!(
                "  [LIST] SPP SPL interface {label} ({mint}) is missing and protocol_config requires protocol_authority"
            );
            missing_spl_interfaces.push(json!({
                "symbol": label,
                "mint": mint.to_string(),
                "splInterface": spl_if_pda.to_string()
            }));
        }
    }

    // 5. Publish all nine launch hooks from `program/hooks/*.json` (idempotent).
    let mut hook_files: Vec<PathBuf> = std::fs::read_dir(&cli.hooks_dir)
        .with_context(|| format!("reading hooks dir {}", cli.hooks_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    hook_files.sort();
    if hook_files.is_empty() {
        bail!("no hook JSON files found in {}", cli.hooks_dir.display());
    }

    let mut hook_records: Vec<Value> = Vec::new();
    for path in hook_files {
        let json_def: PublishHookJson = serde_json::from_str(&std::fs::read_to_string(&path)?)
            .with_context(|| format!("parsing {}", path.display()))?;
        let args = from_hook_json(&json_def)?;
        let id_hash = hook_id_hash(&args.hook_id).map_err(|e| anyhow!("{e}"))?;
        let (hook_pda, _) = find_hook_pda(&id_hash);
        let hook_pk = to_pk(hook_pda);

        if let Some(existing) = get_account_with_retry(&client, hook_pk, false)? {
            println!(
                "  [SKIP] Hook {:<28} exists at {hook_pda} ({} B, rent={} lamports)",
                args.hook_id,
                existing.data.len(),
                existing.lamports
            );
            hook_records.push(json!({
                "hookId": args.hook_id,
                "pda": hook_pda.to_string(),
                "bytes": existing.data.len(),
                "lamports": existing.lamports,
                "created": false
            }));
        } else {
            let (ix, _) = publish_hook_ix(to_addr(deployer.pubkey()), &args)?;
            let sig = send_ixs(&client, &[ix], &[&deployer], 300_000)?;
            let acct = get_account_with_retry(&client, hook_pk, true)?
                .ok_or_else(|| anyhow!("Hook {} not visible after publish_hook", args.hook_id))?;
            println!(
                "  [INIT] Published {:<28} at {hook_pda} ({} B, rent={} lamports, sig={sig})",
                args.hook_id,
                acct.data.len(),
                acct.lamports
            );
            tx_signatures.insert(format!("hook_{}", args.hook_id), sig.to_string());
            hook_records.push(json!({
                "hookId": args.hook_id,
                "pda": hook_pda.to_string(),
                "bytes": acct.data.len(),
                "lamports": acct.lamports,
                "created": true,
                "signature": sig.to_string()
            }));
            rent_items.push(json!({
                "kind": format!("hook_{}", args.hook_id),
                "address": hook_pda.to_string(),
                "bytes": acct.data.len(),
                "lamports": acct.lamports,
                "created": true,
                "signature": sig.to_string()
            }));
        }
    }

    let bal_end = client.rpc().get_balance(deployer.pubkey())?;
    let total_spent = bal_start.saturating_sub(bal_end);
    println!("=== Init complete. Net deployer spend: {total_spent} lamports ({:.9} SOL) ===", total_spent as f64 / 1e9);

    if !cli.skip_record {
        let record_path = cli.record_path.unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../deploy/{cluster}.json"))
        });
        let mut root: Value = if record_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&record_path)?)?
        } else {
            json!({})
        };
        let map = root
            .as_object_mut()
            .ok_or_else(|| anyhow!("setup record is not a JSON object"))?;
        map.insert("cluster".into(), json!(cluster));
        map.insert("genesisHash".into(), json!(genesis_hash));
        map.insert("programId".into(), json!(pook_program::ID.to_string()));
        map.insert(
            "pdas".into(),
            json!({
                "authority": authority_pda.to_string(),
                "stage": stage_pda.to_string(),
                "config": config_pda.to_string(),
            }),
        );
        map.insert(
            "init".into(),
            json!({
                "admin": deployer.pubkey().to_string(),
                "feeRecipient": cli.fee_recipient.to_string(),
                "runFeeBps": run_fee_bps,
                "authorShareBps": author_share_bps,
                "sppSplInterfaceCreationPermissionless": spl_permissionless,
                "splInterfaces": spl_interfaces,
                "missingSplInterfaces": missing_spl_interfaces,
                "atas": ata_records,
                "hooks": hook_records,
                "netDeployerSpendLamports": total_spent,
                "signatures": tx_signatures,
                "rentBreakdown": rent_items,
            }),
        );
        if let Some(parent) = record_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&record_path, format!("{}\n", serde_json::to_string_pretty(&root)?))?;
        println!("Updated setup record: {}", record_path.display());
    }

    Ok(())
}
