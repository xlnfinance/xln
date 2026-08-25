use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("RSCORE_PROCESS_ABI:{0}")]
    Abi(#[from] xln_rscore_abi::AbiError),
    #[error("RSCORE_PROCESS_BATCH:{0}")]
    Batch(#[from] xln_rscore_batch::BatchError),
    #[error("RSCORE_PROCESS_STATE:{0}")]
    State(#[from] xln_rscore_engine::StateError),
    #[error("RSCORE_PROCESS_HTLC:{0}")]
    Htlc(#[from] xln_rscore_engine::HtlcBoundaryError),
    #[error("RSCORE_PROCESS_IO:{0}")]
    Io(#[from] std::io::Error),
    #[error("RSCORE_PROCESS_ENTROPY:{0}")]
    Entropy(String),
    #[error("RSCORE_PROCESS_ENVELOPE:{0}")]
    Envelope(String),
    #[error("RSCORE_PROCESS_EXPECTED:{0}")]
    Expected(&'static str),
    #[error("RSCORE_PROCESS_ARITY:{context}:{actual}:{expected}")]
    Arity {
        context: &'static str,
        actual: usize,
        expected: usize,
    },
    #[error("RSCORE_PROCESS_INTEGER:{field}:{value}")]
    Integer { field: &'static str, value: i128 },
    #[error("RSCORE_PROCESS_BIGINT:{field}:{value}")]
    BigInt { field: &'static str, value: String },
    #[error("RSCORE_PROCESS_TAG:{field}:{value}")]
    Tag { field: &'static str, value: i128 },
    #[error("RSCORE_PROCESS_OP_UNSUPPORTED:{0}")]
    UnsupportedOp(u8),
    #[error("RSCORE_PROCESS_UNSUPPORTED:{0}")]
    Unsupported(String),
    #[error("RSCORE_PROCESS_REQUEST_KIND")]
    RequestKind,
    #[error("RSCORE_PROCESS_HELLO_REQUIRED")]
    HelloRequired,
    #[error("RSCORE_PROCESS_HELLO_DUPLICATE")]
    HelloDuplicate,
    #[error("RSCORE_PROCESS_VERSION:{actual}:{expected}")]
    Version { actual: u64, expected: u64 },
    #[error("RSCORE_PROCESS_PROFILE:{0}")]
    Profile(String),
    #[error("RSCORE_PROCESS_PROTOCOL_VERSION:{actual}:{expected}")]
    ProtocolVersion { actual: u32, expected: u32 },
    #[error("RSCORE_PROCESS_STORAGE_SCHEMA_VERSION:{actual}:{expected}")]
    StorageSchemaVersion { actual: u32, expected: u32 },
    #[error("RSCORE_PROCESS_PROTOCOL_FINGERPRINT:{actual:?}:{expected:?}")]
    ProtocolFingerprint {
        actual: [u8; 32],
        expected: [u8; 32],
    },
    #[error("RSCORE_PROCESS_BINDING_MISMATCH")]
    BindingMismatch,
    #[error("RSCORE_PROCESS_IDENTITY_MISMATCH")]
    IdentityMismatch,
    #[error("RSCORE_PROCESS_REQUEST_ID:{actual}:{expected}")]
    RequestId { actual: u64, expected: u64 },
    #[error("RSCORE_PROCESS_REQUEST_ID_OVERFLOW")]
    RequestIdOverflow,
    #[error("RSCORE_PROCESS_ENGINE_ALREADY_LOADED")]
    EngineAlreadyLoaded,
    #[error("RSCORE_PROCESS_ENGINE_NOT_LOADED")]
    EngineNotLoaded,
    #[error("RSCORE_PROCESS_AUTHORITY_BOOTSTRAP_INVALID:revision={revision}:accounts={accounts}")]
    AuthorityBootstrapInvalid { revision: u64, accounts: usize },
    #[error("RSCORE_PROCESS_AUTHORITY_UPSERT_FORBIDDEN")]
    AuthorityUpsertForbidden,
    #[error("RSCORE_PROCESS_PREPARE_PENDING")]
    PreparePending,
    #[error("RSCORE_PROCESS_PREPARE_NOT_PENDING")]
    PrepareNotPending,
    #[error("RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH")]
    CandidateTokenMismatch,
    #[error("RSCORE_PROCESS_CHECKPOINT_PENDING")]
    CheckpointPending,
    #[error("RSCORE_PROCESS_CHECKPOINT_NOT_PENDING")]
    CheckpointNotPending,
    #[error("RSCORE_PROCESS_STOPPED")]
    Stopped,
    #[error("RSCORE_PROCESS_FRAME_EMPTY")]
    EmptyFrame,
    #[error("RSCORE_PROCESS_FRAME_TOO_LARGE:{actual}:{maximum}")]
    FrameTooLarge { actual: usize, maximum: usize },
    #[error("RSCORE_PROCESS_FRAME_TRUNCATED")]
    TruncatedFrame,
    #[error("RSCORE_PROCESS_EOF_BEFORE_SHUTDOWN")]
    EofBeforeShutdown,
}

impl ProcessError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Abi(_) => "RSCORE_PROCESS_ABI",
            Self::Batch(error) => batch_code(error),
            Self::State(_) => "RSCORE_PROCESS_STATE",
            Self::Htlc(_) => "RSCORE_PROCESS_HTLC",
            Self::Io(_) => "RSCORE_PROCESS_IO",
            Self::Entropy(_) => "RSCORE_PROCESS_ENTROPY",
            Self::Envelope(_) => "RSCORE_PROCESS_ENVELOPE",
            Self::Expected(_) => "RSCORE_PROCESS_EXPECTED",
            Self::Arity { .. } => "RSCORE_PROCESS_ARITY",
            Self::Integer { .. } => "RSCORE_PROCESS_INTEGER",
            Self::BigInt { .. } => "RSCORE_PROCESS_BIGINT",
            Self::Tag { .. } => "RSCORE_PROCESS_TAG",
            Self::UnsupportedOp(_) => "RSCORE_PROCESS_OP_UNSUPPORTED",
            Self::Unsupported(_) => "RSCORE_PROCESS_UNSUPPORTED",
            Self::RequestKind => "RSCORE_PROCESS_REQUEST_KIND",
            Self::HelloRequired => "RSCORE_PROCESS_HELLO_REQUIRED",
            Self::HelloDuplicate => "RSCORE_PROCESS_HELLO_DUPLICATE",
            Self::Version { .. } => "RSCORE_PROCESS_VERSION",
            Self::Profile(_) => "RSCORE_PROCESS_PROFILE",
            Self::ProtocolVersion { .. } => "RSCORE_PROCESS_PROTOCOL_VERSION",
            Self::StorageSchemaVersion { .. } => "RSCORE_PROCESS_STORAGE_SCHEMA_VERSION",
            Self::ProtocolFingerprint { .. } => "RSCORE_PROCESS_PROTOCOL_FINGERPRINT",
            Self::BindingMismatch => "RSCORE_PROCESS_BINDING_MISMATCH",
            Self::IdentityMismatch => "RSCORE_PROCESS_IDENTITY_MISMATCH",
            Self::RequestId { .. } => "RSCORE_PROCESS_REQUEST_ID",
            Self::RequestIdOverflow => "RSCORE_PROCESS_REQUEST_ID_OVERFLOW",
            Self::EngineAlreadyLoaded => "RSCORE_PROCESS_ENGINE_ALREADY_LOADED",
            Self::EngineNotLoaded => "RSCORE_PROCESS_ENGINE_NOT_LOADED",
            Self::AuthorityBootstrapInvalid { .. } => "RSCORE_PROCESS_AUTHORITY_BOOTSTRAP_INVALID",
            Self::AuthorityUpsertForbidden => "RSCORE_PROCESS_AUTHORITY_UPSERT_FORBIDDEN",
            Self::PreparePending => "RSCORE_PROCESS_PREPARE_PENDING",
            Self::PrepareNotPending => "RSCORE_PROCESS_PREPARE_NOT_PENDING",
            Self::CandidateTokenMismatch => "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
            Self::CheckpointPending => "RSCORE_PROCESS_CHECKPOINT_PENDING",
            Self::CheckpointNotPending => "RSCORE_PROCESS_CHECKPOINT_NOT_PENDING",
            Self::Stopped => "RSCORE_PROCESS_STOPPED",
            Self::EmptyFrame => "RSCORE_PROCESS_FRAME_EMPTY",
            Self::FrameTooLarge { .. } => "RSCORE_PROCESS_FRAME_TOO_LARGE",
            Self::TruncatedFrame => "RSCORE_PROCESS_FRAME_TRUNCATED",
            Self::EofBeforeShutdown => "RSCORE_PROCESS_EOF_BEFORE_SHUTDOWN",
        }
    }
}

fn batch_code(error: &xln_rscore_batch::BatchError) -> &'static str {
    use xln_rscore_batch::BatchError;
    match error {
        BatchError::InvalidWorkerCount(_) => "RSCORE_BATCH_WORKERS_INVALID",
        BatchError::ThreadPoolBuild(_) => "RSCORE_BATCH_THREAD_POOL",
        BatchError::DuplicateAccount(_) => "RSCORE_BATCH_ACCOUNT_DUPLICATE",
        BatchError::EmptyBatch => "RSCORE_BATCH_EMPTY",
        BatchError::BatchTooLarge { .. } => "RSCORE_BATCH_TOO_LARGE",
        BatchError::InputIndex { .. } => "RSCORE_BATCH_INPUT_INDEX",
        BatchError::OperationIndex { .. } => "RSCORE_BATCH_OPERATION_INDEX",
        BatchError::AccountNotFound { .. } => "RSCORE_BATCH_ACCOUNT_NOT_FOUND",
        BatchError::UnsupportedTx { .. } => "RSCORE_BATCH_TX_UNSUPPORTED",
        BatchError::Transition { .. } => "RSCORE_BATCH_TRANSITION",
        BatchError::EnginePanic { .. } => "RSCORE_BATCH_ENGINE_PANIC",
        BatchError::OutputIndexOverflow { .. } => "RSCORE_BATCH_OUTPUT_INDEX_OVERFLOW",
        BatchError::AppliedWithoutCandidate(_) => "RSCORE_BATCH_APPLIED_WITHOUT_CANDIDATE",
        BatchError::RejectedWithOutputs { .. } => "RSCORE_BATCH_REJECTED_WITH_OUTPUTS",
        BatchError::EngineGenerationMismatch => "RSCORE_BATCH_ENGINE_GENERATION_MISMATCH",
        BatchError::CandidateAccountNotFound(_) => "RSCORE_BATCH_CANDIDATE_ACCOUNT_NOT_FOUND",
        BatchError::CandidateBaseMismatch(_) => "RSCORE_BATCH_CANDIDATE_BASE_MISMATCH",
        BatchError::CandidateFingerprint { .. } => "RSCORE_BATCH_CANDIDATE_FINGERPRINT",
        BatchError::StaleCandidate { .. } => "RSCORE_BATCH_CANDIDATE_STALE",
        BatchError::RevisionOverflow => "RSCORE_BATCH_REVISION_OVERFLOW",
        BatchError::CandidateAttemptOverflow => "RSCORE_BATCH_CANDIDATE_ATTEMPT_OVERFLOW",
        BatchError::InputSignatureInvalid { .. } => "RSCORE_BATCH_INPUT_SIGNATURE_INVALID",
        BatchError::WaveEntityDuplicate { .. } => "RSCORE_BATCH_WAVE_ENTITY_DUPLICATE",
        BatchError::WaveEntityUnknown { .. } => "RSCORE_BATCH_WAVE_ENTITY_UNKNOWN",
        BatchError::WaveEntityNotProposer { .. } => "RSCORE_BATCH_WAVE_ENTITY_NOT_PROPOSER",
        BatchError::WaveProposalOrder { .. } => "RSCORE_BATCH_WAVE_PROPOSAL_ORDER",
        BatchError::WaveAccountOwner { .. } => "RSCORE_BATCH_WAVE_ACCOUNT_OWNER",
        BatchError::WaveCreateExisting(_) => "RSCORE_BATCH_WAVE_CREATE_EXISTING",
        BatchError::WaveCreateDuplicate(_) => "RSCORE_BATCH_WAVE_CREATE_DUPLICATE",
        BatchError::WaveCreateAfterUse(_) => "RSCORE_BATCH_WAVE_CREATE_AFTER_USE",
        BatchError::WaveCreateCounterparty { .. } => "RSCORE_BATCH_WAVE_CREATE_COUNTERPARTY",
        BatchError::WaveCreateConsensus(_) => "RSCORE_BATCH_WAVE_CREATE_CONSENSUS",
        BatchError::WaveCreateMempool { .. } => "RSCORE_BATCH_WAVE_CREATE_MEMPOOL",
        BatchError::WaveCreateTransformer(_) => "RSCORE_BATCH_WAVE_CREATE_TRANSFORMER",
        BatchError::WaveCreateEnvelope { .. } => "RSCORE_BATCH_WAVE_CREATE_ENVELOPE",
        BatchError::WaveCreateNonGenesis { .. } => "RSCORE_BATCH_WAVE_CREATE_NON_GENESIS",
        BatchError::WaveCreateUnused(_) => "RSCORE_BATCH_WAVE_CREATE_UNUSED",
        BatchError::WavePending => "RSCORE_BATCH_WAVE_PENDING",
        BatchError::WaveMissing => "RSCORE_BATCH_WAVE_MISSING",
        BatchError::WaveOpen => "RSCORE_BATCH_WAVE_OPEN",
        BatchError::WaveSealed => "RSCORE_BATCH_WAVE_SEALED",
        BatchError::WaveRevision { .. } => "RSCORE_BATCH_WAVE_REVISION",
        BatchError::WaveCandidate { .. } => "RSCORE_BATCH_WAVE_CANDIDATE",
        BatchError::CheckpointRevision { .. } => "RSCORE_BATCH_CHECKPOINT_REVISION",
        BatchError::CheckpointAccountKey { .. } => "RSCORE_BATCH_CHECKPOINT_ACCOUNT_KEY",
        BatchError::CheckpointIncomplete { .. } => "RSCORE_BATCH_CHECKPOINT_INCOMPLETE",
        BatchError::CheckpointAccountLeaf { .. } => "RSCORE_BATCH_CHECKPOINT_ACCOUNT_LEAF",
        BatchError::CheckpointRoot { .. } => "RSCORE_BATCH_CHECKPOINT_ROOT",
        BatchError::CheckpointSignerDigest { .. } => "RSCORE_BATCH_CHECKPOINT_SIGNER_DIGEST",
        BatchError::CheckpointToken { .. } => "RSCORE_BATCH_CHECKPOINT_TOKEN",
        BatchError::SeedRestore { .. } => "RSCORE_BATCH_SEED_RESTORE",
        BatchError::SignerRequired => "RSCORE_BATCH_SIGNER_REQUIRED",
        BatchError::SignerUnknownEntity { .. } => "RSCORE_BATCH_SIGNER_UNKNOWN_ENTITY",
        BatchError::SignerRebind { .. } => "RSCORE_BATCH_SIGNER_REBIND",
        BatchError::Signing(_) => "RSCORE_BATCH_SIGNING",
        BatchError::AccountsTree { .. } => "RSCORE_BATCH_ACCOUNTS_TREE",
    }
}
