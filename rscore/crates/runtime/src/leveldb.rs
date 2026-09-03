//! Direct reader for the canonical xln LevelDB WAL layout.
//!
//! `rusty-leveldb` takes an exclusive database lock and may recover its WAL.
//! The caller must therefore pass an offline database owned by Rust or an
//! operator-created snapshot copy; a live TypeScript Runtime is never opened.

use std::collections::BTreeMap;
use std::path::Path;

use rusty_leveldb::{DB, LdbIterator, Options};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use thiserror::Error;

use crate::restore::{
    ConcreteCheckpointSource, ConcreteRestoreSourceError, ConcreteWalSource, VerifiedEntityContext,
    VerifiedWalFrame, verify_checkpoint_source,
};
use crate::storage::native::{
    CheckpointGraph, EntityContextPayloadRow, EntityContextPayloadRows, NativeStorageError,
    PathNodeChange, PathNodeKey, RuntimeFrameCommit, RuntimeMachineLeafRow,
    entity_context_height_prefix, parse_entity_context_payload_key, validate_runtime_frame,
};
use crate::{StorageMessagePackError, decode_storage_payload};

mod rscore_checkpoint;
mod runtime_output;
pub use rscore_checkpoint::StoredRscoreCheckpoint;

const KEY_FRAME: u8 = 0x10;
const KEY_BOUNDED_VALUE_CHUNK: u8 = 0x11;
const KEY_ENTITY_CONTEXT_PAYLOAD: u8 = 0x14;
const ENTITY_CONTEXT_MANIFEST: u8 = 0;
const ENTITY_CONTEXT_GOSSIP_PROFILE: u8 = 1;
const ENTITY_CONTEXT_HTLC_ENTRY: u8 = 2;
const ENTITY_CONTEXT_HTLC_ORIGINATED: u8 = 3;
const ENTITY_CONTEXT_PEER_ASSERTIONS: u8 = 4;
const ENTITY_CONTEXT_GOSSIP_PROFILE_DIGESTS: u8 = 5;
const ENTITY_CONTEXT_HTLC_ENTRY_DIGESTS: u8 = 6;
const ENTITY_CONTEXT_HTLC_ORIGINATED_DIGESTS: u8 = 7;
const ENTITY_CONTEXT_PEER_ASSERTION_DIGESTS: u8 = 8;
const KEY_RUNTIME_OUTPUT_ROW: u8 = 0x13;
const KEY_HEAD: &[u8] = &[0x20];
const CHUNK_BYTES: usize = 9_000;
const MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES: usize = 10_000;

type RawDatabaseRow = (Vec<u8>, Vec<u8>);

#[derive(Debug, Error)]
pub enum RuntimeLevelDbError {
    #[error("RUNTIME_LEVELDB_OPEN:{0}")]
    Open(String),
    #[error("RUNTIME_LEVELDB_VALUE_MISSING:{0}")]
    Missing(String),
    #[error("RUNTIME_LEVELDB_BOUNDED_MANIFEST:{0}")]
    Manifest(String),
    #[error("RUNTIME_LEVELDB_BOUNDED_CHUNK:{0}")]
    Chunk(String),
    #[error("RUNTIME_LEVELDB_BOUNDED_DIGEST:expected={expected}:actual={actual}")]
    Digest { expected: String, actual: String },
    #[error("RUNTIME_LEVELDB_OUTPUT:{0}")]
    Output(String),
    #[error("RUNTIME_LEVELDB_ITERATOR:{0}")]
    Iterator(String),
    #[error(transparent)]
    MachineGraph(#[from] crate::RuntimeMachineGraphError),
    #[error(transparent)]
    MessagePack(#[from] StorageMessagePackError),
    #[error(transparent)]
    ConcreteSource(#[from] ConcreteRestoreSourceError),
    #[error(transparent)]
    NativeStorage(#[from] NativeStorageError),
}

pub struct RuntimeWalReader {
    database: DB,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RuntimeHeadHeights {
    latest: u64,
    materialized: u64,
    snapshot: u64,
}

impl RuntimeWalReader {
    /// Open an offline/copy-once canonical Runtime WAL.
    pub fn open_owned(path: impl AsRef<Path>) -> Result<Self, RuntimeLevelDbError> {
        let options = Options {
            create_if_missing: false,
            error_if_exists: false,
            paranoid_checks: true,
            ..Options::default()
        };
        DB::open(path, options)
            .map(|database| Self { database })
            .map_err(|error| RuntimeLevelDbError::Open(error.to_string()))
    }

    pub fn head(&mut self) -> Result<Value, RuntimeLevelDbError> {
        self.required_decoded(KEY_HEAD)
    }

    fn head_heights(&mut self) -> Result<RuntimeHeadHeights, RuntimeLevelDbError> {
        let head = self.head()?;
        let object = head
            .as_object()
            .ok_or_else(|| RuntimeLevelDbError::Output("HEAD_OBJECT".into()))?;
        let required = |field: &'static str, code: &'static str| {
            object
                .get(field)
                .and_then(Value::as_u64)
                .ok_or_else(|| RuntimeLevelDbError::Output(code.into()))
        };
        let heights = RuntimeHeadHeights {
            latest: required("latestHeight", "HEAD_LATEST_HEIGHT")?,
            materialized: required(
                "latestMaterializedHeight",
                "HEAD_LATEST_MATERIALIZED_HEIGHT",
            )?,
            snapshot: required("latestSnapshotHeight", "HEAD_LATEST_SNAPSHOT_HEIGHT")?,
        };
        if heights.materialized > heights.latest || heights.snapshot > heights.latest {
            return Err(RuntimeLevelDbError::Output("HEAD_HEIGHT_ORDER".into()));
        }
        Ok(heights)
    }

    pub fn frame(&mut self, height: u64) -> Result<Value, RuntimeLevelDbError> {
        self.required_bounded(&frame_key(height))
    }

    pub fn entity_context(
        &mut self,
        runtime_height: u64,
        replica_id: &str,
        digest: &[u8; 32],
    ) -> Result<Value, RuntimeLevelDbError> {
        let database = &mut self.database;
        entity_context_with(
            &mut |key| Ok(database.get(key).map(|value| value.to_vec())),
            runtime_height,
            replica_id,
            digest,
        )
    }

    /// Rebuild one typed Entity infrastructure context from path-addressed,
    /// digest-verified rows owned by one Runtime frame and replica.
    pub fn entity_context_full(
        &mut self,
        runtime_height: u64,
        replica_id: &str,
        digest: &[u8; 32],
    ) -> Result<Value, RuntimeLevelDbError> {
        let database = &mut self.database;
        entity_context_full_with(
            &mut |key| Ok(database.get(key).map(|value| value.to_vec())),
            runtime_height,
            replica_id,
            digest,
        )
    }

    pub fn runtime_machine(
        &mut self,
        expected_root: &str,
        expected_leaf_count: usize,
    ) -> Result<Value, RuntimeLevelDbError> {
        let prefix = [0x16];
        let rows = self.prefixed_rows(&prefix)?;
        let leaves = rows
            .into_iter()
            .map(|(key, value)| (key[prefix.len()..].to_vec(), value))
            .collect();
        crate::rebuild_runtime_machine_graph(leaves, expected_root, expected_leaf_count)
            .map_err(Into::into)
    }

    /// Read and verify the Runtime-machine graph committed by one WAL frame.
    /// Frames without a materialized/canonical graph return `None`.
    pub fn runtime_machine_for_frame(
        &mut self,
        height: u64,
    ) -> Result<Option<Value>, RuntimeLevelDbError> {
        let frame = self.frame(height)?;
        if height != self.head_heights()?.materialized {
            return Ok(None);
        }
        let Some(root) = frame
            .as_object()
            .and_then(|object| object.get("runtimeMachineRoot"))
        else {
            return Ok(None);
        };
        let root = root
            .as_object()
            .ok_or_else(|| RuntimeLevelDbError::Output("MACHINE_ROOT_OBJECT".into()))?;
        let root_hash = root
            .get("rootHash")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeLevelDbError::Output("MACHINE_ROOT_HASH".into()))?;
        let leaf_count = root
            .get("leafCount")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| RuntimeLevelDbError::Output("MACHINE_ROOT_LEAF_COUNT".into()))?;
        self.runtime_machine(root_hash, leaf_count).map(Some)
    }

    /// Load one exact materialized checkpoint from an offline canonical DB.
    ///
    /// Only permanent logical-path state rows enter the source. Generic
    /// bounded-value manifests are collapsed to their authenticated payload;
    /// dedicated Entity/Account field chunks remain separate path rows for
    /// their owning graph decoder. Old hash-addressed state namespaces are a
    /// loud import failure, never a compatibility read.
    pub fn concrete_checkpoint_source(
        &mut self,
        state_reader: &mut RuntimeWalReader,
        height: u64,
    ) -> Result<ConcreteCheckpointSource, RuntimeLevelDbError> {
        let current = self.head_heights()?.materialized;
        if height != current {
            return Err(RuntimeLevelDbError::Output(format!(
                "CHECKPOINT_MACHINE_NOT_CURRENT:requested={height}:current={current}",
            )));
        }
        let frame_key = frame_key(height);
        let frame_bytes = self.required_bounded_bytes(&frame_key)?;
        let frame = decode_storage_payload(&frame_bytes)?;
        let frame = frame
            .as_object()
            .ok_or_else(|| RuntimeLevelDbError::Output("CHECKPOINT_FRAME_OBJECT".into()))?;
        let root = frame
            .get("runtimeMachineRoot")
            .and_then(Value::as_object)
            .ok_or_else(|| RuntimeLevelDbError::Output("CHECKPOINT_MACHINE_ROOT".into()))?;
        let root_hash = root
            .get("rootHash")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeLevelDbError::Output("CHECKPOINT_MACHINE_ROOT_HASH".into()))
            .and_then(parse_digest)?;
        let leaf_count = root
            .get("leafCount")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| RuntimeLevelDbError::Output("CHECKPOINT_MACHINE_LEAF_COUNT".into()))?;

        let machine_prefix = [0x16];
        let runtime_machine_leaves = self
            .prefixed_rows(&machine_prefix)?
            .into_iter()
            .map(|(key, value)| {
                if key.len() <= machine_prefix.len() {
                    return Err(RuntimeLevelDbError::Output(
                        "CHECKPOINT_MACHINE_LEAF_KEY".into(),
                    ));
                }
                Ok((key[machine_prefix.len()..].to_vec(), value))
            })
            .collect::<Result<Vec<_>, _>>()?;

        // The disposable current DB owns the materialized TS Entity/Account
        // graph. The synced WAL owns the Rust Account checkpoint (0x17-0x19)
        // and exact EntityReplica envelope (0x26) in the same authoritative
        // frame batch. Join those disjoint path families here; copying either
        // into the other DB would create a second source of truth solely for
        // import. Duplicate keys are accepted only when their decoded bytes
        // are identical.
        let rows = state_reader.checkpoint_state_rows()?;
        let wal_rows = self.checkpoint_wal_owned_rows()?;
        let mut state_rows = BTreeMap::new();
        for (key, owner) in rows {
            let value = if dedicated_field_row(&key) {
                owner
            } else {
                state_reader.bounded_bytes_from_owner(&key, owner)?
            };
            state_rows.insert(key, value);
        }
        for (key, owner) in wal_rows {
            let value = self.bounded_bytes_from_owner(&key, owner)?;
            if let Some(previous) = state_rows.insert(key.clone(), value.clone())
                && previous != value
            {
                return Err(RuntimeLevelDbError::Output(format!(
                    "CHECKPOINT_STATE_SOURCE_DIVERGED:{}",
                    hex(&key),
                )));
            }
        }
        let source = ConcreteCheckpointSource {
            height,
            frame_bytes,
            root_hash,
            leaf_count,
            runtime_machine_leaves,
            state_rows,
        };
        verify_checkpoint_source(&source)?;
        Ok(source)
    }

    /// Read one exact canonical TypeScript WAL frame together with the flat
    /// outbox bytes and every authenticated Entity context it references.
    /// Extra 0x14 rows are rejected: replay must see the same closed context
    /// set that the Runtime frame committed, never whichever rows happen to be
    /// present beside it in LevelDB.
    pub fn concrete_wal_source(
        &mut self,
        height: u64,
    ) -> Result<ConcreteWalSource, RuntimeLevelDbError> {
        let raw = self.raw_concrete_wal_rows(height)?;
        concrete_wal_source_from_raw(raw)
    }

    /// Every LevelDB row one Runtime WAL frame needs, read without any parse,
    /// hash or digest work. `concrete_wal_source_from_raw` runs the exact
    /// verification `concrete_wal_source` always ran, so a caller may move
    /// that CPU-heavy half onto a decode thread while this reader stays on
    /// its own thread.
    pub fn raw_concrete_wal_rows(
        &mut self,
        height: u64,
    ) -> Result<RawConcreteWalRows, RuntimeLevelDbError> {
        let frame_bytes = self.required_bounded_bytes(&frame_key(height))?;
        let context_prefix = crate::storage::native::entity_context_height_prefix(height)
            .map_err(|error| RuntimeLevelDbError::Output(format!("CONTEXT_PREFIX:{error:?}")))?;
        let context_rows = self.prefixed_rows(&context_prefix)?;
        let mut output_prefix = [0_u8; 9];
        output_prefix[0] = KEY_RUNTIME_OUTPUT_ROW;
        output_prefix[1..9].copy_from_slice(&height.to_be_bytes());
        let mut output_rows = Vec::new();
        for (index, (key, value)) in self.prefixed_rows(&output_prefix)?.into_iter().enumerate() {
            let expected_index = u32::try_from(index)
                .map_err(|_| RuntimeLevelDbError::Output(format!("OUTPUT_INDEX:{index}")))?;
            if key.len() != 13 || key[9..13] != expected_index.to_be_bytes() {
                return Err(RuntimeLevelDbError::Output(format!(
                    "OUTPUT_ROW_ORDER:{height}:{index}"
                )));
            }
            // An output row of 10 KB or more is a bounded-value manifest whose
            // payload lives in 0x11 chunk rows outside this prefix; the outbox
            // digest binds the payload bytes, never the manifest.
            output_rows.push(self.bounded_bytes_from_owner(&key, value)?);
        }
        Ok(RawConcreteWalRows {
            height,
            frame_bytes,
            context_rows,
            output_rows,
        })
    }

    /// Read one complete canonical TypeScript checkpoint into the exact native
    /// import value. No state digest or transport row is re-created: the
    /// original RuntimeFrame, flat outbox, 0x14 contexts, permanent path rows
    /// and 0x16 leaves are all preserved byte-for-byte and revalidated by
    /// `NativeRuntimeStore::import_checkpoint` before its one synced write.
    pub fn native_checkpoint_import_frame(
        &mut self,
        state_reader: &mut RuntimeWalReader,
        height: u64,
    ) -> Result<RuntimeFrameCommit, RuntimeLevelDbError> {
        let source = self.concrete_checkpoint_source(state_reader, height)?;
        self.native_checkpoint_import_from_source(source)
    }

    /// Import the exact frozen common-bootstrap graph carried by an offline
    /// parity artifact. The caller already decoded the same
    /// `ConcreteCheckpointSource`; this avoids re-reading mutable live rows.
    pub fn native_checkpoint_import_from_source(
        &mut self,
        source: ConcreteCheckpointSource,
    ) -> Result<RuntimeFrameCommit, RuntimeLevelDbError> {
        let height = source.height;
        let validated =
            validate_runtime_frame(&source.frame_bytes).map_err(NativeStorageError::FrameCodec)?;
        let state_root = validated
            .canonical_state_hash
            .ok_or_else(|| RuntimeLevelDbError::Output("CHECKPOINT_CANONICAL_STATE_ROOT".into()))?;
        let outputs = self.runtime_output_bytes(
            height,
            validated.output_count,
            &format!("0x{}", hex(&validated.output_digest)),
        )?;
        let entity_contexts = self.native_entity_context_rows(height)?;
        let node_changes = source
            .state_rows
            .into_iter()
            .map(|(key, value)| {
                Ok(PathNodeChange {
                    key: PathNodeKey::new(key)?,
                    value: Some(value),
                })
            })
            .collect::<Result<Vec<_>, NativeStorageError>>()?;
        let runtime_machine_leaves = source
            .runtime_machine_leaves
            .into_iter()
            .map(|(path_bytes, value_bytes)| RuntimeMachineLeafRow {
                path_bytes,
                value_bytes,
            })
            .collect();
        Ok(RuntimeFrameCommit {
            height,
            frame_bytes: source.frame_bytes,
            outputs,
            entity_contexts,
            checkpoint: Some(CheckpointGraph {
                state_root,
                full: true,
                node_changes,
                runtime_machine_leaves,
            }),
        })
    }

    fn native_entity_context_rows(
        &mut self,
        height: u64,
    ) -> Result<EntityContextPayloadRows, RuntimeLevelDbError> {
        let prefix =
            entity_context_height_prefix(height).map_err(NativeStorageError::EntityContext)?;
        let rows = self.prefixed_rows(&prefix)?;
        entity_context_rows_from_raw(height, &rows)
    }

    fn prefixed_rows(&mut self, prefix: &[u8]) -> Result<Vec<RawDatabaseRow>, RuntimeLevelDbError> {
        let mut iterator = self
            .database
            .new_iter()
            .map_err(|error| RuntimeLevelDbError::Iterator(error.to_string()))?;
        iterator.seek(prefix);
        let mut rows = Vec::new();
        while let Some((key, value)) = iterator.current() {
            if !key.starts_with(prefix) {
                break;
            }
            rows.push((key.to_vec(), value.to_vec()));
            if !iterator.advance() {
                break;
            }
        }
        Ok(rows)
    }

    fn checkpoint_state_rows(&mut self) -> Result<Vec<RawDatabaseRow>, RuntimeLevelDbError> {
        let mut iterator = self
            .database
            .new_iter()
            .map_err(|error| RuntimeLevelDbError::Iterator(error.to_string()))?;
        iterator.seek(&[0x17]);
        let mut rows = Vec::new();
        let mut owners = std::collections::BTreeSet::new();
        while let Some((key, value)) = iterator.current() {
            let Some(tag) = key.first().copied() else {
                return Err(RuntimeLevelDbError::Output(
                    "CHECKPOINT_STATE_KEY_EMPTY".into(),
                ));
            };
            if tag > 0x38 {
                break;
            }
            if checkpoint_state_tag(tag) {
                validate_checkpoint_state_key(&key)?;
                let owner = key
                    .get(1..33)
                    .and_then(|value| <[u8; 32]>::try_from(value).ok())
                    .ok_or_else(|| RuntimeLevelDbError::Output("CHECKPOINT_STATE_OWNER".into()))?;
                owners.insert(owner);
                rows.push((key.to_vec(), value.to_vec()));
            } else if !checkpoint_non_state_tag(tag) {
                return Err(RuntimeLevelDbError::Output(format!(
                    "CHECKPOINT_STATE_TAG_NONCANONICAL:{tag:#04x}",
                )));
            }
            if !iterator.advance() {
                break;
            }
        }
        if owners.len() != 1 {
            return Err(RuntimeLevelDbError::Output(format!(
                "CHECKPOINT_STATE_OWNER_COUNT:{}",
                owners.len(),
            )));
        }
        Ok(rows)
    }

    fn checkpoint_wal_owned_rows(&mut self) -> Result<Vec<RawDatabaseRow>, RuntimeLevelDbError> {
        let mut rows = Vec::new();
        for tag in [0x17_u8, 0x18, 0x19, 0x26] {
            for (key, value) in self.prefixed_rows(&[tag])? {
                validate_checkpoint_state_key(&key)?;
                rows.push((key, value));
            }
        }
        Ok(rows)
    }

    fn required_decoded(&mut self, key: &[u8]) -> Result<Value, RuntimeLevelDbError> {
        let bytes = self.required_raw(key)?;
        decode_storage_payload(&bytes).map_err(Into::into)
    }

    fn required_bounded_bytes(&mut self, key: &[u8]) -> Result<Vec<u8>, RuntimeLevelDbError> {
        let owner = self.required_raw(key)?;
        self.bounded_bytes_from_owner(key, owner)
    }

    fn bounded_bytes_from_owner(
        &mut self,
        key: &[u8],
        owner: Vec<u8>,
    ) -> Result<Vec<u8>, RuntimeLevelDbError> {
        // A chunk manifest is a five-field object of short scalars, far under
        // this bound by construction. A row larger than it is the payload
        // itself, so decoding it here only to have `bounded_manifest` answer
        // None again is a full second msgpack pass over every stored frame.
        const MAX_MANIFEST_BYTES: usize = 4096;
        if owner.len() > MAX_MANIFEST_BYTES {
            return Ok(owner);
        }
        let decoded = decode_storage_payload(&owner)?;
        let Some(manifest) = bounded_manifest(&decoded)? else {
            return Ok(owner);
        };
        self.read_chunks(key, &manifest)
    }

    fn required_bounded(&mut self, key: &[u8]) -> Result<Value, RuntimeLevelDbError> {
        decode_storage_payload(&self.required_bounded_bytes(key)?).map_err(Into::into)
    }

    fn required_raw(&mut self, key: &[u8]) -> Result<Vec<u8>, RuntimeLevelDbError> {
        self.database
            .get(key)
            .map(|value| value.to_vec())
            .ok_or_else(|| RuntimeLevelDbError::Missing(hex(key)))
    }

    fn read_chunks(
        &mut self,
        owner_key: &[u8],
        manifest: &BoundedManifest,
    ) -> Result<Vec<u8>, RuntimeLevelDbError> {
        let mut bytes = Vec::with_capacity(manifest.byte_length);
        for index in 0..manifest.chunk_count {
            let key = chunk_key(owner_key, index)?;
            let chunk = self.required_raw(&key)?;
            let expected = (manifest.byte_length - bytes.len()).min(CHUNK_BYTES);
            if chunk.len() != expected {
                return Err(RuntimeLevelDbError::Chunk(format!(
                    "index={index}:expected={expected}:actual={}",
                    chunk.len()
                )));
            }
            bytes.extend(chunk);
        }
        verify_digest(&bytes, &manifest.digest).map_err(|error| match error {
            RuntimeLevelDbError::Digest { expected, actual } => RuntimeLevelDbError::Digest {
                expected,
                actual: format!(
                    "{actual}:owner={}:chunks={}:bytes={}",
                    hex(owner_key),
                    manifest.chunk_count,
                    manifest.byte_length
                ),
            },
            other => other,
        })?;
        Ok(bytes)
    }
}

const CHECKPOINT_STATE_TAGS: &[u8] = &[
    0x17, 0x18, 0x19, 0x21, 0x22, 0x23, 0x24, 0x26, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x36,
    0x37, 0x38,
];

fn checkpoint_state_tag(tag: u8) -> bool {
    CHECKPOINT_STATE_TAGS.contains(&tag)
}

fn checkpoint_non_state_tag(tag: u8) -> bool {
    // 0x20 is HEAD. 0x31-0x35 are height-scoped historical snapshot rows;
    // neither belongs to the permanent live checkpoint graph.
    tag == 0x20 || (0x31..=0x35).contains(&tag)
}

fn validate_checkpoint_state_key(key: &[u8]) -> Result<(), RuntimeLevelDbError> {
    if crate::storage::native::valid_path_key(key) {
        Ok(())
    } else {
        Err(RuntimeLevelDbError::Output(format!(
            "CHECKPOINT_STATE_KEY_NONCANONICAL:{}",
            hex(key),
        )))
    }
}

fn dedicated_field_row(key: &[u8]) -> bool {
    matches!(key.first(), Some(0x24 | 0x36))
}

/// Every LevelDB row one Runtime WAL frame needs, still raw bytes. Produced
/// by `RuntimeWalReader::raw_concrete_wal_rows`; consumed (and fully
/// verified) by `concrete_wal_source_from_raw`, possibly on another thread.
pub struct RawConcreteWalRows {
    height: u64,
    frame_bytes: Vec<u8>,
    context_rows: Vec<RawDatabaseRow>,
    output_rows: Vec<Vec<u8>>,
}

impl RawConcreteWalRows {
    pub fn height(&self) -> u64 {
        self.height
    }

    /// Raw flat-outbox payloads in row order, without frame verification.
    /// Only for reads that are configuration, not an execution oracle (route
    /// discovery); every replayed frame is still fully verified by
    /// `concrete_wal_source_from_raw` before it is applied.
    pub fn output_rows(&self) -> &[Vec<u8>] {
        &self.output_rows
    }
}

fn entity_context_rows_from_raw(
    height: u64,
    rows: &[RawDatabaseRow],
) -> Result<EntityContextPayloadRows, RuntimeLevelDbError> {
    let rows = rows
        .iter()
        .map(|(key, value)| {
            let (row_height, replica_id, kind, index) =
                parse_entity_context_payload_key(key).map_err(NativeStorageError::EntityContext)?;
            if row_height != height {
                return Err(NativeStorageError::EntityContext(
                    crate::storage::native::EntityContextPayloadError::Key,
                ));
            }
            EntityContextPayloadRow::new(replica_id, kind, index, value.clone())
                .map_err(NativeStorageError::EntityContext)
        })
        .collect::<Result<Vec<_>, NativeStorageError>>()?;
    EntityContextPayloadRows::validate(rows)
        .map_err(NativeStorageError::EntityContext)
        .map_err(Into::into)
}

/// The exact verification `concrete_wal_source` has always run — frame
/// parse+hash validation, context set equality, digest-verified context
/// assembly and the outbox digest fold — over rows already read from
/// LevelDB. Pure CPU: safe to run on a decode thread.
pub fn concrete_wal_source_from_raw(
    raw: RawConcreteWalRows,
) -> Result<ConcreteWalSource, RuntimeLevelDbError> {
    let RawConcreteWalRows {
        height,
        frame_bytes,
        context_rows,
        output_rows,
    } = raw;
    let verified = VerifiedWalFrame::new(height, frame_bytes)?;
    let expected_contexts = verified.context_refs().clone();

    let stored_contexts = entity_context_rows_from_raw(height, &context_rows)?;
    let stored_refs = stored_contexts
        .frame_refs()
        .iter()
        .cloned()
        .collect::<BTreeMap<_, _>>();
    if stored_refs != expected_contexts {
        return Err(RuntimeLevelDbError::Output(format!(
            "WAL_CONTEXT_SET:expected={:?}:actual={:?}",
            expected_contexts.keys().collect::<Vec<_>>(),
            stored_refs.keys().collect::<Vec<_>>(),
        )));
    }

    let row_map = context_rows.into_iter().collect::<BTreeMap<_, _>>();
    let mut fetch = |key: &[u8]| Ok(row_map.get(key).cloned());
    let mut entity_contexts = BTreeMap::new();
    for (replica_id, commitment) in expected_contexts {
        let value = entity_context_full_with(&mut fetch, height, &replica_id, &commitment)?;
        entity_contexts.insert(replica_id, VerifiedEntityContext { commitment, value });
    }
    let outputs = runtime_output::verified_output_bytes(
        verified.validated().output_count,
        &format!("0x{}", hex(&verified.validated().output_digest)),
        output_rows,
    )?;
    verified
        .into_source(entity_contexts, outputs)
        .map_err(Into::into)
}

/// Exact-key row fetch backing context assembly. The reader passes a live
/// LevelDB get; the off-thread decoder passes a lookup into rows it already
/// holds, so the same digest-verified assembly runs on either side.
pub(crate) type ContextRowFetch<'a> =
    dyn FnMut(&[u8]) -> Result<Option<Vec<u8>>, RuntimeLevelDbError> + 'a;

pub(crate) fn entity_context_with(
    fetch: &mut ContextRowFetch<'_>,
    runtime_height: u64,
    replica_id: &str,
    digest: &[u8; 32],
) -> Result<Value, RuntimeLevelDbError> {
    entity_context_payload_with(
        fetch,
        runtime_height,
        replica_id,
        ENTITY_CONTEXT_MANIFEST,
        0,
        digest,
    )
}

pub(crate) fn entity_context_full_with(
    fetch: &mut ContextRowFetch<'_>,
    runtime_height: u64,
    replica_id: &str,
    digest: &[u8; 32],
) -> Result<Value, RuntimeLevelDbError> {
    let manifest = entity_context_with(fetch, runtime_height, replica_id, digest)?;
    require_kind(&manifest, "entityContext")?;
    let mut context = object_field(&manifest, "header")?.clone();
    let profiles = entity_context_children_with(
        fetch,
        runtime_height,
        replica_id,
        &manifest,
        "profilePageDigests",
        "gossipProfile",
    )?;
    let assertion_pages = entity_context_children_with(
        fetch,
        runtime_height,
        replica_id,
        &manifest,
        "peerAssertionPageDigests",
        "peerAssertions",
    )?;
    let mut assertions = Vec::new();
    for page in assertion_pages {
        let rows = page
            .as_object()
            .and_then(|object| object.get("assertions"))
            .and_then(Value::as_array)
            .ok_or_else(|| RuntimeLevelDbError::Output("CONTEXT_PEER_ASSERTIONS".into()))?;
        assertions.extend(rows.iter().cloned());
    }
    let entries = entity_context_children_with(
        fetch,
        runtime_height,
        replica_id,
        &manifest,
        "htlcEntryPageDigests",
        "htlcEntry",
    )?;
    let originated = entity_context_children_with(
        fetch,
        runtime_height,
        replica_id,
        &manifest,
        "htlcOriginatedPageDigests",
        "htlcOriginated",
    )?;
    context.insert(
        "gossipProfiles".into(),
        Value::Array(extract_child_values(profiles, "profile")?),
    );
    context.insert("peerAssertions".into(), Value::Array(assertions));
    context.insert(
        "htlc".into(),
        Value::Object(serde_json::Map::from_iter([
            ("version".into(), Value::Number(1_u64.into())),
            (
                "entries".into(),
                Value::Array(extract_child_values(entries, "entry")?),
            ),
            (
                "originated".into(),
                Value::Array(extract_child_values(originated, "originated")?),
            ),
        ])),
    );
    Ok(Value::Object(context))
}

fn entity_context_payload_with(
    fetch: &mut ContextRowFetch<'_>,
    runtime_height: u64,
    replica_id: &str,
    path_kind: u8,
    index: u32,
    expected_digest: &[u8; 32],
) -> Result<Value, RuntimeLevelDbError> {
    let key = entity_context_key(runtime_height, replica_id, path_kind, index)?;
    let bytes = fetch(&key)?.ok_or_else(|| RuntimeLevelDbError::Missing(hex(&key)))?;
    if bytes.len() >= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES {
        return Err(RuntimeLevelDbError::Output(format!(
            "CONTEXT_TOO_LARGE:{}",
            bytes.len()
        )));
    }
    verify_hash(&bytes, expected_digest).map_err(|error| match error {
        RuntimeLevelDbError::Digest { expected, actual } => RuntimeLevelDbError::Digest {
            expected,
            actual: format!("{actual}:context={replica_id}:kind={path_kind}:index={index}"),
        },
        other => other,
    })?;
    decode_storage_payload(&bytes).map_err(Into::into)
}

fn entity_context_children_with(
    fetch: &mut ContextRowFetch<'_>,
    runtime_height: u64,
    replica_id: &str,
    manifest: &Value,
    field_name: &str,
    child_kind: &str,
) -> Result<Vec<Value>, RuntimeLevelDbError> {
    let pages = digest_array_field(manifest, field_name)?;
    let (page_path_kind, child_path_kind) = entity_context_path_kinds(child_kind)?;
    let mut children = Vec::new();
    for (page_index, page_digest) in pages.into_iter().enumerate() {
        let page = entity_context_payload_with(
            fetch,
            runtime_height,
            replica_id,
            page_path_kind,
            u32::try_from(page_index)
                .map_err(|_| RuntimeLevelDbError::Output("CONTEXT_PAGE_INDEX".into()))?,
            &page_digest,
        )?;
        require_kind(&page, "digestPage")?;
        if string_field(&page, "childKind")? != child_kind {
            return Err(RuntimeLevelDbError::Output(format!(
                "CONTEXT_REFERENCE_KIND:expected={child_kind}"
            )));
        }
        for child_digest in digest_array_field(&page, "digests")? {
            let child_index = u32::try_from(children.len())
                .map_err(|_| RuntimeLevelDbError::Output("CONTEXT_CHILD_INDEX".into()))?;
            let child = entity_context_payload_with(
                fetch,
                runtime_height,
                replica_id,
                child_path_kind,
                child_index,
                &child_digest,
            )?;
            require_kind(&child, child_kind)?;
            children.push(child);
        }
    }
    Ok(children)
}

fn entity_context_key(
    runtime_height: u64,
    replica_id: &str,
    path_kind: u8,
    index: u32,
) -> Result<Vec<u8>, RuntimeLevelDbError> {
    if runtime_height == 0 {
        return Err(RuntimeLevelDbError::Output(
            "CONTEXT_RUNTIME_HEIGHT:0".into(),
        ));
    }
    if !valid_replica_id(replica_id) {
        return Err(RuntimeLevelDbError::Output(format!(
            "CONTEXT_REPLICA_ID:{replica_id}"
        )));
    }
    if path_kind > ENTITY_CONTEXT_PEER_ASSERTION_DIGESTS {
        return Err(RuntimeLevelDbError::Output(format!(
            "CONTEXT_PATH_KIND:{path_kind}"
        )));
    }
    let replica_bytes = replica_id.as_bytes();
    let replica_length = u16::try_from(replica_bytes.len())
        .map_err(|_| RuntimeLevelDbError::Output("CONTEXT_REPLICA_ID_LENGTH".into()))?;
    let mut key = Vec::with_capacity(1 + 8 + 2 + replica_bytes.len() + 1 + 4);
    key.push(KEY_ENTITY_CONTEXT_PAYLOAD);
    key.extend_from_slice(&runtime_height.to_be_bytes());
    key.extend_from_slice(&replica_length.to_be_bytes());
    key.extend_from_slice(replica_bytes);
    key.push(path_kind);
    key.extend_from_slice(&index.to_be_bytes());
    Ok(key)
}

fn valid_replica_id(value: &str) -> bool {
    let mut parts = value.split(':');
    let entity = parts.next();
    let signer = parts.next();
    let generation = parts.next();
    if parts.next().is_some()
        || !entity.is_some_and(|part| lower_hex_id(part, 64))
        || !signer.is_some_and(|part| lower_hex_id(part, 40))
    {
        return false;
    }
    match generation {
        None => true,
        Some(part) => {
            !part.is_empty()
                && !part.starts_with('0')
                && part.bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

fn lower_hex_id(value: &str, digits: usize) -> bool {
    value.len() == digits + 2
        && value.starts_with("0x")
        && value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn entity_context_path_kinds(child_kind: &str) -> Result<(u8, u8), RuntimeLevelDbError> {
    match child_kind {
        "gossipProfile" => Ok((
            ENTITY_CONTEXT_GOSSIP_PROFILE_DIGESTS,
            ENTITY_CONTEXT_GOSSIP_PROFILE,
        )),
        "htlcEntry" => Ok((ENTITY_CONTEXT_HTLC_ENTRY_DIGESTS, ENTITY_CONTEXT_HTLC_ENTRY)),
        "htlcOriginated" => Ok((
            ENTITY_CONTEXT_HTLC_ORIGINATED_DIGESTS,
            ENTITY_CONTEXT_HTLC_ORIGINATED,
        )),
        "peerAssertions" => Ok((
            ENTITY_CONTEXT_PEER_ASSERTION_DIGESTS,
            ENTITY_CONTEXT_PEER_ASSERTIONS,
        )),
        _ => Err(RuntimeLevelDbError::Output(format!(
            "CONTEXT_CHILD_KIND:{child_kind}"
        ))),
    }
}

fn object_field<'a>(
    value: &'a Value,
    name: &str,
) -> Result<&'a serde_json::Map<String, Value>, RuntimeLevelDbError> {
    value
        .as_object()
        .and_then(|object| object.get(name))
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeLevelDbError::Output(format!("OBJECT_FIELD:{name}")))
}

fn extract_child_values(
    children: Vec<Value>,
    name: &str,
) -> Result<Vec<Value>, RuntimeLevelDbError> {
    children
        .into_iter()
        .map(|mut child| {
            child
                .as_object_mut()
                .and_then(|object| object.remove(name))
                .ok_or_else(|| RuntimeLevelDbError::Output(format!("CONTEXT_CHILD:{name}")))
        })
        .collect()
}

fn string_field<'a>(value: &'a Value, name: &str) -> Result<&'a str, RuntimeLevelDbError> {
    value
        .as_object()
        .and_then(|object| object.get(name))
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeLevelDbError::Output(format!("STRING_FIELD:{name}")))
}

fn require_kind(value: &Value, kind: &str) -> Result<(), RuntimeLevelDbError> {
    if string_field(value, "kind")? != kind {
        return Err(RuntimeLevelDbError::Output(format!("KIND:{kind}")));
    }
    if value
        .as_object()
        .and_then(|object| object.get("version"))
        .and_then(Value::as_u64)
        != Some(2)
    {
        return Err(RuntimeLevelDbError::Output(format!("VERSION:{kind}")));
    }
    Ok(())
}

fn digest_array_field(value: &Value, name: &str) -> Result<Vec<[u8; 32]>, RuntimeLevelDbError> {
    value
        .as_object()
        .and_then(|object| object.get(name))
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimeLevelDbError::Output(format!("DIGEST_ARRAY:{name}")))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| RuntimeLevelDbError::Output(format!("DIGEST_TYPE:{name}")))
                .and_then(parse_digest)
        })
        .collect()
}

fn parse_digest(value: &str) -> Result<[u8; 32], RuntimeLevelDbError> {
    let value = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 64)
        .ok_or_else(|| RuntimeLevelDbError::Output("DIGEST".into()))?;
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| RuntimeLevelDbError::Output("DIGEST".into()))?;
    }
    Ok(digest)
}

fn verify_hash(bytes: &[u8], expected: &[u8; 32]) -> Result<(), RuntimeLevelDbError> {
    let actual: [u8; 32] = Sha256::digest(bytes).into();
    if &actual == expected {
        Ok(())
    } else {
        Err(RuntimeLevelDbError::Digest {
            expected: format!("0x{}", hex(expected)),
            actual: format!("0x{}", hex(&actual)),
        })
    }
}

struct BoundedManifest {
    byte_length: usize,
    chunk_count: u32,
    digest: String,
}

fn bounded_manifest(value: &Value) -> Result<Option<BoundedManifest>, RuntimeLevelDbError> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if object.get("kind").and_then(Value::as_str) != Some("boundedValue") {
        return Ok(None);
    }
    let version = object.get("version").and_then(Value::as_u64);
    let byte_length = object.get("byteLength").and_then(Value::as_u64);
    let chunk_count = object.get("chunkCount").and_then(Value::as_u64);
    let digest = object.get("digest").and_then(Value::as_str);
    if version != Some(1) {
        return Err(RuntimeLevelDbError::Manifest("VERSION".into()));
    }
    let byte_length = usize::try_from(
        byte_length.ok_or_else(|| RuntimeLevelDbError::Manifest("BYTE_LENGTH".into()))?,
    )
    .map_err(|_| RuntimeLevelDbError::Manifest("BYTE_LENGTH".into()))?;
    let chunk_count = u32::try_from(
        chunk_count.ok_or_else(|| RuntimeLevelDbError::Manifest("CHUNK_COUNT".into()))?,
    )
    .map_err(|_| RuntimeLevelDbError::Manifest("CHUNK_COUNT".into()))?;
    let expected = byte_length.div_ceil(CHUNK_BYTES);
    if expected != chunk_count as usize {
        return Err(RuntimeLevelDbError::Manifest("CHUNK_COUNT_MISMATCH".into()));
    }
    Ok(Some(BoundedManifest {
        byte_length,
        chunk_count,
        digest: digest
            .ok_or_else(|| RuntimeLevelDbError::Manifest("DIGEST".into()))?
            .to_ascii_lowercase(),
    }))
}

fn frame_key(height: u64) -> [u8; 9] {
    let mut key = [0_u8; 9];
    key[0] = KEY_FRAME;
    key[1..].copy_from_slice(&height.to_be_bytes());
    key
}

fn chunk_key(owner: &[u8], index: u32) -> Result<Vec<u8>, RuntimeLevelDbError> {
    let length = u16::try_from(owner.len())
        .map_err(|_| RuntimeLevelDbError::Manifest("OWNER_KEY_LENGTH".into()))?;
    let mut key = Vec::with_capacity(3 + owner.len() + 4);
    key.push(KEY_BOUNDED_VALUE_CHUNK);
    key.extend_from_slice(&length.to_be_bytes());
    key.extend_from_slice(owner);
    key.extend_from_slice(&index.to_be_bytes());
    Ok(key)
}

fn verify_digest(bytes: &[u8], expected: &str) -> Result<(), RuntimeLevelDbError> {
    let actual = format!("0x{}", hex(&Sha256::digest(bytes)));
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeLevelDbError::Digest {
            expected: expected.to_string(),
            actual,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use xln_rscore_protocol::{CanonicalValue, PersistentRadixMap};

    static TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    const ENTITY: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const SIGNER: &str = "0x2222222222222222222222222222222222222222";

    #[derive(Clone, Copy)]
    enum WalCorruption {
        None,
        MissingContextPage,
        WrongOutboxDigest,
        /// One outbox row of 10 KB or more: a bounded-value manifest plus 0x11 chunk rows, exactly as TS writes it.
        BoundedOutputRow,
        ForeignContext,
    }

    fn temporary_path(label: &str) -> std::path::PathBuf {
        let serial = TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "xln-rscore-reader-{label}-{}-{serial}",
            std::process::id(),
        ))
    }

    fn checkpoint_reader(
        extra_state_key: Option<Vec<u8>>,
    ) -> (
        RuntimeWalReader,
        RuntimeWalReader,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let wal_path = temporary_path("checkpoint-wal-source");
        let state_path = temporary_path("checkpoint-state-source");
        for path in [&wal_path, &state_path] {
            if path.exists() {
                std::fs::remove_dir_all(path).expect("clean fixture path");
            }
        }
        let mut wal_database = DB::open(
            &wal_path,
            Options {
                create_if_missing: true,
                ..Options::default()
            },
        )
        .expect("fixture WAL db");
        let mut state_database = DB::open(
            &state_path,
            Options {
                create_if_missing: true,
                ..Options::default()
            },
        )
        .expect("fixture state db");
        let leaf_key =
            crate::encode_storage_payload(&CanonicalValue::Array(Vec::new())).expect("machine key");
        let leaf_value = crate::encode_storage_payload(&CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String("container".into())),
            ("container".into(), CanonicalValue::String("object".into())),
        ]))
        .expect("machine value");
        let decoded = decode_storage_payload(&leaf_value).expect("machine decode");
        let radix = PersistentRadixMap::empty()
            .updated(
                leaf_key.clone(),
                decoded,
                Sha256::digest(&leaf_value).into(),
            )
            .expect("machine radix");
        let owner = [0x11; 32];
        let frame = crate::storage::native::build_runtime_frame_commit(
            crate::storage::native::CanonicalRuntimeFrameDraft {
                height: 100,
                timestamp: 1_000,
                prev_frame_hash: [0; 32],
                replica_meta_digest: [1; 32],
                runtime_component_digests: vec![],
                materialized_state: true,
                canonical_state: Some(crate::storage::native::CanonicalStateCommitment {
                    state_hash: [2; 32],
                    entity_hashes: vec![crate::storage::native::RuntimeFrameEntityHash {
                        entity_id: format!("0x{}", "11".repeat(32)),
                        hash: [3; 32],
                        cell_count: 1,
                    }],
                }),
                runtime_input: serde_json::json!({"runtimeTxs": [], "entityInputs": []}),
                runtime_machine_root: Some(crate::storage::native::RuntimeMachineGraphRoot {
                    root_hash: radix.root_hash(),
                    leaf_count: 1,
                }),
                account_authority_checkpoints: vec![],
                touched_entities: vec![],
                touched_accounts: vec![],
                touched_book_entities: vec![],
            },
            crate::storage::native::EntityContextPayloadRows::empty(),
            vec![],
            Some(crate::storage::native::CheckpointGraph {
                state_root: [2; 32],
                full: false,
                node_changes: Vec::new(),
                runtime_machine_leaves: vec![crate::storage::native::RuntimeMachineLeafRow {
                    path_bytes: leaf_key.clone(),
                    value_bytes: leaf_value.clone(),
                }],
            }),
        )
        .expect("checkpoint frame")
        .commit
        .frame_bytes;
        wal_database
            .put(&frame_key(100), &frame)
            .expect("frame row");
        wal_database
            .put(KEY_HEAD, &head_bytes(100, 100, 100))
            .expect("HEAD row");
        wal_database
            .put(&[vec![0x16], leaf_key].concat(), &leaf_value)
            .expect("machine leaf");
        wal_database
            .put(
                &[vec![0x26], owner.to_vec(), vec![0; 12], vec![0x22; 20]].concat(),
                &crate::encode_storage_payload(&CanonicalValue::Object(Vec::new()))
                    .expect("replica meta value"),
            )
            .expect("WAL-owned replica meta row");
        state_database
            .put(
                &[vec![0x21], owner.to_vec()].concat(),
                &crate::encode_storage_payload(&CanonicalValue::Object(Vec::new()))
                    .expect("state value"),
            )
            .expect("state row");
        if let Some(key) = extra_state_key {
            state_database
                .put(
                    &key,
                    &crate::encode_storage_payload(&CanonicalValue::Object(Vec::new()))
                        .expect("extra state value"),
                )
                .expect("extra state row");
        }
        (
            RuntimeWalReader {
                database: wal_database,
            },
            RuntimeWalReader {
                database: state_database,
            },
            wal_path,
            state_path,
        )
    }

    fn head_bytes(latest: u64, materialized: u64, snapshot: u64) -> Vec<u8> {
        let value = serde_json::json!({
            "schemaVersion": 5,
            "latestHeight": latest,
            "latestMaterializedHeight": materialized,
            "latestSnapshotHeight": snapshot,
            "snapshotPeriodFrames": 10_000,
            "retainSnapshots": 9_007_199_254_740_991_u64,
            "epochMaxBytes": 9_007_199_254_740_991_u64,
            "accountMerkleRadix": 16,
            "epochReplayBytes": 0,
            "retainedWalBytes": 0,
        });
        let canonical = crate::canonical_value_from_tagged_json(&value).expect("canonical HEAD");
        crate::encode_storage_payload(&canonical).expect("encoded HEAD")
    }

    fn replay_context_rows(entity: &str, signer: &str, profile: bool) -> EntityContextPayloadRows {
        let replica_id = format!("{entity}:{signer}");
        let context = serde_json::json!({
            "version": 1,
            "proposerReplicaId": replica_id,
            "entityId": entity,
            "proposerSignerId": signer,
            "parentFrameHash": "genesis",
            "height": 1,
            "gossipProfiles": if profile { vec![serde_json::json!({"name":"peer"})] } else { vec![] },
            "peerAssertions": [],
            "htlc": {"version":1,"entries":[],"originated":[]},
        });
        let canonical = crate::canonical_value_from_tagged_json(&context).expect("context value");
        crate::processor::prepare_entity_context_rows(&replica_id, &canonical)
            .expect("context rows")
    }

    fn wal_reader(corruption: WalCorruption) -> (RuntimeWalReader, std::path::PathBuf) {
        let path = temporary_path("wal-source");
        if path.exists() {
            std::fs::remove_dir_all(&path).expect("clean fixture path");
        }
        let mut database = DB::open(
            &path,
            Options {
                create_if_missing: true,
                ..Options::default()
            },
        )
        .expect("fixture db");
        let contexts = replay_context_rows(ENTITY, SIGNER, true);
        let mut output_value = serde_json::json!({
            "entityId": format!("0x{}", "33".repeat(32)),
            "runtimeId": format!("0x{}", "44".repeat(20)),
            "signerId": "peer",
            "entityTxs": [],
            "sourceRuntimeFrame": {"height":7,"timestamp":70},
        });
        if matches!(corruption, WalCorruption::BoundedOutputRow) {
            output_value["pad"] = serde_json::Value::String("x".repeat(2 * CHUNK_BYTES + 123));
        }
        let output = crate::transport::msgpack::encode_framed(&output_value).expect("output");
        let encoded = crate::storage::native::build_runtime_frame_commit(
            crate::storage::native::CanonicalRuntimeFrameDraft {
                height: 7,
                timestamp: 70,
                prev_frame_hash: [0; 32],
                replica_meta_digest: [1; 32],
                runtime_component_digests: vec![],
                materialized_state: false,
                canonical_state: None,
                runtime_input: serde_json::json!({"runtimeTxs":[],"entityInputs":[]}),
                runtime_machine_root: None,
                account_authority_checkpoints: vec![],
                touched_entities: vec![],
                touched_accounts: vec![],
                touched_book_entities: vec![],
            },
            contexts.clone(),
            vec![output.clone()],
            None,
        )
        .expect("runtime frame");
        database
            .put(&frame_key(7), &encoded.commit.frame_bytes)
            .expect("frame row");
        for row in contexts.rows() {
            if matches!(corruption, WalCorruption::MissingContextPage)
                && row.kind()
                    == crate::storage::native::EntityContextPayloadKind::GossipProfileDigests
            {
                continue;
            }
            database
                .put(&row.key(7).expect("context key"), row.value())
                .expect("context row");
        }
        if matches!(corruption, WalCorruption::ForeignContext) {
            let foreign_entity = format!("0x{}", "55".repeat(32));
            let foreign_signer = format!("0x{}", "66".repeat(20));
            for row in replay_context_rows(&foreign_entity, &foreign_signer, false).rows() {
                database
                    .put(&row.key(7).expect("foreign key"), row.value())
                    .expect("foreign row");
            }
        }
        let output = if matches!(corruption, WalCorruption::WrongOutboxDigest) {
            crate::transport::msgpack::encode_framed(&serde_json::json!({"corrupt":true}))
                .expect("corrupt output")
        } else {
            output
        };
        let mut output_key = [0_u8; 13];
        output_key[0] = KEY_RUNTIME_OUTPUT_ROW;
        output_key[1..9].copy_from_slice(&7_u64.to_be_bytes());
        if matches!(corruption, WalCorruption::BoundedOutputRow) {
            assert!(output.len() >= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES);
            let chunk_count = output.len().div_ceil(CHUNK_BYTES);
            let manifest = crate::transport::msgpack::encode_framed(&serde_json::json!({
                "kind": "boundedValue",
                "version": 1,
                "byteLength": output.len(),
                "chunkCount": chunk_count,
                "digest": format!("0x{}", hex(&Sha256::digest(&output))),
            }))
            .expect("manifest");
            database.put(&output_key, &manifest).expect("manifest row");
            for (index, chunk) in output.chunks(CHUNK_BYTES).enumerate() {
                let key = chunk_key(&output_key, u32::try_from(index).expect("chunk index"))
                    .expect("chunk key");
                database.put(&key, chunk).expect("chunk row");
            }
        } else {
            database.put(&output_key, &output).expect("output row");
        }
        (RuntimeWalReader { database }, path)
    }

    #[test]
    fn entity_context_key_is_a_height_replica_kind_index_path() {
        let replica_id = format!("{ENTITY}:{SIGNER}");
        let key =
            entity_context_key(17, &replica_id, ENTITY_CONTEXT_HTLC_ENTRY, 9).expect("valid path");
        assert_eq!(key[0], KEY_ENTITY_CONTEXT_PAYLOAD);
        assert_eq!(&key[1..9], &17_u64.to_be_bytes());
        assert_eq!(
            u16::from_be_bytes([key[9], key[10]]) as usize,
            replica_id.len()
        );
        let suffix = 11 + replica_id.len();
        assert_eq!(&key[11..suffix], replica_id.as_bytes());
        assert_eq!(key[suffix], ENTITY_CONTEXT_HTLC_ENTRY);
        assert_eq!(&key[suffix + 1..], &9_u32.to_be_bytes());
    }

    #[test]
    fn entity_context_key_rejects_noncanonical_owners_and_height_zero() {
        let replica_id = format!("{ENTITY}:{SIGNER}");
        assert!(entity_context_key(0, &replica_id, ENTITY_CONTEXT_MANIFEST, 0).is_err());
        assert!(
            entity_context_key(
                1,
                &replica_id.to_ascii_uppercase(),
                ENTITY_CONTEXT_MANIFEST,
                0,
            )
            .is_err()
        );
    }

    #[test]
    fn concrete_checkpoint_source_reads_exact_machine_and_path_rows() {
        let (mut reader, mut state_reader, wal_path, state_path) = checkpoint_reader(None);
        let source = reader
            .concrete_checkpoint_source(&mut state_reader, 100)
            .expect("exact checkpoint source");
        assert_eq!(source.height, 100);
        assert_eq!(source.runtime_machine_leaves.len(), 1);
        assert_eq!(source.state_rows.len(), 2);
        drop(reader);
        drop(state_reader);
        std::fs::remove_dir_all(wal_path).expect("clean WAL fixture");
        std::fs::remove_dir_all(state_path).expect("clean state fixture");
    }

    #[test]
    fn stable_runtime_machine_rows_are_visible_only_at_the_head_materialized_height() {
        let (mut reader, mut state_reader, wal_path, state_path) = checkpoint_reader(None);
        assert!(
            reader
                .runtime_machine_for_frame(100)
                .expect("current materialized machine")
                .is_some(),
        );

        reader
            .database
            .put(KEY_HEAD, &head_bytes(101, 101, 100))
            .expect("advance materialized pointer");
        assert!(
            reader
                .runtime_machine_for_frame(100)
                .expect("historical frame omits current-only graph")
                .is_none(),
        );
        let error = reader
            .concrete_checkpoint_source(&mut state_reader, 100)
            .expect_err("explicit historical checkpoint source must fail");
        assert_eq!(
            error.to_string(),
            "RUNTIME_LEVELDB_OUTPUT:CHECKPOINT_MACHINE_NOT_CURRENT:requested=100:current=101",
        );

        let no_materialized_pointer = crate::canonical_value_from_tagged_json(
            &serde_json::json!({"latestHeight": 101, "latestSnapshotHeight": 100}),
        )
        .expect("canonical HEAD without materialized pointer");
        let no_materialized_pointer = crate::encode_storage_payload(&no_materialized_pointer)
            .expect("encoded HEAD without materialized pointer");
        reader
            .database
            .put(KEY_HEAD, &no_materialized_pointer)
            .expect("replace HEAD without materialized pointer");
        assert_eq!(
            reader
                .runtime_machine_for_frame(100)
                .expect_err("snapshot pointer must not become a compatibility fallback")
                .to_string(),
            "RUNTIME_LEVELDB_OUTPUT:HEAD_LATEST_MATERIALIZED_HEIGHT",
        );

        drop(reader);
        drop(state_reader);
        std::fs::remove_dir_all(wal_path).expect("clean WAL fixture");
        std::fs::remove_dir_all(state_path).expect("clean state fixture");
    }

    #[test]
    fn canonical_checkpoint_source_imports_as_one_native_durable_head() {
        let (mut reader, mut state_reader, wal_path, state_path) = checkpoint_reader(None);
        let commit = reader
            .native_checkpoint_import_frame(&mut state_reader, 100)
            .expect("exact native import frame");
        let native_path = temporary_path("native-import");
        let mut store = crate::storage::native::NativeRuntimeStore::open(
            &native_path,
            crate::storage::native::NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..crate::storage::native::NativeStorageConfig::default()
            },
        )
        .expect("native store");
        store.import_checkpoint(commit).expect("synced import");
        assert_eq!(store.latest_height(), 100);
        let recovered = store.recover().expect("recover imported source");
        let checkpoint = recovered.checkpoint.expect("checkpoint");
        assert_eq!(checkpoint.height, 100);
        assert_eq!(checkpoint.state_root, [2; 32]);
        assert_eq!(checkpoint.runtime_machine_leaves.len(), 1);
        drop(store);
        drop(reader);
        drop(state_reader);
        std::fs::remove_dir_all(wal_path).expect("clean WAL fixture");
        std::fs::remove_dir_all(state_path).expect("clean state fixture");
        std::fs::remove_dir_all(native_path).expect("clean native fixture");
    }

    #[test]
    fn concrete_wal_source_preserves_exact_frame_context_and_outbox() {
        let (mut reader, path) = wal_reader(WalCorruption::None);
        let source = reader.concrete_wal_source(7).expect("exact WAL source");
        assert_eq!(source.height(), 7);
        assert_eq!(source.entity_contexts().len(), 1);
        assert_eq!(source.outputs().len(), 1);
        drop(reader);
        std::fs::remove_dir_all(path).expect("clean fixture");
    }

    #[test]
    fn concrete_wal_source_reassembles_bounded_outbox_rows() {
        let (mut reader, path) = wal_reader(WalCorruption::BoundedOutputRow);
        let source = reader.concrete_wal_source(7).expect("bounded outbox row reassembled");
        assert_eq!(source.outputs().len(), 1);
        assert!(source.outputs()[0].len() >= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES);
        let raw = reader.raw_concrete_wal_rows(7).expect("raw rows");
        assert_eq!(raw.output_rows()[0], source.outputs()[0]);
        drop(reader);
        std::fs::remove_dir_all(path).expect("clean fixture");
    }

    #[test]
    fn concrete_wal_source_rejects_missing_page_wrong_outbox_and_foreign_context() {
        for (corruption, expected) in [
            (
                WalCorruption::MissingContextPage,
                "RRS_ENTITY_CONTEXT_MISSING",
            ),
            (
                WalCorruption::WrongOutboxDigest,
                "RUNTIME_LEVELDB_BOUNDED_DIGEST",
            ),
            (WalCorruption::ForeignContext, "WAL_CONTEXT_SET"),
        ] {
            let (mut reader, path) = wal_reader(corruption);
            let error = match reader.concrete_wal_source(7) {
                Ok(_) => panic!("corrupt WAL source accepted"),
                Err(error) => error,
            };
            assert!(
                error.to_string().contains(expected),
                "expected {expected}, got {error}"
            );
            drop(reader);
            std::fs::remove_dir_all(path).expect("clean fixture");
        }
    }

    #[test]
    fn concrete_checkpoint_source_rejects_foreign_and_retired_state_paths() {
        let foreign = [vec![0x21], vec![0x99; 32]].concat();
        let (mut reader, mut state_reader, wal_path, state_path) = checkpoint_reader(Some(foreign));
        assert!(
            reader
                .concrete_checkpoint_source(&mut state_reader, 100)
                .expect_err("foreign owner")
                .to_string()
                .contains("CHECKPOINT_STATE_OWNER_COUNT:2")
        );
        drop(reader);
        drop(state_reader);
        std::fs::remove_dir_all(wal_path).expect("clean foreign WAL fixture");
        std::fs::remove_dir_all(state_path).expect("clean foreign state fixture");

        let (mut reader, mut state_reader, wal_path, state_path) =
            checkpoint_reader(Some(vec![0x25, 1]));
        assert!(
            reader
                .concrete_checkpoint_source(&mut state_reader, 100)
                .expect_err("retired hash-addressed namespace")
                .to_string()
                .contains("CHECKPOINT_STATE_TAG_NONCANONICAL:0x25")
        );
        drop(reader);
        drop(state_reader);
        std::fs::remove_dir_all(wal_path).expect("clean retired WAL fixture");
        std::fs::remove_dir_all(state_path).expect("clean retired state fixture");
    }
}
