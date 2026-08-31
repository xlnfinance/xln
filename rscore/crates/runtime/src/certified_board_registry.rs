//! Restored Entity-certified board authority used by Account verification.
//!
//! The registry is built only from the Entity checkpoint graph. Account input
//! bytes never select or supply a board, and a missing exact record means the
//! peer is a lazy Entity rather than an implicit compatibility fallback.

use std::collections::BTreeMap;

use xln_rscore_batch::{AccountInputBoardAuthority, BatchError, CertifiedBoardAuthorityResolver};
use xln_rscore_engine::CertifiedBoardAuthority;

#[derive(Clone, Debug, Default)]
pub struct CertifiedBoardRegistry {
    stack_key: Option<[u8; 32]>,
    root: Option<[u8; 32]>,
    authorities: BTreeMap<[u8; 32], CertifiedBoardAuthority>,
    command_boards: BTreeMap<[u8; 32], EntityCommandCertifiedBoard>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntityCommandCertifiedBoard {
    pub board_hash: [u8; 32],
    pub board_epoch: u64,
}

impl CertifiedBoardRegistry {
    pub fn empty() -> Self {
        Self::default()
    }

    pub(crate) fn restored(
        stack_key: [u8; 32],
        root: [u8; 32],
        authorities: BTreeMap<[u8; 32], CertifiedBoardAuthority>,
        command_boards: BTreeMap<[u8; 32], EntityCommandCertifiedBoard>,
    ) -> Self {
        Self {
            stack_key: Some(stack_key),
            root: Some(root),
            authorities,
            command_boards,
        }
    }

    pub fn stack_key(&self) -> Option<&[u8; 32]> {
        self.stack_key.as_ref()
    }

    pub fn root(&self) -> Option<&[u8; 32]> {
        self.root.as_ref()
    }

    pub fn len(&self) -> usize {
        self.authorities.len()
    }

    pub fn is_empty(&self) -> bool {
        self.authorities.is_empty()
    }

    /// Exact currently registered board accepted by Depository for outer
    /// `processBatch` authorization. Historical boards are deliberately not
    /// returned: their seven-day window is dispute evidence only.
    pub fn current_board_hash(&self, entity_id: &[u8; 32]) -> Option<[u8; 32]> {
        self.authorities
            .get(entity_id)
            .map(|authority| authority.registered_board_hash)
    }

    pub(crate) fn current_authority(
        &self,
        entity_id: &[u8; 32],
    ) -> Option<CertifiedBoardAuthority> {
        self.authorities.get(entity_id).copied()
    }

    pub(crate) fn entity_command_board(
        &self,
        entity_id: &[u8; 32],
    ) -> Option<EntityCommandCertifiedBoard> {
        self.command_boards.get(entity_id).copied()
    }
}

impl CertifiedBoardAuthorityResolver for CertifiedBoardRegistry {
    type Error = BatchError;

    fn resolve_certified_board(
        &self,
        peer_entity_id: &[u8; 32],
    ) -> Result<AccountInputBoardAuthority, Self::Error> {
        Ok(match self.authorities.get(peer_entity_id) {
            Some(authority) => AccountInputBoardAuthority::Certified(*authority),
            None => AccountInputBoardAuthority::Lazy,
        })
    }
}
