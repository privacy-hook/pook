//! Instruction builders and end-to-end ZK proving helpers for `pook`.

use anyhow::{anyhow, ensure, Result};
use pook_program::{
    circuits::{
        leave::{LeaveClient, LeavePrivateInputsClient, LeavePublicInputsClient},
        run::{RunClient, RunPrivateInputsClient, RunPublicInputsClient},
        seat::{
            SeatActionClient, SeatActionPrivateInputsClient, SeatActionPublicInputsClient,
            SeatCloseClient, SeatClosePrivateInputsClient, SeatClosePublicInputsClient,
            SeatFundClient, SeatFundPrivateInputsClient, SeatFundPublicInputsClient,
            SeatOpenClient, SeatOpenPrivateInputsClient, SeatOpenPublicInputsClient,
        },
    },
    instructions::{
        claim::ClaimAuthorFeesArgs,
        config::{InitConfigArgs, SetConfigArgs},
        enter::{EnterPublicArgs, EnterPublicKind},
        hook::PublishHookArgs,
        leave::LeaveArgs,
        run::{resolve_cpi_data, RunArgs, RunKind},
        seat::{CloseSeatArgs, OpenSeatArgs, SetupCpi, SetupCpiAccount},
        shared::compute_call_hash,
    },
    pda::{
        find_ata, find_author_fees_pda, find_authority_pda, find_config_pda, find_hook_pda,
        find_seat_pda, find_seat_state_pda, find_stage_pda, hook_id_hash, INSTRUCTIONS_SYSVAR_ID,
        SYSTEM_PROGRAM_ID, WSOL_MINT,
    },
    state::{AccountSlotKind, Hook, HookKind},
    tag,
};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use spr_client::{ProofAuthority, SprIndexer};
use spr_hasher::primitives::hash_bytes;
use spr_interface::{
    instruction::instruction_data::transact::TransactIxData, pda as spp_pda, PROGRAM_ID_PUBKEY,
    SPL_TOKEN_PROGRAM_ID,
};
use spr_keypair::ShieldedAddress;
use spr_program::{
    instruction::{
        Transact, TransactInterfaceTransferAccounts, TransactSolTransferAccounts,
        TransactSplWithdrawalAccounts,
    },
    Field, ProgramOwner, TransactionOptions,
};
use spr_transaction::{instructions::transact::SppProofInputs, WalletUtxo};

use crate::{
    notes::{authority_identity, HolderKeys, MultiKeyProofAuthority},
    proof::{prove, CircuitKind},
};

fn field(bytes: [u8; 32]) -> Result<Field> {
    spr_program::from_bytes(&bytes).map_err(|e| anyhow!("field conversion: {e:?}"))
}

fn to_pubkey(addr: Address) -> solana_pubkey::Pubkey {
    solana_pubkey::Pubkey::new_from_array(*addr.as_array())
}

fn from_pubkey(pk: solana_pubkey::Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

fn prove_spp_transact(
    indexer: &SprIndexer,
    spp_proof_inputs: SppProofInputs,
    authority: &dyn ProofAuthority,
) -> Result<TransactIxData> {
    let expected = spp_proof_inputs
        .padding_independent_private_tx_hash()
        .map_err(|e| anyhow!("private_tx_hash: {e:?}"))?;
    let spp = indexer
        .prove_transact(spp_proof_inputs, authority)
        .map_err(|e| anyhow!("prove_transact: {e:?}"))?;
    ensure!(
        spp.private_tx_hash == expected,
        "SPP proof private_tx_hash mismatch"
    );
    Ok(spp)
}

/// Convert SPP `Transact` accounts so `authority_pda` is marked non-signer at top level
/// (Pook elevates it to signer inside the SPP CPI via `invoke_signed`).
fn spp_transact_accounts_for_pook(
    transact: &TransactIxData,
    payer: Address,
    tree: Address,
    input_mints: &[Address],
    stage_in_for_spp: Option<Address>,
) -> Result<Vec<AccountMeta>> {
    let (authority_pda, _) = find_authority_pda();
    let mut spp_ix = Transact {
        payer: to_pubkey(payer),
        output_tree: to_pubkey(tree),
        input_trees: vec![to_pubkey(tree)],
        owner_signers: vec![to_pubkey(authority_pda)],
        interface_transfer_accounts: build_spp_settlement_accounts(
            transact,
            input_mints,
            stage_in_for_spp,
        )?,
        data: transact.clone(),
    }
    .instruction();

    for meta in &mut spp_ix.accounts {
        if meta.pubkey == to_pubkey(authority_pda) {
            meta.is_signer = false;
        }
    }
    Ok(spp_ix.accounts)
}

fn build_spp_settlement_accounts(
    transact: &TransactIxData,
    input_mints: &[Address],
    stage_in_for_spp: Option<Address>,
) -> Result<Vec<TransactInterfaceTransferAccounts>> {
    use spr_interface::instruction::instruction_data::transact::InterfaceTransfer;
    let mut out = Vec::new();
    for (idx, leg) in transact.interface_transfers.iter().enumerate() {
        let dest =
            stage_in_for_spp.ok_or_else(|| anyhow!("missing stage_in for withdrawal leg"))?;
        match leg {
            InterfaceTransfer::SolWithdrawal { .. } => {
                out.push(TransactInterfaceTransferAccounts::Sol(
                    TransactSolTransferAccounts {
                        recipient: to_pubkey(dest),
                    },
                ));
            }
            InterfaceTransfer::SplWithdrawal { .. } => {
                let mint = to_pubkey(
                    *input_mints
                        .get(idx)
                        .ok_or_else(|| anyhow!("missing mint for SPL leg {idx}"))?,
                );
                out.push(TransactInterfaceTransferAccounts::SplWithdrawal(
                    TransactSplWithdrawalAccounts {
                        mint,
                        spl_interface: spp_pda::spl_interface(&mint),
                        user_token_account: to_pubkey(dest),
                        token_program: spp_pda::spl_token_program_id(),
                    },
                ));
            }
            _ => return Err(anyhow!("unexpected deposit leg in pook transact")),
        }
    }
    Ok(out)
}

pub fn init_config_ix(admin: Address, args: InitConfigArgs) -> Result<Instruction> {
    let (config_pda, _) = find_config_pda();
    let mut data = vec![tag::INIT_CONFIG];
    data.extend_from_slice(&borsh::to_vec(&args)?);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(admin), true),
            AccountMeta::new(to_pubkey(config_pda), false),
            AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        ],
        data,
    })
}

pub fn set_config_ix(admin: Address, args: SetConfigArgs) -> Result<Instruction> {
    let (config_pda, _) = find_config_pda();
    let mut data = vec![tag::SET_CONFIG];
    data.extend_from_slice(&borsh::to_vec(&args)?);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new_readonly(to_pubkey(admin), true),
            AccountMeta::new(to_pubkey(config_pda), false),
        ],
        data,
    })
}

pub fn publish_hook_ix(author: Address, args: &PublishHookArgs) -> Result<(Instruction, Address)> {
    let id_hash = hook_id_hash(&args.hook_id).map_err(|e| anyhow!("hook_id_hash: {e}"))?;
    let (hook_pda, _) = find_hook_pda(&id_hash);
    let mut data = vec![tag::PUBLISH_HOOK];
    data.extend_from_slice(&borsh::to_vec(args)?);
    let ix = Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(author), true),
            AccountMeta::new(to_pubkey(hook_pda), false),
            AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        ],
        data,
    };
    Ok((ix, hook_pda))
}

pub fn enter_public_sol_ix(
    depositor: Address,
    tree: Address,
    owner_hash: [u8; 32],
    amount: u64,
) -> Result<Instruction> {
    let (_, authority_bump) = find_authority_pda();
    let args = EnterPublicArgs {
        kind: EnterPublicKind::Sol,
        authority_bump,
        owner_hash,
        amount,
    };
    let mut data = vec![tag::ENTER, 0u8];
    data.extend_from_slice(&borsh::to_vec(&args)?);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(depositor), true),
            AccountMeta::new(to_pubkey(tree), false),
            AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false),
            AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
            AccountMeta::new(spp_pda::sol_interface(), false),
        ],
        data,
    })
}

pub fn enter_public_spl_ix(
    depositor: Address,
    tree: Address,
    mint: Address,
    user_token: Address,
    token_program: Address,
    owner_hash: [u8; 32],
    amount: u64,
) -> Result<Instruction> {
    let (_, authority_bump) = find_authority_pda();
    let (spl_if, spl_if_bump) = spp_pda::spl_interface_with_bump(&to_pubkey(mint));
    let args = EnterPublicArgs {
        kind: EnterPublicKind::Spl {
            spl_interface_bump: spl_if_bump,
        },
        authority_bump,
        owner_hash,
        amount,
    };
    let mut data = vec![tag::ENTER, 0u8];
    data.extend_from_slice(&borsh::to_vec(&args)?);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(depositor), true),
            AccountMeta::new(to_pubkey(tree), false),
            AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false),
            AccountMeta::new_readonly(to_pubkey(token_program), false),
            AccountMeta::new_readonly(to_pubkey(mint), false),
            AccountMeta::new(to_pubkey(user_token), false),
            AccountMeta::new(spl_if, false),
        ],
        data,
    })
}

pub fn claim_author_fees_sol_ix(author: Address) -> Result<Instruction> {
    let (af_pda, _) = find_author_fees_pda(author.as_array(), &[0u8; 32]);
    let args = ClaimAuthorFeesArgs { mint: [0u8; 32] };
    let mut data = vec![tag::CLAIM_AUTHOR_FEES];
    data.extend_from_slice(&borsh::to_vec(&args)?);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(author), true),
            AccountMeta::new(to_pubkey(af_pda), false),
        ],
        data,
    })
}

pub fn claim_author_fees_spl_ix(
    author: Address,
    mint: Address,
    token_program: Address,
    author_dest_ata: Address,
) -> Result<Instruction> {
    let (af_pda, _) = find_author_fees_pda(author.as_array(), mint.as_array());
    let (af_ata, _) = find_ata(af_pda.as_array(), mint.as_array(), token_program.as_array());
    let args = ClaimAuthorFeesArgs {
        mint: *mint.as_array(),
    };
    let mut data = vec![tag::CLAIM_AUTHOR_FEES];
    data.extend_from_slice(&borsh::to_vec(&args)?);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(author), true),
            AccountMeta::new(to_pubkey(af_pda), false),
            AccountMeta::new_readonly(to_pubkey(token_program), false),
            AccountMeta::new_readonly(to_pubkey(mint), false),
            AccountMeta::new(to_pubkey(af_ata), false),
            AccountMeta::new(to_pubkey(author_dest_ata), false),
        ],
        data,
    })
}

/// Parameters to build and prove a Flow `run` instruction.
pub struct BuildFlowRunParams<'a> {
    pub holder: &'a HolderKeys,
    pub input_0: WalletUtxo,
    pub input_0_index: u64,
    pub input_1: Option<(WalletUtxo, u64)>,
    pub change_index: u64,
    pub output_index: u64,
    pub hook: &'a Hook,
    pub hook_pda: Address,
    pub config_fee_recipient: Address,
    pub relayer_payer: Address,
    pub relayer_fee: u64,
    pub relayer_fee_ata: Option<Address>,
    pub amount_in: u64,
    pub min_out: u64,
    pub mint_in: Address,
    pub mint_out: Address,
    pub has_mint_out: bool,
    pub token_program_in: Address,
    pub token_program_out: Address,
    pub caller_data: Vec<u8>,
    /// Caller accounts matching `Fixed`, `Caller`, and `CallerRemaining` slots in order.
    pub caller_accounts: Vec<AccountMeta>,
    /// Writable flags for `CallerRemaining` accounts (0 or 1).
    pub caller_remaining_writable: Vec<u8>,
    pub expiry: u64,
    pub tree: Address,
    pub tree_id: u16,
}

/// Build, prove (Xark `run` + SPP `transact`), and return the `pook::run` Solana `Instruction`.
pub fn build_and_prove_flow_run(
    params: BuildFlowRunParams<'_>,
    indexer: &SprIndexer,
) -> Result<Instruction> {
    let (_, authority_bump) = find_authority_pda();
    let (stage_pda, stage_bump) = find_stage_pda();
    let (config_pda, _) = find_config_pda();

    let in_is_sol = params.mint_in == Address::default();
    let out_is_sol = params.has_mint_out && params.mint_out == Address::default();

    let stage_in_for_spp = if in_is_sol {
        stage_pda
    } else {
        find_ata(
            stage_pda.as_array(),
            params.mint_in.as_array(),
            params.token_program_in.as_array(),
        )
        .0
    };
    let stage_in_for_hook = if in_is_sol && params.hook.wrap_sol_in {
        find_ata(
            stage_pda.as_array(),
            &WSOL_MINT,
            params.token_program_in.as_array(),
        )
        .0
    } else {
        stage_in_for_spp
    };
    let stage_out_for_hook = if !params.has_mint_out {
        stage_pda
    } else if out_is_sol && params.hook.unwrap_sol_out {
        find_ata(
            stage_pda.as_array(),
            &WSOL_MINT,
            params.token_program_out.as_array(),
        )
        .0
    } else if out_is_sol {
        stage_pda
    } else {
        find_ata(
            stage_pda.as_array(),
            params.mint_out.as_array(),
            params.token_program_out.as_array(),
        )
        .0
    };

    // Reconstruct exact resolved CPI metas & data to compute `call_hash`.
    let cpi_data = resolve_cpi_data(
        params.hook,
        params.amount_in,
        params.min_out,
        &params.caller_data,
    )
    .map_err(|e| anyhow!("resolve_cpi_data: {e}"))?;

    let mut cpi_tuples: Vec<(Address, bool, bool)> = Vec::new();
    let mut caller_idx = 0usize;
    for slot in &params.hook.account_slots {
        match slot.kind {
            AccountSlotKind::StagePda => {
                cpi_tuples.push((stage_pda, slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::StageIn => {
                cpi_tuples.push((stage_in_for_hook, slot.is_writable, false));
            }
            AccountSlotKind::StageOut => {
                cpi_tuples.push((stage_out_for_hook, slot.is_writable, false));
            }
            AccountSlotKind::Fixed | AccountSlotKind::Caller => {
                let meta = params
                    .caller_accounts
                    .get(caller_idx)
                    .ok_or_else(|| anyhow!("missing caller account at {caller_idx}"))?;
                caller_idx += 1;
                cpi_tuples.push((from_pubkey(meta.pubkey), slot.is_writable, false));
            }
            AccountSlotKind::CallerRemaining => {
                let rem = &params.caller_accounts[caller_idx..];
                ensure!(
                    rem.len() == params.caller_remaining_writable.len(),
                    "caller_remaining_writable length mismatch"
                );
                for (meta, &w) in rem.iter().zip(params.caller_remaining_writable.iter()) {
                    cpi_tuples.push((from_pubkey(meta.pubkey), w != 0, false));
                }
                caller_idx = params.caller_accounts.len();
            }
            _ => return Err(anyhow!("unexpected seat slot in flow hook")),
        }
    }
    ensure!(
        caller_idx == params.caller_accounts.len(),
        "extra caller accounts supplied"
    );

    let call_hash = compute_call_hash(
        &params.hook.target_program,
        params.has_mint_out,
        params.mint_out.as_array(),
        &cpi_data,
        &cpi_tuples,
    )
    .map_err(|e| anyhow!("compute_call_hash: {e}"))?;

    // Always bind a real one-time owner hash so any unused input left in `StageIn`
    // (e.g., Kamino reserve rounding or repay overpayment) is deposited back to the holder.
    let output_owner_hash = params.holder.one_time_owner_hash(params.output_index)?;
    let hook_hash = hash_bytes(params.hook_pda.as_array())
        .map_err(|e| anyhow!("hook_hash: {e:?}"))?;

    let (input_1_utxo, nf_1_field, mut auth_keys) = match params.input_1 {
        Some((utxo, idx)) => (
            utxo,
            params.holder.nullifier_secret_field(idx)?,
            vec![
                params.holder.nullifier_key(params.input_0_index)?,
                params.holder.nullifier_key(idx)?,
            ],
        ),
        None => (
            WalletUtxo::dummy(params.tree_id).map_err(|e| anyhow!("dummy utxo: {e:?}"))?,
            Field::zero(),
            vec![params.holder.nullifier_key(params.input_0_index)?],
        ),
    };

    let sender_keys = params.holder.one_time_keys(params.input_0_index)?;
    let sender_addr = params.holder.one_time_address(params.input_0_index)?;
    let change_addr = params.holder.one_time_address(params.change_index)?;

    let program_tx = RunClient {
        private: RunPrivateInputsClient {
            tx_context: TransactionOptions {
                blinding_seed: None,
                output_tree_id: Some(params.tree_id),
            },
            input_0: params.input_0,
            nullifier_secret_0: params.holder.nullifier_secret_field(params.input_0_index)?,
            input_1: input_1_utxo,
            nullifier_secret_1: nf_1_field,
            change_owner: change_addr,
            stage_in_account: *stage_in_for_spp.as_array(),
        },
        public: RunPublicInputsClient {
            authority_identity: authority_identity()?,
            hook_hash: field(hook_hash)?,
            call_hash: field(call_hash)?,
            amount_in: params.amount_in,
            min_out: params.min_out,
            output_owner_hash: field(output_owner_hash)?,
            relayer_fee: params.relayer_fee,
            expiry: params.expiry,
        },
    }
    .prepare(&sender_addr, params.relayer_payer)
    .map_err(|e| anyhow!("RunClient::prepare: {e:?}"))?;

    // Prove Xark circuit + SPP transact.
    let proof = prove(CircuitKind::Run, &program_tx.proof_inputs)?;
    let mut spp_inputs = program_tx
        .finalized
        .encrypt_with_keys(&sender_keys)
        .map_err(|e| anyhow!("encrypt_with_keys: {e:?}"))?;
    spp_inputs.external_data.expiry_unix_ts = params.expiry;

    let authority = MultiKeyProofAuthority::new(core::mem::take(&mut auth_keys));
    let transact = prove_spp_transact(indexer, spp_inputs, &authority)?;
    let spp_metas = spp_transact_accounts_for_pook(
        &transact,
        params.relayer_payer,
        params.tree,
        &[params.mint_in],
        Some(stage_in_for_spp),
    )?;

    let out_spl_interface_bump = if params.has_mint_out && !out_is_sol {
        spp_pda::spl_interface_with_bump(&to_pubkey(params.mint_out)).1
    } else {
        0
    };

    let run_args = RunArgs {
        kind: RunKind::Flow,
        proof,
        authority_bump,
        stage_bump,
        amount_in: params.amount_in,
        min_out: params.min_out,
        output_owner_hash,
        relayer_fee: params.relayer_fee,
        expiry: params.expiry,
        seat_commitment: [0u8; 32],
        mint_in: *params.mint_in.as_array(),
        mint_out: *params.mint_out.as_array(),
        has_mint_out: params.has_mint_out,
        out_spl_interface_bump,
        spp_account_count: u8::try_from(spp_metas.len())?,
        caller_data: params.caller_data,
        caller_remaining_writable: params.caller_remaining_writable,
    };

    let mut ix_data = vec![tag::RUN];
    ix_data.extend_from_slice(&wincode::serialize(&run_args)?);
    ix_data.extend_from_slice(&transact.serialize()?);

    // Assemble account metas in exact `process_run` order.
    let mut accounts = vec![
        AccountMeta::new(to_pubkey(params.relayer_payer), true),
        AccountMeta::new_readonly(to_pubkey(config_pda), false),
        AccountMeta::new_readonly(to_pubkey(params.hook_pda), false),
        AccountMeta::new(to_pubkey(stage_pda), false),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(params.hook.target_program), false),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        AccountMeta::new(to_pubkey(params.tree), false),
        AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false),
    ];

    // Input settlement accounts.
    if in_is_sol && params.hook.wrap_sol_in {
        accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program_in), false));
        accounts.push(AccountMeta::new(to_pubkey(stage_in_for_hook), false));
    } else if !in_is_sol {
        accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program_in), false));
        accounts.push(AccountMeta::new_readonly(to_pubkey(params.mint_in), false));
        accounts.push(AccountMeta::new(to_pubkey(stage_in_for_spp), false));
    }

    // Output settlement accounts.
    if params.has_mint_out {
        if out_is_sol {
            let (af_pda, _) = find_author_fees_pda(&params.hook.author, &[0u8; 32]);
            accounts.push(AccountMeta::new(spp_pda::sol_interface(), false));
            accounts.push(AccountMeta::new(to_pubkey(params.config_fee_recipient), false));
            accounts.push(AccountMeta::new(to_pubkey(af_pda), false));
            if params.hook.unwrap_sol_out {
                accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program_out), false));
                accounts.push(AccountMeta::new(to_pubkey(stage_out_for_hook), false));
            }
        } else {
            let (af_pda, _) =
                find_author_fees_pda(&params.hook.author, params.mint_out.as_array());
            let (af_ata, _) = find_ata(
                af_pda.as_array(),
                params.mint_out.as_array(),
                params.token_program_out.as_array(),
            );
            let (fee_rec_ata, _) = find_ata(
                params.config_fee_recipient.as_array(),
                params.mint_out.as_array(),
                params.token_program_out.as_array(),
            );
            let rel_ata = params.relayer_fee_ata.unwrap_or_else(|| {
                find_ata(
                    params.relayer_payer.as_array(),
                    params.mint_out.as_array(),
                    params.token_program_out.as_array(),
                )
                .0
            });
            accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program_out), false));
            accounts.push(AccountMeta::new_readonly(to_pubkey(params.mint_out), false));
            accounts.push(AccountMeta::new(to_pubkey(stage_out_for_hook), false));
            accounts.push(AccountMeta::new(
                spp_pda::spl_interface(&to_pubkey(params.mint_out)),
                false,
            ));
            accounts.push(AccountMeta::new(to_pubkey(fee_rec_ata), false));
            accounts.push(AccountMeta::new(to_pubkey(af_pda), false));
            accounts.push(AccountMeta::new(to_pubkey(af_ata), false));
            accounts.push(AccountMeta::new(to_pubkey(rel_ata), false));
        }
    }

    // Companion sysvar if hook requires companions.
    if !params.hook.companions.is_empty() {
        accounts.push(AccountMeta::new_readonly(
            solana_pubkey::Pubkey::new_from_array(INSTRUCTIONS_SYSVAR_ID),
            false,
        ));
    }

    // SPP transact accounts + caller hook accounts.
    accounts.extend(spp_metas);
    accounts.extend(params.caller_accounts);

    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts,
        data: ix_data,
    })
}

pub enum LeaveDestination {
    PublicAddress(Address),
    RingsPrivate {
        owner_hash: [u8; 32],
        view_tag: [u8; 32],
    },
}

pub struct BuildLeaveParams<'a> {
    pub holder: &'a HolderKeys,
    pub input_0: WalletUtxo,
    pub input_0_index: u64,
    pub input_1: Option<(WalletUtxo, u64)>,
    pub change_index: u64,
    pub mint: Address,
    pub token_program: Address,
    pub amount: u64,
    pub relayer_payer: Address,
    pub relayer_fee: u64,
    pub relayer_fee_ata: Option<Address>,
    pub destination: LeaveDestination,
    pub expiry: u64,
    pub tree: Address,
    pub tree_id: u16,
}

pub fn build_and_prove_leave(
    params: BuildLeaveParams<'_>,
    indexer: &SprIndexer,
) -> Result<Instruction> {
    let (_, authority_bump) = find_authority_pda();
    let (stage_pda, stage_bump) = find_stage_pda();
    let is_sol = params.mint == Address::default();

    let stage_in_for_spp = if is_sol {
        stage_pda
    } else {
        find_ata(
            stage_pda.as_array(),
            params.mint.as_array(),
            params.token_program.as_array(),
        )
        .0
    };

    let (leave_kind, dest_hash, dest_view_tag_hash, dest_owner_hash, dest_view_tag) =
        match params.destination {
            LeaveDestination::PublicAddress(dest) => (
                0u8,
                hash_bytes(dest.as_array()).map_err(|e| anyhow!("dest_hash: {e:?}"))?,
                [0u8; 32],
                [0u8; 32],
                [0u8; 32],
            ),
            LeaveDestination::RingsPrivate {
                owner_hash,
                view_tag,
            } => (
                1u8,
                owner_hash,
                hash_bytes(&view_tag).map_err(|e| anyhow!("view_tag_hash: {e:?}"))?,
                owner_hash,
                view_tag,
            ),
        };

    let (input_1_utxo, nf_1_field, mut auth_keys) = match params.input_1 {
        Some((utxo, idx)) => (
            utxo,
            params.holder.nullifier_secret_field(idx)?,
            vec![
                params.holder.nullifier_key(params.input_0_index)?,
                params.holder.nullifier_key(idx)?,
            ],
        ),
        None => (
            WalletUtxo::dummy(params.tree_id).map_err(|e| anyhow!("dummy utxo: {e:?}"))?,
            Field::zero(),
            vec![params.holder.nullifier_key(params.input_0_index)?],
        ),
    };

    let sender_keys = params.holder.one_time_keys(params.input_0_index)?;
    let sender_addr = params.holder.one_time_address(params.input_0_index)?;
    let change_addr = params.holder.one_time_address(params.change_index)?;

    let program_tx = LeaveClient {
        private: LeavePrivateInputsClient {
            tx_context: TransactionOptions {
                blinding_seed: None,
                output_tree_id: Some(params.tree_id),
            },
            input_0: params.input_0,
            nullifier_secret_0: params.holder.nullifier_secret_field(params.input_0_index)?,
            input_1: input_1_utxo,
            nullifier_secret_1: nf_1_field,
            change_owner: change_addr,
            stage_in_account: *stage_in_for_spp.as_array(),
        },
        public: LeavePublicInputsClient {
            authority_identity: authority_identity()?,
            leave_kind,
            dest_hash: field(dest_hash)?,
            dest_view_tag_hash: field(dest_view_tag_hash)?,
            amount: params.amount,
            relayer_fee: params.relayer_fee,
            expiry: params.expiry,
        },
    }
    .prepare(&sender_addr, params.relayer_payer)
    .map_err(|e| anyhow!("LeaveClient::prepare: {e:?}"))?;

    let proof = prove(CircuitKind::Leave, &program_tx.proof_inputs)?;
    let mut spp_inputs = program_tx
        .finalized
        .encrypt_with_keys(&sender_keys)
        .map_err(|e| anyhow!("encrypt_with_keys: {e:?}"))?;
    spp_inputs.external_data.expiry_unix_ts = params.expiry;

    let authority = MultiKeyProofAuthority::new(core::mem::take(&mut auth_keys));
    let transact = prove_spp_transact(indexer, spp_inputs, &authority)?;
    let spp_metas = spp_transact_accounts_for_pook(
        &transact,
        params.relayer_payer,
        params.tree,
        &[params.mint],
        Some(stage_in_for_spp),
    )?;

    let spl_interface_bump = if leave_kind == 1 && !is_sol {
        spp_pda::spl_interface_with_bump(&to_pubkey(params.mint)).1
    } else {
        0
    };

    let leave_args = LeaveArgs {
        proof,
        authority_bump,
        stage_bump,
        leave_kind,
        mint: *params.mint.as_array(),
        amount: params.amount,
        relayer_fee: params.relayer_fee,
        expiry: params.expiry,
        dest_owner_hash,
        dest_view_tag,
        spl_interface_bump,
        spp_account_count: u8::try_from(spp_metas.len())?,
    };

    let mut ix_data = vec![tag::LEAVE];
    ix_data.extend_from_slice(&wincode::serialize(&leave_args)?);
    ix_data.extend_from_slice(&transact.serialize()?);

    let mut accounts = vec![
        AccountMeta::new(to_pubkey(params.relayer_payer), true),
        AccountMeta::new(to_pubkey(stage_pda), false),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
    ];

    match (leave_kind, is_sol, params.destination) {
        (0, true, LeaveDestination::PublicAddress(dest)) => {
            accounts.push(AccountMeta::new(to_pubkey(dest), false));
        }
        (0, false, LeaveDestination::PublicAddress(dest_ata)) => {
            let rel_ata = params.relayer_fee_ata.unwrap_or_else(|| {
                find_ata(
                    params.relayer_payer.as_array(),
                    params.mint.as_array(),
                    params.token_program.as_array(),
                )
                .0
            });
            accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program), false));
            accounts.push(AccountMeta::new_readonly(to_pubkey(params.mint), false));
            accounts.push(AccountMeta::new(to_pubkey(stage_in_for_spp), false));
            accounts.push(AccountMeta::new(to_pubkey(dest_ata), false));
            accounts.push(AccountMeta::new(to_pubkey(rel_ata), false));
        }
        (1, true, _) => {
            accounts.push(AccountMeta::new(to_pubkey(params.tree), false));
            accounts.push(AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false));
            accounts.push(AccountMeta::new(spp_pda::sol_interface(), false));
        }
        (1, false, _) => {
            let rel_ata = params.relayer_fee_ata.unwrap_or_else(|| {
                find_ata(
                    params.relayer_payer.as_array(),
                    params.mint.as_array(),
                    params.token_program.as_array(),
                )
                .0
            });
            accounts.push(AccountMeta::new(to_pubkey(params.tree), false));
            accounts.push(AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false));
            accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program), false));
            accounts.push(AccountMeta::new_readonly(to_pubkey(params.mint), false));
            accounts.push(AccountMeta::new(to_pubkey(stage_in_for_spp), false));
            accounts.push(AccountMeta::new(
                spp_pda::spl_interface(&to_pubkey(params.mint)),
                false,
            ));
            accounts.push(AccountMeta::new(to_pubkey(rel_ata), false));
        }
        _ => return Err(anyhow!("mismatched leave destination")),
    }

    accounts.extend(spp_metas);
    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts,
        data: ix_data,
    })
}

/// Build and prove `open_seat`, creating `seat_state`, minting the initial `DataUtxo<SeatNote>`,
/// and optionally executing target-protocol setup CPIs (e.g., Kamino `init_user_metadata` + `init_obligation`)
/// signed by `seat_pda` + `relayer_payer`.
#[allow(clippy::too_many_arguments)]
pub fn build_and_prove_open_seat(
    holder: &HolderKeys,
    seat_index: u64,
    seat_note_key_index: u64,
    relayer_payer: Address,
    expiry: u64,
    tree: Address,
    tree_id: u16,
    setup_cpis: Vec<SetupCpi>,
    setup_accounts: Vec<AccountMeta>,
    indexer: &SprIndexer,
) -> Result<(Instruction, [u8; 32], Address)> {
    let (authority_pda, authority_bump) = find_authority_pda();
    let seat_commitment = holder.seat_commitment(seat_index)?;
    let (seat_state_pda, _) = find_seat_state_pda(&seat_commitment);
    let (seat_pda, _) = find_seat_pda(&seat_commitment);

    let pda_zero = ProgramOwner::new(authority_pda);
    let pda_zero_addr: ShieldedAddress = pda_zero
        .address(holder.viewing_key().pubkey())
        .map_err(|e| anyhow!("pda_zero address: {e:?}"))?;
    let seat_owner_keys = holder.one_time_keys(seat_note_key_index)?;
    let seat_owner_addr = holder.one_time_address(seat_note_key_index)?;

    let program_tx = SeatOpenClient {
        private: SeatOpenPrivateInputsClient {
            tx_context: TransactionOptions {
                blinding_seed: None,
                output_tree_id: Some(tree_id),
            },
            seat_secret: holder.seat_secret_bytes(seat_index),
            pda_address_owner: pda_zero_addr,
            seat_owner: seat_owner_addr,
        },
        public: SeatOpenPublicInputsClient {
            authority_identity: authority_identity()?,
            seat_commitment: field(seat_commitment)?,
            expiry,
        },
    }
    .prepare(&seat_owner_addr, relayer_payer)
    .map_err(|e| anyhow!("SeatOpenClient::prepare: {e:?}"))?;

    let proof = prove(CircuitKind::SeatOpen, &program_tx.proof_inputs)?;
    let mut spp_inputs = program_tx
        .finalized
        .encrypt_with_keys(&seat_owner_keys)
        .map_err(|e| anyhow!("encrypt_with_keys: {e:?}"))?;
    spp_inputs.external_data.expiry_unix_ts = expiry;

    let authority = MultiKeyProofAuthority::new(vec![holder.nullifier_key(seat_note_key_index)?]);
    let transact = prove_spp_transact(indexer, spp_inputs, &authority)?;
    let spp_metas = spp_transact_accounts_for_pook(&transact, relayer_payer, tree, &[], None)?;

    let args = OpenSeatArgs {
        proof,
        authority_bump,
        seat_commitment,
        expiry,
        spp_account_count: u8::try_from(spp_metas.len())?,
        setup_cpis,
    };
    let mut ix_data = vec![tag::OPEN_SEAT];
    ix_data.extend_from_slice(&wincode::serialize(&args)?);
    ix_data.extend_from_slice(&transact.serialize()?);

    let mut accounts = vec![
        AccountMeta::new(to_pubkey(relayer_payer), true),
        AccountMeta::new(to_pubkey(seat_state_pda), false),
        AccountMeta::new(to_pubkey(seat_pda), false),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
    ];
    accounts.extend(spp_metas);
    accounts.extend(setup_accounts);

    Ok((
        Instruction {
            program_id: to_pubkey(pook_program::ID),
            accounts,
            data: ix_data,
        },
        seat_commitment,
        seat_pda,
    ))
}

/// Parameters to build and prove a `SeatFund` `run` instruction (e.g., `kamino.collateral.deposit`, `kamino.repay`).
pub struct BuildSeatFundParams<'a> {
    pub holder: &'a HolderKeys,
    pub seat_index: u64,
    pub seat_utxo: WalletUtxo,
    pub seat_note_key_index: u64,
    pub next_seat_note_key_index: u64,
    pub input_0: WalletUtxo,
    pub input_0_index: u64,
    pub input_1: Option<(WalletUtxo, u64)>,
    pub change_index: u64,
    pub output_index: u64,
    pub hook: &'a Hook,
    pub hook_pda: Address,
    pub config_fee_recipient: Address,
    pub relayer_payer: Address,
    pub relayer_fee: u64,
    pub relayer_fee_ata: Option<Address>,
    pub amount_in: u64,
    pub min_out: u64,
    pub mint_in: Address,
    pub mint_out: Address,
    pub has_mint_out: bool,
    pub token_program_in: Address,
    pub token_program_out: Address,
    pub caller_data: Vec<u8>,
    pub caller_accounts: Vec<AccountMeta>,
    pub caller_remaining_writable: Vec<u8>,
    pub expiry: u64,
    pub tree: Address,
    pub tree_id: u16,
}

/// Parameters to build and prove a `SeatAction` `run` instruction (e.g., `kamino.borrow`, `kamino.collateral.withdraw`).
pub struct BuildSeatActionParams<'a> {
    pub holder: &'a HolderKeys,
    pub seat_index: u64,
    pub seat_utxo: WalletUtxo,
    pub seat_note_key_index: u64,
    pub next_seat_note_key_index: u64,
    pub output_index: u64,
    pub hook: &'a Hook,
    pub hook_pda: Address,
    pub config_fee_recipient: Address,
    pub relayer_payer: Address,
    pub relayer_fee: u64,
    pub relayer_fee_ata: Option<Address>,
    pub min_out: u64,
    pub mint_out: Address,
    pub has_mint_out: bool,
    pub token_program_out: Address,
    pub caller_data: Vec<u8>,
    pub caller_accounts: Vec<AccountMeta>,
    pub caller_remaining_writable: Vec<u8>,
    pub expiry: u64,
    pub tree: Address,
    pub tree_id: u16,
}

#[allow(clippy::too_many_arguments)]
fn resolve_seat_cpi_tuples(
    hook: &Hook,
    stage_pda: Address,
    seat_pda: Address,
    relayer_payer: Address,
    stage_in_for_hook: Option<Address>,
    stage_out_for_hook: Option<Address>,
    caller_accounts: &[AccountMeta],
    caller_remaining_writable: &[u8],
) -> Result<Vec<(Address, bool, bool)>> {
    let mut cpi_tuples = Vec::new();
    let mut caller_idx = 0usize;
    for slot in &hook.account_slots {
        match slot.kind {
            AccountSlotKind::StagePda => {
                cpi_tuples.push((stage_pda, slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::StageIn => {
                let addr = stage_in_for_hook
                    .ok_or_else(|| anyhow!("missing stage_in for StageIn slot"))?;
                cpi_tuples.push((addr, slot.is_writable, false));
            }
            AccountSlotKind::StageOut => {
                let addr = stage_out_for_hook
                    .ok_or_else(|| anyhow!("missing stage_out for StageOut slot"))?;
                cpi_tuples.push((addr, slot.is_writable, false));
            }
            AccountSlotKind::SeatPda => {
                cpi_tuples.push((seat_pda, slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::Payer => {
                cpi_tuples.push((relayer_payer, slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::Fixed | AccountSlotKind::Caller => {
                let meta = caller_accounts
                    .get(caller_idx)
                    .ok_or_else(|| anyhow!("missing caller account at {caller_idx}"))?;
                caller_idx += 1;
                cpi_tuples.push((from_pubkey(meta.pubkey), slot.is_writable, false));
            }
            AccountSlotKind::CallerRemaining => {
                let rem = &caller_accounts[caller_idx..];
                ensure!(
                    rem.len() == caller_remaining_writable.len(),
                    "caller_remaining_writable length mismatch"
                );
                for (meta, &w) in rem.iter().zip(caller_remaining_writable.iter()) {
                    cpi_tuples.push((from_pubkey(meta.pubkey), w != 0, false));
                }
                caller_idx = caller_accounts.len();
            }
        }
    }
    ensure!(
        caller_idx == caller_accounts.len(),
        "extra caller accounts supplied"
    );
    Ok(cpi_tuples)
}

#[allow(clippy::too_many_arguments)]
fn append_run_output_accounts(
    accounts: &mut Vec<AccountMeta>,
    hook: &Hook,
    has_mint_out: bool,
    out_is_sol: bool,
    mint_out: Address,
    token_program_out: Address,
    stage_out_for_hook: Address,
    config_fee_recipient: Address,
    relayer_payer: Address,
    relayer_fee_ata: Option<Address>,
) {
    if !has_mint_out {
        return;
    }
    if out_is_sol {
        let (af_pda, _) = find_author_fees_pda(&hook.author, &[0u8; 32]);
        accounts.push(AccountMeta::new(spp_pda::sol_interface(), false));
        accounts.push(AccountMeta::new(to_pubkey(config_fee_recipient), false));
        accounts.push(AccountMeta::new(to_pubkey(af_pda), false));
        if hook.unwrap_sol_out {
            accounts.push(AccountMeta::new_readonly(to_pubkey(token_program_out), false));
            accounts.push(AccountMeta::new(to_pubkey(stage_out_for_hook), false));
        }
    } else {
        let (af_pda, _) = find_author_fees_pda(&hook.author, mint_out.as_array());
        let (af_ata, _) = find_ata(
            af_pda.as_array(),
            mint_out.as_array(),
            token_program_out.as_array(),
        );
        let (fee_rec_ata, _) = find_ata(
            config_fee_recipient.as_array(),
            mint_out.as_array(),
            token_program_out.as_array(),
        );
        let rel_ata = relayer_fee_ata.unwrap_or_else(|| {
            find_ata(
                relayer_payer.as_array(),
                mint_out.as_array(),
                token_program_out.as_array(),
            )
            .0
        });
        accounts.push(AccountMeta::new_readonly(to_pubkey(token_program_out), false));
        accounts.push(AccountMeta::new_readonly(to_pubkey(mint_out), false));
        accounts.push(AccountMeta::new(to_pubkey(stage_out_for_hook), false));
        accounts.push(AccountMeta::new(
            spp_pda::spl_interface(&to_pubkey(mint_out)),
            false,
        ));
        accounts.push(AccountMeta::new(to_pubkey(fee_rec_ata), false));
        accounts.push(AccountMeta::new(to_pubkey(af_pda), false));
        accounts.push(AccountMeta::new(to_pubkey(af_ata), false));
        accounts.push(AccountMeta::new(to_pubkey(rel_ata), false));
    }
}

/// Build, prove (Xark `seat_fund` + SPP `transact`), and return a `pook::run` (`RunKind::SeatFund`) `Instruction`.
pub fn build_and_prove_seat_fund(
    params: BuildSeatFundParams<'_>,
    indexer: &SprIndexer,
) -> Result<Instruction> {
    ensure!(params.hook.kind == HookKind::Seat, "expected Seat hook");
    ensure!(params.amount_in > 0, "SeatFund requires amount_in > 0");

    let (_, authority_bump) = find_authority_pda();
    let (stage_pda, stage_bump) = find_stage_pda();
    let (config_pda, _) = find_config_pda();
    let seat_commitment = params.holder.seat_commitment(params.seat_index)?;
    let (seat_state_pda, _) = find_seat_state_pda(&seat_commitment);
    let (seat_pda, _) = find_seat_pda(&seat_commitment);

    let in_is_sol = params.mint_in == Address::default();
    let out_is_sol = params.has_mint_out && params.mint_out == Address::default();

    let stage_in_for_spp = if in_is_sol {
        stage_pda
    } else {
        find_ata(
            seat_pda.as_array(),
            params.mint_in.as_array(),
            params.token_program_in.as_array(),
        )
        .0
    };
    let stage_in_for_hook = if in_is_sol && params.hook.wrap_sol_in {
        find_ata(
            seat_pda.as_array(),
            &WSOL_MINT,
            params.token_program_in.as_array(),
        )
        .0
    } else {
        stage_in_for_spp
    };
    let stage_out_for_hook = if !params.has_mint_out {
        stage_pda
    } else if out_is_sol && params.hook.unwrap_sol_out {
        find_ata(
            seat_pda.as_array(),
            &WSOL_MINT,
            params.token_program_out.as_array(),
        )
        .0
    } else if out_is_sol {
        stage_pda
    } else {
        find_ata(
            seat_pda.as_array(),
            params.mint_out.as_array(),
            params.token_program_out.as_array(),
        )
        .0
    };

    let cpi_data = resolve_cpi_data(
        params.hook,
        params.amount_in,
        params.min_out,
        &params.caller_data,
    )
    .map_err(|e| anyhow!("resolve_cpi_data: {e}"))?;

    let cpi_tuples = resolve_seat_cpi_tuples(
        params.hook,
        stage_pda,
        seat_pda,
        params.relayer_payer,
        Some(stage_in_for_hook),
        params.has_mint_out.then_some(stage_out_for_hook),
        &params.caller_accounts,
        &params.caller_remaining_writable,
    )?;

    let call_hash = compute_call_hash(
        &params.hook.target_program,
        params.has_mint_out,
        params.mint_out.as_array(),
        &cpi_data,
        &cpi_tuples,
    )
    .map_err(|e| anyhow!("compute_call_hash: {e}"))?;

    // Always bind a real one-time owner hash so any unused input left in `StageIn`
    // (e.g., Kamino reserve rounding or repay overpayment) is deposited back to the holder.
    let output_owner_hash = params.holder.one_time_owner_hash(params.output_index)?;
    let hook_hash = hash_bytes(params.hook_pda.as_array())
        .map_err(|e| anyhow!("hook_hash: {e:?}"))?;

    let (input_1_utxo, nf_1_field, mut auth_keys) = match params.input_1 {
        Some((utxo, idx)) => (
            utxo,
            params.holder.nullifier_secret_field(idx)?,
            vec![
                params.holder.nullifier_key(params.seat_note_key_index)?,
                params.holder.nullifier_key(params.input_0_index)?,
                params.holder.nullifier_key(idx)?,
            ],
        ),
        None => (
            WalletUtxo::dummy(params.tree_id).map_err(|e| anyhow!("dummy utxo: {e:?}"))?,
            Field::zero(),
            vec![
                params.holder.nullifier_key(params.seat_note_key_index)?,
                params.holder.nullifier_key(params.input_0_index)?,
            ],
        ),
    };

    let sender_keys = params.holder.one_time_keys(params.seat_note_key_index)?;
    let sender_addr = params.holder.one_time_address(params.seat_note_key_index)?;
    let next_seat_owner = params.holder.one_time_address(params.next_seat_note_key_index)?;
    let change_addr = params.holder.one_time_address(params.change_index)?;

    let program_tx = SeatFundClient {
        private: SeatFundPrivateInputsClient {
            tx_context: TransactionOptions {
                blinding_seed: None,
                output_tree_id: Some(params.tree_id),
            },
            seat_input: params.seat_utxo,
            seat_secret: params.holder.seat_secret_bytes(params.seat_index),
            seat_nullifier_secret: params
                .holder
                .nullifier_secret_field(params.seat_note_key_index)?,
            next_seat_owner,
            input_0: params.input_0,
            nullifier_secret_0: params.holder.nullifier_secret_field(params.input_0_index)?,
            input_1: input_1_utxo,
            nullifier_secret_1: nf_1_field,
            change_owner: change_addr,
            stage_in_account: *stage_in_for_spp.as_array(),
        },
        public: SeatFundPublicInputsClient {
            authority_identity: authority_identity()?,
            seat_commitment: field(seat_commitment)?,
            hook_hash: field(hook_hash)?,
            call_hash: field(call_hash)?,
            amount_in: params.amount_in,
            min_out: params.min_out,
            output_owner_hash: field(output_owner_hash)?,
            relayer_fee: params.relayer_fee,
            expiry: params.expiry,
        },
    }
    .prepare(&sender_addr, params.relayer_payer)
    .map_err(|e| anyhow!("SeatFundClient::prepare: {e:?}"))?;

    let proof = prove(CircuitKind::SeatFund, &program_tx.proof_inputs)?;
    let mut spp_inputs = program_tx
        .finalized
        .encrypt_with_keys(&sender_keys)
        .map_err(|e| anyhow!("encrypt_with_keys: {e:?}"))?;
    spp_inputs.external_data.expiry_unix_ts = params.expiry;

    let authority = MultiKeyProofAuthority::new(core::mem::take(&mut auth_keys));
    let transact = prove_spp_transact(indexer, spp_inputs, &authority)?;
    let spp_metas = spp_transact_accounts_for_pook(
        &transact,
        params.relayer_payer,
        params.tree,
        &[params.mint_in],
        Some(stage_in_for_spp),
    )?;

    let out_spl_interface_bump = if params.has_mint_out && !out_is_sol {
        spp_pda::spl_interface_with_bump(&to_pubkey(params.mint_out)).1
    } else {
        0
    };

    let run_args = RunArgs {
        kind: RunKind::SeatFund,
        proof,
        authority_bump,
        stage_bump,
        amount_in: params.amount_in,
        min_out: params.min_out,
        output_owner_hash,
        relayer_fee: params.relayer_fee,
        expiry: params.expiry,
        seat_commitment,
        mint_in: *params.mint_in.as_array(),
        mint_out: *params.mint_out.as_array(),
        has_mint_out: params.has_mint_out,
        out_spl_interface_bump,
        spp_account_count: u8::try_from(spp_metas.len())?,
        caller_data: params.caller_data,
        caller_remaining_writable: params.caller_remaining_writable,
    };

    let mut ix_data = vec![tag::RUN];
    ix_data.extend_from_slice(&wincode::serialize(&run_args)?);
    ix_data.extend_from_slice(&transact.serialize()?);

    let mut accounts = vec![
        AccountMeta::new(to_pubkey(params.relayer_payer), true),
        AccountMeta::new_readonly(to_pubkey(config_pda), false),
        AccountMeta::new_readonly(to_pubkey(params.hook_pda), false),
        AccountMeta::new(to_pubkey(stage_pda), false),
        AccountMeta::new_readonly(
            solana_pubkey::Pubkey::new_from_array(params.hook.target_program),
            false,
        ),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        AccountMeta::new(to_pubkey(params.tree), false),
        AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false),
    ];

    if in_is_sol && params.hook.wrap_sol_in {
        accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program_in), false));
        accounts.push(AccountMeta::new(to_pubkey(stage_in_for_hook), false));
    } else if !in_is_sol {
        accounts.push(AccountMeta::new_readonly(to_pubkey(params.token_program_in), false));
        accounts.push(AccountMeta::new_readonly(to_pubkey(params.mint_in), false));
        accounts.push(AccountMeta::new(to_pubkey(stage_in_for_spp), false));
    }

    append_run_output_accounts(
        &mut accounts,
        params.hook,
        params.has_mint_out,
        out_is_sol,
        params.mint_out,
        params.token_program_out,
        stage_out_for_hook,
        params.config_fee_recipient,
        params.relayer_payer,
        params.relayer_fee_ata,
    );

    // Seat accounts (always present for HookKind::Seat).
    accounts.push(AccountMeta::new_readonly(to_pubkey(seat_state_pda), false));
    accounts.push(AccountMeta::new(to_pubkey(seat_pda), false));

    if !params.hook.companions.is_empty() {
        accounts.push(AccountMeta::new_readonly(
            solana_pubkey::Pubkey::new_from_array(INSTRUCTIONS_SYSVAR_ID),
            false,
        ));
    }

    accounts.extend(spp_metas);
    accounts.extend(params.caller_accounts);

    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts,
        data: ix_data,
    })
}

/// Build, prove (Xark `seat_action` + SPP `transact`), and return a `pook::run` (`RunKind::SeatAction`) `Instruction`.
pub fn build_and_prove_seat_action(
    params: BuildSeatActionParams<'_>,
    indexer: &SprIndexer,
) -> Result<Instruction> {
    ensure!(params.hook.kind == HookKind::Seat, "expected Seat hook");

    let (_, authority_bump) = find_authority_pda();
    let (stage_pda, stage_bump) = find_stage_pda();
    let (config_pda, _) = find_config_pda();
    let seat_commitment = params.holder.seat_commitment(params.seat_index)?;
    let (seat_state_pda, _) = find_seat_state_pda(&seat_commitment);
    let (seat_pda, _) = find_seat_pda(&seat_commitment);

    let out_is_sol = params.has_mint_out && params.mint_out == Address::default();
    let stage_out_for_hook = if !params.has_mint_out {
        stage_pda
    } else if out_is_sol && params.hook.unwrap_sol_out {
        find_ata(
            seat_pda.as_array(),
            &WSOL_MINT,
            params.token_program_out.as_array(),
        )
        .0
    } else if out_is_sol {
        stage_pda
    } else {
        find_ata(
            seat_pda.as_array(),
            params.mint_out.as_array(),
            params.token_program_out.as_array(),
        )
        .0
    };

    let cpi_data = resolve_cpi_data(params.hook, 0, params.min_out, &params.caller_data)
        .map_err(|e| anyhow!("resolve_cpi_data: {e}"))?;

    let cpi_tuples = resolve_seat_cpi_tuples(
        params.hook,
        stage_pda,
        seat_pda,
        params.relayer_payer,
        None,
        params.has_mint_out.then_some(stage_out_for_hook),
        &params.caller_accounts,
        &params.caller_remaining_writable,
    )?;

    let call_hash = compute_call_hash(
        &params.hook.target_program,
        params.has_mint_out,
        params.mint_out.as_array(),
        &cpi_data,
        &cpi_tuples,
    )
    .map_err(|e| anyhow!("compute_call_hash: {e}"))?;

    // Always bind a real one-time owner hash so any unused input left in `StageIn`
    // (e.g., Kamino reserve rounding or repay overpayment) is deposited back to the holder.
    let output_owner_hash = params.holder.one_time_owner_hash(params.output_index)?;
    let hook_hash = hash_bytes(params.hook_pda.as_array())
        .map_err(|e| anyhow!("hook_hash: {e:?}"))?;

    let sender_keys = params.holder.one_time_keys(params.seat_note_key_index)?;
    let sender_addr = params.holder.one_time_address(params.seat_note_key_index)?;
    let next_seat_owner = params.holder.one_time_address(params.next_seat_note_key_index)?;

    let program_tx = SeatActionClient {
        private: SeatActionPrivateInputsClient {
            tx_context: TransactionOptions {
                blinding_seed: None,
                output_tree_id: Some(params.tree_id),
            },
            seat_input: params.seat_utxo,
            seat_secret: params.holder.seat_secret_bytes(params.seat_index),
            seat_nullifier_secret: params
                .holder
                .nullifier_secret_field(params.seat_note_key_index)?,
            next_seat_owner,
        },
        public: SeatActionPublicInputsClient {
            authority_identity: authority_identity()?,
            seat_commitment: field(seat_commitment)?,
            hook_hash: field(hook_hash)?,
            call_hash: field(call_hash)?,
            min_out: params.min_out,
            output_owner_hash: field(output_owner_hash)?,
            relayer_fee: params.relayer_fee,
            expiry: params.expiry,
        },
    }
    .prepare(&sender_addr, params.relayer_payer)
    .map_err(|e| anyhow!("SeatActionClient::prepare: {e:?}"))?;

    let proof = prove(CircuitKind::SeatAction, &program_tx.proof_inputs)?;
    let mut spp_inputs = program_tx
        .finalized
        .encrypt_with_keys(&sender_keys)
        .map_err(|e| anyhow!("encrypt_with_keys: {e:?}"))?;
    spp_inputs.external_data.expiry_unix_ts = params.expiry;

    let authority = MultiKeyProofAuthority::new(vec![params
        .holder
        .nullifier_key(params.seat_note_key_index)?]);
    let transact = prove_spp_transact(indexer, spp_inputs, &authority)?;
    let spp_metas = spp_transact_accounts_for_pook(&transact, params.relayer_payer, params.tree, &[], None)?;

    let out_spl_interface_bump = if params.has_mint_out && !out_is_sol {
        spp_pda::spl_interface_with_bump(&to_pubkey(params.mint_out)).1
    } else {
        0
    };

    let run_args = RunArgs {
        kind: RunKind::SeatAction,
        proof,
        authority_bump,
        stage_bump,
        amount_in: 0,
        min_out: params.min_out,
        output_owner_hash,
        relayer_fee: params.relayer_fee,
        expiry: params.expiry,
        seat_commitment,
        mint_in: [0u8; 32],
        mint_out: *params.mint_out.as_array(),
        has_mint_out: params.has_mint_out,
        out_spl_interface_bump,
        spp_account_count: u8::try_from(spp_metas.len())?,
        caller_data: params.caller_data,
        caller_remaining_writable: params.caller_remaining_writable,
    };

    let mut ix_data = vec![tag::RUN];
    ix_data.extend_from_slice(&wincode::serialize(&run_args)?);
    ix_data.extend_from_slice(&transact.serialize()?);

    let mut accounts = vec![
        AccountMeta::new(to_pubkey(params.relayer_payer), true),
        AccountMeta::new_readonly(to_pubkey(config_pda), false),
        AccountMeta::new_readonly(to_pubkey(params.hook_pda), false),
        AccountMeta::new(to_pubkey(stage_pda), false),
        AccountMeta::new_readonly(
            solana_pubkey::Pubkey::new_from_array(params.hook.target_program),
            false,
        ),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        AccountMeta::new(to_pubkey(params.tree), false),
        AccountMeta::new_readonly(PROGRAM_ID_PUBKEY, false),
    ];

    append_run_output_accounts(
        &mut accounts,
        params.hook,
        params.has_mint_out,
        out_is_sol,
        params.mint_out,
        params.token_program_out,
        stage_out_for_hook,
        params.config_fee_recipient,
        params.relayer_payer,
        params.relayer_fee_ata,
    );

    accounts.push(AccountMeta::new_readonly(to_pubkey(seat_state_pda), false));
    accounts.push(AccountMeta::new(to_pubkey(seat_pda), false));

    if !params.hook.companions.is_empty() {
        accounts.push(AccountMeta::new_readonly(
            solana_pubkey::Pubkey::new_from_array(INSTRUCTIONS_SYSVAR_ID),
            false,
        ));
    }

    accounts.extend(spp_metas);
    accounts.extend(params.caller_accounts);

    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts,
        data: ix_data,
    })
}

/// Helper: derive Kamino `user_metadata` PDA `[b"user_meta", owner]`,
/// vanilla `obligation` PDA `[0, 0, owner, lending_market, default, default]`,
/// and `obligation_farm_user_state` PDA `[b"user", reserve_farm_state, obligation]`.
pub fn derive_kamino_seat_pdas(
    seat_pda: Address,
    lending_market: Address,
) -> (Address, Address) {
    let klend = to_pubkey(crate::hooks::KAMINO_LEND_ID);
    let default_pk = solana_pubkey::Pubkey::default();
    let (user_meta, _) = solana_pubkey::Pubkey::find_program_address(
        &[b"user_meta", seat_pda.as_array()],
        &klend,
    );
    let (obligation, _) = solana_pubkey::Pubkey::find_program_address(
        &[
            &[0u8],
            &[0u8],
            seat_pda.as_array(),
            lending_market.as_array(),
            default_pk.as_ref(),
            default_pk.as_ref(),
        ],
        &klend,
    );
    (from_pubkey(user_meta), from_pubkey(obligation))
}

pub fn derive_kamino_obligation_farm_pda(
    reserve_farm_state: Address,
    obligation: Address,
) -> Address {
    let kfarms = to_pubkey(crate::hooks::KAMINO_FARMS_ID);
    let (pda, _) = solana_pubkey::Pubkey::find_program_address(
        &[b"user", reserve_farm_state.as_array(), obligation.as_array()],
        &kfarms,
    );
    from_pubkey(pda)
}

/// Build the two Kamino setup CPIs (`init_user_metadata` + `init_obligation`) and trailing
/// `setup_accounts` to pass into `build_and_prove_open_seat` when opening a Kamino seat.
pub fn kamino_open_seat_setup(
    seat_pda: Address,
    lending_market: Address,
) -> (Vec<SetupCpi>, Vec<AccountMeta>, Address, Address) {
    use crate::hooks::{kamino_disc, KAMINO_LEND_ID, SYSVAR_RENT_ID};
    let (user_meta, obligation) = derive_kamino_seat_pdas(seat_pda, lending_market);

    // setup_accounts layout (indexed starting at 3; 0=payer, 1=seat_pda, 2=system_program):
    //   3: user_meta (mut)
    //   4: obligation (mut)
    //   5: lending_market (ro)
    //   6: rent sysvar (ro)
    //   7: KAMINO_LEND_ID (ro — used as None for referrer_user_metadata)
    //   8: Pubkey::default() (ro — seed1_account & seed2_account for vanilla tag=0 obligation)
    let setup_accounts = vec![
        AccountMeta::new(to_pubkey(user_meta), false),
        AccountMeta::new(to_pubkey(obligation), false),
        AccountMeta::new_readonly(to_pubkey(lending_market), false),
        AccountMeta::new_readonly(to_pubkey(SYSVAR_RENT_ID), false),
        AccountMeta::new_readonly(to_pubkey(KAMINO_LEND_ID), false),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::default(), false),
    ];

    // 1. init_user_metadata(user_lookup_table = Pubkey::default())
    let mut meta_data = Vec::with_capacity(40);
    meta_data.extend_from_slice(&kamino_disc::INIT_USER_METADATA);
    meta_data.extend_from_slice(&[0u8; 32]);
    let init_meta_cpi = SetupCpi {
        target_program: *KAMINO_LEND_ID.as_array(),
        data: meta_data,
        accounts: vec![
            SetupCpiAccount { account_index: 1, is_writable: false, is_signer: true },  // owner (seat_pda)
            SetupCpiAccount { account_index: 0, is_writable: true, is_signer: true },   // fee_payer
            SetupCpiAccount { account_index: 3, is_writable: true, is_signer: false },  // user_metadata
            SetupCpiAccount { account_index: 7, is_writable: false, is_signer: false }, // referrer_user_metadata (None)
            SetupCpiAccount { account_index: 6, is_writable: false, is_signer: false }, // rent
            SetupCpiAccount { account_index: 2, is_writable: false, is_signer: false }, // system_program
        ],
    };

    // 2. init_obligation(InitObligationArgs { tag: 0, id: 0 })
    let mut ob_data = Vec::with_capacity(10);
    ob_data.extend_from_slice(&kamino_disc::INIT_OBLIGATION);
    ob_data.push(0); // tag = 0 (Vanilla)
    ob_data.push(0); // id = 0
    let init_ob_cpi = SetupCpi {
        target_program: *KAMINO_LEND_ID.as_array(),
        data: ob_data,
        accounts: vec![
            SetupCpiAccount { account_index: 1, is_writable: false, is_signer: true },  // obligation_owner (seat_pda)
            SetupCpiAccount { account_index: 0, is_writable: true, is_signer: true },   // fee_payer
            SetupCpiAccount { account_index: 4, is_writable: true, is_signer: false },  // obligation
            SetupCpiAccount { account_index: 5, is_writable: false, is_signer: false }, // lending_market
            SetupCpiAccount { account_index: 8, is_writable: false, is_signer: false }, // seed1_account (default)
            SetupCpiAccount { account_index: 8, is_writable: false, is_signer: false }, // seed2_account (default)
            SetupCpiAccount { account_index: 3, is_writable: false, is_signer: false }, // owner_user_metadata
            SetupCpiAccount { account_index: 6, is_writable: false, is_signer: false }, // rent
            SetupCpiAccount { account_index: 2, is_writable: false, is_signer: false }, // system_program
        ],
    };

    (vec![init_meta_cpi, init_ob_cpi], setup_accounts, user_meta, obligation)
}

/// Permissionless Kamino `refresh_reserve` companion instruction.
pub fn kamino_refresh_reserve_ix(
    reserve: Address,
    lending_market: Address,
    scope_prices: Address,
) -> Instruction {
    use crate::hooks::{kamino_disc, KAMINO_LEND_ID};
    let klend = to_pubkey(KAMINO_LEND_ID);
    Instruction {
        program_id: klend,
        accounts: vec![
            AccountMeta::new(to_pubkey(reserve), false),
            AccountMeta::new_readonly(to_pubkey(lending_market), false),
            AccountMeta::new_readonly(klend, false), // pyth_oracle: None
            AccountMeta::new_readonly(klend, false), // switchboard_price_oracle: None
            AccountMeta::new_readonly(klend, false), // switchboard_twap_oracle: None
            AccountMeta::new_readonly(to_pubkey(scope_prices), false),
        ],
        data: kamino_disc::REFRESH_RESERVE.to_vec(),
    }
}

/// Permissionless Kamino `refresh_obligation` companion instruction.
pub fn kamino_refresh_obligation_ix(
    lending_market: Address,
    obligation: Address,
    deposit_and_borrow_reserves: &[Address],
) -> Instruction {
    use crate::hooks::{kamino_disc, KAMINO_LEND_ID};
    let mut accounts = vec![
        AccountMeta::new_readonly(to_pubkey(lending_market), false),
        AccountMeta::new(to_pubkey(obligation), false),
    ];
    for r in deposit_and_borrow_reserves {
        accounts.push(AccountMeta::new_readonly(to_pubkey(*r), false));
    }
    Instruction {
        program_id: to_pubkey(KAMINO_LEND_ID),
        accounts,
        data: kamino_disc::REFRESH_OBLIGATION.to_vec(),
    }
}

/// Permissionless Kamino `init_obligation_farms_for_reserve` (relayer-funded; `owner` is not a signer).
#[allow(clippy::too_many_arguments)]
pub fn kamino_init_obligation_farms_for_reserve_ix(
    payer: Address,
    owner: Address,
    obligation: Address,
    lending_market_authority: Address,
    reserve: Address,
    reserve_farm_state: Address,
    obligation_farm: Address,
    lending_market: Address,
    mode: u8,
) -> Instruction {
    use crate::hooks::{kamino_disc, KAMINO_FARMS_ID, KAMINO_LEND_ID, SYSVAR_RENT_ID};
    let mut data = Vec::with_capacity(9);
    data.extend_from_slice(&kamino_disc::INIT_OBLIGATION_FARMS_FOR_RESERVE);
    data.push(mode);
    Instruction {
        program_id: to_pubkey(KAMINO_LEND_ID),
        accounts: vec![
            AccountMeta::new(to_pubkey(payer), true),
            AccountMeta::new_readonly(to_pubkey(owner), false),
            AccountMeta::new(to_pubkey(obligation), false),
            AccountMeta::new_readonly(to_pubkey(lending_market_authority), false),
            AccountMeta::new(to_pubkey(reserve), false),
            AccountMeta::new(to_pubkey(reserve_farm_state), false),
            AccountMeta::new(to_pubkey(obligation_farm), false),
            AccountMeta::new_readonly(to_pubkey(lending_market), false),
            AccountMeta::new_readonly(to_pubkey(KAMINO_FARMS_ID), false),
            AccountMeta::new_readonly(to_pubkey(SYSVAR_RENT_ID), false),
            AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
        ],
        data,
    }
}

/// Build and prove `close_seat`, burning the `SeatNote` and returning seat rent to `opener_relayer`.
pub fn build_and_prove_close_seat(
    holder: &HolderKeys,
    seat_index: u64,
    seat_utxo: WalletUtxo,
    seat_note_key_index: u64,
    relayer_payer: Address,
    opener_relayer: Address,
    expiry: u64,
    tree: Address,
    tree_id: u16,
    indexer: &SprIndexer,
) -> Result<Instruction> {
    let (_, authority_bump) = find_authority_pda();
    let seat_commitment = holder.seat_commitment(seat_index)?;
    let (seat_state_pda, _) = find_seat_state_pda(&seat_commitment);
    let (seat_pda, _) = find_seat_pda(&seat_commitment);

    let seat_owner_keys = holder.one_time_keys(seat_note_key_index)?;
    let seat_owner_addr = holder.one_time_address(seat_note_key_index)?;

    let program_tx = SeatCloseClient {
        private: SeatClosePrivateInputsClient {
            tx_context: TransactionOptions {
                blinding_seed: None,
                output_tree_id: Some(tree_id),
            },
            seat_input: seat_utxo,
            seat_secret: holder.seat_secret_bytes(seat_index),
            seat_nullifier_secret: holder.nullifier_secret_field(seat_note_key_index)?,
        },
        public: SeatClosePublicInputsClient {
            authority_identity: authority_identity()?,
            seat_commitment: field(seat_commitment)?,
            expiry,
        },
    }
    .prepare(&seat_owner_addr, relayer_payer)
    .map_err(|e| anyhow!("SeatCloseClient::prepare: {e:?}"))?;

    let proof = prove(CircuitKind::SeatClose, &program_tx.proof_inputs)?;
    let mut spp_inputs = program_tx
        .finalized
        .encrypt_with_keys(&seat_owner_keys)
        .map_err(|e| anyhow!("encrypt_with_keys: {e:?}"))?;
    spp_inputs.external_data.expiry_unix_ts = expiry;

    let authority = MultiKeyProofAuthority::new(vec![holder.nullifier_key(seat_note_key_index)?]);
    let transact = prove_spp_transact(indexer, spp_inputs, &authority)?;
    let spp_metas = spp_transact_accounts_for_pook(&transact, relayer_payer, tree, &[], None)?;

    let args = CloseSeatArgs {
        proof,
        authority_bump,
        seat_commitment,
        expiry,
    };
    let mut ix_data = vec![tag::CLOSE_SEAT];
    ix_data.extend_from_slice(&wincode::serialize(&args)?);
    ix_data.extend_from_slice(&transact.serialize()?);

    let mut accounts = vec![
        AccountMeta::new(to_pubkey(relayer_payer), true),
        AccountMeta::new(to_pubkey(seat_state_pda), false),
        AccountMeta::new(to_pubkey(seat_pda), false),
        AccountMeta::new(to_pubkey(opener_relayer), false),
        AccountMeta::new_readonly(solana_pubkey::Pubkey::new_from_array(SYSTEM_PROGRAM_ID), false),
    ];
    accounts.extend(spp_metas);

    Ok(Instruction {
        program_id: to_pubkey(pook_program::ID),
        accounts,
        data: ix_data,
    })
}

/// Helper: standard SPL Token program address.
pub fn spl_token_address() -> Address {
    Address::new_from_array(SPL_TOKEN_PROGRAM_ID)
}
