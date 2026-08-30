//! Compact Entity-layer commitment to one exact AccountInput.

use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

use super::EntityFrameError;

const DOMAIN: &[u8] = b"xln:account-input-commitment:v1";

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub(super) fn account_input_commitment(
    value: &CanonicalValue,
) -> Result<CanonicalValue, EntityFrameError> {
    if !matches!(value, CanonicalValue::Object(_)) {
        return Err(EntityFrameError::Value(
            "ACCOUNT_INPUT_COMMITMENT_OBJECT_REQUIRED".into(),
        ));
    }
    let encoded = encode_canonical_consensus_bytes(value)
        .map_err(|error| EntityFrameError::Encoding(error.to_string()))?;
    let mut digest = Sha256::new();
    digest.update(DOMAIN);
    digest.update(encoded);
    Ok(CanonicalValue::Object(vec![
        (
            "domain".into(),
            CanonicalValue::String(String::from_utf8_lossy(DOMAIN).into_owned()),
        ),
        (
            "inputDigest".into(),
            CanonicalValue::String(hex_digest(&digest.finalize())),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use xln_rscore_protocol::CanonicalNumber;

    use super::*;

    #[test]
    fn exact_typescript_commitment_vector() {
        let input = CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String("ack".into())),
            (
                "fromEntityId".into(),
                CanonicalValue::String(format!("0x{}", "11".repeat(32))),
            ),
            (
                "ack".into(),
                CanonicalValue::Object(vec![
                    (
                        "height".into(),
                        CanonicalValue::Number(CanonicalNumber::from_u32(7)),
                    ),
                    (
                        "frameHash".into(),
                        CanonicalValue::String(format!("0x{}", "22".repeat(32))),
                    ),
                ]),
            ),
        ]);
        let CanonicalValue::Object(commitment) =
            account_input_commitment(&input).expect("commitment")
        else {
            panic!("commitment object")
        };
        assert_eq!(
            commitment[1].1,
            CanonicalValue::String(
                "0x7d54a998573778ccb8840bf1f464b1cbc9af32c0f2c99dad824aecb46169af64".into(),
            )
        );
    }
}
