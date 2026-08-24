use std::panic::{AssertUnwindSafe, catch_unwind};

use xln_rscore_engine::{
    AccountReplica, AccountTransition, AccountTx, AccountVerdict, SequentialAccountEngine,
};

use crate::types::ReplicaFingerprint;
use crate::{AccountId, BatchError, BatchJob, BatchVerdict, IndexedOutput, IndexedResult};

pub(crate) struct AccountWork<'a> {
    pub account_id: AccountId,
    pub base_fingerprint: ReplicaFingerprint,
    pub base: &'a AccountReplica,
    pub jobs: Vec<&'a BatchJob>,
}

pub(crate) struct AccountExecution {
    pub account_id: AccountId,
    pub base_fingerprint: ReplicaFingerprint,
    pub candidate: Option<AccountReplica>,
    pub results: Vec<IndexedResult>,
    pub outputs: Vec<IndexedOutput>,
}

pub(crate) fn execute_account_caught(
    work: AccountWork<'_>,
) -> Result<AccountExecution, BatchError> {
    let account_id = work.account_id;
    let input_index = work.jobs.first().map_or(0, |job| job.input_index);
    catch_unwind(AssertUnwindSafe(|| execute_account(work))).unwrap_or(Err(
        BatchError::EnginePanic {
            input_index,
            account_id,
        },
    ))
}

pub(crate) fn execute_account(work: AccountWork<'_>) -> Result<AccountExecution, BatchError> {
    let mut candidate = work.base.clone();
    let mut changed = false;
    let mut results = Vec::with_capacity(work.jobs.len());
    let mut outputs = Vec::new();
    for job in work.jobs {
        let transition = apply_job_caught(&candidate, job)?;
        let events = transition.events().to_vec();
        let verdict = transition.verdict().clone();
        let batch_verdict = match verdict {
            AccountVerdict::Applied => {
                append_outputs(&mut outputs, job, transition.outputs())?;
                candidate = transition
                    .committed()
                    .ok_or(BatchError::AppliedWithoutCandidate(job.input_index))?;
                changed = true;
                BatchVerdict::Applied
            }
            AccountVerdict::Rejected(rejection) => {
                if !transition.outputs().is_empty() {
                    return Err(BatchError::RejectedWithOutputs {
                        input_index: job.input_index,
                        actual: transition.outputs().len(),
                    });
                }
                BatchVerdict::Rejected(rejection)
            }
        };
        results.push(IndexedResult {
            input_index: job.input_index,
            account_id: job.account_id,
            verdict: batch_verdict,
            events,
        });
    }
    Ok(AccountExecution {
        account_id: work.account_id,
        base_fingerprint: work.base_fingerprint,
        candidate: changed.then_some(candidate),
        results,
        outputs,
    })
}

fn apply_job_caught(
    candidate: &AccountReplica,
    job: &BatchJob,
) -> Result<AccountTransition, BatchError> {
    let attempted = catch_unwind(AssertUnwindSafe(|| {
        SequentialAccountEngine::apply_with_context(candidate, job.proposer, &job.tx, &job.context)
    }))
    .map_err(|_| BatchError::EnginePanic {
        input_index: job.input_index,
        account_id: job.account_id,
    })?;
    attempted.map_err(|source| BatchError::Transition {
        input_index: job.input_index,
        source,
    })
}

fn append_outputs(
    indexed: &mut Vec<IndexedOutput>,
    job: &BatchJob,
    outputs: &[xln_rscore_engine::AccountOutput],
) -> Result<(), BatchError> {
    for (position, output) in outputs.iter().enumerate() {
        let output_index =
            u32::try_from(position).map_err(|_| BatchError::OutputIndexOverflow {
                input_index: job.input_index,
                actual: position,
            })?;
        indexed.push(IndexedOutput {
            input_index: job.input_index,
            output_index,
            account_id: job.account_id,
            output: output.clone(),
        });
    }
    Ok(())
}

pub(crate) const fn supported(tx: &AccountTx) -> bool {
    matches!(
        tx,
        AccountTx::AddDelta { .. }
            | AccountTx::SetCreditLimit { .. }
            | AccountTx::DirectPayment { .. }
            | AccountTx::HtlcLock(_)
            | AccountTx::HtlcResolve(_)
            | AccountTx::RebalancePolicy { .. }
            | AccountTx::SwapOffer { .. }
            | AccountTx::SwapCancelRequest { .. }
    )
}

pub(crate) const fn tx_tag(tx: &AccountTx) -> &'static str {
    match tx {
        AccountTx::AddDelta { .. } => "add_delta",
        AccountTx::SetCreditLimit { .. } => "set_credit_limit",
        AccountTx::DirectPayment { .. } => "direct_payment",
        AccountTx::HtlcLock(_) => "htlc_lock",
        AccountTx::HtlcResolve(_) => "htlc_resolve",
        AccountTx::RebalancePolicy { .. } => "rebalance_policy",
        AccountTx::SwapOffer { .. } => "swap_offer",
        AccountTx::SwapCancelRequest { .. } => "swap_cancel_request",
        AccountTx::LendingFund { .. } => "lending_fund",
        AccountTx::LendingBorrowRequest { .. } => "borrow_request",
        AccountTx::LendingRepay { .. } => "repay",
        AccountTx::LendingCredit { .. } => "credit",
        AccountTx::LendingCloseRequest { .. } => "close_request",
        AccountTx::LendingClosePayout { .. } => "close_payout",
        AccountTx::ReserveToCollateral { .. } => "reserve_to_collateral",
    }
}
