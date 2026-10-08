use super::*;

pub(super) fn assert_reopened_exact_replay(
    directory: &std::path::Path,
    runtime_seed: &str,
    entity_seed: &str,
    routes: EntityRouteTable,
    expected_account_root: [u8; 32],
    originating_height: Option<u64>,
) {
    use crate::restore::{
        ConcreteCheckpointConfiguration, decode_concrete_runtime_checkpoint,
        decode_concrete_runtime_wal_frame, load_native_restore_sources,
        restore_decoded_runtime_checkpoint,
    };
    use crate::storage::native::{CheckpointGraph, PathNodeChange, RuntimeFrameCommit};
    let mut original = NativeRuntimeStore::open(directory, NativeStorageConfig::default()).unwrap();
    let recovered = original.recover().unwrap();
    let checkpoint = recovered
        .checkpoint
        .expect("authentic materialized checkpoint");
    let durable = original.read_durable_frame(checkpoint.height).unwrap();
    let sources = load_native_restore_sources(&mut original).unwrap();
    assert!(
        !sources.wal.is_empty(),
        "must replay a real financial tail, not only reopen checkpoint"
    );
    let signer = hex(&derive_signer_address(entity_seed, ENTITY_KEY_LABEL).unwrap());
    let decoded = decode_concrete_runtime_checkpoint(
        sources.checkpoint,
        ConcreteCheckpointConfiguration {
            runtime_seed: runtime_seed.into(),
            signer_derivation_labels: vec![SOURCE_SIGNER.into()],
            custody_import_keys: BTreeMap::from([(
                signer,
                derive_signer_key(entity_seed, ENTITY_KEY_LABEL).unwrap(),
            )]),
            worker_count: 1,
            limits: RuntimeLimits {
                checkpoint_period_frames: 100,
                ..RuntimeLimits::hlt()
            },
            swap_market: Arc::new(SwapMarketPolicy::default()),
            expected_protocol_fingerprint: [0x44; 32],
            board_delays: BoardDelays::default(),
        },
    )
    .unwrap();
    let restored = restore_decoded_runtime_checkpoint(decoded).unwrap();
    let replay_directory = directory.with_extension("exact-replay");
    let mut store =
        NativeRuntimeStore::open(&replay_directory, NativeStorageConfig::default()).unwrap();
    store
        .import_checkpoint(RuntimeFrameCommit {
            height: checkpoint.height,
            frame_bytes: durable.frame_bytes,
            outputs: durable.outputs,
            entity_contexts: durable.entity_contexts,
            checkpoint: Some(CheckpointGraph {
                state_root: checkpoint.state_root,
                full: true,
                node_changes: checkpoint
                    .path_nodes
                    .into_iter()
                    .map(|(key, value)| PathNodeChange {
                        key: crate::storage::native::PathNodeKey::new(key).unwrap(),
                        value: Some(value),
                    })
                    .collect(),
                runtime_machine_leaves: checkpoint.runtime_machine_leaves,
            }),
        })
        .unwrap();
    let mut replay = DurableRuntimeProcessor::new_replay_validate_only(
        restored.replica,
        store,
        routes,
        runtime_seed,
        RuntimeSignerLabel::new(SOURCE_SIGNER).unwrap(),
    )
    .unwrap();
    if let Some(height) = originating_height {
        assert!(
            sources.wal.iter().any(|source| source.height() == height),
            "the new raw origin must be replayed from WAL, not only checkpointed"
        );
        let recorded = original.read_durable_frame(height).unwrap();
        let decoded = crate::decode_storage_payload(&recorded.frame_bytes).unwrap();
        assert!(
            has_raw_empty_route(&decoded["runtimeInput"]),
            "actual recorded raw route[] payment required"
        );
    }
    let replayed_count = sources.wal.len();
    for source in sources.wal {
        let height = source.height();
        let frame = decode_concrete_runtime_wal_frame(
            &source,
            replay.replica().unwrap().state.finalized_j_height,
        )
        .unwrap();
        replay.reconcile_exact_replay_input(&frame.input).unwrap();
        replay
            .process_exact_replay(frame.input, source.outputs())
            .unwrap();
        replay.sync_committed().unwrap();
        let expected = original.read_durable_frame(height).unwrap();
        let actual = replay.read_durable_frame(height).unwrap();
        assert_eq!(
            actual.frame_bytes, expected.frame_bytes,
            "exact WAL frame {height}"
        );
        assert_eq!(
            actual.outputs, expected.outputs,
            "ordered financial outbox {height}"
        );
    }
    assert_eq!(
        entity_state(replay.replica().unwrap()).accounts_root,
        expected_account_root
    );
    eprintln!(
        "EMPTY_ROUTE_EXACT_REPLAY:runtime={runtime_seed}:frames={replayed_count}:through={}",
        replay.replica().unwrap().state.height
    );
    drop(replay);
    drop(original);
    std::fs::remove_dir_all(replay_directory).unwrap();
}

fn has_raw_empty_route(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            (fields.get("type").is_some_and(|kind| kind == "htlcPayment")
                && fields
                    .get("data")
                    .and_then(|data| data.get("route"))
                    .is_some_and(|route| route.as_array().is_some_and(Vec::is_empty)))
                || fields.values().any(has_raw_empty_route)
        }
        Value::Array(items) => items.iter().any(has_raw_empty_route),
        _ => false,
    }
}
