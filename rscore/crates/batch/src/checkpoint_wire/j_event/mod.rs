mod decode;
mod encode;

use thiserror::Error;
use xln_rscore_abi::{AbiValue, BodyTuple};

pub use decode::decode_jurisdiction_event;
pub use encode::encode_jurisdiction_event;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum JEventWireError {
    #[error("RSCORE_J_EVENT_WIRE_{0}")]
    Invalid(String),
}

fn invalid(code: impl Into<String>) -> JEventWireError {
    JEventWireError::Invalid(code.into())
}

fn tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(fields))
}

fn integer(value: impl Into<i128>) -> AbiValue {
    AbiValue::Integer(value.into())
}
