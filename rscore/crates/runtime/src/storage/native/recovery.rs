//! Exact checkpoint-graph plus ordered Runtime-WAL recovery.

use std::collections::BTreeMap;

use rusty_leveldb::LdbIterator;

use super::NativeRuntimeStore;
use super::NativeStorageError;

type RawPathNodeRow = (Vec<u8>, Vec<u8>);
use super::codec::{decode_checkpoint, output_digest, validate_storage_row};
use super::entity_context::{
    EntityContextPayloadRow, EntityContextPayloadRows, entity_context_height_prefix,
    frame_entity_context_refs, parse_entity_context_payload_key,
};
use super::frame::validate_runtime_frame;
use super::keys::{
    KEY_NATIVE_CHECKPOINT, frame_key, is_path_node_key, output_key, runtime_machine_leaf_prefix,
};
use super::types::{
    DurableRuntimeFrame, NativeRuntimeRecovery, RecoveredCheckpoint, RecoveredOutboxFrame,
    RecoveredWalFrame, RuntimeMachineLeafRow,
};

impl NativeRuntimeStore {
    /// Read one already-durable frame for parity diagnostics.
    ///
    /// This is deliberately on-demand: successful production frames retain
    /// no second copy of their bytes, while a replay/shadow failure can still
    /// show the exact first field and outbox row that diverged.
    pub fn read_durable_frame(
        &mut self,
        height: u64,
    ) -> Result<RecoveredWalFrame, NativeStorageError> {
        self.ensure_healthy()?;
        if height == 0 || height > self.head.latest_height {
            return Err(NativeStorageError::NotDurable(height));
        }
        self.recover_frame(height)
    }

    /// Recreate the opaque publication token for the latest fully durable
    /// frame. Delivery state is intentionally absent: after every restart the
    /// latest flat outbox is best-effort resent and bilateral Account ACKs
    /// provide the only protocol deduplication.
    pub fn durable_frames_for_resend(
        &mut self,
    ) -> Result<Vec<DurableRuntimeFrame>, NativeStorageError> {
        self.ensure_healthy()?;
        if self.head.latest_height == 0 {
            return Ok(Vec::new());
        }
        let start = self
            .recover_checkpoint()?
            .as_ref()
            .map_or(1, |checkpoint| checkpoint.height);
        (start..=self.head.latest_height)
            .map(|height| {
                let frame = self.recover_frame(height)?;
                Ok(DurableRuntimeFrame {
                    height: frame.height,
                    output_count: frame.outputs.len(),
                    output_digest: output_digest(&frame.outputs)?,
                    resident_outputs: None,
                    resident_output_values: std::cell::RefCell::new(None),
                })
            })
            .collect()
    }

    /// Rebuild the last materialized path graph, then return every exact WAL
    /// frame after it. The Runtime reducer replays this ordered tail before
    /// sockets or timers are enabled.
    pub fn recover(&mut self) -> Result<NativeRuntimeRecovery, NativeStorageError> {
        self.ensure_healthy()?;
        let checkpoint = self.recover_checkpoint()?;
        let start = checkpoint
            .as_ref()
            .map_or(1, |value| value.height.saturating_add(1));
        let mut wal_frames = Vec::new();
        for height in start..=self.head.latest_height {
            wal_frames.push(self.recover_frame(height)?);
        }
        let resend_start = checkpoint.as_ref().map_or(1, |value| value.height);
        let pending_outbox = (resend_start..=self.head.latest_height)
            .map(|height| {
                Ok(RecoveredOutboxFrame {
                    height,
                    outputs: self.read_outputs_at(height)?,
                })
            })
            .collect::<Result<Vec<_>, NativeStorageError>>()?;
        Ok(NativeRuntimeRecovery {
            checkpoint,
            wal_frames,
            pending_outbox,
        })
    }

    pub(super) fn recover_checkpoint(
        &mut self,
    ) -> Result<Option<RecoveredCheckpoint>, NativeStorageError> {
        let Some(bytes) = self.database.get(KEY_NATIVE_CHECKPOINT) else {
            if self.head.latest_materialized_height != 0 {
                return Err(NativeStorageError::Checkpoint("missing"));
            }
            return Ok(None);
        };
        let (height, state_root) = decode_checkpoint(&bytes)?;
        if height != self.head.latest_materialized_height || height > self.head.latest_height {
            return Err(NativeStorageError::Checkpoint("height"));
        }
        Ok(Some(RecoveredCheckpoint {
            height,
            state_root,
            path_nodes: self.path_node_rows()?.into_iter().collect(),
            runtime_machine_leaves: self.runtime_machine_leaf_rows()?,
        }))
    }

    pub(super) fn recover_frame(
        &mut self,
        height: u64,
    ) -> Result<RecoveredWalFrame, NativeStorageError> {
        let frame_bytes = self.required(&frame_key(height))?;
        let validated = validate_runtime_frame(&frame_bytes)?;
        if validated.height != height {
            return Err(NativeStorageError::FrameHeight {
                key: height,
                frame: validated.height,
            });
        }
        let outputs =
            self.read_outputs(validated.output_count, &validated.output_digest, height)?;
        let entity_contexts = self.read_entity_contexts(height)?;
        if frame_entity_context_refs(&frame_bytes)? != entity_contexts.frame_refs() {
            return Err(NativeStorageError::EntityContext(
                super::EntityContextPayloadError::FrameRefs,
            ));
        }
        Ok(RecoveredWalFrame {
            height,
            frame_bytes,
            outputs,
            entity_contexts,
        })
    }

    pub(super) fn read_outputs_at(
        &mut self,
        height: u64,
    ) -> Result<Vec<Vec<u8>>, NativeStorageError> {
        if height == 0 || height > self.head.latest_height {
            return Err(NativeStorageError::NotDurable(height));
        }
        let frame = self.required(&frame_key(height))?;
        let validated = validate_runtime_frame(&frame)?;
        self.read_outputs(validated.output_count, &validated.output_digest, height)
    }

    fn read_outputs(
        &mut self,
        output_count: usize,
        expected_digest: &[u8; 32],
        height: u64,
    ) -> Result<Vec<Vec<u8>>, NativeStorageError> {
        let mut rows = Vec::with_capacity(output_count);
        for index in 0..output_count {
            let bytes = self.required(&output_key(height, index)?)?;
            validate_storage_row(&bytes)?;
            rows.push(bytes);
        }
        if output_digest(&rows)? != *expected_digest {
            return Err(NativeStorageError::OutputDigest(height));
        }
        Ok(rows)
    }

    fn read_entity_contexts(
        &mut self,
        height: u64,
    ) -> Result<EntityContextPayloadRows, NativeStorageError> {
        let prefix = entity_context_height_prefix(height)?;
        let mut iterator = self
            .database
            .new_iter()
            .map_err(|error| NativeStorageError::Database(error.to_string()))?;
        iterator.seek(&prefix);
        let mut rows = Vec::new();
        while let Some((key, value)) = iterator.current() {
            if !key.starts_with(&prefix) {
                break;
            }
            let (row_height, replica_id, kind, index) = parse_entity_context_payload_key(&key)?;
            if row_height != height {
                return Err(NativeStorageError::EntityContext(
                    super::EntityContextPayloadError::Key,
                ));
            }
            let value = if kind == super::entity_context::EntityContextPayloadKind::Manifest {
                super::bounded::collapse(&mut self.database, &key, &value)?
            } else {
                value.to_vec()
            };
            rows.push(EntityContextPayloadRow::new(
                replica_id, kind, index, value,
            )?);
            if !iterator.advance() {
                break;
            }
        }
        EntityContextPayloadRows::validate(rows).map_err(Into::into)
    }

    pub(super) fn required(&mut self, key: &[u8]) -> Result<Vec<u8>, NativeStorageError> {
        self.database
            .get(key)
            .map(|value| value.to_vec())
            .ok_or_else(|| NativeStorageError::Missing(key.to_vec()))
    }

    pub(super) fn path_node_keys(&mut self) -> Result<Vec<Vec<u8>>, NativeStorageError> {
        let logical = self
            .path_node_rows()?
            .into_iter()
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        let mut physical = Vec::new();
        for key in logical {
            physical.extend(super::bounded::previous_physical_keys(
                &mut self.database,
                &key,
            )?);
        }
        Ok(physical)
    }

    pub(crate) fn path_node_rows(&mut self) -> Result<Vec<RawPathNodeRow>, NativeStorageError> {
        let mut iterator = self
            .database
            .new_iter()
            .map_err(|error| NativeStorageError::Database(error.to_string()))?;
        iterator.seek(&[0]);
        let mut rows = BTreeMap::new();
        while let Some((key, value)) = iterator.current() {
            if is_path_node_key(&key) {
                rows.insert(key.to_vec(), value.to_vec());
            }
            if !iterator.advance() {
                break;
            }
        }
        rows.into_iter()
            .map(|(key, value)| {
                let value = super::bounded::collapse(&mut self.database, &key, &value)?;
                Ok((key, value))
            })
            .collect()
    }

    fn runtime_machine_leaf_rows(
        &mut self,
    ) -> Result<Vec<RuntimeMachineLeafRow>, NativeStorageError> {
        let prefix = runtime_machine_leaf_prefix();
        let mut iterator = self
            .database
            .new_iter()
            .map_err(|error| NativeStorageError::Database(error.to_string()))?;
        iterator.seek(&prefix);
        let mut rows = Vec::new();
        while let Some((key, value)) = iterator.current() {
            if !key.starts_with(&prefix) {
                break;
            }
            let path_bytes = key
                .get(prefix.len()..)
                .filter(|path| !path.is_empty())
                .ok_or(NativeStorageError::RuntimeMachinePath)?
                .to_vec();
            rows.push(RuntimeMachineLeafRow {
                path_bytes,
                value_bytes: value.to_vec(),
            });
            if !iterator.advance() {
                break;
            }
        }
        Ok(rows)
    }
}
