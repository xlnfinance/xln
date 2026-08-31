//! Replay one production-native WAL range from an independent base DB copy.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use xln_rscore_runtime::decode_storage_payload;
use xln_rscore_runtime::processor::{EntityRoute, EntityRouteTable};
use xln_rscore_runtime::restore::{
    concrete_wal_source_from_native, decode_concrete_runtime_wal_frame,
};
use xln_rscore_runtime::storage::native::{NativeRuntimeStore, NativeStorageConfig};

use super::{
    assert_source_commitments, direct_payment_count, hex, sole_entity_commitment,
    sole_entity_replica, sole_entity_state,
};
use crate::native_genesis::{NativeGenesisConfig, create_native_genesis_replay_processor};

#[derive(Debug)]
pub struct NativeV1ReplayMetrics {
    pub frames: u64,
    pub entity_inputs: u64,
    pub account_inputs: u64,
    pub direct_payments: u64,
    pub outputs: u64,
    pub elapsed: Duration,
    pub apply: Duration,
    pub projection: Duration,
    pub storage: Duration,
    pub publication: Duration,
    pub accounts_root: String,
    pub transcript_digest: String,
    pub account_phase_metrics: Vec<xln_rscore_batch::AccountPhaseMetric>,
}

fn add(total: &mut u64, value: usize, label: &str) -> Result<(), String> {
    let value = u64::try_from(value).map_err(|_| format!("NATIVE_REPLAY_COUNT:{label}"))?;
    *total = total
        .checked_add(value)
        .ok_or_else(|| format!("NATIVE_REPLAY_COUNT:{label}"))?;
    Ok(())
}

fn replay_routes(
    source: &mut NativeRuntimeStore,
    source_height: u64,
) -> Result<EntityRouteTable, String> {
    let mut routes = BTreeMap::<String, (String, String)>::new();
    for height in 1..=source_height {
        let frame = source
            .read_durable_frame(height)
            .map_err(|error| format!("NATIVE_REPLAY_ROUTE_SOURCE:{height}:{error}"))?;
        for (index, bytes) in frame.outputs.iter().enumerate() {
            let value = decode_storage_payload(bytes)
                .map_err(|error| format!("NATIVE_REPLAY_ROUTE_DECODE:{height}:{index}:{error}"))?;
            let Some(row) = value.as_object() else {
                return Err(format!("NATIVE_REPLAY_ROUTE_ROW:{height}:{index}"));
            };
            let Some(runtime_id) = row.get("runtimeId") else {
                continue;
            };
            let field = |name: &str| {
                row.get(name)
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_ascii_lowercase)
                    .ok_or_else(|| format!("NATIVE_REPLAY_ROUTE_FIELD:{height}:{index}:{name}"))
            };
            let entity_id = field("entityId")?;
            let route = (
                runtime_id
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(str::to_ascii_lowercase)
                    .ok_or_else(|| {
                        format!("NATIVE_REPLAY_ROUTE_FIELD:{height}:{index}:runtimeId")
                    })?,
                field("signerId")?,
            );
            if let Some(previous) = routes.insert(entity_id.clone(), route.clone())
                && previous != route
            {
                return Err(format!("NATIVE_REPLAY_ROUTE_CONFLICT:{entity_id}"));
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
    .map_err(|error| format!("NATIVE_REPLAY_ROUTES:{error}"))
}

#[allow(clippy::too_many_arguments)]
pub fn replay_native_v1(
    source_database: impl AsRef<Path>,
    replay_database: impl AsRef<Path>,
    genesis: NativeGenesisConfig,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_label: &str,
    workers: usize,
) -> Result<NativeV1ReplayMetrics, String> {
    if workers == 0 || source_database.as_ref() == replay_database.as_ref() {
        return Err("NATIVE_REPLAY_ARGUMENTS".into());
    }
    let mut source = NativeRuntimeStore::open(source_database, NativeStorageConfig::default())
        .map_err(|error| format!("NATIVE_REPLAY_SOURCE_OPEN:{error}"))?;
    let source_height = source.latest_height();
    if source_height == 0 {
        return Err("NATIVE_REPLAY_SOURCE_EMPTY".into());
    }
    let routes = replay_routes(&mut source, source_height)?;

    let ready = create_native_genesis_replay_processor(
        replay_database,
        genesis,
        runtime_seed,
        runtime_signer_label,
        entity_signer_label,
        workers,
        routes,
    )?;
    let mut processor = ready.processor;
    let restored_height = processor
        .replica()
        .map_err(|error| format!("NATIVE_REPLAY_GENESIS:{error}"))?
        .state
        .height;
    if restored_height != 0 {
        return Err(format!("NATIVE_REPLAY_GENESIS_HEIGHT:{restored_height}"));
    }

    let mut metrics = NativeV1ReplayMetrics {
        frames: 0,
        entity_inputs: 0,
        account_inputs: 0,
        direct_payments: 0,
        outputs: 0,
        elapsed: Duration::ZERO,
        apply: Duration::ZERO,
        projection: Duration::ZERO,
        storage: Duration::ZERO,
        publication: Duration::ZERO,
        accounts_root: String::new(),
        transcript_digest: String::new(),
        account_phase_metrics: Vec::new(),
    };
    let mut transcript = Sha256::new();
    let started = Instant::now();
    for height in 1..=source_height {
        let source_frame = source
            .read_durable_frame(height)
            .map_err(|error| format!("NATIVE_REPLAY_SOURCE:{height}:{error}"))?;
        let source_frame = concrete_wal_source_from_native(source_frame)
            .map_err(|error| format!("NATIVE_REPLAY_SOURCE:{height}:{error}"))?;
        let finalized_j_height = processor
            .replica()
            .map_err(|error| format!("NATIVE_REPLAY_REPLICA:{height}:{error}"))?
            .state
            .finalized_j_height;
        let decoded = decode_concrete_runtime_wal_frame(&source_frame, finalized_j_height, false)
            .map_err(|error| format!("NATIVE_REPLAY_DECODE:{height}:{error}"))?;
        metrics.direct_payments = metrics
            .direct_payments
            .checked_add(direct_payment_count(&decoded.input)?)
            .ok_or_else(|| "NATIVE_REPLAY_COUNT:directPayments".to_string())?;
        processor
            .reconcile_exact_replay_input(&decoded.input)
            .map_err(|error| format!("NATIVE_REPLAY_RECONCILE:{height}:{error}"))?;
        let report = processor
            .process(decoded.input)
            .map_err(|error| format!("NATIVE_REPLAY_PROCESS:{height}:{error}"))?;
        let commitments = report
            .commitments
            .as_ref()
            .ok_or_else(|| format!("NATIVE_REPLAY_COMMITMENTS:{height}"))?;
        assert_source_commitments(height, &source_frame, commitments)?;
        transcript.update(height.to_be_bytes());
        transcript.update(commitments.runtime_frame_hash);
        transcript.update(commitments.post_state_hash);
        transcript.update(commitments.events_parity_digest);
        transcript.update(commitments.entity_effects_parity_digest);
        transcript.update(commitments.runtime_outputs_digest);
        transcript.update((report.runtime_entity_inputs as u64).to_be_bytes());
        transcript.update((report.account_inputs as u64).to_be_bytes());
        for entity in &commitments.entities {
            transcript.update(entity.entity_id);
            transcript.update(entity.certified_frame_hash);
            transcript.update(entity.state_root);
            transcript.update(entity.accounts_root);
        }
        add(
            &mut metrics.entity_inputs,
            report.runtime_entity_inputs,
            "entityInputs",
        )?;
        add(
            &mut metrics.account_inputs,
            report.account_inputs,
            "accountInputs",
        )?;
        add(&mut metrics.outputs, report.outputs_published, "outputs")?;
        metrics.frames += 1;
        metrics.apply += report.timings.apply;
        metrics.projection += report.timings.projection;
        metrics.storage += report.timings.storage;
        metrics.publication += report.timings.publication;
        metrics.accounts_root = hex(&sole_entity_commitment(commitments)?.accounts_root);
    }
    if let Some(final_commit) = processor
        .sync_committed()
        .map_err(|error| format!("NATIVE_REPLAY_FINAL_COMMIT:{error}"))?
    {
        add(
            &mut metrics.outputs,
            final_commit.outputs_published,
            "outputs",
        )?;
        metrics.storage += final_commit.timings.storage;
        metrics.publication += final_commit.timings.publication;
    }
    let replica = processor
        .replica()
        .map_err(|error| format!("NATIVE_REPLAY_FINAL:{error}"))?;
    if replica.state.height != source_height {
        return Err(format!(
            "NATIVE_REPLAY_FINAL_HEIGHT:expected={source_height}:actual={}",
            replica.state.height,
        ));
    }
    metrics.accounts_root = hex(&sole_entity_state(replica)?.accounts_root);
    metrics.transcript_digest = hex(&transcript.finalize());
    metrics.account_phase_metrics = sole_entity_replica(replica)?
        .accounts
        .account_phase_metrics();
    metrics.elapsed = started.elapsed();
    Ok(metrics)
}
