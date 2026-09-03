mod authorization;
mod build;
mod command_codec;
mod hash;
mod nonce;
mod value;

use std::collections::BTreeMap;

use num_bigint::BigInt;
use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use crate::LocalEntityTx;

pub use authorization::{assert_signed_entity_command, current_entity_command_board_hash};
pub use build::build_locally_authored_entity_command;
pub(crate) use command_codec::decode_collective_action_txs;
pub use command_codec::decode_signed_entity_command;
pub use nonce::{
    advance_entity_command_nonce, canonical_entity_command_nonces, get_entity_command_disposition,
    normalize_entity_command_nonce_board,
};

pub const UNREGISTERED_ENTITY_COMMAND_STACK_KEY: &str =
    "0xd9deb58ff75c6e30231830f739940f9f5c39f2856a5fc9a469e02e908015f824";
pub(super) const ENTITY_COMMAND_DOMAIN: &str = "xln:entity-command:binary";
pub(super) const ENTITY_PROPOSAL_ACTION_DOMAIN: &str = "xln:entity-proposal-action:v1";
pub(super) const MAX_ENTITY_COMMAND_TXS: usize = 10_000;
pub(super) const MAX_ENTITY_COMMAND_BYTES: usize = 100_000_000;
pub(super) const MAX_ENTITY_COMMAND_SIGNERS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityCommandNonceRecord {
    pub nonce: BigInt,
    pub command_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityCommandNonceState {
    pub version: u8,
    pub board_hash: String,
    pub board_epoch: u64,
    pub by_signer: BTreeMap<String, EntityCommandNonceRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedEntityCommandV1 {
    pub version: u8,
    pub entity_id: String,
    pub stack_key: String,
    pub board_hash: String,
    pub board_epoch: u64,
    pub author_signer_id: String,
    pub author_signer: String,
    pub nonce: BigInt,
    pub txs_hash: String,
    pub txs: Vec<CanonicalValue>,
    pub signature: [u8; 65],
    pub command_hash: String,
    /// Exact single-signer proposal actions. The signed wrapper, not these
    /// derived rows, remains the Entity-frame transaction.
    pub native_txs: Vec<LocalEntityTx>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityCommandBoard {
    pub board_hash: String,
    pub board_epoch: u64,
    pub stack_key: String,
    pub signer_id: String,
    pub signer: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityCommandDisposition {
    Next,
    Retry,
    Cancel,
}

/// Exact TypeScript `isIndividualEntityCommandTx` classification. All other
/// non-protocol Entity transactions require one collective proposal action.
pub const fn is_individual_entity_command_tx_kind(kind: crate::EntityTxKind) -> bool {
    matches!(
        kind,
        crate::EntityTxKind::Chat
            | crate::EntityTxKind::MaterializeCrossJurisdictionClear
            | crate::EntityTxKind::MaterializeCrossJurisdictionSwap
            | crate::EntityTxKind::Propose
            | crate::EntityTxKind::Vote
    )
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum EntityCommandError {
    #[error("{0}")]
    Invalid(String),
}

pub(super) fn invalid(detail: impl Into<String>) -> EntityCommandError {
    EntityCommandError::Invalid(detail.into())
}

#[cfg(test)]
mod tests;
