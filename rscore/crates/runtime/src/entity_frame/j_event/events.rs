//! Non-dispute J-event bodies mirroring `event-normalizers.ts` / wallet.

use num_bigint::BigInt;
use serde_json::{Map, Value};

use super::normalize::{
    int_value, is_action_kind, is_positive_uint256, normalize_address, normalize_big_numberish,
    normalize_bytes32, normalize_entity, normalize_hex_bytes, normalize_int, normalize_string,
    record, string_value,
};

fn insert(map: &mut Map<String, Value>, name: &str, value: Value) {
    map.insert(name.into(), value);
}

type FieldDecoder = fn(&Value) -> Option<Value>;

fn decode_object(
    data: &Map<String, Value>,
    fields: &[(&str, FieldDecoder)],
) -> Option<Map<String, Value>> {
    let mut decoded = Map::new();
    for (name, decode) in fields {
        let raw = data.get(*name).cloned().unwrap_or(Value::Null);
        insert(&mut decoded, name, decode(&raw)?);
    }
    Some(decoded)
}

fn as_entity(value: &Value) -> Option<Value> {
    normalize_entity(value).map(string_value)
}
fn as_address(value: &Value) -> Option<Value> {
    normalize_address(value).map(string_value)
}
fn as_bytes32(value: &Value) -> Option<Value> {
    normalize_bytes32(value).map(string_value)
}
fn as_big(value: &Value) -> Option<Value> {
    normalize_big_numberish(value).map(string_value)
}
fn as_int(value: &Value) -> Option<Value> {
    normalize_int(value).map(int_value)
}
fn as_string(value: &Value) -> Option<Value> {
    normalize_string(value).map(string_value)
}

fn bigint_value(value: &Value, non_negative: bool) -> Option<Value> {
    let text = normalize_big_numberish(value)?;
    let parsed = text.parse::<BigInt>().ok()?;
    if non_negative && parsed < BigInt::from(0) {
        return None;
    }
    Some(Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String("BigInt".into())),
        ("value".into(), Value::String(parsed.to_string())),
    ])))
}

fn exact_fields(value: &Map<String, Value>, names: &[&str]) -> bool {
    value.len() == names.len() && names.iter().all(|name| value.contains_key(*name))
}

fn proof_body(value: &Value) -> Option<Value> {
    let proof = record(value)?;
    let names = [
        "watchSeed",
        "leftResponseSeconds",
        "rightResponseSeconds",
        "offdeltas",
        "tokenIds",
        "transformers",
    ];
    if !exact_fields(proof, &names) {
        return None;
    }
    let bigints = |name: &str, non_negative: bool| -> Option<Value> {
        Some(Value::Array(
            proof
                .get(name)?
                .as_array()?
                .iter()
                .map(|value| bigint_value(value, non_negative))
                .collect::<Option<Vec<_>>>()?,
        ))
    };
    let transformers = proof
        .get("transformers")?
        .as_array()?
        .iter()
        .map(|value| {
            let transformer = record(value)?;
            if !exact_fields(
                transformer,
                &["transformerAddress", "encodedBatch", "allowances"],
            ) {
                return None;
            }
            let allowances = transformer
                .get("allowances")?
                .as_array()?
                .iter()
                .map(|value| {
                    let allowance = record(value)?;
                    if !exact_fields(
                        allowance,
                        &["deltaIndex", "rightAllowance", "leftAllowance"],
                    ) {
                        return None;
                    }
                    Some(Value::Object(Map::from_iter([
                        (
                            "deltaIndex".into(),
                            bigint_value(allowance.get("deltaIndex")?, false)?,
                        ),
                        (
                            "rightAllowance".into(),
                            bigint_value(allowance.get("rightAllowance")?, false)?,
                        ),
                        (
                            "leftAllowance".into(),
                            bigint_value(allowance.get("leftAllowance")?, false)?,
                        ),
                    ])))
                })
                .collect::<Option<Vec<_>>>()?;
            Some(Value::Object(Map::from_iter([
                (
                    "transformerAddress".into(),
                    string_value(normalize_string(transformer.get("transformerAddress")?)?),
                ),
                (
                    "encodedBatch".into(),
                    string_value(normalize_string(transformer.get("encodedBatch")?)?),
                ),
                ("allowances".into(), Value::Array(allowances)),
            ])))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Value::Object(Map::from_iter([
        (
            "watchSeed".into(),
            string_value(normalize_string(proof.get("watchSeed")?)?),
        ),
        (
            "leftResponseSeconds".into(),
            int_value(normalize_int(proof.get("leftResponseSeconds")?)?),
        ),
        (
            "rightResponseSeconds".into(),
            int_value(normalize_int(proof.get("rightResponseSeconds")?)?),
        ),
        ("offdeltas".into(), bigints("offdeltas", false)?),
        ("tokenIds".into(), bigints("tokenIds", true)?),
        ("transformers".into(), Value::Array(transformers)),
    ])))
}

fn as_proof_body(value: &Value) -> Option<Value> {
    proof_body(value)
}

fn bytes32_quartet(value: &Value) -> Option<Value> {
    let values = value.as_array()?;
    if values.len() != 4 {
        return None;
    }
    Some(Value::Array(
        values
            .iter()
            .map(|value| normalize_bytes32(value).map(string_value))
            .collect::<Option<Vec<_>>>()?,
    ))
}

fn cmp_text(left: &str, right: &str) -> std::cmp::Ordering {
    left.cmp(right)
}

fn token_balances(value: &Value) -> Option<Value> {
    let mut balances = Vec::new();
    for raw in value.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let entry = record(raw)?;
        let mut decoded =
            decode_object(entry, &[("tokenAddress", as_address), ("balance", as_big)])?;
        if let Some(token_id) = entry.get("tokenId").and_then(normalize_int) {
            insert(&mut decoded, "tokenId", int_value(token_id));
        }
        balances.push(Value::Object(decoded));
    }
    balances.sort_by(|left, right| {
        let left = left.as_object().expect("token");
        let right = right.as_object().expect("token");
        cmp_text(
            left["tokenAddress"].as_str().expect("addr"),
            right["tokenAddress"].as_str().expect("addr"),
        )
        .then_with(|| {
            left.get("tokenId")
                .and_then(Value::as_i64)
                .unwrap_or(-1)
                .cmp(&right.get("tokenId").and_then(Value::as_i64).unwrap_or(-1))
        })
        .then_with(|| {
            cmp_text(
                left["balance"].as_str().expect("bal"),
                right["balance"].as_str().expect("bal"),
            )
        })
    });
    Some(Value::Array(balances))
}

fn allowances(value: &Value) -> Option<Value> {
    let mut out = Vec::new();
    for raw in value.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let entry = record(raw)?;
        out.push(Value::Object(decode_object(
            entry,
            &[
                ("tokenAddress", as_address),
                ("spender", as_address),
                ("allowance", as_big),
            ],
        )?));
    }
    out.sort_by(|left, right| {
        let left = left.as_object().expect("allowance");
        let right = right.as_object().expect("allowance");
        cmp_text(
            left["tokenAddress"].as_str().expect("addr"),
            right["tokenAddress"].as_str().expect("addr"),
        )
        .then_with(|| {
            cmp_text(
                left["spender"].as_str().expect("spender"),
                right["spender"].as_str().expect("spender"),
            )
        })
        .then_with(|| {
            cmp_text(
                left["allowance"].as_str().expect("allowance"),
                right["allowance"].as_str().expect("allowance"),
            )
        })
    });
    Some(Value::Array(out))
}

fn wallet_snapshot(data: &Map<String, Value>) -> Option<Value> {
    let base = decode_object(
        data,
        &[
            ("entityId", as_entity),
            ("owner", as_address),
            ("tokenBalances", token_balances),
            ("allowances", allowances),
        ],
    )?;
    let native_present = data.contains_key("nativeBalance");
    let native = data.get("nativeBalance").and_then(normalize_big_numberish);
    if native_present && native.is_none() {
        return None;
    }
    let mut out = Map::new();
    insert(&mut out, "entityId", base["entityId"].clone());
    insert(&mut out, "owner", base["owner"].clone());
    if let Some(native) = native {
        insert(&mut out, "nativeBalance", string_value(native));
    }
    if let Some(Value::Array(balances)) = base.get("tokenBalances")
        && !balances.is_empty()
    {
        insert(&mut out, "tokenBalances", Value::Array(balances.clone()));
    }
    if let Some(Value::Array(list)) = base.get("allowances")
        && !list.is_empty()
    {
        insert(&mut out, "allowances", Value::Array(list.clone()));
    }
    Some(Value::Object(out))
}

fn wallet_delta(data: &Map<String, Value>) -> Option<Value> {
    let mut out = decode_object(
        data,
        &[
            ("entityId", as_entity),
            ("owner", as_address),
            ("tokenAddress", as_address),
        ],
    )?;
    if let Some(token_id) = data.get("tokenId").and_then(normalize_int) {
        insert(&mut out, "tokenId", int_value(token_id));
    }
    let has_balance = data.contains_key("balanceDelta");
    let has_allowance = data.contains_key("allowance") || data.contains_key("spender");
    let balance_delta = data.get("balanceDelta").and_then(normalize_big_numberish);
    let spender = data.get("spender").and_then(normalize_address);
    let allowance = data.get("allowance").and_then(normalize_big_numberish);
    if (has_balance && balance_delta.is_none())
        || (has_allowance && (spender.is_none() || allowance.is_none()))
        || (!has_balance && !has_allowance)
    {
        return None;
    }
    if let Some(delta) = balance_delta {
        insert(&mut out, "balanceDelta", string_value(delta));
    }
    if let (Some(spender), Some(allowance)) = (spender, allowance) {
        insert(&mut out, "spender", string_value(spender));
        insert(&mut out, "allowance", string_value(allowance));
    }
    Some(Value::Object(out))
}

pub(super) fn normalize_event_data(kind: &str, data: &Map<String, Value>) -> Option<Value> {
    match kind {
        "FoundationBootstrapped" => decode_object(
            data,
            &[
                ("recipient", as_address),
                ("boardHash", as_bytes32),
                ("controlTokenId", as_big),
                ("dividendTokenId", as_big),
            ],
        )
        .map(Value::Object),
        "EntityRegistered" => decode_object(
            data,
            &[
                ("entityId", as_bytes32),
                ("entityNumber", as_big),
                ("boardHash", as_bytes32),
            ],
        )
        .map(Value::Object),
        "BoardActivated" => {
            let decoded = decode_object(
                data,
                &[
                    ("entityId", as_bytes32),
                    ("previousBoardHash", as_bytes32),
                    ("newBoardHash", as_bytes32),
                    ("previousBoardValidUntil", as_big),
                ],
            )?;
            let until = decoded["previousBoardValidUntil"]
                .as_str()?
                .parse::<BigInt>()
                .ok()?;
            (until > BigInt::from(0)).then_some(Value::Object(decoded))
        }
        "ReserveUpdated" => decode_object(
            data,
            &[
                ("entity", as_entity),
                ("tokenId", as_int),
                ("newBalance", as_big),
            ],
        )
        .map(Value::Object),
        "ExternalWalletSnapshot" => wallet_snapshot(data),
        "ExternalWalletDelta" => wallet_delta(data),
        "SecretRevealed" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("hashlock", as_string),
                    ("revealer", as_string),
                    ("secret", as_string),
                ],
            )?;
            let revealer = decoded["revealer"].as_str()?.to_ascii_lowercase();
            insert(&mut decoded, "revealer", string_value(revealer));
            Some(Value::Object(decoded))
        }
        "AccountSettled" => decode_object(
            data,
            &[
                ("leftEntity", as_entity),
                ("rightEntity", as_entity),
                ("tokenId", as_int),
                ("leftReserve", as_big),
                ("rightReserve", as_big),
                ("collateral", as_big),
                ("ondelta", as_big),
                ("nonce", as_int),
            ],
        )
        .map(Value::Object),
        "HankoBatchProcessed" => {
            let decoded = decode_object(
                data,
                &[
                    ("entityId", as_bytes32),
                    ("batchHash", as_bytes32),
                    ("nonce", as_int),
                ],
            )?;
            (decoded["nonce"].as_i64()? >= 1).then_some(Value::Object(decoded))
        }
        "EntityProviderActionExecuted" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("entityId", as_bytes32),
                    ("actionNonce", as_big),
                    ("actionHash", as_bytes32),
                ],
            )?;
            let action_kind = data.get("actionKind").and_then(normalize_int)?;
            let nonce = decoded["actionNonce"].as_str()?;
            if !is_positive_uint256(nonce) || !is_action_kind(action_kind) {
                return None;
            }
            insert(&mut decoded, "actionKind", int_value(action_kind));
            Some(Value::Object(decoded))
        }
        "EntityProviderActionCancelled" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("entityId", as_bytes32),
                    ("actionNonce", as_big),
                    ("cancelledActionHash", as_bytes32),
                    ("cancelHash", as_bytes32),
                ],
            )?;
            let cancelled_kind = data.get("cancelledActionKind").and_then(normalize_int)?;
            let nonce = decoded["actionNonce"].as_str()?;
            if !is_positive_uint256(nonce) || !is_action_kind(cancelled_kind) {
                return None;
            }
            insert(
                &mut decoded,
                "cancelledActionKind",
                int_value(cancelled_kind),
            );
            Some(Value::Object(decoded))
        }
        "DebtCreated" => decode_object(
            data,
            &[
                ("debtor", as_entity),
                ("creditor", as_entity),
                ("tokenId", as_int),
                ("amount", as_big),
                ("debtIndex", as_int),
            ],
        )
        .map(Value::Object),
        "DisputeStarted" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("sender", as_entity),
                    ("counterentity", as_entity),
                    ("nonce", as_big),
                    ("proofbodyHash", as_string),
                    ("watchSeed", as_bytes32),
                    ("starterInitialArguments", |value| {
                        normalize_hex_bytes(value).map(string_value)
                    }),
                    ("starterCounterArguments", |value| {
                        normalize_hex_bytes(value).map(string_value)
                    }),
                    ("starterCounterProofCommitment", as_bytes32),
                    ("initialProofbody", as_proof_body),
                    ("disputeTimeout", as_int),
                    ("disputeStartTimestamp", as_int),
                    ("leftResponseSeconds", as_int),
                    ("rightResponseSeconds", as_int),
                ],
            )?;
            let proposer = data.get("proposerIsLeft")?.as_bool()?;
            let start = decoded["disputeStartTimestamp"].as_i64()?;
            let left = decoded["leftResponseSeconds"].as_i64()?;
            let right = decoded["rightResponseSeconds"].as_i64()?;
            let timeout = decoded["disputeTimeout"].as_i64()?;
            if start <= 0
                || left < 0
                || right < 0
                || start.checked_add(left)?.checked_add(right)? != timeout
            {
                return None;
            }
            insert(&mut decoded, "proposerIsLeft", Value::Bool(proposer));
            if let Some(batch_nonce) = data.get("batchNonce").and_then(normalize_int) {
                insert(&mut decoded, "batchNonce", int_value(batch_nonce));
            }
            Some(Value::Object(decoded))
        }
        "DisputeFinalized" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("sender", as_entity),
                    ("counterentity", as_entity),
                    ("initialNonce", as_big),
                    ("initialProofbodyHash", as_string),
                    ("finalProofbodyHash", as_string),
                    ("finalizationEvidenceHash", as_string),
                    ("finalProofbody", as_proof_body),
                ],
            )?;
            if let Some(batch_nonce) = data.get("batchNonce").and_then(normalize_int) {
                insert(&mut decoded, "batchNonce", int_value(batch_nonce));
            }
            Some(Value::Object(decoded))
        }
        "CounterDisputeRegistered" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("sender", as_entity),
                    ("counterentity", as_entity),
                    ("nonce", as_int),
                    ("proofbodyHash", as_bytes32),
                    ("counterProofbody", as_proof_body),
                ],
            )?;
            insert(
                &mut decoded,
                "proposerIsLeft",
                Value::Bool(data.get("proposerIsLeft")?.as_bool()?),
            );
            Some(Value::Object(decoded))
        }
        "HashLadderRevealRegistered" => {
            let mut decoded = decode_object(
                data,
                &[
                    ("entity", as_entity),
                    ("counterpartyEntity", as_entity),
                    ("ladderHash", as_bytes32),
                    ("fillRatio", as_int),
                    ("fullSecret", as_bytes32),
                    ("reveals", bytes32_quartet),
                    ("revealedAt", as_int),
                ],
            )?;
            let fill_ratio = decoded["fillRatio"].as_i64()?;
            let revealed_at = decoded["revealedAt"].as_i64()?;
            if !(1..=0xffff).contains(&fill_ratio) || revealed_at <= 0 {
                return None;
            }
            insert(
                &mut decoded,
                "targetRole",
                Value::Bool(data.get("targetRole")?.as_bool()?),
            );
            Some(Value::Object(decoded))
        }
        "DebtEnforced" => decode_object(
            data,
            &[
                ("debtor", as_entity),
                ("creditor", as_entity),
                ("tokenId", as_int),
                ("amountPaid", as_big),
                ("remainingAmount", as_big),
                ("newDebtIndex", as_int),
            ],
        )
        .map(Value::Object),
        "DebtForgiven" => decode_object(
            data,
            &[
                ("debtor", as_entity),
                ("creditor", as_entity),
                ("tokenId", as_int),
                ("amountForgiven", as_big),
                ("debtIndex", as_int),
            ],
        )
        .map(Value::Object),
        _ => None,
    }
}
