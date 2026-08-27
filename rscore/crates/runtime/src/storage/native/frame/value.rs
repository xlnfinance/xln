use serde_json::{Map, Number, Value};

use super::MAX_SAFE_INTEGER;
use super::types::{Digest, RuntimeFrameCodecError};

pub(super) fn text(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

pub(super) fn number(field: &'static str, value: u64) -> Result<Value, RuntimeFrameCodecError> {
    if value > MAX_SAFE_INTEGER {
        return Err(RuntimeFrameCodecError::UnsafeNumber { field, value });
    }
    Ok(Value::Number(Number::from(value)))
}

pub(super) fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(Map::from_iter(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value)),
    ))
}

pub(super) fn format_hash(value: &Digest) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in value {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

pub(super) fn parse_hash(value: &str) -> Result<Digest, RuntimeFrameCodecError> {
    let text = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 64)
        .ok_or(RuntimeFrameCodecError::Field("postStateHash"))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| RuntimeFrameCodecError::Field("postStateHash"))?;
    }
    Ok(output)
}

pub(super) fn encode(value: &Value) -> Result<Vec<u8>, RuntimeFrameCodecError> {
    crate::transport::msgpack::encode_framed(value)
        .map_err(|error| RuntimeFrameCodecError::Encoding(error.to_string()))
}

pub(super) fn encode_frame_record(value: &Value) -> Result<Vec<u8>, RuntimeFrameCodecError> {
    crate::transport::msgpack::encode_framed_runtime_frame(value)
        .map_err(|error| RuntimeFrameCodecError::Encoding(error.to_string()))
}
