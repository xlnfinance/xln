//! Canonical logical values for the permanent Entity storage graph.
//!
//! This boundary deliberately stops before MessagePack and physical keys. The
//! storage owner can chunk scalar values and build Patricia nodes without
//! acquiring a second serializer for Entity-owned consensus data.

use std::collections::BTreeMap;

use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use crate::commitment::{
    CanonicalOrderbookStorageFields, canonical_htlc_route, canonical_lock_entry,
    canonical_orderbook_storage_fields, canonical_reserves, number,
};
use crate::scheduler::{canonical_crontab_storage_state, canonical_hook};
use crate::{
    EntityAuthorityError, EntityKernelError, EntityStateSlice, ResidentEntityConsensusReplica,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityStorageProjection {
    pub entity_id: CanonicalValue,
    pub height: CanonicalValue,
    pub timestamp: CanonicalValue,
    pub entity_command_nonces: Option<CanonicalValue>,
    pub config: CanonicalValue,
    pub leader_state: CanonicalValue,
    pub reserves: CanonicalValue,
    pub last_finalized_j_height: CanonicalValue,
    pub crontab_state: Option<CanonicalValue>,
    pub htlc_fees_earned: CanonicalValue,
    pub orderbook_hub_profile: Option<CanonicalValue>,
    pub orderbook_referrals: Option<CanonicalValue>,
    pub orderbook_pair_dimensions: Option<CanonicalValue>,
    /// Logical namespace 1 leaves, before text-key framing and Patricia layout.
    pub htlc_routes: BTreeMap<String, CanonicalValue>,
    /// Logical namespace 2 leaves, before text-key framing and Patricia layout.
    pub lock_book: BTreeMap<String, CanonicalValue>,
    /// Logical namespace 7 leaves, before text-key framing and Patricia layout.
    pub crontab_hooks: BTreeMap<String, CanonicalValue>,
}

impl EntityStorageProjection {
    /// Present permanent 0x36 fields in ascending immutable tag order.
    pub fn scalar_fields(&self) -> impl Iterator<Item = (u8, &CanonicalValue)> {
        [
            Some((1, &self.entity_id)),
            Some((2, &self.height)),
            Some((3, &self.timestamp)),
            self.entity_command_nonces.as_ref().map(|value| (5, value)),
            Some((7, &self.config)),
            Some((9, &self.leader_state)),
            Some((10, &self.reserves)),
            Some((14, &self.last_finalized_j_height)),
            self.crontab_state.as_ref().map(|value| (17, value)),
            Some((23, &self.htlc_fees_earned)),
            self.orderbook_hub_profile.as_ref().map(|value| (35, value)),
            self.orderbook_referrals.as_ref().map(|value| (36, value)),
            self.orderbook_pair_dimensions
                .as_ref()
                .map(|value| (37, value)),
        ]
        .into_iter()
        .flatten()
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityStorageProjectionError {
    #[error(transparent)]
    Authority(#[from] EntityAuthorityError),
    #[error(transparent)]
    Kernel(#[from] EntityKernelError),
}

fn project_htlc_routes(
    state: &EntityStateSlice,
) -> Result<BTreeMap<String, CanonicalValue>, EntityKernelError> {
    state
        .htlc_routes
        .iter()
        .map(|(key, route)| Ok((key.clone(), canonical_htlc_route(route)?)))
        .collect()
}

fn project_lock_book(state: &EntityStateSlice) -> BTreeMap<String, CanonicalValue> {
    state
        .lock_book
        .iter()
        .map(|(key, lock)| (key.clone(), canonical_lock_entry(lock)))
        .collect()
}

fn project_crontab_hooks(
    state: &EntityStateSlice,
) -> Result<BTreeMap<String, CanonicalValue>, EntityKernelError> {
    let Some(crontab) = &state.crontab else {
        return Ok(BTreeMap::new());
    };
    crontab
        .hooks
        .iter()
        .map(|(key, hook)| Ok((key.clone(), canonical_hook(hook)?)))
        .collect()
}

fn project_orderbook_fields(
    state: &EntityStateSlice,
) -> Result<Option<CanonicalOrderbookStorageFields>, EntityKernelError> {
    match (&state.orderbook, &state.orderbook_metadata) {
        (Some(orderbook), Some(metadata)) => Ok(Some(canonical_orderbook_storage_fields(
            orderbook, metadata,
        )?)),
        (None, None) => Ok(None),
        _ => Err(EntityKernelError::CommitmentEncoding {
            detail: "ENTITY_ORDERBOOK_METADATA_MISMATCH".to_string(),
        }),
    }
}

/// Project one live Entity state and its consensus envelope into exact logical
/// storage values. The result owns no replica machinery and performs no I/O.
pub fn project_entity_storage(
    state: &EntityStateSlice,
    consensus: &ResidentEntityConsensusReplica,
) -> Result<EntityStorageProjection, EntityStorageProjectionError> {
    let (config, leader_state) = consensus.state.authority.state_values()?;
    let orderbook = project_orderbook_fields(state)?;
    Ok(EntityStorageProjection {
        entity_id: CanonicalValue::String(state.entity_id.clone()),
        height: number("height", state.height)?,
        timestamp: number("timestamp", state.timestamp)?,
        entity_command_nonces: state
            .entity_command_nonces
            .as_ref()
            .map(crate::canonical_entity_command_nonces)
            .transpose()
            .map_err(|error| EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?,
        config,
        leader_state,
        reserves: canonical_reserves(state),
        last_finalized_j_height: number("lastFinalizedJHeight", state.last_finalized_j_height)?,
        crontab_state: state
            .crontab
            .as_ref()
            .map(canonical_crontab_storage_state)
            .transpose()?,
        htlc_fees_earned: CanonicalValue::BigInt(state.htlc_fees_earned.clone()),
        orderbook_hub_profile: orderbook.as_ref().map(|value| value.hub_profile.clone()),
        orderbook_referrals: orderbook.as_ref().map(|value| value.referrals.clone()),
        orderbook_pair_dimensions: orderbook.map(|value| value.pair_dimensions),
        htlc_routes: project_htlc_routes(state)?,
        lock_book: project_lock_book(state),
        crontab_hooks: project_crontab_hooks(state)?,
    })
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
