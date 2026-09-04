//! Canonical logical values for the permanent Entity storage graph.
//!
//! This boundary deliberately stops before MessagePack and physical keys. The
//! storage owner can chunk scalar values and build Patricia nodes without
//! acquiring a second serializer for Entity-owned consensus data.

use std::collections::BTreeMap;

use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use crate::commitment::{
    CanonicalOrderbookStorageFields, canonical_orderbook_storage_fields, canonical_paybook_entry,
    canonical_profile, canonical_reserves, canonical_swap_trading_pairs, hex, number,
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
    pub proposals: CanonicalValue,
    pub entity_provider_action_state: Option<CanonicalValue>,
    pub entity_encryption_public_key: CanonicalValue,
    pub profile: CanonicalValue,
    pub config: CanonicalValue,
    pub leader_state: CanonicalValue,
    pub reserves: CanonicalValue,
    pub external_wallet: Option<CanonicalValue>,
    pub out_debts_by_token: Option<CanonicalValue>,
    pub in_debts_by_token: Option<CanonicalValue>,
    pub swap_trading_pairs: Option<CanonicalValue>,
    pub last_finalized_j_height: CanonicalValue,
    pub j_history_finality: Option<CanonicalValue>,
    pub certified_board_state: Option<CanonicalValue>,
    pub crontab_state: Option<CanonicalValue>,
    pub j_batch_state: Option<CanonicalValue>,
    pub paybook: CanonicalValue,
    pub hub_rebalance_config: Option<CanonicalValue>,
    pub orderbook_hub_profile: Option<CanonicalValue>,
    pub orderbook_referrals: Option<CanonicalValue>,
    pub orderbook_pair_dimensions: Option<CanonicalValue>,
    pub lending: Option<CanonicalValue>,
    /// Logical namespace 1 leaves, before text-key framing and Patricia layout.
    pub paybook_entries: BTreeMap<String, CanonicalValue>,
    /// Logical namespace 7 leaves, before text-key framing and Patricia layout.
    pub crontab_hooks: BTreeMap<String, CanonicalValue>,
    pub deferred_account_proposals: BTreeMap<String, CanonicalValue>,
    pub deferred_account_proposals_present: bool,
    pub settlement_continuations: BTreeMap<String, CanonicalValue>,
    pub settlement_continuations_present: bool,
    pub cross_jurisdiction_swaps: BTreeMap<String, CanonicalValue>,
    pub cross_jurisdiction_swaps_present: bool,
    pub cross_jurisdiction_authorizations: BTreeMap<String, CanonicalValue>,
    pub cross_jurisdiction_authorizations_present: bool,
    pub cross_jurisdiction_book_admissions: BTreeMap<String, CanonicalValue>,
    pub cross_jurisdiction_book_admissions_present: bool,
}

impl EntityStorageProjection {
    /// Present permanent 0x36 fields in ascending immutable tag order.
    pub fn scalar_fields(&self) -> impl Iterator<Item = (u8, &CanonicalValue)> {
        [
            Some((1, &self.entity_id)),
            Some((2, &self.height)),
            Some((3, &self.timestamp)),
            self.entity_command_nonces.as_ref().map(|value| (5, value)),
            Some((6, &self.proposals)),
            Some((7, &self.config)),
            Some((9, &self.leader_state)),
            Some((10, &self.reserves)),
            self.external_wallet.as_ref().map(|value| (11, value)),
            Some((14, &self.last_finalized_j_height)),
            self.j_history_finality.as_ref().map(|value| (15, value)),
            self.certified_board_state.as_ref().map(|value| (16, value)),
            self.crontab_state.as_ref().map(|value| (17, value)),
            self.j_batch_state.as_ref().map(|value| (18, value)),
            self.entity_provider_action_state
                .as_ref()
                .map(|value| (19, value)),
            Some((20, &self.entity_encryption_public_key)),
            Some((21, &self.profile)),
            Some((22, &self.paybook)),
            self.out_debts_by_token.as_ref().map(|value| (26, value)),
            self.in_debts_by_token.as_ref().map(|value| (27, value)),
            self.swap_trading_pairs.as_ref().map(|value| (29, value)),
            self.hub_rebalance_config.as_ref().map(|value| (34, value)),
            self.orderbook_hub_profile.as_ref().map(|value| (35, value)),
            self.orderbook_referrals.as_ref().map(|value| (36, value)),
            self.orderbook_pair_dimensions
                .as_ref()
                .map(|value| (37, value)),
            self.lending.as_ref().map(|value| (38, value)),
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

fn project_paybook_entries(
    state: &EntityStateSlice,
) -> Result<BTreeMap<String, CanonicalValue>, EntityKernelError> {
    state
        .paybook
        .entries
        .iter()
        .map(|(_, entry)| Ok((entry.hashlock.clone(), canonical_paybook_entry(entry)?)))
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

fn decode_text_key(key: &[u8]) -> Result<String, EntityKernelError> {
    let length = key
        .get(..2)
        .and_then(|value| <[u8; 2]>::try_from(value).ok())
        .map(u16::from_be_bytes)
        .map(usize::from)
        .ok_or_else(|| EntityKernelError::CommitmentEncoding {
            detail: "ENTITY_COLLECTION_KEY_PREFIX".into(),
        })?;
    let payload = key
        .get(2..)
        .filter(|value| value.len() == length)
        .ok_or_else(|| EntityKernelError::CommitmentEncoding {
            detail: "ENTITY_COLLECTION_KEY_LENGTH".into(),
        })?;
    String::from_utf8(payload.to_vec()).map_err(|error| EntityKernelError::CommitmentEncoding {
        detail: format!("ENTITY_COLLECTION_KEY_UTF8:{error}"),
    })
}

fn project_collection(
    collection: Option<&crate::EntityCanonicalCollection>,
) -> Result<BTreeMap<String, CanonicalValue>, EntityKernelError> {
    collection
        .into_iter()
        .flat_map(|collection| collection.keyed_values())
        .map(|(key, value)| Ok((decode_text_key(key)?, value.clone())))
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
    let (config, leader_state) = consensus.state.authority.storage_values()?;
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
        proposals: crate::canonical_entity_proposals(&state.proposals)?,
        entity_provider_action_state: state
            .entity_provider_action_state
            .as_ref()
            .map(crate::canonical_entity_provider_action_state)
            .transpose()?,
        entity_encryption_public_key: CanonicalValue::String(hex(
            &state.entity_encryption_public_key
        )),
        profile: canonical_profile(&state.profile),
        config,
        leader_state,
        reserves: canonical_reserves(state),
        external_wallet: state
            .external_wallet
            .as_ref()
            .map(crate::canonical_external_wallet)
            .transpose()?,
        out_debts_by_token: state
            .out_debts_by_token
            .as_ref()
            .map(crate::canonical_debt_ledger)
            .transpose()?,
        in_debts_by_token: state
            .in_debts_by_token
            .as_ref()
            .map(crate::canonical_debt_ledger)
            .transpose()?,
        swap_trading_pairs: state
            .swap_trading_pairs
            .as_deref()
            .map(canonical_swap_trading_pairs)
            .transpose()?,
        last_finalized_j_height: number("lastFinalizedJHeight", state.last_finalized_j_height)?,
        j_history_finality: state.j_history_finality.clone(),
        certified_board_state: state
            .certified_board_state
            .as_ref()
            .map(crate::canonical_certified_board_state)
            .transpose()?,
        crontab_state: state
            .crontab
            .as_ref()
            .map(canonical_crontab_storage_state)
            .transpose()?,
        j_batch_state: state
            .j_batch_state
            .as_ref()
            .map(crate::canonical_j_batch_state)
            .transpose()
            .map_err(|error| EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?,
        paybook: CanonicalValue::Object(vec![(
            "feesEarned".to_string(),
            CanonicalValue::BigInt(state.paybook.fees_earned.clone()),
        )]),
        hub_rebalance_config: state.hub_rebalance_config.clone(),
        orderbook_hub_profile: orderbook.as_ref().map(|value| value.hub_profile.clone()),
        orderbook_referrals: orderbook.as_ref().map(|value| value.referrals.clone()),
        orderbook_pair_dimensions: orderbook.map(|value| value.pair_dimensions),
        lending: state
            .lending
            .as_ref()
            .map(crate::canonical_lending_state)
            .transpose()?,
        paybook_entries: project_paybook_entries(state)?,
        crontab_hooks: project_crontab_hooks(state)?,
        deferred_account_proposals: project_collection(state.deferred_account_proposals.as_ref())?,
        deferred_account_proposals_present: state.deferred_account_proposals.is_some(),
        settlement_continuations: project_collection(state.settlement_continuations.as_ref())?,
        settlement_continuations_present: state.settlement_continuations.is_some(),
        cross_jurisdiction_swaps: project_collection(state.cross_jurisdiction_swaps.as_ref())?,
        cross_jurisdiction_swaps_present: state.cross_jurisdiction_swaps.is_some(),
        cross_jurisdiction_authorizations: project_collection(
            state.cross_jurisdiction_authorizations.as_ref(),
        )?,
        cross_jurisdiction_authorizations_present: state
            .cross_jurisdiction_authorizations
            .is_some(),
        cross_jurisdiction_book_admissions: project_collection(
            state.cross_jurisdiction_book_admissions.as_ref(),
        )?,
        cross_jurisdiction_book_admissions_present: state
            .cross_jurisdiction_book_admissions
            .is_some(),
    })
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
