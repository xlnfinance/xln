use std::collections::BTreeSet;

use serde_json::{Map, Value};
use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_engine::{
    DisputeFinalizationEvidence, EntityId, JurisdictionEvent,
    canonical_dispute_finalization_evidence_hash, canonical_event_value, canonical_events_hash,
};
use xln_rscore_entity_kernel::{
    FinalizedJEventBatch, canonical_j_event_blocks, project_finalized_j_event_batch,
};

use crate::tagged_json_from_canonical_value;

use super::{FinalizedJHeader, JWatcherError, JWatcherPoll};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObserveJRange {
    pub entity_id: EntityId,
    pub signer_id: String,
    pub jurisdiction_ref: String,
    pub scanned_through_height: u64,
    pub tip_block_hash: [u8; 32],
    /// Presence is protocol-visible: TypeScript omits `headers` on an
    /// event-only observation but preserves an explicitly supplied empty
    /// array. Keep that distinction through decode/replay projection.
    pub headers_present: bool,
    pub headers: Vec<FinalizedJHeader>,
    pub batches: Vec<FinalizedJEventBatch>,
}

fn invalid(code: impl Into<String>) -> JWatcherError {
    JWatcherError::Observation(code.into())
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}
fn tuple(values: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(values))
}
fn integer(value: i128) -> AbiValue {
    AbiValue::Integer(value)
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, JWatcherError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], JWatcherError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("ARRAY:{path}")))
}

fn field<'a>(
    value: &'a Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<&'a Value, JWatcherError> {
    value
        .get(name)
        .ok_or_else(|| invalid(format!("FIELD:{path}.{name}")))
}

fn exact(
    value: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    path: &str,
) -> Result<(), JWatcherError> {
    if let Some(name) = required.iter().find(|name| !value.contains_key(**name)) {
        return Err(invalid(format!("FIELD:{path}.{name}")));
    }
    if let Some(name) = value
        .keys()
        .find(|name| !required.contains(&name.as_str()) && !optional.contains(&name.as_str()))
    {
        return Err(invalid(format!("EXTRA:{path}.{name}")));
    }
    Ok(())
}

fn text(value: &Value, path: &str) -> Result<String, JWatcherError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn number(value: &Value, path: &str) -> Result<i128, JWatcherError> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
        .ok_or_else(|| invalid(format!("INTEGER:{path}")))
}

fn boolean(value: &Value, path: &str) -> Result<bool, JWatcherError> {
    value
        .as_bool()
        .ok_or_else(|| invalid(format!("BOOL:{path}")))
}

fn bytes(value: &Value, path: &str) -> Result<AbiValue, JWatcherError> {
    let value = text(value, path)?;
    let body = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid(format!("HEX:{path}")))?;
    let decoded = hex::decode(body).map_err(|_| invalid(format!("HEX:{path}")))?;
    if hex(&decoded) != value {
        return Err(invalid(format!("HEX_CANONICAL:{path}")));
    }
    Ok(AbiValue::Bytes(decoded))
}

fn bigint(value: &Value, path: &str) -> Result<AbiValue, JWatcherError> {
    let value = match value {
        Value::String(value) => value.clone(),
        Value::Object(value)
            if value.get("__xlnType").and_then(Value::as_str) == Some("BigInt") =>
        {
            text(field(value, "value", path)?, path)?
        }
        _ => return Err(invalid(format!("BIGINT:{path}"))),
    };
    value
        .parse::<num_bigint::BigInt>()
        .map_err(|_| invalid(format!("BIGINT:{path}")))?;
    Ok(AbiValue::Text(value))
}

fn optional(
    value: Option<&Value>,
    map: impl FnOnce(&Value) -> Result<AbiValue, JWatcherError>,
) -> Result<AbiValue, JWatcherError> {
    value.map_or(Ok(AbiValue::Nil), map)
}

fn metadata(event: &Map<String, Value>, path: &str) -> Result<AbiValue, JWatcherError> {
    Ok(tuple(vec![
        optional(event.get("blockNumber"), |v| Ok(integer(number(v, path)?)))?,
        optional(event.get("blockHash"), |v| bytes(v, path))?,
        optional(event.get("transactionHash"), |v| bytes(v, path))?,
        optional(event.get("logIndex"), |v| Ok(integer(number(v, path)?)))?,
        optional(event.get("eventIndex"), |v| Ok(integer(number(v, path)?)))?,
    ]))
}

fn proof_body(value: &Value, path: &str) -> Result<AbiValue, JWatcherError> {
    let value = object(value, path)?;
    exact(
        value,
        &[
            "watchSeed",
            "leftResponseSeconds",
            "rightResponseSeconds",
            "offdeltas",
            "tokenIds",
            "transformers",
        ],
        &[],
        path,
    )?;
    let bigs = |name: &str| -> Result<AbiValue, JWatcherError> {
        Ok(tuple(
            array(field(value, name, path)?, path)?
                .iter()
                .map(|v| bigint(v, path))
                .collect::<Result<Vec<_>, _>>()?,
        ))
    };
    let transformers = array(field(value, "transformers", path)?, path)?
        .iter()
        .map(|raw| {
            let row = object(raw, path)?;
            exact(
                row,
                &["transformerAddress", "encodedBatch", "allowances"],
                &[],
                path,
            )?;
            let allowances = array(field(row, "allowances", path)?, path)?
                .iter()
                .map(|raw| {
                    let allowance = object(raw, path)?;
                    exact(
                        allowance,
                        &["deltaIndex", "rightAllowance", "leftAllowance"],
                        &[],
                        path,
                    )?;
                    Ok(tuple(vec![
                        bigint(&allowance["deltaIndex"], path)?,
                        bigint(&allowance["rightAllowance"], path)?,
                        bigint(&allowance["leftAllowance"], path)?,
                    ]))
                })
                .collect::<Result<Vec<_>, JWatcherError>>()?;
            Ok(tuple(vec![
                AbiValue::Text(text(&row["transformerAddress"], path)?),
                AbiValue::Text(text(&row["encodedBatch"], path)?),
                tuple(allowances),
            ]))
        })
        .collect::<Result<Vec<_>, JWatcherError>>()?;
    Ok(tuple(vec![
        AbiValue::Text(text(&value["watchSeed"], path)?),
        integer(number(&value["leftResponseSeconds"], path)?),
        integer(number(&value["rightResponseSeconds"], path)?),
        bigs("offdeltas")?,
        bigs("tokenIds")?,
        tuple(transformers),
    ]))
}

fn event_abi(value: &Value, path: &str) -> Result<AbiValue, JWatcherError> {
    let event = object(value, path)?;
    exact(
        event,
        &["type", "data"],
        &[
            "blockNumber",
            "blockHash",
            "transactionHash",
            "logIndex",
            "eventIndex",
        ],
        path,
    )?;
    let kind = text(&event["type"], path)?;
    let data = object(&event["data"], path)?;
    let t = |name: &str| -> Result<AbiValue, JWatcherError> {
        Ok(AbiValue::Text(text(field(data, name, path)?, path)?))
    };
    let b = |name: &str| bytes(field(data, name, path)?, path);
    let n = |name: &str| -> Result<AbiValue, JWatcherError> {
        Ok(integer(number(field(data, name, path)?, path)?))
    };
    let big = |name: &str| bigint(field(data, name, path)?, path);
    let flag = |name: &str| -> Result<AbiValue, JWatcherError> {
        Ok(AbiValue::Bool(boolean(field(data, name, path)?, path)?))
    };
    let opt_n = |name: &str| optional(data.get(name), |v| Ok(integer(number(v, path)?)));
    let opt_big = |name: &str| optional(data.get(name), |v| bigint(v, path));
    let meta = metadata(event, path)?;
    let mut row = vec![
        integer(match kind.as_str() {
            "AccountSettled" => 0,
            "FoundationBootstrapped" => 1,
            "EntityRegistered" => 2,
            "BoardActivated" => 3,
            "ReserveUpdated" => 4,
            "ExternalWalletSnapshot" => 5,
            "ExternalWalletDelta" => 6,
            "SecretRevealed" => 7,
            "HankoBatchProcessed" => 8,
            "EntityProviderActionExecuted" => 9,
            "EntityProviderActionCancelled" => 10,
            "DebtCreated" => 11,
            "DisputeStarted" => 12,
            "DisputeFinalized" => 13,
            "CounterDisputeRegistered" => 14,
            "HashLadderRevealRegistered" => 15,
            "DebtEnforced" => 16,
            "DebtForgiven" => 17,
            _ => return Err(invalid(format!("EVENT_KIND:{kind}"))),
        }),
        meta,
    ];
    match kind.as_str() {
        "AccountSettled" => row.extend([
            b("leftEntity")?,
            b("rightEntity")?,
            n("tokenId")?,
            big("leftReserve")?,
            big("rightReserve")?,
            big("collateral")?,
            big("ondelta")?,
            n("nonce")?,
        ]),
        "FoundationBootstrapped" => row.extend([
            b("recipient")?,
            b("boardHash")?,
            big("controlTokenId")?,
            big("dividendTokenId")?,
        ]),
        "EntityRegistered" => row.extend([b("entityId")?, big("entityNumber")?, b("boardHash")?]),
        "BoardActivated" => row.extend([
            b("entityId")?,
            b("previousBoardHash")?,
            b("newBoardHash")?,
            big("previousBoardValidUntil")?,
        ]),
        "ReserveUpdated" => row.extend([t("entity")?, n("tokenId")?, big("newBalance")?]),
        "ExternalWalletSnapshot" => {
            let balances = data.get("tokenBalances").map_or(Ok(Vec::new()), |v| {
                array(v, path)?
                    .iter()
                    .map(|raw| {
                        let item = object(raw, path)?;
                        exact(item, &["tokenAddress", "balance"], &["tokenId"], path)?;
                        Ok(tuple(vec![
                            bytes(&item["tokenAddress"], path)?,
                            optional(item.get("tokenId"), |v| Ok(integer(number(v, path)?)))?,
                            bigint(&item["balance"], path)?,
                        ]))
                    })
                    .collect::<Result<Vec<_>, JWatcherError>>()
            })?;
            let allowances = data.get("allowances").map_or(Ok(Vec::new()), |v| {
                array(v, path)?
                    .iter()
                    .map(|raw| {
                        let item = object(raw, path)?;
                        exact(item, &["tokenAddress", "spender", "allowance"], &[], path)?;
                        Ok(tuple(vec![
                            bytes(&item["tokenAddress"], path)?,
                            bytes(&item["spender"], path)?,
                            bigint(&item["allowance"], path)?,
                        ]))
                    })
                    .collect::<Result<Vec<_>, JWatcherError>>()
            })?;
            row.extend([
                t("entityId")?,
                b("owner")?,
                opt_big("nativeBalance")?,
                tuple(balances),
                tuple(allowances),
            ]);
        }
        "ExternalWalletDelta" => row.extend([
            t("entityId")?,
            b("owner")?,
            b("tokenAddress")?,
            opt_n("tokenId")?,
            opt_big("balanceDelta")?,
            optional(data.get("spender"), |v| bytes(v, path))?,
            opt_big("allowance")?,
        ]),
        "SecretRevealed" => row.extend([t("hashlock")?, t("revealer")?, t("secret")?]),
        "HankoBatchProcessed" => row.extend([b("entityId")?, b("batchHash")?, n("nonce")?]),
        "EntityProviderActionExecuted" => row.extend([
            b("entityId")?,
            big("actionNonce")?,
            b("actionHash")?,
            n("actionKind")?,
        ]),
        "EntityProviderActionCancelled" => row.extend([
            b("entityId")?,
            big("actionNonce")?,
            b("cancelledActionHash")?,
            n("cancelledActionKind")?,
            b("cancelHash")?,
        ]),
        "DebtCreated" => row.extend([
            t("debtor")?,
            t("creditor")?,
            n("tokenId")?,
            big("amount")?,
            n("debtIndex")?,
        ]),
        "DisputeStarted" => row.extend([
            t("sender")?,
            t("counterentity")?,
            big("nonce")?,
            flag("proposerIsLeft")?,
            t("proofbodyHash")?,
            b("watchSeed")?,
            b("starterInitialArguments")?,
            b("starterCounterArguments")?,
            b("starterCounterProofCommitment")?,
            proof_body(field(data, "initialProofbody", path)?, path)?,
            n("disputeTimeout")?,
            n("disputeStartTimestamp")?,
            n("leftResponseSeconds")?,
            n("rightResponseSeconds")?,
            opt_n("batchNonce")?,
        ]),
        "DisputeFinalized" => row.extend([
            t("sender")?,
            t("counterentity")?,
            big("initialNonce")?,
            t("initialProofbodyHash")?,
            t("finalProofbodyHash")?,
            t("finalizationEvidenceHash")?,
            proof_body(field(data, "finalProofbody", path)?, path)?,
            opt_n("batchNonce")?,
        ]),
        "CounterDisputeRegistered" => row.extend([
            t("sender")?,
            t("counterentity")?,
            n("nonce")?,
            flag("proposerIsLeft")?,
            b("proofbodyHash")?,
            proof_body(field(data, "counterProofbody", path)?, path)?,
        ]),
        "HashLadderRevealRegistered" => row.extend([
            t("entity")?,
            t("counterpartyEntity")?,
            b("ladderHash")?,
            n("fillRatio")?,
            b("fullSecret")?,
            tuple(
                array(field(data, "reveals", path)?, path)?
                    .iter()
                    .map(|v| bytes(v, path))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            flag("targetRole")?,
            n("revealedAt")?,
        ]),
        "DebtEnforced" => row.extend([
            t("debtor")?,
            t("creditor")?,
            n("tokenId")?,
            big("amountPaid")?,
            big("remainingAmount")?,
            n("newDebtIndex")?,
        ]),
        "DebtForgiven" => row.extend([
            t("debtor")?,
            t("creditor")?,
            n("tokenId")?,
            big("amountForgiven")?,
            n("debtIndex")?,
        ]),
        _ => unreachable!(),
    }
    Ok(tuple(row))
}

fn decode_event(value: &Value, path: &str) -> Result<JurisdictionEvent, JWatcherError> {
    let wire = event_abi(value, path)?;
    let event = xln_rscore_batch::decode_jurisdiction_event(&wire)
        .map_err(|error| invalid(error.to_string()))?;
    let canonical = tagged_json_from_canonical_value(
        &canonical_event_value(&event).map_err(|error| invalid(error.to_string()))?,
    )
    .map_err(|error| invalid(error.to_string()))?;
    if &canonical != value {
        return Err(invalid(format!("EVENT_NON_CANONICAL:{path}")));
    }
    Ok(event)
}

fn evidence_json(value: &DisputeFinalizationEvidence) -> Value {
    serde_json::json!({
        "sender":value.sender,"counterentity":value.counterentity,"initialNonce":value.initial_nonce,
        "finalNonce":value.final_nonce,"initialProofbodyHash":value.initial_proofbody_hash,
        "finalProofbodyHash":value.final_proofbody_hash,"proposerIsLeft":value.proposer_is_left,
        "leftArguments":value.left_arguments,"rightArguments":value.right_arguments,
        "startedByLeft":value.started_by_left,"sig":value.sig,
    })
}

fn decode_evidence(
    value: &Value,
    path: &str,
) -> Result<DisputeFinalizationEvidence, JWatcherError> {
    let value = object(value, path)?;
    exact(
        value,
        &[
            "sender",
            "counterentity",
            "initialNonce",
            "finalNonce",
            "initialProofbodyHash",
            "finalProofbodyHash",
            "proposerIsLeft",
            "leftArguments",
            "rightArguments",
            "startedByLeft",
            "sig",
        ],
        &[],
        path,
    )?;
    Ok(DisputeFinalizationEvidence {
        sender: text(&value["sender"], path)?,
        counterentity: text(&value["counterentity"], path)?,
        initial_nonce: text(&value["initialNonce"], path)?,
        final_nonce: text(&value["finalNonce"], path)?,
        initial_proofbody_hash: text(&value["initialProofbodyHash"], path)?,
        final_proofbody_hash: text(&value["finalProofbodyHash"], path)?,
        proposer_is_left: boolean(&value["proposerIsLeft"], path)?,
        left_arguments: text(&value["leftArguments"], path)?,
        right_arguments: text(&value["rightArguments"], path)?,
        started_by_left: boolean(&value["startedByLeft"], path)?,
        sig: text(&value["sig"], path)?,
    })
}

pub fn encode_observe_j_range(value: &ObserveJRange) -> Result<Value, JWatcherError> {
    let blocks =
        canonical_j_event_blocks(&value.batches).map_err(|error| invalid(error.to_string()))?;
    let blocks = blocks
        .iter()
        .map(|block| -> Result<Value, JWatcherError> {
            let events = block
                .events
                .iter()
                .map(|event| {
                    tagged_json_from_canonical_value(
                        &canonical_event_value(event)
                            .map_err(|e: xln_rscore_engine::StateError| invalid(e.to_string()))?,
                    )
                    .map_err(|e| invalid(e.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let evidence = block
                .dispute_finalization_evidence
                .iter()
                .map(evidence_json)
                .collect::<Vec<_>>();
            let mut object = Map::from_iter([
                (
                    "jurisdictionRef".into(),
                    Value::String(value.jurisdiction_ref.clone()),
                ),
                ("jHeight".into(), Value::Number(block.j_height.into())),
                ("jBlockHash".into(), Value::String(hex(&block.j_block_hash))),
                ("eventsHash".into(), Value::String(hex(&block.events_hash))),
                ("events".into(), Value::Array(events)),
            ]);
            if !evidence.is_empty() {
                object.insert("disputeFinalizationEvidence".into(), Value::Array(evidence));
                object.insert(
                    "disputeFinalizationEvidenceHash".into(),
                    Value::String(hex(&block.dispute_finalization_evidence_hash)),
                );
            }
            Ok(Value::Object(object))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut encoded = Map::from_iter([
        ("entityId".into(), Value::String(value.entity_id.as_hex())),
        ("signerId".into(), Value::String(value.signer_id.clone())),
        (
            "jurisdictionRef".into(),
            Value::String(value.jurisdiction_ref.clone()),
        ),
        (
            "scannedThroughHeight".into(),
            Value::from(value.scanned_through_height),
        ),
        (
            "tipBlockHash".into(),
            Value::String(hex(&value.tip_block_hash)),
        ),
        ("blocks".into(), Value::Array(blocks)),
    ]);
    if value.headers_present {
        encoded.insert(
            "headers".into(),
            Value::Array(
                value
                    .headers
                    .iter()
                    .map(|header| {
                        serde_json::json!({
                            "jHeight": header.j_height,
                            "jBlockHash": hex(&header.j_block_hash),
                        })
                    })
                    .collect(),
            ),
        );
    }
    Ok(Value::Object(encoded))
}

pub fn decode_observe_j_range(value: &Value) -> Result<ObserveJRange, JWatcherError> {
    let data = object(value, "observeJRange")?;
    exact(
        data,
        &[
            "entityId",
            "signerId",
            "jurisdictionRef",
            "scannedThroughHeight",
            "tipBlockHash",
            "blocks",
        ],
        &["headers"],
        "observeJRange",
    )?;
    let entity_id = EntityId::parse(&text(&data["entityId"], "entityId")?)
        .map_err(|e| invalid(e.to_string()))?;
    let signer_id = text(&data["signerId"], "signerId")?;
    let jurisdiction_ref = text(&data["jurisdictionRef"], "jurisdictionRef")?;
    let scanned_through_height = u64::try_from(number(
        &data["scannedThroughHeight"],
        "scannedThroughHeight",
    )?)
    .map_err(|_| invalid("SCANNED_HEIGHT"))?;
    let tip_block_hash = match bytes(&data["tipBlockHash"], "tipBlockHash")? {
        AbiValue::Bytes(v) => v.try_into().map_err(|_| invalid("TIP_HASH"))?,
        _ => unreachable!(),
    };
    let headers = data.get("headers").map_or(Ok(Vec::new()), |raw| {
        array(raw, "headers")?
            .iter()
            .enumerate()
            .map(|(index, raw)| {
                let path = format!("headers[{index}]");
                let row = object(raw, &path)?;
                exact(row, &["jHeight", "jBlockHash"], &[], &path)?;
                let hash = match bytes(&row["jBlockHash"], &path)? {
                    AbiValue::Bytes(v) => v.try_into().map_err(|_| invalid("HEADER_HASH"))?,
                    _ => unreachable!(),
                };
                Ok(FinalizedJHeader {
                    j_height: u64::try_from(number(&row["jHeight"], &path)?)
                        .map_err(|_| invalid("HEADER_HEIGHT"))?,
                    j_block_hash: hash,
                })
            })
            .collect::<Result<Vec<_>, JWatcherError>>()
    })?;
    let mut batches = Vec::new();
    for (index, raw) in array(&data["blocks"], "blocks")?.iter().enumerate() {
        let path = format!("blocks[{index}]");
        let block = object(raw, &path)?;
        exact(
            block,
            &[
                "jurisdictionRef",
                "jHeight",
                "jBlockHash",
                "eventsHash",
                "events",
            ],
            &[
                "disputeFinalizationEvidence",
                "disputeFinalizationEvidenceHash",
            ],
            &path,
        )?;
        if text(&block["jurisdictionRef"], &path)? != jurisdiction_ref {
            return Err(invalid("BLOCK_JURISDICTION"));
        }
        let j_height = u64::try_from(number(&block["jHeight"], &path)?)
            .map_err(|_| invalid("BLOCK_HEIGHT"))?;
        let j_block_hash = match bytes(&block["jBlockHash"], &path)? {
            AbiValue::Bytes(v) => v.try_into().map_err(|_| invalid("BLOCK_HASH"))?,
            _ => unreachable!(),
        };
        let events = array(&block["events"], &path)?
            .iter()
            .enumerate()
            .map(|(i, v)| decode_event(v, &format!("{path}.events[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let expected_events_hash: [u8; 32] = match bytes(&block["eventsHash"], &path)? {
            AbiValue::Bytes(v) => v.try_into().map_err(|_| invalid("EVENTS_HASH"))?,
            _ => unreachable!(),
        };
        if canonical_events_hash(&events).map_err(|e| invalid(e.to_string()))?
            != expected_events_hash
        {
            return Err(invalid("EVENTS_HASH_MISMATCH"));
        }
        let evidence = block
            .get("disputeFinalizationEvidence")
            .map_or(Ok(Vec::new()), |raw| {
                array(raw, &path)?
                    .iter()
                    .enumerate()
                    .map(|(i, v)| decode_evidence(v, &format!("{path}.evidence[{i}]")))
                    .collect::<Result<Vec<_>, _>>()
            })?;
        if evidence.is_empty() {
            if block.contains_key("disputeFinalizationEvidenceHash") {
                return Err(invalid("EMPTY_EVIDENCE_HASH"));
            }
        } else {
            let expected: [u8; 32] = match bytes(
                field(block, "disputeFinalizationEvidenceHash", &path)?,
                &path,
            )? {
                AbiValue::Bytes(v) => v.try_into().map_err(|_| invalid("EVIDENCE_HASH"))?,
                _ => unreachable!(),
            };
            if canonical_dispute_finalization_evidence_hash(&evidence)
                .map_err(|e| invalid(e.to_string()))?
                != expected
            {
                return Err(invalid("EVIDENCE_HASH_MISMATCH"));
            }
        }
        batches.push(
            project_finalized_j_event_batch(&entity_id, j_height, j_block_hash, events, evidence)
                .map_err(|e| invalid(e.to_string()))?,
        );
    }
    let unique = headers.iter().map(|h| h.j_height).collect::<BTreeSet<_>>();
    if headers.len() != unique.len()
        || headers
            .windows(2)
            .any(|w| w[0].j_height + 1 != w[1].j_height)
        || headers.last().is_some_and(|h| {
            h.j_height != scanned_through_height || h.j_block_hash != tip_block_hash
        })
    {
        return Err(invalid("HEADER_RANGE"));
    }
    Ok(ObserveJRange {
        entity_id,
        signer_id,
        jurisdiction_ref,
        scanned_through_height,
        tip_block_hash,
        headers_present: data.contains_key("headers"),
        headers,
        batches,
    })
}

pub fn observation_from_poll(
    entity_id: EntityId,
    signer_id: String,
    jurisdiction_ref: String,
    poll: JWatcherPoll,
) -> Result<ObserveJRange, JWatcherError> {
    let tip_block_hash = poll
        .cursor
        .block_hash
        .ok_or_else(|| invalid("POLL_TIP_HASH"))?;
    let value = ObserveJRange {
        entity_id,
        signer_id,
        jurisdiction_ref,
        scanned_through_height: poll.cursor.scanned_through,
        tip_block_hash,
        headers_present: !poll.headers.is_empty(),
        headers: poll.headers,
        batches: poll.batches,
    };
    decode_observe_j_range(&encode_observe_j_range(&value)?)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn observe_range_projection_preserves_optional_headers_presence() {
        let base = json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": format!("0x{}", "22".repeat(20)),
            "jurisdictionRef": format!("stack:31337:0x{}", "33".repeat(20)),
            "scannedThroughHeight": 7,
            "tipBlockHash": format!("0x{}", "44".repeat(32)),
            "blocks": [],
        });
        let absent = decode_observe_j_range(&base).expect("headers absent");
        assert!(!absent.headers_present);
        assert!(
            encode_observe_j_range(&absent)
                .expect("encode absent")
                .get("headers")
                .is_none()
        );

        let mut explicit = base;
        explicit["headers"] = json!([]);
        let explicit = decode_observe_j_range(&explicit).expect("headers explicit");
        assert!(explicit.headers_present);
        assert_eq!(
            encode_observe_j_range(&explicit).expect("encode explicit")["headers"],
            json!([]),
        );
    }
}
