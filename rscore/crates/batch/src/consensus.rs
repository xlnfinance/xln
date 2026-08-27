//! The authoritative account store: replicas the engine itself drives.
//!
//! The mirror engine in `stateful.rs` applies transitions the runtime already
//! decided. This one owns the accounts instead — their mempools, their frames
//! and their signatures — so a wave costs one message rather than one replica
//! shell per frame. Both keep the same commitment: a radix-16 Patricia tree
//! keyed by account id, leaf digest = the Entity's account leaf.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use rayon::{ThreadPool, ThreadPoolBuilder};
use xln_rscore_engine::{
    AccountConsensus, AccountEnvelope, AccountFrame, AccountIdentity, AccountOutput,
    AccountPeerEnvelope, AccountReplica, AccountState, AccountTx, AckOutcome, BoardDelays,
    BoardHankoRefreshInput, CertifiedBoardAuthority, CommittedFrameEvidence, CounterpartyDispute,
    Disposition, FrameAckOutcome, FrameAckPhase, HtlcResolveOutcome, HtlcResolveTx, IncomingAck,
    IncomingFrame, IncomingFrameSecurityContext, IncomingOutcome, ProposalOutcome, ReceiverClock,
    SignedIncomingFrame, SigningIdentity, StandaloneInputOutcome, StateError,
    apply_board_hanko_refresh, apply_incoming_ack_with_authority,
    apply_incoming_frame_ack_with_authority, apply_incoming_frame_with_authority,
    apply_standalone_dispute, canonical_tx_digest, propose_account_frame,
};
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentNodeRecord, PersistentNodeRef, PersistentRadixMap,
};

use crate::checkpoint::{
    AccountCheckpointRows, AccountRestore, AccountsCheckpoint, CheckpointExpectation,
    CheckpointToken, account_rows,
};
use crate::parallel::map_accounts;
use crate::stateful::MAX_BATCH_WORKERS;
use crate::{AccountId, AccountSeed, BatchError, CandidateId, EngineGeneration};

/// What arrives for one account. `FrameAck` is one canonical wire input whose
/// phases execute ACK-first: a valid ACK commits even if the bundled frame is
/// rejected, matching the TypeScript bilateral machine.
#[derive(Clone, Debug)]
pub enum AccountInputKind {
    Frame(Box<IncomingFrame>),
    Ack(IncomingAck),
    FrameAck {
        ack: IncomingAck,
        frame: Box<IncomingFrame>,
    },
    Dispute(CounterpartyDispute),
    BoardHankoRefresh(BoardHankoRefreshInput),
}

#[derive(Clone, Debug)]
pub struct AccountPeerInput {
    pub envelope: AccountPeerEnvelope,
    pub kind: AccountInputKind,
}

#[derive(Clone, Debug)]
pub struct AccountInputRow {
    pub operation_index: u64,
    pub account_id: AccountId,
    /// Trusted owner policy used only when this exact row is an authenticated
    /// H=1 proposal for an Account absent from the resident forest.
    pub genesis_policy: Option<crate::EntityAccountGenesisPolicy>,
    /// Exact current board hash certified by the parent Entity for the peer.
    /// It is local verification context, never copied from the peer envelope.
    pub certified_board_authority: PeerBoardAuthority,
    /// Exact current/previous board record certified by the parent Entity for
    /// the Account owner. Duplicate-frame ACK reuse authenticates this local
    /// historical Hanko independently of the peer authority above.
    pub local_certified_board_authority: PeerBoardAuthority,
    pub input: AccountPeerInput,
}

/// Parent-resolved board authority for one untrusted peer input.
///
/// `Unresolved` is deliberately distinct from `Lazy`: absence in peer bytes
/// proves nothing about registration. Only the parent Entity registry may
/// turn it into `Lazy` or `Certified`, and Account execution fails loudly if
/// that resolution step was skipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerBoardAuthority {
    Unresolved,
    Lazy,
    Certified(CertifiedBoardAuthority),
}

impl PeerBoardAuthority {
    pub(crate) fn certified(&self) -> Result<Option<&CertifiedBoardAuthority>, BatchError> {
        match self {
            Self::Unresolved => Err(BatchError::BoardAuthorityUnresolved),
            Self::Lazy => Ok(None),
            Self::Certified(authority) => Ok(Some(authority)),
        }
    }
}

/// Parent Entity authority lookup. Implementations resolve only from the
/// Entity-certified registry keyed by the peer; peer AccountInput bytes never
/// participate in this decision.
pub trait CertifiedBoardAuthorityResolver {
    type Error;

    fn resolve_certified_board(
        &self,
        peer_entity_id: &[u8; 32],
    ) -> Result<PeerBoardAuthority, Self::Error>;
}

impl AccountInputRow {
    pub fn resolve_certified_boards<R>(&mut self, resolver: &R) -> Result<(), R::Error>
    where
        R: CertifiedBoardAuthorityResolver,
    {
        self.certified_board_authority =
            resolver.resolve_certified_board(&self.input.envelope.from_entity_id)?;
        self.local_certified_board_authority =
            resolver.resolve_certified_board(&self.input.envelope.to_entity_id)?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub enum AccountInputVerdict {
    FrameCommitted {
        height: u64,
        state_hash: [u8; 32],
        /// Raw owner signature paired with `ack_hanko`, retained only until
        /// the parent Entity builds this Runtime frame's signature manifest.
        ack_signature: [u8; 65],
        ack_hanko: Vec<u8>,
        outputs: Vec<AccountOutput>,
        /// Exactly what the committed transactions said they did. The Entity
        /// frame hashes these strings, so a publisher that re-derived them
        /// would be signing its own guess.
        events: Vec<String>,
        rolled_back: Option<xln_rscore_engine::RolledBackProposal>,
        committed_frame: Box<CommittedFrameEvidence>,
        /// The recovery proof the acknowledgement this frame produced carries,
        /// so the publisher can send it without reading the account back.
        ack_dispute: Option<xln_rscore_engine::DisputeDraft>,
    },
    FrameCollisionIgnored {
        height: u64,
        /// What this side still holds while it waits to be acknowledged. The
        /// publisher names the count in an event the Entity frame commits.
        queued: usize,
    },
    FrameDuplicate {
        height: u64,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
        ack_dispute: Option<xln_rscore_engine::DisputeDraft>,
    },
    FrameStale {
        height: u64,
        current_height: u64,
    },
    FrameDisputeRequired {
        reason: String,
        evidence_secrets: Vec<xln_rscore_engine::HtlcEvidenceSecret>,
        signed_frame: SignedIncomingFrame,
    },
    FrameRejected {
        reason: String,
    },
    AckCommitted {
        height: u64,
        state_hash: [u8; 32],
        outputs: Vec<AccountOutput>,
        /// The pending frame's own events, released on the same ACK as its
        /// outputs.
        events: Vec<String>,
        committed_frame: Box<CommittedFrameEvidence>,
    },
    AckStale {
        height: u64,
    },
    AckRejected {
        reason: String,
    },
    FrameAckApplied {
        ack: Box<AccountInputVerdict>,
        frame: Box<AccountInputVerdict>,
    },
    FrameAckRejected {
        phase: FrameAckPhase,
        reason: String,
    },
    DisputeApplied,
    DisputeRejected {
        reason: String,
    },
    BoardHankoRefreshApplied {
        events: Vec<String>,
    },
    BoardHankoRefreshRejected {
        reason: String,
    },
    /// The account is not in this engine, or its transition faulted. The
    /// runtime decides what to do; the engine never guesses.
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct AccountInputResult {
    pub operation_index: u64,
    pub account_id: AccountId,
    pub verdict: AccountInputVerdict,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountAdmissionVerdict {
    Admitted { count: usize },
    Rejected { code: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountAdmissionResult {
    pub operation_index: u64,
    pub account_id: AccountId,
    pub verdict: AccountAdmissionVerdict,
}

#[derive(Debug)]
/// Everything one runtime frame asks of the accounts.
pub struct WaveRequest {
    /// One group per owner Entity, each with its own clocks and its own work.
    /// The whole wave is still one candidate: prepared together, committed or
    /// aborted together, under one accounts root.
    pub entities: Vec<EntityWave>,
    /// Whether every reply must carry the full checkpoint row of each touched
    /// account.
    ///
    /// This is the account body: its mempool, its trees, its node changes. A
    /// caller that only needs to know what happened — the verdicts, the
    /// outputs, the leaf — must not pay to have the whole account serialized,
    /// shipped and decoded on every operation. Durable checkpointing asks for
    /// the rows explicitly, at the frame boundary, where they belong.
    pub post_accounts: bool,
}

/// One thing the authority did to one account, in the order it did it.
///
/// Measured, not assumed: in a same-jurisdiction swap recording, 10 of 40
/// Runtime frames admit a transaction to an account *after* a peer input for
/// that same account was already applied (payments: 0 of 60). A wave that put
/// every admission ahead of every input would build a different mempool out of
/// identical traffic, and the two engines would sign different frames.
#[derive(Clone, Debug)]
pub enum WaveOp {
    Admit {
        operation_index: u64,
        account_id: AccountId,
        txs: Vec<xln_rscore_engine::AccountTx>,
    },
    Input(Box<AccountInputRow>),
    /// Create the account at financial genesis inside this abortable candidate.
    /// It must be the first operation that names the account; importing a
    /// post-transition seed here would make TypeScript, not Rust, authoritative.
    Create {
        operation_index: u64,
        seed: Box<AccountSeed>,
    },
}

impl WaveOp {
    pub const fn account_id(&self) -> AccountId {
        match self {
            Self::Admit { account_id, .. } => *account_id,
            Self::Input(row) => row.account_id,
            Self::Create { seed, .. } => seed.account_id,
        }
    }

    pub const fn operation_index(&self) -> u64 {
        match self {
            Self::Admit {
                operation_index, ..
            } => *operation_index,
            Self::Input(row) => row.operation_index,
            Self::Create {
                operation_index, ..
            } => *operation_index,
        }
    }
}

/// One Entity's part of a wave: its own clocks, its own ordered work, and its
/// own decision whether to propose.
///
/// A runtime hosts several Entities, and each judges expiry with its own
/// entity timestamp and finalized J height. One clock for the whole runtime
/// frame would settle one Entity's HTLC against a neighbour's J height, which
/// is a divergence no root would catch until the frame was already signed.
#[derive(Clone, Debug)]
pub struct EntityWave {
    /// The Entity that owns every account named in `ops`. Checked against each
    /// account's own owner, never trusted.
    pub owner_entity_id: [u8; 32],
    /// The clock this Entity stamps the frames it proposes with.
    pub timestamp: u64,
    pub j_height: u64,
    /// The clock this Entity judges arrivals with.
    pub clock: ReceiverClock,
    pub ops: Vec<WaveOp>,
    /// Whether this Entity proposes once its work is applied. An Entity that
    /// only wants to drain its inbox says no.
    pub propose: bool,
}

/// The exact Entity clock and proposal policy for one parent Entity input.
///
/// Runtime candidates may consume several Entity inputs before their WAL row
/// is durable. Each input installs its own context only for its abortable
/// stage, so a rejected parent input cannot leave its clock behind for the
/// next accepted input.
#[derive(Clone, Copy, Debug)]
pub struct EntityStageContext {
    pub owner_entity_id: [u8; 32],
    pub timestamp: u64,
    pub j_height: u64,
    pub clock: ReceiverClock,
    pub propose: bool,
}

impl PartialEq for EntityStageContext {
    fn eq(&self, other: &Self) -> bool {
        self.owner_entity_id == other.owner_entity_id
            && self.timestamp == other.timestamp
            && self.j_height == other.j_height
            && self.clock.entity_timestamp == other.clock.entity_timestamp
            && self.clock.finalized_j_height == other.clock.finalized_j_height
            && self.propose == other.propose
    }
}

impl Eq for EntityStageContext {}

/// Stable identity of one parent Entity input inside an abortable Runtime
/// candidate. It is derived by the caller from that exact input, not allocated
/// by transport, so retrying after a lost reply reaches the same stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StageKey([u8; 32]);

impl StageKey {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for StageKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityStageStatus {
    Open,
    Accepted,
    RolledBack,
}

impl fmt::Display for EntityStageStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Open => "open",
            Self::Accepted => "accepted",
            Self::RolledBack => "rolled_back",
        })
    }
}

/// Idempotent acknowledgement of one Entity stage command.
///
/// Begin and rollback return the ordinal they received. Accept returns the
/// next ordinal, which is the value the next distinct Entity stage must name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntityStageReceipt {
    pub key: StageKey,
    pub status: EntityStageStatus,
    pub accepted_stage_ordinal: u64,
}

#[derive(Debug)]
pub struct EntityWaveOps {
    pub owner_entity_id: [u8; 32],
    pub ops: Vec<WaveOp>,
}

#[derive(Debug)]
pub struct WaveOpsRequest {
    pub entities: Vec<EntityWaveOps>,
}

#[derive(Debug)]
pub struct EntityProposalSelection {
    pub owner_entity_id: [u8; 32],
    pub account_ids: Vec<AccountId>,
}

#[derive(Debug)]
pub struct WaveProposalRequest {
    pub entities: Vec<EntityProposalSelection>,
}

/// What the wave produced, against a candidate that is not yet committed.
pub struct WaveResult {
    /// Stable for every stage of this one abortable attempt and different for
    /// every later attempt, even when state and inputs are byte-identical.
    pub candidate_id: CandidateId,
    pub revision: u64,
    pub accounts_root: [u8; 32],
    pub applied: Vec<AccountInputResult>,
    pub admissions: Vec<AccountAdmissionResult>,
    pub proposals: Vec<ProposalRow>,
    /// Every account the wave moved, with the leaf it now commits. The root
    /// alone says that something differs; these say which account does.
    pub touched: Vec<(AccountId, [u8; 32])>,
    /// Checkpoint node-change rows for every touched account this engine still
    /// holds. This is the ten-field incremental checkpoint shape, not the
    /// nine-field materialized `RestoreExact` row; callers must apply its node
    /// changes before using the restore decoder.
    pub post_accounts: Vec<AccountCheckpointRows>,
}

/// The committed store as it was before the wave, kept until the runtime says
/// its own record is durable.
struct PendingWave {
    candidate_id: CandidateId,
    /// Carried from the request: whether replies include account bodies.
    post_accounts: bool,
    base_accounts: PersistentRadixMap<AccountConsensus>,
    base_identities: BTreeMap<[u8; 32], SigningIdentity>,
    base_revision: u64,
    contexts: BTreeMap<[u8; 32], WaveEntityContext>,
    last_operation_index: Option<u64>,
    /// Every account named since this candidate opened. A Create after a
    /// missing input is still a protocol-order bug, even though that input did
    /// not move the forest.
    used_accounts: BTreeSet<AccountId>,
    created_accounts: BTreeSet<AccountId>,
    /// A Create is only the atomic prelude to this frame's first real Account
    /// operation. Letting a bare imported seed reach Seal would make the seed,
    /// not a Rust transition, the authority for a new tree leaf.
    unused_created_accounts: BTreeSet<AccountId>,
    touched: BTreeSet<AccountId>,
    applied: Vec<AccountInputResult>,
    admissions: Vec<AccountAdmissionResult>,
    proposals: Vec<ProposalRow>,
    sealed: bool,
    accepted_stage_ordinal: u64,
    terminal_entity_stages: BTreeMap<StageKey, TerminalEntityStage>,
    entity_stage: Option<EntityStageSavepoint>,
}

#[derive(Clone, Copy)]
struct WaveEntityContext {
    timestamp: u64,
    j_height: u64,
    clock: ReceiverClock,
    propose: bool,
}

/// Everything one parent Entity input is allowed to change inside a held
/// Runtime candidate. The persistent Account forest makes the large fields
/// cheap path-copy snapshots; rollback is an exact pointer-level restoration,
/// not a best-effort inverse transition.
struct EntityStageSavepoint {
    key: StageKey,
    expected_accepted_stage_ordinal: u64,
    context: EntityStageContext,
    accounts: PersistentRadixMap<AccountConsensus>,
    identities: BTreeMap<[u8; 32], SigningIdentity>,
    revision: u64,
    contexts: BTreeMap<[u8; 32], WaveEntityContext>,
    last_operation_index: Option<u64>,
    used_accounts: BTreeSet<AccountId>,
    created_accounts: BTreeSet<AccountId>,
    unused_created_accounts: BTreeSet<AccountId>,
    touched: BTreeSet<AccountId>,
    applied_len: usize,
    admissions_len: usize,
    proposals_len: usize,
}

#[derive(Clone, Copy)]
struct TerminalEntityStage {
    begin_ordinal: u64,
    context: EntityStageContext,
    receipt: EntityStageReceipt,
}

/// One attempt to propose, whether or not it produced a frame. A window where
/// every transaction was rejected still moves the account — the mempool is
/// part of the leaf — so the attempt is reported with no frame rather than
/// not reported at all, or the two engines would silently disagree about a
/// tree they both changed.
#[derive(Clone)]
pub struct ProposalRow {
    pub account_id: AccountId,
    /// Exact Entity-local AccountInput authored by Account consensus. Runtime
    /// may add only the destination signer/runtime route; it must never
    /// reconstruct domain, dispute config, watch seed, ACK or proposal bytes.
    pub outbound_input: Option<AccountPeerInput>,
    /// The signed frame, absent when nothing survived the window.
    ///
    /// It carries no outputs: what the frame produced is released with the
    /// peer's ack, never before.
    pub proposed: Option<ProposedRow>,
    /// Every transaction the window could not include, named by the digest of
    /// its canonical form. A count would say that something was dropped
    /// without saying what, which is not enough to compare two engines.
    pub dropped: Vec<DroppedRow>,
    /// Non-retryable HTLC locks the parent Entity must resolve in this same
    /// Entity frame. The exact hashlock and rejection reason are Account
    /// outputs; the parent must not infer them from a digest or log string.
    pub failed_htlc_locks: Vec<FailedHtlcLockRow>,
}

/// The frame an attempt produced.
#[derive(Clone)]
pub struct ProposedRow {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    /// Raw owner signature paired with `hanko`, for the parent Entity's
    /// manifest. It is ephemeral and never changes the Account wire shape.
    pub signature: [u8; 65],
    pub hanko: Vec<u8>,
    /// The recovery proof the proposal travels with, when it carries one.
    pub dispute: Option<xln_rscore_engine::DisputeDraft>,
    /// What the proposer publishes at signing time, before any ack exists.
    /// The frame's committed effects are released with the peer's ack; these
    /// are the strings the Entity frame commits and the outputs it acts on
    /// the moment the window executed.
    pub events: Vec<String>,
    pub outputs: Vec<AccountOutput>,
    /// Exact outputs of each transaction in `frame.txs` order. The process
    /// wire keeps its existing flattened output field; resident Entity
    /// composition consumes this lossless form directly.
    pub outputs_by_tx: Vec<Vec<AccountOutput>>,
    /// Present when this proposal also carries the acknowledgement this side
    /// owed, which makes it a `frame_ack` on the wire.
    pub bundled_ack: Option<xln_rscore_engine::OutboundAck>,
}

impl ProposalRow {
    /// The frame as the counterparty receives it, or `None` when the attempt
    /// produced none.
    pub fn incoming(&self) -> Option<xln_rscore_engine::IncomingFrame> {
        self.proposed
            .as_ref()
            .map(|proposed| xln_rscore_engine::IncomingFrame {
                frame: proposed.frame.clone(),
                state_hash: proposed.state_hash,
                frame_hanko: Some(proposed.hanko.clone()),
                // The proposer's signature over their proof is not modelled
                // here: this path hands one engine's own proposal to another
                // inside a test, where both sides build the same proof from
                // the same state.
                dispute: proposed.dispute.as_ref().map(|draft| {
                    xln_rscore_engine::CounterpartyDispute {
                        hanko: None,
                        hash: draft.hash,
                        proof_body_hash: draft.proof_body_hash,
                        nonce: draft.nonce,
                        proposer_is_left: draft.proposer_is_left,
                    }
                }),
            })
    }
}

/// One transaction the proposal window rejected.
#[derive(Clone)]
pub struct DroppedRow {
    pub index: usize,
    pub tx_digest: [u8; 32],
    pub code: &'static str,
    pub message: String,
    pub disposition: Disposition,
}

#[derive(Clone)]
pub struct FailedHtlcLockRow {
    pub hashlock: [u8; 32],
    pub lock_id: String,
    pub reason: String,
    pub upstream_resolution: Option<UpstreamHtlcResolutionRow>,
}

#[derive(Clone)]
pub struct UpstreamHtlcResolutionRow {
    pub account_id: AccountId,
    pub lock_id: String,
    pub reason: String,
}

fn failed_htlc_locks(dropped: &[xln_rscore_engine::DroppedTx]) -> Vec<FailedHtlcLockRow> {
    dropped
        .iter()
        .filter_map(|dropped| match (&dropped.tx, dropped.disposition) {
            (
                xln_rscore_engine::AccountTx::HtlcLock(lock),
                xln_rscore_engine::Disposition::Removed,
            ) => Some(FailedHtlcLockRow {
                hashlock: *lock.hashlock.bytes(),
                lock_id: lock.lock_id.clone(),
                reason: dropped.rejection.message(),
                upstream_resolution: None,
            }),
            _ => None,
        })
        .collect()
}

fn dropped_rows(
    account_id: AccountId,
    dropped: &[xln_rscore_engine::DroppedTx],
) -> Result<Vec<DroppedRow>, BatchError> {
    dropped
        .iter()
        .map(|dropped| {
            Ok(DroppedRow {
                index: dropped.index,
                tx_digest: canonical_tx_digest(&dropped.tx)
                    .map_err(|error| state_error(account_id, &error))?,
                code: dropped.rejection.code(),
                message: dropped.rejection.message(),
                disposition: dropped.disposition,
            })
        })
        .collect()
}

fn outgoing_account_input(account: &AccountConsensus, proposed: &ProposedRow) -> AccountPeerInput {
    let replica = account.replica();
    let envelope = AccountPeerEnvelope {
        from_entity_id: *replica.owner().as_bytes(),
        to_entity_id: *replica.counterparty().as_bytes(),
        domain: replica.state().identity().domain().clone(),
        dispute_config: replica.state().dispute_config(),
        watch_seed: Some(replica.state().identity().watch_seed().clone()),
    };
    let frame = IncomingFrame {
        frame: proposed.frame.clone(),
        state_hash: proposed.state_hash,
        frame_hanko: Some(proposed.hanko.clone()),
        dispute: proposed
            .dispute
            .as_ref()
            .map(|draft| xln_rscore_engine::CounterpartyDispute {
                hanko: None,
                hash: draft.hash,
                proof_body_hash: draft.proof_body_hash,
                nonce: draft.nonce,
                proposer_is_left: draft.proposer_is_left,
            }),
    };
    let kind = match &proposed.bundled_ack {
        Some(ack) => AccountInputKind::FrameAck {
            ack: IncomingAck {
                height: ack.height,
                frame_hash: ack.frame_hash,
                frame_hanko: Some(ack.frame_hanko.clone()),
                dispute: ack
                    .dispute
                    .as_ref()
                    .map(|draft| xln_rscore_engine::CounterpartyDispute {
                        hanko: None,
                        hash: draft.hash,
                        proof_body_hash: draft.proof_body_hash,
                        nonce: draft.nonce,
                        proposer_is_left: draft.proposer_is_left,
                    }),
            },
            frame: Box::new(frame),
        },
        None => AccountInputKind::Frame(Box::new(frame)),
    };
    AccountPeerInput { envelope, kind }
}

pub(crate) fn proposal_row(
    account_id: AccountId,
    outcome: ProposalOutcome,
    account: &AccountConsensus,
) -> Result<ProposalRow, BatchError> {
    Ok(match outcome {
        ProposalOutcome::Idle { dropped } => ProposalRow {
            account_id,
            outbound_input: None,
            proposed: None,
            failed_htlc_locks: failed_htlc_locks(&dropped),
            dropped: dropped_rows(account_id, &dropped)?,
        },
        ProposalOutcome::Proposed(proposed) => {
            if proposed.dispute_requires_existing_hanko
                || proposed.bundled_ack_dispute_requires_existing_hanko
            {
                return Err(BatchError::OutboundDisputeUnsupported(account_id));
            }
            let failed_htlc_locks = failed_htlc_locks(&proposed.dropped);
            let dropped = dropped_rows(account_id, &proposed.dropped)?;
            let proposed = ProposedRow {
                frame: proposed.frame,
                state_hash: proposed.state_hash,
                signature: proposed.signature,
                hanko: proposed.hanko,
                dispute: proposed.dispute,
                events: proposed.events,
                outputs: proposed.outputs,
                outputs_by_tx: proposed.outputs_by_tx,
                bundled_ack: proposed.bundled_ack,
            };
            let outbound_input = Some(outgoing_account_input(account, &proposed));
            ProposalRow {
                account_id,
                outbound_input,
                proposed: Some(proposed),
                dropped,
                failed_htlc_locks,
            }
        }
    })
}

/// One account's work returned from the pool: the account it belongs to, the
/// state it reached, and whatever the caller asked for.
type ProposalWork = Result<(AccountId, AccountConsensus, [u8; 32], ProposalRow), BatchError>;
type HtlcFixedPointResult = (
    Vec<AccountAdmissionResult>,
    Vec<ProposalRow>,
    BTreeSet<AccountId>,
);
type OutboundWork = Result<
    (
        AccountId,
        Option<(AccountConsensus, [u8; 32])>,
        Option<ProposalRow>,
    ),
    BatchError,
>;
type InputWork = Result<
    (
        AccountId,
        AccountConsensus,
        Vec<AccountInputResult>,
        Vec<AccountAdmissionResult>,
        Option<[u8; 32]>,
    ),
    BatchError,
>;
type EntityOpsResult = (
    Vec<AccountInputResult>,
    Vec<AccountAdmissionResult>,
    BTreeSet<AccountId>,
    BTreeSet<AccountId>,
    BTreeSet<AccountId>,
);
type MaterializedWaveRows = (Vec<(AccountId, [u8; 32])>, Vec<AccountCheckpointRows>);

pub struct StatefulConsensusEngine {
    engine_generation: EngineGeneration,
    revision: u64,
    candidate_attempt: u64,
    pool: ThreadPool,
    account_shards: crate::parallel::AccountShardPlan,
    accounts: PersistentRadixMap<AccountConsensus>,
    /// The accounts tree as of the last checkpoint the runtime took, so the
    /// next checkpoint ships only what moved. The runtime asks for this every
    /// hundred or so frames; between those it never pays for the diff.
    checkpoint: PersistentRadixMap<AccountConsensus>,
    checkpoint_revision: u64,
    /// The signer key this process signs with, and the id the runtime knows
    /// it by. Every account derives its identity from the key, bound to its
    /// own owner entity. The runtime hands over this one key, never the seed
    /// that makes all of them.
    private_key: [u8; 32],
    signer_id: String,
    identities: BTreeMap<[u8; 32], SigningIdentity>,
    /// Registry market tables, installed by the runtime with Hello. Not
    /// account state: they cannot be derived from the tree, and a frame priced
    /// against the wrong tables is a divergence the roots would not catch
    /// until after it is signed.
    swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
    pending: Option<PendingWave>,
    /// Persistent pre-inbound tree for the currently open two-visit Entity round.
    entity_round_base: Option<crate::round::EntityRoundBase>,
}

impl StatefulConsensusEngine {
    pub fn restore(
        engine_generation: EngineGeneration,
        worker_count: usize,
        revision: u64,
        private_key: [u8; 32],
        signer_id: String,
        swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
        seeds: Vec<AccountSeed>,
    ) -> Result<Self, BatchError> {
        if worker_count == 0 || worker_count > MAX_BATCH_WORKERS {
            return Err(BatchError::InvalidWorkerCount(worker_count));
        }
        if private_key == [0_u8; 32] || signer_id.is_empty() {
            return Err(BatchError::SignerRequired);
        }
        let pool = ThreadPoolBuilder::new()
            .num_threads(worker_count)
            .thread_name(|index| format!("rscore-consensus-{index}"))
            .build()
            .map_err(|error| BatchError::ThreadPoolBuild(error.to_string()))?;
        let account_shards = crate::parallel::AccountShardPlan::balanced(worker_count)?;
        let mut engine = Self {
            engine_generation,
            revision,
            candidate_attempt: 0,
            pool,
            account_shards,
            accounts: PersistentRadixMap::empty(),
            checkpoint: PersistentRadixMap::empty(),
            checkpoint_revision: revision,
            private_key,
            signer_id,
            identities: BTreeMap::new(),
            swap_market,
            pending: None,
            entity_round_base: None,
        };
        engine.upsert_accounts(seeds)?;
        // Seeding is not a state change: the engine comes up at the revision
        // it was restored to, not one past it, or every restart would report a
        // revision the runtime never wrote.
        engine.revision = revision;
        engine.checkpoint_revision = revision;
        Ok(engine)
    }

    pub const fn engine_generation(&self) -> EngineGeneration {
        self.engine_generation
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn worker_count(&self) -> usize {
        self.pool.current_num_threads()
    }

    pub(crate) fn pool(&self) -> &ThreadPool {
        &self.pool
    }

    pub(crate) fn account_shards(&self) -> &crate::parallel::AccountShardPlan {
        &self.account_shards
    }

    pub fn account_shard_metrics(&self) -> Vec<crate::AccountShardMetric> {
        self.account_shards.metrics()
    }

    pub(crate) fn signer_id(&self) -> &str {
        &self.signer_id
    }

    pub(crate) const fn entity_round_base(&self) -> Option<&crate::round::EntityRoundBase> {
        self.entity_round_base.as_ref()
    }

    pub(crate) fn set_entity_round_base(&mut self, base: crate::round::EntityRoundBase) {
        self.entity_round_base = Some(base);
    }

    pub(crate) fn take_entity_round_base(&mut self) -> Option<crate::round::EntityRoundBase> {
        self.entity_round_base.take()
    }

    /// The committed tree as it stands, kept so a round can name what it moved.
    /// The map is persistent: this shares structure rather than copying it.
    pub(crate) fn accounts_snapshot(&self) -> PersistentRadixMap<AccountConsensus> {
        self.accounts.clone()
    }

    pub(crate) fn identities_snapshot(&self) -> BTreeMap<[u8; 32], SigningIdentity> {
        self.identities.clone()
    }

    pub(crate) fn restore_entity_snapshot(
        &mut self,
        accounts: PersistentRadixMap<AccountConsensus>,
        identities: BTreeMap<[u8; 32], SigningIdentity>,
        revision: u64,
    ) {
        self.accounts = accounts;
        self.identities = identities;
        self.revision = revision;
    }

    pub fn accounts_root(&self) -> [u8; 32] {
        self.accounts.root_hash()
    }

    pub fn account(&self, account_id: &AccountId) -> Option<&AccountConsensus> {
        self.accounts.get(account_id.as_bytes())
    }

    pub(crate) fn account_with_leaf(
        &self,
        account_id: &AccountId,
    ) -> Option<(&AccountConsensus, [u8; 32])> {
        self.accounts.get_with_digest(account_id.as_bytes())
    }

    pub fn account_count(&self) -> usize {
        self.accounts.len()
    }

    /// Seed or replace accounts. A seed that carries no consensus state starts
    /// the account at genesis — no frames, no queue; one that carries it is
    /// restored to exactly where the runtime holds the account, and its pending
    /// proposal is replayed rather than trusted.
    pub fn upsert_accounts(&mut self, seeds: Vec<AccountSeed>) -> Result<[u8; 32], BatchError> {
        let mut entries = Vec::with_capacity(seeds.len());
        let mut seen = BTreeSet::new();
        for seed in seeds {
            // Two seeds for one account in a wave is a caller bug: one of them
            // would be silently discarded by the tree write.
            if !seen.insert(seed.account_id) {
                return Err(BatchError::DuplicateAccount(seed.account_id));
            }
            self.ensure_identity(seed.replica.owner().as_bytes())?;
            let (account_id, account, leaf) = restore_seed_account(seed, &self.swap_market)?;
            entries.push((account_id.as_bytes().to_vec(), account, leaf));
        }
        if entries.is_empty() {
            return Ok(self.accounts.root_hash());
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    /// Admit local transactions into the accounts' mempools.
    ///
    /// A wave may carry several rows for the same account. They are merged in
    /// row order onto one copy: cloning the pre-wave account per row and
    /// writing each back would keep only the last row's transactions, and the
    /// rest would vanish without an error.
    pub fn admit_txs(
        &mut self,
        requests: Vec<(AccountId, Vec<xln_rscore_engine::AccountTx>)>,
    ) -> Result<[u8; 32], BatchError> {
        let mut merged: BTreeMap<AccountId, Vec<xln_rscore_engine::AccountTx>> = BTreeMap::new();
        for (account_id, txs) in requests {
            merged.entry(account_id).or_default().extend(txs);
        }
        let work = merged
            .into_iter()
            .map(|(account_id, txs)| {
                let account = self
                    .accounts
                    .get(account_id.as_bytes())
                    .ok_or(BatchError::AccountNotFound {
                        input_index: 0,
                        account_id,
                    })?
                    .clone();
                Ok((account_id, account, txs))
            })
            .collect::<Result<Vec<_>, BatchError>>()?;
        let admitted = map_accounts(
            &self.pool,
            &self.account_shards,
            work,
            |row| row.0,
            |(account_id, mut account, txs)| {
                account
                    .admit_txs(txs, "rscoreConsensus:admit")
                    .map_err(|error| state_error(account_id, &error))?;
                let leaf = leaf_root(account_id, &account)?;
                Ok((account_id.as_bytes().to_vec(), account, leaf))
            },
        );
        let entries = admitted
            .into_iter()
            .collect::<Result<Vec<_>, BatchError>>()?;
        if entries.is_empty() {
            return Ok(self.accounts.root_hash());
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    /// Queue local transactions and build the selected proposals in one
    /// account-local pass and one accounts-tree commit.
    ///
    /// The Entity exposes these as one outbound visit. Persisting the
    /// intermediate admitted-only tree would hash and path-copy every touched
    /// account twice even though no observer can see that intermediate root.
    pub(crate) fn admit_and_propose(
        &mut self,
        requests: Vec<(AccountId, Vec<AccountTx>)>,
        selected: &[AccountId],
        timestamp: u64,
        j_height: u64,
    ) -> Result<(Vec<AccountAdmissionResult>, Vec<ProposalRow>), BatchError> {
        let group_at = std::time::Instant::now();
        let admissions = requests
            .iter()
            .enumerate()
            .map(|(index, (account_id, txs))| AccountAdmissionResult {
                operation_index: index as u64,
                account_id: *account_id,
                verdict: AccountAdmissionVerdict::Admitted { count: txs.len() },
            })
            .collect::<Vec<_>>();
        let mut admitted: BTreeMap<AccountId, Vec<AccountTx>> = BTreeMap::new();
        for (account_id, txs) in requests {
            admitted.entry(account_id).or_default().extend(txs);
        }
        let mut selected_set = BTreeSet::new();
        for account_id in selected {
            if !selected_set.insert(*account_id) {
                return Err(BatchError::DuplicateAccount(*account_id));
            }
        }
        let mut account_ids = selected_set.clone();
        account_ids.extend(admitted.keys().copied());
        if account_ids.is_empty() {
            return Ok((admissions, Vec::new()));
        }
        let work = account_ids
            .into_iter()
            .map(|account_id| {
                (
                    account_id,
                    admitted.remove(&account_id),
                    selected_set.contains(&account_id),
                )
            })
            .collect::<Vec<_>>();
        crate::round::phase::add(&crate::round::phase::ACCOUNT_GROUP, group_at);
        let accounts = &self.accounts;
        let identities = &self.identities;
        let swap_market = &self.swap_market;
        let work_at = std::time::Instant::now();
        let outcomes: Vec<OutboundWork> = map_accounts(
            &self.pool,
            &self.account_shards,
            work,
            |row| row.0,
            |(account_id, txs, selected)| {
                let mut account = accounts
                    .get(account_id.as_bytes())
                    .ok_or(BatchError::AccountNotFound {
                        input_index: 0,
                        account_id,
                    })?
                    .clone();
                let mut changed = false;
                if let Some(txs) = txs {
                    account
                        .admit_txs(txs, "rscoreConsensus:admit")
                        .map_err(|error| state_error(account_id, &error))?;
                    changed = true;
                }
                let proposal = if selected {
                    if proposable(&account)? {
                        let identity = identities
                            .get(account.replica().owner().as_bytes())
                            .ok_or(BatchError::SignerRequired)?;
                        let outcome = propose_account_frame(
                            &mut account,
                            identity,
                            timestamp,
                            j_height,
                            swap_market,
                        )
                        .map_err(|error| state_error(account_id, &error))?;
                        changed = true;
                        Some(proposal_row(account_id, outcome, &account)?)
                    } else {
                        Some(ProposalRow {
                            account_id,
                            outbound_input: None,
                            proposed: None,
                            dropped: Vec::new(),
                            failed_htlc_locks: Vec::new(),
                        })
                    }
                } else {
                    None
                };
                let update = if changed {
                    let leaf = leaf_root(account_id, &account)?;
                    Some((account, leaf))
                } else {
                    None
                };
                Ok((account_id, update, proposal))
            },
        );
        crate::round::phase::add(&crate::round::phase::ACCOUNT_WORK, work_at);
        let collect_at = std::time::Instant::now();
        let mut entries = Vec::with_capacity(outcomes.len());
        let mut proposals = Vec::with_capacity(selected.len());
        for outcome in outcomes {
            let (account_id, update, proposal) = outcome?;
            if let Some((account, leaf)) = update {
                entries.push((account_id.as_bytes().to_vec(), account, leaf));
            }
            if let Some(proposal) = proposal {
                proposals.push(proposal);
            }
        }
        crate::round::phase::add(&crate::round::phase::ACCOUNT_COLLECT, collect_at);
        if !entries.is_empty() {
            let tree_at = std::time::Instant::now();
            self.accounts = self.put_accounts(entries)?;
            crate::round::phase::add(&crate::round::phase::TREE_PUBLISH, tree_at);
            self.revision += 1;
        }
        proposals.sort_by_key(|row| *row.account_id.as_bytes());
        Ok((admissions, proposals))
    }

    pub(crate) fn proposals_need_htlc_followup(
        proposals: &[ProposalRow],
        routes: &[crate::round::FailedHtlcRoute],
    ) -> Result<bool, BatchError> {
        let mut hashlocks = BTreeSet::new();
        for route in routes {
            if !hashlocks.insert(route.hashlock) {
                return Err(BatchError::FailedHtlcRouteDuplicate {
                    hashlock: hex_of(&route.hashlock),
                });
            }
        }
        Ok(proposals.iter().any(|proposal| {
            proposal
                .failed_htlc_locks
                .iter()
                .any(|failed| hashlocks.contains(&failed.hashlock))
        }))
    }

    /// Re-run the rare failed-forward path in canonical Entity worklist order.
    ///
    /// The fast path proposes independent accounts in parallel. Only an actual
    /// rejected forwarded lock creates a same-frame cross-account dependency.
    /// At that point the caller restores the post-inbound persistent snapshot
    /// and uses this ordered path: all original admissions happen first, then
    /// each failed lock queues its upstream resolve before the target's turn.
    /// Accounts already visited are not proposed twice, matching the TS
    /// worklist's permanent `scheduled` set.
    pub(crate) fn admit_and_propose_htlc_fixed_point(
        &mut self,
        requests: Vec<(AccountId, Vec<AccountTx>)>,
        selected: &[AccountId],
        timestamp: u64,
        j_height: u64,
        routes: &[crate::round::FailedHtlcRoute],
    ) -> Result<HtlcFixedPointResult, BatchError> {
        let mut route_by_hashlock = BTreeMap::new();
        for route in routes {
            if route_by_hashlock.insert(route.hashlock, route).is_some() {
                return Err(BatchError::FailedHtlcRouteDuplicate {
                    hashlock: hex_of(&route.hashlock),
                });
            }
        }
        let mut admissions = requests
            .iter()
            .enumerate()
            .map(|(index, (account_id, txs))| AccountAdmissionResult {
                operation_index: index as u64,
                account_id: *account_id,
                verdict: AccountAdmissionVerdict::Admitted { count: txs.len() },
            })
            .collect::<Vec<_>>();
        self.admit_txs(requests)?;

        let mut scheduled = BTreeSet::new();
        for account_id in selected {
            if !scheduled.insert(*account_id) {
                return Err(BatchError::DuplicateAccount(*account_id));
            }
        }
        let mut remaining = scheduled.clone();
        let mut generated_accounts = BTreeSet::new();
        let mut proposals = Vec::new();
        while let Some(account_id) = remaining.pop_first() {
            let mut rows = self.propose_frames(timestamp, j_height, Some(&[account_id]))?;
            let mut proposal = rows.pop().ok_or(BatchError::AccountNotFound {
                input_index: 0,
                account_id,
            })?;
            for failed in &mut proposal.failed_htlc_locks {
                let Some(route) = route_by_hashlock.get(&failed.hashlock) else {
                    continue;
                };
                if route.outbound_account_id != account_id
                    || route.outbound_lock_id != failed.lock_id
                {
                    return Err(BatchError::FailedHtlcRouteMismatch {
                        hashlock: hex_of(&failed.hashlock),
                        account: hex_of(account_id.as_bytes()),
                        lock_id: failed.lock_id.clone(),
                    });
                }
                let reason = format!("forward_failed:{}", failed.reason);
                let tx = AccountTx::HtlcResolve(HtlcResolveTx {
                    lock_id: route.inbound_lock_id.clone(),
                    outcome: HtlcResolveOutcome::Error {
                        reason: Some(reason.clone()),
                    },
                });
                self.admit_txs(vec![(route.inbound_account_id, vec![tx])])?;
                admissions.push(AccountAdmissionResult {
                    operation_index: admissions.len() as u64,
                    account_id: route.inbound_account_id,
                    verdict: AccountAdmissionVerdict::Admitted { count: 1 },
                });
                failed.upstream_resolution = Some(UpstreamHtlcResolutionRow {
                    account_id: route.inbound_account_id,
                    lock_id: route.inbound_lock_id.clone(),
                    reason,
                });
                generated_accounts.insert(route.inbound_account_id);
                if scheduled.insert(route.inbound_account_id) {
                    remaining.insert(route.inbound_account_id);
                }
            }
            proposals.push(proposal);
        }
        Ok((admissions, proposals, generated_accounts))
    }

    /// Propose a frame for every account that has something to propose. Frame
    /// building, hashing and signing all happen on the pool, one account per
    /// core, because signatures are the expensive part of a wave.
    pub fn propose_frames(
        &mut self,
        timestamp: u64,
        j_height: u64,
        selected: Option<&[AccountId]>,
    ) -> Result<Vec<ProposalRow>, BatchError> {
        let mut idle = Vec::new();
        let candidates: Vec<(AccountId, AccountConsensus)> = match selected {
            Some(ids) => {
                let mut seen = BTreeSet::new();
                let mut candidates = Vec::new();
                for account_id in ids {
                    if !seen.insert(*account_id) {
                        return Err(BatchError::DuplicateAccount(*account_id));
                    }
                    let account = self.accounts.get(account_id.as_bytes()).ok_or(
                        BatchError::AccountNotFound {
                            input_index: 0,
                            account_id: *account_id,
                        },
                    )?;
                    if proposable(account)? {
                        candidates.push((*account_id, account.clone()));
                    } else {
                        // A selected worklist is a request/response contract:
                        // every named Account gets one row. The Entity cannot
                        // consult its stale pre-outbound replica to predict
                        // whether Rust's post-inbound Account is proposable.
                        idle.push(ProposalRow {
                            account_id: *account_id,
                            outbound_input: None,
                            proposed: None,
                            dropped: Vec::new(),
                            failed_htlc_locks: Vec::new(),
                        });
                    }
                }
                candidates
            }
            None => {
                let mut candidates = Vec::new();
                for (key, account) in self.accounts.iter() {
                    if proposable(account)? {
                        candidates.push((AccountId::from_key(key), account.clone()));
                    }
                }
                candidates
            }
        };
        let mut rows = self.propose_candidates(candidates, timestamp, j_height)?;
        rows.append(&mut idle);
        rows.sort_by_key(|row| *row.account_id.as_bytes());
        Ok(rows)
    }

    /// Build, hash and sign one clock's worth of proposals. Split out of
    /// `propose_frames` because a wave proposes per Entity: the accounts are
    /// selected once, then each Entity's group is stamped with its own clock.
    fn propose_candidates(
        &mut self,
        candidates: Vec<(AccountId, AccountConsensus)>,
        timestamp: u64,
        j_height: u64,
    ) -> Result<Vec<ProposalRow>, BatchError> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let identities = &self.identities;
        let swap_market = &self.swap_market;
        let proposals: Vec<ProposalWork> = map_accounts(
            &self.pool,
            &self.account_shards,
            candidates,
            |row| row.0,
            |(account_id, mut account)| {
                let identity = identities
                    .get(account.replica().owner().as_bytes())
                    .ok_or(BatchError::SignerRequired)?;
                let outcome =
                    propose_account_frame(&mut account, identity, timestamp, j_height, swap_market)
                        .map_err(|error| state_error(account_id, &error))?;
                let row = proposal_row(account_id, outcome, &account)?;
                let leaf = leaf_root(account_id, &account)?;
                Ok((account_id, account, leaf, row))
            },
        );
        let mut entries = Vec::with_capacity(proposals.len());
        let mut rows = Vec::new();
        for proposal in proposals {
            let (account_id, account, leaf, row) = proposal?;
            entries.push((account_id.as_bytes().to_vec(), account, leaf));
            rows.push(row);
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        rows.sort_by_key(|row| *row.account_id.as_bytes());
        Ok(rows)
    }

    /// Apply inputs that arrived from peers. Inputs for one account keep their
    /// order; different accounts run on different cores, which is where the
    /// signature verification parallelises.
    /// Apply inputs against the runtime's own clock. Enforcement decisions —
    /// whether a lock has expired — are judged with `clock`, never with the
    /// clock the peer signed into the frame.
    pub fn apply_inputs(
        &mut self,
        clock: ReceiverClock,
        rows: Vec<AccountInputRow>,
    ) -> Result<Vec<AccountInputResult>, BatchError> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let group_at = std::time::Instant::now();
        for pair in rows.windows(2) {
            if pair[0].operation_index >= pair[1].operation_index {
                return Err(BatchError::OperationIndex {
                    actual: pair[1].operation_index,
                    after: Some(pair[0].operation_index),
                });
            }
        }
        let mut by_account: BTreeMap<AccountId, Vec<AccountInputRow>> = BTreeMap::new();
        let mut missing = Vec::new();
        for row in rows {
            if self.accounts.get(row.account_id.as_bytes()).is_none() {
                missing.push(AccountInputResult {
                    operation_index: row.operation_index,
                    account_id: row.account_id,
                    verdict: AccountInputVerdict::Failed(format!(
                        "RSCORE_CONSENSUS_ACCOUNT_NOT_FOUND:{}",
                        hex_of(row.account_id.as_bytes())
                    )),
                });
                continue;
            }
            by_account.entry(row.account_id).or_default().push(row);
        }
        let work: Vec<(AccountId, Vec<AccountInputRow>)> = by_account.into_iter().collect();
        crate::round::phase::add(&crate::round::phase::ACCOUNT_GROUP, group_at);
        let accounts = &self.accounts;
        let identities = &self.identities;
        let swap_market = &self.swap_market;
        let work_at = std::time::Instant::now();
        let applied: Vec<InputWork> = map_accounts(
            &self.pool,
            &self.account_shards,
            work,
            |row| row.0,
            |(account_id, rows)| {
                let mut account = accounts
                    .get(account_id.as_bytes())
                    .expect("presence checked above")
                    .clone();
                let identity = identities
                    .get(account.replica().owner().as_bytes())
                    .ok_or(BatchError::SignerRequired)?;
                let mut results = Vec::with_capacity(rows.len());
                let mut changed = false;
                for row in rows {
                    let authority = row.certified_board_authority.certified()?;
                    let local_authority = row.local_certified_board_authority.certified()?;
                    let (verdict, row_changed) = apply_one(
                        account_id,
                        &mut account,
                        identity,
                        row.input,
                        IncomingFrameSecurityContext {
                            clock,
                            peer_certified_board_authority: authority,
                            local_certified_board_authority: local_authority,
                        },
                        swap_market,
                    );
                    changed |= row_changed;
                    results.push(AccountInputResult {
                        operation_index: row.operation_index,
                        account_id,
                        verdict,
                    });
                }
                let leaf = if changed {
                    Some(leaf_root(account_id, &account)?)
                } else {
                    None
                };
                Ok((account_id, account, results, Vec::new(), leaf))
            },
        );
        crate::round::phase::add(&crate::round::phase::ACCOUNT_WORK, work_at);
        let collect_at = std::time::Instant::now();
        let mut entries = Vec::with_capacity(applied.len());
        let mut results = missing;
        for outcome in applied {
            let (account_id, account, rows, _, leaf) = outcome?;
            let Some(leaf) = leaf else {
                results.extend(rows);
                continue;
            };
            entries.push((account_id.as_bytes().to_vec(), account, leaf));
            results.extend(rows);
        }
        crate::round::phase::add(&crate::round::phase::ACCOUNT_COLLECT, collect_at);
        if !entries.is_empty() {
            let tree_at = std::time::Instant::now();
            self.accounts = self.put_accounts(entries)?;
            crate::round::phase::add(&crate::round::phase::TREE_PUBLISH, tree_at);
            self.revision += 1;
        }
        results.sort_by_key(|result| result.operation_index);
        Ok(results)
    }

    /// Apply every Entity's ordered work, one account per core.
    ///
    /// The order is per account and comes from the request: admissions and
    /// peer inputs interleave inside one runtime frame, so they run in the
    /// sequence the authority observed rather than in two phases. Accounts are
    /// independent of one another, which is where signature verification
    /// parallelises.
    fn run_entity_ops(
        &mut self,
        contexts: &BTreeMap<[u8; 32], WaveEntityContext>,
        entities: &[EntityWaveOps],
        prior_used: &BTreeSet<AccountId>,
        prior_created: &BTreeSet<AccountId>,
        prior_unused_created: &BTreeSet<AccountId>,
    ) -> Result<EntityOpsResult, BatchError> {
        let mut owners: BTreeSet<[u8; 32]> = BTreeSet::new();
        for entity in entities {
            if !owners.insert(entity.owner_entity_id) {
                return Err(BatchError::WaveEntityDuplicate {
                    entity_id: hex_of(&entity.owner_entity_id),
                });
            }
            if !contexts.contains_key(&entity.owner_entity_id) {
                return Err(BatchError::WaveEntityUnknown {
                    entity_id: hex_of(&entity.owner_entity_id),
                });
            }
        }

        // Validate every Create before installing any of them. The request is
        // globally ordered by operation_index, so this scan also proves that
        // creation precedes every use across both this step and prior steps of
        // the held candidate.
        let mut used = prior_used.clone();
        let mut created = prior_created.clone();
        let mut unused_created = prior_unused_created.clone();
        let mut step_used = BTreeSet::new();
        let mut step_created: BTreeMap<AccountId, AccountConsensus> = BTreeMap::new();
        for entity in entities {
            for op in &entity.ops {
                let account_id = op.account_id();
                if let WaveOp::Create { seed, .. } = op {
                    if created.contains(&account_id) {
                        return Err(BatchError::WaveCreateDuplicate(account_id));
                    }
                    if self.accounts.get(account_id.as_bytes()).is_some() {
                        return Err(BatchError::WaveCreateExisting(account_id));
                    }
                    if used.contains(&account_id) {
                        return Err(BatchError::WaveCreateAfterUse(account_id));
                    }
                    let account = validate_genesis_seed(entity.owner_entity_id, seed)?;
                    step_created.insert(account_id, account);
                    created.insert(account_id);
                    unused_created.insert(account_id);
                }
                used.insert(account_id);
                step_used.insert(account_id);
            }
        }
        // A zero-account lazy Entity has no pre-existing signer binding. Bind
        // it only after the complete Create set passed validation; apply_wave
        // snapshots identities too, so a later step error remains atomic.
        for account in step_created.values() {
            self.ensure_identity(account.replica().owner().as_bytes())?;
        }

        struct AccountWork {
            clock: ReceiverClock,
            account: AccountConsensus,
            ops: Vec<WaveOp>,
        }
        let mut work: BTreeMap<AccountId, AccountWork> = BTreeMap::new();
        let mut missing: Vec<AccountInputResult> = Vec::new();
        for entity in entities {
            for op in &entity.ops {
                let account_id = op.account_id();
                let account = self
                    .accounts
                    .get(account_id.as_bytes())
                    .or_else(|| step_created.get(&account_id));
                let Some(account) = account else {
                    match op {
                        // An input for an account this engine does not hold is
                        // reported as a verdict; the runtime decides what to do
                        // with it.
                        WaveOp::Input(row) => {
                            missing.push(AccountInputResult {
                                operation_index: row.operation_index,
                                account_id,
                                verdict: AccountInputVerdict::Failed(format!(
                                    "RSCORE_CONSENSUS_ACCOUNT_NOT_FOUND:{}",
                                    hex_of(account_id.as_bytes())
                                )),
                            });
                            continue;
                        }
                        // Nothing could have queued a transaction for an
                        // account that does not exist: that is a driver bug,
                        // not a rejected input.
                        WaveOp::Admit { .. } => {
                            return Err(BatchError::AccountNotFound {
                                input_index: 0,
                                account_id,
                            });
                        }
                        // Every Create was materialized by the validation pass.
                        WaveOp::Create { .. } => unreachable!("validated Create is present"),
                    }
                };
                // The group says who owns this account, and so does the
                // account. The engine believes the account.
                if account.replica().owner().as_bytes() != &entity.owner_entity_id {
                    return Err(BatchError::WaveAccountOwner {
                        account_id,
                        entity_id: hex_of(&entity.owner_entity_id),
                    });
                }
                let context = contexts
                    .get(&entity.owner_entity_id)
                    .expect("presence checked above");
                work.entry(account_id)
                    .or_insert_with(|| AccountWork {
                        clock: context.clock,
                        account: account.clone(),
                        ops: Vec::new(),
                    })
                    .ops
                    .push(op.clone());
            }
        }
        if work.is_empty() {
            return Ok((missing, Vec::new(), step_used, created, unused_created));
        }
        let units: Vec<(AccountId, AccountWork)> = work.into_iter().collect();
        let identities = &self.identities;
        let swap_market = &self.swap_market;
        let applied: Vec<InputWork> = map_accounts(
            &self.pool,
            &self.account_shards,
            units,
            |row| row.0,
            |(account_id, unit)| {
                let AccountWork {
                    clock,
                    mut account,
                    ops,
                } = unit;
                let identity = identities
                    .get(account.replica().owner().as_bytes())
                    .ok_or(BatchError::SignerRequired)?;
                let mut results = Vec::new();
                let mut admissions = Vec::new();
                let mut changed = step_created.contains_key(&account_id);
                for op in ops {
                    match op {
                        WaveOp::Admit {
                            operation_index,
                            txs,
                            ..
                        } => {
                            let verdict = match admit_local_txs(&mut account, txs) {
                                Ok(count) => {
                                    changed |= count > 0;
                                    AccountAdmissionVerdict::Admitted { count }
                                }
                                Err(error) => AccountAdmissionVerdict::Rejected {
                                    code: "ACCOUNT_ADMISSION_REJECTED".to_string(),
                                    message: error.to_string(),
                                },
                            };
                            admissions.push(AccountAdmissionResult {
                                operation_index,
                                account_id,
                                verdict,
                            });
                        }
                        WaveOp::Input(row) => {
                            let authority = row.certified_board_authority.certified()?;
                            let local_authority =
                                row.local_certified_board_authority.certified()?;
                            let (verdict, row_changed) = apply_one(
                                account_id,
                                &mut account,
                                identity,
                                row.input,
                                IncomingFrameSecurityContext {
                                    clock,
                                    peer_certified_board_authority: authority,
                                    local_certified_board_authority: local_authority,
                                },
                                swap_market,
                            );
                            changed |= row_changed;
                            results.push(AccountInputResult {
                                operation_index: row.operation_index,
                                account_id,
                                verdict,
                            });
                        }
                        // Validation already constructed this exact
                        // genesis account as the unit's starting value.
                        WaveOp::Create { .. } => {}
                    }
                }
                let leaf = if changed {
                    Some(leaf_root(account_id, &account)?)
                } else {
                    None
                };
                Ok((account_id, account, results, admissions, leaf))
            },
        );
        let mut entries = Vec::with_capacity(applied.len());
        let mut results = missing;
        let mut admissions = Vec::new();
        for outcome in applied {
            let (account_id, account, rows, admitted, leaf) = outcome?;
            if created.contains(&account_id)
                && (rows.iter().any(|row| verdict_commits_genesis(&row.verdict))
                    || admitted.iter().any(|row| {
                        matches!(
                            &row.verdict,
                            AccountAdmissionVerdict::Admitted { count } if *count > 0
                        )
                    }))
            {
                unused_created.remove(&account_id);
            }
            results.extend(rows);
            admissions.extend(admitted);
            if let Some(leaf) = leaf {
                entries.push((account_id.as_bytes().to_vec(), account, leaf));
            }
        }
        if !entries.is_empty() {
            self.accounts = self.put_accounts(entries)?;
            self.revision += 1;
        }
        results.sort_by_key(|result| result.operation_index);
        admissions.sort_by_key(|result| result.operation_index);
        Ok((results, admissions, step_used, created, unused_created))
    }

    /// Propose only the canonical worklist the Entity selected for this round.
    /// Scanning every proposable account here would race ahead of Entity logic:
    /// one proposal can schedule another account, which belongs to the next
    /// deterministic round rather than this one.
    fn propose_selected(
        &mut self,
        contexts: &BTreeMap<[u8; 32], WaveEntityContext>,
        request: &WaveProposalRequest,
    ) -> Result<Vec<ProposalRow>, BatchError> {
        let mut owners = BTreeSet::new();
        let mut rows = Vec::new();
        for selection in &request.entities {
            if !owners.insert(selection.owner_entity_id) {
                return Err(BatchError::WaveEntityDuplicate {
                    entity_id: hex_of(&selection.owner_entity_id),
                });
            }
            let context = contexts.get(&selection.owner_entity_id).ok_or_else(|| {
                BatchError::WaveEntityUnknown {
                    entity_id: hex_of(&selection.owner_entity_id),
                }
            })?;
            if !context.propose {
                return Err(BatchError::WaveEntityNotProposer {
                    entity_id: hex_of(&selection.owner_entity_id),
                });
            }
            if selection
                .account_ids
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            {
                return Err(BatchError::WaveProposalOrder {
                    entity_id: hex_of(&selection.owner_entity_id),
                });
            }
            let mut candidates = Vec::new();
            for account_id in &selection.account_ids {
                let account = self.accounts.get(account_id.as_bytes()).ok_or(
                    BatchError::AccountNotFound {
                        input_index: 0,
                        account_id: *account_id,
                    },
                )?;
                if account.replica().owner().as_bytes() != &selection.owner_entity_id {
                    return Err(BatchError::WaveAccountOwner {
                        account_id: *account_id,
                        entity_id: hex_of(&selection.owner_entity_id),
                    });
                }
                if proposable(account)? {
                    candidates.push((*account_id, account.clone()));
                }
            }
            rows.extend(self.propose_candidates(
                candidates,
                context.timestamp,
                context.j_height,
            )?);
        }
        rows.sort_by_key(|row| *row.account_id.as_bytes());
        Ok(rows)
    }

    /// Open one abortable Runtime-frame candidate and apply its first ordered
    /// operation chunk. Proposals are explicit later rounds: committed outputs
    /// from this reply may schedule more Account work before any frame is built.
    pub fn prepare_wave(&mut self, request: WaveRequest) -> Result<WaveResult, BatchError> {
        if self.pending.is_some() {
            return Err(BatchError::WavePending);
        }
        let include_post_accounts = request.post_accounts;
        let base_accounts = self.accounts.clone();
        let base_identities = self.identities.clone();
        let base_revision = self.revision;
        let attempt = self
            .candidate_attempt
            .checked_add(1)
            .ok_or(BatchError::CandidateAttemptOverflow)?;
        let candidate_id = CandidateId::derive(
            self.engine_generation,
            attempt,
            base_revision,
            base_accounts.root_hash(),
        );
        // Burn attempts that later fail: no capability is returned for them,
        // and a retry must never be able to alias work the engine attempted.
        self.candidate_attempt = attempt;
        let mut contexts = BTreeMap::new();
        let mut ops = Vec::with_capacity(request.entities.len());
        for entity in request.entities {
            if contexts
                .insert(
                    entity.owner_entity_id,
                    WaveEntityContext {
                        timestamp: entity.timestamp,
                        j_height: entity.j_height,
                        clock: entity.clock,
                        propose: entity.propose,
                    },
                )
                .is_some()
            {
                return Err(BatchError::WaveEntityDuplicate {
                    entity_id: hex_of(&entity.owner_entity_id),
                });
            }
            ops.push(EntityWaveOps {
                owner_entity_id: entity.owner_entity_id,
                ops: entity.ops,
            });
        }
        self.pending = Some(PendingWave {
            candidate_id,
            post_accounts: include_post_accounts,
            base_accounts: base_accounts.clone(),
            base_identities: base_identities.clone(),
            base_revision,
            contexts,
            last_operation_index: None,
            used_accounts: BTreeSet::new(),
            created_accounts: BTreeSet::new(),
            unused_created_accounts: BTreeSet::new(),
            touched: BTreeSet::new(),
            applied: Vec::new(),
            admissions: Vec::new(),
            proposals: Vec::new(),
            sealed: false,
            accepted_stage_ordinal: 0,
            terminal_entity_stages: BTreeMap::new(),
            entity_stage: None,
        });
        let outcome = self.apply_wave_ops(WaveOpsRequest { entities: ops });
        match outcome {
            Ok(result) => Ok(result),
            Err(error) => {
                self.accounts = base_accounts;
                self.identities = base_identities;
                self.revision = base_revision;
                self.pending = None;
                Err(error)
            }
        }
    }

    /// Open the savepoint for one exact parent Entity input.
    ///
    /// The caller supplies both a content-derived key and the number of Entity
    /// stages this candidate has already accepted. The pair makes retries
    /// idempotent without letting an old input attach itself to a later point
    /// in the same Runtime candidate.
    pub fn begin_entity_stage(
        &mut self,
        key: StageKey,
        expected_accepted_stage_ordinal: u64,
        context: EntityStageContext,
    ) -> Result<EntityStageReceipt, BatchError> {
        let pending = self.pending.as_ref().ok_or(BatchError::WaveMissing)?;
        if let Some(terminal) = pending.terminal_entity_stages.get(&key) {
            validate_terminal_replay(key, expected_accepted_stage_ordinal, &context, terminal)?;
            return Ok(terminal.receipt);
        }
        if pending.sealed {
            return Err(BatchError::WaveSealed);
        }
        if let Some(active) = pending.entity_stage.as_ref() {
            if active.key != key {
                return Err(BatchError::EntityStageOpen(active.key));
            }
            if active.expected_accepted_stage_ordinal != expected_accepted_stage_ordinal {
                return Err(BatchError::EntityStageOrdinal {
                    actual: expected_accepted_stage_ordinal,
                    expected: active.expected_accepted_stage_ordinal,
                });
            }
            if active.context != context {
                return Err(BatchError::EntityStageReplay {
                    key,
                    detail: "context",
                });
            }
            return Ok(EntityStageReceipt {
                key,
                status: EntityStageStatus::Open,
                accepted_stage_ordinal: expected_accepted_stage_ordinal,
            });
        }
        if pending.accepted_stage_ordinal != expected_accepted_stage_ordinal {
            return Err(BatchError::EntityStageOrdinal {
                actual: expected_accepted_stage_ordinal,
                expected: pending.accepted_stage_ordinal,
            });
        }
        let savepoint = EntityStageSavepoint {
            key,
            expected_accepted_stage_ordinal,
            context,
            accounts: self.accounts.clone(),
            identities: self.identities.clone(),
            revision: self.revision,
            contexts: pending.contexts.clone(),
            last_operation_index: pending.last_operation_index,
            used_accounts: pending.used_accounts.clone(),
            created_accounts: pending.created_accounts.clone(),
            unused_created_accounts: pending.unused_created_accounts.clone(),
            touched: pending.touched.clone(),
            applied_len: pending.applied.len(),
            admissions_len: pending.admissions.len(),
            proposals_len: pending.proposals.len(),
        };
        let pending = self.pending.as_mut().ok_or(BatchError::WaveMissing)?;
        pending.contexts.insert(
            context.owner_entity_id,
            WaveEntityContext {
                timestamp: context.timestamp,
                j_height: context.j_height,
                clock: context.clock,
                propose: context.propose,
            },
        );
        pending.entity_stage = Some(savepoint);
        Ok(EntityStageReceipt {
            key,
            status: EntityStageStatus::Open,
            accepted_stage_ordinal: expected_accepted_stage_ordinal,
        })
    }

    /// Keep the mutations made for one parent Entity input. Its clock is
    /// stage-local and is removed even on accept; the next Entity input must
    /// install its own exact context before doing Account work.
    pub fn accept_entity_stage(
        &mut self,
        key: StageKey,
        expected_accepted_stage_ordinal: u64,
    ) -> Result<EntityStageReceipt, BatchError> {
        self.finish_entity_stage(
            key,
            expected_accepted_stage_ordinal,
            EntityStageStatus::Accepted,
        )
    }

    /// Reject the parent Entity input and restore the candidate byte-for-byte
    /// to its pre-input state, including the operation index. A later accepted
    /// input can therefore reuse the same deterministic index range.
    pub fn rollback_entity_stage(
        &mut self,
        key: StageKey,
        expected_accepted_stage_ordinal: u64,
    ) -> Result<EntityStageReceipt, BatchError> {
        self.finish_entity_stage(
            key,
            expected_accepted_stage_ordinal,
            EntityStageStatus::RolledBack,
        )
    }

    /// Prove that a staged Apply/Propose command is attached to the currently
    /// open parent Entity input. The process layer calls this after validating
    /// the candidate capability and before dispatching the existing mutation
    /// method; batch methods deliberately retain their no-stage form until the
    /// old driver is removed at cutover.
    pub fn require_entity_stage(&self, key: StageKey) -> Result<(), BatchError> {
        let pending = self.pending.as_ref().ok_or(BatchError::WaveMissing)?;
        let active = pending
            .entity_stage
            .as_ref()
            .ok_or(BatchError::EntityStageMissing(key))?;
        if active.key != key {
            return Err(BatchError::EntityStageKey {
                actual: key,
                expected: active.key,
            });
        }
        Ok(())
    }

    fn finish_entity_stage(
        &mut self,
        key: StageKey,
        expected_accepted_stage_ordinal: u64,
        decision: EntityStageStatus,
    ) -> Result<EntityStageReceipt, BatchError> {
        let pending = self.pending.as_ref().ok_or(BatchError::WaveMissing)?;
        if let Some(terminal) = pending.terminal_entity_stages.get(&key) {
            if terminal.begin_ordinal != expected_accepted_stage_ordinal {
                return Err(BatchError::EntityStageOrdinal {
                    actual: expected_accepted_stage_ordinal,
                    expected: terminal.begin_ordinal,
                });
            }
            if terminal.receipt.status != decision {
                return Err(BatchError::EntityStageDecisionConflict {
                    key,
                    actual: decision,
                    expected: terminal.receipt.status,
                });
            }
            return Ok(terminal.receipt);
        }
        let active = pending
            .entity_stage
            .as_ref()
            .ok_or(BatchError::EntityStageMissing(key))?;
        if active.key != key {
            return Err(BatchError::EntityStageKey {
                actual: key,
                expected: active.key,
            });
        }
        if active.expected_accepted_stage_ordinal != expected_accepted_stage_ordinal {
            return Err(BatchError::EntityStageOrdinal {
                actual: expected_accepted_stage_ordinal,
                expected: active.expected_accepted_stage_ordinal,
            });
        }
        let accepted_stage_ordinal = match decision {
            EntityStageStatus::Accepted => expected_accepted_stage_ordinal
                .checked_add(1)
                .ok_or(BatchError::EntityStageOrdinalOverflow)?,
            EntityStageStatus::RolledBack => expected_accepted_stage_ordinal,
            EntityStageStatus::Open => unreachable!("open is not a terminal decision"),
        };
        let savepoint = self
            .pending
            .as_mut()
            .ok_or(BatchError::WaveMissing)?
            .entity_stage
            .take()
            .ok_or(BatchError::EntityStageMissing(key))?;
        let receipt = EntityStageReceipt {
            key,
            status: decision,
            accepted_stage_ordinal,
        };
        let terminal = TerminalEntityStage {
            begin_ordinal: expected_accepted_stage_ordinal,
            context: savepoint.context,
            receipt,
        };
        match decision {
            EntityStageStatus::Accepted => {
                let pending = self.pending.as_mut().ok_or(BatchError::WaveMissing)?;
                pending.contexts = savepoint.contexts;
                pending.accepted_stage_ordinal = accepted_stage_ordinal;
                pending.terminal_entity_stages.insert(key, terminal);
            }
            EntityStageStatus::RolledBack => {
                self.accounts = savepoint.accounts;
                self.identities = savepoint.identities;
                self.revision = savepoint.revision;
                let pending = self.pending.as_mut().ok_or(BatchError::WaveMissing)?;
                pending.contexts = savepoint.contexts;
                pending.last_operation_index = savepoint.last_operation_index;
                pending.used_accounts = savepoint.used_accounts;
                pending.created_accounts = savepoint.created_accounts;
                pending.unused_created_accounts = savepoint.unused_created_accounts;
                pending.touched = savepoint.touched;
                pending.applied.truncate(savepoint.applied_len);
                pending.admissions.truncate(savepoint.admissions_len);
                pending.proposals.truncate(savepoint.proposals_len);
                pending.terminal_entity_stages.insert(key, terminal);
            }
            EntityStageStatus::Open => unreachable!("open is not a terminal decision"),
        }
        Ok(receipt)
    }

    /// Continue an open candidate. A failed step restores the candidate state
    /// that preceded this call; the original abort base remains unchanged.
    pub fn apply_wave_ops(&mut self, request: WaveOpsRequest) -> Result<WaveResult, BatchError> {
        let (
            contexts,
            previous_index,
            prior_used,
            prior_created,
            prior_unused_created,
            include_post_accounts,
        ) = {
            let pending = self.open_wave()?;
            if let Some(stage) = pending.entity_stage.as_ref() {
                for entity in &request.entities {
                    if entity.owner_entity_id != stage.context.owner_entity_id {
                        return Err(BatchError::EntityStageOwner {
                            key: stage.key,
                            actual: hex_of(&entity.owner_entity_id),
                            expected: hex_of(&stage.context.owner_entity_id),
                        });
                    }
                }
            }
            (
                pending.contexts.clone(),
                pending.last_operation_index,
                pending.used_accounts.clone(),
                pending.created_accounts.clone(),
                pending.unused_created_accounts.clone(),
                pending.post_accounts,
            )
        };
        let next_index = validate_operation_indices(&request.entities, previous_index)?;
        let touched: BTreeSet<AccountId> = request
            .entities
            .iter()
            .flat_map(|entity| entity.ops.iter().map(WaveOp::account_id))
            .collect();
        let step_accounts = self.accounts.clone();
        let step_identities = self.identities.clone();
        let step_revision = self.revision;
        let outcome = self
            .run_entity_ops(
                &contexts,
                &request.entities,
                &prior_used,
                &prior_created,
                &prior_unused_created,
            )
            .and_then(
                |(applied, admissions, step_used, created, unused_created)| {
                    let (leaves, post_accounts) =
                        self.materialize_wave_rows(&touched, include_post_accounts)?;
                    Ok((
                        applied,
                        admissions,
                        step_used,
                        created,
                        unused_created,
                        leaves,
                        post_accounts,
                    ))
                },
            );
        let (applied, admissions, step_used, created, unused_created, leaves, post_accounts) =
            match outcome {
                Ok(result) => result,
                Err(error) => {
                    self.accounts = step_accounts;
                    self.identities = step_identities;
                    self.revision = step_revision;
                    return Err(error);
                }
            };
        let pending = self.open_wave_mut()?;
        pending.last_operation_index = next_index;
        pending.used_accounts.extend(step_used);
        pending.created_accounts = created;
        pending.unused_created_accounts = unused_created;
        pending.touched.extend(touched);
        pending.applied.extend(applied.iter().cloned());
        pending.admissions.extend(admissions.iter().cloned());
        Ok(WaveResult {
            candidate_id: self
                .pending
                .as_ref()
                .ok_or(BatchError::WaveMissing)?
                .candidate_id,
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            applied,
            admissions,
            proposals: Vec::new(),
            touched: leaves,
            post_accounts,
        })
    }

    /// Build frames only for the exact deterministic Account worklist selected
    /// by each Entity for this round.
    pub fn propose_wave(&mut self, request: WaveProposalRequest) -> Result<WaveResult, BatchError> {
        let (contexts, include_post_accounts) = {
            let pending = self.open_wave()?;
            if let Some(stage) = pending.entity_stage.as_ref() {
                for entity in &request.entities {
                    if entity.owner_entity_id != stage.context.owner_entity_id {
                        return Err(BatchError::EntityStageOwner {
                            key: stage.key,
                            actual: hex_of(&entity.owner_entity_id),
                            expected: hex_of(&stage.context.owner_entity_id),
                        });
                    }
                }
            }
            (pending.contexts.clone(), pending.post_accounts)
        };
        let step_accounts = self.accounts.clone();
        let step_revision = self.revision;
        let outcome = self
            .propose_selected(&contexts, &request)
            .and_then(|proposals| {
                let touched: BTreeSet<AccountId> =
                    proposals.iter().map(|row| row.account_id).collect();
                let (leaves, post_accounts) =
                    self.materialize_wave_rows(&touched, include_post_accounts)?;
                Ok((proposals, touched, leaves, post_accounts))
            });
        let (proposals, touched, leaves, post_accounts) = match outcome {
            Ok(rows) => rows,
            Err(error) => {
                self.accounts = step_accounts;
                self.revision = step_revision;
                return Err(error);
            }
        };
        let pending = self.open_wave_mut()?;
        pending.touched.extend(touched);
        pending.proposals.extend(proposals.iter().cloned());
        Ok(WaveResult {
            candidate_id: self
                .pending
                .as_ref()
                .ok_or(BatchError::WaveMissing)?
                .candidate_id,
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            applied: Vec::new(),
            admissions: Vec::new(),
            proposals,
            touched: leaves,
            post_accounts,
        })
    }

    /// Freeze the complete candidate transcript. Only this final result carries
    /// cumulative results and materialized Account rows.
    pub fn seal_wave(&mut self) -> Result<WaveResult, BatchError> {
        let (touched, applied, admissions, proposals) = {
            let pending = self.open_wave()?;
            if let Some(stage) = pending.entity_stage.as_ref() {
                return Err(BatchError::EntityStageOpen(stage.key));
            }
            if let Some(account_id) = pending.unused_created_accounts.first() {
                return Err(BatchError::WaveCreateUnused(*account_id));
            }
            (
                pending.touched.clone(),
                pending.applied.clone(),
                pending.admissions.clone(),
                pending.proposals.clone(),
            )
        };
        let include_post_accounts = self.open_wave()?.post_accounts;
        let (leaves, post_accounts) =
            self.materialize_wave_rows(&touched, include_post_accounts)?;
        self.open_wave_mut()?.sealed = true;
        Ok(WaveResult {
            candidate_id: self
                .pending
                .as_ref()
                .ok_or(BatchError::WaveMissing)?
                .candidate_id,
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            applied,
            admissions,
            proposals,
            touched: leaves,
            post_accounts,
        })
    }

    fn materialize_wave_rows(
        &self,
        touched: &BTreeSet<AccountId>,
        include_accounts: bool,
    ) -> Result<MaterializedWaveRows, BatchError> {
        let ids = touched.iter().copied().collect::<Vec<_>>();
        let materialized = map_accounts(
            &self.pool,
            &self.account_shards,
            ids,
            |account_id| *account_id,
            |account_id| {
                let Some((account, leaf)) = self.accounts.get_with_digest(account_id.as_bytes())
                else {
                    return Ok(None);
                };
                let post_account = if include_accounts {
                    let signer_id = self
                        .signer_of(account.replica().owner().as_bytes())
                        .ok_or(BatchError::SignerRequired)?;
                    let previous = self
                        .pending
                        .as_ref()
                        .and_then(|pending| pending.base_accounts.get(account_id.as_bytes()));
                    Some(
                        account_rows(account_id, account, previous, leaf, signer_id).map_err(
                            |error| BatchError::AccountsTree {
                                account_id,
                                detail: error.to_string(),
                            },
                        )?,
                    )
                } else {
                    None
                };
                Ok(Some((account_id, leaf, post_account)))
            },
        );
        let mut leaves = Vec::with_capacity(touched.len());
        let mut post_accounts =
            Vec::with_capacity(if include_accounts { touched.len() } else { 0 });
        for row in materialized {
            let Some((account_id, leaf, post_account)) = row? else {
                continue;
            };
            leaves.push((account_id, leaf));
            if let Some(post_account) = post_account {
                post_accounts.push(post_account);
            }
        }
        Ok((leaves, post_accounts))
    }

    fn open_wave(&self) -> Result<&PendingWave, BatchError> {
        let pending = self.pending.as_ref().ok_or(BatchError::WaveMissing)?;
        if pending.sealed {
            return Err(BatchError::WaveSealed);
        }
        Ok(pending)
    }

    fn open_wave_mut(&mut self) -> Result<&mut PendingWave, BatchError> {
        let pending = self.pending.as_mut().ok_or(BatchError::WaveMissing)?;
        if pending.sealed {
            return Err(BatchError::WaveSealed);
        }
        Ok(pending)
    }

    /// Keep the wave: the runtime has made its own record of it durable.
    pub fn commit_wave(&mut self, candidate_id: CandidateId) -> Result<[u8; 32], BatchError> {
        let pending = self.pending.as_ref().ok_or(BatchError::WaveMissing)?;
        if let Some(stage) = pending.entity_stage.as_ref() {
            return Err(BatchError::EntityStageOpen(stage.key));
        }
        if !pending.sealed {
            return Err(BatchError::WaveOpen);
        }
        if candidate_id != pending.candidate_id {
            return Err(BatchError::WaveCandidate {
                actual: candidate_id,
                expected: pending.candidate_id,
            });
        }
        self.pending = None;
        Ok(self.accounts.root_hash())
    }

    /// Drop the wave and everything it touched. The caller could not make its
    /// own record durable, so this engine must not be ahead of it.
    pub fn abort_wave(&mut self, candidate_id: CandidateId) -> Result<u64, BatchError> {
        let Some(pending) = self.pending.take() else {
            return Err(BatchError::WaveMissing);
        };
        if candidate_id != pending.candidate_id {
            let expected = pending.candidate_id;
            self.pending = Some(pending);
            return Err(BatchError::WaveCandidate {
                actual: candidate_id,
                expected,
            });
        }
        self.accounts = pending.base_accounts;
        self.identities = pending.base_identities;
        self.revision = pending.base_revision;
        Ok(self.revision)
    }

    /// Whether a wave is waiting for the runtime's word.
    pub const fn wave_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Every other entry point is closed while a wave is uncommitted: the
    /// engine holds exactly one candidate, and a second mutation on top of it
    /// could not be rolled back to the state the runtime agreed on.
    fn assert_no_pending_wave(&self) -> Result<(), BatchError> {
        if let Some(pending) = self.pending.as_ref() {
            if let Some(stage) = pending.entity_stage.as_ref() {
                return Err(BatchError::EntityStageOpen(stage.key));
            }
            return Err(BatchError::WavePending);
        }
        Ok(())
    }

    /// Bind an entity this runtime signs for to the key it signs with. A
    /// runtime that hosts several entities holds a different key for each;
    /// without this they would all sign as the session's default signer.
    ///
    /// The key comes from the caller because only the runtime knows how its
    /// own signers are derived — this process is handed keys, never a seed to
    /// derive them from.
    pub fn register_signer(
        &mut self,
        entity_id: [u8; 32],
        private_key: [u8; 32],
        signer_id: &str,
    ) -> Result<(), BatchError> {
        let identity = self.build_identity(entity_id, private_key, signer_id)?;
        if let Some(existing) = self.identities.get(&entity_id) {
            if existing.signer_id() != signer_id {
                return Err(BatchError::SignerRebind {
                    entity_id: hex_of(&entity_id),
                    actual: signer_id.to_string(),
                    expected: existing.signer_id().to_string(),
                });
            }
            return Ok(());
        }
        self.identities.insert(entity_id, identity);
        Ok(())
    }

    /// Everything that moved since the last committed checkpoint. The runtime
    /// writes these rows into its canonical database and calls
    /// `commit_checkpoint` once the write is durable; nothing is dropped until
    /// then, so a crash in between replays from the previous checkpoint.
    pub fn checkpoint_changes(&self) -> Result<AccountsCheckpoint, BatchError> {
        // A wave the runtime has not committed is not part of the world yet,
        // so it must not reach the database that outlives this process.
        self.assert_no_pending_wave()?;
        self.build_checkpoint_changes()
    }

    /// Snapshot the candidate held for one exact runtime wave.
    ///
    /// The runtime calls this before its WAL fsync. Binding the read to the
    /// wave revision prevents a stale or unrelated candidate from being
    /// written under the frame that is about to become durable. The candidate
    /// remains abortable until `commit_wave`; this method only reads it.
    pub fn checkpoint_changes_for_wave(
        &self,
        candidate_id: CandidateId,
    ) -> Result<AccountsCheckpoint, BatchError> {
        let pending = self.pending.as_ref().ok_or(BatchError::WaveMissing)?;
        if let Some(stage) = pending.entity_stage.as_ref() {
            return Err(BatchError::EntityStageOpen(stage.key));
        }
        if !pending.sealed {
            return Err(BatchError::WaveOpen);
        }
        if candidate_id != pending.candidate_id {
            return Err(BatchError::WaveCandidate {
                actual: candidate_id,
                expected: pending.candidate_id,
            });
        }
        self.build_checkpoint_changes()
    }

    fn build_checkpoint_changes(&self) -> Result<AccountsCheckpoint, BatchError> {
        let diff = self.accounts.node_changes_since(&self.checkpoint);
        let mut accounts = Vec::new();
        for record in &diff.puts {
            let PersistentNodeRecord::Leaf { key, value, .. } = record else {
                continue;
            };
            let account_id = account_id_of(key)?;
            let owner = value.replica().owner().as_bytes();
            let signer_id = self
                .signer_of(owner)
                .ok_or(BatchError::SignerRequired)?
                .to_string();
            accounts.push(
                account_rows(
                    account_id,
                    value,
                    self.checkpoint.get(key),
                    leaf_root(account_id, value)?,
                    &signer_id,
                )
                .map_err(|error| BatchError::AccountsTree {
                    account_id,
                    detail: error.to_string(),
                })?,
            );
        }
        let mut removed = Vec::new();
        for record in &diff.dels {
            let PersistentNodeRef::Leaf { key, .. } = record else {
                continue;
            };
            // A leaf may move within the tree without leaving it: a deletion
            // that the same revision also puts back is a reshape, not a drop.
            if self.accounts.get(key).is_none() {
                removed.push(account_id_of(key)?);
            }
        }
        Ok(AccountsCheckpoint {
            token: self.checkpoint_token()?,
            accounts,
            removed,
        })
    }

    /// The token for the state as it stands: what a restore must reproduce.
    pub fn checkpoint_token(&self) -> Result<CheckpointToken, BatchError> {
        if let Some(stage) = self
            .pending
            .as_ref()
            .and_then(|pending| pending.entity_stage.as_ref())
        {
            return Err(BatchError::EntityStageOpen(stage.key));
        }
        Ok(CheckpointToken {
            base_revision: self.checkpoint_revision,
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            signer_digest: self.signer_digest()?,
            account_count: self.accounts.len(),
        })
    }

    fn signer_digest(&self) -> Result<[u8; 32], BatchError> {
        let mut rows = Vec::with_capacity(self.accounts.len());
        for (key, account) in self.accounts.iter() {
            let owner = account.replica().owner();
            let signer_id = self
                .signer_of(owner.as_bytes())
                .ok_or(BatchError::SignerRequired)?;
            rows.push((account_id_of(key)?, *owner.as_bytes(), signer_id));
        }
        Ok(crate::checkpoint::signer_digest(rows.into_iter()))
    }

    /// Accept a checkpoint the runtime has made durable.
    ///
    /// The token must be the one that was read: a revision alone would let an
    /// acknowledgement land on a different checkpoint — same number, different
    /// accounts, or the same accounts signed by someone else.
    pub fn commit_checkpoint(&mut self, token: &CheckpointToken) -> Result<(), BatchError> {
        self.assert_no_pending_wave()?;
        let current = self.checkpoint_token()?;
        if *token != current {
            return Err(BatchError::CheckpointToken {
                actual: format!(
                    "{}:{}:{}",
                    token.revision,
                    hex_of(&token.accounts_root),
                    hex_of(&token.signer_digest)
                ),
                expected: format!(
                    "{}:{}:{}",
                    current.revision,
                    hex_of(&current.accounts_root),
                    hex_of(&current.signer_digest)
                ),
            });
        }
        self.checkpoint = self.accounts.clone();
        self.checkpoint_revision = current.revision;
        Ok(())
    }

    /// Load accounts back from a checkpoint the database holds.
    ///
    /// This replaces the store rather than merging into it: a restore is what
    /// the database says the world is, and an account the database no longer
    /// has must not survive in memory. The result is checked against what the
    /// checkpoint recorded — every account leaf, the account count, the tree
    /// root and the revision — because any subset of rows rebuilds into a
    /// perfectly valid tree that simply is not this one.
    pub fn restore_accounts(
        &mut self,
        rows: Vec<AccountRestore>,
        expected: &CheckpointExpectation,
    ) -> Result<[u8; 32], BatchError> {
        self.assert_no_pending_wave()?;
        if rows.len() != expected.account_count {
            return Err(BatchError::CheckpointIncomplete {
                actual: rows.len(),
                expected: expected.account_count,
            });
        }
        // Everything is built beside the live store. A restore that fails must
        // leave this engine exactly as it was, not half-loaded from a database
        // that turned out not to match.
        let mut identities: BTreeMap<[u8; 32], SigningIdentity> = BTreeMap::new();
        let mut seen = BTreeSet::new();
        let mut signer_rows = Vec::with_capacity(rows.len());
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            if !seen.insert(row.account_id) {
                return Err(BatchError::DuplicateAccount(row.account_id));
            }
            let owner = *row.replica.owner().as_bytes();
            // The key for an entity this session was told about is the one it
            // was given; for any other row the session's own key must bind the
            // entity, or the row is refused rather than signed for by the
            // wrong signer. This process holds keys, not the seed that makes
            // them, so it cannot derive a stranger's.
            let identity = match self.identities.get(&owner) {
                Some(known) => {
                    if known.signer_id() != row.signer_id {
                        return Err(BatchError::SignerRebind {
                            entity_id: hex_of(&owner),
                            actual: row.signer_id.clone(),
                            expected: known.signer_id().to_string(),
                        });
                    }
                    known.clone()
                }
                None => self.build_identity(owner, self.private_key, &row.signer_id)?,
            };
            if let Some(existing) = identities.get(&owner) {
                if existing.signer_id() != row.signer_id {
                    return Err(BatchError::SignerRebind {
                        entity_id: hex_of(&owner),
                        actual: row.signer_id.clone(),
                        expected: existing.signer_id().to_string(),
                    });
                }
            } else {
                identities.insert(owner, identity);
            }
            let restored = restore_checkpoint_account(row, &self.swap_market)?;
            signer_rows.push((restored.account_id, restored.owner, restored.signer_id));
            entries.push((
                restored.account_id.as_bytes().to_vec(),
                restored.account,
                restored.leaf,
            ));
        }
        let restored = self.put_into(&PersistentRadixMap::empty(), entries)?;
        if restored.len() != expected.account_count {
            return Err(BatchError::CheckpointIncomplete {
                actual: restored.len(),
                expected: expected.account_count,
            });
        }
        let root = restored.root_hash();
        if root != expected.accounts_root {
            return Err(BatchError::CheckpointRoot {
                actual: hex_of(&root),
                expected: hex_of(&expected.accounts_root),
            });
        }
        let digest = crate::checkpoint::signer_digest(
            signer_rows
                .iter()
                .map(|(account_id, owner, signer_id)| (*account_id, *owner, signer_id.as_str())),
        );
        if digest != expected.signer_digest {
            return Err(BatchError::CheckpointSignerDigest {
                actual: hex_of(&digest),
                expected: hex_of(&expected.signer_digest),
            });
        }
        // Only now, with every check passed, does this become the engine.
        self.accounts = restored;
        self.identities = identities;
        self.revision = expected.revision;
        self.checkpoint = self.accounts.clone();
        self.checkpoint_revision = expected.revision;
        Ok(root)
    }

    /// Resolve the signer for an entity we host. The session's default signer
    /// is only assumed when it actually is this entity's signer — a lazy
    /// entity id is the hash of its own board, so that is checkable. Guessing
    /// wrong would have this engine sign frames the peer cannot verify, and
    /// the mistake would only surface at the counterparty.
    fn ensure_identity(&mut self, entity_id: &[u8; 32]) -> Result<(), BatchError> {
        if self.identities.contains_key(entity_id) {
            return Ok(());
        }
        let signer_id = self.signer_id.clone();
        let identity = self.build_identity(*entity_id, self.private_key, &signer_id)?;
        self.identities.insert(*entity_id, identity);
        Ok(())
    }

    /// Bind a key to one entity and prove it belongs to it. The proof is the
    /// lazy entity id: it is the hash of the board this key alone defines, so
    /// a key that is not this entity's cannot pass.
    fn build_identity(
        &self,
        entity_id: [u8; 32],
        private_key: [u8; 32],
        signer_id: &str,
    ) -> Result<SigningIdentity, BatchError> {
        build_signing_identity(entity_id, private_key, signer_id)
    }

    /// The signer id bound to an entity, so a checkpoint can carry it and a
    /// restore can rebuild the mapping instead of guessing.
    pub fn signer_of(&self, entity_id: &[u8; 32]) -> Option<&str> {
        self.identities
            .get(entity_id)
            .map(|identity| identity.signer_id())
    }

    fn put_accounts(
        &self,
        entries: Vec<(Vec<u8>, AccountConsensus, [u8; 32])>,
    ) -> Result<PersistentRadixMap<AccountConsensus>, BatchError> {
        self.put_into(&self.accounts, entries)
    }

    /// The same batched write against any base, so a restore can build its
    /// tree without the live one having to be replaced first.
    fn put_into(
        &self,
        base: &PersistentRadixMap<AccountConsensus>,
        entries: Vec<(Vec<u8>, AccountConsensus, [u8; 32])>,
    ) -> Result<PersistentRadixMap<AccountConsensus>, BatchError> {
        let wide = entries.len() >= crate::parallel::THREE_LEVEL_FANOUT_MIN;
        if wide {
            base.updated_batch_three_levels(entries, |slots| {
                crate::parallel::map_account_slots(&self.pool, &self.account_shards, slots)
            })
        } else if self.pool.current_num_threads() > 16
            && entries.len() >= crate::parallel::SECOND_LEVEL_FANOUT_MIN
        {
            base.updated_batch_two_levels(entries, |slots| {
                crate::parallel::map_slots(&self.pool, slots)
            })
        } else {
            base.updated_batch(entries, |slots| {
                crate::parallel::map_slots(&self.pool, slots)
            })
        }
        .map_err(|error| BatchError::AccountsTree {
            account_id: AccountId::from_bytes([0; 32]),
            detail: error.to_string(),
        })
    }
}

pub(crate) fn apply_one(
    account_id: AccountId,
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    input: AccountPeerInput,
    security: IncomingFrameSecurityContext<'_>,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> (AccountInputVerdict, bool) {
    let clock = security.clock;
    let peer_authority = security.peer_certified_board_authority;
    let local_authority = security.local_certified_board_authority;
    if account_id.as_bytes() != &input.envelope.from_entity_id {
        return (
            AccountInputVerdict::Failed("ACCOUNT_INPUT_ACCOUNT_ID_MISMATCH".to_string()),
            false,
        );
    }
    if let Some(authority) = peer_authority
        && let Err(error) = authority.assert_entity(&input.envelope.from_entity_id)
    {
        return (AccountInputVerdict::Failed(error.to_string()), false);
    }
    let verdict = match input.kind {
        AccountInputKind::Frame(frame) => {
            match apply_incoming_frame_with_authority(
                account,
                identity,
                &input.envelope,
                *frame,
                swap_market,
                IncomingFrameSecurityContext {
                    clock,
                    peer_certified_board_authority: peer_authority,
                    local_certified_board_authority: local_authority,
                },
            ) {
                Ok(outcome) => incoming_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
        AccountInputKind::Ack(ack) => {
            match apply_incoming_ack_with_authority(
                account,
                &input.envelope,
                clock,
                ack,
                peer_authority,
            ) {
                Ok(outcome) => ack_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
        AccountInputKind::FrameAck { ack, frame } => match apply_incoming_frame_ack_with_authority(
            account,
            identity,
            &input.envelope,
            ack,
            *frame,
            swap_market,
            IncomingFrameSecurityContext {
                clock,
                peer_certified_board_authority: peer_authority,
                local_certified_board_authority: local_authority,
            },
        ) {
            Ok(outcome) => frame_ack_verdict(outcome),
            Err(error) => AccountInputVerdict::Failed(error.to_string()),
        },
        AccountInputKind::Dispute(dispute) => {
            match apply_standalone_dispute(account, &input.envelope, clock, dispute, peer_authority)
            {
                Ok(outcome) => standalone_dispute_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
        AccountInputKind::BoardHankoRefresh(refresh) => {
            match apply_board_hanko_refresh(
                account,
                &input.envelope,
                clock,
                refresh,
                peer_authority,
            ) {
                Ok(outcome) => board_hanko_refresh_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
    };
    let changed = verdict_changes_account(&verdict);
    (verdict, changed)
}

fn standalone_dispute_verdict(outcome: StandaloneInputOutcome) -> AccountInputVerdict {
    match outcome {
        StandaloneInputOutcome::Applied { .. } => AccountInputVerdict::DisputeApplied,
        StandaloneInputOutcome::Rejected { reason } => {
            AccountInputVerdict::DisputeRejected { reason }
        }
    }
}

fn board_hanko_refresh_verdict(outcome: StandaloneInputOutcome) -> AccountInputVerdict {
    match outcome {
        StandaloneInputOutcome::Applied { events } => {
            AccountInputVerdict::BoardHankoRefreshApplied { events }
        }
        StandaloneInputOutcome::Rejected { reason } => {
            AccountInputVerdict::BoardHankoRefreshRejected { reason }
        }
    }
}

fn incoming_verdict(outcome: IncomingOutcome) -> AccountInputVerdict {
    match outcome {
        IncomingOutcome::Committed {
            height,
            state_hash,
            ack_signature,
            ack_hanko,
            outputs,
            events,
            rolled_back,
            committed_frame,
            ack_dispute,
        } => AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            ack_signature,
            ack_hanko,
            outputs,
            events,
            rolled_back,
            committed_frame,
            ack_dispute,
        },
        IncomingOutcome::CollisionIgnored { height, queued } => {
            AccountInputVerdict::FrameCollisionIgnored { height, queued }
        }
        IncomingOutcome::Duplicate {
            height,
            state_hash,
            ack_hanko,
            ack_dispute,
        } => AccountInputVerdict::FrameDuplicate {
            height,
            state_hash,
            ack_hanko,
            ack_dispute,
        },
        IncomingOutcome::Stale {
            height,
            current_height,
        } => AccountInputVerdict::FrameStale {
            height,
            current_height,
        },
        IncomingOutcome::DisputeRequired {
            reason,
            evidence_secrets,
            signed_frame,
        } => AccountInputVerdict::FrameDisputeRequired {
            reason,
            evidence_secrets,
            signed_frame: *signed_frame,
        },
        IncomingOutcome::Rejected { reason } => AccountInputVerdict::FrameRejected { reason },
    }
}

fn ack_verdict(outcome: AckOutcome) -> AccountInputVerdict {
    match outcome {
        AckOutcome::Committed {
            height,
            state_hash,
            outputs,
            events,
            committed_frame,
        } => AccountInputVerdict::AckCommitted {
            height,
            state_hash,
            outputs,
            events,
            committed_frame,
        },
        AckOutcome::Stale { height } => AccountInputVerdict::AckStale { height },
        AckOutcome::Rejected { reason } => AccountInputVerdict::AckRejected { reason },
    }
}

fn frame_ack_verdict(outcome: FrameAckOutcome) -> AccountInputVerdict {
    match outcome {
        FrameAckOutcome::Applied { ack, frame } => AccountInputVerdict::FrameAckApplied {
            ack: Box::new(ack_verdict(*ack)),
            frame: Box::new(incoming_verdict(*frame)),
        },
        FrameAckOutcome::Rejected { phase, reason } => {
            AccountInputVerdict::FrameAckRejected { phase, reason }
        }
    }
}

fn verdict_changes_account(verdict: &AccountInputVerdict) -> bool {
    match verdict {
        AccountInputVerdict::FrameCommitted { .. }
        | AccountInputVerdict::AckCommitted { .. }
        | AccountInputVerdict::DisputeApplied
        | AccountInputVerdict::BoardHankoRefreshApplied { .. } => true,
        AccountInputVerdict::FrameAckApplied { ack, frame } => {
            verdict_changes_account(ack) || verdict_changes_account(frame)
        }
        AccountInputVerdict::FrameCollisionIgnored { .. }
        | AccountInputVerdict::FrameDuplicate { .. }
        | AccountInputVerdict::FrameStale { .. }
        | AccountInputVerdict::FrameDisputeRequired { .. }
        | AccountInputVerdict::FrameRejected { .. }
        | AccountInputVerdict::AckStale { .. }
        | AccountInputVerdict::AckRejected { .. }
        | AccountInputVerdict::FrameAckRejected { .. }
        | AccountInputVerdict::DisputeRejected { .. }
        | AccountInputVerdict::BoardHankoRefreshRejected { .. }
        | AccountInputVerdict::Failed(_) => false,
    }
}

pub(crate) fn verdict_commits_genesis(verdict: &AccountInputVerdict) -> bool {
    match verdict {
        AccountInputVerdict::FrameCommitted { height: 1, .. } => true,
        AccountInputVerdict::FrameAckApplied { frame, .. } => verdict_commits_genesis(frame),
        AccountInputVerdict::FrameCommitted { .. }
        | AccountInputVerdict::FrameCollisionIgnored { .. }
        | AccountInputVerdict::FrameDuplicate { .. }
        | AccountInputVerdict::FrameStale { .. }
        | AccountInputVerdict::FrameDisputeRequired { .. }
        | AccountInputVerdict::FrameRejected { .. }
        | AccountInputVerdict::AckCommitted { .. }
        | AccountInputVerdict::AckStale { .. }
        | AccountInputVerdict::AckRejected { .. }
        | AccountInputVerdict::FrameAckRejected { .. }
        | AccountInputVerdict::DisputeApplied
        | AccountInputVerdict::DisputeRejected { .. }
        | AccountInputVerdict::BoardHankoRefreshApplied { .. }
        | AccountInputVerdict::BoardHankoRefreshRejected { .. }
        | AccountInputVerdict::Failed(_) => false,
    }
}

pub(crate) fn admit_local_txs(
    account: &mut AccountConsensus,
    txs: Vec<AccountTx>,
) -> Result<usize, StateError> {
    let mut seen = BTreeSet::new();
    for tx in account.mempool().iter().chain(
        account
            .pending()
            .into_iter()
            .flat_map(|pending| &pending.frame.txs),
    ) {
        if !matches!(tx, AccountTx::DirectPayment { .. }) {
            seen.insert(canonical_tx_digest(tx)?);
        }
    }
    let mut admitted = Vec::with_capacity(txs.len());
    for tx in txs {
        if matches!(tx, AccountTx::DirectPayment { .. }) {
            admitted.push(tx);
            continue;
        }
        if seen.insert(canonical_tx_digest(&tx)?) {
            admitted.push(tx);
        }
    }
    let count = admitted.len();
    account.admit_txs(admitted, "rscoreConsensus:localAdmission")?;
    Ok(count)
}

/// Accept only the pre-input Account genesis that the Entity itself creates.
///
/// Comparing against a Rust-constructed empty state is intentionally stronger
/// than a hand-maintained list of "must be empty" sections. When AccountState
/// gains another committed financial section, its root changes and Create is
/// fail-closed until that section is canonically empty too.
pub(crate) fn validate_genesis_seed(
    owner_entity_id: [u8; 32],
    seed: &AccountSeed,
) -> Result<AccountConsensus, BatchError> {
    let account_id = seed.account_id;
    if seed.replica.owner().as_bytes() != &owner_entity_id {
        return Err(BatchError::WaveAccountOwner {
            account_id,
            entity_id: hex_of(&owner_entity_id),
        });
    }
    if seed.replica.counterparty().as_bytes() != account_id.as_bytes() {
        return Err(BatchError::WaveCreateCounterparty {
            account_id,
            counterparty: hex_of(seed.replica.counterparty().as_bytes()),
        });
    }
    if seed.consensus.is_some() {
        return Err(BatchError::WaveCreateConsensus(account_id));
    }
    let mempool_len = seed.replica.envelope().mempool_len();
    if mempool_len != 0 {
        return Err(BatchError::WaveCreateMempool {
            account_id,
            actual: mempool_len,
        });
    }
    let delta_transformer = seed
        .replica
        .delta_transformer()
        .copied()
        .ok_or(BatchError::WaveCreateTransformer(account_id))?;

    let state = seed.replica.state();
    let expected_state =
        AccountState::new(state.identity().clone(), state.dispute_config(), Vec::new())
            .map_err(|error| state_error(account_id, &error))?;
    let expected = expected_state
        .payment_profile_account_state_root()
        .map_err(|error| state_error(account_id, &error))?;
    let actual = state
        .payment_profile_account_state_root()
        .map_err(|error| state_error(account_id, &error))?;
    if actual != expected {
        return Err(BatchError::WaveCreateNonGenesis {
            account_id,
            actual: hex_of(&actual),
            expected: hex_of(&expected),
        });
    }

    // The seed proves the Entity built the one canonical H=0 shell; it is not
    // a replica snapshot we trust. Rebuild the financial state and envelope
    // from Rust-owned constants so an unmodelled seed field can never become
    // authoritative merely because it happened to hash into the imported
    // leaf. Only status/public pin and the two validated empty collection
    // commitments survive as carried fields; consensus derives every H=0
    // height/frame/proof field itself.
    let envelope = validate_genesis_envelope(account_id, &seed.replica)?;
    let mut replica = AccountReplica::new(seed.replica.owner().clone(), expected_state)
        .map_err(|error| state_error(account_id, &error))?;
    replica.set_delta_transformer(delta_transformer);
    replica.set_envelope(envelope);
    Ok(AccountConsensus::new(replica))
}

fn validate_genesis_envelope(
    account_id: AccountId,
    replica: &AccountReplica,
) -> Result<AccountEnvelope, BatchError> {
    let fields = replica.envelope().fields();
    let mut actual: BTreeMap<&str, &CanonicalValue> = BTreeMap::new();
    for (name, value) in fields {
        if actual.insert(name.as_str(), value).is_some() {
            return Err(create_envelope_error(
                account_id,
                format!("DUPLICATE_FIELD:{name}"),
            ));
        }
    }
    let public_pinned = match actual.get("publicPinned") {
        None => false,
        Some(CanonicalValue::Bool(true)) => true,
        Some(_) => {
            return Err(create_envelope_error(
                account_id,
                "PUBLIC_PINNED_NON_CANONICAL".to_string(),
            ));
        }
    };
    let policy_root = validate_genesis_shadow(account_id, actual.get("shadow").copied())?;
    let expected = genesis_envelope_fields(replica, public_pinned, &policy_root);
    if actual.len() != expected.len() {
        let expected_names: BTreeSet<&str> =
            expected.iter().map(|(name, _)| name.as_str()).collect();
        if let Some(extra) = actual.keys().find(|name| !expected_names.contains(**name)) {
            return Err(create_envelope_error(
                account_id,
                format!("EXTRA_FIELD:{extra}"),
            ));
        }
        if let Some(missing) = expected
            .iter()
            .map(|(name, _)| name.as_str())
            .find(|name| !actual.contains_key(name))
        {
            return Err(create_envelope_error(
                account_id,
                format!("MISSING_FIELD:{missing}"),
            ));
        }
        return Err(create_envelope_error(account_id, "FIELD_COUNT".to_string()));
    }
    for (name, expected_value) in &expected {
        let Some(actual_value) = actual.get(name.as_str()) else {
            return Err(create_envelope_error(
                account_id,
                format!("MISSING_FIELD:{name}"),
            ));
        };
        if !canonical_exact_eq(actual_value, expected_value) {
            return Err(create_envelope_error(
                account_id,
                format!("FIELD_NON_CANONICAL:{name}"),
            ));
        }
    }

    let carried = expected
        .into_iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "status" | "publicPinned" | "pendingWithdrawals" | "shadow"
            )
        })
        .collect();
    AccountEnvelope::new(carried, Vec::new())
        .map_err(|error| create_envelope_error(account_id, error.to_string()))
}

fn genesis_envelope_fields(
    replica: &AccountReplica,
    public_pinned: bool,
    policy_root: &str,
) -> Vec<(String, CanonicalValue)> {
    let zero_root = CanonicalValue::String(format!("0x{}", hex_of(&[0_u8; 32])));
    let mut fields = vec![(
        "status".to_string(),
        CanonicalValue::String("active".to_string()),
    )];
    if public_pinned {
        fields.push(("publicPinned".to_string(), CanonicalValue::Bool(true)));
    }
    fields.extend([
        (
            "currentHeight".to_string(),
            CanonicalValue::Number(CanonicalNumber::from_u32(0)),
        ),
        (
            "rollbackCount".to_string(),
            CanonicalValue::Number(CanonicalNumber::from_u32(0)),
        ),
        (
            "proofHeader".to_string(),
            CanonicalValue::Object(vec![
                (
                    "fromEntity".to_string(),
                    CanonicalValue::String(replica.owner().to_string()),
                ),
                (
                    "toEntity".to_string(),
                    CanonicalValue::String(replica.counterparty().to_string()),
                ),
                (
                    "nextProofNonce".to_string(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(1)),
                ),
            ]),
        ),
        (
            "currentFrameHash".to_string(),
            CanonicalValue::String(String::new()),
        ),
        ("pendingWithdrawals".to_string(), zero_root.clone()),
        (
            "shadow".to_string(),
            CanonicalValue::Object(vec![(
                "rebalance".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "policyRoot".to_string(),
                        CanonicalValue::String(policy_root.to_string()),
                    ),
                    ("submittedAtByTokenRoot".to_string(), zero_root),
                ]),
            )]),
        ),
    ]);
    fields
}

/// The rebalance routing policy is Entity-owned rather than an Account
/// financial transition, so Create carries its already-computed Patricia
/// root. The protocol fingerprint binds this exact two-root projection; this
/// validator admits no quote/request/evidence bodies and requires the
/// submitted-at tree to still be empty at H=0. A later typed CreateSpec can
/// carry the policy rows and let Rust recompute this root, without widening
/// today's seed surface.
fn validate_genesis_shadow(
    account_id: AccountId,
    shadow: Option<&CanonicalValue>,
) -> Result<String, BatchError> {
    let Some(CanonicalValue::Object(shadow)) = shadow else {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow".to_string(),
        ));
    };
    let [(rebalance_name, CanonicalValue::Object(rebalance))] = shadow.as_slice() else {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow".to_string(),
        ));
    };
    if rebalance_name != "rebalance" {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow".to_string(),
        ));
    }
    let [
        (policy_name, CanonicalValue::String(policy_root)),
        (submitted_name, submitted_root),
    ] = rebalance.as_slice()
    else {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow.rebalance".to_string(),
        ));
    };
    if policy_name != "policyRoot"
        || !is_canonical_root_text(policy_root)
        || submitted_name != "submittedAtByTokenRoot"
        || !canonical_exact_eq(
            submitted_root,
            &CanonicalValue::String(format!("0x{}", hex_of(&[0_u8; 32]))),
        )
    {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow.rebalance".to_string(),
        ));
    }
    Ok(policy_root.clone())
}

fn is_canonical_root_text(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value
            .as_bytes()
            .iter()
            .skip(2)
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn canonical_exact_eq(actual: &CanonicalValue, expected: &CanonicalValue) -> bool {
    match (actual, expected) {
        (CanonicalValue::Null, CanonicalValue::Null) => true,
        (CanonicalValue::Bool(left), CanonicalValue::Bool(right)) => left == right,
        (CanonicalValue::Number(left), CanonicalValue::Number(right)) => left == right,
        (CanonicalValue::BigInt(left), CanonicalValue::BigInt(right)) => left == right,
        (CanonicalValue::String(left), CanonicalValue::String(right)) => left == right,
        (CanonicalValue::Array(left), CanonicalValue::Array(right))
        | (CanonicalValue::Set(left), CanonicalValue::Set(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| canonical_exact_eq(left, right))
        }
        (CanonicalValue::Map(left), CanonicalValue::Map(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(
                    |((left_key, left_value), (right_key, right_value))| {
                        canonical_exact_eq(left_key, right_key)
                            && canonical_exact_eq(left_value, right_value)
                    },
                )
        }
        (CanonicalValue::Object(left), CanonicalValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(
                    |((left_name, left_value), (right_name, right_value))| {
                        left_name == right_name && canonical_exact_eq(left_value, right_value)
                    },
                )
        }
        _ => false,
    }
}

fn create_envelope_error(account_id: AccountId, detail: String) -> BatchError {
    BatchError::WaveCreateEnvelope { account_id, detail }
}

fn validate_operation_indices(
    entities: &[EntityWaveOps],
    previous: Option<u64>,
) -> Result<Option<u64>, BatchError> {
    let mut last = previous;
    for operation_index in entities
        .iter()
        .flat_map(|entity| entity.ops.iter().map(WaveOp::operation_index))
    {
        if last.is_some_and(|last| operation_index <= last) {
            return Err(BatchError::OperationIndex {
                actual: operation_index,
                after: last,
            });
        }
        last = Some(operation_index);
    }
    Ok(last)
}

fn validate_terminal_replay(
    key: StageKey,
    expected_accepted_stage_ordinal: u64,
    context: &EntityStageContext,
    terminal: &TerminalEntityStage,
) -> Result<(), BatchError> {
    if terminal.begin_ordinal != expected_accepted_stage_ordinal {
        return Err(BatchError::EntityStageOrdinal {
            actual: expected_accepted_stage_ordinal,
            expected: terminal.begin_ordinal,
        });
    }
    if terminal.context != *context {
        return Err(BatchError::EntityStageReplay {
            key,
            detail: "context",
        });
    }
    Ok(())
}

pub(crate) fn proposable(account: &AccountConsensus) -> Result<bool, BatchError> {
    if account.replica().settlement_workspace_present() {
        return Err(BatchError::ProposabilitySettlementUnrepresented);
    }
    if account.pending().is_some() {
        return Ok(false);
    }
    let active = match account
        .replica()
        .envelope()
        .fields()
        .iter()
        .find(|(name, _)| name == "status")
        .map(|(_, value)| value)
    {
        None => true,
        Some(CanonicalValue::String(value)) => value == "active",
        Some(_) => false,
    };
    if !active {
        return Ok(false);
    }
    let locks_full = account.replica().state().htlc_slots_full();
    Ok(account
        .mempool()
        .iter()
        .any(|tx| !locks_full || !matches!(tx, AccountTx::HtlcLock(_))))
}

/// Rebuild one restored account using the same canonical path as the legacy
/// forest. Resident workers call this before taking ownership of the value;
/// keeping the constructor here prevents the two stores from drifting on
/// pending-frame replay or swap-market validation.
pub(crate) fn restore_seed_account(
    seed: AccountSeed,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> Result<(AccountId, AccountConsensus, [u8; 32]), BatchError> {
    let account_id = seed.account_id;
    let account = match seed.consensus {
        None => AccountConsensus::new(seed.replica),
        Some(snapshot) => {
            AccountConsensus::restore_from_checkpoint(seed.replica, snapshot, swap_market).map_err(
                |error| BatchError::SeedRestore {
                    account_id,
                    detail: error.to_string(),
                },
            )?
        }
    };
    let leaf = leaf_root(account_id, &account)?;
    Ok((account_id, account, leaf))
}

pub(crate) struct RestoredCheckpointAccount {
    pub account_id: AccountId,
    pub account: AccountConsensus,
    pub leaf: [u8; 32],
    pub owner: [u8; 32],
    pub signer_id: String,
}

/// Reconstruct and authenticate one exact checkpoint row. Both resident and
/// legacy forests use this one path, so pending-frame replay, retained Hanko
/// validation, and the claimed leaf cannot drift between restore backends.
pub(crate) fn restore_checkpoint_account(
    row: AccountRestore,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> Result<RestoredCheckpointAccount, BatchError> {
    let account_id = row.account_id;
    let owner = *row.replica.owner().as_bytes();
    if let Some(pending) = row.consensus.pending.as_ref() {
        xln_rscore_engine::verify_frame_hanko(&pending.hanko, &pending.state_hash, &owner)
            .map_err(|error| state_error(account_id, &error))?;
    }
    if let (Some(current), Some(counterparty_hanko)) = (
        row.consensus.current.as_ref(),
        row.consensus.counterparty_frame_hanko.as_ref(),
    ) {
        xln_rscore_engine::verify_frame_hanko(
            counterparty_hanko,
            &current.state_hash,
            row.replica.counterparty().as_bytes(),
        )
        .map_err(|error| state_error(account_id, &error))?;
    }
    if let (Some(current), Some(local_hanko)) = (
        row.consensus.current.as_ref(),
        row.consensus.local_committed_frame_hanko.as_ref(),
    ) {
        xln_rscore_engine::verify_frame_hanko(local_hanko, &current.state_hash, &owner)
            .map_err(|error| state_error(account_id, &error))?;
    }
    let claimed_leaf = row.account_leaf;
    let account =
        AccountConsensus::restore_from_checkpoint(row.replica, row.consensus, swap_market)
            .map_err(|error| state_error(account_id, &error))?;
    let leaf = leaf_root(account_id, &account)?;
    if leaf != claimed_leaf {
        return Err(BatchError::CheckpointAccountLeaf {
            account_id,
            actual: hex_of(&leaf),
            expected: hex_of(&claimed_leaf),
        });
    }
    Ok(RestoredCheckpointAccount {
        account_id,
        account,
        leaf,
        owner,
        signer_id: row.signer_id,
    })
}

/// Construct the exact local H=0 shell for a previously unknown peer, using
/// owner policy for every field the peer is not allowed to choose. This value
/// is only a replay candidate: the caller must authenticate and commit the H=1
/// frame before inserting it into the resident forest.
pub(crate) fn inbound_genesis_account(
    account_id: AccountId,
    owner_entity_id: [u8; 32],
    input: &AccountPeerInput,
    policy: &crate::EntityAccountGenesisPolicy,
) -> Result<AccountConsensus, BatchError> {
    if policy.public_pinned {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "PUBLIC_PINNED_FORBIDDEN".to_string(),
        });
    }
    let envelope = &input.envelope;
    if envelope.from_entity_id != *account_id.as_bytes()
        || envelope.to_entity_id != owner_entity_id
        || envelope.from_entity_id == envelope.to_entity_id
    {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "PARTIES".to_string(),
        });
    }
    if envelope.domain != policy.expected_domain {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "DOMAIN_POLICY".to_string(),
        });
    }
    let Some(watch_seed) = envelope.watch_seed.clone() else {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "WATCH_SEED_REQUIRED".to_string(),
        });
    };
    let frame_height = match &input.kind {
        AccountInputKind::Frame(frame) | AccountInputKind::FrameAck { frame, .. } => {
            frame.frame.height
        }
        AccountInputKind::Ack(_)
        | AccountInputKind::Dispute(_)
        | AccountInputKind::BoardHankoRefresh(_) => {
            return Err(BatchError::InboundGenesis {
                account_id,
                detail: "FRAME_REQUIRED".to_string(),
            });
        }
    };
    if frame_height != 1 {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "HEIGHT_NOT_ONE".to_string(),
        });
    }
    let owner = parse_entity_id(owner_entity_id).map_err(|_| BatchError::InboundGenesis {
        account_id,
        detail: "OWNER_ID".to_string(),
    })?;
    let peer =
        parse_entity_id(envelope.from_entity_id).map_err(|_| BatchError::InboundGenesis {
            account_id,
            detail: "PEER_ID".to_string(),
        })?;
    let (left, right) = if owner < peer {
        (owner.clone(), peer)
    } else {
        (peer, owner.clone())
    };
    let identity = AccountIdentity::new(policy.expected_domain.clone(), left, right, watch_seed)
        .map_err(|error| state_error(account_id, &error))?;
    let state = AccountState::new(identity, envelope.dispute_config, Vec::new())
        .map_err(|error| state_error(account_id, &error))?;
    let mut replica =
        AccountReplica::new(owner, state).map_err(|error| state_error(account_id, &error))?;
    replica.set_delta_transformer(policy.delta_transformer);
    let policy_root = format!("0x{}", hex_of(&policy.shadow_policy_root));
    let fields = genesis_envelope_fields(&replica, false, &policy_root);
    let full_envelope = AccountEnvelope::new(fields, Vec::new())
        .map_err(|error| create_envelope_error(account_id, error.to_string()))?;
    replica.set_envelope(full_envelope);
    validate_genesis_seed(
        owner_entity_id,
        &AccountSeed {
            account_id,
            replica,
            consensus: None,
        },
    )
}

fn parse_entity_id(bytes: [u8; 32]) -> Result<xln_rscore_engine::EntityId, StateError> {
    xln_rscore_engine::EntityId::parse(&format!("0x{}", hex_of(&bytes)))
}

/// Derive and verify the sole signer identity accepted by both Account stores.
/// The key is usable only when it actually defines this lazy Entity; accepting
/// an arbitrary owner here would produce valid signatures for the wrong board.
pub(crate) fn build_signing_identity(
    entity_id: [u8; 32],
    private_key: [u8; 32],
    signer_id: &str,
) -> Result<SigningIdentity, BatchError> {
    let identity = SigningIdentity::from_key(
        private_key,
        signer_id,
        entity_id,
        1,
        1,
        BoardDelays::default(),
    );
    if !identity.binds_lazy_entity() {
        return Err(BatchError::SignerUnknownEntity {
            entity_id: hex_of(&entity_id),
        });
    }
    Ok(identity)
}

/// The leaf commits the consensus state too, so a queued transaction or a new
/// frame moves the tree even when the financial root did not change.
pub(crate) fn leaf_root(
    account_id: AccountId,
    account: &AccountConsensus,
) -> Result<[u8; 32], BatchError> {
    account
        .entity_account_leaf()
        .map_err(|error| BatchError::AccountsTree {
            account_id,
            detail: error.to_string(),
        })
}

pub(crate) fn state_error(account_id: AccountId, error: &StateError) -> BatchError {
    BatchError::AccountsTree {
        account_id,
        detail: error.to_string(),
    }
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// The account id a tree key names. The tree is keyed by the id itself, so a
/// key of any other width is a corrupt tree rather than an unknown account.
fn account_id_of(key: &[u8]) -> Result<AccountId, BatchError> {
    let bytes: [u8; 32] = key
        .try_into()
        .map_err(|_| BatchError::CheckpointAccountKey { width: key.len() })?;
    Ok(AccountId::from_bytes(bytes))
}
