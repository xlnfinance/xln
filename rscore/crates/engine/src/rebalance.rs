//! Bilateral rebalance fee policies.
//!
//! One register per token holding each side's latest published fee terms. The
//! Account frame proposer owns its own half, so the two sides never contend
//! for the same slot. Parity target: the TypeScript handler at
//! `core/account/tx/handlers/rebalance/policy.ts`.

use num_bigint::BigInt;
use xln_rscore_protocol::CanonicalValue;

use crate::delta::MAX_TOKEN_ID;
use crate::mutation::MutationDecision;
use crate::{AccountRejection, AccountReplica, Side, TokenId, TransitionError, ValidationRejection};

const MAX_LIQUIDITY_FEE_BPS: i64 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RebalanceFeePolicySnapshot {
    policy_version: u32,
    base_fee: BigInt,
    liquidity_fee_bps: BigInt,
    gas_fee: BigInt,
    updated_at: u64,
}

impl RebalanceFeePolicySnapshot {
    pub const fn new(
        policy_version: u32,
        base_fee: BigInt,
        liquidity_fee_bps: BigInt,
        gas_fee: BigInt,
        updated_at: u64,
    ) -> Self {
        Self {
            policy_version,
            base_fee,
            liquidity_fee_bps,
            gas_fee,
            updated_at,
        }
    }

    pub const fn policy_version(&self) -> u32 {
        self.policy_version
    }

    /// Terms only — `updatedAt` is deliberately excluded, so an exact retry of
    /// the same version at a later timestamp reads as a retry, not as
    /// equivocation. Mirrors `sameTerms` in the TypeScript handler.
    fn same_terms(&self, base_fee: &BigInt, liquidity_fee_bps: &BigInt, gas_fee: &BigInt) -> bool {
        &self.base_fee == base_fee
            && &self.liquidity_fee_bps == liquidity_fee_bps
            && &self.gas_fee == gas_fee
    }

    fn canonical(&self) -> CanonicalValue {
        CanonicalValue::Object(vec![
            (
                "policyVersion".into(),
                CanonicalValue::Number(f64::from(self.policy_version)),
            ),
            (
                "baseFee".into(),
                CanonicalValue::BigInt(self.base_fee.clone()),
            ),
            (
                "liquidityFeeBps".into(),
                CanonicalValue::BigInt(self.liquidity_fee_bps.clone()),
            ),
            ("gasFee".into(), CanonicalValue::BigInt(self.gas_fee.clone())),
            (
                "updatedAt".into(),
                CanonicalValue::Number(self.updated_at as f64),
            ),
        ])
    }
}

/// Both sides' registers for one token. An absent side is omitted from the
/// commitment, exactly as TypeScript drops undefined object keys before
/// encoding.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BilateralRebalanceFeePolicy {
    left: Option<RebalanceFeePolicySnapshot>,
    right: Option<RebalanceFeePolicySnapshot>,
}

impl BilateralRebalanceFeePolicy {
    pub const fn new(
        left: Option<RebalanceFeePolicySnapshot>,
        right: Option<RebalanceFeePolicySnapshot>,
    ) -> Self {
        Self { left, right }
    }

    pub const fn side(&self, side: Side) -> Option<&RebalanceFeePolicySnapshot> {
        match side {
            Side::Left => self.left.as_ref(),
            Side::Right => self.right.as_ref(),
        }
    }

    fn with_side(&self, side: Side, snapshot: RebalanceFeePolicySnapshot) -> Self {
        let mut next = self.clone();
        match side {
            Side::Left => next.left = Some(snapshot),
            Side::Right => next.right = Some(snapshot),
        }
        next
    }

    pub(crate) fn canonical(&self) -> CanonicalValue {
        let mut fields = Vec::with_capacity(2);
        if let Some(left) = &self.left {
            fields.push(("left".into(), left.canonical()));
        }
        if let Some(right) = &self.right {
            fields.push(("right".into(), right.canonical()));
        }
        CanonicalValue::Object(fields)
    }
}

pub(crate) struct RebalancePolicyTx<'a> {
    pub token_id: u32,
    pub policy_version: u32,
    pub base_fee: &'a BigInt,
    pub liquidity_fee_bps: &'a BigInt,
    pub gas_fee: &'a BigInt,
}

pub(crate) fn apply_policy(
    replica: &mut AccountReplica,
    tx: RebalancePolicyTx<'_>,
    proposer: Side,
    committed_timestamp: u64,
) -> Result<MutationDecision, TransitionError> {
    let RebalancePolicyTx {
        token_id,
        policy_version,
        base_fee,
        liquidity_fee_bps,
        gas_fee,
    } = tx;
    if token_id == 0 || token_id > MAX_TOKEN_ID {
        return Ok(rejected(ValidationRejection::RebalancePolicyTokenId { token_id }));
    }
    if policy_version == 0 {
        return Ok(rejected(ValidationRejection::RebalancePolicyVersion {
                version: policy_version,
            }));
    }
    if committed_timestamp == 0 {
        return Ok(rejected(ValidationRejection::RebalancePolicyTimestamp));
    }
    let zero = BigInt::from(0);
    if base_fee < &zero
        || gas_fee < &zero
        || liquidity_fee_bps < &zero
        || liquidity_fee_bps > &BigInt::from(MAX_LIQUIDITY_FEE_BPS)
    {
        return Ok(rejected(ValidationRejection::RebalancePolicyFeeTerms { token_id }));
    }
    // The token id is already inside the accepted range, so this cannot widen
    // the delta key space.
    let token = TokenId::new(token_id)?;
    if replica.state().delta(token).is_none() {
        return Ok(rejected(ValidationRejection::RebalancePolicyMissingDelta { token_id }));
    }

    let register = replica.state().rebalance_policy(token).cloned();
    let current = register.as_ref().and_then(|entry| entry.side(proposer));
    if let Some(current) = current {
        if policy_version < current.policy_version {
            return Ok(MutationDecision::applied(vec![format!(
                "rebalance_policy: stale v{policy_version} ignored"
            )]));
        }
        if policy_version == current.policy_version {
            if !current.same_terms(base_fee, liquidity_fee_bps, gas_fee) {
                return Ok(rejected(ValidationRejection::RebalancePolicyEquivocation {
                        side: proposer,
                        token_id,
                        version: policy_version,
                    }));
            }
            return Ok(MutationDecision::applied(vec![format!(
                "rebalance_policy: exact v{policy_version} retry"
            )]));
        }
    }

    let next = RebalanceFeePolicySnapshot::new(
        policy_version,
        base_fee.clone(),
        liquidity_fee_bps.clone(),
        gas_fee.clone(),
        committed_timestamp,
    );
    let updated = register
        .unwrap_or_default()
        .with_side(proposer, next);
    replica.state_mut().put_rebalance_policy(token, updated)?;
    let side = if proposer == Side::Left {
        "left"
    } else {
        "right"
    };
    Ok(MutationDecision::applied(vec![format!(
        "rebalance_policy: {side} published v{policy_version} token={token_id}"
    )]))
}

fn rejected(reason: ValidationRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(reason))
}
