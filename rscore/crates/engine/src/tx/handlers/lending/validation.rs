use num_bigint::BigInt;

use crate::{AccountReplica, LendingIntentKind, Side, TransitionError};

pub(super) fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

pub(super) fn require_role(
    replica: &AccountReplica,
    proposer_side: Side,
    role: &'static str,
    claimed_entity_id: &str,
) -> Result<(), TransitionError> {
    let claimed = normalize(claimed_entity_id);
    if !is_entity_id(&claimed) {
        return Err(TransitionError::LendingRoleInvalid {
            role,
            claimed: claimed_entity_id.into(),
        });
    }
    let proposer = replica.state().identity().entity(proposer_side).to_string();
    if claimed != proposer {
        return Err(TransitionError::LendingRoleNotProposer {
            role,
            claimed,
            proposer,
        });
    }
    Ok(())
}

pub(super) fn require_counterparty(
    replica: &AccountReplica,
    proposer: &str,
    counterparty: &str,
) -> Result<(), TransitionError> {
    let proposer = normalize(proposer);
    let identity = replica.state().identity();
    let expected = if proposer == identity.left().to_string() {
        identity.right().to_string()
    } else {
        identity.left().to_string()
    };
    let actual = normalize(counterparty);
    if actual != expected {
        return Err(TransitionError::LendingCounterpartyInvalid { expected, actual });
    }
    Ok(())
}

pub(super) fn require_intent_id(value: &str, expected_prefix: &str) -> Result<(), TransitionError> {
    let normalized = normalize(value);
    let Some((prefix, suffix)) = normalized.split_once('-') else {
        return Err(TransitionError::LendingIntentIdInvalid(value.into()));
    };
    let allowed_prefix = matches!(prefix, "lend" | "borrow" | "loan");
    let valid_suffix = suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !allowed_prefix || prefix != expected_prefix || !valid_suffix {
        return Err(TransitionError::LendingIntentIdInvalid(value.into()));
    }
    Ok(())
}

pub(super) fn positive_amount(
    value: &BigInt,
    context: &'static str,
) -> Result<(), TransitionError> {
    if value <= &BigInt::from(0) {
        return Err(TransitionError::LendingAmountNotPositive { context });
    }
    Ok(())
}

pub(super) fn validate_interest_bps(value: i64) -> Result<(), TransitionError> {
    if !(0..=10_000).contains(&value) {
        return Err(TransitionError::LendingInterestBpsInvalid(value));
    }
    Ok(())
}

pub(super) fn require_unused_intent(
    replica: &AccountReplica,
    key: &str,
) -> Result<(), TransitionError> {
    if replica.state().has_intent(key)? {
        return Err(TransitionError::LendingIntentReplay(key.into()));
    }
    Ok(())
}

pub(super) fn consume_intent(
    replica: &mut AccountReplica,
    key: String,
    kind: LendingIntentKind,
) -> Result<(), TransitionError> {
    require_unused_intent(replica, &key)?;
    replica.state_mut().put_intent(key, kind)?;
    Ok(())
}

fn is_entity_id(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}
