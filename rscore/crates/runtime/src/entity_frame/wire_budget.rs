//! Rust mirror of `core/entity/consensus/proposal/wire-budget.ts`.

use std::collections::BTreeSet;

use serde_json::{Map, Number, Value};
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

use super::EntityFrameError;
use super::account_input_commitment::account_input_commitment;
use crate::canonical_value_from_tagged_json;

const BINARY_MAGIC: u8 = 0x03;
const FRAME_TX_DOMAIN: &[u8] = b"xln:entity-frame-txs:binary";
const FRAME_DOMAIN: &str = "xln:entity-frame:binary-context-digest";
const MAX_FRAME_BYTES: usize = 100_000_000;
const MAX_TX_BYTES: usize = MAX_FRAME_BYTES / 2;
const MAX_FIT_ATTEMPTS: usize = 16;
const DUMMY_ROOT: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

fn payload(value: &Value) -> Result<Vec<u8>, EntityFrameError> {
    let canonical = canonical_value_from_tagged_json(value)?;
    let body = encode_canonical_consensus_bytes(&canonical)
        .map_err(|error| EntityFrameError::Encoding(error.to_string()))?;
    let mut bytes = Vec::with_capacity(body.len() + 1);
    bytes.push(BINARY_MAGIC);
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

fn entity_tx_payload(tx: &Value) -> Result<Vec<u8>, EntityFrameError> {
    let tx = tx
        .as_object()
        .ok_or_else(|| EntityFrameError::Value("OBJECT:entityTx".into()))?;
    if tx.get("type").and_then(Value::as_str) != Some("accountInput") {
        return Err(EntityFrameError::Value("TX_TYPE:accountInput".into()));
    }
    let data = tx
        .get("data")
        .ok_or_else(|| EntityFrameError::Value("FIELD:entityTx.data".into()))?;
    let data = canonical_value_from_tagged_json(data)?;
    let projected = CanonicalValue::Object(vec![
        ("type".into(), CanonicalValue::String("accountInput".into())),
        ("data".into(), account_input_commitment(&data)?),
    ]);
    let body = encode_canonical_consensus_bytes(&projected)
        .map_err(|error| EntityFrameError::Encoding(error.to_string()))?;
    let mut bytes = Vec::with_capacity(body.len() + 1);
    bytes.push(BINARY_MAGIC);
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

fn tx_prefix(txs: &[Value]) -> Result<Vec<usize>, EntityFrameError> {
    let mut total = 0_usize;
    let mut prefix = Vec::with_capacity(txs.len() + 1);
    prefix.push(0);
    for tx in txs {
        let tx_bytes = entity_tx_payload(tx)?.len();
        total = total
            .checked_add(4)
            .and_then(|value| value.checked_add(tx_bytes))
            .ok_or_else(|| EntityFrameError::Value("TX_PREFIX_OVERFLOW".into()))?;
        prefix.push(total);
    }
    Ok(prefix)
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, EntityFrameError> {
    value
        .as_object()
        .ok_or_else(|| EntityFrameError::Value(format!("OBJECT:{path}")))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], EntityFrameError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| EntityFrameError::Value(format!("ARRAY:{path}")))
}

fn text(value: &Value, path: &str) -> Result<String, EntityFrameError> {
    value
        .as_str()
        .map(str::to_lowercase)
        .ok_or_else(|| EntityFrameError::Value(format!("STRING:{path}")))
}

fn prepared_htlc_keys(context: &Value) -> Result<BTreeSet<String>, EntityFrameError> {
    let context = object(context, "context")?;
    let htlc = object(
        context
            .get("htlc")
            .ok_or_else(|| EntityFrameError::Value("FIELD:context.htlc".into()))?,
        "context.htlc",
    )?;
    let entries = array(
        htlc.get("entries")
            .ok_or_else(|| EntityFrameError::Value("FIELD:context.htlc.entries".into()))?,
        "context.htlc.entries",
    )?;
    let mut keys = BTreeSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let path = format!("context.htlc.entries[{index}]");
        let binding = object(
            object(entry, &path)?
                .get("binding")
                .ok_or_else(|| EntityFrameError::Value(format!("FIELD:{path}.binding")))?,
            &format!("{path}.binding"),
        )?;
        let frame = text(
            binding
                .get("accountFrameHash")
                .ok_or_else(|| EntityFrameError::Value(format!("FIELD:{path}.accountFrameHash")))?,
            &format!("{path}.accountFrameHash"),
        )?;
        let lock = text(
            binding
                .get("lockId")
                .ok_or_else(|| EntityFrameError::Value(format!("FIELD:{path}.lockId")))?,
            &format!("{path}.lockId"),
        )?;
        if !keys.insert(format!("{frame}:{lock}")) {
            return Err(EntityFrameError::Value(format!(
                "HTLC_BINDING_DUPLICATE:{frame}:{lock}"
            )));
        }
    }
    Ok(keys)
}

fn inbound_htlc_keys(tx: &Value) -> Result<BTreeSet<String>, EntityFrameError> {
    let tx = object(tx, "entityTx")?;
    let data = object(
        tx.get("data")
            .ok_or_else(|| EntityFrameError::Value("FIELD:entityTx.data".into()))?,
        "entityTx.data",
    )?;
    let Some(proposal) = data.get("proposal") else {
        return Ok(BTreeSet::new());
    };
    let frame = object(
        object(proposal, "entityTx.data.proposal")?
            .get("frame")
            .ok_or_else(|| EntityFrameError::Value("FIELD:entityTx.data.proposal.frame".into()))?,
        "entityTx.data.proposal.frame",
    )?;
    let frame_hash = text(
        frame
            .get("stateHash")
            .ok_or_else(|| EntityFrameError::Value("FIELD:accountFrame.stateHash".into()))?,
        "accountFrame.stateHash",
    )?;
    let account_txs = array(
        frame
            .get("accountTxs")
            .ok_or_else(|| EntityFrameError::Value("FIELD:accountFrame.accountTxs".into()))?,
        "accountFrame.accountTxs",
    )?;
    let mut keys = BTreeSet::new();
    for (index, account_tx) in account_txs.iter().enumerate() {
        let path = format!("accountFrame.accountTxs[{index}]");
        let account_tx = object(account_tx, &path)?;
        if account_tx.get("type").and_then(Value::as_str) != Some("htlc_lock") {
            continue;
        }
        let data = object(
            account_tx
                .get("data")
                .ok_or_else(|| EntityFrameError::Value(format!("FIELD:{path}.data")))?,
            &format!("{path}.data"),
        )?;
        if !data.contains_key("envelope") {
            continue;
        }
        let lock = text(
            data.get("lockId")
                .ok_or_else(|| EntityFrameError::Value(format!("FIELD:{path}.data.lockId")))?,
            &format!("{path}.data.lockId"),
        )?;
        keys.insert(format!("{frame_hash}:{lock}"));
    }
    Ok(keys)
}

fn fit_htlc_context_prefix(
    txs: &[Value],
    context: &Value,
    byte_fitted: usize,
) -> Result<usize, EntityFrameError> {
    let expected = prepared_htlc_keys(context)?;
    let mut observed = BTreeSet::new();
    let mut compatible = 0_usize;
    let mut complete = expected.is_empty().then_some(0_usize);
    for (index, tx) in txs.iter().enumerate() {
        let keys = inbound_htlc_keys(tx)?;
        if keys.iter().any(|key| !expected.contains(key)) {
            break;
        }
        observed.extend(keys);
        compatible = index + 1;
        if complete.is_none() && observed.len() == expected.len() {
            complete = Some(compatible);
        }
    }
    let complete = complete.ok_or_else(|| {
        EntityFrameError::Value(format!(
            "HTLC_PREFIX_MISSING:expected={}:observed={}",
            expected.len(),
            observed.len()
        ))
    })?;
    if observed != expected {
        return Err(EntityFrameError::Value(format!(
            "HTLC_PREFIX_MISMATCH:expected={}:observed={}",
            expected.len(),
            observed.len()
        )));
    }
    let selected = byte_fitted.min(compatible);
    if selected < complete {
        return Err(EntityFrameError::Value(format!(
            "HTLC_PREFIX_UNFITTABLE:required={complete}:fitted={selected}"
        )));
    }
    Ok(selected)
}

fn empty_tx_digest() -> String {
    let mut hasher = Sha256::new();
    hasher.update(FRAME_TX_DOMAIN);
    format!("0x{:x}", hasher.finalize())
}

fn rest_bytes(
    context: &Value,
    height: u64,
    timestamp: u64,
    entity_id: &str,
) -> Result<usize, EntityFrameError> {
    let context = payload(context)?;
    let context_digest = format!("0x{:x}", Sha256::digest(&context));
    let header = Value::Object(Map::from_iter([
        ("domain".into(), Value::String(FRAME_DOMAIN.into())),
        ("prevFrameHash".into(), Value::String(DUMMY_ROOT.into())),
        ("height".into(), Value::Number(Number::from(height))),
        ("timestamp".into(), Value::Number(Number::from(timestamp))),
        ("txCount".into(), Value::Number(Number::from(0))),
        ("txsDigest".into(), Value::String(empty_tx_digest())),
        ("events".into(), Value::Array(Vec::new())),
        ("entityId".into(), Value::String(entity_id.to_string())),
        ("stateRoot".into(), Value::String(DUMMY_ROOT.into())),
        ("authorityRoot".into(), Value::String(DUMMY_ROOT.into())),
        ("entityContextDigest".into(), Value::String(context_digest)),
        ("jPrefixCertificate".into(), Value::Null),
    ]));
    payload(&header)?
        .len()
        .checked_add(context.len())
        .ok_or_else(|| EntityFrameError::Value("REST_BYTES_OVERFLOW".into()))
}

pub fn fit_entity_account_input_prefix(
    txs: &[Value],
    context: &Value,
    height: u64,
    timestamp: u64,
    entity_id: &str,
) -> Result<usize, EntityFrameError> {
    if txs.is_empty() {
        return Ok(0);
    }
    let prefix = tx_prefix(txs)?;
    let tx_cap = prefix
        .partition_point(|bytes| *bytes <= MAX_TX_BYTES)
        .saturating_sub(1);
    if tx_cap == 0 {
        return Err(EntityFrameError::Value("HEAD_TX_UNFITTABLE".into()));
    }
    let fixed = rest_bytes(context, height, timestamp, entity_id)?;
    let max = MAX_FRAME_BYTES - MAX_FRAME_BYTES / 3 - MAX_FRAME_BYTES / 10;
    let mut candidate = tx_cap;
    for _ in 0..MAX_FIT_ATTEMPTS {
        let bytes = fixed
            .checked_add(prefix[candidate])
            .ok_or_else(|| EntityFrameError::Value("FRAME_BYTES_OVERFLOW".into()))?;
        let tx_bytes = prefix[candidate];
        if bytes <= max && tx_bytes <= MAX_TX_BYTES {
            return fit_htlc_context_prefix(txs, context, candidate);
        }
        let ratio = (max as f64 / bytes as f64).min(MAX_TX_BYTES as f64 / tx_bytes as f64);
        let scaled = (candidate as f64 * 0.9 * ratio).floor() as usize;
        candidate = candidate.saturating_sub(1).min(scaled);
        if candidate == 0 {
            return Err(EntityFrameError::Value("HEAD_WIRE_UNFITTABLE".into()));
        }
    }
    Err(EntityFrameError::Value("WIRE_FIT_EXHAUSTED".into()))
}
