//! The account replica as consensus sees it: financial state plus the frames
//! and the mempool around it.
//!
//! Parity target: the `AccountReplica` fields in core/types/account.ts that
//! Account consensus owns — `mempool`, `pendingFrame`, `currentFrame`,
//! `currentHeight`, `rollbackCount`, `lastRollbackFrameHash`. The financial
//! state stays in `AccountReplica` so executing a transaction never copies the
//! queue.

use xln_rscore_protocol::CanonicalValue;

use crate::consensus::frame::hash::{
    AccountFrame, GENESIS_PREV_FRAME_HASH, canonical_tx_value, is_frame_hashable, unsupported_kind,
};
use crate::consensus::proposal::propose::{WindowExecution, execute_window};
use crate::error::StateError;
use crate::input::mempool::{
    assert_mempool_admission, assert_mempool_within_limit, is_deduplicated_on_restore,
};
use crate::state::account_replica_shell::AccountEnvelope;
use crate::{AccountReplica, AccountTx};

/// A frame both sides have committed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedFrame {
    pub height: u64,
    pub state_hash: [u8; 32],
    pub timestamp: u64,
    pub j_height: u64,
}

/// Our own proposal, signed and sent, waiting for the peer's ack. The
/// candidate is the state it commits to, kept so the ack applies without
/// replaying the frame.
#[derive(Clone)]
pub struct PendingFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    pub(crate) candidate: AccountReplica,
}

#[derive(Clone)]
pub struct AccountConsensus {
    replica: AccountReplica,
    mempool: Vec<AccountTx>,
    pending: Option<PendingFrame>,
    current: Option<CommittedFrame>,
    rollback_count: u64,
    last_rollback_frame_hash: Option<[u8; 32]>,
    /// The counterparty's signature over the committed frame — their proposal
    /// Hanko when we accepted their frame, their ack when they accepted ours.
    /// It is the second half of the bilateral certificate, so a later board
    /// rotation can still prove both parties committed this height.
    counterparty_frame_hanko: Option<Vec<u8>>,
    /// The leaf commits the Hanko's digest. A Hanko is ~1.4 KB of hex and the
    /// leaf is recomputed on every tree put, so the digest is taken once, when
    /// the Hanko is stored — exact by identity, like the memo TypeScript keys
    /// on the Hanko string.
    counterparty_frame_hanko_digest: Option<String>,
}

impl AccountConsensus {
    pub fn new(replica: AccountReplica) -> Self {
        Self {
            replica,
            mempool: Vec::new(),
            pending: None,
            current: None,
            rollback_count: 0,
            last_rollback_frame_hash: None,
            counterparty_frame_hanko: None,
            counterparty_frame_hanko_digest: None,
        }
    }

    pub const fn replica(&self) -> &AccountReplica {
        &self.replica
    }

    pub fn mempool(&self) -> &[AccountTx] {
        &self.mempool
    }

    pub const fn pending(&self) -> Option<&PendingFrame> {
        self.pending.as_ref()
    }

    pub const fn current(&self) -> Option<&CommittedFrame> {
        self.current.as_ref()
    }

    pub fn current_height(&self) -> u64 {
        self.current.as_ref().map_or(0, |frame| frame.height)
    }

    pub const fn rollback_count(&self) -> u64 {
        self.rollback_count
    }

    /// What the next frame chains to: the literal `genesis` before any frame
    /// is committed, otherwise the committed frame's own hash.
    pub fn prev_frame_hash(&self) -> String {
        self.current.as_ref().map_or_else(
            || GENESIS_PREV_FRAME_HASH.to_string(),
            |frame| format!("0x{}", hex_of(&frame.state_hash)),
        )
    }

    /// Admit local intentions. The limit counts the proposed frame too, so an
    /// unresponsive peer cannot be used to grow the queue.
    pub fn admit_txs(
        &mut self,
        txs: Vec<AccountTx>,
        context: &'static str,
    ) -> Result<(), StateError> {
        assert_mempool_admission(
            self.mempool.len(),
            self.pending_tx_count(),
            txs.len(),
            context,
        )?;
        // A transaction the frame hash cannot express must never enter the
        // queue: it would fail every later proposal and every leaf digest,
        // with nothing to remove it.
        for tx in &txs {
            if !is_frame_hashable(tx) {
                return Err(StateError::UnsupportedFrameTx(unsupported_kind(tx)));
            }
        }
        self.mempool.extend(txs);
        Ok(())
    }

    fn pending_tx_count(&self) -> usize {
        self.pending
            .as_ref()
            .map_or(0, |pending| pending.frame.txs.len())
    }

    /// Take the whole queue as the proposal window. The caller returns what it
    /// could not use.
    pub(crate) fn take_mempool(&mut self) -> Vec<AccountTx> {
        std::mem::take(&mut self.mempool)
    }

    pub(crate) fn restore_mempool_front(&mut self, txs: Vec<AccountTx>) -> Result<(), StateError> {
        if txs.is_empty() {
            return Ok(());
        }
        let mut next = txs;
        next.extend(std::mem::take(&mut self.mempool));
        assert_mempool_within_limit(next.len(), 0, "accountConsensus:restore")?;
        self.mempool = next;
        Ok(())
    }

    pub(crate) fn set_pending(&mut self, pending: PendingFrame) {
        self.pending = Some(pending);
    }

    /// Commit a frame: the candidate becomes live state and the frame becomes
    /// the chain head.
    /// Commit the counterparty's frame. Their proposal Hanko is the
    /// certificate; the rollback bookkeeping is untouched, because accepting
    /// their frame is not what settles a collision we lost.
    ///
    /// Parity target: the receiver commit in core/account/consensus/index.ts,
    /// which sets `counterpartyFrameHanko` and leaves `rollbackCount` and
    /// `lastRollbackFrameHash` alone.
    pub(crate) fn commit_from_peer(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
        counterparty_hanko: Vec<u8>,
    ) {
        self.install_commit(candidate, frame, state_hash);
        self.store_counterparty_hanko(counterparty_hanko);
    }

    /// Commit our own frame on the peer's ack. Their ack is the certificate,
    /// and one rollback is settled by it.
    ///
    /// Parity target: `installPendingFrameCommit`
    /// (core/account/consensus/incoming/ack-commit.ts):
    /// `rollbackCount = max(0, rollbackCount - 1)`, and the rollback hash is
    /// dropped only when the count reaches zero.
    pub(crate) fn commit_from_ack(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
    ) {
        self.install_commit(candidate, frame, state_hash);
        self.store_counterparty_hanko(ack_hanko);
        self.rollback_count = self.rollback_count.saturating_sub(1);
        if self.rollback_count == 0 {
            self.last_rollback_frame_hash = None;
        }
    }

    fn store_counterparty_hanko(&mut self, hanko: Vec<u8>) {
        self.counterparty_frame_hanko_digest = Some(hanko_leaf_digest(&hanko));
        self.counterparty_frame_hanko = Some(hanko);
    }

    fn install_commit(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
    ) {
        self.replica = candidate;
        self.current = Some(CommittedFrame {
            height: frame.height,
            state_hash,
            timestamp: frame.timestamp,
            j_height: frame.j_height,
        });
        self.pending = None;
    }

    /// Discard our own unacknowledged proposal and put its transactions back
    /// at the front of the queue.
    ///
    /// Parity target: `applySameHeightIncomingFrameRollback`
    /// (core/account/consensus/incoming/collision.ts). Only the RIGHT entity
    /// ever reaches it, and only because the LEFT entity's frame won the
    /// collision — never because time passed.
    pub(crate) fn rollback_pending(
        &mut self,
        winner_state_hash: [u8; 32],
    ) -> Result<usize, StateError> {
        let Some(pending) = self.pending.as_ref() else {
            return Ok(0);
        };
        let mut restored: Vec<AccountTx> = Vec::with_capacity(pending.frame.txs.len());
        for tx in &pending.frame.txs {
            let duplicate = is_deduplicated_on_restore(tx)
                && (self.mempool.iter().any(|queued| queued == tx)
                    || restored.iter().any(|queued| queued == tx));
            if duplicate {
                continue;
            }
            restored.push(tx.clone());
        }
        // The queue check comes before the proposal is discarded: a rollback
        // that failed halfway would leave the transactions in neither place.
        assert_mempool_within_limit(
            restored.len() + self.mempool.len(),
            0,
            "accountConsensus:rollback",
        )?;
        self.pending = None;
        let count = restored.len();
        self.restore_mempool_front(restored)?;
        self.rollback_count = (self.rollback_count + 1).max(1);
        self.last_rollback_frame_hash = Some(winner_state_hash);
        Ok(count)
    }

    pub(crate) const fn last_rollback_frame_hash(&self) -> Option<&[u8; 32]> {
        self.last_rollback_frame_hash.as_ref()
    }
}

/// Our own unacknowledged proposal as a checkpoint saves it: the frame and the
/// signature over it. The candidate state it commits to is not saved — it is
/// exactly what replaying the frame produces, so a restore rebuilds it and
/// checks that it still hashes to the frame the signature covers.
#[derive(Clone, Debug)]
pub struct PendingFrameSnapshot {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
}

/// Everything consensus owns for one account, in a form a database can hold.
///
/// Parity target: the replica fields `mempool`, `currentFrame`,
/// `currentHeight`, `pendingFrame`, `rollbackCount` and
/// `lastRollbackFrameHash` that core/storage/schema/account-field-tags.ts
/// persists alongside the state trees.
#[derive(Clone, Debug)]
pub struct ConsensusSnapshot {
    pub mempool: Vec<AccountTx>,
    pub current: Option<CommittedFrame>,
    pub pending: Option<PendingFrameSnapshot>,
    pub rollback_count: u64,
    pub last_rollback_frame_hash: Option<[u8; 32]>,
    /// The bilateral certificate for the committed frame. It is committed in
    /// the account leaf, so losing it across a restart would change the leaf.
    pub counterparty_frame_hanko: Option<Vec<u8>>,
}

impl AccountConsensus {
    /// What a checkpoint writes for this account, beside its state trees.
    pub fn consensus_snapshot(&self) -> ConsensusSnapshot {
        ConsensusSnapshot {
            mempool: self.mempool.clone(),
            current: self.current.clone(),
            pending: self.pending.as_ref().map(|pending| PendingFrameSnapshot {
                frame: pending.frame.clone(),
                state_hash: pending.state_hash,
                hanko: pending.hanko.clone(),
            }),
            rollback_count: self.rollback_count,
            last_rollback_frame_hash: self.last_rollback_frame_hash,
            counterparty_frame_hanko: self.counterparty_frame_hanko.clone(),
        }
    }

    /// Rebuild an account from a checkpoint: the committed replica as the
    /// database holds it, plus the consensus state around it.
    ///
    /// A pending frame is replayed rather than trusted. If the replay does not
    /// reproduce the state root and the frame hash the signature covers, the
    /// database and the frame disagree and the restore fails here rather than
    /// producing an account that would sign a fork.
    pub fn restore_from_checkpoint(
        replica: AccountReplica,
        snapshot: ConsensusSnapshot,
    ) -> Result<Self, StateError> {
        let ConsensusSnapshot {
            mempool,
            current,
            pending,
            rollback_count,
            last_rollback_frame_hash,
            counterparty_frame_hanko,
        } = snapshot;
        assert_mempool_within_limit(
            mempool.len(),
            pending
                .as_ref()
                .map_or(0, |pending| pending.frame.txs.len()),
            "accountConsensus:checkpointRestore",
        )?;
        let mut account = Self {
            replica,
            mempool,
            pending: None,
            current,
            rollback_count,
            last_rollback_frame_hash,
            counterparty_frame_hanko_digest: counterparty_frame_hanko
                .as_deref()
                .map(hanko_leaf_digest),
            counterparty_frame_hanko,
        };
        let Some(pending) = pending else {
            return Ok(account);
        };
        let expected_height = account.current_height() + 1;
        if pending.frame.height != expected_height {
            return Err(StateError::CheckpointRestore(format!(
                "PENDING_HEIGHT:{}:{expected_height}",
                pending.frame.height
            )));
        }
        if pending.frame.prev_frame_hash != account.prev_frame_hash() {
            return Err(StateError::CheckpointRestore(format!(
                "PENDING_PREV_FRAME_HASH:{}",
                pending.frame.prev_frame_hash
            )));
        }
        let candidate = replay_pending(&account.replica, &pending)?;
        account.pending = Some(PendingFrame {
            frame: pending.frame,
            state_hash: pending.state_hash,
            hanko: pending.hanko,
            candidate,
        });
        Ok(account)
    }
}

/// Replay a saved proposal against the committed replica and prove it is the
/// same frame: same transactions applied, same account state root, same hash.
fn replay_pending(
    replica: &AccountReplica,
    pending: &PendingFrameSnapshot,
) -> Result<AccountReplica, StateError> {
    let context = crate::AccountExecutionContext::new(
        pending.frame.timestamp,
        pending.frame.timestamp,
        pending.frame.j_height,
        pending.frame.height.saturating_sub(1),
        pending.frame.j_height,
    );
    let proposer = replica.owner_side();
    let WindowExecution {
        mut candidate,
        applied,
        ..
    } = execute_window(
        replica,
        proposer,
        pending.frame.txs.clone(),
        &context,
        true,
    )?;
    if applied.len() != pending.frame.txs.len() {
        return Err(StateError::CheckpointRestore(format!(
            "PENDING_TX_REJECTED:{}:{}",
            applied.len(),
            pending.frame.txs.len()
        )));
    }
    let account_state_root = candidate.refresh_account_state_root()?;
    if account_state_root != pending.frame.account_state_root {
        return Err(StateError::CheckpointRestore(
            "PENDING_STATE_ROOT_MISMATCH".to_string(),
        ));
    }
    if pending.frame.hash()? != pending.state_hash {
        return Err(StateError::CheckpointRestore(
            "PENDING_FRAME_HASH_MISMATCH".to_string(),
        ));
    }
    Ok(candidate)
}

impl AccountConsensus {
    /// The Entity's account leaf for this replica, with everything consensus
    /// owns derived rather than carried.
    ///
    /// Parity target: `projectAccountConsensusState`
    /// (core/entity/consensus/state-root.ts). The engine now owns the queue,
    /// the chain head and the frame in flight, so it projects them itself;
    /// fields it does not model yet stay carried on the replica's envelope.
    pub fn entity_account_leaf(&self) -> Result<[u8; 32], StateError> {
        let account_state_root = self.replica.state().payment_profile_account_state_root()?;
        let envelope = self.projected_envelope()?;
        envelope
            .entity_account_leaf(&account_state_root)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }

    fn projected_envelope(&self) -> Result<AccountEnvelope, StateError> {
        let mut mempool = Vec::with_capacity(self.mempool.len());
        for tx in &self.mempool {
            mempool.push(canonical_tx_value(tx)?);
        }
        let mut fields: Vec<(String, CanonicalValue)> = self
            .replica
            .envelope()
            .fields()
            .iter()
            .filter(|(name, _)| !DERIVED_CONSENSUS_FIELDS.contains(&name.as_str()))
            .cloned()
            .collect();
        fields.push((
            "currentHeight".to_string(),
            CanonicalValue::Number(self.current_height() as f64),
        ));
        fields.push((
            "rollbackCount".to_string(),
            CanonicalValue::Number(self.rollback_count as f64),
        ));
        if let Some(current) = &self.current {
            fields.push((
                "currentFrameHash".to_string(),
                CanonicalValue::String(hex_prefixed(&current.state_hash)),
            ));
        }
        if let Some(pending) = &self.pending {
            fields.push((
                "pendingFrameHash".to_string(),
                CanonicalValue::String(hex_prefixed(&pending.state_hash)),
            ));
        }
        if let Some(hash) = &self.last_rollback_frame_hash {
            fields.push((
                "lastRollbackFrameHash".to_string(),
                CanonicalValue::String(hex_prefixed(hash)),
            ));
        }
        if let Some(digest) = &self.counterparty_frame_hanko_digest {
            // The leaf commits the Hanko's digest, not its ~1.4 KB of hex.
            //
            // Parity target: `hankoLeafDigest` over `ACCOUNT_LEAF_HANKO_FIELDS`
            // (core/entity/consensus/state-root.ts): the digest is taken over
            // the UTF-8 of the `0x`-prefixed string, which is how TypeScript
            // holds a Hanko.
            fields.push((
                "counterpartyFrameHanko".to_string(),
                CanonicalValue::String(digest.clone()),
            ));
        }
        AccountEnvelope::new(fields, mempool)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }
}

impl std::fmt::Debug for AccountConsensus {
    /// A summary: the replica behind it is the state, not something a log
    /// line should carry.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountConsensus")
            .field("owner", &self.replica.owner().to_string())
            .field("currentHeight", &self.current_height())
            .field("mempool", &self.mempool.len())
            .field("pending", &self.pending.as_ref().map(|frame| frame.frame.height))
            .field("rollbackCount", &self.rollback_count)
            .finish()
    }
}

/// Projection fields the engine derives from its own consensus state. A
/// carried copy of any of them would let the authority's view of the queue or
/// the chain head override what this engine actually holds.
const DERIVED_CONSENSUS_FIELDS: [&str; 6] = [
    "counterpartyFrameHanko",
    "currentHeight",
    "rollbackCount",
    "currentFrameHash",
    "pendingFrameHash",
    "lastRollbackFrameHash",
];

/// `0x` + sha256 of the Hanko's own `0x`-prefixed hex text, which is the
/// exact preimage `computeIntegrityDigest` hashes on the TypeScript side.
fn hanko_leaf_digest(hanko: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let text = format!("0x{}", hex_of(hanko));
    let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
    hex_prefixed(&digest)
}

fn hex_prefixed(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex_of(bytes))
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
