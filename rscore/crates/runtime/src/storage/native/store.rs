//! Single-writer native Runtime WAL and durable flat outbox.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use rusty_leveldb::{DB, LdbIterator, Options, WriteBatch};

use super::bounded::{physical_keys_for_value, physical_rows, previous_physical_keys};
use super::codec::{
    decode_head, encode_checkpoint, encode_head, output_digest, validate_storage_row,
};
use super::entity_context::frame_entity_context_refs;
use super::frame::{EncodedRuntimeFrame, ValidatedRuntimeFrame, validate_runtime_frame};
use super::fsync::{DurableEnv, sync_database_directory};
use super::keys::{KEY_HEAD, KEY_NATIVE_CHECKPOINT, frame_key, output_key};
use super::keys::{KEY_RUNTIME_MACHINE_LEAF, runtime_machine_leaf_key};
use super::types::{
    DurableRuntimeFrame, NativeStorageConfig, NativeStorageTimings, PathNodeChange,
    RuntimeFrameCommit, StorageHead,
};
use super::{MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, MAX_OUTPUT_ROWS, NativeStorageError};

pub struct NativeRuntimeStore {
    pub(super) database: DB,
    path: PathBuf,
    config: NativeStorageConfig,
    pub(super) head: StorageHead,
    pub(super) poisoned: bool,
    /// RAM mirror of the logical checkpoint path-node rows. Derived state:
    /// populated lazily from `path_node_rows` and advanced by exactly the
    /// `node_changes` that `persist_frame` makes durable, so cadence reads
    /// stop scanning the whole LevelDB graph. Dropped on a full checkpoint
    /// rewrite; a restart rebuilds it from disk.
    checkpoint_path_nodes: Option<BTreeMap<Vec<u8>, Vec<u8>>>,
    /// RAM mirror of the stable `0x16 || path` Runtime-machine keys. A restart
    /// performs one bounded scan of that current namespace; later checkpoints
    /// diff exact prior/current paths without scanning or rewriting obsolete
    /// generations.
    runtime_machine_keys: Option<BTreeSet<Vec<u8>>>,
}

struct PreparedRuntimeFrame {
    frame: RuntimeFrameCommit,
    digest: [u8; 32],
    materialized_state: bool,
    next_head: StorageHead,
}

fn elapsed(started: Option<Instant>) -> Duration {
    started.map_or(Duration::ZERO, |started| started.elapsed())
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
        let env: Box<dyn rusty_leveldb::env::Env> = if config.durable_fsync {
            Box::new(DurableEnv::default())
        } else {
            Box::new(rusty_leveldb::PosixDiskEnv::new())
        };
        let options = Options {
            env: Rc::new(env),
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
            checkpoint_path_nodes: None,
            runtime_machine_keys: None,
        })
    }

    pub fn latest_height(&self) -> u64 {
        self.head.latest_height
    }

    /// Exact bytes retained by the canonical Runtime WAL head.
    ///
    /// This is a read-only projection of the same HEAD row advanced in the
    /// synced frame batch. Filesystem directory size is not equivalent: a
    /// LevelDB compaction may shrink it while the logical WAL grows.
    pub fn retained_wal_bytes(&self) -> u64 {
        self.head.retained_wal_bytes
    }

    /// Exact permanent checkpoint graph visible before the next cadence
    /// write. This is read only at cadence so carried Entity rows can remain
    /// untouched while native-owned rows are replaced in the same WAL batch.
    pub(crate) fn current_checkpoint_path_nodes(
        &mut self,
    ) -> Result<&BTreeMap<Vec<u8>, Vec<u8>>, NativeStorageError> {
        self.ensure_healthy()?;
        if self.checkpoint_path_nodes.is_none() {
            self.checkpoint_path_nodes = Some(self.path_node_rows()?.into_iter().collect());
        } else {
            #[cfg(debug_assertions)]
            {
                let fresh: BTreeMap<Vec<u8>, Vec<u8>> =
                    self.path_node_rows()?.into_iter().collect();
                assert!(
                    self.checkpoint_path_nodes.as_ref() == Some(&fresh),
                    "RSCORE_CHECKPOINT_PATH_NODE_CACHE_DIVERGED"
                );
            }
        }
        Ok(self
            .checkpoint_path_nodes
            .as_ref()
            .expect("populated above"))
    }

    pub fn append_frame(
        &mut self,
        frame: RuntimeFrameCommit,
    ) -> Result<DurableRuntimeFrame, NativeStorageError> {
        self.ensure_healthy()?;
        let prepared = self.prepare_frame(frame)?;
        self.persist_frame(prepared, false).map(|(frame, _)| frame)
    }

    /// Hot production seam for the sealed output of the canonical Runtime
    /// frame builder. It checks durable rows and checkpoint binding without
    /// decoding and re-encoding bytes that this process just constructed.
    pub(crate) fn append_encoded_frame(
        &mut self,
        mut encoded: EncodedRuntimeFrame,
        profile: bool,
    ) -> Result<(DurableRuntimeFrame, NativeStorageTimings), NativeStorageError> {
        self.ensure_healthy()?;
        let prepare_started = profile.then(Instant::now);
        validate_encoded_frame(&encoded)?;
        let resident_output_values = encoded.resident_output_values.take();
        let prepared = self.prepare_validated_frame(encoded.commit, encoded.validated)?;
        let prepare_validate = elapsed(prepare_started);
        let (mut durable, mut timings) = self.persist_frame(prepared, profile)?;
        timings.prepare_validate = prepare_validate;
        durable.resident_output_values = std::cell::RefCell::new(resident_output_values);
        Ok((durable, timings))
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
        if !self.is_pristine()? {
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
        next_head.retained_wal_bytes = bytes;
        self.persist_frame(
            PreparedRuntimeFrame {
                frame,
                digest: envelope.output_digest,
                materialized_state: true,
                next_head,
            },
            false,
        )
        .map(|(frame, _)| frame)
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
        next_head.retained_wal_bytes = next_head
            .retained_wal_bytes
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
            if frame.materialized_state || frame.runtime_machine_root.is_some() {
                return Err(NativeStorageError::Checkpoint("frame-without-graph"));
            }
            return Ok(());
        };
        if !frame.materialized_state {
            return Err(NativeStorageError::Checkpoint("non-materialized-graph"));
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
        mut prepared: PreparedRuntimeFrame,
        profile: bool,
    ) -> Result<(DurableRuntimeFrame, NativeStorageTimings), NativeStorageError> {
        if prepared.materialized_state && self.runtime_machine_keys.is_none() {
            self.runtime_machine_keys = Some(runtime_machine_keys(&mut self.database)?);
        }
        let batch_started = profile.then(Instant::now);
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
        let next_runtime_machine_keys = if let Some(checkpoint) = &prepared.frame.checkpoint
            && prepared.materialized_state
        {
            // Stable Runtime-machine keys carry only the latest materialized
            // checkpoint. Remove exactly paths absent from the new graph and
            // overwrite retained paths in the same batch as frame, checkpoint
            // pointer and HEAD.
            let next = put_runtime_machine_rows(
                &mut batch,
                checkpoint,
                self.runtime_machine_keys
                    .as_ref()
                    .expect("loaded for a materialized checkpoint"),
            )?;
            put_checkpoint_rows(
                &mut self.database,
                &mut batch,
                prepared.frame.height,
                checkpoint,
                self.checkpoint_path_nodes.as_ref(),
            )?;
            Some(next)
        } else {
            None
        };
        batch.put(KEY_HEAD, &encode_head(&prepared.next_head)?);
        let batch_build = elapsed(batch_started);
        let write_started = profile.then(Instant::now);
        if let Err(error) = self.database.write(batch, self.config.durable_fsync) {
            self.poisoned = true;
            return Err(NativeStorageError::Database(error.to_string()));
        }
        let db_write_sync = elapsed(write_started);
        let directory_sync = if self.config.durable_fsync {
            let directory_started = profile.then(Instant::now);
            if let Err(error) = sync_database_directory(&self.path) {
                self.poisoned = true;
                return Err(error);
            }
            elapsed(directory_started)
        } else {
            Duration::ZERO
        };
        let post_commit_started = profile.then(Instant::now);
        match prepared.frame.checkpoint.as_mut() {
            Some(checkpoint) if checkpoint.full => {
                self.checkpoint_path_nodes = Some(
                    std::mem::take(&mut checkpoint.node_changes)
                        .into_iter()
                        .filter_map(|change| {
                            change
                                .value
                                .map(|value| (change.key.as_bytes().to_vec(), value))
                        })
                        .collect(),
                );
            }
            Some(checkpoint) if prepared.materialized_state => {
                if let Some(cache) = self.checkpoint_path_nodes.as_mut() {
                    for change in std::mem::take(&mut checkpoint.node_changes) {
                        match change.value {
                            Some(value) => {
                                cache.insert(change.key.as_bytes().to_vec(), value);
                            }
                            None => {
                                cache.remove(change.key.as_bytes());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if let Some(keys) = next_runtime_machine_keys {
            self.runtime_machine_keys = Some(keys);
        }
        self.head = prepared.next_head;
        let height = prepared.frame.height;
        let output_count = prepared.frame.outputs.len();
        let durable = DurableRuntimeFrame {
            height,
            output_count,
            output_digest: prepared.digest,
            resident_outputs: Some(prepared.frame.outputs),
            resident_output_values: std::cell::RefCell::new(None),
        };
        let post_commit = elapsed(post_commit_started);
        Ok((
            durable,
            NativeStorageTimings {
                prepare_validate: Duration::ZERO,
                batch_build,
                db_write_sync,
                directory_sync,
                post_commit,
            },
        ))
    }

    pub(super) fn ensure_healthy(&self) -> Result<(), NativeStorageError> {
        if self.poisoned {
            Err(NativeStorageError::Poisoned)
        } else {
            Ok(())
        }
    }

    /// True only before this store owns any checkpoint, Runtime WAL row, or
    /// auxiliary durable state. Fresh-genesis admission uses this exact
    /// physical check; a non-pristine store with a missing checkpoint is
    /// corruption and must go through restore's loud failure path.
    pub fn is_pristine(&mut self) -> Result<bool, NativeStorageError> {
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
    if encoded
        .resident_output_values
        .as_ref()
        .is_some_and(|values| values.len() != frame.outputs.len())
    {
        return Err(NativeStorageError::DurableToken(frame.height));
    }
    #[cfg(debug_assertions)]
    if let Some(values) = &encoded.resident_output_values {
        for (value, bytes) in values.iter().zip(&frame.outputs) {
            let rebuilt = crate::transport::msgpack::encode_framed(value)
                .map_err(|_| NativeStorageError::DurableToken(frame.height))?;
            if &rebuilt != bytes {
                return Err(NativeStorageError::DurableToken(frame.height));
            }
        }
    }
    if frame.outputs.len() > MAX_OUTPUT_ROWS {
        return Err(NativeStorageError::OutputCount(frame.outputs.len()));
    }
    // Rows were built by this process's own frame builder and are already
    // bound by the validated output digest checked above; size is the only
    // durable-side constraint left. Decoding each row again here re-parsed
    // bytes this process just constructed (the import path keeps full
    // validation in validate_frame).
    for output in &frame.outputs {
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(NativeStorageError::OutputBytes(output.len()));
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
    Ok(context_bytes)
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
    Ok(())
}

fn put_checkpoint_rows(
    database: &mut DB,
    batch: &mut WriteBatch,
    height: u64,
    checkpoint: &super::types::CheckpointGraph,
    prior: Option<&BTreeMap<Vec<u8>, Vec<u8>>>,
) -> Result<(), NativeStorageError> {
    for PathNodeChange { key, value } in &checkpoint.node_changes {
        let previous_keys = if checkpoint.full {
            Vec::new()
        } else if let Some(prior) = prior {
            prior.get(key.as_bytes()).map_or(Ok(Vec::new()), |value| {
                physical_keys_for_value(key.as_bytes(), value)
            })?
        } else {
            previous_physical_keys(database, key.as_bytes())?
        };
        for physical_key in previous_keys {
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
    graph: &super::types::CheckpointGraph,
    prior: &BTreeSet<Vec<u8>>,
) -> Result<BTreeSet<Vec<u8>>, NativeStorageError> {
    let next = graph
        .runtime_machine_leaves
        .iter()
        .map(|leaf| runtime_machine_leaf_key(&leaf.path_bytes))
        .collect::<Result<BTreeSet<_>, _>>()?;
    for key in prior.difference(&next) {
        batch.delete(key);
    }
    for leaf in &graph.runtime_machine_leaves {
        batch.put(
            &runtime_machine_leaf_key(&leaf.path_bytes)?,
            &leaf.value_bytes,
        );
    }
    Ok(next)
}

fn runtime_machine_keys(database: &mut DB) -> Result<BTreeSet<Vec<u8>>, NativeStorageError> {
    let mut iterator = database
        .new_iter()
        .map_err(|error| NativeStorageError::Database(error.to_string()))?;
    iterator.seek(&[KEY_RUNTIME_MACHINE_LEAF]);
    let mut keys = BTreeSet::new();
    while let Some((key, _)) = iterator.current() {
        if key.first() != Some(&KEY_RUNTIME_MACHINE_LEAF) {
            break;
        }
        if key.len() == 1 {
            return Err(NativeStorageError::RuntimeMachinePath);
        }
        keys.insert(key.to_vec());
        if !iterator.advance() {
            break;
        }
    }
    Ok(keys)
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

fn read_head(database: &mut DB) -> Result<StorageHead, NativeStorageError> {
    database
        .get(KEY_HEAD)
        .map(|bytes| decode_head(&bytes))
        .transpose()
        .map(|head| head.unwrap_or_default())
}
