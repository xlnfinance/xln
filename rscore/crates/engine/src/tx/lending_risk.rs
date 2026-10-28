//! Before/after unsecured exposure, including the maximum promised coupon.
use crate::{AccountReplica, Side, StateError};
use num_bigint::BigInt;
use std::collections::BTreeMap;
pub(crate) type Risk = BTreeMap<(u16, bool), (BigInt, BigInt, BigInt)>;
pub(crate) fn risk(a: &AccountReplica) -> Result<Risk, StateError> {
    let mut result = Risk::new();
    let claims = a.state().lending_claims()?;
    for d in super::handlers::settlement::lending_risk_deltas(a)? {
        for side in [Side::Left, Side::Right] {
            let left = side == Side::Left;
            let mut total = d.ondelta() + d.offdelta();
            let outgoing = d.allowance(side) + d.hold(side);
            total += if left { -outgoing } else { outgoing };
            for (_, c) in &claims {
                if c.token_id != u32::from(d.token_id().get()) {
                    continue;
                }
                let amount = if c.creditor_is_left == left {
                    c.principal.clone()
                } else {
                    c.maximum()
                };
                total += if c.creditor_is_left { amount } else { -amount };
            }
            let owned = if left {
                total.clone()
            } else {
                d.collateral() - &total
            };
            let debt = (-&owned).max(0.into());
            let collateral = owned.max(0.into()).min(d.collateral().clone());
            let limit = if left {
                d.left_credit_limit()
            } else {
                d.right_credit_limit()
            };
            result.insert(
                (d.token_id().get(), left),
                (debt.clone(), limit.clone(), limit + collateral - debt),
            );
        }
    }
    Ok(result)
}
pub(crate) fn admission(before: &Risk, after: &Risk) -> Option<String> {
    let tokens = after
        .keys()
        .map(|(token, _)| *token)
        .collect::<std::collections::BTreeSet<_>>();
    for token in &tokens {
        for left in [&true, &false] {
            let Some((debt, limit, _)) = after.get(&(*token, *left)) else {
                continue;
            };
            let previous = before
                .get(&(*token, *left))
                .map(|v| v.0.clone())
                .unwrap_or_default();
            if debt > limit && *debt > previous {
                return Some(format!(
                    "LENDING_CREDIT_EXPOSURE_EXCEEDED:token={token}:side={}:risk={debt}:limit={limit}",
                    if *left { "left" } else { "right" }
                ));
            }
        }
    }
    None
}
