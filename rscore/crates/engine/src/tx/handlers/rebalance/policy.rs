//! Bilateral rebalance fee policies.
//!
//! One register per token holding each side's latest published fee terms. The
//! Account frame proposer owns its own half, so the two sides never contend
//! for the same slot. Parity target: the TypeScript handler at
//! `core/account/tx/handlers/rebalance/policy.ts`.

use num_bigint::BigInt;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::state::delta::MAX_TOKEN_ID;
use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountRejection, AccountReplica, Side, StateError, TokenId, TransitionError,
    ValidationRejection,
};

const MAX_LIQUIDITY_FEE_BPS: i64 = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RebalanceFeePolicySnapshot {
    policy_version: u64,
    base_fee: BigInt,
    liquidity_fee_bps: BigInt,
    gas_fee: BigInt,
    updated_at: u64,
    notice_period_seconds: u64,
    effective_at: u64,
    previous: Option<Box<Self>>,
}

impl RebalanceFeePolicySnapshot {
    pub const fn new(
        policy_version: u64,
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
            notice_period_seconds: 2_592_000,
            effective_at: updated_at,
            previous: None,
        }
    }

    pub fn with_notice(mut self, seconds: u64, effective_at: u64, previous: Option<Self>) -> Self {
        self.notice_period_seconds = seconds;
        self.effective_at = effective_at;
        self.previous = previous.map(Box::new);
        self
    }
    pub const fn notice_period_seconds(&self) -> u64 {
        self.notice_period_seconds
    }
    pub const fn effective_at(&self) -> u64 {
        self.effective_at
    }
    pub fn previous(&self) -> Option<&Self> {
        self.previous.as_deref()
    }
    pub fn effective(&self, timestamp: u64) -> &Self {
        if timestamp < self.effective_at {
            self.previous().unwrap_or(self)
        } else {
            self
        }
    }
    pub fn notice_is_valid(&self) -> bool {
        if !(1..=9_007_199_254_740).contains(&self.notice_period_seconds)
            || self.effective_at < self.updated_at
        {
            return false;
        }
        match self.previous() {
            None => self.effective_at == self.updated_at,
            Some(old) => {
                old.previous().is_none()
                    && old.notice_is_valid()
                    && old.policy_version < self.policy_version
                    && old.updated_at <= self.updated_at
                    && self
                        .updated_at
                        .checked_add(old.notice_period_seconds * 1000)
                        .is_some_and(|earliest| self.effective_at >= earliest)
            }
        }
    }
    fn terms_canonical(&self) -> Result<CanonicalValue, StateError> {
        let mut value = self.canonical()?;
        if let CanonicalValue::Object(ref mut fields) = value {
            fields.retain(|(name, _)| name != "effectiveAt" && name != "previous");
        }
        Ok(value)
    }
    pub const fn policy_version(&self) -> u64 {
        self.policy_version
    }

    pub const fn base_fee(&self) -> &BigInt {
        &self.base_fee
    }

    pub const fn liquidity_fee_bps(&self) -> &BigInt {
        &self.liquidity_fee_bps
    }

    pub const fn gas_fee(&self) -> &BigInt {
        &self.gas_fee
    }

    pub const fn updated_at(&self) -> u64 {
        self.updated_at
    }

    /// Terms only — `updatedAt` is deliberately excluded, so an exact retry of
    /// the same version at a later timestamp reads as a retry, not as
    /// equivocation. Mirrors `sameTerms` in the TypeScript handler.
    fn same_terms(&self, base_fee: &BigInt, liquidity_fee_bps: &BigInt, gas_fee: &BigInt) -> bool {
        &self.base_fee == base_fee
            && &self.liquidity_fee_bps == liquidity_fee_bps
            && &self.gas_fee == gas_fee
    }

    pub fn canonical(&self) -> Result<CanonicalValue, StateError> {
        let number = |value| {
            CanonicalNumber::try_from_u64(value)
                .map(CanonicalValue::Number)
                .map_err(|error| StateError::AccountStateRoot(error.to_string()))
        };
        let mut fields = vec![
            ("policyVersion".into(), number(self.policy_version)?),
            (
                "baseFee".into(),
                CanonicalValue::BigInt(self.base_fee.clone()),
            ),
            (
                "liquidityFeeBps".into(),
                CanonicalValue::BigInt(self.liquidity_fee_bps.clone()),
            ),
            (
                "gasFee".into(),
                CanonicalValue::BigInt(self.gas_fee.clone()),
            ),
            ("updatedAt".into(), number(self.updated_at)?),
            (
                "noticePeriodSeconds".into(),
                number(self.notice_period_seconds)?,
            ),
            ("effectiveAt".into(), number(self.effective_at)?),
        ];
        if let Some(previous) = self.previous() {
            fields.push(("previous".into(), previous.terms_canonical()?));
        }
        Ok(CanonicalValue::Object(fields))
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

    pub(crate) fn canonical(&self) -> Result<CanonicalValue, StateError> {
        let mut fields = Vec::with_capacity(2);
        if let Some(left) = &self.left {
            fields.push(("left".into(), left.canonical()?));
        }
        if let Some(right) = &self.right {
            fields.push(("right".into(), right.canonical()?));
        }
        Ok(CanonicalValue::Object(fields))
    }
}

pub(crate) struct RebalancePolicyTx<'a> {
    pub token_id: u32,
    pub policy_version: u64,
    pub base_fee: &'a BigInt,
    pub liquidity_fee_bps: &'a BigInt,
    pub notice_period_seconds: Option<u64>,
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
        notice_period_seconds,
    } = tx;
    let notice_period_seconds = notice_period_seconds.unwrap_or(2_592_000);
    if !(1..=9_007_199_254_740).contains(&notice_period_seconds) {
        return Ok(super::reject("rebalance_policy: invalid notice period"));
    }
    if token_id == 0 || token_id > MAX_TOKEN_ID {
        return Ok(rejected(ValidationRejection::RebalancePolicyTokenId {
            token_id,
        }));
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
    // Parity target: handleRebalancePolicy (core/account/tx/handlers/
    // rebalance/policy.ts). Both fees are peer-chosen token amounts; above
    // uint256 they would only fail later at the Account leaf size limit.
    let max_amount = (BigInt::from(1) << 256) - 1;
    if base_fee < &zero
        || base_fee > &max_amount
        || gas_fee < &zero
        || gas_fee > &max_amount
        || liquidity_fee_bps < &zero
        || liquidity_fee_bps > &BigInt::from(MAX_LIQUIDITY_FEE_BPS)
    {
        return Ok(rejected(ValidationRejection::RebalancePolicyFeeTerms {
            token_id,
        }));
    }
    // The token id is already inside the accepted range, so this cannot widen
    // the delta key space.
    let token = TokenId::new(token_id)?;
    if replica.state().delta(token).is_none() {
        return Ok(rejected(ValidationRejection::RebalancePolicyMissingDelta {
            token_id,
        }));
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
            if !current.same_terms(base_fee, liquidity_fee_bps, gas_fee)
                || current.notice_period_seconds != notice_period_seconds
            {
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

    let active = current.map(|policy| policy.effective(committed_timestamp));
    let worse = active.is_some_and(|old| {
        base_fee > old.base_fee()
            || gas_fee > old.gas_fee()
            || liquidity_fee_bps > old.liquidity_fee_bps()
            || notice_period_seconds < old.notice_period_seconds()
    });
    let effective_at = committed_timestamp.checked_add(if worse {
        active.unwrap().notice_period_seconds() * 1000
    } else {
        0
    });
    let Some(effective_at) = effective_at.filter(|value| *value <= 9_007_199_254_740_991) else {
        return Ok(super::reject("rebalance_policy: invalid effectiveAt"));
    };
    let previous = if worse {
        active.map(|old| {
            let mut old = old.clone();
            old.previous = None;
            old.effective_at = old.updated_at;
            old
        })
    } else {
        None
    };
    let next = RebalanceFeePolicySnapshot::new(
        policy_version,
        base_fee.clone(),
        liquidity_fee_bps.clone(),
        gas_fee.clone(),
        committed_timestamp,
    )
    .with_notice(notice_period_seconds, effective_at, previous);
    let updated = register.unwrap_or_default().with_side(proposer, next);
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

#[cfg(test)]
mod notice_tests {
    use super::*;

    #[test]
    fn committed_notice_selects_the_previous_terms_until_the_exact_deadline() {
        let old = RebalanceFeePolicySnapshot::new(1, 10.into(), 1.into(), 0.into(), 1000)
            .with_notice(2, 1000, None);
        let next = RebalanceFeePolicySnapshot::new(2, 30.into(), 1.into(), 0.into(), 2000)
            .with_notice(1, 4000, Some(old));
        assert!(next.notice_is_valid());
        let forged = next.clone().with_notice(1, 3999, next.previous().cloned());
        assert!(!forged.notice_is_valid());
        assert_eq!(next.effective(3999).policy_version(), 1);
        assert_eq!(next.effective(3999).notice_period_seconds(), 2);
        assert_eq!(next.effective(4000).policy_version(), 2);
        assert_eq!(next.effective(4000).notice_period_seconds(), 1);
        let CanonicalValue::Object(fields) = next.canonical().unwrap() else {
            panic!("policy object")
        };
        assert!(fields.iter().any(|(name, _)| name == "previous"));
        assert!(fields.iter().any(|(name, _)| name == "effectiveAt"));
    }
}
