use thiserror::Error;
use xln_rscore_engine::TransitionError;

use crate::AccountId;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BatchError {
    #[error("RSCORE_BATCH_WORKERS_INVALID:{0}")]
    InvalidWorkerCount(usize),
    #[error("RSCORE_BATCH_THREAD_POOL:{0}")]
    ThreadPoolBuild(String),
    #[error("RSCORE_BATCH_RESIDENT_WORKER_START:{worker}:{detail}")]
    ResidentWorkerStart { worker: usize, detail: String },
    #[error("RSCORE_BATCH_RESIDENT_WORKER_STOPPED:{worker}")]
    ResidentWorkerStopped { worker: usize },
    #[error("RSCORE_BATCH_RESIDENT_WORKER_REPLY_MISSING")]
    ResidentWorkerReplyMissing,
    #[error("RSCORE_BATCH_RESIDENT_LANE_COUNT:{actual}:expected={expected}")]
    ResidentLaneCount { actual: usize, expected: usize },
    #[error("RSCORE_BATCH_RESIDENT_SHARD_MISSING:{shard}")]
    ResidentShardMissing { shard: usize },
    #[error("RSCORE_BATCH_RESIDENT_ROLLBACK_MISSING:{phase}")]
    ResidentRollbackMissing { phase: u64 },
    #[error("RSCORE_BATCH_RESIDENT_ROLLBACK_PHASE:{actual}:expected={expected}")]
    ResidentRollbackPhase { actual: u64, expected: u64 },
    #[error("RSCORE_BATCH_RESIDENT_WORKER_RESULT_COUNT:{actual}:expected={expected}")]
    ResidentWorkerResultCount { actual: usize, expected: usize },
    #[error("RSCORE_BATCH_RESIDENT_CHECKPOINT_ACCOUNT_REMOVED:{0}")]
    ResidentCheckpointAccountRemoved(AccountId),
    #[error("RSCORE_BATCH_ACCOUNT_DUPLICATE:{0}")]
    DuplicateAccount(AccountId),
    #[error("RSCORE_BATCH_EMPTY")]
    EmptyBatch,
    #[error("RSCORE_BATCH_TOO_LARGE:{actual}:{maximum}")]
    BatchTooLarge { actual: usize, maximum: usize },
    #[error("RSCORE_BATCH_INPUT_INDEX:{actual}:{expected}")]
    InputIndex { actual: u32, expected: u32 },
    #[error("RSCORE_BATCH_OPERATION_INDEX:{actual}:after={after:?}")]
    OperationIndex { actual: u64, after: Option<u64> },
    #[error("RSCORE_BATCH_BOARD_AUTHORITY_UNRESOLVED")]
    BoardAuthorityUnresolved,
    #[error("RSCORE_BATCH_ACCOUNT_NOT_FOUND:{input_index}:{account_id}")]
    AccountNotFound {
        input_index: u32,
        account_id: AccountId,
    },
    #[error("RSCORE_BATCH_TX_UNSUPPORTED:{input_index}:{tag}")]
    UnsupportedTx { input_index: u32, tag: &'static str },
    /// Settlement proposal eligibility depends on the signed workspace body
    /// and post-commit Hanko drafts. The current payment/swap Account profile
    /// deliberately represents neither; treating a mere presence bit as the
    /// canonical rule would silently propose a frozen transaction.
    #[error("PROPOSABILITY_SETTLEMENT_UNREPRESENTED")]
    ProposabilitySettlementUnrepresented,
    #[error("RSCORE_ACCOUNT_OUTBOUND_DISPUTE_UNSUPPORTED:{0}")]
    OutboundDisputeUnsupported(AccountId),
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
    #[error("RSCORE_BATCH_CANDIDATE_ATTEMPT_OVERFLOW")]
    CandidateAttemptOverflow,
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
    /// Two groups in one wave claiming the same owner Entity, which would give
    /// that Entity two clocks and the wave no single answer about expiry.
    #[error("RSCORE_BATCH_WAVE_ENTITY_DUPLICATE:{entity_id}")]
    WaveEntityDuplicate { entity_id: String },
    #[error("RSCORE_BATCH_WAVE_ENTITY_UNKNOWN:{entity_id}")]
    WaveEntityUnknown { entity_id: String },
    #[error("RSCORE_BATCH_WAVE_ENTITY_NOT_PROPOSER:{entity_id}")]
    WaveEntityNotProposer { entity_id: String },
    #[error("RSCORE_BATCH_WAVE_PROPOSAL_ORDER:{entity_id}")]
    WaveProposalOrder { entity_id: String },
    /// An Entity's group naming an account owned by someone else. The account
    /// says who owns it; the group is not trusted to.
    #[error("RSCORE_BATCH_WAVE_ACCOUNT_OWNER:{account_id}:{entity_id}")]
    WaveAccountOwner {
        account_id: AccountId,
        entity_id: String,
    },
    #[error("RSCORE_BATCH_WAVE_CREATE_EXISTING:{0}")]
    WaveCreateExisting(AccountId),
    #[error("RSCORE_BATCH_WAVE_CREATE_DUPLICATE:{0}")]
    WaveCreateDuplicate(AccountId),
    #[error("RSCORE_BATCH_WAVE_CREATE_AFTER_USE:{0}")]
    WaveCreateAfterUse(AccountId),
    #[error("RSCORE_BATCH_WAVE_CREATE_COUNTERPARTY:{account_id}:{counterparty}")]
    WaveCreateCounterparty {
        account_id: AccountId,
        counterparty: String,
    },
    #[error("RSCORE_BATCH_WAVE_CREATE_CONSENSUS:{0}")]
    WaveCreateConsensus(AccountId),
    #[error("RSCORE_BATCH_WAVE_CREATE_MEMPOOL:{account_id}:{actual}")]
    WaveCreateMempool {
        account_id: AccountId,
        actual: usize,
    },
    #[error("RSCORE_BATCH_WAVE_CREATE_TRANSFORMER:{0}")]
    WaveCreateTransformer(AccountId),
    #[error("RSCORE_BATCH_WAVE_CREATE_ENVELOPE:{account_id}:{detail}")]
    WaveCreateEnvelope {
        account_id: AccountId,
        detail: String,
    },
    #[error("RSCORE_BATCH_WAVE_CREATE_NON_GENESIS:{account_id}:{actual}:{expected}")]
    WaveCreateNonGenesis {
        account_id: AccountId,
        actual: String,
        expected: String,
    },
    #[error("RSCORE_BATCH_WAVE_CREATE_UNUSED:{0}")]
    WaveCreateUnused(AccountId),
    #[error("RSCORE_BATCH_WAVE_PENDING")]
    WavePending,
    #[error("RSCORE_BATCH_WAVE_MISSING")]
    WaveMissing,
    #[error("RSCORE_BATCH_WAVE_OPEN")]
    WaveOpen,
    #[error("RSCORE_BATCH_WAVE_SEALED")]
    WaveSealed,
    #[error("RSCORE_BATCH_ENTITY_ROUND_OPEN")]
    EntityRoundOpen,
    #[error("RSCORE_BATCH_ENTITY_ROUND_MISSING")]
    EntityRoundMissing,
    #[error("RSCORE_BATCH_ENTITY_ROUND_OWNER:{actual}:{expected}")]
    EntityRoundOwner { actual: String, expected: String },
    #[error("RSCORE_BATCH_ENTITY_INBOUND_POST_ACCOUNTS")]
    EntityInboundPostAccounts,
    #[error("RSCORE_BATCH_INBOUND_GENESIS:{account_id}:{detail}")]
    InboundGenesis {
        account_id: AccountId,
        detail: String,
    },
    #[error("RSCORE_BATCH_ENTITY_HEAD_ROOT:{actual}:base={base}:candidate={candidate}")]
    EntityHeadRoot {
        actual: String,
        base: String,
        candidate: String,
    },
    #[error("RSCORE_BATCH_FAILED_HTLC_ROUTE_DUPLICATE:{hashlock}")]
    FailedHtlcRouteDuplicate { hashlock: String },
    #[error("RSCORE_BATCH_FAILED_HTLC_ROUTE_MISMATCH:{hashlock}:{account}:{lock_id}")]
    FailedHtlcRouteMismatch {
        hashlock: String,
        account: String,
        lock_id: String,
    },
    #[error("RSCORE_BATCH_ENTITY_STAGE_OPEN:{0}")]
    EntityStageOpen(crate::StageKey),
    #[error("RSCORE_BATCH_ENTITY_STAGE_MISSING:{0}")]
    EntityStageMissing(crate::StageKey),
    #[error("RSCORE_BATCH_ENTITY_STAGE_KEY:{actual}:{expected}")]
    EntityStageKey {
        actual: crate::StageKey,
        expected: crate::StageKey,
    },
    #[error("RSCORE_BATCH_ENTITY_STAGE_ORDINAL:{actual}:{expected}")]
    EntityStageOrdinal { actual: u64, expected: u64 },
    #[error("RSCORE_BATCH_ENTITY_STAGE_ORDINAL_OVERFLOW")]
    EntityStageOrdinalOverflow,
    #[error("RSCORE_BATCH_ENTITY_STAGE_REPLAY:{key}:{detail}")]
    EntityStageReplay {
        key: crate::StageKey,
        detail: &'static str,
    },
    #[error("RSCORE_BATCH_ENTITY_STAGE_DECISION:{key}:{actual}:{expected}")]
    EntityStageDecisionConflict {
        key: crate::StageKey,
        actual: crate::EntityStageStatus,
        expected: crate::EntityStageStatus,
    },
    #[error("RSCORE_BATCH_ENTITY_STAGE_OWNER:{key}:{actual}:{expected}")]
    EntityStageOwner {
        key: crate::StageKey,
        actual: String,
        expected: String,
    },
    #[error("RSCORE_BATCH_WAVE_REVISION:{actual}:{expected}")]
    WaveRevision { actual: u64, expected: u64 },
    #[error("RSCORE_BATCH_WAVE_CANDIDATE:{actual}:{expected}")]
    WaveCandidate {
        actual: crate::CandidateId,
        expected: crate::CandidateId,
    },
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
    #[error("RSCORE_BATCH_CHECKPOINT_SIGNER_DIGEST:{actual}:{expected}")]
    CheckpointSignerDigest { actual: String, expected: String },
    #[error("RSCORE_BATCH_CHECKPOINT_TOKEN:{actual}:{expected}")]
    CheckpointToken { actual: String, expected: String },
    #[error("RSCORE_BATCH_SEED_RESTORE:{account_id}:{detail}")]
    SeedRestore {
        account_id: AccountId,
        detail: String,
    },
    #[error("RSCORE_BATCH_SIGNER_REQUIRED")]
    SignerRequired,
    #[error("RSCORE_BATCH_SIGNER_UNKNOWN_ENTITY:{entity_id}")]
    SignerUnknownEntity { entity_id: String },
    #[error("RSCORE_BATCH_SIGNER_REBIND:{entity_id}:{actual}:{expected}")]
    SignerRebind {
        entity_id: String,
        actual: String,
        expected: String,
    },
    #[error("RSCORE_BATCH_SIGNING:{0}")]
    Signing(String),
    #[error("RSCORE_BATCH_ACCOUNTS_TREE:{account_id}:{detail}")]
    AccountsTree {
        account_id: AccountId,
        detail: String,
    },
}
