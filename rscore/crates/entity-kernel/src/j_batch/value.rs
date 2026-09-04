use ethabi::ethereum_types::U256;
use num_bigint::{BigInt, Sign};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, JS_MAX_SAFE_INTEGER};

use super::*;

fn err(detail: impl Into<String>) -> JBatchError {
    JBatchError::Abi(format!("J_BATCH_STATE_CANONICAL:{}", detail.into()))
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn number(value: u64, field: &str) -> Result<CanonicalValue, JBatchError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| err(format!("UNSAFE_NUMBER:{field}:{value}")))
}

fn object(entries: impl IntoIterator<Item = (&'static str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn array<T>(
    values: &[T],
    project: impl Fn(&T) -> Result<CanonicalValue, JBatchError>,
) -> Result<CanonicalValue, JBatchError> {
    Ok(CanonicalValue::Array(
        values.iter().map(project).collect::<Result<_, _>>()?,
    ))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 15) as usize]));
    }
    output
}

fn u256_big(value: &U256) -> CanonicalValue {
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    CanonicalValue::BigInt(BigInt::from_bytes_be(Sign::Plus, &bytes))
}

fn u256_number(value: &U256, field: &str) -> Result<CanonicalValue, JBatchError> {
    if value > &U256::from(JS_MAX_SAFE_INTEGER) {
        return Err(err(format!("UNSAFE_NUMBER:{field}:{value}")));
    }
    number(value.low_u64(), field)
}

fn signed(value: &BigInt) -> CanonicalValue {
    CanonicalValue::BigInt(value.clone())
}

fn proof_body(value: &ProofBody) -> Result<CanonicalValue, JBatchError> {
    Ok(object([
        ("watchSeed", text(hex(&value.watch_seed))),
        (
            "leftResponseSeconds",
            number(
                u64::from(value.left_response_seconds),
                "proofBody.leftResponseSeconds",
            )?,
        ),
        (
            "rightResponseSeconds",
            number(
                u64::from(value.right_response_seconds),
                "proofBody.rightResponseSeconds",
            )?,
        ),
        (
            "offdeltas",
            CanonicalValue::Array(value.offdeltas.iter().map(signed).collect()),
        ),
        (
            "tokenIds",
            CanonicalValue::Array(value.token_ids.iter().map(u256_big).collect()),
        ),
        (
            "transformers",
            array(&value.transformers, |transformer| {
                Ok(object([
                    (
                        "transformerAddress",
                        text(hex(&transformer.transformer_address)),
                    ),
                    ("encodedBatch", text(hex(&transformer.encoded_batch))),
                    (
                        "allowances",
                        array(&transformer.allowances, |allowance| {
                            Ok(object([
                                ("deltaIndex", u256_big(&allowance.delta_index)),
                                ("rightAllowance", u256_big(&allowance.right_allowance)),
                                ("leftAllowance", u256_big(&allowance.left_allowance)),
                            ]))
                        })?,
                    ),
                ]))
            })?,
        ),
    ]))
}

pub fn canonical_j_batch(value: &JBatch) -> Result<CanonicalValue, JBatchError> {
    Ok(object([
        (
            "reserveToReserve",
            array(&value.reserve_to_reserve, |op| {
                Ok(object([
                    ("receivingEntity", text(hex(&op.receiving_entity))),
                    (
                        "tokenId",
                        u256_number(&op.token_id, "reserveToReserve.tokenId")?,
                    ),
                    ("amount", u256_big(&op.amount)),
                ]))
            })?,
        ),
        (
            "reserveToCollateral",
            array(&value.reserve_to_collateral, |op| {
                Ok(object([
                    (
                        "tokenId",
                        u256_number(&op.token_id, "reserveToCollateral.tokenId")?,
                    ),
                    ("receivingEntity", text(hex(&op.receiving_entity))),
                    (
                        "pairs",
                        array(&op.pairs, |pair| {
                            Ok(object([
                                ("entity", text(hex(&pair.entity))),
                                ("amount", u256_big(&pair.amount)),
                            ]))
                        })?,
                    ),
                ]))
            })?,
        ),
        (
            "collateralToReserve",
            array(&value.collateral_to_reserve, |op| {
                Ok(object([
                    ("counterparty", text(hex(&op.counterparty))),
                    (
                        "tokenId",
                        u256_number(&op.token_id, "collateralToReserve.tokenId")?,
                    ),
                    ("amount", u256_big(&op.amount)),
                    (
                        "nonce",
                        u256_number(&op.nonce, "collateralToReserve.nonce")?,
                    ),
                    ("sig", text(hex(&op.sig))),
                ]))
            })?,
        ),
        (
            "settlements",
            array(&value.settlements, |op| {
                Ok(object([
                    ("leftEntity", text(hex(&op.left_entity))),
                    ("rightEntity", text(hex(&op.right_entity))),
                    (
                        "diffs",
                        array(&op.diffs, |diff| {
                            Ok(object([
                                (
                                    "tokenId",
                                    u256_number(&diff.token_id, "settlement.diff.tokenId")?,
                                ),
                                ("leftDiff", signed(&diff.left_diff)),
                                ("rightDiff", signed(&diff.right_diff)),
                                ("collateralDiff", signed(&diff.collateral_diff)),
                                ("ondeltaDiff", signed(&diff.ondelta_diff)),
                            ]))
                        })?,
                    ),
                    (
                        "forgiveDebtsInTokenIds",
                        CanonicalValue::Array(
                            op.forgive_debts_in_token_ids
                                .iter()
                                .map(|id| u256_number(id, "settlement.forgiveTokenId"))
                                .collect::<Result<_, _>>()?,
                        ),
                    ),
                    ("sig", text(hex(&op.sig))),
                    ("nonce", u256_number(&op.nonce, "settlement.nonce")?),
                ]))
            })?,
        ),
        (
            "disputeStarts",
            array(&value.dispute_starts, |op| {
                Ok(object([
                    ("counterentity", text(hex(&op.counterentity))),
                    ("nonce", u256_number(&op.nonce, "disputeStart.nonce")?),
                    ("proposerIsLeft", CanonicalValue::Bool(op.proposer_is_left)),
                    ("proofbodyHash", text(hex(&op.proofbody_hash))),
                    ("initialProofbody", proof_body(&op.initial_proofbody)?),
                    ("watchSeed", text(hex(&op.watch_seed))),
                    ("sig", text(hex(&op.sig))),
                    (
                        "starterInitialArguments",
                        text(hex(&op.starter_initial_arguments)),
                    ),
                    (
                        "starterCounterArguments",
                        text(hex(&op.starter_counter_arguments)),
                    ),
                    (
                        "starterCounterProofCommitment",
                        text(hex(&op.starter_counter_proof_commitment)),
                    ),
                ]))
            })?,
        ),
        (
            "counterDisputes",
            array(&value.counter_disputes, |op| {
                Ok(object([
                    ("counterentity", text(hex(&op.counterentity))),
                    (
                        "initialNonce",
                        u256_number(&op.initial_nonce, "counterDispute.initialNonce")?,
                    ),
                    (
                        "initialProofbodyHash",
                        text(hex(&op.initial_proofbody_hash)),
                    ),
                    (
                        "counterNonce",
                        u256_number(&op.counter_nonce, "counterDispute.counterNonce")?,
                    ),
                    ("proposerIsLeft", CanonicalValue::Bool(op.proposer_is_left)),
                    ("counterProofbody", proof_body(&op.counter_proofbody)?),
                    ("sig", text(hex(&op.sig))),
                ]))
            })?,
        ),
        (
            "disputeFinalizations",
            array(&value.dispute_finalizations, |op| {
                let mut fields = vec![
                    ("counterentity", text(hex(&op.counterentity))),
                    (
                        "initialNonce",
                        u256_number(&op.initial_nonce, "disputeFinalization.initialNonce")?,
                    ),
                    (
                        "finalNonce",
                        u256_number(&op.final_nonce, "disputeFinalization.finalNonce")?,
                    ),
                    ("proposerIsLeft", CanonicalValue::Bool(op.proposer_is_left)),
                    (
                        "initialProofbodyHash",
                        text(hex(&op.initial_proofbody_hash)),
                    ),
                    ("finalProofbody", proof_body(&op.final_proofbody)?),
                    ("starterArguments", text(hex(&op.starter_arguments))),
                    ("otherArguments", text(hex(&op.other_arguments))),
                    ("sig", text(hex(&op.sig))),
                    ("startedByLeft", CanonicalValue::Bool(op.started_by_left)),
                    ("cooperative", CanonicalValue::Bool(op.cooperative)),
                ];
                if let Some(at) = op.submit_not_before_timestamp {
                    fields.push((
                        "submitNotBeforeTimestamp",
                        number(at, "submitNotBeforeTimestamp")?,
                    ));
                }
                Ok(object(fields))
            })?,
        ),
        (
            "externalTokenToReserve",
            array(&value.external_token_to_reserve, |op| {
                Ok(object([
                    ("entity", text(hex(&op.entity))),
                    ("contractAddress", text(hex(&op.contract_address))),
                    ("externalTokenId", u256_big(&op.external_token_id)),
                    (
                        "tokenType",
                        number(u64::from(op.token_type), "externalTokenToReserve.tokenType")?,
                    ),
                    (
                        "internalTokenId",
                        u256_number(
                            &op.internal_token_id,
                            "externalTokenToReserve.internalTokenId",
                        )?,
                    ),
                    ("amount", u256_big(&op.amount)),
                ]))
            })?,
        ),
        (
            "reserveToExternalToken",
            array(&value.reserve_to_external_token, |op| {
                Ok(object([
                    ("receivingEntity", text(hex(&op.receiving_entity))),
                    (
                        "tokenId",
                        u256_number(&op.token_id, "reserveToExternalToken.tokenId")?,
                    ),
                    ("amount", u256_big(&op.amount)),
                ]))
            })?,
        ),
        (
            "revealSecrets",
            array(&value.reveal_secrets, |op| {
                Ok(object([
                    ("transformer", text(hex(&op.transformer))),
                    ("secret", text(hex(&op.secret))),
                ]))
            })?,
        ),
        (
            "hashLadderRegistrations",
            array(&value.hash_ladder_registrations, |op| {
                Ok(object([
                    ("counterpartyEntity", text(hex(&op.counterparty_entity))),
                    ("targetRole", CanonicalValue::Bool(op.target_role)),
                    ("fullHash", text(hex(&op.full_hash))),
                    ("partialRoot", text(hex(&op.partial_root))),
                    (
                        "witness",
                        object([
                            (
                                "fillRatio",
                                number(u64::from(op.witness.fill_ratio), "hashLadder.fillRatio")?,
                            ),
                            ("fullSecret", text(hex(&op.witness.full_secret))),
                            (
                                "reveals",
                                CanonicalValue::Array(
                                    op.witness.reveals.iter().map(|v| text(hex(v))).collect(),
                                ),
                            ),
                        ]),
                    ),
                ]))
            })?,
        ),
    ]))
}

fn jurisdiction(value: &JurisdictionConfig) -> Result<CanonicalValue, JBatchError> {
    let mut fields = vec![
        ("address", text(&value.address)),
        ("name", text(&value.name)),
        (
            "entityProviderAddress",
            text(&value.entity_provider_address),
        ),
        ("depositoryAddress", text(&value.depository_address)),
    ];
    for (name, item) in [
        ("chainId", value.chain_id),
        ("blockTimeMs", value.block_time_ms),
        ("registrationBlock", value.registration_block),
        (
            "entityProviderDeploymentBlock",
            value.entity_provider_deployment_block,
        ),
    ] {
        if let Some(item) = item {
            fields.push((name, number(item, name)?));
        }
    }
    if let Some(policy) = &value.rebalance_policy_usd {
        fields.push((
            "rebalancePolicyUsd",
            object([
                (
                    "r2cRequestSoftLimit",
                    number(policy.r2c_request_soft_limit, "r2cRequestSoftLimit")?,
                ),
                ("hardLimit", number(policy.hard_limit, "hardLimit")?),
                ("maxFee", number(policy.max_fee, "maxFee")?),
            ]),
        ));
    }
    Ok(object(fields))
}

fn failure(value: &RuntimeFailureSignal) -> CanonicalValue {
    object([
        (
            "category",
            text(match value.category {
                RuntimeFailureCategory::ExpectedEmpty => "ExpectedEmpty",
                RuntimeFailureCategory::TransientRace => "TransientRace",
                RuntimeFailureCategory::Contradiction => "Contradiction",
            }),
        ),
        ("code", text(&value.code)),
        ("message", text(&value.message)),
        ("retryable", CanonicalValue::Bool(value.retryable)),
        ("fatal", CanonicalValue::Bool(value.fatal)),
    ])
}

fn sent_batch(value: &SentJBatch) -> Result<CanonicalValue, JBatchError> {
    let mut fields = vec![
        ("batch", canonical_j_batch(&value.batch)?),
        ("batchHash", text(hex(&value.batch_hash))),
        ("encodedBatch", text(hex(&value.encoded_batch))),
        (
            "entityNonce",
            number(value.entity_nonce, "sentBatch.entityNonce")?,
        ),
        (
            "firstSubmittedAt",
            number(value.first_submitted_at, "sentBatch.firstSubmittedAt")?,
        ),
        (
            "lastSubmittedAt",
            number(value.last_submitted_at, "sentBatch.lastSubmittedAt")?,
        ),
        (
            "submitAttempts",
            number(u64::from(value.submit_attempts), "sentBatch.submitAttempts")?,
        ),
    ];
    if let Some(overrides) = &value.fee_overrides {
        let mut values = Vec::new();
        if let Some(v) = overrides.gas_bump_bps {
            values.push(("gasBumpBps", number(u64::from(v), "gasBumpBps")?));
        }
        if let Some(v) = &overrides.max_fee_per_gas_wei {
            values.push(("maxFeePerGasWei", text(v)));
        }
        if let Some(v) = &overrides.max_priority_fee_per_gas_wei {
            values.push(("maxPriorityFeePerGasWei", text(v)));
        }
        fields.push(("feeOverrides", object(values)));
    }
    if let Some(hash) = value.transaction_hash {
        fields.push(("txHash", text(hex(&hash))));
    }
    if let Some(last) = &value.last_failure {
        fields.push((
            "lastFailure",
            object([
                ("message", text(&last.message)),
                ("failedAt", number(last.failed_at, "lastFailure.failedAt")?),
                ("failure", failure(&last.failure)),
            ]),
        ));
    }
    if let Some(terminal) = &value.terminal_failure {
        let mut values = vec![
            ("message", text(&terminal.message)),
            (
                "failedAt",
                number(terminal.failed_at, "terminalFailure.failedAt")?,
            ),
        ];
        if let Some(signal) = &terminal.failure {
            values.push(("failure", failure(signal)));
        }
        fields.push(("terminalFailure", object(values)));
    }
    Ok(object(fields))
}

pub fn canonical_j_batch_state(value: &JBatchState) -> Result<CanonicalValue, JBatchError> {
    let mut fields = vec![
        ("batch", canonical_j_batch(&value.batch)?),
        (
            "jurisdiction",
            value
                .jurisdiction
                .as_ref()
                .map(jurisdiction)
                .transpose()?
                .unwrap_or(CanonicalValue::Null),
        ),
        (
            "lastBroadcast",
            number(value.last_broadcast, "lastBroadcast")?,
        ),
        (
            "broadcastCount",
            number(value.broadcast_count, "broadcastCount")?,
        ),
        (
            "failedAttempts",
            number(value.failed_attempts, "failedAttempts")?,
        ),
        (
            "status",
            text(match value.status {
                JBatchStatus::Empty => "empty",
                JBatchStatus::Accumulating => "accumulating",
                JBatchStatus::Sent => "sent",
                JBatchStatus::Failed => "failed",
            }),
        ),
    ];
    if let Some(sent) = &value.sent_batch {
        fields.push(("sentBatch", sent_batch(sent)?));
    }
    if !value.recovery_batches.is_empty() {
        fields.push((
            "recoveryBatches",
            array(&value.recovery_batches, canonical_j_batch)?,
        ));
    }
    if value.auto_broadcast_draft {
        fields.push(("autoBroadcastDraft", CanonicalValue::Bool(true)));
    }
    if let Some(nonce) = value.entity_nonce {
        fields.push(("entityNonce", number(nonce, "entityNonce")?));
    }
    Ok(object(fields))
}

struct Fields<'a> {
    values: &'a [(String, CanonicalValue)],
    context: String,
}

impl<'a> Fields<'a> {
    fn new(
        value: &'a CanonicalValue,
        context: impl Into<String>,
        required: &[&str],
        optional: &[&str],
    ) -> Result<Self, JBatchError> {
        let context = context.into();
        let CanonicalValue::Object(values) = value else {
            return Err(err(format!("OBJECT:{context}")));
        };
        for (index, (key, _)) in values.iter().enumerate() {
            if values[..index].iter().any(|(prior, _)| prior == key) {
                return Err(err(format!("DUPLICATE:{context}.{key}")));
            }
            if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
                return Err(err(format!("FIELD:{context}.{key}")));
            }
        }
        for key in required {
            if !values.iter().any(|(name, _)| name == key) {
                return Err(err(format!("MISSING:{context}.{key}")));
            }
        }
        Ok(Self { values, context })
    }
    fn get(&self, key: &str) -> Result<&'a CanonicalValue, JBatchError> {
        self.values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
            .ok_or_else(|| err(format!("MISSING:{}.{}", self.context, key)))
    }
    fn optional(&self, key: &str) -> Option<&'a CanonicalValue> {
        self.values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

fn string(value: &CanonicalValue, context: &str) -> Result<String, JBatchError> {
    match value {
        CanonicalValue::String(v) => Ok(v.clone()),
        _ => Err(err(format!("STRING:{context}"))),
    }
}
fn boolean(value: &CanonicalValue, context: &str) -> Result<bool, JBatchError> {
    match value {
        CanonicalValue::Bool(v) => Ok(*v),
        _ => Err(err(format!("BOOL:{context}"))),
    }
}
fn safe_u64(value: &CanonicalValue, context: &str) -> Result<u64, JBatchError> {
    match value {
        CanonicalValue::Number(v) => v
            .as_str()
            .parse::<u64>()
            .map_err(|_| err(format!("NUMBER:{context}"))),
        _ => Err(err(format!("NUMBER:{context}"))),
    }
}
fn big_uint(value: &CanonicalValue, context: &str) -> Result<U256, JBatchError> {
    let value = match value {
        CanonicalValue::BigInt(v) if v.sign() != Sign::Minus => v,
        _ => return Err(err(format!("BIGUINT:{context}"))),
    };
    let (_, bytes) = value.to_bytes_be();
    if bytes.len() > 32 {
        return Err(err(format!("U256:{context}")));
    }
    Ok(U256::from_big_endian(&bytes))
}
fn number_uint(value: &CanonicalValue, context: &str) -> Result<U256, JBatchError> {
    Ok(U256::from(safe_u64(value, context)?))
}
fn signed_big(value: &CanonicalValue, context: &str) -> Result<BigInt, JBatchError> {
    match value {
        CanonicalValue::BigInt(v) => Ok(v.clone()),
        _ => Err(err(format!("BIGINT:{context}"))),
    }
}
fn values<'a>(
    value: &'a CanonicalValue,
    context: &str,
) -> Result<&'a [CanonicalValue], JBatchError> {
    match value {
        CanonicalValue::Array(v) => Ok(v),
        _ => Err(err(format!("ARRAY:{context}"))),
    }
}

fn hex_bytes(value: &CanonicalValue, bytes: usize, context: &str) -> Result<Vec<u8>, JBatchError> {
    let value = string(value, context)?;
    let raw = value
        .strip_prefix("0x")
        .ok_or_else(|| err(format!("HEX:{context}")))?;
    if raw.len() != bytes * 2
        || !raw.bytes().all(|b| b.is_ascii_hexdigit())
        || raw.bytes().any(|b| b.is_ascii_uppercase())
    {
        return Err(err(format!("HEX:{context}")));
    }
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).map_err(|_| err(format!("HEX:{context}"))))
        .collect()
}
fn bytes(value: &CanonicalValue, context: &str) -> Result<Vec<u8>, JBatchError> {
    let value = string(value, context)?;
    let raw = value
        .strip_prefix("0x")
        .ok_or_else(|| err(format!("HEX:{context}")))?;
    if raw.len() % 2 != 0
        || !raw.bytes().all(|b| b.is_ascii_hexdigit())
        || raw.bytes().any(|b| b.is_ascii_uppercase())
    {
        return Err(err(format!("HEX:{context}")));
    }
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).map_err(|_| err(format!("HEX:{context}"))))
        .collect()
}
fn fixed<const N: usize>(value: &CanonicalValue, context: &str) -> Result<[u8; N], JBatchError> {
    hex_bytes(value, N, context)?
        .try_into()
        .map_err(|_| err(format!("HEX:{context}")))
}

fn decode_vec<T>(
    value: &CanonicalValue,
    context: &str,
    decode: impl Fn(&CanonicalValue, &str) -> Result<T, JBatchError>,
) -> Result<Vec<T>, JBatchError> {
    values(value, context)?
        .iter()
        .enumerate()
        .map(|(i, value)| decode(value, &format!("{context}[{i}]")))
        .collect()
}

fn decode_proof(value: &CanonicalValue, context: &str) -> Result<ProofBody, JBatchError> {
    let f = Fields::new(
        value,
        context,
        &[
            "watchSeed",
            "leftResponseSeconds",
            "rightResponseSeconds",
            "offdeltas",
            "tokenIds",
            "transformers",
        ],
        &[],
    )?;
    let seconds = |value: &CanonicalValue, name: &str| -> Result<u32, JBatchError> {
        let v = safe_u64(value, name)?;
        if v > u64::from(u32::MAX) {
            return Err(err(format!("U32:{name}")));
        }
        Ok(v as u32)
    };
    Ok(ProofBody {
        watch_seed: fixed(f.get("watchSeed")?, &format!("{context}.watchSeed"))?,
        left_response_seconds: seconds(
            f.get("leftResponseSeconds")?,
            &format!("{context}.leftResponseSeconds"),
        )?,
        right_response_seconds: seconds(
            f.get("rightResponseSeconds")?,
            &format!("{context}.rightResponseSeconds"),
        )?,
        offdeltas: decode_vec(
            f.get("offdeltas")?,
            &format!("{context}.offdeltas"),
            signed_big,
        )?,
        token_ids: decode_vec(f.get("tokenIds")?, &format!("{context}.tokenIds"), big_uint)?,
        transformers: decode_vec(
            f.get("transformers")?,
            &format!("{context}.transformers"),
            |v, c| {
                let t = Fields::new(
                    v,
                    c,
                    &["transformerAddress", "encodedBatch", "allowances"],
                    &[],
                )?;
                Ok(TransformerClause {
                    transformer_address: fixed(
                        t.get("transformerAddress")?,
                        &format!("{c}.transformerAddress"),
                    )?,
                    encoded_batch: bytes(t.get("encodedBatch")?, &format!("{c}.encodedBatch"))?,
                    allowances: decode_vec(
                        t.get("allowances")?,
                        &format!("{c}.allowances"),
                        |v, c| {
                            let a = Fields::new(
                                v,
                                c,
                                &["deltaIndex", "rightAllowance", "leftAllowance"],
                                &[],
                            )?;
                            Ok(Allowance {
                                delta_index: big_uint(a.get("deltaIndex")?, c)?,
                                right_allowance: big_uint(a.get("rightAllowance")?, c)?,
                                left_allowance: big_uint(a.get("leftAllowance")?, c)?,
                            })
                        },
                    )?,
                })
            },
        )?,
    })
}

fn decode_batch_at(value: &CanonicalValue, context: &str) -> Result<JBatch, JBatchError> {
    let f = Fields::new(
        value,
        context,
        &[
            "reserveToReserve",
            "reserveToCollateral",
            "collateralToReserve",
            "settlements",
            "disputeStarts",
            "counterDisputes",
            "disputeFinalizations",
            "externalTokenToReserve",
            "reserveToExternalToken",
            "revealSecrets",
            "hashLadderRegistrations",
        ],
        &[],
    )?;
    Ok(JBatch {
        reserve_to_reserve: decode_vec(
            f.get("reserveToReserve")?,
            "batch.reserveToReserve",
            |v, c| {
                let x = Fields::new(v, c, &["receivingEntity", "tokenId", "amount"], &[])?;
                Ok(ReserveToReserve {
                    receiving_entity: fixed(x.get("receivingEntity")?, c)?,
                    token_id: number_uint(x.get("tokenId")?, c)?,
                    amount: big_uint(x.get("amount")?, c)?,
                })
            },
        )?,
        reserve_to_collateral: decode_vec(
            f.get("reserveToCollateral")?,
            "batch.reserveToCollateral",
            |v, c| {
                let x = Fields::new(v, c, &["tokenId", "receivingEntity", "pairs"], &[])?;
                Ok(ReserveToCollateral {
                    token_id: number_uint(x.get("tokenId")?, c)?,
                    receiving_entity: fixed(x.get("receivingEntity")?, c)?,
                    pairs: decode_vec(x.get("pairs")?, c, |v, c| {
                        let p = Fields::new(v, c, &["entity", "amount"], &[])?;
                        Ok(EntityAmount {
                            entity: fixed(p.get("entity")?, c)?,
                            amount: big_uint(p.get("amount")?, c)?,
                        })
                    })?,
                })
            },
        )?,
        collateral_to_reserve: decode_vec(
            f.get("collateralToReserve")?,
            "batch.collateralToReserve",
            |v, c| {
                let x = Fields::new(
                    v,
                    c,
                    &["counterparty", "tokenId", "amount", "nonce", "sig"],
                    &[],
                )?;
                Ok(CollateralToReserve {
                    counterparty: fixed(x.get("counterparty")?, c)?,
                    token_id: number_uint(x.get("tokenId")?, c)?,
                    amount: big_uint(x.get("amount")?, c)?,
                    nonce: number_uint(x.get("nonce")?, c)?,
                    sig: bytes(x.get("sig")?, c)?,
                })
            },
        )?,
        settlements: decode_vec(f.get("settlements")?, "batch.settlements", |v, c| {
            let x = Fields::new(
                v,
                c,
                &[
                    "leftEntity",
                    "rightEntity",
                    "diffs",
                    "forgiveDebtsInTokenIds",
                    "sig",
                    "nonce",
                ],
                &[],
            )?;
            Ok(Settlement {
                left_entity: fixed(x.get("leftEntity")?, c)?,
                right_entity: fixed(x.get("rightEntity")?, c)?,
                diffs: decode_vec(x.get("diffs")?, c, |v, c| {
                    let d = Fields::new(
                        v,
                        c,
                        &[
                            "tokenId",
                            "leftDiff",
                            "rightDiff",
                            "collateralDiff",
                            "ondeltaDiff",
                        ],
                        &[],
                    )?;
                    Ok(SettlementDiff {
                        token_id: number_uint(d.get("tokenId")?, c)?,
                        left_diff: signed_big(d.get("leftDiff")?, c)?,
                        right_diff: signed_big(d.get("rightDiff")?, c)?,
                        collateral_diff: signed_big(d.get("collateralDiff")?, c)?,
                        ondelta_diff: signed_big(d.get("ondeltaDiff")?, c)?,
                    })
                })?,
                forgive_debts_in_token_ids: decode_vec(
                    x.get("forgiveDebtsInTokenIds")?,
                    c,
                    number_uint,
                )?,
                sig: bytes(x.get("sig")?, c)?,
                nonce: number_uint(x.get("nonce")?, c)?,
            })
        })?,
        dispute_starts: decode_vec(f.get("disputeStarts")?, "batch.disputeStarts", |v, c| {
            let x = Fields::new(
                v,
                c,
                &[
                    "counterentity",
                    "nonce",
                    "proposerIsLeft",
                    "proofbodyHash",
                    "initialProofbody",
                    "watchSeed",
                    "sig",
                    "starterInitialArguments",
                    "starterCounterArguments",
                    "starterCounterProofCommitment",
                ],
                &[],
            )?;
            Ok(InitialDisputeProof {
                counterentity: fixed(x.get("counterentity")?, c)?,
                nonce: number_uint(x.get("nonce")?, c)?,
                proposer_is_left: boolean(x.get("proposerIsLeft")?, c)?,
                proofbody_hash: fixed(x.get("proofbodyHash")?, c)?,
                initial_proofbody: decode_proof(x.get("initialProofbody")?, c)?,
                watch_seed: fixed(x.get("watchSeed")?, c)?,
                sig: bytes(x.get("sig")?, c)?,
                starter_initial_arguments: bytes(x.get("starterInitialArguments")?, c)?,
                starter_counter_arguments: bytes(x.get("starterCounterArguments")?, c)?,
                starter_counter_proof_commitment: fixed(
                    x.get("starterCounterProofCommitment")?,
                    c,
                )?,
            })
        })?,
        counter_disputes: decode_vec(
            f.get("counterDisputes")?,
            "batch.counterDisputes",
            |v, c| {
                let x = Fields::new(
                    v,
                    c,
                    &[
                        "counterentity",
                        "initialNonce",
                        "initialProofbodyHash",
                        "counterNonce",
                        "proposerIsLeft",
                        "counterProofbody",
                        "sig",
                    ],
                    &[],
                )?;
                Ok(CounterDisputeProof {
                    counterentity: fixed(x.get("counterentity")?, c)?,
                    initial_nonce: number_uint(x.get("initialNonce")?, c)?,
                    initial_proofbody_hash: fixed(x.get("initialProofbodyHash")?, c)?,
                    counter_nonce: number_uint(x.get("counterNonce")?, c)?,
                    proposer_is_left: boolean(x.get("proposerIsLeft")?, c)?,
                    counter_proofbody: decode_proof(x.get("counterProofbody")?, c)?,
                    sig: bytes(x.get("sig")?, c)?,
                })
            },
        )?,
        dispute_finalizations: decode_vec(
            f.get("disputeFinalizations")?,
            "batch.disputeFinalizations",
            |v, c| {
                let x = Fields::new(
                    v,
                    c,
                    &[
                        "counterentity",
                        "initialNonce",
                        "finalNonce",
                        "proposerIsLeft",
                        "initialProofbodyHash",
                        "finalProofbody",
                        "starterArguments",
                        "otherArguments",
                        "sig",
                        "startedByLeft",
                        "cooperative",
                    ],
                    &["submitNotBeforeTimestamp"],
                )?;
                Ok(FinalDisputeProof {
                    counterentity: fixed(x.get("counterentity")?, c)?,
                    initial_nonce: number_uint(x.get("initialNonce")?, c)?,
                    final_nonce: number_uint(x.get("finalNonce")?, c)?,
                    proposer_is_left: boolean(x.get("proposerIsLeft")?, c)?,
                    initial_proofbody_hash: fixed(x.get("initialProofbodyHash")?, c)?,
                    final_proofbody: decode_proof(x.get("finalProofbody")?, c)?,
                    starter_arguments: bytes(x.get("starterArguments")?, c)?,
                    other_arguments: bytes(x.get("otherArguments")?, c)?,
                    sig: bytes(x.get("sig")?, c)?,
                    started_by_left: boolean(x.get("startedByLeft")?, c)?,
                    cooperative: boolean(x.get("cooperative")?, c)?,
                    submit_not_before_timestamp: x
                        .optional("submitNotBeforeTimestamp")
                        .map(|v| safe_u64(v, c))
                        .transpose()?,
                })
            },
        )?,
        external_token_to_reserve: decode_vec(
            f.get("externalTokenToReserve")?,
            "batch.externalTokenToReserve",
            |v, c| {
                let x = Fields::new(
                    v,
                    c,
                    &[
                        "entity",
                        "contractAddress",
                        "externalTokenId",
                        "tokenType",
                        "internalTokenId",
                        "amount",
                    ],
                    &[],
                )?;
                let token_type = safe_u64(x.get("tokenType")?, c)?;
                Ok(ExternalTokenToReserve {
                    entity: fixed(x.get("entity")?, c)?,
                    contract_address: fixed(x.get("contractAddress")?, c)?,
                    external_token_id: big_uint(x.get("externalTokenId")?, c)?,
                    token_type: u8::try_from(token_type).map_err(|_| err(format!("U8:{c}")))?,
                    internal_token_id: number_uint(x.get("internalTokenId")?, c)?,
                    amount: big_uint(x.get("amount")?, c)?,
                })
            },
        )?,
        reserve_to_external_token: decode_vec(
            f.get("reserveToExternalToken")?,
            "batch.reserveToExternalToken",
            |v, c| {
                let x = Fields::new(v, c, &["receivingEntity", "tokenId", "amount"], &[])?;
                Ok(ReserveToExternalToken {
                    receiving_entity: fixed(x.get("receivingEntity")?, c)?,
                    token_id: number_uint(x.get("tokenId")?, c)?,
                    amount: big_uint(x.get("amount")?, c)?,
                })
            },
        )?,
        reveal_secrets: decode_vec(f.get("revealSecrets")?, "batch.revealSecrets", |v, c| {
            let x = Fields::new(v, c, &["transformer", "secret"], &[])?;
            Ok(SecretReveal {
                transformer: fixed(x.get("transformer")?, c)?,
                secret: fixed(x.get("secret")?, c)?,
            })
        })?,
        hash_ladder_registrations: decode_vec(
            f.get("hashLadderRegistrations")?,
            "batch.hashLadderRegistrations",
            |v, c| {
                let x = Fields::new(
                    v,
                    c,
                    &[
                        "counterpartyEntity",
                        "targetRole",
                        "fullHash",
                        "partialRoot",
                        "witness",
                    ],
                    &[],
                )?;
                let w = Fields::new(
                    x.get("witness")?,
                    c,
                    &["fillRatio", "fullSecret", "reveals"],
                    &[],
                )?;
                let ratio = safe_u64(w.get("fillRatio")?, c)?;
                let reveals = decode_vec(w.get("reveals")?, c, fixed::<32>)?;
                Ok(HashLadderRegistration {
                    counterparty_entity: fixed(x.get("counterpartyEntity")?, c)?,
                    target_role: boolean(x.get("targetRole")?, c)?,
                    full_hash: fixed(x.get("fullHash")?, c)?,
                    partial_root: fixed(x.get("partialRoot")?, c)?,
                    witness: HashLadderWitness {
                        fill_ratio: u16::try_from(ratio).map_err(|_| err(format!("U16:{c}")))?,
                        full_secret: fixed(w.get("fullSecret")?, c)?,
                        reveals: reveals
                            .try_into()
                            .map_err(|_| err(format!("REVEALS:{c}")))?,
                    },
                })
            },
        )?,
    })
}

pub fn decode_canonical_j_batch(value: &CanonicalValue) -> Result<JBatch, JBatchError> {
    decode_batch_at(value, "jBatch")
}

fn decode_jurisdiction(value: &CanonicalValue) -> Result<JurisdictionConfig, JBatchError> {
    let f = Fields::new(
        value,
        "jurisdiction",
        &[
            "address",
            "name",
            "entityProviderAddress",
            "depositoryAddress",
        ],
        &[
            "chainId",
            "blockTimeMs",
            "registrationBlock",
            "entityProviderDeploymentBlock",
            "rebalancePolicyUsd",
        ],
    )?;
    let optional_number = |key: &str| f.optional(key).map(|v| safe_u64(v, key)).transpose();
    let rebalance_policy_usd = f
        .optional("rebalancePolicyUsd")
        .map(|v| {
            let p = Fields::new(
                v,
                "rebalancePolicyUsd",
                &["r2cRequestSoftLimit", "hardLimit", "maxFee"],
                &[],
            )?;
            Ok(RebalancePolicyUsd {
                r2c_request_soft_limit: safe_u64(
                    p.get("r2cRequestSoftLimit")?,
                    "r2cRequestSoftLimit",
                )?,
                hard_limit: safe_u64(p.get("hardLimit")?, "hardLimit")?,
                max_fee: safe_u64(p.get("maxFee")?, "maxFee")?,
            })
        })
        .transpose()?;
    Ok(JurisdictionConfig {
        address: string(f.get("address")?, "address")?,
        name: string(f.get("name")?, "name")?,
        entity_provider_address: string(f.get("entityProviderAddress")?, "entityProviderAddress")?,
        depository_address: string(f.get("depositoryAddress")?, "depositoryAddress")?,
        chain_id: optional_number("chainId")?,
        block_time_ms: optional_number("blockTimeMs")?,
        registration_block: optional_number("registrationBlock")?,
        entity_provider_deployment_block: optional_number("entityProviderDeploymentBlock")?,
        rebalance_policy_usd,
    })
}

fn decode_failure(
    value: &CanonicalValue,
    context: &str,
) -> Result<RuntimeFailureSignal, JBatchError> {
    let f = Fields::new(
        value,
        context,
        &["category", "code", "message", "retryable", "fatal"],
        &[],
    )?;
    let category = match string(f.get("category")?, context)?.as_str() {
        "ExpectedEmpty" => RuntimeFailureCategory::ExpectedEmpty,
        "TransientRace" => RuntimeFailureCategory::TransientRace,
        "Contradiction" => RuntimeFailureCategory::Contradiction,
        _ => return Err(err(format!("CATEGORY:{context}"))),
    };
    let retryable = boolean(f.get("retryable")?, context)?;
    let fatal = boolean(f.get("fatal")?, context)?;
    if retryable != matches!(category, RuntimeFailureCategory::TransientRace)
        || fatal != matches!(category, RuntimeFailureCategory::Contradiction)
    {
        return Err(err(format!("FAILURE_FLAGS:{context}")));
    }
    Ok(RuntimeFailureSignal {
        category,
        code: string(f.get("code")?, context)?,
        message: string(f.get("message")?, context)?,
        retryable,
        fatal,
    })
}

fn decode_sent(value: &CanonicalValue) -> Result<SentJBatch, JBatchError> {
    let f = Fields::new(
        value,
        "sentBatch",
        &[
            "batch",
            "batchHash",
            "encodedBatch",
            "entityNonce",
            "firstSubmittedAt",
            "lastSubmittedAt",
            "submitAttempts",
        ],
        &["feeOverrides", "txHash", "lastFailure", "terminalFailure"],
    )?;
    let fee_overrides = f
        .optional("feeOverrides")
        .map(|v| {
            let x = Fields::new(
                v,
                "feeOverrides",
                &[],
                &["gasBumpBps", "maxFeePerGasWei", "maxPriorityFeePerGasWei"],
            )?;
            Ok(JBatchFeeOverrides {
                gas_bump_bps: x
                    .optional("gasBumpBps")
                    .map(|v| {
                        safe_u64(v, "gasBumpBps")
                            .and_then(|v| u32::try_from(v).map_err(|_| err("U32:gasBumpBps")))
                    })
                    .transpose()?,
                max_fee_per_gas_wei: x
                    .optional("maxFeePerGasWei")
                    .map(|v| string(v, "maxFeePerGasWei"))
                    .transpose()?,
                max_priority_fee_per_gas_wei: x
                    .optional("maxPriorityFeePerGasWei")
                    .map(|v| string(v, "maxPriorityFeePerGasWei"))
                    .transpose()?,
            })
        })
        .transpose()?;
    let last_failure = f
        .optional("lastFailure")
        .map(|v| {
            let x = Fields::new(v, "lastFailure", &["message", "failedAt", "failure"], &[])?;
            Ok(JBatchLastFailure {
                message: string(x.get("message")?, "lastFailure.message")?,
                failed_at: safe_u64(x.get("failedAt")?, "lastFailure.failedAt")?,
                failure: decode_failure(x.get("failure")?, "lastFailure.failure")?,
            })
        })
        .transpose()?;
    let terminal_failure = f
        .optional("terminalFailure")
        .map(|v| {
            let x = Fields::new(v, "terminalFailure", &["message", "failedAt"], &["failure"])?;
            Ok(JBatchTerminalFailure {
                message: string(x.get("message")?, "terminalFailure.message")?,
                failed_at: safe_u64(x.get("failedAt")?, "terminalFailure.failedAt")?,
                failure: x
                    .optional("failure")
                    .map(|v| decode_failure(v, "terminalFailure.failure"))
                    .transpose()?,
            })
        })
        .transpose()?;
    Ok(SentJBatch {
        batch: decode_batch_at(f.get("batch")?, "sentBatch.batch")?,
        batch_hash: fixed(f.get("batchHash")?, "sentBatch.batchHash")?,
        encoded_batch: bytes(f.get("encodedBatch")?, "sentBatch.encodedBatch")?,
        entity_nonce: safe_u64(f.get("entityNonce")?, "sentBatch.entityNonce")?,
        first_submitted_at: safe_u64(f.get("firstSubmittedAt")?, "sentBatch.firstSubmittedAt")?,
        last_submitted_at: safe_u64(f.get("lastSubmittedAt")?, "sentBatch.lastSubmittedAt")?,
        submit_attempts: u32::try_from(safe_u64(
            f.get("submitAttempts")?,
            "sentBatch.submitAttempts",
        )?)
        .map_err(|_| err("U32:submitAttempts"))?,
        fee_overrides,
        transaction_hash: f
            .optional("txHash")
            .map(|v| fixed(v, "sentBatch.txHash"))
            .transpose()?,
        last_failure,
        terminal_failure,
    })
}

pub fn decode_canonical_j_batch_state(value: &CanonicalValue) -> Result<JBatchState, JBatchError> {
    let f = Fields::new(
        value,
        "jBatchState",
        &[
            "batch",
            "jurisdiction",
            "lastBroadcast",
            "broadcastCount",
            "failedAttempts",
            "status",
        ],
        &[
            "sentBatch",
            "recoveryBatches",
            "autoBroadcastDraft",
            "entityNonce",
        ],
    )?;
    let status = match string(f.get("status")?, "status")?.as_str() {
        "empty" => JBatchStatus::Empty,
        "accumulating" => JBatchStatus::Accumulating,
        "sent" => JBatchStatus::Sent,
        "failed" => JBatchStatus::Failed,
        _ => return Err(err("STATUS")),
    };
    let jurisdiction = match f.get("jurisdiction")? {
        CanonicalValue::Null => None,
        v => Some(decode_jurisdiction(v)?),
    };
    let state = JBatchState {
        batch: decode_batch_at(f.get("batch")?, "jBatchState.batch")?,
        jurisdiction,
        last_broadcast: safe_u64(f.get("lastBroadcast")?, "lastBroadcast")?,
        broadcast_count: safe_u64(f.get("broadcastCount")?, "broadcastCount")?,
        failed_attempts: safe_u64(f.get("failedAttempts")?, "failedAttempts")?,
        status,
        sent_batch: f.optional("sentBatch").map(decode_sent).transpose()?,
        recovery_batches: f
            .optional("recoveryBatches")
            .map(|v| decode_vec(v, "recoveryBatches", decode_batch_at))
            .transpose()?
            .unwrap_or_default(),
        auto_broadcast_draft: f
            .optional("autoBroadcastDraft")
            .map(|v| boolean(v, "autoBroadcastDraft"))
            .transpose()?
            .unwrap_or(false),
        entity_nonce: f
            .optional("entityNonce")
            .map(|v| safe_u64(v, "entityNonce"))
            .transpose()?,
    };
    if f.optional("autoBroadcastDraft").is_some() && !state.auto_broadcast_draft {
        return Err(err("AUTO_BROADCAST_FALSE_MUST_BE_ABSENT"));
    }
    if f.optional("recoveryBatches").is_some() && state.recovery_batches.is_empty() {
        return Err(err("EMPTY_RECOVERY_MUST_BE_ABSENT"));
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_response_windows_match_typescript_number_shape() {
        let expected = ProofBody {
            watch_seed: [0; 32],
            left_response_seconds: 86_400,
            right_response_seconds: 3_600,
            offdeltas: Vec::new(),
            token_ids: Vec::new(),
            transformers: Vec::new(),
        };
        let value = proof_body(&expected).expect("proof body");
        assert_eq!(decode_proof(&value, "proofBody").expect("decode"), expected);
        let CanonicalValue::Object(fields) = &value else {
            panic!("proof body object")
        };
        assert!(matches!(
            fields.iter().find(|(key, _)| key == "leftResponseSeconds"),
            Some((_, CanonicalValue::Number(value))) if value.as_str() == "86400"
        ));
        assert!(matches!(
            fields.iter().find(|(key, _)| key == "rightResponseSeconds"),
            Some((_, CanonicalValue::Number(value))) if value.as_str() == "3600"
        ));

        let mut retired = value;
        let CanonicalValue::Object(fields) = &mut retired else {
            panic!("proof body object")
        };
        let (_, left) = fields
            .iter_mut()
            .find(|(key, _)| key == "leftResponseSeconds")
            .expect("left window");
        *left = CanonicalValue::BigInt(BigInt::from(86_400));
        assert!(
            decode_proof(&retired, "proofBody")
                .expect_err("canonical storage rejects retired BigInt shape")
                .to_string()
                .contains("NUMBER:proofBody.leftResponseSeconds")
        );
    }

    #[test]
    fn empty_state_round_trips_with_optional_fields_absent() {
        let state = JBatchState::default();
        let value = canonical_j_batch_state(&state).expect("encode");
        assert_eq!(
            decode_canonical_j_batch_state(&value).expect("decode"),
            state
        );
        let CanonicalValue::Object(fields) = value else {
            panic!("object")
        };
        assert!(!fields.iter().any(|(key, _)| {
            [
                "sentBatch",
                "recoveryBatches",
                "autoBroadcastDraft",
                "entityNonce",
            ]
            .contains(&key.as_str())
        }));
    }
}
