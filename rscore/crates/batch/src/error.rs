use thiserror::Error;
use xln_rscore_engine::TransitionError;

use crate::AccountId;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BatchError {
    #[error("RSCORE_BATCH_WORKERS_INVALID:{0}")]
    InvalidWorkerCount(usize),
    #[error("RSCORE_BATCH_THREAD_POOL:{0}")]
    ThreadPoolBuild(String),
    #[error("RSCORE_BATCH_ACCOUNT_DUPLICATE:{0}")]
    DuplicateAccount(AccountId),
    #[error("RSCORE_BATCH_EMPTY")]
    EmptyBatch,
    #[error("RSCORE_BATCH_TOO_LARGE:{actual}:{maximum}")]
    BatchTooLarge { actual: usize, maximum: usize },
    #[error("RSCORE_BATCH_INPUT_INDEX:{actual}:{expected}")]
    InputIndex { actual: u32, expected: u32 },
    #[error("RSCORE_BATCH_ACCOUNT_NOT_FOUND:{input_index}:{account_id}")]
    AccountNotFound {
        input_index: u32,
        account_id: AccountId,
    },
    #[error("RSCORE_BATCH_TX_UNSUPPORTED:{input_index}:{tag}")]
    UnsupportedTx { input_index: u32, tag: &'static str },
    #[error("RSCORE_BATCH_TRANSITION:{input_index}:{source}")]
    Transition {
        input_index: u32,
        source: TransitionError,
    },
    #[error("RSCORE_BATCH_ENGINE_PANIC:{input_index}:{account_id}")]
    EnginePanic {
        input_index: u32,
        account_id: AccountId,
    },
    #[error("RSCORE_BATCH_OUTPUT_INDEX_OVERFLOW:{input_index}:{actual}")]
    OutputIndexOverflow { input_index: u32, actual: usize },
    #[error("RSCORE_BATCH_APPLIED_WITHOUT_CANDIDATE:{0}")]
    AppliedWithoutCandidate(u32),
    #[error("RSCORE_BATCH_REJECTED_WITH_OUTPUTS:{input_index}:{actual}")]
    RejectedWithOutputs { input_index: u32, actual: usize },
    #[error("RSCORE_BATCH_ENGINE_GENERATION_MISMATCH")]
    EngineGenerationMismatch,
    #[error("RSCORE_BATCH_CANDIDATE_ACCOUNT_NOT_FOUND:{0}")]
    CandidateAccountNotFound(AccountId),
    #[error("RSCORE_BATCH_CANDIDATE_BASE_MISMATCH:{0}")]
    CandidateBaseMismatch(AccountId),
    #[error("RSCORE_BATCH_CANDIDATE_FINGERPRINT:{account_id}:{source}")]
    CandidateFingerprint {
        account_id: AccountId,
        source: xln_rscore_engine::StateError,
    },
    #[error("RSCORE_BATCH_CANDIDATE_STALE:{actual}:{expected}")]
    StaleCandidate { actual: u64, expected: u64 },
    #[error("RSCORE_BATCH_REVISION_OVERFLOW")]
    RevisionOverflow,
    /// An account input whose signature does not recover the expected signer.
    ///
    /// Not a transaction rejection: the authority verifies before it hands the
    /// input over, so disagreement here is a divergence between the two
    /// engines (or a forged input) and the whole candidate is refused.
    #[error("RSCORE_BATCH_INPUT_SIGNATURE_INVALID:{input_index}:{account_id}")]
    InputSignatureInvalid {
        input_index: u32,
        account_id: AccountId,
    },
    #[error("RSCORE_BATCH_WAVE_PENDING")]
    WavePending,
    #[error("RSCORE_BATCH_WAVE_MISSING")]
    WaveMissing,
    #[error("RSCORE_BATCH_WAVE_REVISION:{actual}:{expected}")]
    WaveRevision { actual: u64, expected: u64 },
    #[error("RSCORE_BATCH_CHECKPOINT_REVISION:{actual}:{expected}")]
    CheckpointRevision { actual: u64, expected: u64 },
    #[error("RSCORE_BATCH_CHECKPOINT_ACCOUNT_KEY:{width}")]
    CheckpointAccountKey { width: usize },
    #[error("RSCORE_BATCH_CHECKPOINT_INCOMPLETE:{actual}:{expected}")]
    CheckpointIncomplete { actual: usize, expected: usize },
    #[error("RSCORE_BATCH_CHECKPOINT_ACCOUNT_LEAF:{account_id}:{actual}:{expected}")]
    CheckpointAccountLeaf {
        account_id: AccountId,
        actual: String,
        expected: String,
    },
    #[error("RSCORE_BATCH_CHECKPOINT_ROOT:{actual}:{expected}")]
    CheckpointRoot { actual: String, expected: String },
    #[error("RSCORE_BATCH_SIGNER_REQUIRED")]
    SignerRequired,
    #[error("RSCORE_BATCH_SIGNER_UNKNOWN_ENTITY:{entity_id}")]
    SignerUnknownEntity { entity_id: String },
    #[error("RSCORE_BATCH_SIGNING:{0}")]
    Signing(String),
    #[error("RSCORE_BATCH_ACCOUNTS_TREE:{account_id}:{detail}")]
    AccountsTree {
        account_id: AccountId,
        detail: String,
    },
}
