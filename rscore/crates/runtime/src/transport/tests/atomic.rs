use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::super::inbound::envelope::decode_envelope;
use super::super::msgpack::{encode_framed, encode_transport};
use super::super::routing::prepare_envelopes;
use super::super::{InboundEntityInputs, RuntimeTransportError};

const SOURCE: &str = "0x2222222222222222222222222222222222222222";
const TARGET: &str = "0x1111111111111111111111111111111111111111";

#[test]
fn adjacent_frame_close_legs_match_ts_atomic_group() {
    use base64::Engine as _;
    let capsule: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/native-cross-cancel-ack-v1.json"
    )))
    .unwrap();
    let mut values = capsule["rowsBase64"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(row.as_str().unwrap())
                .unwrap();
            crate::decode_storage_payload(&bytes).unwrap()
        })
        .collect::<Vec<_>>();
    values[2]["sourceRuntimeFrame"]["height"] = json!(97);
    let rows = encode_rows(&values);
    let mut prepared = prepare_envelopes(
        capsule["sourceRuntimeId"].as_str().unwrap(),
        &rows,
        &BTreeMap::new(),
        10,
        1_024 * 1_024,
    )
    .expect("TS groups adjacent-frame sibling closes as one exact atomic pair");
    // Publishing frame differs from both leg frames: never infer max(height).
    prepared.bind_publication_frame(99, 1791403934999);
    assert_eq!(prepared.envelopes[0].source_height, 96);
    assert_eq!(prepared.envelopes[1].source_height, 99);
    assert_eq!(prepared.envelopes[1].source_timestamp, 1791403934999);
    assert_eq!(prepared.envelopes.len(), 2);
    let expected = [2_usize, 1].map(|index| {
        let mut value = values[index].clone();
        value.as_object_mut().unwrap().remove("sourceRuntimeFrame");
        value
    });
    assert_eq!(prepared.envelopes[1].value["entityInputs"], json!(expected));
    assert_eq!(rows, encode_rows(&values), "WAL evidence stays byte-exact");
    for order in [[0, 2, 1], [1, 0, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0]] {
        let permuted = order.map(|index| values[index].clone());
        let prepared = prepare_envelopes(
            capsule["sourceRuntimeId"].as_str().unwrap(),
            &encode_rows(&permuted),
            &BTreeMap::new(),
            10,
            1_024 * 1_024,
        )
        .unwrap();
        let pair = prepared
            .envelopes
            .iter()
            .find(|envelope| envelope.value.get("atomicCrossJurisdictionPair").is_some())
            .unwrap();
        let expected = order
            .iter()
            .rev()
            .filter(|index| **index != 0)
            .map(|index| {
                let mut value = values[*index].clone();
                value.as_object_mut().unwrap().remove("sourceRuntimeFrame");
                value
            })
            .collect::<Vec<_>>();
        assert_eq!(
            pair.value["entityInputs"],
            json!(expected),
            "row order {order:?}"
        );
    }
    for bad in [values[..2].to_vec(), {
        let mut ambiguous = values.clone();
        let mut duplicate = values[2].clone();
        duplicate["sourceRuntimeFrame"]["height"] = json!(98);
        ambiguous.push(duplicate);
        ambiguous
    }] {
        assert!(matches!(prepare_envelopes(
            capsule["sourceRuntimeId"].as_str().unwrap(), &encode_rows(&bad),
            &BTreeMap::new(), 10, 1_024 * 1_024,
        ), Err(RuntimeTransportError::Outbox(reason)) if reason.contains("cross-j-incomplete-cohort")));
    }
}

#[test]
fn native_partial_cancel_ack_and_close_pair_match_ts_groups() {
    use base64::Engine as _;
    let capsule: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/native-cross-cancel-ack-v1.json"
    )))
    .unwrap();
    let rows = capsule["rowsBase64"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            base64::engine::general_purpose::STANDARD
                .decode(row.as_str().unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    let prepared = prepare_envelopes(
        capsule["sourceRuntimeId"].as_str().unwrap(),
        &rows,
        &BTreeMap::new(),
        10,
        1_024 * 1_024,
    )
    .expect("ACK must not hide the complete close pair");
    assert_eq!(prepared.row_count, 3);
    assert_eq!(prepared.envelopes.len(), 2);
    for (envelope, group) in prepared
        .envelopes
        .iter()
        .zip(capsule["groups"].as_array().unwrap())
    {
        let expected = group["indices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| {
                let mut value =
                    crate::decode_storage_payload(&rows[index.as_u64().unwrap() as usize]).unwrap();
                value.as_object_mut().unwrap().remove("sourceRuntimeFrame");
                value
            })
            .collect::<Vec<_>>();
        assert_eq!(envelope.value["entityInputs"], json!(expected));
    }
}

#[test]
fn native_cross_h85_interleaved_close_wal_matches_ts_atomic_groups() {
    use base64::Engine as _;
    let capsule: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/native-cross-close-interleaved-v1.json"
    )))
    .unwrap();
    let rows = capsule["rowsBase64"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            base64::engine::general_purpose::STANDARD
                .decode(row.as_str().unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    let original = rows
        .iter()
        .map(|row| crate::decode_storage_payload(row).unwrap())
        .collect::<Vec<_>>();
    let source = capsule["sourceRuntimeId"].as_str().unwrap();
    let prepared = prepare_envelopes(source, &rows, &BTreeMap::new(), 10, 1_024 * 1_024)
        .expect("both signed cohorts exist in positions Custody, MM, MM, Custody");
    assert_eq!(prepared.row_count, 4);
    assert_eq!(prepared.envelopes.len(), 2);
    for (envelope, expected) in prepared
        .envelopes
        .iter()
        .zip(capsule["expectedGroups"].as_array().unwrap())
    {
        assert_eq!(
            envelope.target_runtime_id,
            expected["target"].as_str().unwrap()
        );
        assert_eq!(envelope.source_height, 85);
        assert_eq!(
            envelope.source_timestamp,
            capsule["timestamp"].as_u64().unwrap()
        );
        assert_eq!(
            envelope.value["atomicCrossJurisdictionPair"]["phase"],
            "proposal"
        );
        let expected_inputs = expected["indices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| {
                let mut input = original[index.as_u64().unwrap() as usize].clone();
                input.as_object_mut().unwrap().remove("sourceRuntimeFrame");
                input
            })
            .collect::<Vec<_>>();
        assert_eq!(envelope.value["entityInputs"], json!(expected_inputs));
    }
    for bad in [
        vec![
            original[0].clone(),
            original[1].clone(),
            original[2].clone(),
        ],
        {
            let mut conflicting = original.clone();
            conflicting[3]["entityTxs"][0]["data"]["proposal"]["frame"]["accountTxs"][0]["data"]
                ["proof"]["binaryHash"] = json!("0x01");
            conflicting
        },
    ] {
        assert!(
            matches!(prepare_envelopes(source, &encode_rows(&bad), &BTreeMap::new(), 10, 1_024 * 1_024),
            Err(RuntimeTransportError::Outbox(reason)) if reason.contains("cross-j-incomplete-cohort"))
        );
    }
    assert_eq!(
        rows,
        encode_rows(&original),
        "permanent WAL rows remain byte-exact"
    );
}

#[test]
fn outbound_pair_stays_in_one_envelope() {
    let marker = atomic_pair("ack", "route-7:fill-9");
    let values = [
        routed_output(TARGET, 0x33, 17, 91, Some(marker.clone())),
        routed_output(TARGET, 0x44, 17, 91, Some(marker.clone())),
    ];
    let rows = encode_rows(&values);
    let prepared = prepare_envelopes(SOURCE, &rows, &BTreeMap::new(), 10, 1_024 * 1_024)
        .expect("atomic envelope");

    assert_eq!(prepared.row_count, 2);
    assert_eq!(prepared.envelopes.len(), 1);
    let envelope = &prepared.envelopes[0];
    assert_eq!(envelope.row_count, 2);
    assert_eq!(envelope.source_height, 17);
    assert_eq!(envelope.source_timestamp, 91);
    assert_eq!(envelope.value["atomicCrossJurisdictionPair"], marker);
    let inputs = envelope.value["entityInputs"]
        .as_array()
        .expect("entity input array");
    assert_eq!(inputs.len(), 2);
    assert!(inputs.iter().all(|input| {
        input.get("atomicCrossJurisdictionPair").is_none()
            && input.get("sourceRuntimeFrame").is_none()
    }));
}

#[test]
fn route_bound_atomic_wal_rows_roundtrip_into_positional_runtime_inputs() {
    use base64::Engine as _;
    // Use captured cross-J peer outputs. Local chat commands are not legal
    // transport inputs and cannot stand in for a production atomic pair.
    let capsule: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/native-cross-cancel-ack-v1.json"
    )))
    .unwrap();
    let source = capsule["sourceRuntimeId"].as_str().unwrap();
    let rows = capsule["rowsBase64"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            base64::engine::general_purpose::STANDARD
                .decode(row.as_str().unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    let prepared = prepare_envelopes(source, &rows, &BTreeMap::new(), 10, 1_024 * 1_024)
        .expect("route-bound atomic WAL rows");
    let envelope = prepared
        .envelopes
        .iter()
        .find(|envelope| envelope.value.get("atomicCrossJurisdictionPair").is_some())
        .expect("one atomic envelope");
    let expected = [2, 1].map(|index| crate::decode_storage_payload(&rows[index]).unwrap());
    let decoded = decode_envelope(
        &encode_transport(&envelope.value).unwrap(),
        source,
        expected[0]["runtimeId"].as_str().unwrap(),
        "atomic-test".into(),
        Some(101),
    )
    .expect("production inbound codec roundtrip");

    assert_eq!(decoded.entity_inputs.len(), 2);
    for (input, expected) in decoded.entity_inputs.iter().zip(expected) {
        let canonical = input.canonical();
        assert_eq!(canonical["entityId"], expected["entityId"]);
        assert_eq!(canonical["entityTxs"], expected["entityTxs"]);
        assert_eq!(
            canonical["atomicCrossJurisdictionPair"],
            envelope.value["atomicCrossJurisdictionPair"]
        );
        assert_eq!(canonical["from"], source);
        assert_eq!(
            canonical["sourceRuntimeFrame"]["height"],
            envelope.source_height
        );
        assert_eq!(
            canonical["sourceRuntimeFrame"]["timestamp"],
            envelope.source_timestamp
        );
    }
    assert_eq!(
        rows,
        capsule["rowsBase64"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                base64::engine::general_purpose::STANDARD
                    .decode(row.as_str().unwrap())
                    .unwrap()
            })
            .collect::<Vec<_>>(),
        "captured WAL stays unchanged"
    );
}

#[test]
fn outbound_malformed_or_over_budget_cohorts_fail_closed() {
    let other_target = "0x5555555555555555555555555555555555555555";
    let marker = atomic_pair("proposal", "route-7:fill-9");
    let cases = [
        vec![routed_output(TARGET, 0x33, 17, 91, Some(marker.clone()))],
        vec![
            routed_output(TARGET, 0x33, 17, 91, Some(marker.clone())),
            routed_output(
                TARGET,
                0x44,
                17,
                91,
                Some(atomic_pair("ack", "route-7:fill-9")),
            ),
        ],
        vec![
            routed_output(TARGET, 0x33, 17, 91, Some(marker.clone())),
            routed_output(other_target, 0x44, 17, 91, Some(marker.clone())),
        ],
        vec![
            routed_output(TARGET, 0x33, 17, 91, Some(marker.clone())),
            routed_output(TARGET, 0x44, 18, 91, Some(marker.clone())),
        ],
        vec![
            routed_output(TARGET, 0x33, 17, 91, Some(marker.clone())),
            routed_output(TARGET, 0x44, 17, 91, None),
            routed_output(TARGET, 0x55, 17, 91, Some(marker.clone())),
        ],
    ];
    for values in cases {
        let rows = encode_rows(&values);
        assert!(matches!(
            prepare_envelopes(SOURCE, &rows, &BTreeMap::new(), 10, 1_024 * 1_024),
            Err(RuntimeTransportError::Outbox(_)),
        ));
    }

    let valid_pair = [
        routed_output(TARGET, 0x33, 17, 91, Some(marker.clone())),
        routed_output(TARGET, 0x44, 17, 91, Some(marker)),
    ];
    let rows = encode_rows(&valid_pair);
    assert!(matches!(
        prepare_envelopes(SOURCE, &rows, &BTreeMap::new(), 1, 1_024 * 1_024),
        Err(RuntimeTransportError::Outbox(_)),
    ));
    assert!(matches!(
        prepare_envelopes(
            SOURCE,
            &rows,
            &BTreeMap::new(),
            2,
            rows.iter().map(Vec::len).sum::<usize>() - 1,
        ),
        Err(RuntimeTransportError::Outbox(_)),
    ));
}

#[test]
fn inbound_pair_is_injected_into_both_canonical_inputs() {
    let marker = json!({"phase":"proposal","pairKey":"route-7:fill-9"});
    let value = inbound_envelope(
        Some(marker.clone()),
        vec![entity_input(0x33, TARGET), entity_input(0x44, TARGET)],
    );
    let decoded = decode_inbound(value).expect("valid atomic envelope");

    assert_eq!(decoded.entity_inputs.len(), 2);
    for input in decoded.entity_inputs {
        assert_eq!(input.canonical()["atomicCrossJurisdictionPair"], marker);
        assert_eq!(input.canonical()["from"], SOURCE);
        assert_eq!(input.canonical()["sourceRuntimeFrame"]["height"], 17);
        assert_eq!(input.canonical()["sourceRuntimeFrame"]["timestamp"], 91);
    }
}

#[test]
fn inbound_malformed_or_incomplete_envelopes_fail_closed() {
    let cases = [
        inbound_envelope(
            Some(json!({"phase":"proposal","pairKey":"route-7:fill-9"})),
            vec![entity_input(0x33, TARGET)],
        ),
        inbound_envelope(
            Some(json!({"phase":"proposal","pairKey":"route-7:fill-9"})),
            vec![
                entity_input(0x33, TARGET),
                entity_input(0x44, TARGET),
                entity_input(0x55, TARGET),
            ],
        ),
        inbound_envelope(
            Some(json!({"phase":"invalid","pairKey":"route-7:fill-9"})),
            vec![entity_input(0x33, TARGET), entity_input(0x44, TARGET)],
        ),
        inbound_envelope(
            Some(json!({"phase":"ack","pairKey":""})),
            vec![entity_input(0x33, TARGET), entity_input(0x44, TARGET)],
        ),
        inbound_envelope(
            Some(json!({"phase":"ack","pairKey":"route-7:fill-9","extra":true})),
            vec![entity_input(0x33, TARGET), entity_input(0x44, TARGET)],
        ),
        inbound_envelope(
            Some(json!({"phase":"ack","pairKey":"route-7:fill-9"})),
            vec![entity_input(0x33, SOURCE), entity_input(0x44, TARGET)],
        ),
    ];

    for value in cases {
        assert!(matches!(
            decode_inbound(value),
            Err(RuntimeTransportError::Inbound(_))
        ));
    }
}

fn atomic_pair(phase: &str, pair_key: &str) -> Value {
    Value::Object(Map::from_iter([
        ("phase".into(), Value::String(phase.into())),
        ("pairKey".into(), Value::String(pair_key.into())),
    ]))
}

fn routed_output(
    target: &str,
    entity_byte: u8,
    height: u64,
    timestamp: u64,
    atomic_pair: Option<Value>,
) -> Value {
    let mut output = Map::from_iter([
        ("runtimeId".into(), Value::String(target.into())),
        (
            "entityId".into(),
            Value::String(format!("0x{}", format!("{entity_byte:02x}").repeat(32))),
        ),
        ("signerId".into(), Value::String("1".into())),
        (
            "entityTxs".into(),
            Value::Array(vec![Value::Object(Map::from_iter([
                ("type".into(), Value::String("chat".into())),
                (
                    "data".into(),
                    Value::Object(Map::from_iter([
                        ("from".into(), Value::String("atomic-test".into())),
                        ("message".into(), Value::String("roundtrip".into())),
                    ])),
                ),
            ]))]),
        ),
        (
            "sourceRuntimeFrame".into(),
            Value::Object(Map::from_iter([
                ("height".into(), Value::from(height)),
                ("timestamp".into(), Value::from(timestamp)),
            ])),
        ),
    ]);
    if let Some(pair) = atomic_pair {
        output.insert("atomicCrossJurisdictionPair".into(), pair);
    }
    Value::Object(output)
}

fn encode_rows(values: &[Value]) -> Vec<Vec<u8>> {
    values
        .iter()
        .map(|value| encode_framed(value).expect("atomic output row"))
        .collect()
}

fn decode_inbound(value: Value) -> Result<InboundEntityInputs, RuntimeTransportError> {
    decode_envelope(
        &encode_transport(&value)?,
        SOURCE,
        TARGET,
        "atomic-test".into(),
        Some(101),
    )
}

fn inbound_envelope(marker: Option<Value>, entity_inputs: Vec<Value>) -> Value {
    let mut value = Map::from_iter([
        ("sourceRuntimeId".into(), Value::String(SOURCE.into())),
        ("sourceRuntimeHeight".into(), Value::from(17)),
        ("sourceRuntimeTimestamp".into(), Value::from(91)),
        ("entityInputs".into(), Value::Array(entity_inputs)),
    ]);
    if let Some(marker) = marker {
        value.insert("atomicCrossJurisdictionPair".into(), marker);
    }
    Value::Object(value)
}

fn entity_input(entity_byte: u8, runtime_id: &str) -> Value {
    json!({
        "runtimeId": runtime_id,
        "entityId": format!("0x{}", format!("{entity_byte:02x}").repeat(32)),
        "signerId": "1",
        "entityTxs": [],
    })
}

#[test]
fn r7_h44_cross_pull_lock_wal_infers_the_exact_ts_atomic_envelope() {
    use base64::Engine as _;
    let capsule: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/runtime-transport/r7-h44-atomic.json"
    )))
    .expect("immutable production R7 h44 capsule");
    let rows: Vec<Vec<u8>> = capsule["rowsBase64"]
        .as_array()
        .expect("original WAL rows")
        .iter()
        .map(|row| {
            base64::engine::general_purpose::STANDARD
                .decode(row.as_str().expect("base64"))
                .expect("original row bytes")
        })
        .collect();
    let prepared = prepare_envelopes(
        capsule["sourceRuntimeId"].as_str().expect("source"),
        &rows,
        &BTreeMap::new(),
        10,
        1_024 * 1_024,
    )
    .expect("paired committed cross_pull_lock proposals");
    let original = rows
        .iter()
        .map(|row| crate::decode_storage_payload(row).expect("original WAL codec"))
        .collect::<Vec<_>>();
    let mut mismatches = Vec::new();
    let mut wrong_ladder = original.clone();
    wrong_ladder[1]["entityTxs"][0]["data"]["proposal"]["frame"]["accountTxs"][0]["data"]["fullHash"] =
        json!("0x01");
    mismatches.push(wrong_ladder);
    let mut wrong_route = original.clone();
    wrong_route[1]["entityTxs"][0]["data"]["proposal"]["frame"]["accountTxs"][0]["data"]["crossJurisdictionRoute"]
        ["target"]["amount"] = json!("1");
    mismatches.push(wrong_route);
    let mut missing_offer = original.clone();
    missing_offer[0]["entityTxs"][0]["data"]["proposal"]["frame"]["accountTxs"]
        .as_array_mut()
        .unwrap()
        .retain(|tx| tx["type"] != "swap_offer");
    mismatches.push(missing_offer);
    let mut same_entity = original.clone();
    same_entity[1]["entityId"] = same_entity[0]["entityId"].clone();
    mismatches.push(same_entity);
    for mismatch in mismatches {
        assert!(
            matches!(prepare_envelopes(
            capsule["sourceRuntimeId"].as_str().unwrap(), &encode_rows(&mismatch),
            &BTreeMap::new(), 10, 1_024 * 1_024,
        ), Err(RuntimeTransportError::Outbox(ref reason)) if reason.contains("cross-j-incomplete-cohort")),
            "same order id alone cannot authorize atomic delivery"
        );
    }
    assert_eq!(prepared.envelopes.len(), 1);
    let envelope = &prepared.envelopes[0];
    assert_eq!(
        envelope.value["atomicCrossJurisdictionPair"],
        capsule["expectedAtomicPair"]
    );
    assert_eq!(
        envelope.value["entityInputs"][0]["entityId"],
        "0x0dc3485c83264b018428dde101e179be75eacfe63be6fa67c0cbc0f0f1808181"
    );
    assert_eq!(
        envelope.value["entityInputs"][1]["entityId"],
        "0x840a5830e1c4d436277d9a797d646476516f66cf3f83893989fe05fd64c4587e"
    );
    assert!(
        prepare_envelopes(
            capsule["sourceRuntimeId"].as_str().unwrap(),
            &rows,
            &BTreeMap::new(),
            1,
            1_024 * 1_024
        )
        .is_err(),
        "an inferred atomic pair must never be split by the transport limit"
    );
}

#[test]
fn r7_h91_source_only_cross_pull_close_wal_fails_before_publication() {
    use base64::Engine as _;
    let capsule: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/runtime-transport/r7-h91-incomplete.json"
    )))
    .expect("actual R15 expiry output: two disjoint sets of nine source closes");
    assert_eq!(
        capsule["expectedPairs"],
        json!([]),
        "the canonical TS selector found no counterpart"
    );
    let rows = capsule["rowsBase64"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            base64::engine::general_purpose::STANDARD
                .decode(row.as_str().unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    let result = prepare_envelopes(
        capsule["sourceRuntimeId"].as_str().unwrap(),
        &rows,
        &BTreeMap::new(),
        10,
        1_024 * 1_024,
    );
    assert!(
        matches!(result, Err(RuntimeTransportError::Outbox(ref reason)) if reason.contains("cross-j-incomplete-cohort")),
        "incomplete signed financial cohorts must fail locally, never reach the peer or be silently parked"
    );
}
