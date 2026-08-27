use serde_json::{Map, Value};

use super::crypto::{
    encryption_identity, frame_digest, frame_mac, hello_digest, static_public_hex,
};
use super::msgpack::encode_framed;
use super::routing::prepare_envelopes;
use super::{DirectRoute, DirectRouteTable, RuntimeTransportError};
mod direct;
mod inbound;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn websocket_codec_and_auth_match_typescript_goldens() {
    let value = Value::Object(Map::from_iter([
        (
            "z".into(),
            Value::Object(Map::from_iter([
                ("__xlnType".into(), Value::String("TypedArray".into())),
                ("kind".into(), Value::String("Uint8Array".into())),
                ("value".into(), Value::String("AQID".into())),
            ])),
        ),
        (
            "a".into(),
            Value::Object(Map::from_iter([
                ("n".into(), Value::from(7)),
                ("s".into(), Value::String("x".into())),
            ])),
        ),
        (
            "m".into(),
            Value::Object(Map::from_iter([
                ("__xlnType".into(), Value::String("Map".into())),
                (
                    "value".into(),
                    Value::Array(vec![
                        Value::Array(vec![Value::String("b".into()), tagged_bigint("2")]),
                        Value::Array(vec![Value::String("a".into()), tagged_bigint("1")]),
                    ]),
                ),
            ])),
        ),
    ]));
    assert_eq!(
        hex(&encode_framed(&value).expect("framed")),
        "03d4724093a161a16da17ad4724192a16ea17307a17882a161d30000000000000001a162d30000000000000002c7047401010203",
    );
    let identity = encryption_identity("transport-test-seed");
    assert_eq!(
        static_public_hex(&identity),
        "0x953809ce01c5b3abacd9d9526a454e983aa2231c3e284e526cf433b82b5ddf7c",
    );
    let message = auth_fixture_message();
    let key = decode_32("f9be29bd28c1f6cf7d005e4a7a262236d3354221398b01b82e4e4fcb726d3a57");
    let audience = "xln-runtime:0x1111111111111111111111111111111111111111";
    assert_eq!(
        frame_mac(&key, &message, audience, "0xchallenge", 1).expect("mac"),
        "b9652395deaf7dda89a2409424de32cde5edbcd4c9a20806351afe94812573e3",
    );
    assert_eq!(
        format!(
            "0x{}",
            hex(&frame_digest(&message, audience, "0xchallenge", 1).expect("hash"))
        ),
        "0xb59264025a5bb1459480185f3a9c564a2296d3c412e24a020af92277c0e576a0",
    );
    assert_eq!(
        format!(
            "0x{}",
            hex(&hello_digest(
                "0x2222222222222222222222222222222222222222",
                &format!("0x{}", "33".repeat(32)),
                123,
                "0xchallenge",
                audience,
                &format!("0x{}", "55".repeat(32)),
            ))
        ),
        "0x5f162680a47059fd4bfe2264e7dca792f41b462150573597b5397832463a853d",
    );
}

#[test]
fn invalid_routes_and_outbox_rows_fail_loudly() {
    assert!(matches!(
        DirectRouteTable::new([DirectRoute {
            target_runtime_id: "not-a-runtime".into(),
            url: "ws://127.0.0.1:1".into(),
        }]),
        Err(RuntimeTransportError::Route(_)),
    ));
    let source = "0x2222222222222222222222222222222222222222";
    let target = "0x1111111111111111111111111111111111111111";
    let missing_frame = Value::Object(Map::from_iter([
        ("runtimeId".into(), Value::String(target.into())),
        (
            "entityId".into(),
            Value::String(format!("0x{}", "33".repeat(32))),
        ),
        ("signerId".into(), Value::String("1".into())),
        ("entityTxs".into(), Value::Array(vec![])),
    ]));
    let row = encode_framed(&missing_frame).expect("malformed fixture bytes");
    assert!(matches!(
        prepare_envelopes(
            source,
            &[row],
            &std::collections::BTreeMap::new(),
            10,
            1_024
        ),
        Err(RuntimeTransportError::Outbox(_)),
    ));
}

fn tagged_bigint(value: &str) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String("BigInt".into())),
        ("value".into(), Value::String(value.into())),
    ]))
}

fn auth_fixture_message() -> Value {
    Value::Object(Map::from_iter([
        ("type".into(), Value::String("entity_inputs".into())),
        ("id".into(), Value::String("rrs_7_1".into())),
        (
            "from".into(),
            Value::String("0x2222222222222222222222222222222222222222".into()),
        ),
        (
            "fromEncryptionPubKey".into(),
            Value::String(format!("0x{}", "33".repeat(32))),
        ),
        (
            "to".into(),
            Value::String("0x1111111111111111111111111111111111111111".into()),
        ),
        ("encSeq".into(), Value::from(1)),
        ("timestamp".into(), Value::from(9)),
        (
            "payload".into(),
            Value::Object(Map::from_iter([
                ("__xlnType".into(), Value::String("TypedArray".into())),
                ("kind".into(), Value::String("Uint8Array".into())),
                ("value".into(), Value::String("BAUG".into())),
            ])),
        ),
        ("encrypted".into(), Value::Bool(true)),
        (
            "entityId".into(),
            Value::String(format!("0x{}", "44".repeat(32))),
        ),
        ("txs".into(), Value::from(1)),
    ]))
}

fn decode_32(value: &str) -> [u8; 32] {
    let bytes = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex"))
        .collect::<Vec<_>>();
    bytes.try_into().expect("32 bytes")
}
