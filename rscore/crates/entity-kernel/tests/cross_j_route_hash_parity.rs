use num_bigint::BigInt;
use std::collections::BTreeMap;
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, ConsensusMode, EntityCanonicalCollection, EntityConsensusConfig,
    EntityFrameAuthority, EntityLeaderState, EntityStateSlice, EntityTxKind,
    apply_cross_jurisdiction_entity_txs,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe test number"))
}

fn string(value: &str) -> CanonicalValue {
    CanonicalValue::String(value.to_string())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn route(route_hash: Option<&str>) -> CanonicalValue {
    let mut fields = vec![
        ("orderId", string("order-1")),
        ("makerEntityId", string("source-user")),
        ("hubEntityId", string("source-hub")),
        ("sourceSignerId", string("source-user-signer")),
        ("sourceHubSignerId", string("source-hub-signer")),
        ("targetHubSignerId", string("target-hub-signer")),
        ("targetSignerId", string("target-user-signer")),
        (
            "source",
            object(vec![
                (
                    "jurisdiction",
                    string("stack:1:0x1111111111111111111111111111111111111111"),
                ),
                ("entityId", string("source-user")),
                ("counterpartyEntityId", string("source-hub")),
                ("tokenId", number(2)),
                (
                    "amount",
                    CanonicalValue::BigInt(BigInt::from(1_000_000_000_000_000_000_u64)),
                ),
            ]),
        ),
        (
            "target",
            object(vec![
                (
                    "jurisdiction",
                    string("stack:2:0x2222222222222222222222222222222222222222"),
                ),
                ("entityId", string("target-hub")),
                ("counterpartyEntityId", string("target-user")),
                ("tokenId", number(1)),
                (
                    "amount",
                    CanonicalValue::BigInt(BigInt::from(2_000_000_u64)),
                ),
            ]),
        ),
        (
            "sourceDisputeConfig",
            object(vec![
                ("leftResponseSeconds", number(3_600)),
                ("rightResponseSeconds", number(86_400)),
            ]),
        ),
        (
            "targetDisputeConfig",
            object(vec![
                ("leftResponseSeconds", number(3_600)),
                ("rightResponseSeconds", number(86_400)),
            ]),
        ),
        ("status", string("intent")),
        ("createdAt", number(1_000)),
        ("updatedAt", number(1_000)),
        ("expiresAt", number(61_000)),
    ];
    if let Some(route_hash) = route_hash {
        fields.push(("routeHash", string(route_hash)));
    }
    object(fields)
}

fn prepare(route: CanonicalValue) -> CanonicalEntityTx {
    CanonicalEntityTx::from_frame_projection(
        EntityTxKind::PrepareCrossJurisdictionSwap,
        object(vec![("route", route)]),
    )
    .expect("prepare projection")
}

fn authority(signer: &str) -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![signer.into()],
            shares: BTreeMap::from([(signer.into(), 1)]),
            jurisdiction: Some(object(vec![
                ("chainId", number(1)),
                (
                    "depositoryAddress",
                    string("0x1111111111111111111111111111111111111111"),
                ),
                (
                    "entityProviderAddress",
                    string("0x3333333333333333333333333333333333333333"),
                ),
            ])),
        },
        leader_state: EntityLeaderState {
            active_validator_id: signer.into(),
            view: 0,
            changed_at_height: 0,
        },
    }
}

#[test]
fn typescript_route_hash_vector_is_materialized_before_state_commit() {
    let mut state = EntityStateSlice::empty("source-user", 1_000);
    apply_cross_jurisdiction_entity_txs(
        &mut state,
        &std::collections::BTreeMap::new(),
        &[prepare(route(None))],
        Some("source-user-signer"),
        &authority("source-user-signer"),
    )
    .expect("prepare");
    let committed = state
        .cross_jurisdiction_authorizations
        .as_ref()
        .and_then(|values| values.get("order-1"))
        .expect("committed authorization");
    let CanonicalValue::Object(fields) = committed else {
        panic!("route object");
    };
    let hash = fields
        .iter()
        .find_map(|(key, value)| (key == "routeHash").then_some(value));
    assert_eq!(
        hash,
        Some(&string(
            "0xc7256dc31e315883c77c1743527b1a8b5b4966db203cecb91cfbfeab7c444f03"
        ))
    );
    assert_eq!(
        format!(
            "0x{}",
            hex(&state
                .cross_jurisdiction_authorizations
                .as_ref()
                .expect("authorization map")
                .root_hash())
        ),
        "0x3c55d08a3e43175b173cf9bc1ed4b3cceb72fe1717f811b7800ff0277524010c"
    );
}

#[test]
fn supplied_route_hash_mismatch_is_rejected_before_state_mutation() {
    let mut state = EntityStateSlice::empty("source-user", 1_000);
    let error = apply_cross_jurisdiction_entity_txs(
        &mut state,
        &std::collections::BTreeMap::new(),
        &[prepare(route(Some(&format!("0x{}", "00".repeat(32)))))],
        Some("source-user-signer"),
        &authority("source-user-signer"),
    )
    .expect_err("mismatch");
    assert!(error.to_string().contains("ROUTE_HASH_MISMATCH"));
    assert!(state.cross_jurisdiction_authorizations.is_none());
}

#[test]
fn growing_collection_matches_typescript_leaf_admission_limits() {
    let mut collection = EntityCanonicalCollection::empty();
    let nested = object(vec![(
        "nested",
        CanonicalValue::Map(vec![(string("key"), string("value"))]),
    )]);
    let nested_error = collection
        .insert("nested".to_string(), nested)
        .expect_err("nested map");
    assert!(
        nested_error
            .to_string()
            .contains("ENTITY_COLLECTION_LEAF_NESTED_COLLECTION_FORBIDDEN")
    );
    let large_error = collection
        .insert("large".to_string(), string(&"x".repeat(10_001)))
        .expect_err("large leaf");
    assert!(
        large_error
            .to_string()
            .contains("ENTITY_COLLECTION_LEAF_TOO_LARGE")
    );
    assert!(collection.is_empty());
}
