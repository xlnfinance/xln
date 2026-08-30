//! Exact canonical Account-envelope decoder used by checkpoint restore.

use num_bigint::BigInt;
use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{AccountEnvelope, CanonicalValue};
use xln_rscore_protocol::CanonicalNumber;

use super::account_value::{AccountWireRestoreError, exact, integer, invalid, text, tuple};

const MAX_DEPTH: usize = 32;

fn list(value: &AbiValue, depth: usize) -> Result<Vec<CanonicalValue>, AccountWireRestoreError> {
    tuple(value)?
        .iter()
        .map(|entry| decode(entry, depth.saturating_add(1)))
        .collect()
}

fn decode(value: &AbiValue, depth: usize) -> Result<CanonicalValue, AccountWireRestoreError> {
    if depth > MAX_DEPTH {
        return Err(invalid("CANONICAL_DEPTH"));
    }
    let fields = tuple(value)?;
    let tag = integer(fields.first().ok_or_else(|| invalid("CANONICAL_TAG"))?)?;
    let payload = &fields[1..];
    let one = || payload.first().ok_or_else(|| invalid("CANONICAL_PAYLOAD"));
    match tag {
        0 => {
            exact(payload, 0, "canonicalNull")?;
            Ok(CanonicalValue::Null)
        }
        1 => {
            exact(payload, 1, "canonicalBool")?;
            match integer(one()?)? {
                0 => Ok(CanonicalValue::Bool(false)),
                1 => Ok(CanonicalValue::Bool(true)),
                value => Err(invalid(format!("CANONICAL_BOOL:{value}"))),
            }
        }
        2 => {
            exact(payload, 1, "canonicalNumber")?;
            CanonicalNumber::parse_js_canonical(text(one()?)?)
                .map(CanonicalValue::Number)
                .map_err(|_| invalid("CANONICAL_NUMBER"))
        }
        3 => {
            exact(payload, 1, "canonicalBigInt")?;
            text(one()?)?
                .parse::<BigInt>()
                .map(CanonicalValue::BigInt)
                .map_err(|_| invalid("CANONICAL_BIGINT"))
        }
        4 => {
            exact(payload, 1, "canonicalString")?;
            Ok(CanonicalValue::String(text(one()?)?.to_owned()))
        }
        5 => {
            exact(payload, 1, "canonicalArray")?;
            Ok(CanonicalValue::Array(list(one()?, depth)?))
        }
        6 => {
            exact(payload, 1, "canonicalMap")?;
            let mut entries = Vec::new();
            for pair in tuple(one()?)? {
                let pair = exact(tuple(pair)?, 2, "canonicalMapEntry")?;
                entries.push((
                    decode(&pair[0], depth.saturating_add(1))?,
                    decode(&pair[1], depth.saturating_add(1))?,
                ));
            }
            Ok(CanonicalValue::Map(entries))
        }
        7 => {
            exact(payload, 1, "canonicalSet")?;
            Ok(CanonicalValue::Set(list(one()?, depth)?))
        }
        8 => {
            exact(payload, 1, "canonicalObject")?;
            let mut entries = Vec::new();
            for pair in tuple(one()?)? {
                let pair = exact(tuple(pair)?, 2, "canonicalObjectEntry")?;
                entries.push((
                    text(&pair[0])?.to_owned(),
                    decode(&pair[1], depth.saturating_add(1))?,
                ));
            }
            Ok(CanonicalValue::Object(entries))
        }
        value => Err(invalid(format!("CANONICAL_TAG:{value}"))),
    }
}

pub(crate) fn value(value: &AbiValue) -> Result<CanonicalValue, AccountWireRestoreError> {
    decode(value, 0)
}

pub fn envelope(value: &AbiValue) -> Result<AccountEnvelope, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 4, "envelope")?;
    let projected = match decode(&fields[0], 0)? {
        CanonicalValue::Object(entries) => entries,
        _ => return Err(invalid("ENVELOPE_FIELDS")),
    };
    let mempool = tuple(&fields[1])?
        .iter()
        .map(|value| decode(value, 0))
        .collect::<Result<Vec<_>, _>>()?;
    let policy = tuple(&fields[2])?
        .iter()
        .map(|row| {
            let row = exact(tuple(row)?, 2, "rebalanceShadowPolicyRow")?;
            let token_id = u32::try_from(integer(&row[0])?)
                .map_err(|_| invalid("REBALANCE_SHADOW_POLICY_TOKEN"))?;
            Ok((token_id, decode(&row[1], 0)?))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let submitted = tuple(&fields[3])?
        .iter()
        .map(|row| {
            let row = exact(tuple(row)?, 2, "rebalanceShadowSubmittedRow")?;
            let token_id = u32::try_from(integer(&row[0])?)
                .map_err(|_| invalid("REBALANCE_SHADOW_SUBMITTED_TOKEN"))?;
            let timestamp = u64::try_from(integer(&row[1])?)
                .map_err(|_| invalid("REBALANCE_SHADOW_SUBMITTED_TIMESTAMP"))?;
            Ok((token_id, timestamp))
        })
        .collect::<Result<Vec<_>, _>>()?;
    AccountEnvelope::new_with_rebalance_shadow_rows(projected, mempool, policy, submitted)
        .map_err(|error| invalid(format!("ENVELOPE:{error}")))
}
