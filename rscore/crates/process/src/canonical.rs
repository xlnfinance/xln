//! Generic canonical values on the wire.
//!
//! The Entity commits parts of an account replica the engine does not execute
//! (mempool txs in their frame-hash form, hankos, acks, frame bindings). They
//! travel as a tagged encoding of the exact value model both sides hash —
//! `CanonicalValue` here, `encodeAccountStateValue`'s input over there — so
//! the engine can hash the whole leaf without a per-field Rust type for every
//! shape the authority may commit.

use num_bigint::BigInt;
use xln_rscore_abi::AbiValue;
use xln_rscore_engine::CanonicalValue;
use xln_rscore_protocol::CanonicalNumber;

use crate::ProcessError;
use crate::wire_value::{integer, text, tuple};

/// Depth bound: a hostile or corrupt payload must not recurse the decoder into
/// the stack guard. The deepest real projection is well under ten.
const MAX_DEPTH: usize = 32;

pub fn canonical_value(value: &AbiValue) -> Result<CanonicalValue, ProcessError> {
    decode(value, 0)
}

/// `[fields, mempool, rebalanceShadowPolicyRows,
/// rebalanceShadowSubmittedRows]`: one canonical envelope, including the
/// value-bearing bodies behind both committed radix roots.
pub fn envelope(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::AccountEnvelope>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = tuple(value)?;
    if fields.len() != 4 {
        return Err(ProcessError::Expected("envelope"));
    }
    let projected = match canonical_value(&fields[0])? {
        CanonicalValue::Object(entries) => entries,
        _ => return Err(ProcessError::Expected("envelopeFields")),
    };
    let mempool = tuple(&fields[1])?
        .iter()
        .map(canonical_value)
        .collect::<Result<Vec<_>, _>>()?;
    let policy = tuple(&fields[2])?
        .iter()
        .map(|row| {
            let row = tuple(row)?;
            if row.len() != 2 {
                return Err(ProcessError::Expected("rebalanceShadowPolicyRow"));
            }
            let token_id = u32::try_from(integer(&row[0])?)
                .map_err(|_| ProcessError::Expected("rebalanceShadowPolicyToken"))?;
            Ok((token_id, canonical_value(&row[1])?))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let submitted = tuple(&fields[3])?
        .iter()
        .map(|row| {
            let row = tuple(row)?;
            if row.len() != 2 {
                return Err(ProcessError::Expected("rebalanceShadowSubmittedRow"));
            }
            let token_id = u32::try_from(integer(&row[0])?)
                .map_err(|_| ProcessError::Expected("rebalanceShadowSubmittedToken"))?;
            let timestamp = u64::try_from(integer(&row[1])?)
                .map_err(|_| ProcessError::Expected("rebalanceShadowSubmittedTimestamp"))?;
            Ok((token_id, timestamp))
        })
        .collect::<Result<Vec<_>, _>>()?;
    xln_rscore_engine::AccountEnvelope::new_with_rebalance_shadow_rows(
        projected, mempool, policy, submitted,
    )
    .map(Some)
    .map_err(|error| ProcessError::Envelope(error.to_string()))
}

fn decode(value: &AbiValue, depth: usize) -> Result<CanonicalValue, ProcessError> {
    if depth > MAX_DEPTH {
        return Err(ProcessError::Expected("canonicalDepth"));
    }
    let fields = tuple(value)?;
    let tag = integer(
        fields
            .first()
            .ok_or(ProcessError::Expected("canonicalTag"))?,
    )?;
    let payload = &fields[1..];
    let one = || -> Result<&AbiValue, ProcessError> {
        payload
            .first()
            .ok_or(ProcessError::Expected("canonicalPayload"))
    };
    match tag {
        0 => Ok(CanonicalValue::Null),
        1 => Ok(CanonicalValue::Bool(integer(one()?)? != 0)),
        // Validate JavaScript's exact shortest rendering once, then retain only
        // those bytes. No binary64 value reaches committed or hashed state.
        2 => CanonicalNumber::parse_js_canonical(text(one()?)?)
            .map(CanonicalValue::Number)
            .map_err(|_| ProcessError::Expected("canonicalNumber")),
        3 => text(one()?)?
            .parse::<BigInt>()
            .map(CanonicalValue::BigInt)
            .map_err(|_| ProcessError::Expected("canonicalBigInt")),
        4 => Ok(CanonicalValue::String(text(one()?)?.into())),
        5 => Ok(CanonicalValue::Array(list(one()?, depth)?)),
        6 => {
            let mut entries = Vec::new();
            for pair in tuple(one()?)? {
                let pair = tuple(pair)?;
                if pair.len() != 2 {
                    return Err(ProcessError::Expected("canonicalMapEntry"));
                }
                entries.push((decode(&pair[0], depth + 1)?, decode(&pair[1], depth + 1)?));
            }
            Ok(CanonicalValue::Map(entries))
        }
        7 => Ok(CanonicalValue::Set(list(one()?, depth)?)),
        8 => {
            let mut entries = Vec::new();
            for pair in tuple(one()?)? {
                let pair = tuple(pair)?;
                if pair.len() != 2 {
                    return Err(ProcessError::Expected("canonicalObjectEntry"));
                }
                entries.push((text(&pair[0])?.into(), decode(&pair[1], depth + 1)?));
            }
            Ok(CanonicalValue::Object(entries))
        }
        _ => Err(ProcessError::Expected("canonicalTag")),
    }
}

fn list(value: &AbiValue, depth: usize) -> Result<Vec<CanonicalValue>, ProcessError> {
    tuple(value)?
        .iter()
        .map(|entry| decode(entry, depth + 1))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire_number(value: &str) -> AbiValue {
        AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(vec![
            AbiValue::Integer(2),
            AbiValue::Text(value.to_string()),
        ]))
    }

    #[test]
    fn wire_number_retains_only_exact_javascript_text() {
        for value in ["0", "42", "-3.5", "1e+21", "0.000001", "1e-7"] {
            let decoded = canonical_value(&wire_number(value)).expect("canonical number");
            let CanonicalValue::Number(number) = decoded else {
                panic!("number variant");
            };
            assert_eq!(number.as_str(), value);
        }

        for value in ["-0", "NaN", "Infinity", "01", "+1", "1.0"] {
            assert!(canonical_value(&wire_number(value)).is_err(), "{value}");
        }
    }
}
