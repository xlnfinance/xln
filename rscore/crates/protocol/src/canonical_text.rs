//! Exact Rust mirror of TypeScript `encodeCanonicalConsensusValue`.
//!
//! This is the legacy tagged-text consensus domain. It is intentionally
//! separate from canonical MessagePack and account-state RLP.

use std::cmp::Ordering;

use thiserror::Error;

use crate::CanonicalValue;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CanonicalTextError {
    #[error("CANONICAL_TEXT_JSON:{0}")]
    Json(String),
    #[error("CANONICAL_TEXT_DUPLICATE_OBJECT_KEY:{0}")]
    DuplicateObjectKey(String),
}

fn cmp_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn quoted(value: &str) -> Result<String, CanonicalTextError> {
    serde_json::to_string(value).map_err(|error| CanonicalTextError::Json(error.to_string()))
}

pub fn encode_canonical_consensus_text(
    value: &CanonicalValue,
) -> Result<String, CanonicalTextError> {
    Ok(match value {
        CanonicalValue::Null => "[\"Null\"]".into(),
        CanonicalValue::Bool(value) => format!("[\"Boolean\",{value}]"),
        CanonicalValue::Number(value) => format!("[\"Number\",{}]", quoted(value.as_str())?),
        CanonicalValue::BigInt(value) => {
            format!("[\"BigInt\",{}]", quoted(&value.to_string())?)
        }
        CanonicalValue::String(value) => format!("[\"String\",{}]", quoted(value)?),
        CanonicalValue::Array(values) => format!(
            "[\"Array\",[{}]]",
            values
                .iter()
                .map(encode_canonical_consensus_text)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        ),
        CanonicalValue::Object(entries) => {
            let mut entries = entries.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| cmp_utf16(&left.0, &right.0));
            if let Some(pair) = entries.windows(2).find(|pair| pair[0].0 == pair[1].0) {
                return Err(CanonicalTextError::DuplicateObjectKey(pair[0].0.clone()));
            }
            let body = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "[{},{}]",
                        quoted(key)?,
                        encode_canonical_consensus_text(value)?
                    ))
                })
                .collect::<Result<Vec<_>, CanonicalTextError>>()?
                .join(",");
            format!("[\"Object\",[{body}]]")
        }
        CanonicalValue::Map(entries) => {
            let mut entries = entries
                .iter()
                .map(|(key, value)| {
                    Ok((
                        encode_canonical_consensus_text(key)?,
                        encode_canonical_consensus_text(value)?,
                    ))
                })
                .collect::<Result<Vec<_>, CanonicalTextError>>()?;
            entries.sort_by(|left, right| match cmp_utf16(&left.0, &right.0) {
                Ordering::Equal => cmp_utf16(&left.1, &right.1),
                ordering => ordering,
            });
            format!(
                "[\"Map\",[{}]]",
                entries
                    .into_iter()
                    .map(|(key, value)| format!("[{key},{value}]"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        CanonicalValue::Set(values) => {
            let mut values = values
                .iter()
                .map(encode_canonical_consensus_text)
                .collect::<Result<Vec<_>, _>>()?;
            values.sort_by(|left, right| cmp_utf16(left, right));
            format!("[\"Set\",[{}]]", values.join(","))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CanonicalNumber;

    #[test]
    fn object_keys_and_scalar_tags_match_typescript() {
        let value = CanonicalValue::Object(vec![
            ("z".into(), CanonicalValue::BigInt(2.into())),
            (
                "a".into(),
                CanonicalValue::Number(CanonicalNumber::try_from_u64(1).expect("number")),
            ),
        ]);
        assert_eq!(
            encode_canonical_consensus_text(&value).expect("text"),
            "[\"Object\",[[\"a\",[\"Number\",\"1\"]],[\"z\",[\"BigInt\",\"2\"]]]]"
        );
    }
}
