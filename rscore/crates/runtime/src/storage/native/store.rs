//! Single-writer native Runtime WAL and durable flat outbox.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use rusty_leveldb::{DB, LdbIterator, Options, WriteBatch};

use super::bounded::{physical_rows, previous_physical_keys};
use super::codec::{
    decode_head, encode_checkpoint, encode_head, output_digest, validate_storage_row,
};
use super::entity_context::frame_entity_context_refs;
use super::frame::{EncodedRuntimeFrame, ValidatedRuntimeFrame, validate_runtime_frame};
use super::fsync::{DurableEnv, sync_database_directory};
use super::keys::{KEY_HEAD, KEY_NATIVE_CHECKPOINT, frame_key, output_key};
use super::keys::{runtime_machine_leaf_key, runtime_watcher_cursor_key};
use super::types::{
    DurableRuntimeFrame, NativeStorageConfig, PathNodeChange, RuntimeFrameCommit,
    RuntimeWatcherCursorRow, StorageHead,
};
use super::{MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, MAX_OUTPUT_ROWS, NativeStorageError};

pub struct NativeRuntimeStore {
    pub(super) database: DB,
    path: PathBuf,
    config: NativeStorageConfig,
    pub(super) head: StorageHead,
    pub(super) poisoned: bool,
}

struct PreparedRuntimeFrame {
    frame: RuntimeFrameCommit,
    digest: [u8; 32],
    materialized_state: bool,
    next_head: StorageHead,
}

impl NativeRuntimeStore {
    pub fn open(
        path: impl AsRef<Path>,
        config: NativeStorageConfig,
    ) -> Result<Self, NativeStorageError> {
        if config.checkpoint_period_frames == 0 {
            return Err(NativeStorageError::CheckpointPeriod);
        }
        let path = path.as_ref().to_path_buf();
        let options = Options {
            env: Rc::new(Box::new(DurableEnv::default())),
            // Runtime frames are already an append-only WAL stream. Keep one
            // checkpoint interval resident so LevelDB does not synchronously
            // compact the same hot bytes between every few frame fsyncs.
            write_buffer_size: 256 * 1024 * 1024,
            max_file_size: 64 * 1024 * 1024,
            create_if_missing: true,
            error_if_exists: false,
            paranoid_checks: true,
            ..Options::default()
        };
        let mut database = DB::open(&path, options)
            .map_err(|error| NativeStorageError::Database(error.to_string()))?;
        let head = read_head(&mut database)?;
        Ok(Self {
            database,
            path,
            config,
            head,
            poisoned: false,
        })
    }

    pub fn latest_height(&self) -> u64 {
        self.head.latest_height
    }

    /// Exact permanent checkpoint graph visible before the next cadence
    /// write. This is read only at cadence so carried Entity rows can remain
    /// untouched while native-owned rows are replaced in the same WAL batch.
    pub(crate) fn current_checkpoint_path_nodes(
        &mut self,
    ) -> Result<BTreeMap<Vec<u8>, Vec<u8>>, NativeStorageError> {
        self.ensure_healthy()?;
        Ok(self.path_node_rows()?.into_iter().collect())
    }

    pub fn append_frame(
        &mut self,
        frame: RuntimeFrameCommit,
    ) -> Result<DurableRuntimeFrame, NativeStorageError> {
        self.ensure_healthy()?;
        let prepared = self.prepare_frame(frame)?;
        self.persist_frame(prepared)
    }

    /// Hot production seam for the sealed output of the canonical Runtime
    /// frame builder. It checks durable rows and checkpoint binding without
    /// decoding and re-encoding bytes that this process just constructed.
    pub(crate) fn append_encoded_frame(
        &mut self,
        encoded: EncodedRuntimeFrame,
    ) -> Result<DurableRuntimeFrame, NativeStorageError> {
        self.ensure_healthy()?;
        validate_encoded_frame(&encoded)?;
        let prepared = self.prepare_validated_frame(encoded.commit, encoded.validated)?;
        self.persist_frame(prepared)
    }

    /// Atomically install one already-verified materialized Runtime checkpoint
    /// as the first native durable head. The import is a real WAL boundary:
    /// exact frame, outbox, Entity contexts, path-key state, Runtime-machine
    /// leaves and HEAD share one synced batch. Historical gaps are not filled
    /// with fake empty frames.
    pub fn import_checkpoint(
        &mut self,
        frame: RuntimeFrameCommit,
    ) -> Result<DurableRuntimeFrame, NativeStorageError> {
        self.ensure_healthy()?;
        if !self.is_empty()? {
            return Err(NativeStorageError::CheckpointImportNotEmpty);
        }
        let checkpoint = frame
            .checkpoint
            .as_ref()
            .ok_or(NativeStorageError::CheckpointImportFullRequired)?;
        if !checkpoint.full {
            return Err(NativeStorageError::CheckpointImportFullRequired);
        }
        let envelope = validate_frame(&frame)?;
        self.validate_checkpoint(frame.height, &envelope, Some(checkpoint))?;
        let bytes = committed_bytes(&frame)?;
        let mut next_head = self.head.clone();
        next_head.latest_height = frame.height;
        next_head.latest_materialized_height = frame.height;
        next_head.epoch_replay_bytes = bytes;
        next_head.retained_history_bytes = bytes;
        self.persist_frame(PreparedRuntimeFrame {
            frame,
            digest: envelope.output_digest,
            materialized_state: true,
            next_head,
        })
    }

    pub fn read_durable_outputs(
        &mut self,
        durable: &DurableRuntimeFrame,
    ) -> Result<Vec<Vec<u8>>, NativeStorageError> {
        self.ensure_healthy()?;
        let outputs = self.read_outputs_at(durable.height)?;
        let actual = output_digest(&outputs)?;
        if outputs.len() != durable.output_count || actual != durable.output_digest {
            return Err(NativeStorageError::DurableToken(durable.height));
        }
        Ok(outputs)
    }

    /// Use the exact in-memory rows that have just crossed the synced batch.
    /// A restart has no resident copy and therefore falls back to the durable
    /// LevelDB rows. Either path is bound to the opaque count+digest token.
    pub(crate) fn publication_outputs<'a>(
        &mut self,
        durable: &'a DurableRuntimeFrame,
    ) -> Result<Cow<'a, [Vec<u8>]>, NativeStorageError> {
        if let Some(outputs) = durable.resident_outputs() {
            return Ok(Cow::Borrowed(outputs));
        }
        self.read_durable_outputs(durable).map(Cow::Owned)
    }

    /// Read the exact native Runtime-envelope watcher cursor before enabling
    /// polling. Absence means this `(Entity, chain, depository)` has never
    /// consumed a finalized range in the native store.
    pub fn read_runtime_watcher_cursor(
        &mut self,
        entity_id: [u8; 32],
        chain_id: u64,
        depository_address: [u8; 20],
    ) -> Result<Option<RuntimeWatcherCursorRow>, NativeStorageError> {
        self.ensure_healthy()?;
        let key = runtime_watcher_cursor_key(&entity_id, chain_id, &depository_address);
        self.database
            .get(&key)
            .map(|value| RuntimeWatcherCursorRow {
                entity_id,
                chain_id,
                depository_address,
                value_bytes: value.to_vec(),
            })
            .map(validate_watcher_cursor_row)
            .transpose()
    }

    fn prepare_frame(
        &self,
        frame: RuntimeFrameCommit,
    ) -> Result<PreparedRuntimeFrame, NativeStorageError> {
        let envelope = validate_frame(&frame)?;
        self.prepare_validated_frame(frame, envelope)
    }

    fn prepare_validated_frame(
        &self,
        frame: RuntimeFrameCommit,
        envelope: ValidatedRuntimeFrame,
    ) -> Result<PreparedRuntimeFrame, NativeStorageError> {
        let expected = self
            .head
            .latest_height
            .checked_add(1)
            .ok_or(NativeStorageError::HeightOverflow)?;
        if frame.height != expected {
            return Err(NativeStorageError::Height {
                expected,
                actual: frame.height,
            });
        }
        self.validate_checkpoint(frame.height, &envelope, frame.checkpoint.as_ref())?;
        let bytes = committed_bytes(&frame)?;
        let mut next_head = self.head.clone();
        next_head.latest_height = frame.height;
        if envelope.materialized_state {
            next_head.latest_materialized_height = frame.height;
        }
        next_head.epoch_replay_bytes = next_head
            .epoch_replay_bytes
            .checked_add(bytes)
            .ok_or(NativeStorageError::ByteCountOverflow)?;
        next_head.retained_history_bytes = next_head
            .retained_history_bytes
            .checked_add(bytes)
            .ok_or(NativeStorageError::ByteCountOverflow)?;
        Ok(PreparedRuntimeFrame {
            frame,
            digest: envelope.output_digest,
            materialized_state: envelope.materialized_state,
            next_head,
        })
    }

    fn validate_checkpoint(
        &self,
        height: u64,
        frame: &ValidatedRuntimeFrame,
        checkpoint: Option<&super::types::CheckpointGraph>,
    ) -> Result<(), NativeStorageError> {
        // Genesis-only WALs remain recoverable without a materialized graph;
        // the production machine requests one at height 1. Once a durable
        // head exists, enforce the same relative cadence as TypeScript.
        if self.head.latest_height > 0
            && crate::machine::materialization_due(
                height,
                self.head.latest_materialized_height,
                self.config.checkpoint_period_frames,
            )
            && checkpoint.is_none()
        {
            return Err(NativeStorageError::CheckpointRequired(height));
        }
        let Some(checkpoint) = checkpoint else {
            if frame.canonical_state_hash.is_some() || frame.runtime_machine_root.is_some() {
                return Err(NativeStorageError::Checkpoint("frame-without-graph"));
            }
            return Ok(());
        };
        if !frame.materialized_state && (checkpoint.full || !checkpoint.node_changes.is_empty()) {
            return Err(NativeStorageError::Checkpoint(
                "non-materialized-node-changes",
            ));
        }
        let canonical_state_hash = frame
            .canonical_state_hash
            .ok_or(NativeStorageError::RuntimeMachineRootMissing)?;
        if canonical_state_hash != checkpoint.state_root {
            return Err(NativeStorageError::RuntimeMachineRootMismatch);
        }
        let machine_root = frame
            .runtime_machine_root
            .as_ref()
            .ok_or(NativeStorageError::RuntimeMachineRootMissing)?;
        let mut keys = BTreeSet::new();
        for change in &checkpoint.node_changes {
            if !keys.insert(change.key.as_bytes()) {
                return Err(NativeStorageError::DuplicateNodeKey(
                    change.key.as_bytes().to_vec(),
                ));
            }
            if let Some(value) = &change.value {
                validate_storage_row(value)?;
            }
        }
        let mut machine_paths = BTreeSet::new();
        for leaf in &checkpoint.runtime_machine_leaves {
            if leaf.path_bytes.is_empty() || !machine_paths.insert(leaf.path_bytes.as_slice()) {
                return Err(NativeStorageError::RuntimeMachinePath);
            }
        }
        let expected_leaf_count = usize::try_from(machine_root.leaf_count)
            .map_err(|_| NativeStorageError::RuntimeMachinePath)?;
        crate::rebuild_runtime_machine_graph(
            checkpoint
                .runtime_machine_leaves
                .iter()
                .map(|leaf| (leaf.path_bytes.clone(), leaf.value_bytes.clone()))
                .collect(),
            &format_hash(&machine_root.root_hash),
            expected_leaf_count,
        )?;
        Ok(())
    }

    fn persist_frame(
        &mut self,
        prepared: PreparedRuntimeFrame,
    ) -> Result<DurableRuntimeFrame, NativeStorageError> {
        let mut batch = WriteBatch::default();
        if prepared
            .frame
            .checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.full)
        {
            for key in self.path_node_keys()? {
                batch.delete(&key);
            }
        }
        put_frame_rows(&mut batch, &prepared.frame)?;
        if let Some(checkpoint) = &prepared.frame.checkpoint {
            put_runtime_machine_rows(&mut batch, prepared.frame.height, checkpoint)?;
            if prepared.materialized_state {
                put_checkpoint_rows(
                    &mut self.database,
                    &mut batch,
                    prepared.frame.height,
                    checkpoint,
                )?;
            }
        }
        batch.put(KEY_HEAD, &encode_head(&prepared.next_head)?);
        if let Err(error) = self.database.write(batch, true) {
            self.poisoned = true;
            return Err(NativeStorageError::Database(error.to_string()));
        }
        if let Err(error) = sync_database_directory(&self.path) {
            self.poisoned = true;
            return Err(error);
        }
        self.head = prepared.next_head;
        let height = prepared.frame.height;
        let output_count = prepared.frame.outputs.len();
        Ok(DurableRuntimeFrame {
            height,
            output_count,
            output_digest: prepared.digest,
            resident_outputs: Some(prepared.frame.outputs),
        })
    }

    pub(super) fn ensure_healthy(&self) -> Result<(), NativeStorageError> {
        if self.poisoned {
            Err(NativeStorageError::Poisoned)
        } else {
            Ok(())
        }
    }

    fn is_empty(&mut self) -> Result<bool, NativeStorageError> {
        if self.head != super::types::StorageHead::default() {
            return Ok(false);
        }
        let mut iterator = self
            .database
            .new_iter()
            .map_err(|error| NativeStorageError::Database(error.to_string()))?;
        iterator.seek(&[0]);
        while let Some((key, _)) = iterator.current() {
            if key != KEY_HEAD {
                return Ok(false);
            }
            if !iterator.advance() {
                break;
            }
        }
        Ok(true)
    }
}

fn validate_frame(frame: &RuntimeFrameCommit) -> Result<ValidatedRuntimeFrame, NativeStorageError> {
    if frame.frame_bytes.len() > MAX_FRAME_BYTES {
        return Err(NativeStorageError::FrameBytes(frame.frame_bytes.len()));
    }
    if frame.outputs.len() > MAX_OUTPUT_ROWS {
        return Err(NativeStorageError::OutputCount(frame.outputs.len()));
    }
    let validated = validate_runtime_frame(&frame.frame_bytes)?;
    if frame_entity_context_refs(&frame.frame_bytes)? != frame.entity_contexts.frame_refs() {
        return Err(NativeStorageError::EntityContext(
            super::EntityContextPayloadError::FrameRefs,
        ));
    }
    if validated.height != frame.height {
        return Err(NativeStorageError::FrameHeight {
            key: frame.height,
            frame: validated.height,
        });
    }
    if validated.output_count != frame.outputs.len() {
        return Err(NativeStorageError::FrameOutputCount {
            frame: validated.output_count,
            rows: frame.outputs.len(),
        });
    }
    for output in &frame.outputs {
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(NativeStorageError::OutputBytes(output.len()));
        }
        validate_storage_row(output)?;
    }
    let digest = output_digest(&frame.outputs)?;
    if digest != validated.output_digest {
        return Err(NativeStorageError::OutputDigest(frame.height));
    }
    if frame.watcher_cursor_changes.len() > 256 {
        return Err(NativeStorageError::WatcherCursorCount(
            frame.watcher_cursor_changes.len(),
        ));
    }
    let mut watcher_keys = BTreeSet::new();
    for row in &frame.watcher_cursor_changes {
        validate_watcher_cursor_row(row.clone())?;
        if !watcher_keys.insert(runtime_watcher_cursor_key(
            &row.entity_id,
            row.chain_id,
            &row.depository_address,
        )) {
            return Err(NativeStorageError::WatcherCursorDuplicate);
        }
    }
    Ok(validated)
}

fn validate_encoded_frame(encoded: &EncodedRuntimeFrame) -> Result<(), NativeStorageError> {
    let frame = &encoded.commit;
    let validated = &encoded.validated;
    if frame.frame_bytes.len() > MAX_FRAME_BYTES {
        return Err(NativeStorageError::FrameBytes(frame.frame_bytes.len()));
    }
    if frame.height != validated.height {
        return Err(NativeStorageError::FrameHeight {
            key: frame.height,
            frame: validated.height,
        });
    }
    if encoded.frame_hash != validated.frame_hash
        || encoded.output_digest != validated.output_digest
        || frame.outputs.len() != validated.output_count
    {
        return Err(NativeStorageError::DurableToken(frame.height));
    }
    if frame.outputs.len() > MAX_OUTPUT_ROWS {
        return Err(NativeStorageError::OutputCount(frame.outputs.len()));
    }
    for output in &frame.outputs {
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(NativeStorageError::OutputBytes(output.len()));
        }
        validate_storage_row(output)?;
    }
    if frame.watcher_cursor_changes.len() > 256 {
        return Err(NativeStorageError::WatcherCursorCount(
            frame.watcher_cursor_changes.len(),
        ));
    }
    let mut watcher_keys = BTreeSet::new();
    for row in &frame.watcher_cursor_changes {
        validate_watcher_cursor_row(row.clone())?;
        if !watcher_keys.insert(runtime_watcher_cursor_key(
            &row.entity_id,
            row.chain_id,
            &row.depository_address,
        )) {
            return Err(NativeStorageError::WatcherCursorDuplicate);
        }
    }
    Ok(())
}

fn committed_bytes(frame: &RuntimeFrameCommit) -> Result<u64, NativeStorageError> {
    let output_bytes =
        frame
            .outputs
            .iter()
            .try_fold(frame.frame_bytes.len() as u64, |total, output| {
                total
                    .checked_add(output.len() as u64)
                    .ok_or(NativeStorageError::ByteCountOverflow)
            })?;
    let context_bytes =
        frame
            .entity_contexts
            .rows()
            .iter()
            .try_fold(output_bytes, |total, row| {
                let row_bytes = u64::try_from(row.value().len())
                    .map_err(|_| NativeStorageError::ByteCountOverflow)?;
                let key_bytes = u64::try_from(row.key(frame.height)?.len())
                    .map_err(|_| NativeStorageError::ByteCountOverflow)?;
                total
                    .checked_add(row_bytes)
                    .and_then(|value| value.checked_add(key_bytes))
                    .ok_or(NativeStorageError::ByteCountOverflow)
            })?;
    frame
        .watcher_cursor_changes
        .iter()
        .try_fold(context_bytes, |total, row| {
            let value_bytes = u64::try_from(row.value_bytes.len())
                .map_err(|_| NativeStorageError::ByteCountOverflow)?;
            total
                .checked_add(61)
                .and_then(|value| value.checked_add(value_bytes))
                .ok_or(NativeStorageError::ByteCountOverflow)
        })
}

fn put_frame_rows(
    batch: &mut WriteBatch,
    frame: &RuntimeFrameCommit,
) -> Result<(), NativeStorageError> {
    batch.put(&frame_key(frame.height), &frame.frame_bytes);
    for (index, output) in frame.outputs.iter().enumerate() {
        batch.put(&output_key(frame.height, index)?, output);
    }
    for row in frame.entity_contexts.rows() {
        batch.put(&row.key(frame.height)?, row.value());
    }
    for row in &frame.watcher_cursor_changes {
        batch.put(
            &runtime_watcher_cursor_key(&row.entity_id, row.chain_id, &row.depository_address),
            &row.value_bytes,
        );
    }
    Ok(())
}

fn put_checkpoint_rows(
    database: &mut DB,
    batch: &mut WriteBatch,
    height: u64,
    checkpoint: &super::types::CheckpointGraph,
) -> Result<(), NativeStorageError> {
    for PathNodeChange { key, value } in &checkpoint.node_changes {
        for physical_key in previous_physical_keys(database, key.as_bytes())? {
            batch.delete(&physical_key);
        }
        if let Some(value) = value {
            for (physical_key, physical_value) in physical_rows(key.as_bytes(), value)? {
                batch.put(&physical_key, &physical_value);
            }
        }
    }
    batch.put(
        KEY_NATIVE_CHECKPOINT,
        &encode_checkpoint(height, &checkpoint.state_root)?,
    );
    Ok(())
}

fn put_runtime_machine_rows(
    batch: &mut WriteBatch,
    height: u64,
    graph: &super::types::CheckpointGraph,
) -> Result<(), NativeStorageError> {
    for leaf in &graph.runtime_machine_leaves {
        batch.put(
            &runtime_machine_leaf_key(height, &leaf.path_bytes)?,
            &leaf.value_bytes,
        );
    }
    Ok(())
}

fn format_hash(value: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in value {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn validate_watcher_cursor_row(
    row: RuntimeWatcherCursorRow,
) -> Result<RuntimeWatcherCursorRow, NativeStorageError> {
    if row.chain_id == 0 || row.chain_id > 9_007_199_254_740_991 {
        return Err(NativeStorageError::WatcherCursorValue("chainId"));
    }
    let value = crate::decode_storage_payload(&row.value_bytes)?;
    if crate::transport::msgpack::encode_framed(&value)
        .map_err(|_| NativeStorageError::WatcherCursorValue("encoding"))?
        != row.value_bytes
    {
        return Err(NativeStorageError::WatcherCursorValue("canonical"));
    }
    let object = value
        .as_object()
        .filter(|object| {
            object.len() == 4
                && [
                    "chainId",
                    "depositoryAddress",
                    "scannedThrough",
                    "blockHash",
                ]
                .iter()
                .all(|field| object.contains_key(*field))
        })
        .ok_or(NativeStorageError::WatcherCursorValue("object"))?;
    let expected_address = format_bytes(&row.depository_address);
    let scanned_through = object
        .get("scannedThrough")
        .and_then(serde_json::Value::as_u64)
        .filter(|height| *height <= 9_007_199_254_740_991)
        .ok_or(NativeStorageError::WatcherCursorValue("binding"))?;
    if object.get("chainId").and_then(serde_json::Value::as_u64) != Some(row.chain_id)
        || object
            .get("depositoryAddress")
            .and_then(serde_json::Value::as_str)
            != Some(expected_address.as_str())
    {
        return Err(NativeStorageError::WatcherCursorValue("binding"));
    }
    match (scanned_through, object.get("blockHash")) {
        (0, Some(serde_json::Value::Null)) => {}
        (1.., Some(serde_json::Value::String(value)))
            if value == &value.to_ascii_lowercase()
                && value.len() == 66
                && value.starts_with("0x")
                && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit()) => {}
        _ => return Err(NativeStorageError::WatcherCursorValue("blockHash")),
    }
    Ok(row)
}

fn format_bytes(value: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(value.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in value {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn read_head(database: &mut DB) -> Result<StorageHead, NativeStorageError> {
    database
        .get(KEY_HEAD)
        .map(|bytes| decode_head(&bytes))
        .transpose()
        .map(|head| head.unwrap_or_default())
}
