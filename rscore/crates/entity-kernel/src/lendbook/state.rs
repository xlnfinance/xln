use crate::EntityKernelError;
use xln_rscore_protocol::CanonicalValue;

/// No Rust lending state is representable until the canonical TS bank model
/// is implemented. In particular, an empty retired pool book is not supported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LendingState {}

pub fn canonical_lending_state(state: &LendingState) -> Result<CanonicalValue, EntityKernelError> {
    match *state {}
}
