use std::collections::BTreeSet;

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::decode_storage_payload;

use super::types::{
    Digest, RuntimeFrameCodecError, RuntimeMachineGraphRoot, ValidatedRuntimeFrame,
};
use super::value::{encode, encode_frame_record};
use super::{FRAME_DOMAIN, MAX_SAFE_INTEGER};

const REQUIRED_FIELDS: [&str; 13] = [
    "height",
    "timestamp",
    "prevFrameHash",
    "frameHash",
    "replicaMetaDigest",
    "postStateHash",
    "materializedState",
    "runtimeInput",
    "runtimeOutputCount",
    "runtimeOutputsDigest",
    "touchedEntities",
    "touchedAccounts",
    "touchedBookEntities",
];

const OPTIONAL_FIELDS: [&str; 6] = [
    "canonicalStateHash",
    "canonicalEntityHashes",
    "runtimeStateHash",
    "runtimeMachineRoot",
    "accountAuthorityCheckpoints",
    "entityContextRefs",
];

fn object<'a>(
    value: &'a Value,
    field: &'static str,
) -> Result<&'a Map<String, Value>, RuntimeFrameCodecError> {
    value
        .as_object()
        .ok_or(RuntimeFrameCodecError::Field(field))
}

fn field<'a>(
    object: &'a Map<String, Value>,
    name: &'static str,
) -> Result<&'a Value, RuntimeFrameCodecError> {
    object.get(name).ok_or(RuntimeFrameCodecError::Field(name))
}

fn unsigned(
    object: &Map<String, Value>,
    name: &'static str,
) -> Result<u64, RuntimeFrameCodecError> {
    field(object, name)?
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(RuntimeFrameCodecError::Field(name))
}

fn digest(value: &Value, field: &'static str) -> Result<Digest, RuntimeFrameCodecError> {
    let text = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or(RuntimeFrameCodecError::Field(field))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| RuntimeFrameCodecError::Field(field))?;
    }
    Ok(output)
}

fn digest_field(
    object: &Map<String, Value>,
    name: &'static str,
) -> Result<Digest, RuntimeFrameCodecError> {
    digest(field(object, name)?, name)
}

fn validate_fields(frame: &Map<String, Value>) -> Result<(), RuntimeFrameCodecError> {
    let allowed = REQUIRED_FIELDS
        .iter()
        .chain(OPTIONAL_FIELDS.iter())
        .copied()
        .collect::<BTreeSet<_>>();
    if REQUIRED_FIELDS
        .iter()
        .any(|field| !frame.contains_key(*field))
        || frame.keys().any(|field| !allowed.contains(field.as_str()))
    {
        return Err(RuntimeFrameCodecError::Fields);
    }
    Ok(())
}

fn validate_runtime_input(
    value: &Value,
    field: &'static str,
) -> Result<(), RuntimeFrameCodecError> {
    let input = object(value, field)?;
    let required = ["runtimeTxs", "entityInputs"];
    let allowed = [
        "runtimeTxs",
        "entityInputs",
        "jInputs",
        "timestamp",
        "queuedAt",
    ];
    if required.iter().any(|key| !input.contains_key(*key))
        || input.keys().any(|key| !allowed.contains(&key.as_str()))
        || !input["runtimeTxs"].is_array()
        || !input["entityInputs"].is_array()
    {
        return Err(RuntimeFrameCodecError::RuntimeInputObject(field));
    }
    Ok(())
}

fn validate_canonical_roots(frame: &Map<String, Value>) -> Result<(), RuntimeFrameCodecError> {
    let fields = [
        "canonicalStateHash",
        "canonicalEntityHashes",
        "runtimeStateHash",
    ];
    let present = fields.map(|field| frame.contains_key(field));
    if present.iter().any(|value| *value) && present.iter().any(|value| !*value) {
        return Err(RuntimeFrameCodecError::MaterializedRootsRequired);
    }
    if frame.get("materializedState").and_then(Value::as_bool) == Some(true) && !present[0] {
        return Err(RuntimeFrameCodecError::MaterializedRootsRequired);
    }
    if (present[0] || frame.get("materializedState").and_then(Value::as_bool) == Some(true))
        && !frame.contains_key("runtimeMachineRoot")
    {
        return Err(RuntimeFrameCodecError::MachineRootRequired);
    }
    for field in ["canonicalStateHash", "runtimeStateHash"] {
        if let Some(value) = frame.get(field) {
            digest(value, field)?;
        }
    }
    Ok(())
}

fn runtime_machine_root(
    frame: &Map<String, Value>,
) -> Result<Option<RuntimeMachineGraphRoot>, RuntimeFrameCodecError> {
    let Some(value) = frame.get("runtimeMachineRoot") else {
        return Ok(None);
    };
    let value = object(value, "runtimeMachineRoot")?;
    if value.len() != 2 || !value.contains_key("rootHash") || !value.contains_key("leafCount") {
        return Err(RuntimeFrameCodecError::Field("runtimeMachineRoot"));
    }
    Ok(Some(RuntimeMachineGraphRoot {
        root_hash: digest_field(value, "rootHash")?,
        leaf_count: unsigned(value, "leafCount")?,
    }))
}

fn normalized_entity_hashes(frame: &mut Map<String, Value>) -> Result<(), RuntimeFrameCodecError> {
    let Some(Value::Array(rows)) = frame.get_mut("canonicalEntityHashes") else {
        return Ok(());
    };
    for row in rows.iter_mut() {
        let row = row
            .as_object_mut()
            .ok_or(RuntimeFrameCodecError::Field("canonicalEntityHashes"))?;
        let entity_id = row
            .get("entityId")
            .and_then(Value::as_str)
            .ok_or(RuntimeFrameCodecError::Field(
                "canonicalEntityHashes.entityId",
            ))?
            .to_lowercase();
        row.insert("entityId".into(), Value::String(entity_id));
    }
    rows.sort_by(|left, right| {
        left["entityId"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["entityId"].as_str().unwrap_or_default())
    });
    Ok(())
}

fn recompute_frame_hash(frame: &Map<String, Value>) -> Result<Digest, RuntimeFrameCodecError> {
    let mut base = frame.clone();
    base.remove("frameHash");
    normalized_entity_hashes(&mut base)?;
    base.insert("kind".into(), Value::String(FRAME_DOMAIN.into()));
    base.entry("canonicalEntityHashes")
        .or_insert_with(|| Value::Array(vec![]));
    Ok(Sha256::digest(encode(&Value::Object(base))?).into())
}

fn validate_exact_bytes(bytes: &[u8], value: &Value) -> Result<(), RuntimeFrameCodecError> {
    let canonical = encode_frame_record(value)?;
    if canonical != bytes {
        let offset = bytes
            .iter()
            .zip(canonical.iter())
            .position(|(stored, encoded)| stored != encoded)
            .unwrap_or_else(|| bytes.len().min(canonical.len()));
        return Err(RuntimeFrameCodecError::NonCanonicalBytes {
            offset,
            stored: bytes
                .get(offset)
                .map_or_else(|| "eof".into(), |value| format!("0x{value:02x}")),
            canonical: canonical
                .get(offset)
                .map_or_else(|| "eof".into(), |value| format!("0x{value:02x}")),
            stored_len: bytes.len(),
            canonical_len: canonical.len(),
            stored_window: byte_window(bytes, offset),
            canonical_window: byte_window(&canonical, offset),
        });
    }
    Ok(())
}

fn byte_window(bytes: &[u8], offset: usize) -> String {
    let start = offset.saturating_sub(16);
    let end = bytes.len().min(offset.saturating_add(48));
    bytes[start..end]
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect::<String>()
}

pub fn validate_runtime_frame(
    bytes: &[u8],
) -> Result<ValidatedRuntimeFrame, RuntimeFrameCodecError> {
    let value = decode_storage_payload(bytes)?;
    let frame = object(&value, "object")?;
    validate_fields(frame)?;
    let height = unsigned(frame, "height")?;
    if height == 0 {
        return Err(RuntimeFrameCodecError::Field("height"));
    }
    let timestamp = unsigned(frame, "timestamp")?;
    let prev_frame_hash = digest_field(frame, "prevFrameHash")?;
    let frame_hash = digest_field(frame, "frameHash")?;
    digest_field(frame, "replicaMetaDigest")?;
    digest_field(frame, "postStateHash")?;
    let materialized_state = field(frame, "materializedState")?
        .as_bool()
        .ok_or(RuntimeFrameCodecError::Field("materializedState"))?;
    validate_runtime_input(field(frame, "runtimeInput")?, "runtimeInput")?;
    validate_canonical_roots(frame)?;
    let canonical_state_hash = frame
        .get("canonicalStateHash")
        .map(|value| digest(value, "canonicalStateHash"))
        .transpose()?;
    let runtime_machine_root = runtime_machine_root(frame)?;
    let output_count = usize::try_from(unsigned(frame, "runtimeOutputCount")?)
        .map_err(|_| RuntimeFrameCodecError::Field("runtimeOutputCount"))?;
    let output_digest = digest_field(frame, "runtimeOutputsDigest")?;
    if recompute_frame_hash(frame)? != frame_hash {
        return Err(RuntimeFrameCodecError::FrameHash);
    }
    validate_exact_bytes(bytes, &value)?;
    Ok(ValidatedRuntimeFrame {
        height,
        timestamp,
        prev_frame_hash,
        frame_hash,
        materialized_state,
        output_count,
        output_digest,
        canonical_state_hash,
        runtime_machine_root,
    })
}
