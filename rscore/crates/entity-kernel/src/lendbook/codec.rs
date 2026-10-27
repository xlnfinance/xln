use super::LendingState;
use crate::EntityKernelError;
use xln_rscore_protocol::CanonicalValue;

pub fn decode_canonical_lending_state(
    _: &CanonicalValue,
) -> Result<LendingState, EntityKernelError> {
    Err(EntityKernelError::SnapshotInvalid {
        detail: "LENDING_UNSUPPORTED_STATE".into(),
    })
}
