use super::*;
#[test]
fn evm_replacement_preserves_nonce_and_intent_and_rounds_both_caps() {
    let key = [0x21; 32];
    let mut tx = Eip1559Transaction {
        chain_id: 31337,
        nonce: 7,
        to: [0x22; 20],
        value: 0.into(),
        data: vec![0x12, 0x34],
        gas_limit: 50000.into(),
        max_fee_per_gas: 100.into(),
        max_priority_fee_per_gas: 10.into(),
    };
    let old = format!("0x{}", hex::encode(tx.sign(&key).unwrap().raw));
    tx.max_fee_per_gas = 125.into();
    tx.max_priority_fee_per_gas = 13.into();
    let raw = format!("0x{}", hex::encode(tx.sign(&key).unwrap().raw));
    let hash = format!(
        "0x{}",
        hex::encode(decode_prepared_transaction(&old, false).unwrap().hash)
    );
    assert!(validate(&old, &raw, &hash, 2500).is_ok());
    tx.nonce += 1;
    let wrong = format!("0x{}", hex::encode(tx.sign(&key).unwrap().raw));
    assert!(validate(&old, &wrong, &hash, 2500).is_err());
    assert_eq!(bump(10.into(), 2500).unwrap(), U256::from(13));
    assert!(validate(&old, &raw, &hash, 3000).is_err());
}

#[test]
fn market_fee_tuple_keeps_priority_distinct_from_total_cap() {
    struct Market;
    impl crate::j_watcher::JsonRpc for Market {
        fn call(
            &self,
            method: &str,
            _: serde_json::Value,
        ) -> Result<serde_json::Value, crate::j_watcher::JWatcherError> {
            Ok(match method {
                "eth_getBlockByNumber" => serde_json::json!({"baseFeePerGas":"0x64"}),
                "eth_maxPriorityFeePerGas" => serde_json::json!("0xa"),
                _ => panic!("unexpected RPC {method}"),
            })
        }
    }
    let key = [0x21; 32];
    let tx = Eip1559Transaction {
        chain_id: 31337,
        nonce: 7,
        to: [0x22; 20],
        value: 0.into(),
        data: vec![1],
        gas_limit: 50000.into(),
        max_fee_per_gas: 100.into(),
        max_priority_fee_per_gas: 10.into(),
    };
    let raw = format!("0x{}", hex::encode(tx.sign(&key).unwrap().raw));
    let submitter = super::super::JSubmitter::new(
        &Market,
        super::super::JSubmitConfig {
            chain_id: 31337,
            depository_address: tx.to,
            operator_private_key: key,
            max_fee_per_gas: 1000.into(),
            gas_headroom_bps: 12000,
        },
    )
    .unwrap();
    let record = submitter
        .prepared_record("SimNet", "market-attempt", raw.clone())
        .unwrap();
    let limits = record
        .fee_authorization
        .unwrap()
        .validate("SimNet", "market-attempt", &raw)
        .unwrap();
    let next = submitter
        .prepare_evm_replacement(&raw, 2500, false, &limits)
        .unwrap()
        .unwrap();
    let decoded = decode_prepared_transaction(&next, false).unwrap();
    assert_eq!(decoded.max_fee, U256::from(210));
    assert_eq!(decoded.priority_fee, U256::from(13));
}

#[test]
fn repeated_underpriced_replacements_stop_at_payer_maximum() {
    struct Market;
    impl crate::j_watcher::JsonRpc for Market {
        fn call(
            &self,
            method: &str,
            _: serde_json::Value,
        ) -> Result<serde_json::Value, crate::j_watcher::JWatcherError> {
            Ok(match method {
                "eth_getBlockByNumber" => serde_json::json!({"baseFeePerGas":"0x0"}),
                "eth_maxPriorityFeePerGas" => serde_json::json!("0x1"),
                _ => panic!("unexpected RPC {method}"),
            })
        }
    }
    let key = [0x21; 32];
    let tx = Eip1559Transaction {
        chain_id: 31337,
        nonce: 7,
        to: [0x22; 20],
        value: 0.into(),
        data: vec![1],
        gas_limit: 50000.into(),
        max_fee_per_gas: 2.into(),
        max_priority_fee_per_gas: 1.into(),
    };
    let original = format!("0x{}", hex::encode(tx.sign(&key).unwrap().raw));
    let submitter = super::super::JSubmitter::new(
        &Market,
        super::super::JSubmitConfig {
            chain_id: 31337,
            depository_address: tx.to,
            operator_private_key: key,
            max_fee_per_gas: 4.into(),
            gas_headroom_bps: 12000,
        },
    )
    .unwrap();
    for (max, tip, allowed) in [(4, 3, 2), (100, 2, 1), (3, 3, 1)] {
        let limits = EvmFeeLimits {
            max_fee_per_gas: max.into(),
            max_priority_fee_per_gas: tip.into(),
        };
        let mut raw = original.clone();
        for index in 0..5 {
            // Recovery uses persisted limits, never a new RPC/config-derived budget.
            let restored = EvmFeeLimits::decode(
                &serde_json::from_slice::<serde_json::Value>(
                    &serde_json::to_vec(&limits.encode()).unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            let next = submitter
                .prepare_evm_replacement(&raw, 1250, true, &restored)
                .unwrap();
            if index >= allowed {
                assert!(
                    next.is_none(),
                    "fresh rejection must not raise either payer ceiling"
                );
            } else {
                raw = next.expect("authorized replacement");
            }
        }
    }
}

#[test]
fn payer_authorization_matches_typescript_bytes_and_rejects_changed_authority() {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../fixtures/evm-fee-authorization-v1.json"
    ))
    .unwrap();
    let text = |key| value[key].as_str().unwrap();
    let auth = EvmFeeAuthorization::decode(&serde_json::json!({"maxFeePerGasWei":text("maxFeePerGasWei"),"maxPriorityFeePerGasWei":text("maxPriorityFeePerGasWei"),"signature":text("signature")})).unwrap();
    assert_eq!(
        format!(
            "0x{}",
            hex::encode(
                auth.digest(
                    text("jurisdictionName"),
                    text("attemptId"),
                    text("rawTransaction")
                )
                .unwrap()
            )
        ),
        text("digest")
    );
    assert_eq!(
        auth.validate(
            text("jurisdictionName"),
            text("attemptId"),
            text("rawTransaction")
        )
        .unwrap(),
        auth.limits
    );
    assert!(
        auth.validate("OtherNet", text("attemptId"), text("rawTransaction"))
            .is_err()
    );
    assert!(
        auth.validate(
            text("jurisdictionName"),
            "next-attempt",
            text("rawTransaction")
        )
        .is_err()
    );
    let mut alternate = hex::decode(&auth.signature[2..]).unwrap();
    let order = U256::from_str_radix(
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
        16,
    )
    .unwrap();
    let high_s = order - U256::from_big_endian(&alternate[32..64]);
    high_s.to_big_endian(&mut alternate[32..64]);
    alternate[64] = if alternate[64] == 27 { 28 } else { 27 };
    let mut noncanonical = auth.clone();
    noncanonical.signature = format!("0x{}", hex::encode(alternate));
    assert!(
        noncanonical
            .validate(
                text("jurisdictionName"),
                text("attemptId"),
                text("rawTransaction")
            )
            .is_err()
    );
    let mut changed = auth.clone();
    changed.limits.max_priority_fee_per_gas += U256::one();
    assert!(
        changed
            .validate(
                text("jurisdictionName"),
                text("attemptId"),
                text("rawTransaction")
            )
            .is_err()
    );
    for max in [
        "-1".to_owned(),
        "01".into(),
        "1e2".into(),
        format!("{}0", U256::MAX),
    ] {
        assert!(
            EvmFeeLimits::decode(
                &serde_json::json!({"maxFeePerGasWei":max,"maxPriorityFeePerGasWei":"0"})
            )
            .is_err()
        );
    }
}
