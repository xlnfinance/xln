//! User-side automatic collateral requests after a bilateral commit.
//!
//! Parity target: `checkAutoRebalance` and `runPostFrameAutoRebalanceCheck`
//! in `core/account/tx/handlers/rebalance/request-collateral.ts` and
//! `core/account/consensus/helpers.ts`.

use num_bigint::BigInt;
use xln_rscore_protocol::CanonicalValue;

use crate::{AccountConsensus, AccountTx, StateError, TokenId};

fn invalid_policy(token_id: u32, field: &str) -> StateError {
    StateError::TransitionFailed(format!(
        "REBALANCE_SHADOW_POLICY_INVALID:{token_id}:{field}"
    ))
}

fn amount(
    fields: &[(String, CanonicalValue)],
    token_id: u32,
    name: &str,
) -> Result<BigInt, StateError> {
    match fields.iter().find(|(field, _)| field == name) {
        Some((_, CanonicalValue::BigInt(value))) => Ok(value.clone()),
        _ => Err(invalid_policy(token_id, name)),
    }
}

fn policy(token_id: u32, value: CanonicalValue) -> Result<(BigInt, BigInt, BigInt), StateError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(invalid_policy(token_id, "object"));
    };
    if fields.len() != 3
        || fields.iter().any(|(name, _)| {
            !matches!(
                name.as_str(),
                "r2cRequestSoftLimit" | "hardLimit" | "maxAcceptableFee"
            )
        })
    {
        return Err(invalid_policy(token_id, "fields"));
    }
    Ok((
        amount(&fields, token_id, "r2cRequestSoftLimit")?,
        amount(&fields, token_id, "hardLimit")?,
        amount(&fields, token_id, "maxAcceptableFee")?,
    ))
}

fn requests(account: &AccountConsensus) -> Result<Vec<AccountTx>, StateError> {
    if account.pending().is_some() || account.replica().state().settlement_workspace().is_some() {
        return Ok(Vec::new());
    }
    let owner_side = account.replica().owner_side();
    let mut requests = Vec::new();
    for (raw_token_id, shadow) in account.replica().envelope().rebalance_shadow_policy_rows() {
        let token_id = TokenId::new(raw_token_id)?;
        let (soft_limit, hard_limit, max_fee) = policy(raw_token_id, shadow)?;
        if soft_limit == hard_limit
            || account
                .replica()
                .state()
                .requested_rebalance(token_id)
                .is_some_and(|amount| amount > &BigInt::from(0_u8))
            || account.mempool().iter().any(|tx| {
                matches!(tx, AccountTx::RequestCollateral { token_id: queued, .. } if *queued == token_id)
            })
        {
            continue;
        }
        let state = account.replica().state();
        let Some(delta) = state.delta(token_id) else {
            continue;
        };
        let Some(fee_policy) = state
            .rebalance_policy(token_id)
            .and_then(|policy| policy.side(owner_side.opposite()))
        else {
            continue;
        };
        let out_peer_credit = delta.perspective(owner_side).out_peer_credit;
        if out_peer_credit < soft_limit {
            continue;
        }
        let fee = fee_policy.base_fee()
            + fee_policy.gas_fee()
            + (&out_peer_credit * fee_policy.liquidity_fee_bps() / BigInt::from(10_000_u32));
        if fee > max_fee || out_peer_credit <= fee {
            continue;
        }
        requests.push(AccountTx::RequestCollateral {
            token_id,
            amount: out_peer_credit,
            fee_token_id: Some(token_id),
            fee_amount: fee,
            policy_version: fee_policy.policy_version(),
        });
    }
    Ok(requests)
}

pub(crate) fn queue_post_commit_auto_rebalance(
    account: &mut AccountConsensus,
    owning_entity_is_hub: bool,
    context: &'static str,
) -> Result<usize, StateError> {
    if owning_entity_is_hub {
        return Ok(0);
    }
    let requests = requests(account)?;
    let expected = requests.len();
    if expected == 0 {
        return Ok(0);
    }
    let admitted = account.admit_txs(requests, context)?;
    if admitted.admitted != expected || admitted.duplicates != 0 || !admitted.rejections.is_empty()
    {
        return Err(StateError::TransitionFailed(format!(
            "AUTO_REBALANCE_ADMISSION_MISMATCH:{expected}:{}:{}:{}",
            admitted.admitted,
            admitted.duplicates,
            admitted.rejections.len()
        )));
    }
    Ok(admitted.admitted)
}
