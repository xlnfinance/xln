//! Exact canonical TypeScript-compatible RuntimeFrame encoding.

mod encode;
mod rows;
mod types;
mod validate;
mod value;

pub use encode::build_runtime_frame_commit;
pub use types::{
    AccountAuthorityCheckpointRef, CanonicalRuntimeFrameDraft, CanonicalStateCommitment,
    EncodedRuntimeFrame, RuntimeFrameCodecError, RuntimeFrameEntityHash, RuntimeMachineGraphRoot,
    TouchedAccount, ValidatedRuntimeFrame,
};
pub(crate) use validate::decode_and_validate_runtime_frame;
pub use validate::validate_runtime_frame;
#[cfg(test)]
pub(crate) use validate::{reset_runtime_frame_validation_count, runtime_frame_validation_count};

pub(super) const FRAME_DOMAIN: &str = "xln.storage.frame";
pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
