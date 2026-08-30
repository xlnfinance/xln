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
    #[error("RSCORE_PROCESS_ENTITY:{0}")]
    Entity(#[from] xln_rscore_entity_kernel::EntityKernelError),
    #[error("RSCORE_PROCESS_J_BATCH:{0}")]
    JBatch(#[from] xln_rscore_entity_kernel::JBatchError),
    #[error("RSCORE_PROCESS_RESIDENT_ENTITY:{0}")]
    ResidentEntity(#[from] xln_rscore_entity_kernel::ResidentEntityError),
    #[error("RSCORE_PROCESS_IO:{0}")]
    Io(#[from] std::io::Error),
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
    #[error("RSCORE_PROCESS_AUTHORITY_REQUIRED")]
    AuthorityRequired,
    #[error("RSCORE_PROCESS_AUTHORITY_TWO_CALL_ONLY")]
    AuthorityTwoCallOnly,
    #[error("RSCORE_PROCESS_ENTITY_ALREADY_LOADED")]
    EntityAlreadyLoaded,
    #[error("RSCORE_PROCESS_ENTITY_NOT_LOADED")]
    EntityNotLoaded,
    #[error("RSCORE_PROCESS_ENTITY_MODE_ONLY")]
    EntityModeOnly,
    #[error("RSCORE_PROCESS_ENTITY_HEAD:{0}")]
    EntityHead(String),
    #[error("RSCORE_PROCESS_PREPARE_WAVE_NONEMPTY:entities={entities}")]
    PrepareWaveNonempty { entities: usize },
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

impl From<xln_rscore_batch::AccountWireEncodeError> for ProcessError {
    fn from(error: xln_rscore_batch::AccountWireEncodeError) -> Self {
        match error {
            xln_rscore_batch::AccountWireEncodeError::Expected(field) => Self::Expected(field),
            xln_rscore_batch::AccountWireEncodeError::Unsupported(detail) => {
                Self::Unsupported(detail)
            }
            xln_rscore_batch::AccountWireEncodeError::State(error) => Self::State(error),
        }
    }
}

impl ProcessError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Abi(_) => "RSCORE_PROCESS_ABI",
            Self::Batch(error) => batch_code(error),
            Self::State(_) => "RSCORE_PROCESS_STATE",
            Self::Htlc(_) => "RSCORE_PROCESS_HTLC",
            Self::Entity(_) => "RSCORE_PROCESS_ENTITY",
            Self::JBatch(_) => "RSCORE_PROCESS_J_BATCH",
            Self::ResidentEntity(_) => "RSCORE_PROCESS_RESIDENT_ENTITY",
            Self::Io(_) => "RSCORE_PROCESS_IO",
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
            Self::AuthorityRequired => "RSCORE_PROCESS_AUTHORITY_REQUIRED",
            Self::AuthorityTwoCallOnly => "RSCORE_PROCESS_AUTHORITY_TWO_CALL_ONLY",
            Self::EntityAlreadyLoaded => "RSCORE_PROCESS_ENTITY_ALREADY_LOADED",
            Self::EntityNotLoaded => "RSCORE_PROCESS_ENTITY_NOT_LOADED",
            Self::EntityModeOnly => "RSCORE_PROCESS_ENTITY_MODE_ONLY",
            Self::EntityHead(_) => "RSCORE_PROCESS_ENTITY_HEAD",
            Self::PrepareWaveNonempty { .. } => "RSCORE_PROCESS_PREPARE_WAVE_NONEMPTY",
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
        BatchError::ResidentWorkerStart { .. } => "RSCORE_BATCH_RESIDENT_WORKER_START",
        BatchError::ResidentWorkerStopped { .. } => "RSCORE_BATCH_RESIDENT_WORKER_STOPPED",
        BatchError::ResidentWorkerReplyMissing => "RSCORE_BATCH_RESIDENT_WORKER_REPLY_MISSING",
        BatchError::ResidentLaneCount { .. } => "RSCORE_BATCH_RESIDENT_LANE_COUNT",
        BatchError::ResidentShardMissing { .. } => "RSCORE_BATCH_RESIDENT_SHARD_MISSING",
        BatchError::ResidentRollbackMissing { .. } => "RSCORE_BATCH_RESIDENT_ROLLBACK_MISSING",
        BatchError::ResidentRollbackPhase { .. } => "RSCORE_BATCH_RESIDENT_ROLLBACK_PHASE",
        BatchError::ResidentWorkerResultCount { .. } => "RSCORE_BATCH_RESIDENT_WORKER_RESULT_COUNT",
        BatchError::ResidentResultPosition { .. } => "RSCORE_BATCH_RESIDENT_RESULT_POSITION",
        BatchError::ResidentResultPositionDuplicate { .. } => {
            "RSCORE_BATCH_RESIDENT_RESULT_POSITION_DUPLICATE"
        }
        BatchError::ResidentCheckpointAccountRemoved(_) => {
            "RSCORE_BATCH_RESIDENT_CHECKPOINT_ACCOUNT_REMOVED"
        }
        BatchError::DuplicateAccount(_) => "RSCORE_BATCH_ACCOUNT_DUPLICATE",
        BatchError::EmptyBatch => "RSCORE_BATCH_EMPTY",
        BatchError::FinancialView(_) => "RSCORE_BATCH_FINANCIAL_VIEW",
        BatchError::OperationIndex { .. } => "RSCORE_BATCH_OPERATION_INDEX",
        BatchError::BoardAuthorityUnresolved => "RSCORE_BATCH_BOARD_AUTHORITY_UNRESOLVED",
        BatchError::AccountNotFound { .. } => "RSCORE_BATCH_ACCOUNT_NOT_FOUND",
        BatchError::Transition { .. } => "RSCORE_BATCH_TRANSITION",
        BatchError::CandidateAccountNotFound(_) => "RSCORE_BATCH_CANDIDATE_ACCOUNT_NOT_FOUND",
        BatchError::RevisionOverflow => "RSCORE_BATCH_REVISION_OVERFLOW",
        BatchError::CandidateAttemptOverflow => "RSCORE_BATCH_CANDIDATE_ATTEMPT_OVERFLOW",
        BatchError::WaveAccountOwner { .. } => "RSCORE_BATCH_WAVE_ACCOUNT_OWNER",
        BatchError::WaveCreateExisting(_) => "RSCORE_BATCH_WAVE_CREATE_EXISTING",
        BatchError::WaveCreateCounterparty { .. } => "RSCORE_BATCH_WAVE_CREATE_COUNTERPARTY",
        BatchError::WaveCreateConsensus(_) => "RSCORE_BATCH_WAVE_CREATE_CONSENSUS",
        BatchError::WaveCreateMempool { .. } => "RSCORE_BATCH_WAVE_CREATE_MEMPOOL",
        BatchError::WaveCreateTransformer(_) => "RSCORE_BATCH_WAVE_CREATE_TRANSFORMER",
        BatchError::WaveCreateEnvelope { .. } => "RSCORE_BATCH_WAVE_CREATE_ENVELOPE",
        BatchError::WaveCreateNonGenesis { .. } => "RSCORE_BATCH_WAVE_CREATE_NON_GENESIS",
        BatchError::EntityRoundOpen => "RSCORE_BATCH_ENTITY_ROUND_OPEN",
        BatchError::EntityRoundMissing => "RSCORE_BATCH_ENTITY_ROUND_MISSING",
        BatchError::EntityRoundOwner { .. } => "RSCORE_BATCH_ENTITY_ROUND_OWNER",
        BatchError::EntityInboundPostAccounts => "RSCORE_BATCH_ENTITY_INBOUND_POST_ACCOUNTS",
        BatchError::HtlcFollowupUnmatched { .. } => "RSCORE_BATCH_HTLC_FOLLOWUP_UNMATCHED",
        BatchError::HtlcFollowupTx { .. } => "RSCORE_BATCH_HTLC_FOLLOWUP_TX",
        BatchError::HtlcFollowupCascade { .. } => "RSCORE_BATCH_HTLC_FOLLOWUP_CASCADE",
        BatchError::InboundGenesis { .. } => "RSCORE_BATCH_INBOUND_GENESIS",
        BatchError::EntityHeadRoot { .. } => "RSCORE_BATCH_ENTITY_HEAD_ROOT",
        BatchError::CheckpointRevision { .. } => "RSCORE_BATCH_CHECKPOINT_REVISION",
        BatchError::CheckpointAccountKey { .. } => "RSCORE_BATCH_CHECKPOINT_ACCOUNT_KEY",
        BatchError::CheckpointIncomplete { .. } => "RSCORE_BATCH_CHECKPOINT_INCOMPLETE",
        BatchError::CheckpointAccountLeaf { .. } => "RSCORE_BATCH_CHECKPOINT_ACCOUNT_LEAF",
        BatchError::CheckpointRoot { .. } => "RSCORE_BATCH_CHECKPOINT_ROOT",
        BatchError::CheckpointSignerDigest { .. } => "RSCORE_BATCH_CHECKPOINT_SIGNER_DIGEST",
        BatchError::SeedRestore { .. } => "RSCORE_BATCH_SEED_RESTORE",
        BatchError::SignerRequired => "RSCORE_BATCH_SIGNER_REQUIRED",
        BatchError::SignerUnknownEntity { .. } => "RSCORE_BATCH_SIGNER_UNKNOWN_ENTITY",
        BatchError::SignerRebind { .. } => "RSCORE_BATCH_SIGNER_REBIND",
        BatchError::Signing(_) => "RSCORE_BATCH_SIGNING",
        BatchError::AccountsTree { .. } => "RSCORE_BATCH_ACCOUNTS_TREE",
    }
}
