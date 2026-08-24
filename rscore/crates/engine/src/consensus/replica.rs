//! The account replica as consensus sees it: financial state plus the frames
//! and the mempool around it.
//!
//! Parity target: the `AccountReplica` fields in core/types/account.ts that
//! Account consensus owns — `mempool`, `pendingFrame`, `currentFrame`,
//! `currentHeight`, `rollbackCount`, `lastRollbackFrameHash`. The financial
//! state stays in `AccountReplica` so executing a transaction never copies the
//! queue.

use crate::consensus::frame::hash::{AccountFrame, GENESIS_PREV_FRAME_HASH};
use crate::error::StateError;
use crate::input::mempool::{
    assert_mempool_admission, assert_mempool_within_limit, is_deduplicated_on_restore,
};
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

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
