//! Exact Entity-local output projection for the Runtime outbox.
//!
//! Entity owns authorization and produces typed outputs. Runtime adds only the
//! route envelope; it must never reconstruct an Account proposal from hashes
//! or re-interpret a certified generic output.

use num_bigint::BigInt;
use serde_json::{Map, Number, Value};
use thiserror::Error;
use xln_rscore_batch::{AccountInputKind, AccountPeerInput};
use xln_rscore_engine::{
    AccountFrame, CounterpartyDispute, IncomingAck, IncomingFrame, StateError, canonical_tx_value,
};
use xln_rscore_entity_kernel::{EntityOutputError, LocalEntityOutput, LocalEntityOutputTx};
use xln_rscore_protocol::CanonicalValue;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum EntityOutputEncodingError {
    #[error("RRS_ENTITY_OUTPUT_SAFE_INTEGER:{field}:{value}")]
    SafeInteger { field: &'static str, value: u64 },
    #[error("RRS_ENTITY_OUTPUT_CANONICAL_NUMBER:{0}")]
    CanonicalNumber(String),
    #[error("RRS_ENTITY_OUTPUT_TARGET_MISMATCH:{index}:{outer}:{inner}")]
    TargetMismatch {
        index: usize,
        outer: String,
        inner: String,
    },
    #[error("RRS_ENTITY_OUTPUT_RUNTIME_ROUTE_MISSING:{0}")]
    RuntimeRouteMissing(&'static str),
    #[error("RRS_ENTITY_OUTPUT_MIXED_PROTOCOL_PAYLOAD:{0}")]
    MixedProtocolPayload(usize),
    #[error(transparent)]
    Account(#[from] StateError),
    #[error(transparent)]
    Entity(#[from] EntityOutputError),
}

/// Encode Entity-authorized local outputs without adding Runtime routing.
///
/// The returned values are the exact TS `EntityOutput` surface. The caller
/// binds `runtimeId`, `signerId` and `sourceRuntimeFrame`, then serializes once
/// into the fsynced flat outbox row.
pub fn encode_local_entity_outputs(
    outputs: Vec<LocalEntityOutput>,
    source_entity_id: &str,
    source_signer_id: &str,
) -> Result<Vec<Value>, EntityOutputEncodingError> {
    outputs
        .into_iter()
        .enumerate()
        .map(|(index, output)| {
            encode_local_entity_output(index, output, source_entity_id, source_signer_id)
        })
        .collect()
}

pub(crate) fn encode_local_entity_output(
    index: usize,
    output: LocalEntityOutput,
    source_entity_id: &str,
    source_signer_id: &str,
) -> Result<Value, EntityOutputEncodingError> {
    let entity_id = output.entity_id.to_ascii_lowercase();
    let mut account_txs = Vec::new();
    let mut projected_txs = Vec::new();
    for tx in output.entity_txs {
        match tx {
            LocalEntityOutputTx::AccountInput(input) => {
                let inner = hex(&input.envelope.to_entity_id);
                if inner != entity_id {
                    return Err(EntityOutputEncodingError::TargetMismatch {
                        index,
                        outer: entity_id.clone(),
                        inner,
                    });
                }
                account_txs.push(object([
                    ("type", Value::String("accountInput".into())),
                    ("data", encode_account_input(&input)?),
                ]));
            }
            LocalEntityOutputTx::Projected(projected) => {
                projected_txs.push(object([
                    ("type", Value::String(projected.kind.as_str().into())),
                    (
                        "data",
                        canonical_json_ref(projected.frame_data().ok_or_else(|| {
                            EntityOutputEncodingError::Entity(
                                EntityOutputError::ProjectedDataMissing(projected.kind.as_str()),
                            )
                        })?)?,
                    ),
                ]));
            }
        }
    }
    if !account_txs.is_empty() && !projected_txs.is_empty() {
        return Err(EntityOutputEncodingError::MixedProtocolPayload(index));
    }
    let entity_txs = if projected_txs.is_empty() {
        account_txs
    } else {
        let source_entity_id = source_entity_id.trim().to_ascii_lowercase();
        let source_signer_id = source_signer_id.trim().to_ascii_lowercase();
        if source_entity_id.is_empty() {
            return Err(EntityOutputEncodingError::RuntimeRouteMissing(
                "sourceEntityId",
            ));
        }
        if source_signer_id.is_empty() {
            return Err(EntityOutputEncodingError::RuntimeRouteMissing(
                "sourceSignerId",
            ));
        }
        vec![object([
            ("type", Value::String("runtimeOutput".into())),
            (
                "data",
                object([
                    ("protocol", Value::String("cross-j".into())),
                    ("sourceEntityId", Value::String(source_entity_id)),
                    ("sourceSignerId", Value::String(source_signer_id)),
                    ("targetEntityId", Value::String(entity_id.clone())),
                    ("entityTxs", Value::Array(projected_txs)),
                ]),
            ),
        ])]
    };
    Ok(object([
        ("entityId", Value::String(entity_id)),
        ("entityTxs", Value::Array(entity_txs)),
    ]))
}

fn encode_account_input(input: &AccountPeerInput) -> Result<Value, EntityOutputEncodingError> {
    let envelope = &input.envelope;
    let mut fields = Map::from_iter([
        (
            "fromEntityId".into(),
            Value::String(hex(&envelope.from_entity_id)),
        ),
        (
            "toEntityId".into(),
            Value::String(hex(&envelope.to_entity_id)),
        ),
        (
            "domain".into(),
            object([
                (
                    "chainId",
                    safe_number("domain.chainId", envelope.domain.chain_id())?,
                ),
                (
                    "depositoryAddress",
                    Value::String(envelope.domain.depository_address().as_hex()),
                ),
            ]),
        ),
        (
            "disputeConfig".into(),
            object([
                (
                    "leftResponseSeconds",
                    Value::Number(Number::from(
                        envelope.dispute_config.left_response_seconds(),
                    )),
                ),
                (
                    "rightResponseSeconds",
                    Value::Number(Number::from(
                        envelope.dispute_config.right_response_seconds(),
                    )),
                ),
            ]),
        ),
    ]);
    if let Some(seed) = &envelope.watch_seed {
        fields.insert("watchSeed".into(), Value::String(seed.as_hex()));
    }
    match &input.kind {
        AccountInputKind::Frame(frame) => {
            fields.insert("kind".into(), Value::String("frame".into()));
            fields.insert("proposal".into(), encode_proposal(frame)?);
        }
        AccountInputKind::Ack(ack) => {
            fields.insert("kind".into(), Value::String("ack".into()));
            fields.insert("ack".into(), encode_ack(ack)?);
        }
        AccountInputKind::AckFrame { ack, frame } => {
            fields.insert("kind".into(), Value::String("ack_frame".into()));
            fields.insert("ack".into(), encode_ack(ack)?);
            fields.insert("proposal".into(), encode_proposal(frame)?);
        }
        AccountInputKind::Dispute(dispute) => {
            fields.insert("kind".into(), Value::String("dispute".into()));
            fields.insert("disputeHanko".into(), encode_dispute(dispute)?);
        }
        AccountInputKind::BoardHankoRefresh(refresh) => {
            fields.insert("kind".into(), Value::String("board_hanko_refresh".into()));
            let mut value = Map::from_iter([
                (
                    "height".into(),
                    safe_number("boardHankoRefresh.height", refresh.height)?,
                ),
                ("frameHash".into(), Value::String(hex(&refresh.frame_hash))),
                (
                    "boardActivationJHeight".into(),
                    safe_number(
                        "boardHankoRefresh.boardActivationJHeight",
                        refresh.board_activation_j_height,
                    )?,
                ),
                (
                    "boardActivationLogIndex".into(),
                    safe_number(
                        "boardHankoRefresh.boardActivationLogIndex",
                        refresh.board_activation_log_index,
                    )?,
                ),
            ]);
            if let Some(hanko) = &refresh.frame_hanko {
                value.insert("frameHanko".into(), Value::String(hex(hanko)));
            }
            if let Some(dispute) = &refresh.dispute {
                value.insert("disputeHanko".into(), encode_dispute(dispute)?);
            }
            fields.insert("boardHankoRefresh".into(), Value::Object(value));
        }
    }
    Ok(Value::Object(fields))
}

fn encode_proposal(frame: &IncomingFrame) -> Result<Value, EntityOutputEncodingError> {
    let mut fields = Map::from_iter([("frame".into(), encode_frame(frame)?)]);
    if let Some(hanko) = &frame.frame_hanko {
        fields.insert("frameHanko".into(), Value::String(hex(hanko)));
    }
    if let Some(dispute) = &frame.dispute {
        fields.insert("disputeHanko".into(), encode_dispute(dispute)?);
    }
    Ok(Value::Object(fields))
}

fn encode_ack(ack: &IncomingAck) -> Result<Value, EntityOutputEncodingError> {
    let mut fields = Map::from_iter([
        ("height".into(), safe_number("ack.height", ack.height)?),
        ("frameHash".into(), Value::String(hex(&ack.frame_hash))),
    ]);
    if let Some(hanko) = &ack.frame_hanko {
        fields.insert("frameHanko".into(), Value::String(hex(hanko)));
    }
    if let Some(dispute) = &ack.dispute {
        fields.insert("disputeHanko".into(), encode_dispute(dispute)?);
    }
    Ok(Value::Object(fields))
}

fn encode_dispute(dispute: &CounterpartyDispute) -> Result<Value, EntityOutputEncodingError> {
    let mut fields = Map::from_iter([
        ("hash".into(), Value::String(hex(&dispute.hash))),
        (
            "proofBodyHash".into(),
            Value::String(hex(&dispute.proof_body_hash)),
        ),
        (
            "proofNonce".into(),
            safe_number("dispute.proofNonce", dispute.nonce)?,
        ),
        (
            "proposerIsLeft".into(),
            Value::Bool(dispute.proposer_is_left),
        ),
    ]);
    if let Some(hanko) = &dispute.hanko {
        fields.insert("hanko".into(), Value::String(hex(hanko)));
    }
    Ok(Value::Object(fields))
}

fn encode_frame(frame: &IncomingFrame) -> Result<Value, EntityOutputEncodingError> {
    let AccountFrame {
        height,
        timestamp,
        j_height,
        txs,
        prev_frame_hash,
        account_state_root,
    } = &frame.frame;
    Ok(object([
        ("height", safe_number("frame.height", *height)?),
        ("timestamp", safe_number("frame.timestamp", *timestamp)?),
        ("jHeight", safe_number("frame.jHeight", *j_height)?),
        (
            "accountTxs",
            Value::Array(
                txs.iter()
                    .map(|tx| {
                        canonical_tx_value(tx)
                            .map_err(EntityOutputEncodingError::from)
                            .and_then(canonical_json)
                    })
                    .collect::<Result<Vec<_>, EntityOutputEncodingError>>()?,
            ),
        ),
        ("prevFrameHash", Value::String(prev_frame_hash.clone())),
        ("accountStateRoot", Value::String(hex(account_state_root))),
        ("stateHash", Value::String(hex(&frame.state_hash))),
    ]))
}

pub(crate) fn canonical_json(value: CanonicalValue) -> Result<Value, EntityOutputEncodingError> {
    match value {
        CanonicalValue::Null => Ok(Value::Null),
        CanonicalValue::Bool(value) => Ok(Value::Bool(value)),
        CanonicalValue::Number(value) => value
            .as_str()
            .parse::<Number>()
            .map(Value::Number)
            .map_err(|_| EntityOutputEncodingError::CanonicalNumber(value.as_str().into())),
        CanonicalValue::BigInt(value) => Ok(tagged_bigint(&value)),
        CanonicalValue::String(value) => Ok(Value::String(value)),
        CanonicalValue::Array(values) => Ok(Value::Array(
            values
                .into_iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        CanonicalValue::Object(entries) => Ok(Value::Object(
            entries
                .into_iter()
                .map(|(key, value)| Ok((key, canonical_json(value)?)))
                .collect::<Result<Map<_, _>, EntityOutputEncodingError>>()?,
        )),
        CanonicalValue::Map(entries) => Ok(tagged(
            "Map",
            Value::Array(
                entries
                    .into_iter()
                    .map(|(key, value)| {
                        Ok(Value::Array(vec![
                            canonical_json(key)?,
                            canonical_json(value)?,
                        ]))
                    })
                    .collect::<Result<Vec<_>, EntityOutputEncodingError>>()?,
            ),
        )),
        CanonicalValue::Set(entries) => Ok(tagged(
            "Set",
            Value::Array(
                entries
                    .into_iter()
                    .map(canonical_json)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        )),
    }
}

pub(crate) fn canonical_json_ref(
    value: &CanonicalValue,
) -> Result<Value, EntityOutputEncodingError> {
    match value {
        CanonicalValue::Null => Ok(Value::Null),
        CanonicalValue::Bool(value) => Ok(Value::Bool(*value)),
        CanonicalValue::Number(value) => value
            .as_str()
            .parse::<Number>()
            .map(Value::Number)
            .map_err(|_| EntityOutputEncodingError::CanonicalNumber(value.as_str().into())),
        CanonicalValue::BigInt(value) => Ok(tagged_bigint(value)),
        CanonicalValue::String(value) => Ok(Value::String(value.clone())),
        CanonicalValue::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(canonical_json_ref)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        CanonicalValue::Object(entries) => Ok(Value::Object(
            entries
                .iter()
                .map(|(key, value)| Ok((key.clone(), canonical_json_ref(value)?)))
                .collect::<Result<Map<_, _>, EntityOutputEncodingError>>()?,
        )),
        CanonicalValue::Map(entries) => Ok(tagged(
            "Map",
            Value::Array(
                entries
                    .iter()
                    .map(|(key, value)| {
                        Ok(Value::Array(vec![
                            canonical_json_ref(key)?,
                            canonical_json_ref(value)?,
                        ]))
                    })
                    .collect::<Result<Vec<_>, EntityOutputEncodingError>>()?,
            ),
        )),
        CanonicalValue::Set(entries) => Ok(tagged(
            "Set",
            Value::Array(
                entries
                    .iter()
                    .map(canonical_json_ref)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        )),
    }
}

fn tagged_bigint(value: &BigInt) -> Value {
    tagged("BigInt", Value::String(value.to_string()))
}

fn tagged(kind: &str, value: Value) -> Value {
    object([("__xlnType", Value::String(kind.into())), ("value", value)])
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn safe_number(field: &'static str, value: u64) -> Result<Value, EntityOutputEncodingError> {
    if value > MAX_SAFE_INTEGER {
        return Err(EntityOutputEncodingError::SafeInteger { field, value });
    }
    Ok(Value::Number(Number::from(value)))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use xln_rscore_batch::AccountInputKind;
    use xln_rscore_engine::{
        AccountDisputeConfig, AccountDomain, AccountPeerEnvelope, DepositoryAddress, IncomingAck,
    };

    use super::*;

    fn entity(byte: u8) -> String {
        hex(&[byte; 32])
    }

    fn ack_input() -> AccountPeerInput {
        AccountPeerInput {
            envelope: AccountPeerEnvelope {
                from_entity_id: [0x11; 32],
                to_entity_id: [0x22; 32],
                domain: AccountDomain::new(
                    31337,
                    DepositoryAddress::parse("0x3333333333333333333333333333333333333333")
                        .expect("depository"),
                )
                .expect("domain"),
                dispute_config: AccountDisputeConfig::new(60, 120).expect("dispute config"),
                watch_seed: None,
            },
            kind: AccountInputKind::Ack(IncomingAck {
                height: 7,
                frame_hash: [0x44; 32],
                frame_hanko: Some(vec![0x55; 65]),
                dispute: None,
            }),
        }
    }

    #[test]
    fn account_output_is_the_exact_inverse_of_the_runtime_decoder() {
        let witnesses = std::collections::BTreeMap::new();
        let output = LocalEntityOutput::account_input(ack_input(), &witnesses)
            .expect("authorized account output");
        let encoded = encode_local_entity_outputs(vec![output], &entity(0x11), "source-signer")
            .expect("encode");
        assert_eq!(encoded[0]["entityId"], entity(0x22));
        let entity_tx = &encoded[0]["entityTxs"][0];
        let decoded = crate::decode_entity_account_input_row(&entity(0x22), 9, entity_tx)
            .expect("decode exact output");
        assert_eq!(decoded.operation_index, 9);
        assert_eq!(decoded.input.envelope.from_entity_id, [0x11; 32]);
        assert_eq!(decoded.input.envelope.to_entity_id, [0x22; 32]);
        match decoded.input.kind {
            AccountInputKind::Ack(ack) => {
                assert_eq!(ack.height, 7);
                assert_eq!(ack.frame_hash, [0x44; 32]);
                assert_eq!(ack.frame_hanko, Some(vec![0x55; 65]));
            }
            _ => panic!("ack output required"),
        }
    }

    #[test]
    fn non_mutating_self_wake_preserves_the_exact_empty_entity_input() {
        let target = entity(0x22);
        let encoded = encode_local_entity_outputs(
            vec![LocalEntityOutput::non_mutating_wake(target.clone())],
            &entity(0x11),
            "source-signer",
        )
        .expect("encode wake");
        assert_eq!(encoded, vec![json!({"entityId": target, "entityTxs": []})],);
    }

    #[test]
    fn cross_j_output_is_wrapped_once_with_committed_source_authority() {
        let source = entity(0x11);
        let target = entity(0x22);
        let projected = xln_rscore_entity_kernel::CanonicalEntityTx::from_frame_projection(
            xln_rscore_entity_kernel::EntityTxKind::PrepareCrossJurisdictionSwap,
            CanonicalValue::Object(vec![(
                "route".into(),
                CanonicalValue::Object(vec![(
                    "orderId".into(),
                    CanonicalValue::String("order-1".into()),
                )]),
            )]),
        )
        .expect("projected cross-j tx");
        let encoded = encode_local_entity_outputs(
            vec![LocalEntityOutput {
                entity_id: target.clone(),
                entity_txs: vec![LocalEntityOutputTx::Projected(projected)],
            }],
            &source,
            "source-signer",
        )
        .expect("encode runtime output");
        assert_eq!(encoded[0]["entityId"], target);
        assert_eq!(encoded[0]["entityTxs"].as_array().unwrap().len(), 1);
        let wrapper = &encoded[0]["entityTxs"][0];
        assert_eq!(wrapper["type"], "runtimeOutput");
        assert_eq!(wrapper["data"]["protocol"], "cross-j");
        assert_eq!(wrapper["data"]["sourceEntityId"], source);
        assert_eq!(wrapper["data"]["sourceSignerId"], "source-signer");
        assert_eq!(wrapper["data"]["targetEntityId"], target);
        assert_eq!(
            wrapper["data"]["entityTxs"][0]["type"],
            "prepareCrossJurisdictionSwap"
        );
    }
}
