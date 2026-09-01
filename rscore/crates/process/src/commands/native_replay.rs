//! Production-native V1 replay. No TS oracle, import mode or schema fallback.

use std::path::PathBuf;

use xln_rscore_process::native_genesis::NativeGenesisConfig;
use xln_rscore_process::runtime_replay::replay_native_v1;

fn milliseconds(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn argument(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("NATIVE_REPLAY_ARG_MISSING:{name}"))?;
    args.get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("NATIVE_REPLAY_ARG_MISSING:{name}"))
}

fn workers(args: &[String]) -> Result<usize, String> {
    argument(args, "--workers")?
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "NATIVE_REPLAY_WORKERS".to_string())
}

fn phase_metrics(rows: &[xln_rscore_batch::AccountPhaseMetric]) -> Vec<serde_json::Value> {
    rows.iter()
        .map(|row| {
            serde_json::json!({
                "kind": match row.kind {
                    xln_rscore_batch::AccountPhaseKind::Inbound => "inbound",
                    xln_rscore_batch::AccountPhaseKind::OutboundReset => "outboundReset",
                    xln_rscore_batch::AccountPhaseKind::OutboundFailedHtlcFollowup => {
                        "outboundFailedHtlcFollowup"
                    }
                    xln_rscore_batch::AccountPhaseKind::OutboundSettlementHankoAttach => {
                        "outboundSettlementHankoAttach"
                    }
                },
                "invocations": row.invocations,
                "coordinatorWallMs": row.coordinator_wall_nanos as f64 / 1e6,
                "workerSamples": row.worker_samples,
                "workerWorkMs": row.worker_work_sum_nanos as f64 / 1e6,
                "workerRows": &row.worker_rows,
                "workerWorkNanos": &row.worker_work_nanos,
                "workerBarrierWaitMs": row.worker_barrier_wait_sum_nanos as f64 / 1e6,
                "coordinatorFoldMs": row.coordinator_fold_nanos as f64 / 1e6,
                "touchedRows": row.touched_rows,
                "touchedShards": row.touched_shards,
                "workersWithWork": row.workers_with_work,
            })
        })
        .collect()
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let source = PathBuf::from(argument(&args, "--source-native-db")?);
    let replay = PathBuf::from(argument(&args, "--replay-native-db")?);
    let seed = std::fs::read_to_string(argument(&args, "--runtime-seed-file")?)
        .map_err(|error| format!("NATIVE_REPLAY_SEED:{error}"))?;
    let genesis = NativeGenesisConfig::read(argument(&args, "--genesis-config")?)?;
    let worker_count = workers(&args)?;
    let metrics = replay_native_v1(
        source,
        replay,
        genesis,
        seed.trim(),
        &argument(&args, "--runtime-signer-label")?,
        &argument(&args, "--entity-signer-label")?,
        worker_count,
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
        "inputMs": milliseconds(metrics.projection_input),
        "machineMs": milliseconds(metrics.projection_machine),
        "metaMs": milliseconds(metrics.projection_meta),
        "contextMs": milliseconds(metrics.projection_context),
        "checkpointMs": milliseconds(metrics.projection_checkpoint),
        "encodeMs": milliseconds(metrics.projection_encode),
    });
    println!(
        "{}",
        serde_json::json!({
            "benchmark": "xlnrs-native-replay-v1",
            "workers": worker_count,
            "frames": metrics.frames,
            "entityInputs": metrics.entity_inputs,
            "accountInputs": metrics.account_inputs,
            "directPayments": metrics.direct_payments,
            "outputs": metrics.outputs,
            "elapsedMs": metrics.elapsed.as_secs_f64() * 1_000.0,
            "setupMs": milliseconds(metrics.setup),
            "sourceDecodeMs": milliseconds(metrics.source_decode),
            "reconcileMs": milliseconds(metrics.reconcile),
            "processorWallMs": milliseconds(metrics.processor_wall),
            "verificationMs": milliseconds(metrics.verification),
            "finalDrainMs": milliseconds(metrics.final_drain),
            "applyMs": metrics.apply.as_secs_f64() * 1_000.0,
            "projectionMs": metrics.projection.as_secs_f64() * 1_000.0,
            "storageMs": metrics.storage.as_secs_f64() * 1_000.0,
            "publicationMs": metrics.publication.as_secs_f64() * 1_000.0,
            "storagePrepareValidateMs": metrics.storage_prepare_validate.as_secs_f64() * 1_000.0,
            "storageBatchBuildMs": metrics.storage_batch_build.as_secs_f64() * 1_000.0,
            "storageDbWriteSyncMs": metrics.storage_db_write_sync.as_secs_f64() * 1_000.0,
            "storageDirectorySyncMs": metrics.storage_directory_sync.as_secs_f64() * 1_000.0,
            "storagePostCommitMs": metrics.storage_post_commit.as_secs_f64() * 1_000.0,
            "barrierWaitForPreviousCommitMs": metrics.barrier_wait_for_previous_commit.as_secs_f64() * 1_000.0,
            "committerBusyMs": metrics.committer_busy.as_secs_f64() * 1_000.0,
            "committerIdleMs": metrics.committer_idle.as_secs_f64() * 1_000.0,
            "accountsRoot": metrics.accounts_root,
            "transcriptDigest": metrics.transcript_digest,
            "applyProfile": apply_profile,
            "projectionProfile": projection_profile,
            "accountPhaseMetrics": phase_metrics(&metrics.account_phase_metrics),
        }),
    );
    Ok(())
}
