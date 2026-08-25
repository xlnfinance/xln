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

use crate::ProcessError;
use crate::wire_value::{integer, text, tuple};

/// Depth bound: a hostile or corrupt payload must not recurse the decoder into
/// the stack guard. The deepest real projection is well under ten.
const MAX_DEPTH: usize = 32;

pub fn canonical_value(value: &AbiValue) -> Result<CanonicalValue, ProcessError> {
    decode(value, 0)
}

pub fn encode_envelope(value: &xln_rscore_engine::AccountEnvelope) -> AbiValue {
    let fields = CanonicalValue::Object(value.fields().to_vec());
    AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(vec![
        encode(&fields),
        AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(
            value.mempool().iter().map(encode).collect(),
        )),
    ]))
}

fn encode(value: &CanonicalValue) -> AbiValue {
    let tuple = |fields| AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(fields));
    match value {
        CanonicalValue::Null => tuple(vec![AbiValue::Integer(0)]),
        CanonicalValue::Bool(flag) => tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Integer(i128::from(*flag)),
        ]),
        CanonicalValue::Number(number) => {
            let mut buffer = ryu_js::Buffer::new();
            tuple(vec![
                AbiValue::Integer(2),
                AbiValue::Text(buffer.format(*number).to_owned()),
            ])
        }
        CanonicalValue::BigInt(number) => tuple(vec![
            AbiValue::Integer(3),
            AbiValue::Text(number.to_string()),
        ]),
        CanonicalValue::String(text) => {
            tuple(vec![AbiValue::Integer(4), AbiValue::Text(text.clone())])
        }
        CanonicalValue::Array(values) => tuple(vec![
            AbiValue::Integer(5),
            tuple(values.iter().map(encode).collect()),
        ]),
        CanonicalValue::Map(entries) => tuple(vec![
            AbiValue::Integer(6),
            tuple(
                entries
                    .iter()
                    .map(|(key, value)| tuple(vec![encode(key), encode(value)]))
                    .collect(),
            ),
        ]),
        CanonicalValue::Set(values) => tuple(vec![
            AbiValue::Integer(7),
            tuple(values.iter().map(encode).collect()),
        ]),
        CanonicalValue::Object(entries) => tuple(vec![
            AbiValue::Integer(8),
            tuple(
                entries
                    .iter()
                    .map(|(key, value)| tuple(vec![AbiValue::Text(key.clone()), encode(value)]))
                    .collect(),
            ),
        ]),
    }
}

/// `[fields, mempool]`: the account-leaf projection minus the derived roots,
/// and the canonical frame-hash form of every queued tx.
pub fn envelope(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::AccountEnvelope>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = tuple(value)?;
    if fields.len() != 2 {
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
    xln_rscore_engine::AccountEnvelope::new(projected, mempool)
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
        // Numbers travel as the string JavaScript renders, and are parsed back
        // to the same double: the shortest representation round-trips exactly,
        // so re-rendering it on this side reproduces the authority's bytes.
        2 => text(one()?)?
            .parse::<f64>()
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

fn wire_tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(fields))
}

/// The same nine-variant model back on the wire, so a runtime can read the
/// projection the engine committed and name the field that disagrees instead
/// of comparing two opaque leaves.
pub fn canonical_wire(value: &CanonicalValue) -> AbiValue {
    match value {
        CanonicalValue::Null => wire_tuple(vec![AbiValue::Integer(0)]),
        CanonicalValue::Bool(flag) => wire_tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Integer(i128::from(*flag)),
        ]),
        CanonicalValue::Number(number) => wire_tuple(vec![
            AbiValue::Integer(2),
            AbiValue::Text({
                let mut buffer = ryu_js::Buffer::new();
                buffer.format(*number).to_string()
            }),
        ]),
        CanonicalValue::BigInt(value) => wire_tuple(vec![
            AbiValue::Integer(3),
            AbiValue::Text(value.to_string()),
        ]),
        CanonicalValue::String(text) => {
            wire_tuple(vec![AbiValue::Integer(4), AbiValue::Text(text.clone())])
        }
        CanonicalValue::Array(items) => wire_tuple(vec![
            AbiValue::Integer(5),
            wire_tuple(items.iter().map(canonical_wire).collect()),
        ]),
        CanonicalValue::Map(entries) => wire_tuple(vec![
            AbiValue::Integer(6),
            wire_tuple(
                entries
                    .iter()
                    .map(|(key, value)| {
                        wire_tuple(vec![canonical_wire(key), canonical_wire(value)])
                    })
                    .collect(),
            ),
        ]),
        CanonicalValue::Set(items) => wire_tuple(vec![
            AbiValue::Integer(7),
            wire_tuple(items.iter().map(canonical_wire).collect()),
        ]),
        CanonicalValue::Object(entries) => wire_tuple(vec![
            AbiValue::Integer(8),
            wire_tuple(
                entries
                    .iter()
                    .map(|(key, value)| {
                        wire_tuple(vec![AbiValue::Text(key.clone()), canonical_wire(value)])
                    })
                    .collect(),
            ),
        ]),
    }
}
