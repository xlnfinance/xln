use sha2::{Digest, Sha256};

use crate::rlp::RlpWriter;
use crate::{CanonicalValue, ValueEncodingError, write_account_state_value};

const FLAT_DIGEST_DOMAIN: &[u8] = b"xln.flat-digest.v1";

fn sha256(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

pub fn compute_flat_integrity_root(
    namespace: &str,
    entries: &[(String, CanonicalValue)],
) -> Result<[u8; 32], ValueEncodingError> {
    let mut writer = RlpWriter::with_capacity(512);
    let mut label = String::with_capacity(64);
    let mut leaves = Vec::with_capacity(entries.len());
    for (path, value) in entries {
        // One reused buffer for the label and one for the value: this runs
        // once per committed account, and a fresh String plus a Vec per node
        // was the largest single cost in the engine profile.
        label.clear();
        label.push_str("xln.");
        label.push_str(namespace);
        label.push('.');
        label.push_str(path);
        writer.clear();
        write_account_state_value(&mut writer, value)?;
        leaves.push((sha256(label.as_bytes()), sha256(writer.as_slice())));
    }
    leaves.sort_unstable_by_key(|(key, _)| *key);
    let mut digest = Sha256::new();
    digest.update(FLAT_DIGEST_DOMAIN);
    for (key, value) in leaves {
        digest.update(key);
        digest.update(value);
    }
    Ok(digest.finalize().into())
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;

    use super::*;

    fn text(value: &str) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn number(value: f64) -> CanonicalValue {
        CanonicalValue::Number(value)
    }

    fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
        )
    }

    #[test]
    fn matches_typescript_account_state_vector() {
        let zero = text(&format!("0x{}", "00".repeat(32)));
        let entries = vec![
            (
                "identity".into(),
                object(vec![
                    ("chainId", number(31_337.0)),
                    ("depositoryAddress", text(&format!("0x{}", "11".repeat(20)))),
                    ("leftEntity", text(&format!("0x{}", "22".repeat(32)))),
                    ("rightEntity", text(&format!("0x{}", "33".repeat(32)))),
                    ("watchSeed", text(&format!("0x{}", "44".repeat(32)))),
                ]),
            ),
            (
                "financial".into(),
                object(vec![
                    ("deltasRoot", zero.clone()),
                    ("jNonce", number(7.0)),
                    (
                        "disputeConfig",
                        object(vec![
                            ("leftResponseSeconds", number(11.0)),
                            ("rightResponseSeconds", number(13.0)),
                        ]),
                    ),
                ]),
            ),
            (
                "commitments".into(),
                object(vec![
                    ("locksRoot", zero.clone()),
                    ("settlementWorkspace", CanonicalValue::Null),
                ]),
            ),
            (
                "jurisdiction".into(),
                object(vec![
                    ("lastFinalizedJHeight", number(9.0)),
                    (
                        "leftPendingJClaims",
                        object(vec![("height", number(0.0)), ("root", zero.clone())]),
                    ),
                    (
                        "rightPendingJClaims",
                        object(vec![("height", number(0.0)), ("root", zero.clone())]),
                    ),
                ]),
            ),
            (
                "rebalance".into(),
                object(vec![("requestedRebalanceRoot", zero)]),
            ),
        ];
        let root = compute_flat_integrity_root("account.state", &entries).expect("root");
        assert_eq!(
            hex::encode(root),
            "7b6f98bbb3d769796a4378d58a5640a0602b5229a09f8f14b0103706e45918c3",
        );
    }

    #[test]
    fn number_and_bigint_are_distinct_commitments() {
        let number_root =
            compute_flat_integrity_root("test", &[("value".into(), CanonicalValue::Number(7.0))])
                .expect("number");
        let bigint_root = compute_flat_integrity_root(
            "test",
            &[("value".into(), CanonicalValue::BigInt(BigInt::from(7)))],
        )
        .expect("bigint");
        assert_ne!(number_root, bigint_root);
    }
}
