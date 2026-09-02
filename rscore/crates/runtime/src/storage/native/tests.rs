use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};

use rusty_leveldb::WriteBatch;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalValue, PersistentRadixMap};

use super::keys::runtime_machine_leaf_key;
use super::*;

static TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

fn temporary_path(label: &str) -> std::path::PathBuf {
    let serial = TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "xln-rscore-native-{label}-{}-{serial}",
        std::process::id(),
    ))
}

fn cleanup(path: &std::path::Path) {
    if path.exists() {
        std::fs::remove_dir_all(path).expect("remove isolated test database");
    }
}

#[test]
fn retired_schema_four_head_is_rejected_without_compatibility() {
    let bytes = super::codec::encode_head(&super::types::StorageHead {
        schema_version: 4,
        ..super::types::StorageHead::default()
    })
    .expect("encode retired head fixture");
    assert_eq!(
        super::codec::decode_head(&bytes)
            .expect_err("schema four must be rejected")
            .to_string(),
        "RRS_STORAGE_HEAD:schemaVersion",
    );
}

fn output(value: &str) -> Vec<u8> {
    crate::encode_storage_payload(&CanonicalValue::Object(vec![
        (
            "kind".into(),
            CanonicalValue::String("runtimeOutput".into()),
        ),
        ("value".into(), CanonicalValue::String(value.into())),
    ]))
    .expect("output")
}

fn frame(
    height: u64,
    outputs: Vec<Vec<u8>>,
    mut checkpoint: Option<CheckpointGraph>,
) -> RuntimeFrameCommit {
    let materialized = checkpoint.is_some();
    let (canonical_state, runtime_machine_root) =
        checkpoint.as_mut().map_or((None, None), |checkpoint| {
            if checkpoint.runtime_machine_leaves.is_empty() {
                checkpoint.runtime_machine_leaves = runtime_machine_fixture().1;
            }
            let mut graph = PersistentRadixMap::empty();
            for leaf in &checkpoint.runtime_machine_leaves {
                let value =
                    crate::decode_storage_payload(&leaf.value_bytes).expect("machine value");
                graph = graph
                    .updated(
                        leaf.path_bytes.clone(),
                        value,
                        Sha256::digest(&leaf.value_bytes).into(),
                    )
                    .expect("machine graph");
            }
            (
                Some(CanonicalStateCommitment {
                    state_hash: checkpoint.state_root,
                    entity_hashes: Vec::new(),
                }),
                Some(RuntimeMachineGraphRoot {
                    root_hash: graph.root_hash(),
                    leaf_count: checkpoint.runtime_machine_leaves.len() as u64,
                }),
            )
        });
    build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height,
            timestamp: height,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: vec![],
            materialized_state: materialized,
            canonical_state,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root,
            account_authority_checkpoints: vec![],
            touched_entities: vec![],
            touched_accounts: vec![],
            touched_book_entities: vec![],
        },
        EntityContextPayloadRows::empty(),
        outputs,
        checkpoint,
    )
    .expect("canonical frame")
    .commit
}

fn runtime_machine_fixture() -> (Value, Vec<RuntimeMachineLeafRow>) {
    let path = json!([]);
    let value = json!({"kind":"container","container":"object"});
    (json!({}), vec![runtime_machine_leaf(path, value)])
}

fn runtime_machine_leaf(path: Value, value: Value) -> RuntimeMachineLeafRow {
    RuntimeMachineLeafRow {
        path_bytes: crate::transport::msgpack::encode_framed(&path).expect("machine path"),
        value_bytes: crate::transport::msgpack::encode_framed(&value).expect("machine value"),
    }
}

fn canonical_only_frame(height: u64, state_root: [u8; 32]) -> RuntimeFrameCommit {
    build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height,
            timestamp: height,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: Some(CanonicalStateCommitment {
                state_hash: state_root,
                entity_hashes: Vec::new(),
            }),
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: vec![],
            touched_entities: vec![],
            touched_accounts: vec![],
            touched_book_entities: vec![],
        },
        EntityContextPayloadRows::empty(),
        vec![],
        None,
    )
    .expect("canonical-only frame")
    .commit
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("fixture hex"))
        .collect()
}

/// Exact bytes emitted by the current TypeScript prepareEntityContextPayloadRows for
/// one leaf of every kind. Keeping the producer bytes here makes Rust prove
/// both graph semantics and msgpackr canonicality instead of testing itself.
fn typescript_entity_context_rows() -> EntityContextPayloadRows {
    let entity = format!("0x{}", "11".repeat(32));
    let signer = format!("0x{}", "22".repeat(20));
    let replica = format!("{entity}:{signer}");
    let fixtures = [
        (
            EntityContextPayloadKind::GossipProfile,
            "03d4724093a46b696e64a770726f66696c65a776657273696f6ead676f7373697050726f66696c65d4724191a8656e746974794964c72048111111111111111111111111111111111111111111111111111111111111111102",
        ),
        (
            EntityContextPayloadKind::HtlcEntry,
            "03d4724093a5656e747279a46b696e64a776657273696f6ed4724191a762696e64696e67d4724291a66c6f636b4964c720485555555555555555555555555555555555555555555555555555555555555555a968746c63456e74727902",
        ),
        (
            EntityContextPayloadKind::HtlcOriginated,
            "03d4724093a46b696e64aa6f726967696e61746564a776657273696f6eae68746c634f726967696e61746564d4724191a66c6f636b4964c72048666666666666666666666666666666666666666666666666666666666666666602",
        ),
        (
            EntityContextPayloadKind::PeerAssertions,
            "03d4724093aa617373657274696f6e73a46b696e64a776657273696f6e91d4724192a8656e746974794964a66f6e6c696e65c720484444444444444444444444444444444444444444444444444444444444444444c3ae70656572417373657274696f6e7302",
        ),
        (
            EntityContextPayloadKind::GossipProfileDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6ead676f7373697050726f66696c6591c72048855687ee02f6a6eaba342b4c4fbdbc874abc84d52332ffb7e69ae7eaeeea6566aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::PeerAssertionDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6eae70656572417373657274696f6e7391c720484b5d53f603851c72fdc506ceb80f8abd322478c94b9882abf87f74daa560cd96aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::HtlcEntryDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6ea968746c63456e74727991c720485bd1e21a4a678d63e78036bcb53f90907fade4c8673d906811ea00076b9b49fdaa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::HtlcOriginatedDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6eae68746c634f726967696e6174656491c720487e636c81875a314af0e12c87be42cee3d7423c50c9b8819971a509096ee4b4b0aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::Manifest,
            "03d4724097a6686561646572b468746c63456e7472795061676544696765737473b968746c634f726967696e617465645061676544696765737473a46b696e64b870656572417373657274696f6e5061676544696765737473b270726f66696c655061676544696765737473a776657273696f6ed4724196a8656e746974794964a6686569676874af706172656e744672616d6548617368b170726f706f7365725265706c6963614964b070726f706f7365725369676e65724964a776657273696f6ec72048111111111111111111111111111111111111111111111111111111111111111102c720483333333333333333333333333333333333333333333333333333333333333333d96d3078313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313a307832323232323232323232323232323232323232323232323232323232323232323232323232323232c7144822222222222222222222222222222222222222220191c7204881893d75d920b55dc51153c5fcb320e5687eb9674e5e450794926c22df6c76bb91c72048977f2d42b5f19d715d4e8477bc45d91bb3182f671a7f588a7e2d504497063d22ad656e74697479436f6e7465787491c72048ca9af4c8d4e89209dee02c6338bae69aea941b26a788659cf1e0913c194fecf691c7204852088c07f8acb43385f36a3f60cee59d075a893d581bcd5ffdd6521fe73d89d702",
        ),
    ];
    let rows = fixtures
        .into_iter()
        .map(|(kind, bytes)| {
            EntityContextPayloadRow::new(&replica, kind, 0, decode_hex(bytes))
                .expect("valid TS row")
        })
        .collect();
    EntityContextPayloadRows::validate(rows).expect("complete TS v2 graph")
}

fn frame_with_contexts(height: u64, contexts: EntityContextPayloadRows) -> RuntimeFrameCommit {
    build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height,
            timestamp: height,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: vec![],
            touched_entities: vec![],
            touched_accounts: vec![],
            touched_book_entities: vec![],
        },
        contexts,
        vec![],
        None,
    )
    .expect("context frame")
    .commit
}

#[test]
fn all_nine_typescript_context_paths_validate_and_bind_the_frame_ref() {
    let contexts = typescript_entity_context_rows();
    assert_eq!(contexts.rows().len(), 9);
    assert_eq!(
        hex(&contexts.frame_refs()[0].1),
        "b8c775040ca66c46c5ae8d2b3342e15402f44d3393968047d124db2acba98ea5",
    );
    assert_eq!(
        contexts
            .rows()
            .iter()
            .map(|row| row.kind())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            EntityContextPayloadKind::Manifest,
            EntityContextPayloadKind::GossipProfile,
            EntityContextPayloadKind::HtlcEntry,
            EntityContextPayloadKind::HtlcOriginated,
            EntityContextPayloadKind::PeerAssertions,
            EntityContextPayloadKind::GossipProfileDigests,
            EntityContextPayloadKind::HtlcEntryDigests,
            EntityContextPayloadKind::HtlcOriginatedDigests,
            EntityContextPayloadKind::PeerAssertionDigests,
        ]),
    );
    let manifest = contexts
        .rows()
        .iter()
        .find(|row| row.kind() == EntityContextPayloadKind::Manifest)
        .expect("manifest");
    let key = manifest.key(17).expect("path key");
    assert_eq!(key[0], 0x14);
    assert_eq!(&key[1..9], &17_u64.to_be_bytes());
    assert_eq!(&key[9..11], &109_u16.to_be_bytes());
    assert_eq!(key[key.len() - 5], EntityContextPayloadKind::Manifest as u8);
    assert_eq!(&key[key.len() - 4..], &0_u32.to_be_bytes());
}

#[test]
fn native_frame_atomically_recovers_the_exact_verified_context_bundle() {
    let path = temporary_path("entity-context");
    cleanup(&path);
    let contexts = typescript_entity_context_rows();
    {
        let mut store =
            NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("open");
        store
            .append_frame(frame_with_contexts(1, contexts.clone()))
            .expect("durable frame and contexts");
    }
    let mut reopened =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("reopen");
    let recovered = reopened.recover().expect("recover");
    assert_eq!(recovered.wal_frames.len(), 1);
    assert_eq!(recovered.wal_frames[0].entity_contexts, contexts);
    drop(reopened);
    cleanup(&path);
}

#[test]
fn stable_runtime_machine_paths_overwrite_and_prune_only_obsolete_rows() {
    let path = temporary_path("runtime-machine-current");
    cleanup(&path);
    let root = runtime_machine_leaf(json!([]), json!({"kind":"container","container":"object"}));
    let shared_old = runtime_machine_leaf(
        json!([{"kind":"property","name":"shared"}]),
        json!({"kind":"atom","value":1}),
    );
    let old_only = runtime_machine_leaf(
        json!([{"kind":"property","name":"old"}]),
        json!({"kind":"atom","value":"old"}),
    );
    let shared_new = runtime_machine_leaf(
        json!([{"kind":"property","name":"shared"}]),
        json!({"kind":"atom","value":2}),
    );
    let new_only = runtime_machine_leaf(
        json!([{"kind":"property","name":"new"}]),
        json!({"kind":"atom","value":"new"}),
    );
    let first_leaves = vec![root.clone(), shared_old.clone(), old_only.clone()];
    let latest_leaves = vec![root, shared_new.clone(), new_only.clone()];
    let materialized = |state_root, runtime_machine_leaves| CheckpointGraph {
        state_root,
        full: false,
        node_changes: Vec::new(),
        runtime_machine_leaves,
    };
    let shared_key = runtime_machine_leaf_key(&shared_old.path_bytes).expect("shared key");
    let old_only_key = runtime_machine_leaf_key(&old_only.path_bytes).expect("old-only key");
    let new_only_key = runtime_machine_leaf_key(&new_only.path_bytes).expect("new-only key");
    let adjacent_key = [vec![0x17], vec![0x77; 32]].concat();
    let adjacent_value = output("adjacent-path-namespace");
    let canonical = canonical_only_frame(2, [0x22; 32]);
    let canonical_bytes = canonical.frame_bytes.clone();
    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("open");
        store
            .append_frame(frame(
                1,
                vec![],
                Some(materialized([0x11; 32], first_leaves)),
            ))
            .expect("first materialized checkpoint");
        assert_eq!(
            store.database.get(&shared_key).map(|value| value.to_vec()),
            Some(shared_old.value_bytes.clone()),
        );
        assert!(store.database.get(&old_only_key).is_some());
        store
            .database
            .put(&adjacent_key, &adjacent_value)
            .expect("adjacent namespace row");

        store.append_frame(canonical).expect("canonical-only frame");
        assert_eq!(
            store
                .read_durable_frame(2)
                .expect("canonical durable frame")
                .frame_bytes,
            canonical_bytes,
        );
        assert!(store.database.get(&shared_key).is_some());
        assert!(store.database.get(&old_only_key).is_some());
    }

    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("reopen before replacement");
        store
            .append_frame(frame(
                3,
                vec![],
                Some(materialized([0x33; 32], latest_leaves.clone())),
            ))
            .expect("latest materialized checkpoint");
        assert_eq!(
            store.database.get(&shared_key).map(|value| value.to_vec()),
            Some(shared_new.value_bytes.clone()),
        );
        assert!(store.database.get(&old_only_key).is_none());
        assert!(store.database.get(&new_only_key).is_some());
        assert_eq!(
            store
                .database
                .get(&adjacent_key)
                .map(|value| value.to_vec()),
            Some(adjacent_value.clone()),
        );
    }

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen");
    let recovered = reopened.recover().expect("recover");
    let checkpoint = recovered.checkpoint.expect("latest checkpoint");
    assert_eq!(checkpoint.height, 3);
    assert_eq!(checkpoint.state_root, [0x33; 32]);
    assert_eq!(
        checkpoint
            .runtime_machine_leaves
            .into_iter()
            .map(|leaf| (leaf.path_bytes, leaf.value_bytes))
            .collect::<BTreeMap<_, _>>(),
        latest_leaves
            .into_iter()
            .map(|leaf| (leaf.path_bytes, leaf.value_bytes))
            .collect::<BTreeMap<_, _>>(),
    );
    assert!(recovered.wal_frames.is_empty());
    drop(reopened);
    cleanup(&path);
}

#[test]
fn missing_and_orphan_context_paths_are_rejected() {
    let contexts = typescript_entity_context_rows();
    let mut duplicate = contexts.rows().to_vec();
    duplicate.push(duplicate[0].clone());
    assert!(matches!(
        EntityContextPayloadRows::validate(duplicate),
        Err(EntityContextPayloadError::DuplicatePath { .. }),
    ));

    let mut missing = contexts.rows().to_vec();
    missing.retain(|row| row.kind() != EntityContextPayloadKind::HtlcEntry);
    assert!(matches!(
        EntityContextPayloadRows::validate(missing),
        Err(EntityContextPayloadError::Missing {
            kind: "htlcEntry",
            ..
        }),
    ));

    let source = contexts
        .rows()
        .iter()
        .find(|row| row.kind() == EntityContextPayloadKind::HtlcEntry)
        .expect("entry");
    let mut orphan = contexts.rows().to_vec();
    orphan.push(
        EntityContextPayloadRow::new(
            source.replica_id(),
            source.kind(),
            1,
            source.value().to_vec(),
        )
        .expect("canonical orphan"),
    );
    assert!(matches!(
        EntityContextPayloadRows::validate(orphan),
        Err(EntityContextPayloadError::Orphan {
            kind: "htlcEntry",
            index: 1,
            ..
        }),
    ));
}

#[test]
fn context_rows_require_canonical_framed_msgpack_below_ten_kilobytes() {
    let replica = format!("0x{}:0x{}", "11".repeat(32), "22".repeat(20));
    assert!(matches!(
        EntityContextPayloadRow::new(
            &replica,
            EntityContextPayloadKind::Manifest,
            0,
            vec![0x03, 0xcc, 0x01],
        ),
        Err(EntityContextPayloadError::NonCanonical),
    ));
    assert!(matches!(
        EntityContextPayloadRow::new(
            replica,
            EntityContextPayloadKind::Manifest,
            0,
            vec![0x03; 10_000],
        ),
        Err(EntityContextPayloadError::RowBytes(10_000)),
    ));
}

#[test]
fn native_recovery_rejects_a_missing_durable_context_row() {
    let path = temporary_path("entity-context-missing");
    cleanup(&path);
    let contexts = typescript_entity_context_rows();
    let missing_key = contexts
        .rows()
        .iter()
        .find(|row| row.kind() == EntityContextPayloadKind::PeerAssertions)
        .expect("assertion row")
        .key(1)
        .expect("row key");
    let mut store = NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("open");
    store
        .append_frame(frame_with_contexts(1, contexts))
        .expect("durable context frame");
    let mut corruption = WriteBatch::default();
    corruption.delete(&missing_key);
    store
        .database
        .write(corruption, true)
        .expect("simulate missing durable row");
    assert!(matches!(
        store.recover(),
        Err(NativeStorageError::EntityContext(
            EntityContextPayloadError::Missing {
                kind: "peerAssertions",
                ..
            }
        )),
    ));
    drop(store);
    cleanup(&path);
}

#[test]
fn runtime_frame_bytes_and_hash_match_the_typescript_canonical_golden() {
    let encoded = build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height: 1,
            timestamp: 100,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: vec![],
            touched_entities: vec![],
            touched_accounts: vec![],
            touched_book_entities: vec![],
        },
        EntityContextPayloadRows::empty(),
        vec![],
        None,
    )
    .expect("canonical frame");
    assert_eq!(
        hex(&encoded.frame_hash),
        "5053074f16efeee0c151dfc5a4938455e508db8815c048c28adec4dbd7009c88",
    );
    let expected = decode_hex(concat!(
        "03d472409da6686569676874b16d6174657269616c697a65645374617465ad706f7374537461746548617368ad707265764672616d6548617368b17265706c6963614d657461446967657374ac72756e74696d65496e707574b272756e74696d654f7574707574436f756e74b472756e74696d654f757470757473446967657374a974696d657374616d70af746f75636865644163636f756e7473b3746f7563686564426f6f6b456e746974696573af746f7563686564456e746974696573a96672616d654861736801c2c72048d7c10592b50ad7fb4416d4789fbf58a708dfedab2c9ac9cbb7a0e17261f569e8",
        "c720480000000000000000000000000000000000000000000000000000000000000000c720481111111111111111111111111111111111111111111111111111111111111111d4724192ac656e74697479496e70757473aa72756e74696d65547873909000c7204856cc30822c85fae6a34ca5bd7047a22371f2bc0101275dc7240013b675347827cc64909090c720485053074f16efeee0c151dfc5a4938455e508db8815c048c28adec4dbd7009c88",
    ));
    assert_eq!(encoded.commit.frame_bytes, expected);
    let validated = validate_runtime_frame(&encoded.commit.frame_bytes).expect("validate");
    assert_eq!(validated.frame_hash, encoded.frame_hash);
}

#[test]
fn materialized_frame_has_one_state_hash_and_rejects_the_retired_duplicate() {
    let commit = frame(
        1,
        vec![],
        Some(CheckpointGraph {
            state_root: [0x55; 32],
            full: true,
            node_changes: vec![],
            runtime_machine_leaves: vec![],
        }),
    );
    let mut decoded = crate::decode_storage_payload(&commit.frame_bytes).expect("decode frame");
    let fields = decoded.as_object().expect("frame object");
    let canonical = fields
        .get("canonicalStateHash")
        .cloned()
        .expect("sole canonical state commitment");
    assert!(!fields.contains_key("runtimeStateHash"));

    let mut missing = decoded.clone();
    let missing_fields = missing.as_object_mut().expect("missing-root frame object");
    missing_fields.remove("canonicalStateHash");
    missing_fields.remove("canonicalEntityHashes");
    let missing = crate::transport::msgpack::encode_framed_runtime_frame(&missing)
        .expect("encode missing-root frame shape");
    assert!(matches!(
        validate_runtime_frame(&missing),
        Err(RuntimeFrameCodecError::MaterializedRootsRequired)
    ));

    // V1 is versionless: the retired duplicate is an unknown field, not a
    // compatibility alias. Reject it before restore can choose between roots.
    decoded
        .as_object_mut()
        .expect("retired-root frame object")
        .insert("runtimeStateHash".into(), canonical);
    let retired = crate::transport::msgpack::encode_framed_runtime_frame(&decoded)
        .expect("encode retired frame shape");
    assert!(matches!(
        validate_runtime_frame(&retired),
        Err(RuntimeFrameCodecError::Fields)
    ));
}

#[test]
fn canonical_only_frame_has_no_checkpoint_graph_or_runtime_machine_root() {
    let commit = canonical_only_frame(2, [0x44; 32]);
    assert!(commit.checkpoint.is_none());
    let decoded = crate::decode_storage_payload(&commit.frame_bytes).expect("decode frame");
    let fields = decoded.as_object().expect("frame object");
    assert_eq!(fields.get("materializedState"), Some(&Value::Bool(false)));
    assert!(fields.contains_key("canonicalStateHash"));
    assert!(!fields.contains_key("runtimeMachineRoot"));
    let validated = validate_runtime_frame(&commit.frame_bytes).expect("canonical-only frame");
    assert_eq!(validated.canonical_state_hash, Some([0x44; 32]));
    assert_eq!(validated.runtime_machine_root, None);

    let mut invalid = decoded;
    invalid.as_object_mut().expect("frame object").insert(
        "runtimeMachineRoot".into(),
        json!({"rootHash": format!("0x{}", "55".repeat(32)), "leafCount": 1}),
    );
    let invalid = crate::transport::msgpack::encode_framed_runtime_frame(&invalid)
        .expect("encode invalid graph root");
    assert!(matches!(
        validate_runtime_frame(&invalid),
        Err(RuntimeFrameCodecError::MachineRootMaterializedOnly),
    ));
}

#[test]
fn encoder_rejects_checkpoint_graph_fields_on_nonmaterialized_frames() {
    let draft = CanonicalRuntimeFrameDraft {
        height: 2,
        timestamp: 2,
        prev_frame_hash: [0; 32],
        replica_meta_digest: [0x11; 32],
        runtime_component_digests: vec![],
        materialized_state: false,
        canonical_state: Some(CanonicalStateCommitment {
            state_hash: [0x44; 32],
            entity_hashes: Vec::new(),
        }),
        runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
        runtime_machine_root: Some(RuntimeMachineGraphRoot {
            root_hash: [0x55; 32],
            leaf_count: 1,
        }),
        account_authority_checkpoints: vec![],
        touched_entities: vec![],
        touched_accounts: vec![],
        touched_book_entities: vec![],
    };
    assert!(matches!(
        build_runtime_frame_commit(
            draft.clone(),
            EntityContextPayloadRows::empty(),
            vec![],
            None,
        ),
        Err(RuntimeFrameCodecError::MachineRootMaterializedOnly),
    ));

    let graphless = CanonicalRuntimeFrameDraft {
        runtime_machine_root: None,
        ..draft.clone()
    };
    assert!(matches!(
        build_runtime_frame_commit(
            graphless,
            EntityContextPayloadRows::empty(),
            vec![],
            Some(CheckpointGraph {
                state_root: [0x44; 32],
                full: false,
                node_changes: Vec::new(),
                runtime_machine_leaves: runtime_machine_fixture().1,
            }),
        ),
        Err(RuntimeFrameCodecError::CheckpointGraphMaterializedOnly),
    ));

    let materialized_without_graph = CanonicalRuntimeFrameDraft {
        materialized_state: true,
        runtime_machine_root: Some(RuntimeMachineGraphRoot {
            root_hash: [0x55; 32],
            leaf_count: 1,
        }),
        ..draft
    };
    assert!(matches!(
        build_runtime_frame_commit(
            materialized_without_graph,
            EntityContextPayloadRows::empty(),
            vec![],
            None,
        ),
        Err(RuntimeFrameCodecError::CheckpointGraphRequired),
    ));
}

#[test]
fn native_store_rejects_a_checkpoint_graph_on_a_canonical_only_frame() {
    let path = temporary_path("canonical-only-graph");
    cleanup(&path);
    let mut store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("open");
    store
        .append_frame(frame(
            1,
            vec![],
            Some(CheckpointGraph {
                state_root: [0x11; 32],
                full: false,
                node_changes: Vec::new(),
                runtime_machine_leaves: runtime_machine_fixture().1,
            }),
        ))
        .expect("materialized genesis");
    let mut invalid = canonical_only_frame(2, [0x22; 32]);
    invalid.checkpoint = Some(CheckpointGraph {
        state_root: [0x22; 32],
        full: false,
        node_changes: Vec::new(),
        runtime_machine_leaves: runtime_machine_fixture().1,
    });
    assert!(matches!(
        store.append_frame(invalid),
        Err(NativeStorageError::Checkpoint("non-materialized-graph")),
    ));
    assert_eq!(store.latest_height(), 1);
    drop(store);
    cleanup(&path);
}

#[test]
fn dropping_a_prepared_frame_cannot_publish_outputs() {
    let path = temporary_path("pre-fsync");
    cleanup(&path);
    {
        let store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("open");
        let candidate = frame(1, vec![output("must-not-publish")], None);
        assert_eq!(store.latest_height(), 0);
        drop(candidate);
        drop(store);
    }
    let mut reopened =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("reopen");
    assert_eq!(reopened.latest_height(), 0);
    assert_eq!(
        reopened.recover().expect("recover"),
        NativeRuntimeRecovery {
            checkpoint: None,
            wal_frames: vec![],
            pending_outbox: vec![],
        },
    );
    cleanup(&path);
}

#[test]
fn recovery_is_latest_path_checkpoint_plus_exact_wal_tail() {
    let path = temporary_path("recover");
    cleanup(&path);
    let mut account_meta_bytes = vec![0x17];
    account_meta_bytes.extend([1_u8; 32]);
    let account_meta = PathNodeKey::new(account_meta_bytes).expect("account checkpoint meta");
    let mut account_row_bytes = vec![0x18];
    account_row_bytes.extend([1_u8; 32]);
    account_row_bytes.extend([2_u8; 32]);
    let account_row = PathNodeKey::new(account_row_bytes).expect("account checkpoint row");
    let mut account_node_bytes = vec![0x19];
    account_node_bytes.extend([1_u8; 32]);
    account_node_bytes.extend([2_u8; 32]);
    account_node_bytes.extend([3_u8, 1_u8, 4_u8]);
    let account_node = PathNodeKey::new(account_node_bytes).expect("account checkpoint node");
    let first_outputs = vec![output("published-one")];
    let second_outputs = vec![output("published-two")];
    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("open");
        assert_eq!(store.retained_wal_bytes(), 0);
        let first = store
            .append_frame(frame(
                1,
                first_outputs.clone(),
                Some(CheckpointGraph {
                    state_root: [0x11; 32],
                    full: true,
                    runtime_machine_leaves: Vec::new(),
                    node_changes: vec![
                        PathNodeChange {
                            key: account_meta.clone(),
                            value: Some(output("account-meta")),
                        },
                        PathNodeChange {
                            key: account_row.clone(),
                            value: Some(output("account-row")),
                        },
                        PathNodeChange {
                            key: account_node.clone(),
                            value: Some(output("account-node")),
                        },
                    ],
                }),
            ))
            .expect("durable checkpoint frame");
        let retained_after_first = store.retained_wal_bytes();
        assert!(retained_after_first > 0);
        assert_eq!(first.resident_outputs(), Some(first_outputs.as_slice()));
        assert_eq!(
            store.read_durable_outputs(&first).expect("published"),
            first_outputs,
        );
        store
            .append_frame(frame(2, second_outputs.clone(), None))
            .expect("durable tail frame");
        assert!(store.retained_wal_bytes() > retained_after_first);
    }
    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 2,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen");
    assert!(reopened.retained_wal_bytes() > 0);
    let recovered = reopened.recover().expect("recover");
    let checkpoint = recovered.checkpoint.expect("checkpoint");
    assert_eq!(checkpoint.height, 1);
    assert_eq!(checkpoint.state_root, [0x11; 32]);
    assert_eq!(
        checkpoint.path_nodes.get(account_meta.as_bytes()),
        Some(&output("account-meta"))
    );
    assert_eq!(
        checkpoint.path_nodes.get(account_row.as_bytes()),
        Some(&output("account-row"))
    );
    assert_eq!(
        checkpoint.path_nodes.get(account_node.as_bytes()),
        Some(&output("account-node"))
    );
    assert_eq!(checkpoint.runtime_machine_leaves.len(), 1);
    assert_eq!(recovered.wal_frames.len(), 1);
    assert_eq!(recovered.wal_frames[0].height, 2);
    assert_eq!(recovered.wal_frames[0].outputs, second_outputs);
    assert_eq!(recovered.pending_outbox.len(), 2);
    assert_eq!(recovered.pending_outbox[0].height, 1);
    assert_eq!(recovered.pending_outbox[0].outputs, first_outputs);
    assert_eq!(recovered.pending_outbox[1].height, 2);
    assert_eq!(recovered.pending_outbox[1].outputs, second_outputs);
    let resend = reopened
        .durable_frames_for_resend()
        .expect("ordered durable resend tokens");
    assert_eq!(
        resend
            .iter()
            .map(DurableRuntimeFrame::height)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(
        resend
            .iter()
            .all(|durable| durable.resident_outputs().is_none())
    );
    drop(reopened);
    cleanup(&path);
}

#[test]
fn large_account_rows_use_canonical_chunks_and_overwrite_prunes_them() {
    let path = temporary_path("bounded-account-row");
    cleanup(&path);
    let mut key_bytes = vec![0x18];
    key_bytes.extend([1_u8; 32]);
    key_bytes.extend([2_u8; 32]);
    let key = PathNodeKey::new(key_bytes).expect("account row key");
    let large = output(&"z".repeat(10_000));
    let small = output("replacement");
    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 1,
                ..NativeStorageConfig::default()
            },
        )
        .expect("open");
        store
            .append_frame(frame(
                1,
                vec![],
                Some(CheckpointGraph {
                    state_root: [1; 32],
                    full: true,
                    node_changes: vec![PathNodeChange {
                        key: key.clone(),
                        value: Some(large.clone()),
                    }],
                    runtime_machine_leaves: Vec::new(),
                }),
            ))
            .expect("large checkpoint");
        let physical = super::bounded::physical_rows(key.as_bytes(), &large).expect("physical");
        assert_eq!(physical.len(), 3);
        for (physical_key, expected) in &physical {
            assert_eq!(
                store.database.get(physical_key).map(|value| value.to_vec()),
                Some(expected.clone()),
            );
        }
        assert_eq!(
            store
                .current_checkpoint_path_nodes()
                .expect("logical rows")
                .get(key.as_bytes()),
            Some(&large),
        );
        store
            .append_frame(frame(
                2,
                vec![],
                Some(CheckpointGraph {
                    state_root: [2; 32],
                    full: false,
                    node_changes: vec![PathNodeChange {
                        key: key.clone(),
                        value: Some(small.clone()),
                    }],
                    runtime_machine_leaves: Vec::new(),
                }),
            ))
            .expect("replacement checkpoint");
        assert_eq!(
            store
                .database
                .get(key.as_bytes())
                .map(|value| value.to_vec()),
            Some(small.clone()),
        );
        for (chunk_key, _) in physical.iter().skip(1) {
            assert!(store.database.get(chunk_key).is_none());
        }
    }
    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 1,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen");
    assert_eq!(
        reopened
            .recover()
            .expect("recover")
            .checkpoint
            .expect("checkpoint")
            .path_nodes
            .get(key.as_bytes()),
        Some(&small),
    );
    cleanup(&path);
}

#[test]
fn exact_checkpoint_import_installs_one_synced_head_without_fake_frames() {
    let path = temporary_path("checkpoint-import");
    cleanup(&path);
    let mut owner_key = vec![0x17];
    owner_key.extend([0x44; 32]);
    let output_rows = vec![output("imported-outbox")];
    let checkpoint_frame = frame(
        100,
        output_rows.clone(),
        Some(CheckpointGraph {
            state_root: [0x55; 32],
            full: true,
            node_changes: vec![PathNodeChange {
                key: PathNodeKey::new(owner_key).expect("owner path"),
                value: Some(output("imported-state")),
            }],
            runtime_machine_leaves: Vec::new(),
        }),
    );
    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("open");
        let durable = store
            .import_checkpoint(checkpoint_frame)
            .expect("atomic import");
        assert_eq!(durable.height(), 100);
        assert_eq!(store.latest_height(), 100);
        assert!(matches!(
            store.import_checkpoint(frame(200, vec![], None)),
            Err(NativeStorageError::CheckpointImportNotEmpty)
        ));
    }
    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen");
    assert_eq!(reopened.latest_height(), 100);
    let recovered = reopened.recover().expect("recover import");
    assert_eq!(recovered.checkpoint.expect("checkpoint").height, 100);
    assert_eq!(recovered.pending_outbox.len(), 1);
    assert_eq!(recovered.pending_outbox[0].outputs, output_rows);
    reopened
        .append_frame(frame(101, vec![], None))
        .expect("first post-import WAL frame");
    cleanup(&path);
}

#[test]
fn rejected_checkpoint_import_is_atomic_and_a_valid_retry_survives_reopen() {
    let path = temporary_path("checkpoint-import-atomic");
    cleanup(&path);
    let mut owner_key = vec![0x17];
    owner_key.extend([0x66; 32]);
    let valid = frame(
        100,
        vec![],
        Some(CheckpointGraph {
            state_root: [0x77; 32],
            full: true,
            node_changes: vec![PathNodeChange {
                key: PathNodeKey::new(owner_key.clone()).expect("owner path"),
                value: Some(output("state")),
            }],
            runtime_machine_leaves: Vec::new(),
        }),
    );
    let mut invalid = valid.clone();
    invalid
        .checkpoint
        .as_mut()
        .expect("checkpoint")
        .runtime_machine_leaves[0]
        .value_bytes = output("not-a-machine-node");
    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("open");
        assert!(store.import_checkpoint(invalid).is_err());
        assert_eq!(store.latest_height(), 0);
        assert_eq!(
            store.recover().expect("still empty"),
            NativeRuntimeRecovery {
                checkpoint: None,
                wal_frames: Vec::new(),
                pending_outbox: Vec::new(),
            }
        );
    }
    {
        let mut reopened = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 100,
                ..NativeStorageConfig::default()
            },
        )
        .expect("reopen empty");
        assert_eq!(reopened.latest_height(), 0);
        reopened.import_checkpoint(valid).expect("valid import");
    }
    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen durable");
    let recovered = reopened.recover().expect("recover valid import");
    assert_eq!(recovered.checkpoint.expect("checkpoint").height, 100);
    assert!(recovered.wal_frames.is_empty());
    cleanup(&path);
}

#[test]
fn account_checkpoint_meta_requires_the_exact_owner_path() {
    assert!(PathNodeKey::new([vec![0x17], vec![1_u8; 32]].concat()).is_ok());
    assert!(matches!(
        PathNodeKey::new([vec![0x17], vec![1_u8; 31]].concat()),
        Err(NativeStorageError::PathKey(_)),
    ));
    assert!(matches!(
        PathNodeKey::new([vec![0x17], vec![1_u8; 33]].concat()),
        Err(NativeStorageError::PathKey(_)),
    ));
}

#[test]
fn missing_due_checkpoint_is_rejected_before_any_database_write() {
    let path = temporary_path("cadence");
    cleanup(&path);
    let mut store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 2,
            ..NativeStorageConfig::default()
        },
    )
    .expect("open");
    store
        .append_frame(frame(1, vec![], None))
        .expect("frame one");
    assert!(matches!(
        store.append_frame(frame(2, vec![], None)),
        Err(NativeStorageError::CheckpointRequired(2)),
    ));
    assert_eq!(store.latest_height(), 1);
    drop(store);
    cleanup(&path);
}

#[test]
fn a_real_filesystem_sync_failure_poison_stops_publication_and_future_work() {
    let path = temporary_path("fsync-failure");
    let moved = path.with_extension("moved");
    cleanup(&path);
    cleanup(&moved);
    let mut store = NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("open");
    // The production DB remains real and writable through its open log fd, but
    // moving its directory makes the mandatory post-write directory fsync fail.
    std::fs::rename(&path, &moved).expect("move isolated database");
    assert!(matches!(
        store.append_frame(frame(1, vec![output("not-published")], None)),
        Err(NativeStorageError::Fsync(_)),
    ));
    assert!(matches!(store.recover(), Err(NativeStorageError::Poisoned)));
    assert!(matches!(
        store.append_frame(frame(1, vec![], None)),
        Err(NativeStorageError::Poisoned),
    ));
    drop(store);
    cleanup(&moved);
}

#[test]
fn storage_wall_decomposition_is_gated_and_does_not_change_wal_rows() {
    let path = temporary_path("profile-wall");
    cleanup(&path);
    let mut store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            durable_fsync: false,
            ..NativeStorageConfig::default()
        },
    )
    .expect("open");
    let build = |height| {
        build_runtime_frame_commit(
            CanonicalRuntimeFrameDraft {
                height,
                timestamp: height,
                prev_frame_hash: [0; 32],
                replica_meta_digest: [0x11; 32],
                runtime_component_digests: vec![],
                materialized_state: false,
                canonical_state: None,
                runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
                runtime_machine_root: None,
                account_authority_checkpoints: vec![],
                touched_entities: vec![],
                touched_accounts: vec![],
                touched_book_entities: vec![],
            },
            EntityContextPayloadRows::empty(),
            vec![],
            None,
        )
        .expect("encoded frame")
    };
    let first = build(1);
    let first_bytes = first.commit.frame_bytes.clone();
    let (_, disabled) = store
        .append_encoded_frame(first, false)
        .expect("unprofiled append");
    assert_eq!(disabled, NativeStorageTimings::default());
    assert_eq!(
        store
            .read_durable_frame(1)
            .expect("first frame")
            .frame_bytes,
        first_bytes,
    );

    let (_, profiled) = store
        .append_encoded_frame(build(2), true)
        .expect("profiled append");
    assert_eq!(profiled.directory_sync, std::time::Duration::ZERO);
    assert!(profiled.accounted() > std::time::Duration::ZERO);
    assert_eq!(
        profiled.accounted(),
        profiled.prepare_validate
            + profiled.batch_build
            + profiled.db_write_sync
            + profiled.directory_sync
            + profiled.post_commit,
    );
    drop(store);
    cleanup(&path);
}
