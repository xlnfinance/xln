use super::*;
#[test]
fn genuine_tronweb_wire_recovers_exact_call_and_rejects_mutations() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/tron-signed-call-v1.json"
    ))
    .unwrap();
    let raw = fixture["raw"].as_str().unwrap();
    let decoded = decode_prepared_transaction(&format!("0x{raw}"), true).unwrap();
    assert_eq!(hex::encode(decoded.hash), fixture["hash"].as_str().unwrap());
    assert_eq!(hex::encode(decoded.to), fixture["to"].as_str().unwrap());
    assert_eq!(hex::encode(decoded.data), fixture["data"].as_str().unwrap());
    assert_eq!(decoded.value, U256::zero());
    assert_eq!(decoded.chain_id, None);
    assert_eq!(decoded.nonce, 0);
    let key: Word = hex::decode(fixture["key"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        decoded.signer,
        xln_rscore_crypto::address_of_private_key(&key).unwrap()
    );
    let original = hex::decode(raw).unwrap();
    for length in 0..original.len() {
        assert!(
            decode_prepared_transaction(&format!("0x{}", hex::encode(&original[..length])), true)
                .is_err()
        );
    }
    for offset in [5, 14, 22, 142, original.len() - 2] {
        let mut changed = original.clone();
        changed[offset] ^= 1;
        assert!(decode_prepared_transaction(&format!("0x{}", hex::encode(changed)), true).is_err());
    }
    assert!(decode_prepared_transaction(&format!("0x{raw}0801"), true).is_err());
    assert!(decode_prepared_transaction(&format!("0x{raw}"), false).is_err());
}
#[test]
fn signed_eip1559_recovers_authority_and_exact_intent_fields() {
    let key = [1; 32];
    let tx = Eip1559Transaction {
        chain_id: 31337,
        nonce: 7,
        max_priority_fee_per_gas: 1.into(),
        max_fee_per_gas: 2.into(),
        gas_limit: 500000.into(),
        to: [0x12; 20],
        value: 0.into(),
        data: vec![1, 2, 3, 4],
    };
    let signed = tx.sign(&key).unwrap();
    let decoded =
        decode_prepared_transaction(&format!("0x{}", hex::encode(&signed.raw)), false).unwrap();
    assert_eq!(decoded.hash, signed.hash);
    assert_eq!(
        decoded.signer,
        xln_rscore_crypto::address_of_private_key(&key).unwrap()
    );
    assert_eq!(
        (
            decoded.to,
            decoded.value,
            decoded.data,
            decoded.nonce,
            decoded.chain_id
        ),
        (tx.to, tx.value, tx.data.clone(), 7, Some(31337))
    );
    let other = tx.sign(&[2; 32]).unwrap();
    assert_ne!(
        decode_prepared_transaction(&format!("0x{}", hex::encode(other.raw)), false)
            .unwrap()
            .signer,
        decoded.signer
    );
    for length in 0..signed.raw.len() {
        assert!(
            decode_prepared_transaction(
                &format!("0x{}", hex::encode(&signed.raw[..length])),
                false
            )
            .is_err()
        );
    }
    let mut trailing = signed.raw.clone();
    trailing.push(0);
    assert!(decode_prepared_transaction(&format!("0x{}", hex::encode(trailing)), false).is_err());
    assert!(decode_prepared_transaction("0x02c0", false).is_err());
    assert!(decode_prepared_transaction("0x00", true).is_err());
}
