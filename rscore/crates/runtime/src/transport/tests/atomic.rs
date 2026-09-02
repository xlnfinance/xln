use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::super::inbound::envelope::decode_envelope;
use super::super::msgpack::{encode_framed, encode_transport};
use super::super::routing::prepare_envelopes;
use super::super::{InboundEntityInputs, RuntimeTransportError};

const SOURCE: &str = "0x2222222222222222222222222222222222222222";
const TARGET: &str = "0x1111111111111111111111111111111111111111";

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
    let marker = atomic_pair("ack", "route-7:fill-9");
    let entity_bytes = [0x33, 0x44];
    let values = entity_bytes
        .map(|entity_byte| routed_output(TARGET, entity_byte, 17, 91, Some(marker.clone())));
    let rows = encode_rows(&values);
    let prepared = prepare_envelopes(SOURCE, &rows, &BTreeMap::new(), 10, 1_024 * 1_024)
        .expect("route-bound atomic WAL rows");
    let envelope = prepared
        .envelopes
        .into_iter()
        .next()
        .expect("one atomic envelope");

    let decoded = decode_inbound(envelope.value).expect("production inbound codec roundtrip");

    assert_eq!(decoded.entity_inputs.len(), 2);
    for (index, input) in decoded.entity_inputs.iter().enumerate() {
        let canonical = input.canonical();
        assert_eq!(
            canonical["entityId"],
            format!("0x{}", format!("{:02x}", entity_bytes[index]).repeat(32)),
        );
        assert_eq!(canonical["atomicCrossJurisdictionPair"], marker);
        assert_eq!(canonical["from"], SOURCE);
        assert_eq!(canonical["sourceRuntimeFrame"]["height"], 17);
        assert_eq!(canonical["sourceRuntimeFrame"]["timestamp"], 91);
    }
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
