use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TaggedJsonError {
    #[error("RUNTIME_TAGGED_JSON_NUMBER_INVALID:{0}")]
    InvalidNumber(String),
    #[error("RUNTIME_TAGGED_JSON_BIGINT_INVALID:{0}")]
    InvalidBigInt(String),
    #[error("RUNTIME_TAGGED_JSON_MAP_INVALID")]
    InvalidMap,
    #[error("RUNTIME_TAGGED_JSON_SET_INVALID")]
    InvalidSet,
    #[error("RUNTIME_TAGGED_JSON_TAG_UNSUPPORTED:{0}")]
    UnsupportedTag(String),
}

fn number(value: &serde_json::Number) -> Result<CanonicalValue, TaggedJsonError> {
    let text = value.to_string();
    CanonicalNumber::parse_js_canonical(&text)
        .map(CanonicalValue::Number)
        .map_err(|_| TaggedJsonError::InvalidNumber(text))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, TaggedJsonError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| TaggedJsonError::UnsupportedTag(field.to_string()))
}

fn tagged(object: &Map<String, Value>, tag: &str) -> Result<CanonicalValue, TaggedJsonError> {
    match tag {
        "BigInt" => {
            let value = required_string(object, "value")?;
            value
                .parse::<BigInt>()
                .map(CanonicalValue::BigInt)
                .map_err(|_| TaggedJsonError::InvalidBigInt(value.to_string()))
        }
        "Map" => {
            let rows = object
                .get("value")
                .and_then(Value::as_array)
                .ok_or(TaggedJsonError::InvalidMap)?;
            let mut entries = Vec::with_capacity(rows.len());
            for row in rows {
                let pair = row.as_array().ok_or(TaggedJsonError::InvalidMap)?;
                if pair.len() != 2 {
                    return Err(TaggedJsonError::InvalidMap);
                }
                entries.push((
                    canonical_value_from_tagged_json(&pair[0])?,
                    canonical_value_from_tagged_json(&pair[1])?,
                ));
            }
            Ok(CanonicalValue::Map(entries))
        }
        "Set" => {
            let rows = object
                .get("value")
                .and_then(Value::as_array)
                .ok_or(TaggedJsonError::InvalidSet)?;
            Ok(CanonicalValue::Set(
                rows.iter()
                    .map(canonical_value_from_tagged_json)
                    .collect::<Result<_, _>>()?,
            ))
        }
        other => Err(TaggedJsonError::UnsupportedTag(other.to_string())),
    }
}

/// Convert the repository's canonical tagged JSON interchange into the exact
/// value domain hashed by MessagePack. Tags are decoded before hashing: a
/// serialized BigInt object must never be committed as an ordinary object.
pub fn canonical_value_from_tagged_json(value: &Value) -> Result<CanonicalValue, TaggedJsonError> {
    match value {
        Value::Null => Ok(CanonicalValue::Null),
        Value::Bool(value) => Ok(CanonicalValue::Bool(*value)),
        Value::Number(value) => number(value),
        Value::String(value) => Ok(CanonicalValue::String(value.clone())),
        Value::Array(values) => Ok(CanonicalValue::Array(
            values
                .iter()
                .map(canonical_value_from_tagged_json)
                .collect::<Result<_, _>>()?,
        )),
        Value::Object(object) => {
            if let Some(tag) = object.get("__xlnType").and_then(Value::as_str) {
                return tagged(object, tag);
            }
            Ok(CanonicalValue::Object(
                object
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), canonical_value_from_tagged_json(value)?)))
                    .collect::<Result<_, TaggedJsonError>>()?,
            ))
        }
    }
}

/// Convert an already-validated canonical value back to the repository's
/// tagged JSON envelope. This is the inverse of
/// [`canonical_value_from_tagged_json`]; Runtime uses it only at the existing
/// persisted TS boundary, never as a second consensus codec.
pub fn tagged_json_from_canonical_value(value: &CanonicalValue) -> Result<Value, TaggedJsonError> {
    Ok(match value {
        CanonicalValue::Null => Value::Null,
        CanonicalValue::Bool(value) => Value::Bool(*value),
        CanonicalValue::Number(value) => {
            let text = value.as_str().to_owned();
            Value::Number(
                text.parse()
                    .map_err(|_| TaggedJsonError::InvalidNumber(text))?,
            )
        }
        CanonicalValue::BigInt(value) => Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("BigInt".into())),
            ("value".into(), Value::String(value.to_string())),
        ])),
        CanonicalValue::String(value) => Value::String(value.clone()),
        CanonicalValue::Array(values) => Value::Array(
            values
                .iter()
                .map(tagged_json_from_canonical_value)
                .collect::<Result<_, _>>()?,
        ),
        CanonicalValue::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| Ok((key.clone(), tagged_json_from_canonical_value(value)?)))
                .collect::<Result<_, TaggedJsonError>>()?,
        ),
        CanonicalValue::Map(entries) => Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("Map".into())),
            (
                "value".into(),
                Value::Array(
                    entries
                        .iter()
                        .map(|(key, value)| {
                            Ok(Value::Array(vec![
                                tagged_json_from_canonical_value(key)?,
                                tagged_json_from_canonical_value(value)?,
                            ]))
                        })
                        .collect::<Result<_, TaggedJsonError>>()?,
                ),
            ),
        ])),
        CanonicalValue::Set(values) => Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("Set".into())),
            (
                "value".into(),
                Value::Array(
                    values
                        .iter()
                        .map(tagged_json_from_canonical_value)
                        .collect::<Result<_, _>>()?,
                ),
            ),
        ])),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute_runtime_component_digest;

    #[test]
    fn tagged_bigint_and_map_hash_as_runtime_values_not_json_envelopes() {
        let value: Value = serde_json::from_str(
            r#"{"rows":{"__xlnType":"Map","value":[["b",{"__xlnType":"BigInt","value":"2"}],["a",{"__xlnType":"BigInt","value":"1"}]]}}"#,
        )
        .expect("valid fixture json");
        let canonical = canonical_value_from_tagged_json(&value).expect("canonical tagged value");
        assert_eq!(
            compute_runtime_component_digest(&canonical).expect("component digest"),
            "0x5fba87ae7a5408467f52d5ed9101e8bce47db5253e624c68cadac676208272bf",
        );
    }

    #[test]
    fn tagged_json_conversion_is_an_exact_inverse() {
        let canonical = CanonicalValue::Object(vec![
            ("big".into(), CanonicalValue::BigInt(BigInt::from(-7))),
            (
                "map".into(),
                CanonicalValue::Map(vec![(
                    CanonicalValue::String("a".into()),
                    CanonicalValue::Set(vec![CanonicalValue::Bool(true)]),
                )]),
            ),
        ]);
        let tagged = tagged_json_from_canonical_value(&canonical).expect("tagged");
        assert_eq!(
            canonical_value_from_tagged_json(&tagged).expect("canonical"),
            canonical
        );
    }
}
