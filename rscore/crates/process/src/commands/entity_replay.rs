//! Direct Account+paybook+orderbook replay of a previously verified process
//! transcript. This intentionally does not claim to be a Runtime replay: its
//! purpose is smoke/parity validation of the resident Rust financial kernel.
//! It deliberately emits no timing or rate that could be quoted as live TPS.

use xln_rscore_abi::{AbiValue, Envelope, OpTag};
use xln_rscore_entity_kernel::{apply_resident_entity_round_core, compute_entity_owned_sections};
use xln_rscore_process::replay_support::{
    bootstrap_resident_authority, normalize_response, tune_request,
};
use xln_rscore_process::transcript::{TranscriptPair, read_transcript};
use xln_rscore_process::{decode_resident_entity_round, encode_resident_entity_round};

#[derive(Default)]
struct ReplayMetrics {
    rounds: u64,
    ingress: u64,
    egress: u64,
    accounts_root: String,
    paybook_root: String,
    orderbook_root: String,
}

fn argument(args: &[String], name: &str) -> Result<Option<String>, String> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(None);
    };
    args.get(index + 1)
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("NATIVE_REPLAY_ARG_MISSING:{name}"))
}

fn tuples(value: &AbiValue) -> Result<&[AbiValue], String> {
    let AbiValue::Tuple(tuple) = value else {
        return Err("NATIVE_REPLAY_TUPLE_REQUIRED".to_string());
    };
    Ok(tuple.fields())
}

fn one_body(envelope: &Envelope) -> Result<&[AbiValue], String> {
    let [value] = envelope.body.fields() else {
        return Err("NATIVE_REPLAY_BODY_ARITY".to_string());
    };
    tuples(value)
}

fn bytes_hex(value: &AbiValue) -> Result<String, String> {
    let AbiValue::Bytes(bytes) = value else {
        return Err("NATIVE_REPLAY_BYTES_REQUIRED".to_string());
    };
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    Ok(output)
}

fn count_egress(proposals: &[AbiValue]) -> Result<u64, String> {
    let mut egress = 0_u64;
    for proposal in proposals {
        let fields = tuples(proposal)?;
        let has_frame = !matches!(fields.get(1), Some(AbiValue::Nil));
        let has_ack = !matches!(fields.get(4), Some(AbiValue::Nil));
        if has_frame || has_ack {
            egress = egress
                .checked_add(1)
                .ok_or_else(|| "NATIVE_REPLAY_EGRESS_OVERFLOW".to_string())?;
        }
    }
    Ok(egress)
}

fn observe_entity(response: &Envelope, metrics: &mut ReplayMetrics) -> Result<(), String> {
    let fields = one_body(response)?;
    if fields.len() != 6 {
        return Err("NATIVE_REPLAY_ENTITY_ARITY".to_string());
    }
    let inbound = tuples(&fields[0])?;
    let outbound = tuples(&fields[1])?;
    metrics.rounds = metrics
        .rounds
        .checked_add(1)
        .ok_or_else(|| "NATIVE_REPLAY_ROUNDS_OVERFLOW".to_string())?;
    metrics.ingress = metrics
        .ingress
        .checked_add(
            u64::try_from(tuples(&inbound[2])?.len())
                .map_err(|_| "NATIVE_REPLAY_INGRESS_COUNT".to_string())?,
        )
        .ok_or_else(|| "NATIVE_REPLAY_INGRESS_OVERFLOW".to_string())?;
    let egress = count_egress(tuples(&outbound[4])?)?;
    metrics.egress = metrics
        .egress
        .checked_add(egress)
        .ok_or_else(|| "NATIVE_REPLAY_EGRESS_OVERFLOW".to_string())?;
    metrics.accounts_root = bytes_hex(&outbound[1])?;
    let commitments = tuples(&fields[3])?;
    metrics.paybook_root = bytes_hex(&commitments[0])?;
    metrics.orderbook_root = bytes_hex(&commitments[1])?;
    Ok(())
}

fn replay(pairs: &[TranscriptPair], workers: usize) -> Result<ReplayMetrics, String> {
    let (bootstrap, first_round) = bootstrap_resident_authority(pairs, workers)?;
    let mut accounts = bootstrap.accounts;
    let mut state = bootstrap.entity_state;
    let mut current_root = bootstrap.accounts_root;
    let mut metrics = ReplayMetrics::default();
    for (pair_index, pair) in pairs.iter().enumerate().skip(first_round) {
        if pair.request.op_tag == OpTag::Shutdown {
            continue;
        }
        let request = tune_request(pair.request.clone(), workers)?;
        let (request, context) = decode_resident_entity_round(&request)
            .map_err(|error| format!("NATIVE_REPLAY_DECODE:index={pair_index}:{error}"))?;
        if request.inbound.expected_accounts_root != current_root {
            return Err(format!("NATIVE_REPLAY_PARENT_ROOT:index={pair_index}"));
        }
        let core = apply_resident_entity_round_core(&mut accounts, state, request, &context)
            .map_err(|error| format!("NATIVE_REPLAY_ENGINE:index={pair_index}:{error}"))?;
        let sections = compute_entity_owned_sections(
            &core.state,
            core.outbound.accounts_root,
            accounts.account_count(),
        )
        .map_err(|error| format!("NATIVE_REPLAY_SECTIONS:index={pair_index}:{error}"))?;
        let result = core
            .with_canonical_commitments()
            .map_err(|error| format!("NATIVE_REPLAY_DIAGNOSTICS:index={pair_index}:{error}"))?;

        let mut actual = pair.expected.clone();
        actual.body = encode_resident_entity_round(&result, &sections)
            .map_err(|error| format!("NATIVE_REPLAY_ENCODE:index={pair_index}:{error}"))?;
        observe_entity(&actual, &mut metrics)?;
        let actual = normalize_response(actual)?;
        let expected = normalize_response(pair.expected.clone())?;
        if actual != expected {
            return Err(format!("NATIVE_REPLAY_PARITY:index={pair_index}"));
        }
        current_root = result.outbound.accounts_root;
        state = result.state;
    }
    if std::env::var("XLN_RSCORE_PROFILE_SHARDS").as_deref() == Ok("1") {
        let mut worker_items = vec![0_u64; accounts.worker_count()];
        let mut worker_nanos = vec![0_u64; accounts.worker_count()];
        let mut active_shards = 0_usize;
        for metric in accounts.account_shard_metrics() {
            let worker = usize::from(metric.worker);
            worker_items[worker] = worker_items[worker].saturating_add(metric.work_items);
            worker_nanos[worker] = worker_nanos[worker]
                .saturating_add(metric.work_nanos)
                .saturating_add(metric.fold_nanos);
            active_shards += usize::from(metric.work_items > 0 || metric.fold_leaves > 0);
        }
        eprintln!(
            "RSCORE_NATIVE_SHARD_PROFILE activeShards={active_shards} workerItems={worker_items:?} workerNanos={worker_nanos:?}"
        );
    }
    Ok(metrics)
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let transcript = argument(&args, "--transcript")?
        .ok_or_else(|| "NATIVE_REPLAY_ARG_MISSING:--transcript".to_string())?;
    let workers = argument(&args, "--workers")?
        .unwrap_or_else(|| "16".to_string())
        .parse::<usize>()
        .map_err(|_| "NATIVE_REPLAY_WORKERS_INVALID".to_string())?;
    let payments = argument(&args, "--payments")?
        .ok_or_else(|| "NATIVE_REPLAY_ARG_MISSING:--payments".to_string())?
        .parse::<u64>()
        .map_err(|_| "NATIVE_REPLAY_PAYMENTS_INVALID".to_string())?;
    if payments == 0 {
        return Err("NATIVE_REPLAY_PAYMENTS_INVALID".to_string());
    }
    let pairs = read_transcript(&transcript).map_err(|error| error.to_string())?;
    let result = replay(&pairs, workers)?;
    println!(
        concat!(
            "{{\"evidence\":\"smoke-parity-only-not-tps\",",
            "\"benchmark\":\"rscore-native-apo-smoke\",\"workers\":{},",
            "\"payments\":{},\"rounds\":{},\"ingress\":{},\"egress\":{},",
            "\"accountsRoot\":\"{}\",",
            "\"paybookRoot\":\"{}\",\"orderbookRoot\":\"{}\"}}"
        ),
        workers,
        payments,
        result.rounds,
        result.ingress,
        result.egress,
        result.accounts_root,
        result.paybook_root,
        result.orderbook_root,
    );
    Ok(())
}
