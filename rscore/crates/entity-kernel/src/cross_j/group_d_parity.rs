use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use xln_rscore_engine::{Side, SwapOfferSnapshot, canonical_tx_digest};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::*;
use crate::local_financial::LocalAccountFinancialView;

const FIXTURE: &str = include_str!("../../../../fixtures/cross-j-entity-kinds/group-d-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    signer_id: String,
    authority_jurisdiction: Value,
    before: StateProjection,
    tx: Value,
    after: StateProjection,
    events: Vec<EventProjection>,
    effects: EffectsProjection,
    outbox: OutboxProjection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateProjection {
    entity_id: String,
    timestamp: u64,
    known_accounts: Vec<String>,
    accounts: Vec<AccountProjection>,
    cross_jurisdiction_swaps: CollectionProjection,
    cross_jurisdiction_authorizations: CollectionProjection,
    pending_cross_jurisdiction_fill_acks: CollectionProjection,
    cross_jurisdiction_book_admissions: CollectionProjection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountProjection {
    account_id: String,
    account_state_root: String,
    entity_leaf: String,
    status: String,
    dispute_prepare: Value,
    active_dispute: Value,
}

#[derive(Deserialize)]
struct CollectionProjection {
    entries: Vec<(String, Value)>,
    root: Option<String>,
}

#[derive(Deserialize)]
struct EventProjection {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectsProjection {
    storage_changes: Vec<Value>,
    candidate_effects: Vec<Value>,
    swap_offers_created: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboxProjection {
    outputs: Vec<Value>,
    account_txs: Vec<AccountTxProjection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountTxProjection {
    account_id: String,
    tx_digest: String,
}

fn canonical(value: &Value) -> CanonicalValue {
    match value {
        Value::Null => CanonicalValue::Null,
        Value::Bool(value) => CanonicalValue::Bool(*value),
        Value::Number(value) => {
            let value = if let Some(value) = value.as_u64() {
                CanonicalNumber::try_from_u64(value).expect("safe fixture integer")
            } else {
                CanonicalNumber::try_from_i64(value.as_i64().expect("fixture integer"))
                    .expect("safe fixture integer")
            };
            CanonicalValue::Number(value)
        }
        Value::String(value) => CanonicalValue::String(value.clone()),
        Value::Array(values) => CanonicalValue::Array(values.iter().map(canonical).collect()),
        Value::Object(fields)
            if fields.get("__xlnType").and_then(Value::as_str) == Some("BigInt") =>
        {
            CanonicalValue::BigInt(
                fields["value"]
                    .as_str()
                    .expect("BigInt fixture value")
                    .parse()
                    .expect("BigInt fixture decimal"),
            )
        }
        Value::Object(fields) => CanonicalValue::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
    }
}

fn collection(projection: &CollectionProjection) -> Option<EntityCanonicalCollection> {
    projection.root.as_ref()?;
    let mut collection = EntityCanonicalCollection::empty();
    for (key, value) in &projection.entries {
        collection
            .insert(key.clone(), canonical(value))
            .expect("fixture collection value");
    }
    Some(collection)
}

fn state(projection: &StateProjection) -> EntityStateSlice {
    let mut state = EntityStateSlice::empty(&projection.entity_id, projection.timestamp);
    for account_id in &projection.known_accounts {
        state.known_accounts.insert(account_id.clone());
    }
    state.cross_jurisdiction_swaps = collection(&projection.cross_jurisdiction_swaps);
    state.cross_jurisdiction_authorizations =
        collection(&projection.cross_jurisdiction_authorizations);
    state.pending_cross_jurisdiction_fill_acks =
        collection(&projection.pending_cross_jurisdiction_fill_acks);
    state.cross_jurisdiction_book_admissions =
        collection(&projection.cross_jurisdiction_book_admissions);
    state
}

fn authority(case: &Case) -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: crate::EntityConsensusConfig {
            mode: crate::ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![case.signer_id.clone()],
            shares: BTreeMap::from([(case.signer_id.clone(), 1)]),
            jurisdiction: Some(canonical(&case.authority_jurisdiction)),
        },
        leader_state: crate::EntityLeaderState {
            active_validator_id: case.signer_id.clone(),
            view: 0,
            changed_at_height: 0,
        },
    }
}

fn tx(value: &Value) -> CanonicalEntityTx {
    let kind = EntityTxKind::parse(value["type"].as_str().expect("fixture tx type"))
        .expect("known fixture tx type");
    CanonicalEntityTx::from_frame_projection(kind, canonical(&value["data"]))
        .expect("canonical fixture tx")
}

fn route_from(state: &EntityStateSlice, tx: &CanonicalEntityTx) -> Option<CanonicalValue> {
    state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.text_entries().ok())
        .and_then(|entries| entries.into_iter().next().map(|(_, route)| route))
        .or_else(|| {
            tx.frame_data()
                .and_then(|data| field(data, "route"))
                .cloned()
        })
}

fn empty_account_view(owner_is_left: bool) -> LocalAccountFinancialView {
    LocalAccountFinancialView {
        active: true,
        owner_side: if owner_is_left {
            Side::Left
        } else {
            Side::Right
        },
        owner_out_capacity: BTreeMap::new(),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: None,
        settlement_transition_pending: false,
        settlement_execution: Err("group-d fixture has no settlement".into()),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: BTreeSet::new(),
        pending_cross_swap_ack_ids: BTreeSet::new(),
        dispute: None,
    }
}

fn account_views(
    case_name: &str,
    state: &EntityStateSlice,
    transaction: &CanonicalEntityTx,
) -> BTreeMap<String, LocalAccountFinancialView> {
    let Some(route) = route_from(state, transaction) else {
        return state
            .known_accounts
            .iter()
            .map(|account_id| {
                (
                    account_id.clone(),
                    empty_account_view(state.entity_id < *account_id),
                )
            })
            .collect();
    };
    let local = normalized(&state.entity_id);
    let source_user = nested_text(&route, "source", "entityId").map(normalized);
    let source_hub = nested_text(&route, "source", "counterpartyEntityId").map(normalized);
    let target_hub = nested_text(&route, "target", "entityId").map(normalized);
    let target_user = nested_text(&route, "target", "counterpartyEntityId").map(normalized);
    let mut views = BTreeMap::new();
    for account_id in state.known_accounts.iter() {
        let mut view = empty_account_view(local < normalized(account_id));
        if case_name == "crossJurisdictionForceSiblingDispute" {
            view.dispute = Some(xln_rscore_batch::ResidentAccountDisputeView {
                status: "active".into(),
                dispute_prepare: None,
                active_dispute: None,
                local_dispute: None,
                counterparty_dispute: None,
                proof_body: Err("unused without counterparty Hanko".into()),
                j_nonce: 0,
                owner_is_left: view.owner_side == Side::Left,
                delta_transformer: None,
                payment_hashlocks: Vec::new(),
                pull_ids: field(&route, "sourcePull")
                    .and_then(|pull| text(pull, "pullId"))
                    .map(|pull_id| vec![pull_id.to_string()])
                    .unwrap_or_default(),
                pull_count: usize::from(field(&route, "sourcePull").is_some()),
                swap_offers: Vec::new(),
                pending_swap_fill_ratios: BTreeMap::new(),
            });
        }
        if source_hub.as_deref() == Some(&local) && source_user.as_deref() == Some(account_id) {
            if let Some(pull) = field(&route, "sourcePull")
                && let Some(pull_id) = text(pull, "pullId")
            {
                view.pulls.insert(pull_id.to_string(), CanonicalValue::Null);
            }
            if matches!(
                case_name,
                "crossJurisdictionBookOrderRemoved" | "orderbookSweepCrossJurisdiction"
            ) {
                let offer_id = text(&route, "orderId").unwrap_or_default().to_string();
                view.swap_offers.insert(
                    offer_id.clone(),
                    SwapOfferSnapshot {
                        offer_id,
                        left_entity: source_user.clone().unwrap_or_default(),
                        right_entity: source_hub.clone().unwrap_or_default(),
                        give_token_id: 1,
                        give_token_decimals: 6,
                        give_amount: BigInt::from(1_000),
                        want_token_id: 1,
                        want_token_decimals: 6,
                        want_amount: BigInt::from(900),
                        max_fee: BigInt::from(0),
                        min_net_receive: BigInt::from(900),
                        price_ticks: BigInt::from(900),
                        time_in_force: Some(0),
                        maker_is_left: true,
                        created_height: 0,
                        quantized_give: BigInt::from(1_000),
                        quantized_want: BigInt::from(900),
                        cross_jurisdiction: Some(route.clone()),
                    },
                );
            }
        }
        if target_hub.as_deref() == Some(&local)
            && target_user.as_deref() == Some(account_id)
            && let Some(pull) = field(&route, "targetPull")
            && let Some(pull_id) = text(pull, "pullId")
        {
            view.pulls.insert(pull_id.to_string(), CanonicalValue::Null);
        }
        views.insert(account_id.clone(), view);
    }
    views
}

fn root(collection: &Option<EntityCanonicalCollection>) -> Option<String> {
    collection
        .as_ref()
        .map(|collection| format!("0x{}", hex::encode(collection.root_hash())))
}

fn assert_state(case_name: &str, actual: &EntityStateSlice, expected: &StateProjection) {
    assert_eq!(actual.entity_id, expected.entity_id, "{case_name} entity");
    assert_eq!(
        actual.timestamp, expected.timestamp,
        "{case_name} timestamp"
    );
    assert_eq!(
        root(&actual.cross_jurisdiction_swaps),
        expected.cross_jurisdiction_swaps.root,
        "{case_name} swaps root"
    );
    assert_eq!(
        root(&actual.cross_jurisdiction_authorizations),
        expected.cross_jurisdiction_authorizations.root,
        "{case_name} authorizations root"
    );
    assert_eq!(
        root(&actual.pending_cross_jurisdiction_fill_acks),
        expected.pending_cross_jurisdiction_fill_acks.root,
        "{case_name} fill ACK root"
    );
    assert_eq!(
        root(&actual.cross_jurisdiction_book_admissions),
        expected.cross_jurisdiction_book_admissions.root,
        "{case_name} admissions root"
    );
}

fn assert_events(case: &Case, actual: &[EntityFrameEvent]) {
    assert_eq!(actual.len(), case.events.len(), "{} event count", case.name);
    for (actual, expected) in actual.iter().zip(&case.events) {
        let EntityFrameEvent::Status { message } = actual else {
            panic!("{} expected status event", case.name);
        };
        assert_eq!(expected.kind, "status", "{} event kind", case.name);
        assert_eq!(message, &expected.message, "{} event message", case.name);
    }
}

fn assert_outbox(case: &Case, actual: &CrossJurisdictionApplyResult) {
    assert_eq!(
        actual.outputs.len(),
        case.outbox.outputs.len(),
        "{} Entity output count",
        case.name
    );
    for (actual, expected) in actual.outputs.iter().zip(&case.outbox.outputs) {
        assert_eq!(
            actual.entity_id, expected["entityId"],
            "{} output target",
            case.name
        );
        let bound_signer = actual.target_signer_id.as_deref().or_else(|| {
            (actual.entity_id == case.before.entity_id).then_some(case.signer_id.as_str())
        });
        assert_eq!(
            bound_signer,
            expected["signerId"].as_str(),
            "{} output signer",
            case.name
        );
        let expected_txs = expected["entityTxs"].as_array().expect("output Entity txs");
        assert_eq!(
            actual.entity_txs.len(),
            expected_txs.len(),
            "{} output tx count",
            case.name
        );
        for (actual_tx, expected_tx) in actual.entity_txs.iter().zip(expected_txs) {
            let LocalEntityOutputTx::Projected(actual_tx) = actual_tx else {
                panic!("{} unexpected AccountInput output", case.name);
            };
            assert_eq!(
                format!(
                    "0x{}",
                    hex::encode(Sha256::digest(actual_tx.frame_payload()))
                ),
                expected_tx["txDigest"],
                "{} projected Entity tx digest",
                case.name,
            );
        }
    }
    let actual_account_txs = actual
        .proposal_work
        .iter()
        .flat_map(|work| work.txs.iter().map(|tx| (&work.account_id, tx)))
        .collect::<Vec<_>>();
    assert_eq!(
        actual_account_txs.len(),
        case.outbox.account_txs.len(),
        "{} Account outbox count",
        case.name
    );
    for ((account_id, transaction), expected) in
        actual_account_txs.iter().zip(&case.outbox.account_txs)
    {
        assert_eq!(
            *account_id, &expected.account_id,
            "{} Account target",
            case.name
        );
        assert_eq!(
            format!(
                "0x{}",
                hex::encode(canonical_tx_digest(transaction).expect("Account tx digest"))
            ),
            expected.tx_digest,
            "{} Account tx digest",
            case.name,
        );
    }
}

fn assert_force_sibling_dispute(case: &Case) {
    let transaction = tx(&case.tx);
    let mut actual_state = state(&case.before);
    let views = account_views(&case.name, &actual_state, &transaction);
    let decoded = crate::local_financial::decode_local_entity_financial_tx(&transaction)
        .expect("force sibling decode")
        .expect("force sibling financial tx");
    let mut paybook = crate::paybook::PaybookChanges::default();
    let actual = crate::local_financial::apply_local_entity_financial_txs(
        &mut actual_state,
        &mut paybook,
        vec![decoded],
        &crate::DeterministicContext::hlt_default(),
        &views,
        None,
        Some("cross-j-entity-kinds-group-d-v1"),
    )
    .unwrap_or_else(|error| panic!("{} Rust transition: {error}", case.name));
    assert_state(&case.name, &actual_state, &case.after);
    assert_events(case, &actual.events);
    assert!(
        actual.account_txs.is_empty(),
        "{} Account outbox",
        case.name
    );
    assert!(actual.outputs.is_empty(), "{} Runtime effects", case.name);
    assert!(
        actual.routed_entity_outputs.is_empty(),
        "{} Entity outbox",
        case.name
    );
    let expected = case
        .after
        .accounts
        .first()
        .expect("force sibling Account projection");
    assert!(
        !expected.account_state_root.is_empty(),
        "Account root evidence"
    );
    assert!(
        !expected.entity_leaf.is_empty(),
        "Entity Account leaf evidence"
    );
    let [
        (
            account_id,
            crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                status,
                dispute_prepare: Some(dispute_prepare),
                active_dispute,
            },
        ),
    ] = actual.envelope_mutations.as_slice()
    else {
        panic!("{} exact Account dispute mutation", case.name);
    };
    assert_eq!(
        account_id, &expected.account_id,
        "{} dispute Account",
        case.name
    );
    assert_eq!(status, &expected.status, "{} dispute status", case.name);
    assert_eq!(
        encode_canonical_consensus_bytes(dispute_prepare).expect("actual dispute preparation"),
        encode_canonical_consensus_bytes(&canonical(&expected.dispute_prepare))
            .expect("expected dispute preparation"),
        "{} dispute preparation",
        case.name,
    );
    assert_eq!(
        active_dispute
            .as_ref()
            .map(|value| encode_canonical_consensus_bytes(value).unwrap()),
        (!expected.active_dispute.is_null())
            .then(
                || encode_canonical_consensus_bytes(&canonical(&expected.active_dispute)).unwrap()
            ),
        "{} active dispute",
        case.name,
    );
}

#[test]
fn group_d_cross_j_entity_kinds_match_typescript() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared Group D fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript applyEntityTx cross-j Group D semantic transitions"
    );
    assert_eq!(fixture.cases.len(), 12, "all Group D kinds");
    for case in fixture.cases {
        let transaction = tx(&case.tx);
        if transaction.kind == EntityTxKind::CrossJurisdictionForceSiblingDispute {
            assert_force_sibling_dispute(&case);
            continue;
        }
        let mut actual_state = state(&case.before);
        assert_state(&case.name, &actual_state, &case.before);
        let views = account_views(&case.name, &actual_state, &transaction);
        let actual = apply_cross_jurisdiction_entity_txs(
            &mut actual_state,
            &views,
            &[transaction],
            Some(&case.signer_id),
            &authority(&case),
        )
        .unwrap_or_else(|error| panic!("{} Rust transition: {error}", case.name));
        assert_state(&case.name, &actual_state, &case.after);
        assert_events(&case, &actual.events);
        assert!(
            case.effects.storage_changes.is_empty(),
            "{} unexpected TS storage effect",
            case.name
        );
        assert!(
            case.effects.candidate_effects.is_empty(),
            "{} unexpected TS candidate effect",
            case.name
        );
        if case.name == "admitCrossJurisdictionBookOrder" {
            // TS exposes `swapOffersCreated` as an input to its later F3 book
            // stage. This vector deliberately has no orderbookExt, so the
            // full stage produces no external effect and Rust correctly
            // discards the transient delta at the same boundary.
            assert_eq!(
                case.effects.swap_offers_created.len(),
                1,
                "TS transient book input"
            );
            assert!(
                actual.orderbook_deltas.is_empty(),
                "Rust absent-book stage effect"
            );
        } else {
            assert_eq!(
                actual
                    .orderbook_deltas
                    .iter()
                    .filter(|delta| matches!(delta, SameJOutputDelta::Upsert { .. }))
                    .count(),
                case.effects.swap_offers_created.len(),
                "{} orderbook upserts",
                case.name,
            );
        }
        assert!(
            actual.account_envelope_mutations.is_empty(),
            "{} cross-j envelope mutation",
            case.name
        );
        assert_outbox(&case, &actual);
    }
}
