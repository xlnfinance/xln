//! The account replica as consensus sees it: financial state plus the frames
//! and the mempool around it.
//!
//! Parity target: the `AccountReplica` fields in core/types/account.ts that
//! Account consensus owns — `mempool`, `pendingFrame`, `currentFrame`,
//! `currentHeight`, `rollbackCount`, `lastRollbackFrameHash`. The financial
//! state stays in `AccountReplica` so executing a transaction never copies the
//! queue.

use xln_rscore_protocol::CanonicalValue;

use crate::consensus::frame::hash::{AccountFrame, GENESIS_PREV_FRAME_HASH, canonical_tx_value};
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
    pub(crate) fn commit(
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
        self.last_rollback_frame_hash = None;
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
        let Some(pending) = self.pending.take() else {
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
        AccountEnvelope::new(fields, mempool)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }
}

/// Projection fields the engine derives from its own consensus state. A
/// carried copy of any of them would let the authority's view of the queue or
/// the chain head override what this engine actually holds.
const DERIVED_CONSENSUS_FIELDS: [&str; 5] = [
    "currentHeight",
    "rollbackCount",
    "currentFrameHash",
    "pendingFrameHash",
    "lastRollbackFrameHash",
];

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
