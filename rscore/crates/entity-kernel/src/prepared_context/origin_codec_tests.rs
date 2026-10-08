use super::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/entity-kernel/origin-codec-ts-v1.json"
    )))
    .unwrap()
}
fn bytes(value: &Value, key: &str) -> Vec<u8> {
    hex::decode(value[key].as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
}
fn final_layer() -> DecodedOnionLayer {
    DecodedOnionLayer::Final {
        secret: format!("0x{}", "81".repeat(32)),
        description: Some("payment π".into()),
        started_at_ms: Some(1_791_440_000_000),
    }
}

#[test]
fn native_origin_matches_captured_ts_final_and_forward_bytes() {
    let golden = fixture();
    let recipient: [u8; 32] = bytes(&golden, "recipient").try_into().unwrap();
    let context: [u8; 32] = bytes(&golden, "context").try_into().unwrap();
    let plaintext = encode_onion_layer(&final_layer()).unwrap();
    assert_eq!(plaintext, bytes(&golden, "finalPlain"));
    let inner = encrypt_opaque_htlc_layer(&plaintext, &recipient, &context, &[0x21; 32]).unwrap();
    assert_eq!(inner.packed(), bytes(&golden, "finalPacked"));
    let forward = DecodedOnionLayer::Forward {
        next_hop: format!("0x{}", "aa".repeat(32)),
        inner_envelope: inner,
        forward_amount: BigInt::from(1000),
    };
    let plaintext = encode_onion_layer(&forward).unwrap();
    assert_eq!(plaintext, bytes(&golden, "forwardPlain"));
    assert_eq!(decode_onion_layer(&plaintext).unwrap(), forward);
    let outer = encrypt_opaque_htlc_layer(&plaintext, &recipient, &context, &[0x22; 32]).unwrap();
    assert_eq!(outer.packed(), bytes(&golden, "forwardPacked"));
    let decoded = decrypt_opaque_htlc_layer(&outer, &recipient, &[0x31; 32], &context).unwrap();
    assert_eq!(decoded, plaintext);
    assert!(decrypt_opaque_htlc_layer(&outer, &recipient, &[0x31; 32], &[0x42; 32]).is_err());
}

#[test]
fn native_origin_keeps_secret_inside_target_and_rejects_invalid_crypto_inputs() {
    let recipient = *PublicKey::from(&StaticSecret::from([0x31; 32])).as_bytes();
    let plaintext = encode_onion_layer(&final_layer()).unwrap();
    let envelope =
        encrypt_opaque_htlc_layer(&plaintext, &recipient, &[0x41; 32], &[0x21; 32]).unwrap();
    assert!(
        !envelope
            .packed()
            .windows(32)
            .any(|window| window == [0x81; 32])
    );
    let opened =
        decrypt_opaque_htlc_layer(&envelope, &recipient, &[0x31; 32], &[0x41; 32]).unwrap();
    assert_eq!(decode_onion_layer(&opened).unwrap(), final_layer());
    assert!(encrypt_opaque_htlc_layer(&plaintext, &[0; 32], &[0x41; 32], &[0x21; 32]).is_err());
    let malformed = DecodedOnionLayer::Final {
        secret: format!("0x{}", "é".repeat(32)),
        description: None,
        started_at_ms: None,
    };
    assert!(encode_onion_layer(&malformed).is_err());
    let invalid_time = DecodedOnionLayer::Final {
        secret: format!("0x{}", "81".repeat(32)),
        description: None,
        started_at_ms: Some(0),
    };
    assert!(encode_onion_layer(&invalid_time).is_err());
}
