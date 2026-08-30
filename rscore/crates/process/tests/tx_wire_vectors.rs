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
    for chunk in text.split("\"name\":").skip(1) {
        let name = chunk
            .split('"')
            .nth(1)
            .unwrap_or_else(|| panic!("vector name in {chunk}"))
            .to_string();
        let hex = chunk
            .split("\"bytes\":")
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .unwrap_or_else(|| panic!("vector bytes for {name}"));
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
