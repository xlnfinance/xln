use crate::{AbiError, AbiValue};

pub const ABI_MAGIC: u8 = 0x03;
pub const ABI_DOMAIN: &str = "xln.rscore.account";
pub const ABI_VERSION: u16 = 1;

const DEFAULT_MAX_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES: usize = 15 * 1024 * 1024;
const DEFAULT_MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES: usize = 4 * 1024;
const DEFAULT_MAX_TUPLE_FIELDS: usize = u16::MAX as usize;
const DEFAULT_MAX_TOTAL_VALUES: usize = 1_000_000;
const DEFAULT_MAX_NESTING_DEPTH: usize = 32;
const HARD_MAX_ENVELOPE_BYTES: usize = 64 * 1024 * 1024;
const HARD_MAX_BODY_BYTES: usize = 63 * 1024 * 1024;
const HARD_MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;
const HARD_MAX_TEXT_BYTES: usize = 64 * 1024;
const HARD_MAX_TOTAL_VALUES: usize = 1_000_000;
const HARD_MAX_NESTING_DEPTH: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AbiLimits {
    pub max_envelope_bytes: usize,
    pub max_body_bytes: usize,
    pub max_blob_bytes: usize,
    pub max_text_bytes: usize,
    pub max_tuple_fields: usize,
    pub max_total_values: usize,
    pub max_nesting_depth: usize,
}

impl Default for AbiLimits {
    fn default() -> Self {
        Self {
            max_envelope_bytes: DEFAULT_MAX_ENVELOPE_BYTES,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
            max_text_bytes: DEFAULT_MAX_TEXT_BYTES,
            max_tuple_fields: DEFAULT_MAX_TUPLE_FIELDS,
            max_total_values: DEFAULT_MAX_TOTAL_VALUES,
            max_nesting_depth: DEFAULT_MAX_NESTING_DEPTH,
        }
    }
}

impl AbiLimits {
    pub(crate) fn validate(&self) -> Result<(), AbiError> {
        let checks = [
            (
                self.max_envelope_bytes <= HARD_MAX_ENVELOPE_BYTES,
                "maxEnvelopeBytes",
            ),
            (self.max_body_bytes <= HARD_MAX_BODY_BYTES, "maxBodyBytes"),
            (self.max_blob_bytes <= HARD_MAX_BLOB_BYTES, "maxBlobBytes"),
            (self.max_text_bytes <= HARD_MAX_TEXT_BYTES, "maxTextBytes"),
            (
                self.max_tuple_fields <= usize::from(u16::MAX),
                "maxTupleFields",
            ),
            (
                self.max_total_values <= HARD_MAX_TOTAL_VALUES,
                "maxTotalValues",
            ),
            (
                self.max_nesting_depth <= HARD_MAX_NESTING_DEPTH,
                "maxNestingDepth",
            ),
        ];
        for (valid, field) in checks {
            if !valid {
                return Err(AbiError::InvalidLimits(field));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum OpTag {
    Hello = 0,
    RestoreCheckpoint = 1,
    BeginRuntime = 2,
    BeginEntity = 3,
    ReadCapacityBatch = 4,
    ExecuteWave = 5,
    PrepareEntity = 6,
    FinalizeEntity = 7,
    DiscardEntity = 8,
    PrepareRuntime = 9,
    CommitRuntime = 10,
    AbortRuntime = 11,
    ReadAccountSummaryPage = 12,
}

impl TryFrom<u64> for OpTag {
    type Error = AbiError;

    fn try_from(value: u64) -> Result<Self, AbiError> {
        match value {
            0 => Ok(Self::Hello),
            1 => Ok(Self::RestoreCheckpoint),
            2 => Ok(Self::BeginRuntime),
            3 => Ok(Self::BeginEntity),
            4 => Ok(Self::ReadCapacityBatch),
            5 => Ok(Self::ExecuteWave),
            6 => Ok(Self::PrepareEntity),
            7 => Ok(Self::FinalizeEntity),
            8 => Ok(Self::DiscardEntity),
            9 => Ok(Self::PrepareRuntime),
            10 => Ok(Self::CommitRuntime),
            11 => Ok(Self::AbortRuntime),
            12 => Ok(Self::ReadAccountSummaryPage),
            _ => Err(AbiError::UnknownOpTag(value)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageKind {
    Request = 0,
    Ok = 1,
    Error = 2,
}

impl TryFrom<u64> for MessageKind {
    type Error = AbiError;

    fn try_from(value: u64) -> Result<Self, AbiError> {
        match value {
            0 => Ok(Self::Request),
            1 => Ok(Self::Ok),
            2 => Ok(Self::Error),
            _ => Err(AbiError::UnknownMessageKind(value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolBinding {
    pub protocol_version: u32,
    pub storage_schema_version: u32,
    pub protocol_fingerprint: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineIdentity {
    pub engine_generation: [u8; 8],
    pub runtime_id: [u8; 20],
    pub session_id: [u8; 16],
    pub request_id: [u8; 8],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodyTuple(Vec<AbiValue>);

impl BodyTuple {
    pub fn from_array<const N: usize>(fields: [AbiValue; N]) -> Self {
        Self(Vec::from(fields))
    }

    pub fn from_vec(fields: Vec<AbiValue>) -> Self {
        Self(fields)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn fields(&self) -> &[AbiValue] {
        &self.0
    }

    pub fn into_fields(self) -> Vec<AbiValue> {
        self.0
    }

    pub(crate) fn decoded(fields: Vec<AbiValue>) -> Self {
        Self::from_vec(fields)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub binding: ProtocolBinding,
    pub identity: EngineIdentity,
    pub op_tag: OpTag,
    pub message_kind: MessageKind,
    pub body: BodyTuple,
}
