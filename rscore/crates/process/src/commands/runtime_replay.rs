//! Full-range production Runtime replay over one strict mixed TS artifact.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use xln_rscore_process::runtime_replay::replay_runtime_wal;
use xln_rscore_runtime::RuntimeWalReader;

fn milliseconds(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn account_phase_metrics(rows: &[xln_rscore_batch::AccountPhaseMetric]) -> Vec<serde_json::Value> {
    rows.iter()
        .map(|row| {
            serde_json::json!({
                "kind": format!("{:?}", row.kind),
                "invocations": row.invocations,
                "coordinatorWallMs": row.coordinator_wall_nanos as f64 / 1e6,
                "coordinatorPreDispatchMs": row.coordinator_pre_dispatch_nanos as f64 / 1e6,
                "runLanesWallMs": row.run_lanes_wall_nanos as f64 / 1e6,
                "coordinatorPostJoinMs": row.coordinator_post_join_nanos as f64 / 1e6,
                "coordinatorDispatchJoinMs": row.coordinator_dispatch_join_nanos as f64 / 1e6,
                "coordinatorFoldMs": row.coordinator_fold_nanos as f64 / 1e6,
                "workerSamples": row.worker_samples,
                "workerWorkSumMs": row.worker_work_sum_nanos as f64 / 1e6,
                "workerWorkMaxMs": row.worker_work_max_nanos as f64 / 1e6,
                "workerCriticalPathMs": row.worker_critical_path_nanos as f64 / 1e6,
                "workerPhaseSpanMs": row.worker_phase_span_nanos as f64 / 1e6,
                "workerBarrierWaitSumMs": row.worker_barrier_wait_sum_nanos as f64 / 1e6,
                "workerBarrierWaitMaxMs": row.worker_barrier_wait_max_nanos as f64 / 1e6,
                "workerRows": row.worker_rows,
                "workerWorkNanos": row.worker_work_nanos,
                "touchedRows": row.touched_rows,
                "touchedShards": row.touched_shards,
                "workersWithWork": row.workers_with_work,
                "shardHandleClones": row.shard_handle_clones,
                "candidateBaseReads": row.candidate_base_reads,
                "continuationRounds": row.continuation_rounds,
                "restartRounds": row.restart_rounds,
            })
        })
        .collect()
}

fn arguments(args: &[String]) -> Result<BTreeMap<&str, &str>, String> {
    const NAMES: [&str; 9] = [
        "--wal",
        "--recording",
        "--recording-manifest-hash",
        "--ts-parity-report",
        "--runtime-seed-file",
        "--runtime-signer-label",
        "--entity-signer-label",
        "--native-db",
        "--workers",
    ];
    if !args.len().is_multiple_of(2) {
        return Err("RUNTIME_REPLAY_ARG_VALUE_MISSING".into());
    }
    let mut parsed = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        let name = pair[0].as_str();
        let value = pair[1].as_str();
        if !NAMES.contains(&name) {
            return Err(format!("RUNTIME_REPLAY_ARG_UNKNOWN:{name}"));
        }
        if value.is_empty() {
            return Err(format!("RUNTIME_REPLAY_ARG_MISSING:{name}"));
        }
        if parsed.insert(name, value).is_some() {
            return Err(format!("RUNTIME_REPLAY_ARG_DUPLICATE:{name}"));
        }
    }
    for name in NAMES {
        if !parsed.contains_key(name) {
            return Err(format!("RUNTIME_REPLAY_ARG_MISSING:{name}"));
        }
    }
    Ok(parsed)
}

fn unsigned(value: Option<&Value>, path: &str) -> Result<u64, String> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("RUNTIME_REPLAY_UNSIGNED:{path}"))
}

fn exact_range(root: &Value) -> Result<(u64, u64), String> {
    let checkpoint = root
        .get("checkpoint")
        .and_then(Value::as_object)
        .ok_or_else(|| "RUNTIME_REPLAY_CHECKPOINT_OBJECT".to_string())?;
    let tail = root
        .get("tail")
        .and_then(Value::as_object)
        .ok_or_else(|| "RUNTIME_REPLAY_TAIL_OBJECT".to_string())?;
    let base = unsigned(checkpoint.get("height"), "checkpoint.height")?;
    if unsigned(tail.get("baseRuntimeHeight"), "tail.baseRuntimeHeight")? != base {
        return Err("RUNTIME_REPLAY_TAIL_BASE_MISMATCH".into());
    }
    let from = base
        .checked_add(1)
        .ok_or_else(|| "RUNTIME_REPLAY_HEIGHT_OVERFLOW".to_string())?;
    let to = unsigned(tail.get("runtimeHeight"), "tail.runtimeHeight")?;
    // Production framing coalesces a busy second into few Runtime frames
    // (1,000 users x rate 2 ~ 70 frames per 10 s); exactness is measured in
    // Account inputs by the TS recorder gate, this floor only rejects toy tails.
    if to < from || to - from + 1 < 50 {
        return Err(format!("RUNTIME_REPLAY_EXACT_RANGE:from={from}:to={to}"));
    }
    Ok((from, to))
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let args = arguments(&args)?;
    let wal_path = args["--wal"];
    let recording_path = args["--recording"];
    let recording_manifest_hash = args["--recording-manifest-hash"];
    let parity_report_path = args["--ts-parity-report"];
    let seed_path = args["--runtime-seed-file"];
    let runtime_signer_label = args["--runtime-signer-label"];
    let entity_signer_label = args["--entity-signer-label"];
    let native_path = args["--native-db"];
    let workers = args["--workers"]
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "RUNTIME_REPLAY_ARG_INVALID:--workers".to_string())?;
    let recording: Value = serde_json::from_slice(
        &std::fs::read(recording_path)
            .map_err(|error| format!("RUNTIME_REPLAY_RECORDING_READ:{error}"))?,
    )
    .map_err(|error| format!("RUNTIME_REPLAY_RECORDING_JSON:{error}"))?;
    let parity_report: Value = serde_json::from_slice(
        &std::fs::read(parity_report_path)
            .map_err(|error| format!("RUNTIME_REPLAY_TS_PARITY_REPORT_READ:{error}"))?,
    )
    .map_err(|error| format!("RUNTIME_REPLAY_TS_PARITY_REPORT_JSON:{error}"))?;
    let (from, to) = exact_range(&recording)?;
    let runtime_seed = std::fs::read_to_string(seed_path)
        .map_err(|error| format!("RUNTIME_REPLAY_SEED_READ:{error}"))?;
    let runtime_seed = runtime_seed.trim();
    if runtime_seed.is_empty() {
        return Err("RUNTIME_REPLAY_SEED_EMPTY".into());
    }
    let mut reader = RuntimeWalReader::open_owned(wal_path)
        .map_err(|error| format!("RUNTIME_REPLAY_WAL_OPEN:{error}"))?;
    let metrics = replay_runtime_wal(
        &mut reader,
        &recording,
        &parity_report,
        recording_manifest_hash,
        runtime_seed,
        runtime_signer_label,
        entity_signer_label,
        native_path,
        from,
        to,
        workers,
        &PathBuf::from(format!("{recording_path}.w{workers}.diffs")),
    )?;
    let apply_profile = serde_json::json!({
        "fitMs": milliseconds(metrics.apply_profile.fit),
        "residentCoreMs": milliseconds(metrics.apply_profile.resident_core),
        "postCorePrepareMs": milliseconds(metrics.apply_profile.post_core_prepare),
        "certificationMs": milliseconds(metrics.apply_profile.certification),
        "settlementAttachMs": milliseconds(metrics.apply_profile.settlement_attach),
        "postCertJMs": milliseconds(metrics.apply_profile.post_cert_j),
        "residualMs": milliseconds(metrics.apply_profile.residual),
        "totalMs": milliseconds(metrics.apply_profile.total),
        "entityGroups": metrics.apply_profile.entity_groups,
        "entityTxsSelected": metrics.apply_profile.entity_txs_selected,
        "accountInputs": metrics.apply_profile.account_inputs,
        "settlementHankos": metrics.apply_profile.settlement_hankos,
        "postCertJActions": metrics.apply_profile.post_cert_j_actions,
    });
    let projection_profile = serde_json::json!({
        "inputMs": milliseconds(metrics.projection_input_elapsed),
        "machineMs": milliseconds(metrics.projection_machine_elapsed),
        "metaMs": milliseconds(metrics.projection_meta_elapsed),
        "contextMs": milliseconds(metrics.projection_context_elapsed),
        "checkpointMs": milliseconds(metrics.projection_checkpoint_elapsed),
        "encodeMs": milliseconds(metrics.projection_encode_elapsed),
    });
    println!(
        "{}",
        serde_json::json!({
            "benchmark": "xlnrs-runtime-replay",
            "workers": workers,
            "frames": metrics.frames,
            "ingress": metrics.ingress,
            "egress": metrics.egress,
            "directPayments": metrics.direct_payments,
            "effectDigestsCompared": metrics.effect_digests_compared,
            "eventDigestsCompared": metrics.event_digests_compared,
            "localContinuationsCompared": metrics.local_continuations_compared,
            "outboxDigestsCompared": metrics.outbox_digests_compared,
            "postStateHashesCompared": metrics.post_state_hashes_compared,
            "runtimeRootsCompared": metrics.runtime_roots_compared,
            "accountsRoot": metrics.accounts_root,
            "setupMs": milliseconds(metrics.setup_elapsed),
            "elapsedMs": metrics.elapsed.as_secs_f64() * 1_000.0,
            "engineMs": milliseconds(metrics.engine_elapsed),
            "applyMs": metrics.apply_elapsed.as_secs_f64() * 1_000.0,
            "projectionMs": metrics.projection_elapsed.as_secs_f64() * 1_000.0,
            "storageMs": metrics.storage_elapsed.as_secs_f64() * 1_000.0,
            "publicationMs": metrics.publication_elapsed.as_secs_f64() * 1_000.0,
            "storagePrepareValidateMs": metrics.storage_prepare_validate_elapsed.as_secs_f64() * 1_000.0,
            "storageBatchBuildMs": metrics.storage_batch_build_elapsed.as_secs_f64() * 1_000.0,
            "storageDbWriteSyncMs": metrics.storage_db_write_sync_elapsed.as_secs_f64() * 1_000.0,
            "storageDirectorySyncMs": metrics.storage_directory_sync_elapsed.as_secs_f64() * 1_000.0,
            "storagePostCommitMs": metrics.storage_post_commit_elapsed.as_secs_f64() * 1_000.0,
            "barrierWaitForPreviousCommitMs": metrics.barrier_wait_for_previous_commit_elapsed.as_secs_f64() * 1_000.0,
            "committerBusyMs": metrics.committer_busy_elapsed.as_secs_f64() * 1_000.0,
            "committerIdleMs": metrics.committer_idle_elapsed.as_secs_f64() * 1_000.0,
            "applyProfile": apply_profile,
            "projectionProfile": projection_profile,
            "accountPhaseMetrics": account_phase_metrics(&metrics.account_phase_metrics),
        })
    );
    Ok(())
}
