use xln_rscore_batch::{AccountAdmissionResult, AccountAdmissionVerdict};
use xln_rscore_engine::AccountTx;
use xln_rscore_protocol::JS_MAX_SAFE_INTEGER;

use crate::scheduler::ScheduledHookFrame;
use crate::{
    AccountProposalWork, EntityKernelError, EntityStateSlice, OrderedAccountCommit, ScheduledHook,
};

fn cancel_resolved(
    frame: &mut ScheduledHookFrame,
    tx: &AccountTx,
) -> Result<(), EntityKernelError> {
    let AccountTx::HtlcResolve(resolve) = tx else {
        return Ok(());
    };
    frame.remove(&format!("htlc-timeout:{}", resolve.lock_id))
}

/// Mirror committed-frame-followups.ts: a committed resolve makes its local
/// timeout wake obsolete before Entity-produced transactions are admitted.
pub(crate) fn apply_committed_frame_hooks(
    state: &mut EntityStateSlice,
    commits: &[OrderedAccountCommit],
) -> Result<(), EntityKernelError> {
    let Some(crontab) = state.crontab.as_mut() else {
        return Ok(());
    };
    let mut frame = ScheduledHookFrame::default();
    for tx in commits
        .iter()
        .flat_map(|commit| commit.transitions.iter().map(|row| &row.tx))
    {
        cancel_resolved(&mut frame, tx)?;
    }
    frame.commit(&mut crontab.hooks)
}

fn apply_admitted_tx(
    frame: Option<&mut ScheduledHookFrame>,
    account_id: &str,
    tx: &AccountTx,
) -> Result<(), EntityKernelError> {
    let Some(frame) = frame else {
        return Ok(());
    };
    match tx {
        AccountTx::HtlcLock(lock) => {
            let trigger_at = u64::try_from(&lock.timelock)
                .ok()
                .filter(|value| *value <= JS_MAX_SAFE_INTEGER)
                .ok_or_else(|| EntityKernelError::htlc("HTLC_TIMEOUT_UNSAFE"))?;
            frame.put(ScheduledHook::htlc_timeout(
                account_id.to_string(),
                lock.lock_id.clone(),
                trigger_at,
            ))?;
        }
        AccountTx::HtlcResolve(resolve) => {
            frame.remove(&format!("htlc-timeout:{}", resolve.lock_id))?;
        }
        _ => {}
    }
    Ok(())
}

/// Mirror tx-effects.ts only for rows the Account machine actually admitted.
/// Operation indices bind each verdict to its input work item; no positional
/// guess survives a rejected or reordered result.
pub(crate) fn apply_admitted_account_hooks(
    state: &mut EntityStateSlice,
    work: &[AccountProposalWork],
    admissions: &[AccountAdmissionResult],
) -> Result<(), EntityKernelError> {
    if admissions.len() < work.len() {
        return Err(EntityKernelError::htlc("ACCOUNT_ADMISSION_RESULT_MISSING"));
    }
    let mut frame = state
        .crontab
        .as_ref()
        .map(|_| ScheduledHookFrame::default());
    for (index, item) in work.iter().enumerate() {
        let row = &admissions[index];
        let expected_index = u64::try_from(index)
            .map_err(|_| EntityKernelError::htlc("ACCOUNT_ADMISSION_INDEX_OVERFLOW"))?;
        let expected_account = item
            .account_id
            .strip_prefix("0x")
            .unwrap_or(&item.account_id);
        let actual_account = row.account_id.to_string();
        if row.operation_index != expected_index || actual_account != expected_account {
            return Err(EntityKernelError::htlc(
                "ACCOUNT_ADMISSION_BINDING_MISMATCH",
            ));
        }
        match &row.verdict {
            AccountAdmissionVerdict::Admitted { count } if *count == item.txs.len() => {
                for tx in &item.txs {
                    apply_admitted_tx(frame.as_mut(), &item.account_id, tx)?;
                }
            }
            AccountAdmissionVerdict::Admitted { .. } => {
                return Err(EntityKernelError::htlc("ACCOUNT_ADMISSION_COUNT_MISMATCH"));
            }
            AccountAdmissionVerdict::Rejected { .. } => {}
        }
    }
    match (frame, state.crontab.as_mut()) {
        (Some(frame), Some(crontab)) => frame.commit(&mut crontab.hooks),
        (None, None) => Ok(()),
        _ => unreachable!("crontab presence cannot change while applying admitted hooks"),
    }
}
