//! Strict loader for the canonical LevelDB Runtime WAL tail.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use thiserror::Error;

use crate::{RuntimeLevelDbError, RuntimeWalReader};

use super::{ExactRuntimeWalFrame, RestoreCommitments, RestoreDigest};

const MAX_WAL_TAIL_FRAMES: u64 = 1_000_000;

#[derive(Clone, Debug)]
pub struct LevelDbRuntimeInput {
    /// Full validated frame record. The native Runtime decoder consumes its
    /// `runtimeInput`; keeping the envelope lets it also verify the frame hash
    /// chain and pending FIFO without a second LevelDB read.
    pub frame: Value,
    /// Exact immutable Entity contexts referenced by this frame.
    pub entity_contexts: BTreeMap<String, Value>,
    /// Exact flat outbox rows. The reader verifies their count and byte digest
    /// before this structure can be constructed.
    pub persisted_outputs: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeRestoreHeights {
    pub checkpoint_height: u64,
    pub latest_height: u64,
}

#[derive(Debug, Error)]
pub enum RestoreSourceError {
    #[error(transparent)]
    LevelDb(#[from] RuntimeLevelDbError),
    #[error("RRS_RESTORE_SOURCE_OBJECT:{0}")]
    Object(&'static str),
    #[error("RRS_RESTORE_SOURCE_FIELD:{0}")]
    Field(&'static str),
    #[error("RRS_RESTORE_SOURCE_U64:{0}")]
    Unsigned(&'static str),
    #[error("RRS_RESTORE_SOURCE_DIGEST:{0}")]
    Digest(&'static str),
    #[error("RRS_RESTORE_SOURCE_HEAD_ORDER:checkpoint={checkpoint}:latest={latest}")]
    HeadOrder { checkpoint: u64, latest: u64 },
    #[error("RRS_RESTORE_SOURCE_TAIL_MAX:{0}")]
    TailMaximum(u64),
    #[error("RRS_RESTORE_SOURCE_CONTEXT_MAP")]
    ContextMap,
    #[error("RRS_RESTORE_SOURCE_CONTEXT_ROW:{0}")]
    ContextRow(usize),
    #[error("RRS_RESTORE_SOURCE_OUTPUT_COUNT:{0}")]
    OutputCount(u64),
}

fn object<'a>(
    value: &'a Value,
    path: &'static str,
) -> Result<&'a Map<String, Value>, RestoreSourceError> {
    value.as_object().ok_or(RestoreSourceError::Object(path))
}

fn field<'a>(value: &'a Value, name: &'static str) -> Result<&'a Value, RestoreSourceError> {
    object(value, "frame")?
        .get(name)
        .ok_or(RestoreSourceError::Field(name))
}

fn unsigned(value: &Value, name: &'static str) -> Result<u64, RestoreSourceError> {
    value.as_u64().ok_or(RestoreSourceError::Unsigned(name))
}

fn digest(value: &Value, name: &'static str) -> Result<RestoreDigest, RestoreSourceError> {
    let payload = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or(RestoreSourceError::Digest(name))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| RestoreSourceError::Digest(name))?;
    }
    Ok(output)
}

fn optional_digest(
    frame: &Value,
    name: &'static str,
) -> Result<Option<RestoreDigest>, RestoreSourceError> {
    object(frame, "frame")?
        .get(name)
        .map(|value| digest(value, name))
        .transpose()
}

fn runtime_machine_root(frame: &Value) -> Result<Option<RestoreDigest>, RestoreSourceError> {
    let Some(root) = object(frame, "frame")?.get("runtimeMachineRoot") else {
        return Ok(None);
    };
    let root = object(root, "runtimeMachineRoot")?;
    let value = root
        .get("rootHash")
        .ok_or(RestoreSourceError::Field("runtimeMachineRoot.rootHash"))?;
    digest(value, "runtimeMachineRoot.rootHash").map(Some)
}

fn frame_commitments(frame: &Value) -> Result<RestoreCommitments, RestoreSourceError> {
    Ok(RestoreCommitments {
        runtime_machine_root: runtime_machine_root(frame)?,
        canonical_state_hash: optional_digest(frame, "canonicalStateHash")?,
        post_state_hash: Some(digest(field(frame, "postStateHash")?, "postStateHash")?),
        entity_state_root: None,
        accounts_root: None,
        paybook_root: None,
        orderbook_root: None,
        output_count: Some(unsigned(
            field(frame, "runtimeOutputCount")?,
            "runtimeOutputCount",
        )?),
        outputs_digest: Some(digest(
            field(frame, "runtimeOutputsDigest")?,
            "runtimeOutputsDigest",
        )?),
        // Current WAL has no standalone event commitment. Native Runtime
        // frames must populate this once their exact event envelope is stored.
        event_count: None,
        events_digest: None,
    })
}

fn context_rows(frame: &Value) -> Result<Vec<(String, RestoreDigest)>, RestoreSourceError> {
    let Some(refs) = object(frame, "frame")?.get("entityContextRefs") else {
        return Ok(Vec::new());
    };
    let refs = object(refs, "entityContextRefs")?;
    if refs.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(RestoreSourceError::ContextMap);
    }
    let rows = refs
        .get("value")
        .and_then(Value::as_array)
        .ok_or(RestoreSourceError::ContextMap)?;
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let row = row
                .as_array()
                .filter(|row| row.len() == 2)
                .ok_or(RestoreSourceError::ContextRow(index))?;
            let key = row[0]
                .as_str()
                .map(str::to_owned)
                .ok_or(RestoreSourceError::ContextRow(index))?;
            let commitment = digest(&row[1], "entityContextRefs.digest")?;
            Ok((key, commitment))
        })
        .collect()
}

fn load_contexts(
    reader: &mut RuntimeWalReader,
    frame: &Value,
) -> Result<BTreeMap<String, Value>, RestoreSourceError> {
    let runtime_height = unsigned(field(frame, "height")?, "height")?;
    let mut contexts = BTreeMap::new();
    for (key, commitment) in context_rows(frame)? {
        let value = reader.entity_context_full(runtime_height, &key, &commitment)?;
        if contexts.insert(key, value).is_some() {
            return Err(RestoreSourceError::ContextMap);
        }
    }
    Ok(contexts)
}

pub fn read_runtime_restore_heights(
    reader: &mut RuntimeWalReader,
) -> Result<RuntimeRestoreHeights, RestoreSourceError> {
    let head = reader.head()?;
    let checkpoint_height = unsigned(
        object(&head, "head")?
            .get("latestMaterializedHeight")
            .ok_or(RestoreSourceError::Field("latestMaterializedHeight"))?,
        "latestMaterializedHeight",
    )?;
    let latest_height = unsigned(
        object(&head, "head")?
            .get("latestHeight")
            .ok_or(RestoreSourceError::Field("latestHeight"))?,
        "latestHeight",
    )?;
    if checkpoint_height == 0 || checkpoint_height > latest_height {
        return Err(RestoreSourceError::HeadOrder {
            checkpoint: checkpoint_height,
            latest: latest_height,
        });
    }
    Ok(RuntimeRestoreHeights {
        checkpoint_height,
        latest_height,
    })
}

/// Load and authenticate the complete WAL tail after one already-restored
/// checkpoint. A missing frame, bounded-value chunk, context, or outbox row is
/// a typed failure; partial tails are never returned.
pub fn load_exact_leveldb_wal_tail(
    reader: &mut RuntimeWalReader,
    after_height: u64,
    through_height: u64,
) -> Result<Vec<ExactRuntimeWalFrame<LevelDbRuntimeInput>>, RestoreSourceError> {
    if through_height < after_height {
        return Err(RestoreSourceError::HeadOrder {
            checkpoint: after_height,
            latest: through_height,
        });
    }
    let count = through_height - after_height;
    if count > MAX_WAL_TAIL_FRAMES {
        return Err(RestoreSourceError::TailMaximum(count));
    }
    let capacity = usize::try_from(count).map_err(|_| RestoreSourceError::TailMaximum(count))?;
    let mut frames = Vec::with_capacity(capacity);
    for height in (after_height + 1)..=through_height {
        let frame = reader.frame(height)?;
        let actual_height = unsigned(field(&frame, "height")?, "height")?;
        if actual_height != height {
            return Err(RestoreSourceError::HeadOrder {
                checkpoint: height,
                latest: actual_height,
            });
        }
        let timestamp = unsigned(field(&frame, "timestamp")?, "timestamp")?;
        let expected = frame_commitments(&frame)?;
        let output_count = expected
            .output_count
            .ok_or(RestoreSourceError::Field("runtimeOutputCount"))?;
        let output_count = usize::try_from(output_count)
            .map_err(|_| RestoreSourceError::OutputCount(output_count))?;
        let output_digest = field(&frame, "runtimeOutputsDigest")?
            .as_str()
            .ok_or(RestoreSourceError::Digest("runtimeOutputsDigest"))?;
        let persisted_outputs = reader.runtime_outputs(height, output_count, output_digest)?;
        let entity_contexts = load_contexts(reader, &frame)?;
        frames.push(ExactRuntimeWalFrame {
            height,
            timestamp,
            expected,
            input: LevelDbRuntimeInput {
                frame,
                entity_contexts,
                persisted_outputs,
            },
        });
    }
    Ok(frames)
}
