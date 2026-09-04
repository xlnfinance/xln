use std::collections::{BTreeMap, BTreeSet};

use xln_rscore_batch::{
    AccountId, AccountInputResult, AccountInputVerdict, ResidentAccountFinancialViewRequest,
};

use crate::paybook::{PaybookChanges, PaybookEffects, dispute_evidence_secret};
use crate::{
    AccountEnvelopeMutation, AccountProposalWork, AdmittedLocalEntityTx, EntityKernelError,
    EntityKernelOutput, EntityStateSlice, LocalAccountFinancialView, LocalEntityFinancialTx,
    LocalEntityTx,
};

#[derive(Clone, Debug)]
pub(crate) struct UnsafeAccountFrame {
    pub account_id: AccountId,
    pub reason: String,
    pub evidence_secrets: Vec<xln_rscore_engine::HtlcEvidenceSecret>,
    pub frame_hash: [u8; 32],
    pub frame_hanko: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) enum UnsafeAccountFrameDisposition {
    CreatedAccountRejected { message: String },
    Process(UnsafeAccountFrame),
}

fn collect_verdict(
    account_id: AccountId,
    verdict: &AccountInputVerdict,
    created_account: bool,
    account_text: &impl Fn(AccountId) -> String,
    output: &mut Vec<UnsafeAccountFrameDisposition>,
) {
    match verdict {
        AccountInputVerdict::FrameDisputeRequired {
            reason,
            evidence_secrets,
            signed_frame,
        } => {
            if created_account {
                let counterparty = account_text(account_id);
                output.push(UnsafeAccountFrameDisposition::CreatedAccountRejected {
                    message: format!(
                        "⚠️ Rejected uncommitted account genesis from {}",
                        &counterparty[counterparty.len() - 8..]
                    ),
                });
            } else {
                output.push(UnsafeAccountFrameDisposition::Process(UnsafeAccountFrame {
                    account_id,
                    reason: reason.clone(),
                    evidence_secrets: evidence_secrets.clone(),
                    frame_hash: signed_frame.state_hash,
                    frame_hanko: signed_frame.frame_hanko.clone(),
                }));
            }
        }
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            collect_verdict(account_id, ack, created_account, account_text, output);
            collect_verdict(account_id, frame, created_account, account_text, output);
        }
        _ => {}
    }
}

pub(crate) fn collect_unsafe_account_frames(
    rows: &[AccountInputResult],
    created_accounts: &BTreeSet<String>,
    account_text: impl Fn(AccountId) -> String,
) -> Vec<UnsafeAccountFrameDisposition> {
    let mut output = Vec::new();
    for row in rows {
        collect_verdict(
            row.account_id,
            &row.verdict,
            created_accounts.contains(&account_text(row.account_id)),
            &account_text,
            &mut output,
        );
    }
    output
}

pub(crate) fn unsafe_account_view_requests(
    frames: &[UnsafeAccountFrame],
) -> Vec<(AccountId, ResidentAccountFinancialViewRequest)> {
    let mut requests = BTreeMap::<AccountId, ResidentAccountFinancialViewRequest>::new();
    for frame in frames {
        let request = requests.entry(frame.account_id).or_default();
        request.dispute = true;
        request.htlc_lock_ids.extend(
            frame
                .evidence_secrets
                .iter()
                .map(|evidence| evidence.hashlock.clone()),
        );
    }
    for request in requests.values_mut() {
        request.htlc_lock_ids.sort();
        request.htlc_lock_ids.dedup();
    }
    requests.into_iter().collect()
}

pub(crate) struct UnsafeAccountEffects {
    pub local_txs: Vec<AdmittedLocalEntityTx>,
    pub proposal_work: Vec<AccountProposalWork>,
    pub envelope_mutations: Vec<(String, AccountEnvelopeMutation)>,
}

pub(crate) fn consume_unsafe_account_frames(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    frames: &[UnsafeAccountFrame],
    views: &BTreeMap<String, LocalAccountFinancialView>,
    signer_id: &str,
) -> Result<UnsafeAccountEffects, EntityKernelError> {
    let mut account_txs = Vec::new();
    let mut outputs = Vec::<EntityKernelOutput>::new();
    let mut envelope_mutations = Vec::new();
    let mut local_txs = Vec::new();
    for frame in frames {
        let account = format!("0x{}", hex::encode(frame.account_id.as_bytes()));
        let view = views
            .get(&account)
            .ok_or_else(|| EntityKernelError::htlc("UNSAFE_ACCOUNT_VIEW_MISSING"))?;
        for evidence in &frame.evidence_secrets {
            let lock = view
                .htlc_locks
                .get(&evidence.hashlock)
                .ok_or_else(|| EntityKernelError::htlc("HTLC_DISPUTE_EVIDENCE_LOCK_MISSING"))?;
            dispute_evidence_secret(
                state,
                paybook,
                &account,
                view,
                lock,
                &evidence.secret,
                &mut PaybookEffects {
                    account_txs: &mut account_txs,
                    outputs: &mut outputs,
                },
            )?;
        }
        envelope_mutations.push((
            account.clone(),
            AccountEnvelopeMutation::SetRejectedFrameEvidence {
                reason: frame.reason.clone(),
                frame_hash: frame.frame_hash,
                frame_hanko: frame.frame_hanko.clone(),
            },
        ));
        local_txs.push(AdmittedLocalEntityTx {
            signer_id: signer_id.to_string(),
            board_epoch: 0,
            tx: LocalEntityTx::Financial(LocalEntityFinancialTx::PrepareDispute(
                crate::local_financial::PrepareDisputeEntityTx {
                    counterparty_entity_id: account,
                    description: Some(frame.reason.clone()),
                    min_cooldown_ms: 0,
                    cross_jurisdiction_route_id: None,
                    starter_initial_arguments: None,
                },
            )),
        });
    }
    let mut proposal_by_account = BTreeMap::<String, Vec<xln_rscore_engine::AccountTx>>::new();
    for (account_id, tx) in account_txs {
        proposal_by_account.entry(account_id).or_default().push(tx);
    }
    if !outputs.is_empty() {
        return Err(EntityKernelError::output(
            "UNSAFE_ACCOUNT_EVIDENCE_OUTPUT_UNEXPECTED",
        ));
    }
    Ok(UnsafeAccountEffects {
        local_txs,
        proposal_work: proposal_by_account
            .into_iter()
            .map(|(account_id, txs)| AccountProposalWork { account_id, txs })
            .collect(),
        envelope_mutations,
    })
}

#[cfg(test)]
mod parity_evidence {
    use super::*;
    use xln_rscore_engine::{AccountFrame, Side, SignedIncomingFrame};

    fn signed_frame(byte: u8) -> SignedIncomingFrame {
        SignedIncomingFrame {
            frame: AccountFrame {
                height: 1,
                timestamp: 1_700_000_000_000,
                j_height: 0,
                txs: Vec::new(),
                prev_frame_hash: format!("0x{}", "00".repeat(32)),
                account_state_root: [byte; 32],
            },
            state_hash: [byte; 32],
            frame_hanko: vec![byte],
        }
    }

    fn dispute_row(
        account_id: AccountId,
        operation_index: u64,
        reason: &str,
    ) -> AccountInputResult {
        AccountInputResult {
            operation_index,
            account_id,
            force_ack: None,
            verdict: AccountInputVerdict::FrameDisputeRequired {
                reason: reason.into(),
                evidence_secrets: Vec::new(),
                signed_frame: signed_frame(operation_index as u8),
            },
        }
    }

    fn empty_view() -> LocalAccountFinancialView {
        LocalAccountFinancialView {
            active: true,
            owner_side: Side::Left,
            owner_out_capacity: BTreeMap::new(),
            owner_peer_credit_limit: BTreeMap::new(),
            settlement_workspace: None,
            settlement_transition_pending: false,
            settlement_execution: Err("not requested".into()),
            rebalance_active_quote: None,
            htlc_locks: BTreeMap::new(),
            pulls: BTreeMap::new(),
            swap_offers: BTreeMap::new(),
            pending_cross_pull_close_ids: BTreeSet::new(),
            dispute: None,
        }
    }

    #[test]
    fn created_account_unsafe_frame_reaches_a_typed_disposition_seam() {
        let account_id = AccountId::from_bytes([0x11; 32]);
        let account = format!("0x{}", hex::encode(account_id.as_bytes()));
        let dispositions = collect_unsafe_account_frames(
            &[dispute_row(account_id, 1, "unsafe genesis")],
            &BTreeSet::from([account]),
            |id| format!("0x{}", hex::encode(id.as_bytes())),
        );

        assert!(
            matches!(
                dispositions.as_slice(),
                [UnsafeAccountFrameDisposition::CreatedAccountRejected { message }]
                    if message == "⚠️ Rejected uncommitted account genesis from 11111111"
            ),
            "created unsafe genesis must survive as the exact TS event-only disposition"
        );
    }

    #[test]
    fn same_account_unsafe_frames_preserve_one_prepare_dispute_per_input_in_order() {
        let account_id = AccountId::from_bytes([0x22; 32]);
        let account = format!("0x{}", hex::encode(account_id.as_bytes()));
        let frames = vec![
            UnsafeAccountFrame {
                account_id,
                reason: "first unsafe frame".into(),
                evidence_secrets: Vec::new(),
                frame_hash: [0x31; 32],
                frame_hanko: vec![0x41],
            },
            UnsafeAccountFrame {
                account_id,
                reason: "second unsafe frame".into(),
                evidence_secrets: Vec::new(),
                frame_hash: [0x32; 32],
                frame_hanko: vec![0x42],
            },
        ];
        let mut state = EntityStateSlice::empty(format!("0x{}", "aa".repeat(32)), 1);
        let effects = consume_unsafe_account_frames(
            &mut state,
            &mut PaybookChanges::default(),
            &frames,
            &BTreeMap::from([(account, empty_view())]),
            &format!("0x{}", "bb".repeat(32)),
        )
        .expect("consume unsafe frames");

        // TypeScript invokes handlePrepareDispute for every unsafe input in input
        // order. The first can queue the dispute; the second must still reach the
        // transition and observe the frame-local lifecycle projection as active.
        assert_eq!(
            effects.local_txs.len(),
            2,
            "same-account unsafe inputs must each reach ordered PrepareDispute handling"
        );
        let descriptions = effects
            .local_txs
            .iter()
            .map(|admitted| match &admitted.tx {
                LocalEntityTx::Financial(LocalEntityFinancialTx::PrepareDispute(tx)) => {
                    tx.description.as_deref()
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            descriptions,
            vec![Some("first unsafe frame"), Some("second unsafe frame")]
        );
    }
}
