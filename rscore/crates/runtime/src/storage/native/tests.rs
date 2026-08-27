use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};

use rusty_leveldb::WriteBatch;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, PersistentRadixMap};

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
            replica_meta_state_mode: if materialized {
                ReplicaMetaStateMode::SharedEntityState
            } else {
                ReplicaMetaStateMode::LiveHead
            },
            runtime_component_digests: vec![],
            materialized_state: materialized,
            canonical_state,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            pending_runtime_input: None,
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
    (
        json!({}),
        vec![RuntimeMachineLeafRow {
            path_bytes: crate::transport::msgpack::encode_framed(&path).expect("machine path"),
            value_bytes: crate::transport::msgpack::encode_framed(&value).expect("machine value"),
        }],
    )
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

/// Exact bytes emitted by TypeScript prepareEntityContextPayloadRows(v2) for
/// one leaf of every kind. Keeping the producer bytes here makes Rust prove
/// both graph semantics and msgpackr canonicality instead of testing itself.
fn typescript_v2_entity_context_rows() -> EntityContextPayloadRows {
    let entity = format!("0x{}", "11".repeat(32));
    let signer = format!("0x{}", "22".repeat(20));
    let replica = format!("{entity}:{signer}");
    let fixtures = [
        (
            EntityContextPayloadKind::GossipProfile,
            "03d4724093a46b696e64a770726f66696c65a776657273696f6ead676f7373697050726f66696c65d4724191a8656e746974794964d94230783131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313102",
        ),
        (
            EntityContextPayloadKind::HtlcEntry,
            "03d4724093a5656e747279a46b696e64a776657273696f6ed4724191a762696e64696e67d4724291a66c6f636b4964d942307835353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535a968746c63456e74727902",
        ),
        (
            EntityContextPayloadKind::HtlcOriginated,
            "03d4724093a46b696e64aa6f726967696e61746564a776657273696f6eae68746c634f726967696e61746564d4724191a66c6f636b4964d94230783636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363602",
        ),
        (
            EntityContextPayloadKind::PeerAssertions,
            "03d4724093aa617373657274696f6e73a46b696e64a776657273696f6e91d4724192a8656e746974794964a66f6e6c696e65d942307834343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434c3ae70656572417373657274696f6e7302",
        ),
        (
            EntityContextPayloadKind::GossipProfileDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6ead676f7373697050726f66696c6591d942307834626533366662366135633336386665393634646361346266346666653638303463396637626365356432613833366265336133313939393361626164356134aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::PeerAssertionDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6eae70656572417373657274696f6e7391d942307836656637636537353165373939356130656131363065363136366132326131373033336137323237306665383162313965366266626363303961393165356536aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::HtlcEntryDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6ea968746c63456e74727991d942307830663236313866326430623038376563663338353831633033653664336664383933353938353830343064386362353765326461376230323561626164633165aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::HtlcOriginatedDigests,
            "03d4724094a96368696c644b696e64a764696765737473a46b696e64a776657273696f6eae68746c634f726967696e6174656491d942307866633633373934653062306333396666313733386336356137616134373864363732346364616661383832633162326261653466313136393066646365666132aa6469676573745061676502",
        ),
        (
            EntityContextPayloadKind::Manifest,
            "03d4724097a6686561646572b468746c63456e7472795061676544696765737473b968746c634f726967696e617465645061676544696765737473a46b696e64b870656572417373657274696f6e5061676544696765737473b270726f66696c655061676544696765737473a776657273696f6ed4724196a8656e746974794964a6686569676874af706172656e744672616d6548617368b170726f706f7365725265706c6963614964b070726f706f7365725369676e65724964a776657273696f6ed94230783131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313102d942307833333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333d96d3078313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313a307832323232323232323232323232323232323232323232323232323232323232323232323232323232d92a3078323232323232323232323232323232323232323232323232323232323232323232323232323232320191d94230783763373638306562356333636461313138366539313964313362386439626433363931366639663730646439303565646233333636616366616630313534336391d942307833316665323138373263396131633731306266356136393737316437333164646539656130626164643639623135313437343232303261383431643139323862ad656e74697479436f6e7465787491d94230783166643865646337623863633264313634366433303066666565346564326637663231343738363735316632323663303631306163663632633832343033383691d94230786366616639386439353064353436663962653864373765313234653434643439383338666663363630613634313066323261343130303130616232396131626302",
        ),
    ];
    let rows = fixtures
        .into_iter()
        .map(|(kind, bytes)| {
            EntityContextPayloadRow::new(&replica, kind, 0, decode_hex(bytes))
                .expect("valid TS v2 row")
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
            replica_meta_state_mode: ReplicaMetaStateMode::LiveHead,
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            pending_runtime_input: None,
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
fn all_nine_typescript_v2_context_paths_validate_and_bind_the_frame_ref() {
    let contexts = typescript_v2_entity_context_rows();
    assert_eq!(contexts.rows().len(), 9);
    assert_eq!(
        hex(&contexts.frame_refs()[0].1),
        "9907d3ce61861531bc49d73069bd46be0685495ee32a85673965a1844da9dff6",
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
    let contexts = typescript_v2_entity_context_rows();
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
fn missing_and_orphan_context_paths_are_rejected() {
    let contexts = typescript_v2_entity_context_rows();
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
    let contexts = typescript_v2_entity_context_rows();
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
            replica_meta_state_mode: ReplicaMetaStateMode::LiveHead,
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            pending_runtime_input: None,
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
        "546f7ab9975255e355900e566265ea321c3efe961e66fb9a9a53e1f9697f154f",
    );
    let expected = decode_hex(concat!(
        "03d472409fa6686569676874b16d6174657269616c697a65645374617465ad706f7374537461746548617368ad707265764672616d6548617368b57265706c6963614d657461436865636b706f696e74b17265706c6963614d657461446967657374b47265706c6963614d65746153746174654d6f6465ac",
        "72756e74696d65496e707574b272756e74696d654f7574707574436f756e74b472756e74696d654f757470757473446967657374a974696d657374616d70af746f75636865644163636f756e7473b3746f7563686564426f6f6b456e746974696573af746f7563686564456e746974696573a96672616d65",
        "4861736801c2d942307863386135626435313539633433373831343264356462613330353664393334333433363734333764663762333033333631643966626566653262343337333030d9423078303030303030303030303030303030303030303030303030303030303030303030303030303030303030",
        "30303030303030303030303030303030303030303030c2d942307831313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131a96c6976652d68656164d4724192ac656e74697479496e70757473aa72",
        "756e74696d65547873909000d942307835366363333038323263383566616536613334636135626437303437613232333731663262633031303132373564633732343030313362363735333437383237cc64909090d942307835343666376162393937353235356533353539303065353636323635656133",
        "323163336566653936316536366662396139613533653166393639376631353466",
    ));
    assert_eq!(encoded.commit.frame_bytes, expected);
    let validated = validate_runtime_frame(&encoded.commit.frame_bytes).expect("validate");
    assert_eq!(validated.frame_hash, encoded.frame_hash);
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
    let mut account_sidecar_bytes = vec![0x18];
    account_sidecar_bytes.extend([1_u8; 32]);
    account_sidecar_bytes.extend([2_u8; 32]);
    let account_sidecar =
        PathNodeKey::new(account_sidecar_bytes).expect("account checkpoint sidecar");
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
            },
        )
        .expect("open");
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
                            key: account_sidecar.clone(),
                            value: Some(output("account-sidecar")),
                        },
                        PathNodeChange {
                            key: account_node.clone(),
                            value: Some(output("account-node")),
                        },
                    ],
                }),
            ))
            .expect("durable checkpoint frame");
        assert_eq!(
            store.read_durable_outputs(&first).expect("published"),
            first_outputs,
        );
        store
            .append_frame(frame(2, second_outputs.clone(), None))
            .expect("durable tail frame");
    }
    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 2,
        },
    )
    .expect("reopen");
    let recovered = reopened.recover().expect("recover");
    let checkpoint = recovered.checkpoint.expect("checkpoint");
    assert_eq!(checkpoint.height, 1);
    assert_eq!(checkpoint.state_root, [0x11; 32]);
    assert_eq!(
        checkpoint.path_nodes.get(account_meta.as_bytes()),
        Some(&output("account-meta"))
    );
    assert_eq!(
        checkpoint.path_nodes.get(account_sidecar.as_bytes()),
        Some(&output("account-sidecar"))
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
        },
    )
    .expect("reopen durable");
    let recovered = reopened.recover().expect("recover valid import");
    assert_eq!(recovered.checkpoint.expect("checkpoint").height, 100);
    assert!(recovered.wal_frames.is_empty());
    cleanup(&path);
}

#[test]
fn watcher_cursor_overwrites_with_the_consuming_frame_and_is_not_merkle_state() {
    let path = temporary_path("watcher-cursor");
    cleanup(&path);
    let entity_id = [0xaa; 32];
    let depository_address = [0x11; 20];
    let cursor = crate::j_watcher::FinalizedWatcherCursor {
        scanned_through: 43,
        block_hash: Some([0x22; 32]),
    };
    let row = cursor
        .durable_change(&entity_id, 31_337, &depository_address)
        .expect("canonical cursor row");
    let mut committed = frame(
        1,
        vec![],
        Some(CheckpointGraph {
            state_root: [0x33; 32],
            full: true,
            node_changes: Vec::new(),
            runtime_machine_leaves: Vec::new(),
        }),
    );
    committed.watcher_cursor_changes.push(row.clone());
    {
        let mut store = NativeRuntimeStore::open(
            &path,
            NativeStorageConfig {
                checkpoint_period_frames: 1,
            },
        )
        .expect("open");
        store.append_frame(committed).expect("atomic cursor frame");
    }
    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 1,
        },
    )
    .expect("reopen");
    assert_eq!(
        reopened
            .read_runtime_watcher_cursor(entity_id, 31_337, depository_address)
            .expect("read cursor"),
        Some(row),
    );
    assert!(
        reopened
            .recover()
            .expect("recover")
            .checkpoint
            .expect("checkpoint")
            .path_nodes
            .keys()
            .all(|key| key.first() != Some(&0x3a)),
    );
    cleanup(&path);
}

#[test]
fn invalid_watcher_cursor_is_rejected_before_the_frame_write() {
    let path = temporary_path("watcher-cursor-invalid");
    cleanup(&path);
    let entity_id = [0xaa; 32];
    let depository_address = [0x11; 20];
    let mut invalid = frame(1, vec![], None);
    invalid
        .watcher_cursor_changes
        .push(RuntimeWatcherCursorRow {
            entity_id,
            chain_id: 31_337,
            depository_address,
            value_bytes: crate::encode_storage_payload(&CanonicalValue::Object(vec![
                (
                    "chainId".into(),
                    CanonicalValue::Number(
                        CanonicalNumber::try_from_u64(31_337).expect("chain id"),
                    ),
                ),
                (
                    "depositoryAddress".into(),
                    CanonicalValue::String(format!("0x{}", "11".repeat(20))),
                ),
                (
                    "scannedThrough".into(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(0)),
                ),
                (
                    "blockHash".into(),
                    CanonicalValue::String(format!("0x{}", "22".repeat(32))),
                ),
            ]))
            .expect("canonical malicious row"),
        });
    let mut store = NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("open");
    assert!(matches!(
        store.append_frame(invalid),
        Err(NativeStorageError::WatcherCursorValue("blockHash")),
    ));
    assert_eq!(store.latest_height(), 0);
    drop(store);
    let reopened = NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("reopen");
    assert_eq!(reopened.latest_height(), 0);
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
