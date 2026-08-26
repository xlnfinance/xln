#![forbid(unsafe_code)]

//! Direct Account+paybook+orderbook replay of a previously verified process
//! transcript. This intentionally does not claim to be a Runtime replay: its
//! purpose is to measure the resident Rust financial kernel without IPC.

use std::fs;
use std::time::{Duration, Instant};

use xln_rscore_abi::{AbiValue, BodyTuple, Envelope, MessageKind, OpTag, decode_envelope};
use xln_rscore_process::ProcessSession;

const TRANSCRIPT_MAGIC: &[u8; 8] = b"XRSCTR01";

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Clone)]
struct TranscriptPair {
    request: Envelope,
    expected: Envelope,
}

#[derive(Default)]
struct ReplayMetrics {
    rounds: u64,
    ingress: u64,
    egress: u64,
    account_txs: u64,
    elapsed: Duration,
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

fn parse_transcript(path: &str) -> Result<Vec<TranscriptPair>, String> {
    let bytes = fs::read(path).map_err(|error| format!("NATIVE_REPLAY_READ:{error}"))?;
    if bytes.get(..TRANSCRIPT_MAGIC.len()) != Some(TRANSCRIPT_MAGIC) {
        return Err("NATIVE_REPLAY_MAGIC".to_string());
    }
    let mut records = Vec::new();
    let mut offset = TRANSCRIPT_MAGIC.len();
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset.saturating_add(5))
            .ok_or_else(|| "NATIVE_REPLAY_RECORD_HEADER".to_string())?;
        let direction = *header
            .first()
            .ok_or_else(|| "NATIVE_REPLAY_RECORD_DIRECTION".to_string())?;
        let length_bytes: [u8; 4] = header
            .get(1..5)
            .ok_or_else(|| "NATIVE_REPLAY_RECORD_LENGTH".to_string())?
            .try_into()
            .map_err(|_| "NATIVE_REPLAY_RECORD_LENGTH".to_string())?;
        let length = usize::try_from(u32::from_be_bytes(length_bytes))
            .map_err(|_| "NATIVE_REPLAY_RECORD_LENGTH_RANGE".to_string())?;
        offset = offset.saturating_add(5);
        let end = offset
            .checked_add(length)
            .ok_or_else(|| "NATIVE_REPLAY_RECORD_OVERFLOW".to_string())?;
        let frame = bytes
            .get(offset..end)
            .ok_or_else(|| "NATIVE_REPLAY_RECORD_TRUNCATED".to_string())?;
        let envelope = decode_envelope(frame, 1)
            .or_else(|first_error| decode_envelope(frame, 2).map_err(|_| first_error))
            .map_err(|error| {
                format!(
                    "NATIVE_REPLAY_ENVELOPE:index={}:direction={direction}:{error}",
                    records.len()
                )
            })?;
        records.push((direction, envelope));
        offset = end;
    }
    if records.is_empty() || !records.len().is_multiple_of(2) {
        return Err("NATIVE_REPLAY_RECORD_COUNT".to_string());
    }
    records
        .chunks_exact(2)
        .map(|pair| {
            if pair[0].0 != 0 || pair[1].0 != 1 {
                return Err("NATIVE_REPLAY_RECORD_ORDER".to_string());
            }
            Ok(TranscriptPair {
                request: pair[0].1.clone(),
                expected: pair[1].1.clone(),
            })
        })
        .collect()
}

fn replace_tuple_field(
    value: AbiValue,
    index: usize,
    replacement: AbiValue,
) -> Result<AbiValue, String> {
    let AbiValue::Tuple(tuple) = value else {
        return Err("NATIVE_REPLAY_REPLACE_TUPLE".to_string());
    };
    let mut fields = tuple.into_fields();
    let slot = fields
        .get_mut(index)
        .ok_or_else(|| format!("NATIVE_REPLAY_REPLACE_INDEX:{index}"))?;
    *slot = replacement;
    Ok(AbiValue::Tuple(BodyTuple::from_vec(fields)))
}

fn tune_request(mut request: Envelope, workers: usize) -> Result<Envelope, String> {
    let body_fields = request.body.clone().into_fields();
    let [payload] = body_fields.as_slice() else {
        return Err("NATIVE_REPLAY_REQUEST_BODY".to_string());
    };
    let replacement = match request.op_tag {
        OpTag::Hello => replace_tuple_field(
            payload.clone(),
            1,
            AbiValue::Integer(
                i128::try_from(workers).map_err(|_| "NATIVE_REPLAY_WORKERS".to_string())?,
            ),
        )?,
        OpTag::EntityRound => replace_tuple_field(payload.clone(), 5, AbiValue::Bool(false))?,
        _ => return Ok(request),
    };
    request.body = BodyTuple::from_array([replacement]);
    Ok(request)
}

fn normalize_round(value: AbiValue) -> Result<AbiValue, String> {
    let value = replace_tuple_field(value, 6, AbiValue::Tuple(BodyTuple::from_vec(Vec::new())))?;
    replace_tuple_field(value, 10, AbiValue::Integer(0))
}

fn normalize_response(mut response: Envelope) -> Result<Envelope, String> {
    if response.op_tag == OpTag::Hello {
        let body_fields = response.body.clone().into_fields();
        let [payload] = body_fields.as_slice() else {
            return Err("NATIVE_REPLAY_HELLO_RESPONSE".to_string());
        };
        response.body = BodyTuple::from_array([replace_tuple_field(
            payload.clone(),
            2,
            AbiValue::Integer(0),
        )?]);
    } else if response.op_tag == OpTag::EntityRound {
        let body_fields = response.body.clone().into_fields();
        let [payload] = body_fields.as_slice() else {
            return Err("NATIVE_REPLAY_ENTITY_RESPONSE".to_string());
        };
        let fields = tuples(payload)?;
        if fields.len() != 6 {
            return Err("NATIVE_REPLAY_ENTITY_RESPONSE_ARITY".to_string());
        }
        let mut normalized = fields.to_vec();
        normalized[0] = normalize_round(normalized[0].clone())?;
        normalized[1] = normalize_round(normalized[1].clone())?;
        normalized[5] = AbiValue::Integer(0);
        response.body = BodyTuple::from_array([AbiValue::Tuple(BodyTuple::from_vec(normalized))]);
    }
    Ok(response)
}

fn count_egress(proposals: &[AbiValue]) -> Result<(u64, u64), String> {
    let mut egress = 0_u64;
    let mut txs = 0_u64;
    for proposal in proposals {
        let fields = tuples(proposal)?;
        let has_frame = !matches!(fields.get(1), Some(AbiValue::Nil));
        let has_ack = !matches!(fields.get(4), Some(AbiValue::Nil));
        if has_frame || has_ack {
            egress = egress
                .checked_add(1)
                .ok_or_else(|| "NATIVE_REPLAY_EGRESS_OVERFLOW".to_string())?;
        }
        if has_frame {
            let frame = tuples(
                fields
                    .get(1)
                    .ok_or_else(|| "NATIVE_REPLAY_FRAME".to_string())?,
            )?;
            let frame_txs = tuples(
                frame
                    .get(3)
                    .ok_or_else(|| "NATIVE_REPLAY_FRAME_TXS".to_string())?,
            )?;
            txs = txs
                .checked_add(
                    u64::try_from(frame_txs.len())
                        .map_err(|_| "NATIVE_REPLAY_TX_COUNT".to_string())?,
                )
                .ok_or_else(|| "NATIVE_REPLAY_TX_OVERFLOW".to_string())?;
        }
    }
    Ok((egress, txs))
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
    let (egress, txs) = count_egress(tuples(&outbound[4])?)?;
    metrics.egress = metrics
        .egress
        .checked_add(egress)
        .ok_or_else(|| "NATIVE_REPLAY_EGRESS_OVERFLOW".to_string())?;
    metrics.account_txs = metrics
        .account_txs
        .checked_add(txs)
        .ok_or_else(|| "NATIVE_REPLAY_TX_OVERFLOW".to_string())?;
    metrics.accounts_root = bytes_hex(&outbound[1])?;
    let commitments = tuples(&fields[3])?;
    metrics.paybook_root = bytes_hex(&commitments[0])?;
    metrics.orderbook_root = bytes_hex(&commitments[1])?;
    Ok(())
}

fn replay(pairs: &[TranscriptPair], workers: usize) -> Result<ReplayMetrics, String> {
    let mut session = ProcessSession::try_new().map_err(|error| error.to_string())?;
    let mut metrics = ReplayMetrics::default();
    for (pair_index, pair) in pairs.iter().enumerate() {
        let request = tune_request(pair.request.clone(), workers)?;
        let request_op = request.op_tag;
        let request_body = request.body.clone();
        let started = Instant::now();
        let reply = session.handle(request);
        if reply.envelope.op_tag == OpTag::EntityRound {
            metrics.elapsed += started.elapsed();
            observe_entity(&reply.envelope, &mut metrics)?;
        }
        if reply.envelope.message_kind != MessageKind::Ok {
            return Err(format!(
                "NATIVE_REPLAY_ENGINE_ERROR:index={pair_index}:op={request_op:?}:requestBody={request_body:?}:error={:?}",
                reply.envelope.body,
            ));
        }
        let actual = normalize_response(reply.envelope)?;
        let expected = normalize_response(pair.expected.clone())?;
        if actual != expected {
            return Err(format!("NATIVE_REPLAY_PARITY:{:?}", actual.op_tag));
        }
    }
    Ok(metrics)
}

fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let transcript = argument(&args, "--transcript")?
        .ok_or_else(|| "NATIVE_REPLAY_ARG_MISSING:--transcript".to_string())?;
    let workers = argument(&args, "--workers")?
        .unwrap_or_else(|| "16".to_string())
        .parse::<usize>()
        .map_err(|_| "NATIVE_REPLAY_WORKERS_INVALID".to_string())?;
    let pairs = parse_transcript(&transcript)?;
    let result = replay(&pairs, workers)?;
    let seconds = result.elapsed.as_secs_f64().max(0.000_001);
    println!(
        concat!(
            "{{\"benchmark\":\"rscore-native-apo-replay\",\"workers\":{},",
            "\"rounds\":{},\"ingress\":{},\"egress\":{},\"accountTxs\":{},",
            "\"elapsedMs\":{:.3},\"ingressPerSecond\":{:.2},\"egressPerSecond\":{:.2},",
            "\"protocolRowsPerSecond\":{:.2},\"accountsRoot\":\"{}\",",
            "\"paybookRoot\":\"{}\",\"orderbookRoot\":\"{}\"}}"
        ),
        workers,
        result.rounds,
        result.ingress,
        result.egress,
        result.account_txs,
        seconds * 1_000.0,
        result.ingress as f64 / seconds,
        result.egress as f64 / seconds,
        (result.ingress + result.egress) as f64 / seconds,
        result.accounts_root,
        result.paybook_root,
        result.orderbook_root,
    );
    Ok(())
}
