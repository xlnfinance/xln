use crate::{AccountReplica, LendingIntentKind, TransitionError};
use num_bigint::BigInt;

pub(super) fn positive_amount(
    value: &BigInt,
    context: &'static str,
) -> Result<(), TransitionError> {
    if value <= &BigInt::from(0) {
        return Err(TransitionError::LendingAmountNotPositive { context });
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
