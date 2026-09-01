//! Full-range production Runtime replay over one strict mixed TS artifact.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use xln_rscore_process::runtime_replay::replay_runtime_wal;
use xln_rscore_runtime::RuntimeWalReader;

fn arguments(args: &[String]) -> Result<BTreeMap<&str, &str>, String> {
    const NAMES: [&str; 7] = [
        "--wal",
        "--recording",
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
    if to < from || to - from + 1 < 1_000 {
        return Err(format!("RUNTIME_REPLAY_EXACT_RANGE:from={from}:to={to}"));
    }
    Ok((from, to))
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let args = arguments(&args)?;
    let wal_path = args["--wal"];
    let recording_path = args["--recording"];
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
        runtime_seed,
        runtime_signer_label,
        entity_signer_label,
        native_path,
        from,
        to,
        workers,
        &PathBuf::from(format!("{recording_path}.w{workers}.diffs")),
    )?;
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
            "outboxDigestsCompared": metrics.outbox_digests_compared,
            "postStateHashesCompared": metrics.post_state_hashes_compared,
            "runtimeRootsCompared": metrics.runtime_roots_compared,
            "accountsRoot": metrics.accounts_root,
            "elapsedMs": metrics.elapsed.as_secs_f64() * 1_000.0,
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
        })
    );
    Ok(())
}
