use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{Map, Value};

use super::RuntimeTransportError;

const RUNTIME_ID_BYTES: usize = 20;
const ENTITY_ID_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectRoute {
    pub target_runtime_id: String,
    pub url: String,
}

#[derive(Clone, Debug, Default)]
pub struct DirectRouteTable(Arc<BTreeMap<String, String>>);

impl DirectRouteTable {
    pub fn new(
        routes: impl IntoIterator<Item = DirectRoute>,
    ) -> Result<Self, RuntimeTransportError> {
        let mut output = BTreeMap::new();
        for route in routes {
            let target = normalize_runtime_id(&route.target_runtime_id)?;
            if !(route.url.starts_with("ws://") || route.url.starts_with("wss://")) {
                return Err(RuntimeTransportError::Route(format!("url:{}", route.url)));
            }
            if output.insert(target.clone(), route.url).is_some() {
                return Err(RuntimeTransportError::Route(format!("duplicate:{target}")));
            }
        }
        Ok(Self(Arc::new(output)))
    }

    pub(super) fn url(&self, target: &str) -> Result<&str, RuntimeTransportError> {
        self.0
            .get(target)
            .map(String::as_str)
            .ok_or_else(|| RuntimeTransportError::Route(format!("missing:{target}")))
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, target: &str) -> bool {
        self.0.contains_key(target)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct OutboundEnvelope {
    pub target_runtime_id: String,
    pub source_height: u64,
    pub source_timestamp: u64,
    pub entity_id: Option<String>,
    pub transaction_count: u64,
    pub value: Value,
    pub row_count: usize,
    pub durable_bytes: usize,
}

pub(super) struct PreparedEnvelopeBatch {
    pub envelopes: Vec<OutboundEnvelope>,
    pub row_count: usize,
    pub bytes: usize,
}

impl PreparedEnvelopeBatch {
    /// Atomic cohorts share the publishing Runtime's durable frame, as TS
    /// dispatch does. Original signed Account proposals and WAL rows stay exact.
    pub(super) fn bind_publication_frame(&mut self, height: u64, timestamp: u64) {
        for envelope in &mut self.envelopes {
            if envelope.value.get("atomicCrossJurisdictionPair").is_some() {
                envelope.source_height = height;
                envelope.source_timestamp = timestamp;
                envelope.value["sourceRuntimeHeight"] = Value::from(height);
                envelope.value["sourceRuntimeTimestamp"] = Value::from(timestamp);
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct AtomicCrossJurisdictionPair {
    phase: String,
    pair_key: String,
}

type GroupKey = (String, u64, u64, Option<AtomicCrossJurisdictionPair>);
type PendingAtomicPair = (usize, String, u64, u64, AtomicCrossJurisdictionPair);

pub(super) fn prepare_envelopes(
    source_runtime_id: &str,
    rows: &[Vec<u8>],
    local_entity_signers: &BTreeMap<String, String>,
    max_rows: usize,
    max_plaintext_bytes: usize,
) -> Result<PreparedEnvelopeBatch, RuntimeTransportError> {
    let values = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            crate::decode_storage_payload(row)
                .map_err(|error| RuntimeTransportError::Outbox(format!("row={index}:{error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    prepare_envelopes_from_values(
        source_runtime_id,
        rows,
        values,
        local_entity_signers,
        max_rows,
        max_plaintext_bytes,
    )
}

/// Prepare immediate publication from the exact values that produced the
/// synced outbox rows. `rows` remain the sole authority for byte counts and
/// recovery; this transient path only deletes an encode-then-decode roundtrip.
pub(super) fn prepare_envelopes_from_values(
    source_runtime_id: &str,
    rows: &[Vec<u8>],
    values: Vec<Value>,
    local_entity_signers: &BTreeMap<String, String>,
    max_rows: usize,
    max_plaintext_bytes: usize,
) -> Result<PreparedEnvelopeBatch, RuntimeTransportError> {
    if values.len() != rows.len() {
        return Err(RuntimeTransportError::Outbox(format!(
            "resident-row-count:{}:{}",
            values.len(),
            rows.len()
        )));
    }
    let source = normalize_runtime_id(source_runtime_id)?;
    let mut groups = Vec::<(GroupKey, Vec<(usize, Value)>)>::new();
    let mut pending_atomic_pair: Option<PendingAtomicPair> = None;
    let mut completed_atomic_pairs = BTreeSet::new();
    let mut remote_rows = 0_usize;
    let mut remote_bytes = 0_usize;
    for (index, (value, row)) in values.into_iter().zip(rows).enumerate() {
        let Value::Object(mut object) = value else {
            return Err(RuntimeTransportError::Outbox(format!("row={index}:object")));
        };
        validate_output(&object, index)?;
        let atomic_pair = decode_atomic_pair(&object, index)?;
        let entity_id = normalize_entity_id(required_text(&object, "entityId", index)?)?;
        let signer_id = required_text(&object, "signerId", index)?.to_ascii_lowercase();
        let Some(target) = object.get("runtimeId") else {
            if pending_atomic_pair.is_some() {
                return Err(RuntimeTransportError::Outbox(format!(
                    "row={index}:atomic-pair-incomplete"
                )));
            }
            if atomic_pair.is_some() {
                return Err(RuntimeTransportError::Outbox(format!(
                    "row={index}:atomic-pair-local"
                )));
            }
            if local_entity_signers.get(&entity_id) != Some(&signer_id) {
                return Err(RuntimeTransportError::Outbox(format!(
                    "row={index}:local-route"
                )));
            }
            continue;
        };
        let target = normalize_runtime_id(
            target
                .as_str()
                .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:runtimeId")))?,
        )?;
        if target == source {
            return Err(RuntimeTransportError::Outbox(format!(
                "row={index}:self-route"
            )));
        }
        let frame = required_object(&object, "sourceRuntimeFrame", index)?;
        let height = safe_u64(frame.get("height"), "height", index)?;
        let timestamp = safe_u64(frame.get("timestamp"), "timestamp", index)?;
        object.remove("sourceRuntimeFrame");
        object.remove("atomicCrossJurisdictionPair");
        match (pending_atomic_pair.take(), atomic_pair.as_ref()) {
            (
                Some((first_index, first_target, first_height, first_timestamp, first_pair)),
                Some(pair),
            ) => {
                if pair != &first_pair {
                    return Err(RuntimeTransportError::Outbox(format!(
                        "row={index}:atomic-pair-mixed:first={first_index}"
                    )));
                }
                if target != first_target {
                    return Err(RuntimeTransportError::Outbox(format!(
                        "row={index}:atomic-pair-target:first={first_index}"
                    )));
                }
                if height != first_height || timestamp != first_timestamp {
                    return Err(RuntimeTransportError::Outbox(format!(
                        "row={index}:atomic-pair-source-frame:first={first_index}"
                    )));
                }
                completed_atomic_pairs.insert(first_pair);
            }
            (Some((first_index, _, _, _, _)), None) => {
                return Err(RuntimeTransportError::Outbox(format!(
                    "row={index}:atomic-pair-incomplete:first={first_index}"
                )));
            }
            (None, Some(pair)) => {
                if completed_atomic_pairs.contains(pair) {
                    return Err(RuntimeTransportError::Outbox(format!(
                        "row={index}:atomic-pair-count"
                    )));
                }
                pending_atomic_pair =
                    Some((index, target.clone(), height, timestamp, pair.clone()));
            }
            (None, None) => {}
        }
        let key = (target, height, timestamp, atomic_pair);
        // TS dispatch groups by destination in first-appearance order before
        // selecting exact sibling cohorts. Entity output order may interleave
        // Custody, MM, MM, Custody; adjacency cannot decide cohort completeness.
        // Keep the permanent row index and bytes unchanged within each group.
        let group_index = groups
            .iter()
            .position(|(current, _)| current == &key)
            .unwrap_or_else(|| {
                groups.push((key, Vec::new()));
                groups.len() - 1
            });
        groups[group_index].1.push((index, Value::Object(object)));
        remote_rows = remote_rows
            .checked_add(1)
            .ok_or_else(|| RuntimeTransportError::Outbox("row-count-overflow".into()))?;
        remote_bytes = remote_bytes
            .checked_add(row.len())
            .ok_or_else(|| RuntimeTransportError::Outbox("byte-overflow".into()))?;
    }
    if let Some((first_index, _, _, _, _)) = pending_atomic_pair {
        return Err(RuntimeTransportError::Outbox(format!(
            "row={first_index}:atomic-pair-incomplete"
        )));
    }

    // A destination frame can contain an ordinary ACK beside signed sibling
    // proposals. Select exact pairs before batching, as TS dispatch does;
    // unrelated rows must neither hide a pair nor become part of its cohort.
    let groups = groups
        .into_iter()
        .flat_map(|(key, values)| {
            if key.3.is_some()
                || values.len() == 1
                || (values.len() == 2 && infer_atomic_pair(&values).is_some())
                || !values.iter().any(|(_, value)| has_cross_proposal(value))
            {
                return vec![(key, values)];
            }
            let mut claimed = BTreeSet::new();
            let mut units = Vec::new();
            for index in 0..values.len() {
                if claimed.contains(&index) {
                    continue;
                }
                claimed.insert(index);
                let matches = (index + 1..values.len())
                    .filter(|other| {
                        !claimed.contains(other)
                            && infer_atomic_pair(&[values[index].clone(), values[*other].clone()])
                                .is_some()
                    })
                    .collect::<Vec<_>>();
                let mut unit = vec![values[index].clone()];
                if let [other] = matches.as_slice() {
                    claimed.insert(*other);
                    unit.push(values[*other].clone());
                }
                units.push((key.clone(), unit));
            }
            units
        })
        .collect::<Vec<_>>();
    // Frame grouping above must not change positional pairing when an older
    // frame's ACK surrounds a newer frame's leg. Restore row positions within
    // each destination; destination order itself remains first appearance.
    let mut target_order = Vec::new();
    for (key, _) in &groups {
        if !target_order.contains(&key.0) {
            target_order.push(key.0.clone());
        }
    }
    let mut groups = groups;
    groups.sort_by_key(|(key, values)| {
        (
            target_order
                .iter()
                .position(|target| target == &key.0)
                .unwrap(),
            values[0].0,
        )
    });
    // TS gives exact same-frame cohorts priority, then pairs unclaimed legs
    // across source frames. Only the already durable flat outbox participates;
    // a lone or ambiguous leg remains an invariant error below.
    let mut claimed = BTreeSet::new();
    let mut cross_frame_groups = Vec::new();
    for index in 0..groups.len() {
        if !claimed.insert(index) {
            continue;
        }
        let (key, values) = &groups[index];
        let matches = if key.3.is_none() && values.len() == 1 {
            (index + 1..groups.len())
                .filter(|other| {
                    let (other_key, other_values) = &groups[*other];
                    !claimed.contains(other)
                        && other_key.3.is_none()
                        && key.0 == other_key.0
                        && other_values.len() == 1
                        && infer_atomic_pair(&[values[0].clone(), other_values[0].clone()])
                            .is_some()
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let mut unit = values.clone();
        if let [other] = matches.as_slice() {
            claimed.insert(*other);
            unit.push(groups[*other].1[0].clone());
        }
        cross_frame_groups.push((key.clone(), unit));
    }
    let mut envelopes = Vec::new();
    for ((target, height, timestamp, atomic_pair), mut values) in cross_frame_groups {
        let inferred = atomic_pair.is_none();
        let atomic_pair = atomic_pair.or_else(|| infer_atomic_pair(&values));
        // TS dispatch fails producer invariants rather than sending or parking
        // a lone signed financial leg. Reject the entire prepared batch before
        // stage/publication, including when both unmatched rows are source legs.
        if atomic_pair.is_none() && values.iter().any(|(_, value)| has_cross_proposal(value)) {
            return Err(RuntimeTransportError::Outbox(format!(
                "cross-j-incomplete-cohort:target={target}:height={height}"
            )));
        }
        if let Some(pair) = atomic_pair {
            if inferred {
                // groupAtomicCrossJAdmissionOutputs emits targetInputIndex then
                // sourceInputIndex for inferred proposals. Explicit ACK cohorts
                // retain their admitted order; neither convention rewrites WAL.
                values.reverse();
            }
            if values.len() != 2 || max_rows < 2 {
                return Err(RuntimeTransportError::Outbox(format!(
                    "atomic-pair-size:{}:{max_rows}",
                    values.len()
                )));
            }
            let raw_bytes = values.iter().try_fold(0_usize, |total, (index, _)| {
                total
                    .checked_add(rows[*index].len())
                    .ok_or_else(|| RuntimeTransportError::Outbox("byte-overflow".into()))
            })?;
            if raw_bytes > max_plaintext_bytes {
                return Err(RuntimeTransportError::Outbox(format!(
                    "atomic-pair-bytes:{raw_bytes}:{max_plaintext_bytes}"
                )));
            }
            envelopes.push(build_envelope(
                &source,
                &target,
                height,
                timestamp,
                values.into_iter().map(|(_, value)| value).collect(),
                raw_bytes,
                Some(&pair),
            )?);
            continue;
        }
        let mut chunk = Vec::new();
        let mut raw_bytes = 0_usize;
        for (index, value) in values {
            let estimate = rows[index].len();
            if !chunk.is_empty()
                && (chunk.len() == max_rows
                    || raw_bytes.saturating_add(estimate) > max_plaintext_bytes)
            {
                envelopes.push(build_envelope(
                    &source, &target, height, timestamp, chunk, raw_bytes, None,
                )?);
                chunk = Vec::new();
                raw_bytes = 0;
            }
            raw_bytes = raw_bytes
                .checked_add(estimate)
                .ok_or_else(|| RuntimeTransportError::Outbox("byte-overflow".into()))?;
            chunk.push(value);
        }
        if !chunk.is_empty() {
            envelopes.push(build_envelope(
                &source, &target, height, timestamp, chunk, raw_bytes, None,
            )?);
        }
    }
    Ok(PreparedEnvelopeBatch {
        envelopes,
        row_count: remote_rows,
        bytes: remote_bytes,
    })
}

// TS selectPotentialCrossJAccountInputPairs: this is structural envelope
// membership only. The signed Account proposals remain the authority; pairing
// must bind both routes and pull proofs, not merely a user-chosen order id.
struct CrossProposal<'a> {
    key: String,
    source_pulls: Vec<&'a Value>,
    target_pulls: Vec<&'a Value>,
    source_closes: Vec<&'a Value>,
    target_closes: Vec<&'a Value>,
}

fn lower_text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_ascii_lowercase()
}

fn open_key(data: &Value) -> String {
    format!(
        "{}\0{}",
        data["crossJurisdiction"]["orderId"]
            .as_str()
            .unwrap_or_default()
            .trim(),
        lower_text(&data["crossJurisdiction"]["routeHash"]).trim()
    )
}

fn close_key(data: &Value) -> String {
    let proof = &data["proof"];
    let mut key = Map::from_iter([
        ("operation".into(), Value::String("close".into())),
        ("binary".into(), data["binary"].clone()),
    ]);
    for field in [
        "orderId",
        "routeHash",
        "sourcePullId",
        "targetPullId",
        "fillRatio",
        "cumulativeSourceAmount",
        "cumulativeTargetAmount",
        "binaryHash",
        "closeMode",
    ] {
        let value = if matches!(field, "routeHash" | "binaryHash") {
            Value::String(lower_text(&proof[field]))
        } else {
            proof[field].clone()
        };
        key.insert(field.into(), value);
    }
    Value::Object(key).to_string()
}

fn cross_proposal(account_input: &Value) -> Option<CrossProposal<'_>> {
    let txs = account_input["proposal"]["frame"]["accountTxs"].as_array()?;
    let pulls = |leg: &str| {
        txs.iter()
            .filter(|tx| {
                tx["type"] == "cross_pull_lock" && tx["data"]["crossJurisdiction"]["leg"] == leg
            })
            .map(|tx| &tx["data"])
            .collect::<Vec<_>>()
    };
    let closes = |leg: &str| {
        txs.iter()
            .filter(|tx| {
                tx["type"] == "cross_pull_close"
                    && tx["data"]["pullId"] == tx["data"]["proof"][format!("{leg}PullId")]
            })
            .map(|tx| &tx["data"])
            .collect::<Vec<_>>()
    };
    let source_pulls = pulls("source");
    let target_pulls = pulls("target");
    let source_closes = closes("source");
    let target_closes = closes("target");
    if !source_pulls.iter().all(|pull| {
        txs.iter().any(|tx| {
            tx["type"] == "swap_offer"
                && tx["data"]["crossJurisdiction"]["orderId"]
                    == pull["crossJurisdiction"]["orderId"]
                && lower_text(&tx["data"]["crossJurisdiction"]["routeHash"])
                    == lower_text(&pull["crossJurisdiction"]["routeHash"])
        })
    }) {
        return None;
    }
    let mut keys = source_pulls
        .iter()
        .chain(&target_pulls)
        .map(|data| format!("open\0{}", open_key(data)))
        .chain(
            source_closes
                .iter()
                .chain(&target_closes)
                .map(|data| close_key(data)),
        )
        .collect::<Vec<_>>();
    if keys.is_empty() || keys.iter().collect::<BTreeSet<_>>().len() != keys.len() {
        return None;
    }
    keys.sort(); // Route-set key only; never reorders financial inputs/outputs.
    Some(CrossProposal {
        key: format!("proposal\0{}", keys.join("\u{1}")),
        source_pulls,
        target_pulls,
        source_closes,
        target_closes,
    })
}

fn paired_pulls(source: &[&Value], target: &[&Value]) -> bool {
    source.len() == target.len()
        && source.iter().all(|left| {
            let matches = target
                .iter()
                .filter(|right| open_key(left) == open_key(right))
                .collect::<Vec<_>>();
            let [right] = matches.as_slice() else {
                return false;
            };
            let route = &left["crossJurisdictionRoute"];
            route.is_object()
                && route == &right["crossJurisdictionRoute"]
                && left["pullId"] == route["sourcePull"]["pullId"]
                && right["pullId"] == route["targetPull"]["pullId"]
                && lower_text(&left["fullHash"]) == lower_text(&right["fullHash"])
                && lower_text(&left["partialRoot"]) == lower_text(&right["partialRoot"])
        })
}

fn paired_closes(source: &[&Value], target: &[&Value]) -> bool {
    source.len() == target.len()
        && source.iter().all(|left| {
            let matches = target
                .iter()
                .filter(|right| close_key(left) == close_key(right))
                .collect::<Vec<_>>();
            let [right] = matches.as_slice() else {
                return false;
            };
            left["pullId"] == left["proof"]["sourcePullId"]
                && right["pullId"] == right["proof"]["targetPullId"]
        })
}

fn has_cross_proposal(input: &Value) -> bool {
    input["entityTxs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|tx| tx["type"] == "accountInput")
        .flat_map(|tx| {
            tx["data"]["proposal"]["frame"]["accountTxs"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .any(|tx| {
            tx["type"] == "cross_pull_close"
                || (tx["type"] == "cross_pull_lock" && !tx["data"]["crossJurisdiction"].is_null())
        })
}

fn infer_atomic_pair(values: &[(usize, Value)]) -> Option<AtomicCrossJurisdictionPair> {
    let [(_, left), (_, right)] = values else {
        return None;
    };
    if lower_text(&left["entityId"]) == lower_text(&right["entityId"])
        || lower_text(&left["runtimeId"]) != lower_text(&right["runtimeId"])
        || lower_text(&left["from"]) != lower_text(&right["from"])
    {
        return None;
    }
    fn candidates(input: &Value) -> Vec<CrossProposal<'_>> {
        input["entityTxs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|tx| tx["type"] == "accountInput")
            .filter_map(|tx| cross_proposal(&tx["data"]))
            .collect()
    }
    let left_candidates = candidates(left);
    let right_candidates = candidates(right);
    for left in left_candidates {
        let matches = right_candidates
            .iter()
            .filter(|right| {
                left.key == right.key
                    && paired_pulls(&left.source_pulls, &right.target_pulls)
                    && paired_pulls(&right.source_pulls, &left.target_pulls)
                    && paired_closes(&left.source_closes, &right.target_closes)
                    && paired_closes(&right.source_closes, &left.target_closes)
            })
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return Some(AtomicCrossJurisdictionPair {
                phase: "proposal".into(),
                pair_key: left.key,
            });
        }
    }
    None
}

fn build_envelope(
    source: &str,
    target: &str,
    height: u64,
    timestamp: u64,
    entity_inputs: Vec<Value>,
    durable_bytes: usize,
    atomic_pair: Option<&AtomicCrossJurisdictionPair>,
) -> Result<OutboundEnvelope, RuntimeTransportError> {
    let row_count = entity_inputs.len();
    let entity_id = (row_count == 1)
        .then(|| {
            entity_inputs[0]
                .get("entityId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten();
    let transaction_count = entity_inputs.iter().try_fold(0_u64, |count, input| {
        let rows = input
            .get("entityTxs")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        count
            .checked_add(rows as u64)
            .ok_or_else(|| RuntimeTransportError::Outbox("tx-count-overflow".into()))
    })?;
    let mut envelope = Map::from_iter([
        ("sourceRuntimeId".into(), Value::String(source.to_owned())),
        ("sourceRuntimeHeight".into(), Value::from(height)),
        ("sourceRuntimeTimestamp".into(), Value::from(timestamp)),
        ("entityInputs".into(), Value::Array(entity_inputs)),
    ]);
    if let Some(pair) = atomic_pair {
        envelope.insert(
            "atomicCrossJurisdictionPair".into(),
            Value::Object(Map::from_iter([
                ("phase".into(), Value::String(pair.phase.clone())),
                ("pairKey".into(), Value::String(pair.pair_key.clone())),
            ])),
        );
    }
    let value = Value::Object(envelope);
    Ok(OutboundEnvelope {
        target_runtime_id: target.to_owned(),
        source_height: height,
        source_timestamp: timestamp,
        entity_id,
        transaction_count,
        value,
        row_count,
        durable_bytes,
    })
}

fn decode_atomic_pair(
    object: &Map<String, Value>,
    index: usize,
) -> Result<Option<AtomicCrossJurisdictionPair>, RuntimeTransportError> {
    let Some(value) = object.get("atomicCrossJurisdictionPair") else {
        return Ok(None);
    };
    let pair = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:atomic-pair")))?;
    if pair.len() != 2
        || pair
            .keys()
            .any(|key| !matches!(key.as_str(), "phase" | "pairKey"))
    {
        return Err(RuntimeTransportError::Outbox(format!(
            "row={index}:atomic-pair-fields"
        )));
    }
    let phase = pair
        .get("phase")
        .and_then(Value::as_str)
        .filter(|phase| matches!(*phase, "proposal" | "ack"))
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:atomic-pair-phase")))?;
    let pair_key = pair
        .get("pairKey")
        .and_then(Value::as_str)
        .filter(|pair_key| !pair_key.is_empty())
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:atomic-pair-key")))?;
    Ok(Some(AtomicCrossJurisdictionPair {
        phase: phase.to_owned(),
        pair_key: pair_key.to_owned(),
    }))
}

fn validate_output(object: &Map<String, Value>, index: usize) -> Result<(), RuntimeTransportError> {
    required_text(object, "entityId", index)?;
    required_text(object, "signerId", index)?;
    let has_payload = [
        "entityTxs",
        "proposedFrame",
        "hashPrecommits",
        "jPrefixAttestations",
        "leaderTimeoutVote",
    ]
    .iter()
    .any(|field| object.contains_key(*field));
    if !has_payload {
        return Err(RuntimeTransportError::Outbox(format!("row={index}:empty")));
    }
    Ok(())
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    index: usize,
) -> Result<&'a str, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:{field}")))
}

fn required_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    index: usize,
) -> Result<&'a Map<String, Value>, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:{field}")))
}

fn safe_u64(
    value: Option<&Value>,
    field: &str,
    index: usize,
) -> Result<u64, RuntimeTransportError> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:{field}")))
}

pub(super) fn normalize_runtime_id(value: &str) -> Result<String, RuntimeTransportError> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x").unwrap_or("");
    if body.len() != RUNTIME_ID_BYTES * 2 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RuntimeTransportError::Route(format!("runtime-id:{value}")));
    }
    Ok(normalized)
}

pub(super) fn normalize_entity_id(value: &str) -> Result<String, RuntimeTransportError> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x").unwrap_or("");
    if body.len() != ENTITY_ID_BYTES * 2 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RuntimeTransportError::Route(format!("entity-id:{value}")));
    }
    Ok(normalized)
}
