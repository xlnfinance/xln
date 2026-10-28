//! The transaction wire, held to bytes TypeScript produced.
//!
//! A Rust round trip proves this engine is self-consistent, which is exactly
//! what a codec that disagrees with the other language also is. These vectors
//! come from `accountTxWire` (core/rscore/shadow-wire.ts) via TypeScript's own
//! encoder: decoding them proves the two languages read the same bytes, and
//! re-encoding them proves this side would have written them.
//!
//! Regenerate with the generator named in core/__tests__/rscore/tx-wire.test.ts
//! whenever a transaction gains a field — and expect the diff to be reviewed,
//! because a changed vector is a changed protocol.

use std::path::Path;

fn vectors() -> Vec<(String, Vec<u8>)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../core/__tests__/rscore/tx-wire-vectors.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    // A flat array of {name, bytes}; parsing it by hand keeps this crate free
    // of a JSON dependency it needs nowhere else.
    let mut rows = Vec::new();
    let quoted = |chunk: &str, key: &str| -> Option<String> {
        chunk
            .split(&format!("\"{key}\":"))
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .map(str::to_string)
    };
    // Each `{ ... }` object carries both keys; their order is whatever the
    // TypeScript serializer chose, so read each key independently.
    for chunk in text.split('{').skip(1) {
        let name = quoted(chunk, "name").unwrap_or_else(|| panic!("vector name in {chunk}"));
        let hex = quoted(chunk, "bytes").unwrap_or_else(|| panic!("vector bytes for {name}"));
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
            .collect();
        rows.push((name, bytes));
    }
    assert!(!rows.is_empty(), "the vector file is not empty");
    rows
}

#[test]
fn every_transaction_typescript_writes_decodes_and_re_encodes_identically() {
    let mut covered = std::collections::BTreeSet::new();
    for (name, bytes) in vectors() {
        let value = xln_rscore_process::decode_wire_value(&bytes)
            .unwrap_or_else(|error| panic!("{name}: decode bytes: {error}"));
        let tx = xln_rscore_process::decode_account_tx(&value)
            .unwrap_or_else(|error| panic!("{name}: decode tx: {error}"));
        covered.insert(tx.wire_name());
        let re_encoded = xln_rscore_process::encode_account_tx(&tx)
            .unwrap_or_else(|error| panic!("{name}: encode: {error}"));
        assert_eq!(re_encoded, value, "{name}: re-encoded to a different value");
        let re_encoded_bytes = xln_rscore_process::encode_wire_value(&re_encoded)
            .unwrap_or_else(|error| panic!("{name}: encode bytes: {error}"));
        assert_eq!(
            hex::encode(&re_encoded_bytes),
            hex::encode(&bytes),
            "{name}: re-encoded to different bytes",
        );
    }
    assert_eq!(
        covered,
        xln_rscore_engine::ACCOUNT_TX_TYPES.into_iter().collect(),
        "shared vectors must cover every canonical AccountTx exactly by kind",
    );
}

#[test]
fn raw_lending_tokens_survive_json_wire_checkpoint_and_hash_without_narrowing() {
    use serde_json::json;
    for raw in [2, 65536, 4294967297, 9007199254740991_u64] {
        for kind in ["lending_repay", "lending_borrow_request"] {
            let mut data = json!({
                "hubEntityId": format!("0x{}", "11".repeat(32)),
                "borrowerEntityId": format!("0x{}", "22".repeat(32)),
                "tokenId": raw, "amount": {"__xlnType":"BigInt", "value":"100"}
            });
            if kind == "lending_repay" {
                data["loanId"] = json!("loan-0327fd9035d42518");
                data["claimHash"] = json!(format!("0x{}", "33".repeat(32)));
            } else {
                data["requestId"] = json!("borrow-2222222222222222");
                data["termId"] = json!("1d");
                data["maxInterestBps"] = json!(100);
                data["maxLateMs"] = json!(86400000);
                data["expiresAt"] = json!(5000);
            }
            let json_tx = json!({"type":kind,"data":data});
            let tx = xln_rscore_runtime::decode_account_tx_json(&json_tx, 0).unwrap();
            let wire = xln_rscore_process::encode_account_tx(&tx).unwrap();
            assert_eq!(xln_rscore_process::decode_account_tx(&wire).unwrap(), tx);
            let canonical = xln_rscore_engine::canonical_tx_value(&tx).unwrap();
            let xln_rscore_protocol::CanonicalValue::Object(fields) = canonical else {
                panic!("canonical tx object")
            };
            let (_, xln_rscore_protocol::CanonicalValue::Object(data)) =
                fields.iter().find(|(k, _)| k == "data").unwrap()
            else {
                panic!("canonical tx data")
            };
            assert_eq!(
                data.iter().find(|(k, _)| k == "tokenId").unwrap().1,
                xln_rscore_protocol::CanonicalValue::Number(
                    xln_rscore_protocol::CanonicalNumber::try_from_u64(raw).unwrap()
                )
            );
            let bytes = xln_rscore_process::encode_wire_value(&wire).unwrap();
            assert_eq!(xln_rscore_process::decode_wire_value(&bytes).unwrap(), wire);
        }
    }
}
