//! RAM-only Runtime projection for cross-J opening cohort selection.
//!
//! Touched Entity slots are removed from the live Runtime maps while a frame
//! is applied. Callers therefore provide the current staged slots separately;
//! those always win over any same-key live slot. Nothing in this module is a
//! wire, WAL, checkpoint, or committed-state representation.

use std::collections::BTreeMap;

use xln_rscore_entity_kernel::{
    CrossJOpeningSiblingAccountView, CrossJOpeningSiblingEntityView, cross_j_opening_account_ids,
};

use super::{RuntimeEntityKey, RuntimeEntityReplica, RuntimeEntityState, RuntimeMachineError};

/// One borrowed live Entity slot. This adapter lets `apply.rs` pass its private
/// staged-slot type without exposing or duplicating that type here.
pub struct CrossJOpeningRuntimeSlot<'a> {
    pub key: &'a RuntimeEntityKey,
    pub state: &'a RuntimeEntityState,
    pub replica: &'a mut RuntimeEntityReplica,
}

impl<'a> CrossJOpeningRuntimeSlot<'a> {
    pub fn new(
        key: &'a RuntimeEntityKey,
        state: &'a RuntimeEntityState,
        replica: &'a mut RuntimeEntityReplica,
    ) -> Self {
        Self {
            key,
            state,
            replica,
        }
    }
}

fn account_id(value: &str) -> Result<xln_rscore_batch::AccountId, RuntimeMachineError> {
    let body = value.strip_prefix("0x").ok_or_else(|| {
        RuntimeMachineError::EntityStateMap(format!("CROSS_J_SIBLING_ACCOUNT_ID_INVALID:{value}"))
    })?;
    if body.len() != 64 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RuntimeMachineError::EntityStateMap(format!(
            "CROSS_J_SIBLING_ACCOUNT_ID_INVALID:{value}"
        )));
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).map_err(|_| {
            RuntimeMachineError::EntityStateMap(format!(
                "CROSS_J_SIBLING_ACCOUNT_ID_INVALID:{value}"
            ))
        })?;
    }
    Ok(xln_rscore_batch::AccountId::from_bytes(bytes))
}

fn opening_account_ids(
    state: &RuntimeEntityState,
) -> Result<Vec<xln_rscore_batch::AccountId>, RuntimeMachineError> {
    cross_j_opening_account_ids(&state.entity)
        .map_err(RuntimeMachineError::EntityFinancial)?
        .into_iter()
        .map(|account| account_id(&account))
        .collect()
}

fn collect_one(
    source: CrossJOpeningRuntimeSlot<'_>,
) -> Result<CrossJOpeningSiblingEntityView, RuntimeMachineError> {
    if source.key.entity_id != source.replica.entity_id
        || source.key.signer_id != source.replica.signer_id
        || source.state.entity.entity_id != render_entity_id(&source.key.entity_id)
    {
        return Err(RuntimeMachineError::EntityStateMap(
            "CROSS_J_SIBLING_SLOT_IDENTITY_MISMATCH".into(),
        ));
    }
    if source
        .state
        .entity
        .cross_jurisdiction_swaps
        .as_ref()
        .is_none_or(|routes| routes.is_empty())
    {
        return Ok(CrossJOpeningSiblingEntityView {
            entity_id: source.state.entity.entity_id.to_ascii_lowercase(),
            signer_id: source.replica.signer_id.clone(),
            accounts: Vec::new(),
        });
    }

    let account_ids = opening_account_ids(source.state)?;
    let resident_views = if account_ids.is_empty() {
        Vec::new()
    } else {
        source
            .replica
            .accounts
            .cross_j_opening_account_views(account_ids)?
    };
    let accounts = resident_views
        .into_iter()
        .map(|view| {
            (
                view.counterparty_entity_id.clone(),
                CrossJOpeningSiblingAccountView {
                    counterparty_entity_id: view.counterparty_entity_id,
                    mempool: view.mempool,
                    pending_frame_txs: view.pending_frame_txs,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();

    Ok(CrossJOpeningSiblingEntityView {
        entity_id: source.state.entity.entity_id.to_ascii_lowercase(),
        signer_id: source.replica.signer_id.clone(),
        accounts: accounts.into_values().collect(),
    })
}

/// Collect the exact transient sibling view with staged-first precedence.
/// Live slots are read only when the same Entity key is untouched in the
/// current Runtime frame.
pub fn collect_cross_j_opening_sibling_views<'staged, 'live>(
    staged: impl IntoIterator<Item = CrossJOpeningRuntimeSlot<'staged>>,
    live: impl IntoIterator<Item = CrossJOpeningRuntimeSlot<'live>>,
) -> Result<Vec<CrossJOpeningSiblingEntityView>, RuntimeMachineError> {
    let mut views = BTreeMap::new();
    for source in staged {
        let key = source.key.clone();
        if views.insert(key, collect_one(source)?).is_some() {
            return Err(RuntimeMachineError::EntityStateMap(
                "CROSS_J_SIBLING_STAGED_SLOT_DUPLICATE".into(),
            ));
        }
    }
    for source in live {
        if views.contains_key(source.key) {
            continue;
        }
        views.insert(source.key.clone(), collect_one(source)?);
    }
    Ok(views.into_values().collect())
}

fn render_entity_id(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::super::types::EntityPendingWork;
    use super::*;

    #[test]
    fn entity_id_rendering_is_canonical_lowercase_hex() {
        assert_eq!(
            render_entity_id(&[0xab; 32]),
            format!("0x{}", "ab".repeat(32))
        );
    }

    #[test]
    fn staged_slot_wins_before_invalid_same_key_live_fallback() -> Result<(), RuntimeMachineError> {
        let mut staged_runtime = super::super::tests::replica(super::super::RuntimeLimits::hlt())?;
        let mut live_runtime = super::super::tests::replica(super::super::RuntimeLimits::hlt())?;
        let staged_key = staged_runtime
            .state
            .e_replicas
            .keys()
            .next()
            .expect("staged key")
            .clone();
        let live_key = live_runtime
            .state
            .e_replicas
            .keys()
            .next()
            .expect("live key")
            .clone();
        live_runtime
            .e_replicas
            .get_mut(&live_key)
            .expect("live replica")
            .signer_id = "invalid-if-read".into();

        let views = collect_cross_j_opening_sibling_views(
            [CrossJOpeningRuntimeSlot::new(
                &staged_key,
                staged_runtime
                    .state
                    .e_replicas
                    .get(&staged_key)
                    .expect("staged state"),
                staged_runtime
                    .e_replicas
                    .get_mut(&staged_key)
                    .expect("staged replica"),
            )],
            [CrossJOpeningRuntimeSlot::new(
                &live_key,
                live_runtime
                    .state
                    .e_replicas
                    .get(&live_key)
                    .expect("live state"),
                live_runtime
                    .e_replicas
                    .get_mut(&live_key)
                    .expect("live replica"),
            )],
        )?;
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].signer_id, staged_key.signer_id);
        assert!(
            views[0]
                .accounts
                .iter()
                .all(|account| account.mempool.is_empty())
        );
        Ok(())
    }

    #[test]
    fn future_entity_mempool_registration_is_not_projected() -> Result<(), RuntimeMachineError> {
        let mut runtime = super::super::tests::replica(super::super::RuntimeLimits::hlt())?;
        let key = runtime
            .state
            .e_replicas
            .keys()
            .next()
            .expect("entity key")
            .clone();
        let register = xln_rscore_entity_kernel::CanonicalEntityTx::from_frame_projection(
            xln_rscore_entity_kernel::EntityTxKind::RegisterCrossJurisdictionSwap,
            xln_rscore_protocol::CanonicalValue::Object(vec![(
                "route".into(),
                xln_rscore_protocol::CanonicalValue::Object(Vec::new()),
            )]),
        )
        .expect("future registration");
        runtime
            .e_replicas
            .get_mut(&key)
            .expect("entity replica")
            .entity_mempool
            .push_back(EntityPendingWork::Projected(register));

        let views = collect_cross_j_opening_sibling_views(
            std::iter::empty(),
            [CrossJOpeningRuntimeSlot::new(
                &key,
                runtime.state.e_replicas.get(&key).expect("entity state"),
                runtime.e_replicas.get_mut(&key).expect("entity replica"),
            )],
        )?;
        assert!(
            views[0]
                .accounts
                .iter()
                .all(|account| account.mempool.is_empty())
        );
        Ok(())
    }

    #[test]
    fn zero_committed_routes_skips_all_account_reads() -> Result<(), RuntimeMachineError> {
        let mut runtime = super::super::tests::replica(super::super::RuntimeLimits::hlt())?;
        let key = runtime
            .state
            .e_replicas
            .keys()
            .next()
            .expect("entity key")
            .clone();
        runtime
            .state
            .e_replicas
            .get_mut(&key)
            .expect("entity state")
            .entity
            .known_accounts
            .insert("invalid-if-account-ids-are-read".into());

        let views = collect_cross_j_opening_sibling_views(
            std::iter::empty(),
            [CrossJOpeningRuntimeSlot::new(
                &key,
                runtime.state.e_replicas.get(&key).expect("entity state"),
                runtime.e_replicas.get_mut(&key).expect("entity replica"),
            )],
        )?;

        assert_eq!(views.len(), 1);
        assert!(views[0].accounts.is_empty());
        Ok(())
    }
}
