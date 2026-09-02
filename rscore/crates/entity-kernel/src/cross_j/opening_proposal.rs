//! Pure selection of the next atomic cross-j Account-opening cohort.
//!
//! The sibling views are transient Runtime/Entity replica projections. They
//! are never committed, serialized, or promoted into an alternate Account
//! authority: the selected transactions remain exact members of the local
//! Account mempool.

use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;
use xln_rscore_engine::{ACCOUNT_MEMPOOL_SIZE, AccountTx};
use xln_rscore_protocol::CanonicalValue;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossJOpeningSiblingAccountView {
    pub counterparty_entity_id: String,
    pub mempool: Vec<AccountTx>,
    pub pending_frame_txs: Option<Vec<AccountTx>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossJOpeningSiblingEntityView {
    pub entity_id: String,
    pub signer_id: String,
    pub accounts: Vec<CrossJOpeningSiblingAccountView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CrossJOpeningProposalSelection {
    Ordinary,
    Wait,
    Selected(Vec<AccountTx>),
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CrossJOpeningSelectionError {
    #[error("CROSS_J_OPENING_ORDER_ID_REQUIRED")]
    OrderIdRequired,
    #[error("CROSS_J_OPENING_LOCAL_ROLE_INVALID:{order_id}:{local_entity_id}")]
    LocalRoleInvalid {
        order_id: String,
        local_entity_id: String,
    },
    #[error("CROSS_J_OPENING_SIBLING_BINDING_REQUIRED:{order_id}")]
    SiblingBindingRequired { order_id: String },
    #[error("CROSS_J_OPENING_SIBLING_REPLICA_MISSING:{sibling_key}")]
    SiblingReplicaMissing { sibling_key: String },
    #[error("CROSS_J_OPENING_SIBLING_ACCOUNT_MISSING:{sibling_key}")]
    SiblingAccountMissing { sibling_key: String },
    #[error("CROSS_J_OPENING_RECIPROCAL_COHORT_TOO_LARGE:{actual}")]
    ReciprocalCohortTooLarge { actual: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SiblingBinding {
    entity_id: String,
    signer_id: String,
    account_id: String,
}

fn normalized(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn field<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn text<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a str> {
    match field(value, name)? {
        CanonicalValue::String(value) => Some(value),
        _ => None,
    }
}

fn nested_text<'a>(value: &'a CanonicalValue, parent: &str, name: &str) -> Option<&'a str> {
    text(field(value, parent)?, name)
}

fn required_order_id(value: &CanonicalValue) -> Result<String, CrossJOpeningSelectionError> {
    let order_id = normalized(text(value, "orderId").unwrap_or_default());
    (!order_id.is_empty())
        .then_some(order_id)
        .ok_or(CrossJOpeningSelectionError::OrderIdRequired)
}

fn opening_legs(
    txs: &[AccountTx],
) -> Result<BTreeMap<String, &CanonicalValue>, CrossJOpeningSelectionError> {
    let mut legs = BTreeMap::new();
    for tx in txs {
        let AccountTx::CrossPullLock { data } = tx else {
            continue;
        };
        let (Some(binding), Some(route)) = (
            field(data, "crossJurisdiction"),
            field(data, "crossJurisdictionRoute"),
        ) else {
            continue;
        };
        legs.insert(required_order_id(binding)?, route);
    }
    Ok(legs)
}

fn opening_order_id(tx: &AccountTx) -> Result<Option<String>, CrossJOpeningSelectionError> {
    match tx {
        AccountTx::CrossPullLock { data } => field(data, "crossJurisdiction")
            .map(required_order_id)
            .transpose(),
        AccountTx::SwapOffer {
            cross_jurisdiction: Some(route),
            ..
        } => required_order_id(route).map(Some),
        _ => Ok(None),
    }
}

fn select_opening_txs(
    txs: &[AccountTx],
    order_ids: &BTreeSet<String>,
) -> Result<Vec<AccountTx>, CrossJOpeningSelectionError> {
    txs.iter()
        .filter_map(|tx| match opening_order_id(tx) {
            Ok(Some(order_id)) if order_ids.contains(&order_id) => Some(Ok(tx.clone())),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn sibling_binding(
    local_entity_id: &str,
    order_id: &str,
    route: &CanonicalValue,
) -> Result<SiblingBinding, CrossJOpeningSelectionError> {
    let local = normalized(local_entity_id);
    let binding = role_binding(&local, route).ok_or_else(|| {
        CrossJOpeningSelectionError::LocalRoleInvalid {
            order_id: order_id.to_string(),
            local_entity_id: local,
        }
    })?;
    if binding.entity_id.is_empty() || binding.signer_id.is_empty() || binding.account_id.is_empty()
    {
        return Err(CrossJOpeningSelectionError::SiblingBindingRequired {
            order_id: order_id.to_string(),
        });
    }
    Ok(binding)
}

fn role_binding(local: &str, route: &CanonicalValue) -> Option<SiblingBinding> {
    let source_entity = normalized(nested_text(route, "source", "entityId").unwrap_or_default());
    let source_hub =
        normalized(nested_text(route, "source", "counterpartyEntityId").unwrap_or_default());
    let target_hub = normalized(nested_text(route, "target", "entityId").unwrap_or_default());
    let target_entity =
        normalized(nested_text(route, "target", "counterpartyEntityId").unwrap_or_default());
    match local {
        value if value == source_entity => {
            Some(binding(target_entity, route, "targetSignerId", target_hub))
        }
        value if value == source_hub => Some(binding(
            target_hub,
            route,
            "targetHubSignerId",
            target_entity,
        )),
        value if value == target_hub => Some(binding(
            source_hub,
            route,
            "sourceHubSignerId",
            source_entity,
        )),
        value if value == target_entity => {
            Some(binding(source_entity, route, "sourceSignerId", source_hub))
        }
        _ => None,
    }
}

fn binding(
    entity_id: String,
    route: &CanonicalValue,
    signer_field: &str,
    account_id: String,
) -> SiblingBinding {
    SiblingBinding {
        entity_id,
        signer_id: normalized(text(route, signer_field).unwrap_or_default()),
        account_id,
    }
}

fn sibling_key(binding: &SiblingBinding) -> String {
    format!(
        "{}:{}:{}",
        binding.entity_id, binding.signer_id, binding.account_id
    )
}

fn find_sibling<'a>(
    binding: &SiblingBinding,
    siblings: &'a [CrossJOpeningSiblingEntityView],
) -> Result<
    (
        &'a CrossJOpeningSiblingEntityView,
        &'a CrossJOpeningSiblingAccountView,
    ),
    CrossJOpeningSelectionError,
> {
    let key = sibling_key(binding);
    let entity = siblings
        .iter()
        .find(|view| {
            normalized(&view.entity_id) == binding.entity_id
                && normalized(&view.signer_id) == binding.signer_id
        })
        .ok_or_else(|| CrossJOpeningSelectionError::SiblingReplicaMissing {
            sibling_key: key.clone(),
        })?;
    let account = entity
        .accounts
        .iter()
        .find(|view| normalized(&view.counterparty_entity_id) == binding.account_id)
        .ok_or(CrossJOpeningSelectionError::SiblingAccountMissing { sibling_key: key })?;
    Ok((entity, account))
}

fn reciprocal_order_ids(
    txs: &[AccountTx],
    sibling_entity_id: &str,
    local_entity_id: &str,
    local_account_counterparty: &str,
) -> Result<BTreeSet<String>, CrossJOpeningSelectionError> {
    let mut reciprocal = BTreeSet::new();
    for (order_id, route) in opening_legs(txs)? {
        let binding = sibling_binding(sibling_entity_id, &order_id, route)?;
        if binding.entity_id == normalized(local_entity_id)
            && binding.account_id == normalized(local_account_counterparty)
        {
            reciprocal.insert(order_id);
        }
    }
    Ok(reciprocal)
}

fn sibling_opening_source(
    account: &CrossJOpeningSiblingAccountView,
) -> Result<(&[AccountTx], bool), CrossJOpeningSelectionError> {
    let pending = account.pending_frame_txs.as_deref().unwrap_or(&[]);
    let has_pending_opening = !opening_legs(pending)?.is_empty();
    Ok(if has_pending_opening {
        (pending, true)
    } else {
        (&account.mempool, false)
    })
}

fn opening_intersection(
    local: &BTreeSet<String>,
    reciprocal: &BTreeSet<String>,
    pending: bool,
) -> Option<BTreeSet<String>> {
    let common = local
        .intersection(reciprocal)
        .cloned()
        .collect::<BTreeSet<_>>();
    if common.is_empty() || (pending && reciprocal.len() != common.len()) {
        return None;
    }
    Some(if pending {
        common
    } else {
        common.into_iter().take(1).collect()
    })
}

fn selected_for_group(
    local_mempool: &[AccountTx],
    local_order_ids: &BTreeSet<String>,
    local_entity_id: &str,
    local_account_counterparty: &str,
    binding: &SiblingBinding,
    siblings: &[CrossJOpeningSiblingEntityView],
) -> Result<Option<Vec<AccountTx>>, CrossJOpeningSelectionError> {
    let (entity, account) = find_sibling(binding, siblings)?;
    let (sibling_txs, pending) = sibling_opening_source(account)?;
    let reciprocal = reciprocal_order_ids(
        sibling_txs,
        &entity.entity_id,
        local_entity_id,
        local_account_counterparty,
    )?;
    let Some(cohort) = opening_intersection(local_order_ids, &reciprocal, pending) else {
        return Ok(None);
    };
    let selected = select_opening_txs(local_mempool, &cohort)?;
    if selected.len() > ACCOUNT_MEMPOOL_SIZE {
        return Err(CrossJOpeningSelectionError::ReciprocalCohortTooLarge {
            actual: selected.len(),
        });
    }
    Ok(Some(selected))
}

fn opening_groups(
    local_entity_id: &str,
    local_legs: BTreeMap<String, &CanonicalValue>,
) -> Result<BTreeMap<String, (SiblingBinding, BTreeSet<String>)>, CrossJOpeningSelectionError> {
    let mut groups = BTreeMap::<String, (SiblingBinding, BTreeSet<String>)>::new();
    for (order_id, route) in local_legs {
        let binding = sibling_binding(local_entity_id, &order_id, route)?;
        groups
            .entry(sibling_key(&binding))
            .or_insert_with(|| (binding, BTreeSet::new()))
            .1
            .insert(order_id);
    }
    Ok(groups)
}

/// Match TypeScript's `selectCrossJOpeningAccountProposalTxs` without reading
/// Runtime globals or changing any durable replica state.
pub fn select_cross_j_opening_proposal(
    local_entity_id: &str,
    local_account_counterparty: &str,
    local_mempool: &[AccountTx],
    siblings: &[CrossJOpeningSiblingEntityView],
) -> Result<CrossJOpeningProposalSelection, CrossJOpeningSelectionError> {
    let local_legs = opening_legs(local_mempool)?;
    if local_legs.is_empty() {
        return Ok(CrossJOpeningProposalSelection::Ordinary);
    }
    for (_, (binding, order_ids)) in opening_groups(local_entity_id, local_legs)? {
        if let Some(selected) = selected_for_group(
            local_mempool,
            &order_ids,
            local_entity_id,
            local_account_counterparty,
            &binding,
            siblings,
        )? {
            return Ok(CrossJOpeningProposalSelection::Selected(selected));
        }
    }
    Ok(CrossJOpeningProposalSelection::Wait)
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;

    use super::*;

    fn object(fields: impl IntoIterator<Item = (&'static str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn string(value: &str) -> CanonicalValue {
        CanonicalValue::String(value.to_string())
    }

    fn route(order_id: &str) -> CanonicalValue {
        object([
            ("orderId", string(order_id)),
            ("sourceSignerId", string("source-user-signer")),
            ("sourceHubSignerId", string("source-hub-signer")),
            ("targetHubSignerId", string("target-hub-signer")),
            ("targetSignerId", string("target-user-signer")),
            (
                "source",
                object([
                    ("entityId", string("source-user")),
                    ("counterpartyEntityId", string("source-hub")),
                ]),
            ),
            (
                "target",
                object([
                    ("entityId", string("target-hub")),
                    ("counterpartyEntityId", string("target-user")),
                ]),
            ),
        ])
    }

    fn pull(order_id: &str) -> AccountTx {
        AccountTx::CrossPullLock {
            data: object([
                ("crossJurisdiction", object([("orderId", string(order_id))])),
                ("crossJurisdictionRoute", route(order_id)),
            ]),
        }
    }

    fn offer(order_id: &str) -> AccountTx {
        AccountTx::SwapOffer {
            offer_id: order_id.to_string(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: BigInt::from(1),
            want_token_id: 2,
            want_token_decimals: 6,
            want_amount: BigInt::from(2),
            max_fee: BigInt::from(0),
            min_net_receive: BigInt::from(2),
            time_in_force: Some(0),
            price_ticks: None,
            cross_jurisdiction: Some(route(order_id)),
        }
    }

    fn ordinary() -> AccountTx {
        AccountTx::SwapCancelRequest {
            offer_id: "ordinary".into(),
        }
    }

    fn sibling(
        entity_id: &str,
        signer_id: &str,
        account_id: &str,
        mempool: Vec<AccountTx>,
        pending_frame_txs: Option<Vec<AccountTx>>,
    ) -> CrossJOpeningSiblingEntityView {
        CrossJOpeningSiblingEntityView {
            entity_id: entity_id.to_string(),
            signer_id: signer_id.to_string(),
            accounts: vec![CrossJOpeningSiblingAccountView {
                counterparty_entity_id: account_id.to_string(),
                mempool,
                pending_frame_txs,
            }],
        }
    }

    #[test]
    fn ordinary_mempool_needs_no_sibling_view() {
        assert_eq!(
            select_cross_j_opening_proposal("source-user", "source-hub", &[ordinary()], &[]),
            Ok(CrossJOpeningProposalSelection::Ordinary)
        );
    }

    #[test]
    fn lexical_intersection_selects_one_order_and_preserves_local_order_and_duplicates() {
        let local = vec![
            ordinary(),
            offer("b"),
            pull("a"),
            offer("a"),
            pull("b"),
            pull("a"),
        ];
        let sibling = sibling(
            "target-user",
            "target-user-signer",
            "target-hub",
            vec![pull("b"), pull("a")],
            None,
        );
        assert_eq!(
            select_cross_j_opening_proposal("source-user", "source-hub", &local, &[sibling]),
            Ok(CrossJOpeningProposalSelection::Selected(vec![
                pull("a"),
                offer("a"),
                pull("a")
            ]))
        );
    }

    #[test]
    fn missing_reciprocal_leg_waits() {
        let view = sibling(
            "target-user",
            "target-user-signer",
            "target-hub",
            vec![pull("other")],
            None,
        );
        assert_eq!(
            select_cross_j_opening_proposal("source-user", "source-hub", &[pull("a")], &[view]),
            Ok(CrossJOpeningProposalSelection::Wait)
        );
    }

    #[test]
    fn pending_opening_freezes_exact_existing_cohort() {
        let local = vec![pull("b"), offer("a"), pull("a"), offer("b")];
        let view = sibling(
            "target-user",
            "target-user-signer",
            "target-hub",
            vec![pull("later")],
            Some(vec![pull("a"), pull("b")]),
        );
        assert_eq!(
            select_cross_j_opening_proposal("source-user", "source-hub", &local, &[view]),
            Ok(CrossJOpeningProposalSelection::Selected(local))
        );
    }

    #[test]
    fn pending_opening_with_unavailable_member_waits() {
        let view = sibling(
            "target-user",
            "target-user-signer",
            "target-hub",
            vec![],
            Some(vec![pull("a"), pull("b")]),
        );
        assert_eq!(
            select_cross_j_opening_proposal("source-user", "source-hub", &[pull("a")], &[view]),
            Ok(CrossJOpeningProposalSelection::Wait)
        );
    }

    #[test]
    fn all_four_roles_resolve_the_exact_sibling_binding() {
        let cases = [
            (
                "source-user",
                "source-hub",
                "target-user",
                "target-user-signer",
                "target-hub",
            ),
            (
                "source-hub",
                "source-user",
                "target-hub",
                "target-hub-signer",
                "target-user",
            ),
            (
                "target-hub",
                "target-user",
                "source-hub",
                "source-hub-signer",
                "source-user",
            ),
            (
                "target-user",
                "target-hub",
                "source-user",
                "source-user-signer",
                "source-hub",
            ),
        ];
        for (local, counterparty, sibling_entity, signer, sibling_account) in cases {
            let view = sibling(
                sibling_entity,
                signer,
                sibling_account,
                vec![pull("a")],
                None,
            );
            assert_eq!(
                select_cross_j_opening_proposal(local, counterparty, &[pull("a")], &[view]),
                Ok(CrossJOpeningProposalSelection::Selected(vec![pull("a")]))
            );
        }
    }

    #[test]
    fn missing_replica_and_account_fail_loudly() {
        let missing_replica =
            select_cross_j_opening_proposal("source-user", "source-hub", &[pull("a")], &[]);
        assert!(matches!(
            missing_replica,
            Err(CrossJOpeningSelectionError::SiblingReplicaMissing { .. })
        ));

        let view = sibling(
            "target-user",
            "target-user-signer",
            "wrong-account",
            vec![pull("a")],
            None,
        );
        assert!(matches!(
            select_cross_j_opening_proposal("source-user", "source-hub", &[pull("a")], &[view]),
            Err(CrossJOpeningSelectionError::SiblingAccountMissing { .. })
        ));
    }

    #[test]
    fn missing_signer_binding_fails_loudly() {
        let mut invalid_route = route("a");
        let CanonicalValue::Object(fields) = &mut invalid_route else {
            unreachable!()
        };
        fields.retain(|(key, _)| key != "targetSignerId");
        let tx = AccountTx::CrossPullLock {
            data: object([
                ("crossJurisdiction", object([("orderId", string("a"))])),
                ("crossJurisdictionRoute", invalid_route),
            ]),
        };
        assert_eq!(
            select_cross_j_opening_proposal("source-user", "source-hub", &[tx], &[]),
            Err(CrossJOpeningSelectionError::SiblingBindingRequired {
                order_id: "a".into()
            })
        );
    }
}
