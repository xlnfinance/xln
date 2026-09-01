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

fn collect_verdict(
    account_id: AccountId,
    verdict: &AccountInputVerdict,
    output: &mut Vec<UnsafeAccountFrame>,
) {
    match verdict {
        AccountInputVerdict::FrameDisputeRequired {
            reason,
            evidence_secrets,
            signed_frame,
        } => output.push(UnsafeAccountFrame {
            account_id,
            reason: reason.clone(),
            evidence_secrets: evidence_secrets.clone(),
            frame_hash: signed_frame.state_hash,
            frame_hanko: signed_frame.frame_hanko.clone(),
        }),
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            collect_verdict(account_id, ack, output);
            collect_verdict(account_id, frame, output);
        }
        _ => {}
    }
}

pub(crate) fn collect_unsafe_account_frames(
    rows: &[AccountInputResult],
    created_accounts: &BTreeSet<String>,
    account_text: impl Fn(AccountId) -> String,
) -> Vec<UnsafeAccountFrame> {
    let mut output = Vec::new();
    for row in rows {
        if created_accounts.contains(&account_text(row.account_id)) {
            continue;
        }
        collect_verdict(row.account_id, &row.verdict, &mut output);
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
    let mut scheduled_accounts = BTreeSet::new();
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
        if scheduled_accounts.insert(frame.account_id) {
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
