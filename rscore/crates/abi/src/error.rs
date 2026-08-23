use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AbiError {
    #[error("RSCORE_ABI_INVALID_LIMITS:{0}")]
    InvalidLimits(&'static str),
    #[error("RSCORE_ABI_ENVELOPE_TOO_LARGE:{actual}:{max}")]
    EnvelopeTooLarge { actual: usize, max: usize },
    #[error("RSCORE_ABI_INVALID_MAGIC:{0:#04x}")]
    InvalidMagic(u8),
    #[error("RSCORE_ABI_UNEXPECTED_EOF")]
    UnexpectedEof,
    #[error("RSCORE_ABI_UNSUPPORTED_MARKER:{0:#04x}")]
    UnsupportedMarker(u8),
    #[error("RSCORE_ABI_EXPECTED_{expected}:{actual:#04x}")]
    UnexpectedMarker { expected: &'static str, actual: u8 },
    #[error("RSCORE_ABI_INVALID_UTF8")]
    InvalidUtf8,
    #[error("RSCORE_ABI_TEXT_TOO_LARGE:{actual}:{max}")]
    TextTooLarge { actual: usize, max: usize },
    #[error("RSCORE_ABI_BLOB_TOO_LARGE:{actual}:{max}")]
    BlobTooLarge { actual: usize, max: usize },
    #[error("RSCORE_ABI_TUPLE_TOO_LARGE:{actual}:{max}")]
    TupleTooLarge { actual: usize, max: usize },
    #[error("RSCORE_ABI_VALUE_LIMIT:{actual}:{max}")]
    ValueLimit { actual: usize, max: usize },
    #[error("RSCORE_ABI_NESTING_TOO_DEEP:{actual}:{max}")]
    NestingTooDeep { actual: usize, max: usize },
    #[error("RSCORE_ABI_OUTER_ARITY:{actual}:14")]
    OuterArity { actual: usize },
    #[error("RSCORE_ABI_BODY_ARITY:{actual}:{expected}")]
    BodyArity { actual: usize, expected: usize },
    #[error("RSCORE_ABI_DOMAIN")]
    Domain,
    #[error("RSCORE_ABI_VERSION:{0}")]
    AbiVersion(u64),
    #[error("RSCORE_ABI_INTEGER_RANGE:{field}:{value}")]
    IntegerRange { field: &'static str, value: u64 },
    #[error("RSCORE_ABI_BODY_INTEGER_RANGE:{0}")]
    BodyIntegerRange(i128),
    #[error("RSCORE_ABI_FIXED_BYTES:{field}:{actual}:{expected}")]
    FixedBytes {
        field: &'static str,
        actual: usize,
        expected: usize,
    },
    #[error("RSCORE_ABI_UNKNOWN_OP_TAG:{0}")]
    UnknownOpTag(u64),
    #[error("RSCORE_ABI_UNKNOWN_MESSAGE_KIND:{0}")]
    UnknownMessageKind(u64),
    #[error("RSCORE_ABI_BODY_LENGTH:{actual}:{declared}")]
    BodyLength { actual: usize, declared: u64 },
    #[error("RSCORE_ABI_BODY_DIGEST")]
    BodyDigest,
    #[error("RSCORE_ABI_TRAILING_BYTES:{0}")]
    TrailingBytes(usize),
    #[error("RSCORE_ABI_NON_CANONICAL")]
    NonCanonical,
    #[error("RSCORE_ABI_LENGTH_OVERFLOW")]
    LengthOverflow,
}
