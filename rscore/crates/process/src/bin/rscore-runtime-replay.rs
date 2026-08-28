#![forbid(unsafe_code)]

//! Exact single-Entity native Runtime replay over canonical TypeScript storage.

use serde_json::Value;
use std::path::PathBuf;
use xln_rscore_process::runtime_replay::replay_runtime_wal;
use xln_rscore_runtime::{RuntimeWalReader, restore::MigrationOrigin};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn argument(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("RUNTIME_REPLAY_ARG_MISSING:{name}"))?;
    args.get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("RUNTIME_REPLAY_ARG_MISSING:{name}"))
}

fn optional_usize(args: &[String], name: &str, default: usize) -> Result<usize, String> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(default);
    };
    args.get(index + 1)
        .ok_or_else(|| format!("RUNTIME_REPLAY_ARG_MISSING:{name}"))?
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("RUNTIME_REPLAY_ARG_INVALID:{name}"))
}

fn optional_nonzero_usize(args: &[String], name: &str) -> Result<Option<usize>, String> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(None);
    };
    args.get(index + 1)
        .ok_or_else(|| format!("RUNTIME_REPLAY_ARG_MISSING:{name}"))?
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .map(Some)
        .ok_or_else(|| format!("RUNTIME_REPLAY_ARG_INVALID:{name}"))
}

fn unsigned(value: Option<&Value>, path: &str) -> Result<u64, String> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("RUNTIME_REPLAY_UNSIGNED:{path}"))
}

fn recording_range(root: &Value) -> Result<(u64, u64), String> {
    let recording = root
        .as_object()
        .and_then(|value| value.get("recording"))
        .and_then(Value::as_object)
        .ok_or_else(|| "RUNTIME_REPLAY_RECORDING_OBJECT".to_string())?;
    let base = unsigned(recording.get("baseHeight"), "recording.baseHeight")?;
    let target = unsigned(recording.get("targetHeight"), "recording.targetHeight")?;
    let from = base
        .checked_add(1)
        .ok_or_else(|| "RUNTIME_REPLAY_HEIGHT_OVERFLOW".to_string())?;
    if base == 0 || target < from {
        return Err(format!(
            "RUNTIME_REPLAY_RECORDING_RANGE:base={base}:target={target}"
        ));
    }
    Ok((from, target))
}

fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let wal_path = argument(&args, "--wal")?;
    let checkpoint_wal_path = args
        .iter()
        .position(|value| value == "--checkpoint-wal")
        .map(|index| {
            args.get(index + 1)
                .filter(|value| !value.is_empty())
                .cloned()
                .ok_or_else(|| "RUNTIME_REPLAY_ARG_MISSING:--checkpoint-wal".to_string())
        })
        .transpose()?
        .filter(|path| path != &wal_path);
    let state_path = argument(&args, "--state-db")?;
    if wal_path == state_path || checkpoint_wal_path.as_deref() == Some(state_path.as_str()) {
        return Err("RUNTIME_REPLAY_DATABASES_MUST_BE_DISTINCT".into());
    }
    let recording_path = argument(&args, "--recording")?;
    let runtime_seed_path = argument(&args, "--runtime-seed-file")?;
    let runtime_signer_label = argument(&args, "--runtime-signer-label")?;
    let entity_signer_label = argument(&args, "--entity-signer-label")?;
    let native_path = argument(&args, "--native-db")?;
    let diff_path = args
        .iter()
        .position(|value| value == "--diff-dir")
        .map(|index| {
            args.get(index + 1)
                .filter(|value| !value.is_empty())
                .cloned()
                .ok_or_else(|| "RUNTIME_REPLAY_ARG_MISSING:--diff-dir".to_string())
        })
        .transpose()?
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("{recording_path}.diffs")));
    let workers = optional_usize(&args, "--workers", 8)?;
    let offline_ts_import = args.iter().any(|value| value == "--offline-ts-import");

    let recording_bytes = std::fs::read(&recording_path)
        .map_err(|error| format!("RUNTIME_REPLAY_RECORDING_READ:{error}"))?;
    let recording = serde_json::from_slice::<Value>(&recording_bytes)
        .map_err(|error| format!("RUNTIME_REPLAY_RECORDING_JSON:{error}"))?;
    let (from, recorded_to) = recording_range(&recording)?;
    let max_frames = optional_nonzero_usize(&args, "--max-frames")?;
    let to = max_frames.map_or(Ok(recorded_to), |count| {
        let count =
            u64::try_from(count).map_err(|_| "RUNTIME_REPLAY_MAX_FRAMES_OVERFLOW".to_string())?;
        from.checked_add(count - 1)
            .map(|height| height.min(recorded_to))
            .ok_or_else(|| "RUNTIME_REPLAY_HEIGHT_OVERFLOW".to_string())
    })?;
    let runtime_seed = std::fs::read_to_string(runtime_seed_path)
        .map_err(|error| format!("RUNTIME_REPLAY_SEED_READ:{error}"))?;
    let runtime_seed = runtime_seed.trim();
    if runtime_seed.is_empty() {
        return Err("RUNTIME_REPLAY_SEED_EMPTY".into());
    }

    let mut reader = RuntimeWalReader::open_owned(wal_path)
        .map_err(|error| format!("RUNTIME_REPLAY_WAL_OPEN:{error}"))?;
    let mut checkpoint_reader = checkpoint_wal_path
        .map(RuntimeWalReader::open_owned)
        .transpose()
        .map_err(|error| format!("RUNTIME_REPLAY_CHECKPOINT_WAL_OPEN:{error}"))?;
    let mut state_reader = RuntimeWalReader::open_owned(state_path)
        .map_err(|error| format!("RUNTIME_REPLAY_STATE_OPEN:{error}"))?;
    let metrics = replay_runtime_wal(
        &mut reader,
        checkpoint_reader.as_mut(),
        &mut state_reader,
        &recording,
        runtime_seed,
        &runtime_signer_label,
        &entity_signer_label,
        native_path,
        from,
        to,
        workers,
        offline_ts_import.then_some(MigrationOrigin::OfflineTsImport),
        &diff_path,
    )?;
    // Serialized once after replay; timing-only observability that never
    // touches committed state. Mean worker times are derived from sums.
    let phase_metrics = metrics
        .account_phase_metrics
        .iter()
        .map(|metric| {
            let kind = match metric.kind {
                xln_rscore_batch::AccountPhaseKind::Inbound => "inbound",
                xln_rscore_batch::AccountPhaseKind::OutboundReset => "outboundReset",
                xln_rscore_batch::AccountPhaseKind::OutboundContinue => "outboundContinue",
            };
            let samples = metric.worker_samples.max(1);
            serde_json::json!({
                "kind": kind,
                "invocations": metric.invocations,
                "coordinatorWallMs": metric.coordinator_wall_nanos as f64 / 1e6,
                "workerSamples": metric.worker_samples,
                "workerWorkMeanMs": metric.worker_work_sum_nanos as f64 / samples as f64 / 1e6,
                "workerWorkMaxMs": metric.worker_work_max_nanos as f64 / 1e6,
                "workerBarrierWaitMeanMs":
                    metric.worker_barrier_wait_sum_nanos as f64 / samples as f64 / 1e6,
                "workerBarrierWaitMaxMs": metric.worker_barrier_wait_max_nanos as f64 / 1e6,
                "coordinatorFoldMs": metric.coordinator_fold_nanos as f64 / 1e6,
                "touchedRows": metric.touched_rows,
                "touchedShards": metric.touched_shards,
                "workersWithWork": metric.workers_with_work,
                "valueClones": metric.value_clones,
                "candidateBaseReads": metric.candidate_base_reads,
                "continuationRounds": metric.continuation_rounds,
                "fallbackRounds": metric.fallback_rounds,
            })
        })
        .collect::<Vec<_>>();
    let phase_metrics = serde_json::to_string(&phase_metrics)
        .map_err(|error| format!("RUNTIME_REPLAY_PHASE_METRICS_JSON:{error}"))?;
    println!(
        concat!(
            "{{\"benchmark\":\"rscore-runtime-replay\",\"mode\":\"native-exact\",",
            "\"nativeRestartVerified\":true,",
            "\"workers\":{},\"frames\":{},\"ingress\":{},\"egress\":{},",
            "\"setupMs\":{:.3},\"elapsedMs\":{:.3},\"engineMs\":{:.3},",
            "\"applyMs\":{:.3},\"projectionMs\":{:.3},\"storageMs\":{:.3},\"publicationMs\":{:.3},",
            "\"directPayments\":{},",
            "\"effectDigestsCompared\":{},",
            "\"outboxDigestsCompared\":{},\"postStateHashesCompared\":{},",
            "\"runtimeRootsCompared\":{},\"accountsRoot\":\"{}\",",
            "\"accountPhaseMetrics\":{}}}"
        ),
        workers,
        metrics.frames,
        metrics.ingress,
        metrics.egress,
        metrics.setup_elapsed.as_secs_f64() * 1_000.0,
        metrics.elapsed.as_secs_f64() * 1_000.0,
        metrics.engine_elapsed.as_secs_f64() * 1_000.0,
        metrics.apply_elapsed.as_secs_f64() * 1_000.0,
        metrics.projection_elapsed.as_secs_f64() * 1_000.0,
        metrics.storage_elapsed.as_secs_f64() * 1_000.0,
        metrics.publication_elapsed.as_secs_f64() * 1_000.0,
        metrics.direct_payments,
        metrics.effect_digests_compared,
        metrics.outbox_digests_compared,
        metrics.post_state_hashes_compared,
        metrics.runtime_roots_compared,
        metrics.accounts_root,
        phase_metrics,
    );
    Ok(())
}
