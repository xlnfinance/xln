//! Exact native replay of canonical TypeScript Runtime WAL frames.
//!
//! Replay restores the real resident Runtime from one materialized checkpoint,
//! imports that same checkpoint into the native durable store, and then feeds
//! exact persisted Runtime inputs through `DurableRuntimeProcessor`. Recorded
//! commitments are assertions only: they never select proposals or repair state.

mod diff;
mod expectations;
mod native_v1;
pub use crate::native_runtime::{NativeRuntimeReady, restore_native_runtime_processor};
pub use native_v1::{NativeV1ReplayMetrics, replay_native_v1};

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use xln_rscore_engine::BoardDelays;
use xln_rscore_runtime::processor::{EntityRoute, EntityRouteTable};
use xln_rscore_runtime::restore::{
    ConcreteCheckpointConfiguration, ConcreteCheckpointSource, ConcreteWalSource,
    DecodedRuntimeWalFrame, MigrationOrigin, decode_concrete_runtime_wal_frame,
    decode_offline_ts_import_checkpoint, restore_decoded_runtime_checkpoint,
    verify_checkpoint_source,
};
use xln_rscore_runtime::storage::native::{
    NativeRuntimeStore, NativeStorageConfig, validate_runtime_frame,
};
use xln_rscore_runtime::{
    CanonicalRuntimeEntityHash, DurableRuntimeProcessor, RuntimeDurableCommitments,
    RuntimeDurableEntityCommitment, RuntimeEntityReplica, RuntimeEntityState, RuntimeReplica,
    RuntimeSignerLabel, RuntimeWalReader, canonical_swap_market_policy,
    compute_canonical_runtime_state_hash, decode_storage_payload,
};

use crate::PAYMENT_PROFILE_BINDING;
use diff::{RuntimeReplayDiffInput, write_runtime_replay_diff};
use expectations::ReplayExpectations;

/// This replay fixture is single-entity by construction. Every commitment,
/// state and diagnostic read below names that sole Entity explicitly, and a
/// second Entity appearing is a loud failure instead of a silent pick.
fn sole_entity_state(replica: &RuntimeReplica) -> Result<&RuntimeEntityState, String> {
    let mut entities = replica.state.e_replicas.values();
    let (Some(state), None) = (entities.next(), entities.next()) else {
        return Err(format!(
            "RUNTIME_REPLAY_SOLE_ENTITY_STATE:{}",
            replica.state.e_replicas.len()
        ));
    };
    Ok(state)
}

fn sole_entity_replica(replica: &RuntimeReplica) -> Result<&RuntimeEntityReplica, String> {
    let mut entities = replica.e_replicas.values();
    let (Some(entity), None) = (entities.next(), entities.next()) else {
        return Err(format!(
            "RUNTIME_REPLAY_SOLE_ENTITY_REPLICA:{}",
            replica.e_replicas.len()
        ));
    };
    Ok(entity)
}

/// The single replayed Entity's final commitment in this Runtime frame. One
/// frame may commit that Entity more than once (an external input followed by
/// its derived account-work frame); the last commitment carries the frame's
/// canonical Entity hash and accounts root, exactly like the TS frame record.
fn sole_entity_commitment(
    commitments: &RuntimeDurableCommitments,
) -> Result<&RuntimeDurableEntityCommitment, String> {
    let (Some(first), Some(last)) = (commitments.entities.first(), commitments.entities.last())
    else {
        return Err("RUNTIME_REPLAY_SOLE_ENTITY_COMMITMENT:0".to_string());
    };
    if commitments
        .entities
        .iter()
        .any(|entity| entity.entity_id != first.entity_id)
    {
        return Err(format!(
            "RUNTIME_REPLAY_SOLE_ENTITY_COMMITMENT:{}",
            commitments.entities.len()
        ));
    }
    Ok(last)
}

pub struct RuntimeReplayMetrics {
    pub frames: u64,
    pub ingress: u64,
    /// Submitted directPayment txs decoded from the WAL. Fixture cardinality
    /// for replay diagnostics, never a delivery or throughput claim.
    pub direct_payments: u64,
    pub egress: u64,
    pub elapsed: Duration,
    pub setup_elapsed: Duration,
    pub engine_elapsed: Duration,
    pub apply_elapsed: Duration,
    pub projection_elapsed: Duration,
    pub projection_input_elapsed: Duration,
    pub projection_machine_elapsed: Duration,
    pub projection_meta_elapsed: Duration,
    pub projection_context_elapsed: Duration,
    pub projection_checkpoint_elapsed: Duration,
    pub projection_encode_elapsed: Duration,
    pub storage_elapsed: Duration,
    pub publication_elapsed: Duration,
    pub storage_prepare_validate_elapsed: Duration,
    pub storage_batch_build_elapsed: Duration,
    pub storage_db_write_sync_elapsed: Duration,
    pub storage_directory_sync_elapsed: Duration,
    pub storage_post_commit_elapsed: Duration,
    pub barrier_wait_for_previous_commit_elapsed: Duration,
    pub committer_busy_elapsed: Duration,
    pub committer_idle_elapsed: Duration,
    pub apply_profile: xln_rscore_runtime::RuntimeApplyPhaseProfile,
    pub effect_digests_compared: u64,
    pub event_digests_compared: u64,
    pub local_continuations_compared: u64,
    pub outbox_digests_compared: u64,
    pub post_state_hashes_compared: u64,
    pub runtime_roots_compared: u64,
    pub accounts_root: String,
    /// Resident Account sharding observability per phase kind. Timing-only:
    /// serialized once after replay and never part of committed state.
    pub account_phase_metrics: Vec<xln_rscore_batch::AccountPhaseMetric>,
}

fn add_wall_decomposition(
    metrics: &mut RuntimeReplayMetrics,
    report: &xln_rscore_runtime::RuntimeProcessReport,
) {
    let timings = report.timings;
    metrics.projection_input_elapsed += timings.projection_input;
    metrics.projection_machine_elapsed += timings.projection_machine;
    metrics.projection_meta_elapsed += timings.projection_meta;
    metrics.projection_context_elapsed += timings.projection_context;
    metrics.projection_checkpoint_elapsed += timings.projection_checkpoint;
    metrics.projection_encode_elapsed += timings.projection_encode;
    metrics.storage_elapsed += timings.storage;
    metrics.publication_elapsed += timings.publication;
    metrics.storage_prepare_validate_elapsed += timings.storage_prepare_validate;
    metrics.storage_batch_build_elapsed += timings.storage_batch_build;
    metrics.storage_db_write_sync_elapsed += timings.storage_db_write_sync;
    metrics.storage_directory_sync_elapsed += timings.storage_directory_sync;
    metrics.storage_post_commit_elapsed += timings.storage_post_commit;
    metrics.barrier_wait_for_previous_commit_elapsed += timings.barrier_wait_for_previous_commit;
    metrics.committer_busy_elapsed += timings.committer_busy;
    metrics.committer_idle_elapsed += timings.committer_idle;
    if let Some(profile) = &report.apply_profile {
        metrics.apply_profile.fit += profile.fit;
        metrics.apply_profile.resident_core += profile.resident_core;
        metrics.apply_profile.post_core_prepare += profile.post_core_prepare;
        metrics.apply_profile.certification += profile.certification;
        metrics.apply_profile.settlement_attach += profile.settlement_attach;
        metrics.apply_profile.post_cert_j += profile.post_cert_j;
        metrics.apply_profile.total += profile.total;
        metrics.apply_profile.residual += profile.residual;
        metrics.apply_profile.entity_groups = metrics
            .apply_profile
            .entity_groups
            .saturating_add(profile.entity_groups);
        metrics.apply_profile.entity_txs_selected = metrics
            .apply_profile
            .entity_txs_selected
            .saturating_add(profile.entity_txs_selected);
        metrics.apply_profile.account_inputs = metrics
            .apply_profile
            .account_inputs
            .saturating_add(profile.account_inputs);
        metrics.apply_profile.settlement_hankos = metrics
            .apply_profile
            .settlement_hankos
            .saturating_add(profile.settlement_hankos);
        metrics.apply_profile.post_cert_j_actions = metrics
            .apply_profile
            .post_cert_j_actions
            .saturating_add(profile.post_cert_j_actions);
    }
}

/// Submitted directPayment txs in one decoded input. Counted from the
/// canonical input the decode already holds; fixture cardinality only.
fn direct_payment_count(input: &xln_rscore_runtime::RuntimeInput) -> Result<u64, String> {
    input
        .entity_inputs
        .iter()
        .try_fold(0_u64, |total, entity_input| {
            let txs = entity_input
                .canonical()
                .as_object()
                .and_then(|value| value.get("entityTxs"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let payments = txs
                .iter()
                .filter(|tx| {
                    tx.as_object()
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str)
                        == Some("directPayment")
                })
                .count();
            total
                .checked_add(
                    u64::try_from(payments)
                        .map_err(|_| "RUNTIME_REPLAY_PAYMENT_COUNT_OVERFLOW".to_string())?,
                )
                .ok_or_else(|| "RUNTIME_REPLAY_PAYMENT_COUNT_OVERFLOW".to_string())
        })
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("RUNTIME_REPLAY_OBJECT:{path}"))
}

fn field<'a>(value: &'a Value, name: &str, path: &str) -> Result<&'a Value, String> {
    object(value, path)?
        .get(name)
        .ok_or_else(|| format!("RUNTIME_REPLAY_FIELD:{path}.{name}"))
}

fn artifact_hex(value: &Value, path: &str) -> Result<Vec<u8>, String> {
    let raw = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| !value.is_empty() && value.len() % 2 == 0)
        .ok_or_else(|| format!("RUNTIME_REPLAY_CHECKPOINT_HEX:{path}"))?;
    (0..raw.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&raw[index..index + 2], 16)
                .map_err(|_| format!("RUNTIME_REPLAY_CHECKPOINT_HEX:{path}"))
        })
        .collect()
}

struct ArtifactRow {
    key: Vec<u8>,
    value: Vec<u8>,
}

fn artifact_rows(value: &Value, path: &str) -> Result<Vec<ArtifactRow>, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| format!("RUNTIME_REPLAY_CHECKPOINT_ROWS:{path}"))?;
    let mut output = Vec::with_capacity(rows.len());
    let mut previous = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| format!("RUNTIME_REPLAY_CHECKPOINT_ROW:{path}:{index}"))?;
        let key = artifact_hex(&row[0], &format!("{path}[{index}].key"))?;
        if !previous.is_empty() && previous >= key {
            return Err(format!(
                "RUNTIME_REPLAY_CHECKPOINT_ROW_ORDER:{path}:{index}"
            ));
        }
        let value = artifact_hex(&row[1], &format!("{path}[{index}].value"))?;
        previous = key.clone();
        output.push(ArtifactRow { key, value });
    }
    Ok(output)
}

fn checkpoint_from_artifact(root: &Value) -> Result<ConcreteCheckpointSource, String> {
    let value = field(root, "checkpoint", "recordingRoot")?;
    let checkpoint = object(value, "checkpoint")?;
    let expected = [
        "frameBytes",
        "height",
        "leafCount",
        "rootHash",
        "runtimeMachineLeaves",
        "stateRows",
    ];
    if checkpoint.len() != expected.len()
        || expected.iter().any(|name| !checkpoint.contains_key(*name))
    {
        return Err("RUNTIME_REPLAY_CHECKPOINT_FIELDS".into());
    }
    let height = checkpoint["height"]
        .as_u64()
        .filter(|height| *height > 0 && *height <= 9_007_199_254_740_991)
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_HEIGHT".to_string())?;
    let leaf_count = checkpoint["leafCount"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_LEAF_COUNT".to_string())?;
    let root_hash = artifact_hex(&checkpoint["rootHash"], "checkpoint.rootHash")?
        .try_into()
        .map_err(|_| "RUNTIME_REPLAY_CHECKPOINT_ROOT_HASH".to_string())?;
    let runtime_machine_leaves = artifact_rows(
        &checkpoint["runtimeMachineLeaves"],
        "checkpoint.runtimeMachineLeaves",
    )?
    .into_iter()
    .map(|row| (row.key, row.value))
    .collect::<Vec<_>>();
    if runtime_machine_leaves.len() != leaf_count {
        return Err("RUNTIME_REPLAY_CHECKPOINT_LEAF_COUNT_MISMATCH".into());
    }
    let state_rows = artifact_rows(&checkpoint["stateRows"], "checkpoint.stateRows")?
        .into_iter()
        .map(|row| (row.key, row.value))
        .collect::<BTreeMap<_, _>>();
    let source = ConcreteCheckpointSource {
        height,
        frame_bytes: artifact_hex(&checkpoint["frameBytes"], "checkpoint.frameBytes")?,
        root_hash,
        leaf_count,
        runtime_machine_leaves,
        state_rows,
    };
    verify_checkpoint_source(&source)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_SOURCE:{error}"))?;
    Ok(source)
}

fn text_field<'a>(
    value: &'a Map<String, Value>,
    name: &'static str,
    height: u64,
    index: usize,
) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("RUNTIME_REPLAY_ROUTE_FIELD:{height}:{index}:{name}"))
}

/// Routing is external configuration, not an execution oracle. The fixture's
/// already-durable flat outbox may therefore provide only the exact Entity ->
/// Runtime/signer bindings. No payload or proposal decision is consumed.
fn routes_from_wal(
    reader: &mut RuntimeWalReader,
    owner: &str,
    from: u64,
    to: u64,
) -> Result<EntityRouteTable, String> {
    let mut routes = BTreeMap::<String, (String, String)>::new();
    for height in from..=to {
        // Raw rows only: route discovery reads three configuration fields per
        // outbox row. Frame verification is not skipped anywhere it matters —
        // the replay loop re-reads and fully verifies every one of these
        // frames before applying it.
        let source = reader
            .raw_concrete_wal_rows(height)
            .map_err(|error| format!("RUNTIME_REPLAY_SOURCE:{height}:{error}"))?;
        for (index, bytes) in source.output_rows().iter().enumerate() {
            let value = decode_storage_payload(bytes)
                .map_err(|error| format!("RUNTIME_REPLAY_ROUTE_ROW:{height}:{index}:{error}"))?;
            let value = object(&value, "outboxRow")?;
            let Some(runtime_id) = value.get("runtimeId") else {
                continue;
            };
            let runtime_id = runtime_id
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("RUNTIME_REPLAY_ROUTE_FIELD:{height}:{index}:runtimeId"))?;
            let entity_id = text_field(value, "entityId", height, index)?.to_ascii_lowercase();
            if entity_id == owner {
                return Err(format!(
                    "RUNTIME_REPLAY_LOCAL_OUTPUT_PREBOUND:{height}:{index}"
                ));
            }
            let signer_id = text_field(value, "signerId", height, index)?.to_string();
            let route = (runtime_id.to_ascii_lowercase(), signer_id);
            if let Some(previous) = routes.insert(entity_id.clone(), route.clone())
                && previous != route
            {
                return Err(format!("RUNTIME_REPLAY_ROUTE_CONFLICT:{entity_id}"));
            }
        }
    }
    EntityRouteTable::new(
        routes
            .into_iter()
            .map(|(target_entity_id, route)| EntityRoute {
                target_entity_id,
                target_runtime_id: route.0,
                target_signer_id: route.1,
                websocket_url: Some("ws://127.0.0.1:1/ws".into()),
            }),
    )
    .map_err(|error| format!("RUNTIME_REPLAY_ROUTES:{error}"))
}

fn assert_source_commitments(
    height: u64,
    source: &xln_rscore_runtime::restore::ConcreteWalSource,
    actual: &RuntimeDurableCommitments,
) -> Result<(), String> {
    let expected = source.validated();
    if expected.height != height
        || actual.height != height
        || expected.frame_hash != actual.runtime_frame_hash
        || expected.output_count != source.outputs().len()
        || u64::try_from(expected.output_count).ok() != Some(actual.runtime_output_count)
        || expected.output_digest != actual.runtime_outputs_digest
    {
        return Err(format!(
            "RUNTIME_REPLAY_FRAME_MISMATCH:{height}:expectedFrame={}:actualFrame={}:expectedOut={}/{}:actualOut={}/{}",
            hex(&expected.frame_hash),
            hex(&actual.runtime_frame_hash),
            expected.output_count,
            hex(&expected.output_digest),
            actual.runtime_output_count,
            hex(&actual.runtime_outputs_digest),
        ));
    }
    Ok(())
}

fn add(value: &mut u64, amount: u64, field: &'static str) -> Result<(), String> {
    *value = value
        .checked_add(amount)
        .ok_or_else(|| format!("RUNTIME_REPLAY_COUNTER_OVERFLOW:{field}"))?;
    Ok(())
}

fn assert_checkpoint_runtime_root(source: &ConcreteCheckpointSource) -> Result<(), String> {
    verify_checkpoint_source(source)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_GRAPH:{error}"))?;
    let validated = validate_runtime_frame(&source.frame_bytes)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_FRAME:{error}"))?;
    let expected = validated
        .canonical_state_hash
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_RUNTIME_ROOT_MISSING".to_string())?;
    let frame = decode_storage_payload(&source.frame_bytes)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_FRAME_DECODE:{error}"))?;
    let rows = field(&frame, "canonicalEntityHashes", "checkpointFrame")?
        .as_array()
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_ENTITY_HASHES".to_string())?;
    if rows.len() != 1 {
        return Err(format!(
            "RUNTIME_REPLAY_CHECKPOINT_ENTITY_COUNT:{}",
            rows.len()
        ));
    }
    let row = object(&rows[0], "checkpointFrame.canonicalEntityHashes[0]")?;
    let entity_id = row
        .get("entityId")
        .and_then(Value::as_str)
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_ENTITY_ID".to_string())?
        .to_ascii_lowercase();
    let hash = row
        .get("hash")
        .and_then(Value::as_str)
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_ENTITY_ROOT".to_string())?
        .to_ascii_lowercase();
    let cell_count = row
        .get("cellCount")
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_ENTITY_CELL_COUNT".to_string())?;
    let actual = compute_canonical_runtime_state_hash(
        source.height,
        validated.timestamp,
        &[CanonicalRuntimeEntityHash {
            entity_id,
            hash,
            cell_count,
        }],
    )
    .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_RUNTIME_ROOT:{error}"))?;
    let expected = hex(&expected);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "RUNTIME_REPLAY_CHECKPOINT_RUNTIME_ROOT_MISMATCH:expected={expected}:actual={actual}"
        ))
    }
}

#[allow(clippy::too_many_arguments)]
pub fn replay_runtime_wal(
    reader: &mut RuntimeWalReader,
    recording: &Value,
    ts_parity_report: &Value,
    recording_manifest_hash: &str,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_label: &str,
    native_database: impl AsRef<Path>,
    from: u64,
    to: u64,
    workers: usize,
    diff_dir: &Path,
) -> Result<RuntimeReplayMetrics, String> {
    if from <= 1 || to < from || workers == 0 {
        return Err("RUNTIME_REPLAY_ARGUMENTS".into());
    }
    let native_database = native_database.as_ref();
    let setup_started = Instant::now();
    let expectations =
        ReplayExpectations::from_sources(recording, ts_parity_report, recording_manifest_hash)?;
    expectations.assert_exact_range(from, to)?;
    let checkpoint_height = from - 1;
    let checkpoint_source = checkpoint_from_artifact(recording)?;
    if checkpoint_source.height != checkpoint_height {
        return Err(format!(
            "RUNTIME_REPLAY_CHECKPOINT_HEIGHT:expected={checkpoint_height}:actual={}",
            checkpoint_source.height,
        ));
    }
    let source_frame_hash = validate_runtime_frame(&checkpoint_source.frame_bytes)
        .map_err(|error| format!("RUNTIME_REPLAY_SOURCE_CHECKPOINT:{error}"))?
        .frame_hash;
    assert_checkpoint_runtime_root(&checkpoint_source)?;
    let mut replay_limits = xln_rscore_runtime::RuntimeLimits::hlt();
    // Complete parity evidence requires a canonical Runtime root on every
    // recorded frame. Replay must project at that same cadence; the operator
    // env that selected it is intentionally not durable consensus state.
    replay_limits.canonical_hash_period_frames = 1;
    let configuration = ConcreteCheckpointConfiguration {
        runtime_seed: runtime_seed.to_string(),
        signer_derivation_label: entity_signer_label.to_string(),
        worker_count: workers,
        limits: replay_limits,
        swap_market: Arc::new(canonical_swap_market_policy()),
        expected_protocol_fingerprint: PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        board_delays: BoardDelays::default(),
    };
    let decoded = decode_offline_ts_import_checkpoint(
        checkpoint_source.clone(),
        configuration,
        MigrationOrigin::OfflineTsImport,
    )
    .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_DECODE:{error}"))?;
    let owner = decoded.entity_snapshot.entity_id.to_ascii_lowercase();
    let mut restored = restore_decoded_runtime_checkpoint(decoded)
        .map_err(|error| format!("RUNTIME_REPLAY_RESTORE:{error}"))?;
    restored
        .replica
        .durable
        .adopt_offline_import_lineage(MigrationOrigin::OfflineTsImport, source_frame_hash);
    // Validate-only replay reproduces the recorded frames bit-for-bit, so it
    // must run under the operator cadence the recording was produced with,
    // even on the offline-import binding where a live takeover would keep its
    // own limits instead.
    if let Some(period) = restored
        .replica
        .durable
        .runtime_config()
        .materialize_period_frames()
    {
        restored.replica.limits.checkpoint_period_frames = period;
    }
    if let Some(period) = restored
        .replica
        .durable
        .runtime_config()
        .canonical_hash_period_frames()
    {
        restored.replica.limits.canonical_hash_period_frames = period;
    }
    let checkpoint_period_frames = restored.replica.limits.checkpoint_period_frames;

    let routes = routes_from_wal(reader, &owner, from, to)?;
    let restart_routes = routes.clone();
    let checkpoint_commit = reader
        .native_checkpoint_import_from_source(checkpoint_source)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_IMPORT_SOURCE:{error}"))?;
    let mut store = NativeRuntimeStore::open(
        native_database,
        NativeStorageConfig {
            checkpoint_period_frames,
            // Production-shaped replay measures the exact H1 durability path,
            // including the disk barrier. The database is disposable, but
            // disabling fsync would hide the serial WAL/storage cost that the
            // benchmark exists to attribute.
            durable_fsync: true,
        },
    )
    .map_err(|error| format!("RUNTIME_REPLAY_NATIVE_STORE:{error}"))?;
    store
        .import_checkpoint(checkpoint_commit)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_IMPORT:{error}"))?;
    let mut processor = DurableRuntimeProcessor::new_replay_validate_only(
        restored.replica,
        store,
        routes,
        runtime_seed,
        RuntimeSignerLabel::new(runtime_signer_label)
            .map_err(|error| format!("RUNTIME_REPLAY_SIGNER_LABEL:{error}"))?,
    )
    .map_err(|error| format!("RUNTIME_REPLAY_PROCESSOR:{error}"))?;

    let initial_accounts_root = sole_entity_state(
        processor
            .replica()
            .map_err(|error| format!("RUNTIME_REPLAY_REPLICA:{error}"))?,
    )?
    .accounts_root;
    let mut metrics = RuntimeReplayMetrics {
        frames: 0,
        ingress: 0,
        direct_payments: 0,
        egress: 0,
        elapsed: Duration::ZERO,
        setup_elapsed: setup_started.elapsed(),
        engine_elapsed: Duration::ZERO,
        apply_elapsed: Duration::ZERO,
        projection_elapsed: Duration::ZERO,
        projection_input_elapsed: Duration::ZERO,
        projection_machine_elapsed: Duration::ZERO,
        projection_meta_elapsed: Duration::ZERO,
        projection_context_elapsed: Duration::ZERO,
        projection_checkpoint_elapsed: Duration::ZERO,
        projection_encode_elapsed: Duration::ZERO,
        storage_elapsed: Duration::ZERO,
        publication_elapsed: Duration::ZERO,
        storage_prepare_validate_elapsed: Duration::ZERO,
        storage_batch_build_elapsed: Duration::ZERO,
        storage_db_write_sync_elapsed: Duration::ZERO,
        storage_directory_sync_elapsed: Duration::ZERO,
        storage_post_commit_elapsed: Duration::ZERO,
        barrier_wait_for_previous_commit_elapsed: Duration::ZERO,
        committer_busy_elapsed: Duration::ZERO,
        committer_idle_elapsed: Duration::ZERO,
        apply_profile: xln_rscore_runtime::RuntimeApplyPhaseProfile::default(),
        effect_digests_compared: 0,
        event_digests_compared: 0,
        local_continuations_compared: 0,
        outbox_digests_compared: 0,
        post_state_hashes_compared: 0,
        // The independently verified materialized checkpoint graph is the one
        // explicit canonical Runtime root in this below-cadence replay range.
        runtime_roots_compared: 1,
        accounts_root: hex(&initial_accounts_root),
        account_phase_metrics: Vec::new(),
    };

    let replay_started = Instant::now();
    let mut committed_next = from;
    // Frame N+1..N+DEPTH raw rows are read ahead on this thread (cheap
    // LevelDB gets) while a decode thread runs the exact parse, hash and
    // digest verification `concrete_wal_source` always ran. Nothing about
    // what is verified changes — only which thread pays the CPU.
    const PIPELINE_DEPTH: usize = 3;
    let loop_result: Result<(), String> = std::thread::scope(|scope| {
        // Both channels live inside this scope so an early error return drops
        // them, which unblocks and terminates the decode thread before join.
        let (raw_tx, raw_rx) =
            std::sync::mpsc::sync_channel::<xln_rscore_runtime::RawConcreteWalRows>(PIPELINE_DEPTH);
        let (decoded_tx, decoded_rx) = std::sync::mpsc::sync_channel::<
            Result<(ConcreteWalSource, DecodedRuntimeWalFrame), String>,
        >(PIPELINE_DEPTH);
        scope.spawn(move || {
            while let Ok(raw) = raw_rx.recv() {
                let height = raw.height();
                let item = xln_rscore_runtime::concrete_wal_source_from_raw(raw)
                    .map_err(|error| format!("RUNTIME_REPLAY_SOURCE:{height}:{error}"))
                    .and_then(|source| {
                        // The decoded frame context's finalized_j_height is a
                        // pass-through copy; the consumer overwrites it with
                        // the live replica value before applying.
                        decode_concrete_runtime_wal_frame(&source, 0)
                            .map(|decoded| (source, decoded))
                            .map_err(|error| format!("RUNTIME_REPLAY_WAL_DECODE:{height}:{error}"))
                    });
                if decoded_tx.send(item).is_err() {
                    return;
                }
            }
        });
        let mut send_raw = |next_read: u64| -> Result<(), String> {
            let raw = reader
                .raw_concrete_wal_rows(next_read)
                .map_err(|error| format!("RUNTIME_REPLAY_READ:{next_read}:{error}"))?;
            raw_tx
                .send(raw)
                .map_err(|_| "RUNTIME_REPLAY_PIPELINE_CLOSED".to_string())
        };
        let mut next_read = from;
        while next_read <= to && next_read - from < PIPELINE_DEPTH as u64 {
            send_raw(next_read)?;
            next_read += 1;
        }
        for height in from..=to {
            let received = decoded_rx
                .recv()
                .map_err(|_| format!("RUNTIME_REPLAY_PIPELINE_CLOSED:{height}"))?;
            let (source, mut decoded) = received?;
            if next_read <= to {
                send_raw(next_read)?;
                next_read += 1;
            }
            expectations.assert_timestamp(height, decoded.timestamp)?;
            let expected_root = expectations.expected_canonical_state_hash(height)?;
            let source_root = decoded
                .canonical_state_hash
                .ok_or_else(|| format!("RUNTIME_REPLAY_RUNTIME_ROOT_MISSING:{height}"))?;
            if source_root != expected_root {
                return Err(format!(
                    "RUNTIME_REPLAY_RUNTIME_ROOT_MISMATCH:{height}:expected={}:actual={}",
                    hex(&expected_root),
                    hex(&source_root),
                ));
            }
            add(&mut metrics.runtime_roots_compared, 1, "runtimeRoots")?;
            let input = &mut decoded.input;
            add(
                &mut metrics.direct_payments,
                direct_payment_count(input)?,
                "directPayments",
            )?;
            let ingress = input.entity_inputs.iter().try_fold(0_u64, |total, input| {
                let count = u64::try_from(input.account_input_count())
                    .map_err(|_| "RUNTIME_REPLAY_INGRESS_OVERFLOW".to_string())?;
                total
                    .checked_add(count)
                    .ok_or_else(|| "RUNTIME_REPLAY_INGRESS_OVERFLOW".to_string())
            })?;
            processor
                .reconcile_exact_replay_input(input)
                .map_err(|error| format!("RUNTIME_REPLAY_RECONCILE:{height}:{error}"))?;

            let started = Instant::now();
            let report = processor
                .process_exact_replay(decoded.input)
                .map_err(|error| format!("RUNTIME_REPLAY_PROCESS:{height}:{error}"))?;
            metrics.engine_elapsed += started.elapsed();
            metrics.apply_elapsed += report.timings.apply;
            metrics.projection_elapsed += report.timings.projection;
            add_wall_decomposition(&mut metrics, &report);
            // The committer pipelines exactly one frame: this call reports
            // the previous frame's completed commit. Every replayed height
            // must still commit exactly once, in order; the terminal
            // `sync_committed` below closes the final gap.
            if let Some(committed) = report.durable_height {
                if committed != committed_next {
                    return Err(format!(
                        "RUNTIME_REPLAY_DURABLE_HEIGHT:{height}:committed={committed}:expected={committed_next}",
                    ));
                }
                committed_next = committed
                    .checked_add(1)
                    .ok_or_else(|| "RUNTIME_REPLAY_DURABLE_HEIGHT_OVERFLOW".to_string())?;
            }
            let commitments = report
                .commitments
                .as_ref()
                .ok_or_else(|| format!("RUNTIME_REPLAY_COMMITMENTS_MISSING:{height}"))?;
            if let Err(summary) = assert_source_commitments(height, &source, commitments) {
                let replica = processor
                    .replica()
                    .map_err(|error| format!("{summary}:RUNTIME_REPLAY_DIFF_REPLICA:{error}"))?;
                let diagnostic_entity_key = replica.e_replicas.keys().next().cloned();
                let diagnostic_account_ids = report
                    .account_commits
                    .iter()
                    .map(|commit| commit.account_id)
                    .collect::<Vec<_>>();
                let entity_replica =
                    sole_entity_replica(replica).map_err(|error| format!("{summary}:{error}"))?;
                let entity_state =
                    sole_entity_state(replica).map_err(|error| format!("{summary}:{error}"))?;
                let actual_sections = entity_replica
                    .entity_consensus
                    .state
                    .sections
                    .iter()
                    .map(|section| format!("{}={}", section.field, section.digest))
                    .collect::<Vec<_>>()
                    .join(",");
                eprintln!("RUNTIME_REPLAY_ACTUAL_ENTITY_SECTIONS:{height}:{actual_sections}");
                // XLN_RSCORE_DEBUG_EVENTS=1 dumps the certified frame's events so a
                // TS `--diagnostic-events-height` run can be diffed line by line.
                let debug_events = std::env::var_os("XLN_RSCORE_DEBUG_EVENTS")
                    .and(entity_replica.entity_consensus.certified_frame_head.as_ref());
                if let Some(head) = debug_events {
                    for event in &head.frame.events {
                        let message = match event {
                            xln_rscore_entity_kernel::EntityFrameEvent::Status { message } => message.clone(),
                            xln_rscore_entity_kernel::EntityFrameEvent::Text { validator_id, message } => {
                                format!("{validator_id}:{message}")
                            }
                        };
                        eprintln!("RUNTIME_REPLAY_ACTUAL_ENTITY_EVENT:{height}:{message}");
                    }
                }
                if let Some(orderbook) = entity_state.entity.orderbook.as_ref() {
                    let book_digests = orderbook
                        .books
                        .iter()
                        .map(|(pair, book)| {
                            xln_rscore_entity_kernel::compute_book_commitment_hash(book)
                                .map(|digest| format!(
                                    "{pair}={digest}:bucket={}:max={}:stp={}:bid={}:ask={}:next={}:trades={}:qty={}:last={}:usdAsk={}:event={}",
                                    book.bucket_width_ticks,
                                    book.max_orders,
                                    book.stp_policy,
                                    book.bid_pages_root(),
                                    book.ask_pages_root(),
                                    book.next_seq,
                                    book.trade_count,
                                    book.trade_qty_sum,
                                    book.last_trade_price_ticks,
                                    book.last_accepted_usd_ask_price_ticks,
                                    book.event_hash,
                                ))
                                .map_err(|error| {
                                    format!("{summary}:RUNTIME_REPLAY_ORDERBOOK_DIAGNOSTIC:{error}")
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()?
                        .join(",");
                    eprintln!("RUNTIME_REPLAY_ACTUAL_ORDERBOOK_BOOKS:{height}:{book_digests}");
                }
                eprintln!(
                    "RUNTIME_REPLAY_ACTUAL_ENTITY_COMMAND_NONCES:{height}:{:?}",
                    entity_state.entity.entity_command_nonces,
                );
                eprintln!(
                    "RUNTIME_REPLAY_ACTUAL_ENTITY_CRONTAB:{height}:{:?}",
                    entity_state.entity.crontab,
                );
                eprintln!(
                    "RUNTIME_REPLAY_ACTUAL_ENTITY_J_BATCH:{height}:{:?}",
                    entity_state.entity.j_batch_state,
                );
                if let Some(j_batch_state) = entity_state.entity.j_batch_state.as_ref() {
                    let canonical =
                        xln_rscore_entity_kernel::canonical_j_batch_state(j_batch_state)
                            .map_err(|error| format!("{summary}:RUNTIME_REPLAY_J_BATCH:{error}"))?;
                    let tagged = xln_rscore_runtime::tagged_json_from_canonical_value(&canonical)
                        .map_err(|error| {
                        format!("{summary}:RUNTIME_REPLAY_J_BATCH_JSON:{error}")
                    })?;
                    eprintln!("RUNTIME_REPLAY_ACTUAL_ENTITY_J_BATCH_JSON:{height}:{tagged}");
                }
                if let Ok(entity_commitment) = sole_entity_commitment(commitments) {
                    eprintln!(
                        "RUNTIME_REPLAY_ACTUAL_ENTITY_FRAME:{height}:hash={}:root={}",
                        hex(&entity_commitment.certified_frame_hash),
                        hex(&entity_commitment.state_root),
                    );
                } else {
                    eprintln!(
                        "RUNTIME_REPLAY_ACTUAL_ENTITY_COMMITMENTS:{height}:{}",
                        commitments.entities.len(),
                    );
                }
                let actual_replica_meta = entity_replica.replica_metadata().clone();
                let actual_entity_sections = Value::Object(Map::from_iter(
                    entity_replica
                        .entity_consensus
                        .state
                        .sections
                        .iter()
                        .map(|section| {
                            (section.field.clone(), Value::String(section.digest.clone()))
                        }),
                ));
                let actual = processor
                    .read_durable_frame(height)
                    .map_err(|error| format!("{summary}:RUNTIME_REPLAY_DIFF_READ:{error}"))?;
                let diagnostic = write_runtime_replay_diff(RuntimeReplayDiffInput {
                    directory: diff_dir,
                    height,
                    expected: &source,
                    actual: &actual,
                    actual_replica_meta: &actual_replica_meta,
                    actual_entity_sections: &actual_entity_sections,
                    actual_commitments: commitments,
                    actual_account_commits: &report.account_commits,
                })
                .map_err(|error| format!("{summary}:RUNTIME_REPLAY_DIFF_WRITE:{error}"))?;
                // Side-by-side leaf diagnostics: TypeScript prints the same
                // projection with `--diagnostic-account` at this height.
                if let Some(entity_key) = diagnostic_entity_key {
                    for account_id in diagnostic_account_ids {
                        let rendered =
                            match processor.account_envelope_fields(&entity_key, account_id) {
                                Ok(Some(fields)) => {
                                    xln_rscore_runtime::tagged_json_from_canonical_value(
                                        &xln_rscore_protocol::CanonicalValue::Object(fields),
                                    )
                                    .map(|value| value.to_string())
                                    .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"))
                                }
                                Ok(None) => "null".to_string(),
                                Err(error) => format!("{{\"error\":\"{error}\"}}"),
                            };
                        eprintln!(
                            "RUNTIME_REPLAY_ACTUAL_ACCOUNT_LEAF:{height}:{account_id:?}:{rendered}"
                        );
                    }
                }
                return Err(format!(
                    "{summary}:first={}:diff={}",
                    diagnostic.first_difference,
                    diagnostic.path.display(),
                ));
            }
            expectations.assert_durable(height, commitments)?;
            expectations.assert_effects(height, commitments)?;
            expectations.assert_events(height, commitments)?;
            expectations.assert_local_continuations(height, &report.local_continuations)?;

            add(&mut metrics.frames, 1, "frames")?;
            add(&mut metrics.ingress, ingress, "ingress")?;
            add(
                &mut metrics.egress,
                u64::try_from(report.outputs_published)
                    .map_err(|_| "RUNTIME_REPLAY_EGRESS_OVERFLOW".to_string())?,
                "egress",
            )?;
            add(&mut metrics.effect_digests_compared, 1, "effects")?;
            add(&mut metrics.event_digests_compared, 1, "events")?;
            add(
                &mut metrics.local_continuations_compared,
                1,
                "localContinuations",
            )?;
            add(&mut metrics.outbox_digests_compared, 1, "outbox")?;
            add(&mut metrics.post_state_hashes_compared, 1, "postState")?;
            if !commitments.entities.is_empty() {
                metrics.accounts_root = hex(&sole_entity_commitment(commitments)?.accounts_root);
            }
        }
        Ok(())
    });
    loop_result?;
    // Close the one-frame committer pipeline inside the timed window: the
    // final frame is only counted replayed once its commit outcome landed.
    let final_commit = processor
        .sync_committed()
        .map_err(|error| format!("RUNTIME_REPLAY_FINAL_COMMIT:{error}"))?;
    if let Some(final_commit) = final_commit {
        let committed = final_commit
            .durable_height
            .ok_or_else(|| "RUNTIME_REPLAY_FINAL_COMMIT_HEIGHT".to_string())?;
        if committed != committed_next {
            return Err(format!(
                "RUNTIME_REPLAY_FINAL_COMMIT_HEIGHT:committed={committed}:expected={committed_next}",
            ));
        }
        committed_next = committed
            .checked_add(1)
            .ok_or_else(|| "RUNTIME_REPLAY_DURABLE_HEIGHT_OVERFLOW".to_string())?;
        metrics.egress = metrics
            .egress
            .checked_add(
                u64::try_from(final_commit.outputs_published)
                    .map_err(|_| "RUNTIME_REPLAY_EGRESS_OVERFLOW".to_string())?,
            )
            .ok_or_else(|| "RUNTIME_REPLAY_EGRESS_OVERFLOW".to_string())?;
        add_wall_decomposition(&mut metrics, &final_commit);
    }
    if committed_next != to + 1 {
        return Err(format!(
            "RUNTIME_REPLAY_COMMIT_GAP:committed_through={}:expected={to}",
            committed_next.saturating_sub(1),
        ));
    }
    metrics.elapsed = replay_started.elapsed();
    metrics.account_phase_metrics = sole_entity_replica(
        processor
            .replica()
            .map_err(|error| format!("RUNTIME_REPLAY_PHASE_METRICS:{error}"))?,
    )?
    .accounts
    .account_phase_metrics();

    let expected_frames = to - from + 1;
    if metrics.frames != expected_frames
        || metrics.effect_digests_compared != expected_frames
        || metrics.event_digests_compared != expected_frames
        || metrics.local_continuations_compared != expected_frames
        || metrics.outbox_digests_compared != expected_frames
        || metrics.post_state_hashes_compared != expected_frames
        || metrics.runtime_roots_compared == 0
    {
        return Err(format!(
            "RUNTIME_REPLAY_PARITY_UNARMED:frames={}/{}:effects={}:events={}:localContinuations={}:outbox={}:postState={}:runtimeRoots={}",
            metrics.frames,
            expected_frames,
            metrics.effect_digests_compared,
            metrics.event_digests_compared,
            metrics.local_continuations_compared,
            metrics.outbox_digests_compared,
            metrics.post_state_hashes_compared,
            metrics.runtime_roots_compared,
        ));
    }
    let expected_height = processor
        .replica()
        .map_err(|error| format!("RUNTIME_REPLAY_FINAL_REPLICA:{error}"))?
        .state
        .height;
    let expected_accounts_root = sole_entity_state(
        processor
            .replica()
            .map_err(|error| format!("RUNTIME_REPLAY_FINAL_REPLICA:{error}"))?,
    )?
    .accounts_root;
    let expected_lineage = processor
        .replica()
        .map_err(|error| format!("RUNTIME_REPLAY_FINAL_REPLICA:{error}"))?
        .durable
        .prev_frame_hash();
    drop(processor);
    let restarted = crate::native_runtime::restore_native_replay_processor(
        native_database,
        runtime_seed,
        runtime_signer_label,
        entity_signer_label,
        workers,
        restart_routes,
        // The migration boundary was the imported TS checkpoint above. By
        // this point the native store owns a later materialized checkpoint;
        // requiring the retired TS 0x22 rows again would turn an ordinary
        // same-engine restart into a second migration and reject its one
        // canonical path-keyed Account graph.
        None,
    )?;
    let actual = restarted
        .processor
        .replica()
        .map_err(|error| format!("RUNTIME_REPLAY_RESTART_REPLICA:{error}"))?;
    let actual_accounts_root = sole_entity_state(actual)?.accounts_root;
    if actual.state.height != expected_height
        || actual_accounts_root != expected_accounts_root
        || actual.durable.prev_frame_hash() != expected_lineage
    {
        return Err(format!(
            "RUNTIME_REPLAY_RESTART_MISMATCH:height={}/{}:accounts={}/{}:lineage={}/{}",
            actual.state.height,
            expected_height,
            hex(&actual_accounts_root),
            hex(&expected_accounts_root),
            hex(&actual.durable.prev_frame_hash()),
            hex(&expected_lineage),
        ));
    }
    Ok(metrics)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}
