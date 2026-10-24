//! Entity-certified board authority read by Account verification.
//!
//! The authority is resolved straight from the Entity-committed
//! `certified_board_state`, the same tree the checkpoint graph is projected
//! from. Nothing is copied into the live replica, so a `BoardActivated`
//! committed by frame N is visible to frame N+1 inside the same process,
//! exactly like the TypeScript `resolveObserverCertifiedBoardRecord`.
//! Account input bytes never select or supply a board, and a missing exact
//! record means the peer is a lazy Entity rather than an implicit
//! compatibility fallback.

use xln_rscore_batch::{AccountInputBoardAuthority, BatchError, CertifiedBoardAuthorityResolver};
use xln_rscore_engine::CertifiedBoardAuthority;
use xln_rscore_entity_kernel::{CertifiedBoardRecord, CertifiedBoardState};

/// Borrowed view over one Entity's committed certified board tree. It owns no
/// records: every lookup reads the committed state, so the live process can
/// never answer with a board that a committed rotation already replaced.
#[derive(Clone, Copy, Debug, Default)]
pub struct CertifiedBoardAuthorityView<'a> {
    state: Option<&'a CertifiedBoardState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntityCommandCertifiedBoard {
    pub board_hash: [u8; 32],
    pub board_epoch: u64,
}

fn certified_authority(record: &CertifiedBoardRecord) -> CertifiedBoardAuthority {
    CertifiedBoardAuthority {
        entity_id: record.entity_id,
        registered_board_hash: record.board_hash,
        previous_board_hash: record.previous_board_hash,
        previous_board_valid_until: record.previous_board_valid_until,
        board_epoch: record.board_epoch,
    }
}

impl<'a> CertifiedBoardAuthorityView<'a> {
    pub fn new(state: Option<&'a CertifiedBoardState>) -> Self {
        Self { state }
    }

    pub fn stack_key(&self) -> Option<[u8; 32]> {
        self.state.map(|state| state.stack_key)
    }

    pub fn root(&self) -> Option<[u8; 32]> {
        self.state.map(|state| state.board_registry_root)
    }

    fn record(&self, entity_id: &[u8; 32]) -> Option<&'a CertifiedBoardRecord> {
        self.state?.resolve(entity_id)
    }

    /// Exact currently registered board accepted by Depository for outer
    /// `processBatch` authorization. Historical boards are deliberately not
    /// returned: their seven-day window is dispute evidence only.
    pub fn current_board_hash(&self, entity_id: &[u8; 32]) -> Option<[u8; 32]> {
        self.record(entity_id).map(|record| record.board_hash)
    }

    pub(crate) fn current_authority(
        &self,
        entity_id: &[u8; 32],
    ) -> Option<CertifiedBoardAuthority> {
        self.record(entity_id).map(certified_authority)
    }

    pub(crate) fn entity_command_board(
        &self,
        entity_id: &[u8; 32],
    ) -> Option<EntityCommandCertifiedBoard> {
        self.record(entity_id)
            .map(|record| EntityCommandCertifiedBoard {
                board_hash: record.board_hash,
                board_epoch: record.board_epoch,
            })
    }
}

impl CertifiedBoardAuthorityResolver for CertifiedBoardAuthorityView<'_> {
    type Error = BatchError;

    fn resolve_certified_board(
        &self,
        peer_entity_id: &[u8; 32],
    ) -> Result<AccountInputBoardAuthority, Self::Error> {
        Ok(match self.record(peer_entity_id) {
            Some(record) => AccountInputBoardAuthority::Certified(certified_authority(record)),
            None => AccountInputBoardAuthority::Lazy,
        })
    }
}
