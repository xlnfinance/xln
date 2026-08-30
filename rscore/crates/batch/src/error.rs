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
    #[error("RSCORE_BATCH_RESIDENT_RESULT_POSITION:{position}:count={count}")]
    ResidentResultPosition { position: usize, count: usize },
    #[error("RSCORE_BATCH_RESIDENT_RESULT_POSITION_DUPLICATE:{position}")]
    ResidentResultPositionDuplicate { position: usize },
    #[error("RSCORE_BATCH_RESIDENT_CHECKPOINT_ACCOUNT_REMOVED:{0}")]
    ResidentCheckpointAccountRemoved(AccountId),
    #[error("RSCORE_BATCH_ACCOUNT_DUPLICATE:{0}")]
    DuplicateAccount(AccountId),
    #[error("RSCORE_BATCH_EMPTY")]
    EmptyBatch,
    #[error("RSCORE_BATCH_FINANCIAL_VIEW:{0}")]
    FinancialView(String),
    #[error("RSCORE_BATCH_OPERATION_INDEX:{actual}:after={after:?}")]
    OperationIndex { actual: u64, after: Option<u64> },
    #[error("RSCORE_BATCH_BOARD_AUTHORITY_UNRESOLVED")]
    BoardAuthorityUnresolved,
    #[error("RSCORE_BATCH_ACCOUNT_NOT_FOUND:{input_index}:{account_id}")]
    AccountNotFound {
        input_index: u32,
        account_id: AccountId,
    },
    #[error("RSCORE_BATCH_TRANSITION:{input_index}:{source}")]
    Transition {
        input_index: u32,
        source: TransitionError,
    },
    #[error("RSCORE_BATCH_CANDIDATE_ACCOUNT_NOT_FOUND:{0}")]
    CandidateAccountNotFound(AccountId),
    #[error("RSCORE_BATCH_REVISION_OVERFLOW")]
    RevisionOverflow,
    #[error("RSCORE_BATCH_CANDIDATE_ATTEMPT_OVERFLOW")]
    CandidateAttemptOverflow,
    /// An Entity's group naming an account owned by someone else. The account
    /// says who owns it; the group is not trusted to.
    #[error("RSCORE_BATCH_WAVE_ACCOUNT_OWNER:{account_id}:{entity_id}")]
    WaveAccountOwner {
        account_id: AccountId,
        entity_id: String,
    },
    #[error("RSCORE_BATCH_WAVE_CREATE_EXISTING:{0}")]
    WaveCreateExisting(AccountId),
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
    #[error("RSCORE_BATCH_ENTITY_ROUND_OPEN")]
    EntityRoundOpen,
    #[error("RSCORE_BATCH_ENTITY_ROUND_MISSING")]
    EntityRoundMissing,
    #[error("RSCORE_BATCH_ENTITY_ROUND_OWNER:{actual}:{expected}")]
    EntityRoundOwner { actual: String, expected: String },
    #[error("RSCORE_BATCH_ENTITY_INBOUND_POST_ACCOUNTS")]
    EntityInboundPostAccounts,
    #[error("RSCORE_BATCH_HTLC_FOLLOWUP_UNMATCHED:{account_id}:{hashlock}")]
    HtlcFollowupUnmatched {
        account_id: AccountId,
        hashlock: String,
    },
    #[error("RSCORE_BATCH_HTLC_FOLLOWUP_TX:{account_id}:{hashlock}")]
    HtlcFollowupTx {
        account_id: AccountId,
        hashlock: String,
    },
    #[error("RSCORE_BATCH_HTLC_FOLLOWUP_CASCADE:{account_id}:{hashlock}")]
    HtlcFollowupCascade {
        account_id: AccountId,
        hashlock: String,
    },
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
