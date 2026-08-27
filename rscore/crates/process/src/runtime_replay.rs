//! Exact native replay of canonical TypeScript Runtime WAL frames.
//!
//! Replay restores the real resident Runtime from one materialized checkpoint,
//! imports that same checkpoint into the native durable store, and then feeds
//! exact persisted Runtime inputs through `DurableRuntimeProcessor`. Recorded
//! commitments are assertions only: they never select proposals or repair state.

mod diff;
mod evidence;
mod expectations;
mod wal_input;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use xln_rscore_engine::BoardDelays;
use xln_rscore_runtime::processor::{EntityRoute, EntityRouteTable};
use xln_rscore_runtime::restore::{
    ConcreteCheckpointConfiguration, ConcreteCheckpointSource, MigrationOrigin,
    decode_concrete_runtime_checkpoint, decode_offline_ts_import_checkpoint,
    restore_decoded_runtime_checkpoint, verify_checkpoint_source,
};
use xln_rscore_runtime::storage::native::{
    NativeRuntimeStore, NativeStorageConfig, validate_runtime_frame,
};
use xln_rscore_runtime::{
    CanonicalRuntimeEntityHash, DurableRuntimeProcessor, RuntimeDurableCommitments,
    RuntimeSignerLabel, RuntimeWalReader, canonical_swap_market_policy,
    compute_canonical_runtime_state_hash, decode_storage_payload,
};

use crate::PAYMENT_PROFILE_BINDING;
use diff::{RuntimeReplayDiffInput, write_runtime_replay_diff};
use evidence::{assert_entity_events, entity_event_evidence, entity_history_link};
use expectations::ReplayExpectations;
use wal_input::{decode_wal_runtime_input, reconcile_recorded_input_with_resident_queue};

pub struct RuntimeReplayMetrics {
    pub frames: u64,
    pub ingress: u64,
    pub egress: u64,
    pub elapsed: Duration,
    pub setup_elapsed: Duration,
    pub engine_elapsed: Duration,
    pub account_roots_compared: u64,
    pub accounts_forest_roots_compared: u64,
    pub entity_roots_compared: u64,
    pub event_digests_compared: u64,
    pub effect_digests_compared: u64,
    pub outbox_digests_compared: u64,
    pub post_state_hashes_compared: u64,
    pub runtime_roots_compared: u64,
    pub accounts_root: String,
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

fn assert_native_scope(recording: &Value) -> Result<(), String> {
    let policy = object(
        field(recording, "featurePolicy", "recordingRoot")?,
        "featurePolicy",
    )?;
    for field in ["disputes", "lending", "crossJ", "hubRebalance"] {
        if policy.get(field).and_then(Value::as_str) != Some("disabled") {
            return Err(format!("RUNTIME_REPLAY_FEATURE_NOT_DISABLED:{field}"));
        }
    }
    Ok(())
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
        let source = reader
            .concrete_wal_source(height)
            .map_err(|error| format!("RUNTIME_REPLAY_SOURCE:{height}:{error}"))?;
        for (index, bytes) in source.outputs.iter().enumerate() {
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
                websocket_url: "ws://127.0.0.1:1/ws".into(),
            }),
    )
    .map_err(|error| format!("RUNTIME_REPLAY_ROUTES:{error}"))
}

fn one_entity_context(
    source: &xln_rscore_runtime::restore::ConcreteWalSource,
    height: u64,
) -> Result<&Value, String> {
    if source.entity_contexts.len() != 1 {
        return Err(format!(
            "RUNTIME_REPLAY_CONTEXT_COUNT:{height}:{}",
            source.entity_contexts.len(),
        ));
    }
    source
        .entity_contexts
        .values()
        .next()
        .map(|context| &context.value)
        .ok_or_else(|| format!("RUNTIME_REPLAY_CONTEXT_MISSING:{height}"))
}

fn assert_source_commitments(
    height: u64,
    source: &xln_rscore_runtime::restore::ConcreteWalSource,
    actual: &RuntimeDurableCommitments,
) -> Result<(), String> {
    let expected = validate_runtime_frame(&source.frame_bytes)
        .map_err(|error| format!("RUNTIME_REPLAY_FRAME:{height}:{error}"))?;
    if expected.height != height
        || actual.height != height
        || expected.frame_hash != actual.runtime_frame_hash
        || expected.output_count != source.outputs.len()
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
    let machine = verify_checkpoint_source(source)
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
        Some(&machine),
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
    state_reader: &mut RuntimeWalReader,
    recording: &Value,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_label: &str,
    native_database: impl AsRef<Path>,
    from: u64,
    to: u64,
    workers: usize,
    migration_origin: Option<MigrationOrigin>,
    diff_dir: &Path,
) -> Result<RuntimeReplayMetrics, String> {
    if from <= 1 || to < from || workers == 0 {
        return Err("RUNTIME_REPLAY_ARGUMENTS".into());
    }
    assert_native_scope(recording)?;
    let setup_started = Instant::now();
    let expectations = ReplayExpectations::from_recording(recording)?;
    expectations.assert_exact_range(from, to)?;
    let checkpoint_height = from - 1;

    let checkpoint_source = reader
        .concrete_checkpoint_source(state_reader, checkpoint_height)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_SOURCE:{error}"))?;
    assert_checkpoint_runtime_root(&checkpoint_source)?;
    let configuration = ConcreteCheckpointConfiguration {
        runtime_seed: runtime_seed.to_string(),
        signer_derivation_label: entity_signer_label.to_string(),
        worker_count: workers,
        limits: xln_rscore_runtime::RuntimeLimits::hlt(),
        swap_market: Arc::new(canonical_swap_market_policy()),
        expected_protocol_fingerprint: PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        board_delays: BoardDelays::default(),
    };
    let decoded = match migration_origin {
        Some(origin) => {
            decode_offline_ts_import_checkpoint(checkpoint_source, configuration, origin)
        }
        None => decode_concrete_runtime_checkpoint(checkpoint_source, configuration),
    }
    .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_DECODE:{error}"))?;
    let owner = decoded.entity_snapshot.entity_id.to_ascii_lowercase();
    let owner_bytes = decoded.stored_accounts.owner_entity_id;
    let context_policy = decoded.entity_context_policy.clone();
    let restored = restore_decoded_runtime_checkpoint(decoded)
        .map_err(|error| format!("RUNTIME_REPLAY_RESTORE:{error}"))?;
    let checkpoint_period_frames = restored.replica.limits.checkpoint_period_frames;

    let routes = routes_from_wal(reader, &owner, from, to)?;
    let history = reader
        .entity_frames_by_runtime_height(from, to)
        .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_HISTORY:{error}"))?;
    let events = entity_event_evidence(&history, &owner)?;

    let checkpoint_commit = reader
        .native_checkpoint_import_frame(state_reader, checkpoint_height)
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_IMPORT_SOURCE:{error}"))?;
    let mut store = NativeRuntimeStore::open(
        native_database,
        NativeStorageConfig {
            checkpoint_period_frames,
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

    let initial_accounts_root = processor
        .replica()
        .map_err(|error| format!("RUNTIME_REPLAY_REPLICA:{error}"))?
        .state
        .accounts_root;
    let mut metrics = RuntimeReplayMetrics {
        frames: 0,
        ingress: 0,
        egress: 0,
        elapsed: Duration::ZERO,
        setup_elapsed: setup_started.elapsed(),
        engine_elapsed: Duration::ZERO,
        account_roots_compared: 0,
        accounts_forest_roots_compared: 0,
        entity_roots_compared: 0,
        event_digests_compared: 0,
        effect_digests_compared: 0,
        outbox_digests_compared: 0,
        post_state_hashes_compared: 0,
        // The independently verified materialized checkpoint graph is the one
        // explicit canonical Runtime root in this below-cadence replay range.
        runtime_roots_compared: 1,
        accounts_root: hex(&initial_accounts_root),
    };

    let replay_started = Instant::now();
    for height in from..=to {
        let source = reader
            .concrete_wal_source(height)
            .map_err(|error| format!("RUNTIME_REPLAY_SOURCE:{height}:{error}"))?;
        if let Some(expected_root) = expectations.expected_runtime_state_hash(height)? {
            let source_root = validate_runtime_frame(&source.frame_bytes)
                .map_err(|error| format!("RUNTIME_REPLAY_FRAME:{height}:{error}"))?
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
        }
        let frame = xln_rscore_runtime::restore::verify_wal_source(&source)
            .map_err(|error| format!("RUNTIME_REPLAY_SOURCE_VERIFY:{height}:{error}"))?;
        let timestamp = frame
            .as_object()
            .and_then(|value| value.get("timestamp"))
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("RUNTIME_REPLAY_TIMESTAMP:{height}"))?;
        expectations.assert_timestamp(height, timestamp)?;
        let finalized_j_height = processor
            .replica()
            .map_err(|error| format!("RUNTIME_REPLAY_REPLICA:{height}:{error}"))?
            .state
            .finalized_j_height;
        let mut input = decode_wal_runtime_input(
            &frame,
            one_entity_context(&source, height)?,
            &context_policy,
            finalized_j_height,
            false,
        )?;
        let ingress = input.entity_inputs.iter().try_fold(0_u64, |total, input| {
            let count = u64::try_from(input.account_input_count())
                .map_err(|_| "RUNTIME_REPLAY_INGRESS_OVERFLOW".to_string())?;
            total
                .checked_add(count)
                .ok_or_else(|| "RUNTIME_REPLAY_INGRESS_OVERFLOW".to_string())
        })?;
        let resident_inputs_reused = {
            let replica = processor
                .replica()
                .map_err(|error| format!("RUNTIME_REPLAY_REPLICA:{height}:{error}"))?;
            reconcile_recorded_input_with_resident_queue(
                &mut input,
                replica.mempool.pending_entity_inputs(),
            )
        };
        if resident_inputs_reused > 0 {
            eprintln!(
                "RUNTIME_REPLAY_INPUT_RECONCILED:{height}:resident={resident_inputs_reused}:new={}",
                input.entity_inputs.len(),
            );
        }

        let started = Instant::now();
        let report = processor
            .process(input)
            .map_err(|error| format!("RUNTIME_REPLAY_PROCESS:{height}:{error}"))?;
        metrics.engine_elapsed += started.elapsed();
        if report.durable_height != Some(height) {
            return Err(format!(
                "RUNTIME_REPLAY_DURABLE_HEIGHT:{height}:{:?}",
                report.durable_height,
            ));
        }
        let commitments = report
            .commitments
            .as_ref()
            .ok_or_else(|| format!("RUNTIME_REPLAY_COMMITMENTS_MISSING:{height}"))?;
        if let Err(summary) = assert_source_commitments(height, &source, commitments) {
            let replica = processor
                .replica()
                .map_err(|error| format!("{summary}:RUNTIME_REPLAY_DIFF_REPLICA:{error}"))?;
            let actual_sections = replica
                .entity_consensus
                .state
                .sections
                .iter()
                .map(|section| format!("{}={}", section.field, section.digest))
                .collect::<Vec<_>>()
                .join(",");
            eprintln!("RUNTIME_REPLAY_ACTUAL_ENTITY_SECTIONS:{height}:{actual_sections}");
            eprintln!(
                "RUNTIME_REPLAY_ACTUAL_ENTITY_COMMAND_NONCES:{height}:{:?}",
                replica.state.entity.entity_command_nonces,
            );
            eprintln!(
                "RUNTIME_REPLAY_ACTUAL_ENTITY_FRAME:{height}:hash={}:root={}",
                hex(&commitments.certified_entity_frame_hash),
                hex(&commitments.entity_state_root),
            );
            let actual_replica_meta = replica.replica_metadata().clone();
            let actual_entity_sections = Value::Object(Map::from_iter(
                replica
                    .entity_consensus
                    .state
                    .sections
                    .iter()
                    .map(|section| (section.field.clone(), Value::String(section.digest.clone()))),
            ));
            let expected_entity_link = entity_history_link(&history, height, &owner)?.clone();
            let actual = processor
                .read_durable_frame(height)
                .map_err(|error| format!("{summary}:RUNTIME_REPLAY_DIFF_READ:{error}"))?;
            let diagnostic = write_runtime_replay_diff(RuntimeReplayDiffInput {
                directory: diff_dir,
                height,
                expected: &source,
                actual: &actual,
                recording,
                expected_entity_link: &expected_entity_link,
                actual_replica_meta: &actual_replica_meta,
                actual_entity_sections: &actual_entity_sections,
                actual_commitments: commitments,
            })
            .map_err(|error| format!("{summary}:RUNTIME_REPLAY_DIFF_WRITE:{error}"))?;
            return Err(format!(
                "{summary}:first={}:diff={}",
                diagnostic.first_difference,
                diagnostic.path.display(),
            ));
        }
        expectations.assert_durable(height, commitments)?;
        let entity_height = processor
            .replica()
            .map_err(|error| format!("RUNTIME_REPLAY_REPLICA:{height}:{error}"))?
            .state
            .entity
            .height;
        expectations.assert_entity(height, owner_bytes, entity_height, commitments)?;
        let account_count = expectations.assert_accounts(height, &report.account_commits)?;
        assert_entity_events(height, events.get(&height), commitments)?;
        expectations.assert_effects(height, commitments)?;

        add(&mut metrics.frames, 1, "frames")?;
        add(&mut metrics.ingress, ingress, "ingress")?;
        add(
            &mut metrics.egress,
            u64::try_from(report.outputs_published)
                .map_err(|_| "RUNTIME_REPLAY_EGRESS_OVERFLOW".to_string())?,
            "egress",
        )?;
        add(
            &mut metrics.account_roots_compared,
            account_count,
            "accountRoots",
        )?;
        add(
            &mut metrics.accounts_forest_roots_compared,
            1,
            "accountsForestRoots",
        )?;
        add(&mut metrics.entity_roots_compared, 1, "entityRoots")?;
        add(&mut metrics.event_digests_compared, 1, "events")?;
        add(&mut metrics.effect_digests_compared, 1, "effects")?;
        add(&mut metrics.outbox_digests_compared, 1, "outbox")?;
        add(&mut metrics.post_state_hashes_compared, 1, "postState")?;
        metrics.accounts_root = hex(&commitments.accounts_root);
    }
    metrics.elapsed = replay_started.elapsed();

    let expected_frames = to - from + 1;
    if metrics.frames != expected_frames
        || metrics.accounts_forest_roots_compared != expected_frames
        || metrics.entity_roots_compared != expected_frames
        || metrics.event_digests_compared != expected_frames
        || metrics.effect_digests_compared != expected_frames
        || metrics.outbox_digests_compared != expected_frames
        || metrics.post_state_hashes_compared != expected_frames
        || metrics.runtime_roots_compared == 0
    {
        return Err(format!(
            "RUNTIME_REPLAY_PARITY_UNARMED:frames={}/{}:forest={}:entity={}:events={}:effects={}:outbox={}:postState={}:runtimeRoots={}",
            metrics.frames,
            expected_frames,
            metrics.accounts_forest_roots_compared,
            metrics.entity_roots_compared,
            metrics.event_digests_compared,
            metrics.effect_digests_compared,
            metrics.outbox_digests_compared,
            metrics.post_state_hashes_compared,
            metrics.runtime_roots_compared,
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
