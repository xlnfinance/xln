use crate::BodyTuple;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AbiValue {
    Nil,
    Bool(bool),
    Integer(i128),
    Bytes(Vec<u8>),
    Text(String),
    Tuple(BodyTuple),
}
