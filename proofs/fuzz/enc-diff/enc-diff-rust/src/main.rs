//! C1 differential driver: reads the shared corpus and prints one JSON line
//! per case with the Rust encoder's bytes (or its rejection).
//!
//! Usage: enc-diff-rust <corpus-dir>
//! Line shapes:
//!   {"file":"x.json","result":"ok","hex":"<lowercase hex, no 0x>", ...extra}
//!   {"file":"x.json","result":"error","error":"<message>"}
//!
//! The reconstruction mirrors proofs/fuzz/enc-diff/generate.ts and run.ts:
//! undefined-valued object entries are dropped at this boundary (TypeScript
//! filters them inside its encoder), while every other rejection must come
//! from production rscore code, never from this driver.

use std::fs;
use std::path::PathBuf;

use num_bigint::BigInt;
use serde_json::{Value as Json, json};
use xln_rscore_engine::{
    AccountSettledEvent, AccountTx, DeliveryMode, EntityId, HtlcDeliveryMode, HtlcHashlock,
    HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx, JClaimNode, JClaimProof, JClaimRecord,
    JClaimSide, JEventClaimTx, JEventMetadata, JurisdictionEvent, OpaqueHtlcCiphertext, TokenId,
    canonical_tx_value,
};
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, RadixLeaf, RlpWriter, build_radix16_merkle,
    compute_flat_integrity_root, encode_account_state_value, hash_branch16, hash_extension16,
    hash_leaf, write_account_state_value,
};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "proofs/fuzz/enc-diff/corpus".to_string());
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read corpus dir {dir}: {error}"))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        let text = fs::read_to_string(&file).unwrap_or_else(|error| panic!("read {name}: {error}"));
        let case: Json = serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {name}: {error}"));
        let line = match run_case(&case) {
            Ok(value) => {
                let mut object = match value {
                    Json::Object(map) => map,
                    other => serde_json::Map::from_iter([(String::new(), other)]),
                };
                object.insert("file".to_string(), json!(name));
                object.insert("result".to_string(), json!("ok"));
                Json::Object(object)
            }
            Err(error) => json!({"file": name, "result": "error", "error": error}),
        };
        println!("{line}");
    }
}

fn run_case(case: &Json) -> Result<Json, String> {
    let kind = case["kind"].as_str().unwrap_or_default();
    match kind {
        "value" => {
            let value = to_canonical(&case["value"])?;
            let bytes = encode_account_state_value(&value).map_err(|e| e.to_string())?;
            let mut writer = RlpWriter::with_capacity(bytes.len().max(64));
            write_account_state_value(&mut writer, &value)
                .map_err(|e| e.to_string())?;
            if writer.as_slice() != bytes.as_slice() {
                return Err("RUST_STREAMING_WRITER_MISMATCH".to_string());
            }
            Ok(json!({"hex": hex::encode(&bytes)}))
        }
        "flat-root" => {
            let namespace = case["namespace"].as_str().unwrap_or_default().to_string();
            let mut entries = Vec::new();
            for entry in case["entries"].as_array().unwrap_or(&vec![]) {
                let path = entry[0].as_str().unwrap_or_default().to_string();
                entries.push((path, to_canonical(&entry[1])?));
            }
            let root = compute_flat_integrity_root(&namespace, &entries)
                .map_err(|e| e.to_string())?;
            Ok(json!({"hex": hex::encode(root)}))
        }
        "radix-leaf" => {
            let key = parse_hex(&case["keyHex"])?;
            let digest = parse_hex32(&case["valueHex"])?;
            Ok(json!({"hex": hex::encode(hash_leaf(&key, &digest))}))
        }
        "radix-branch" => {
            let mut children = Vec::new();
            for (slot, value) in case["slots"].as_array().unwrap_or(&vec![]).iter().enumerate() {
                if !value.is_null() {
                    children.push((slot as u8, parse_hex32(value)?));
                }
            }
            let hash = hash_branch16(&children).map_err(|e| e.to_string())?;
            Ok(json!({"hex": hex::encode(hash)}))
        }
        "radix-extension" => {
            let path = case["path"].as_array().unwrap_or(&vec![])
                .iter()
                .map(|slot| slot.as_u64().unwrap_or_default() as u8)
                .collect::<Vec<_>>();
            let child = parse_hex32(&case["childHex"])?;
            let hash = hash_extension16(&path, &child).map_err(|e| e.to_string())?;
            Ok(json!({"hex": hex::encode(hash)}))
        }
        "radix-tree" => {
            let mut leaves = Vec::new();
            for leaf in case["leaves"].as_array().unwrap_or(&vec![]) {
                leaves.push(RadixLeaf {
                    key: parse_hex(&leaf["keyHex"])?,
                    value_digest: parse_hex32(&leaf["valueHex"])?,
                });
            }
            let result = build_radix16_merkle(&leaves).map_err(|e| e.to_string())?;
            Ok(json!({
                "hex": hex::encode(result.root),
                "depth": result.depth,
                "leafCount": result.leaf_count,
                "branchCount": result.branch_count,
                "extensionCount": result.extension_count,
                "maxDepth": result.max_depth,
            }))
        }
        "tx" => {
            let tx_kind = case["txKind"].as_str().unwrap_or_default();
            let tx = to_tx(tx_kind, &case["data"])?;
            let canonical = canonical_tx_value(&tx).map_err(|e| e.to_string())?;
            let bytes = encode_account_state_value(&canonical).map_err(|e| e.to_string())?;
            Ok(json!({"hex": hex::encode(&bytes)}))
        }
        other => Err(format!("CASE_KIND_UNKNOWN:{other}")),
    }
}

// ── wire CanonicalValue → rscore CanonicalValue ──────────────────────────────

fn to_canonical(value: &Json) -> Result<CanonicalValue, String> {
    let tag = value["t"].as_str().unwrap_or_default();
    match tag {
        "null" => Ok(CanonicalValue::Null),
        "bool" => Ok(CanonicalValue::Bool(value["v"].as_bool().unwrap_or(false))),
        "num" => CanonicalNumber::parse_js_canonical(value["v"].as_str().unwrap_or_default())
            .map(CanonicalValue::Number)
            .map_err(|e| e.to_string()),
        "bign" => {
            let text = value["v"].as_str().unwrap_or_default();
            BigInt::parse_bytes(text.as_bytes(), 10)
                .map(CanonicalValue::BigInt)
                .ok_or_else(|| format!("WIRE_BIGINT_INVALID:{text}"))
        }
        "str" => Ok(CanonicalValue::String(value["v"].as_str().unwrap_or_default().to_string())),
        "arr" => value["v"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(to_canonical)
            .collect::<Result<Vec<_>, _>>()
            .map(CanonicalValue::Array),
        "set" => value["v"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(to_canonical)
            .collect::<Result<Vec<_>, _>>()
            .map(CanonicalValue::Set),
        "map" => value["v"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|pair| Ok((to_canonical(&pair[0])?, to_canonical(&pair[1])?)))
            .collect::<Result<Vec<_>, String>>()
            .map(CanonicalValue::Map),
        "obj" => value["v"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter(|entry| entry[1]["t"].as_str() != Some("undef"))
            .map(|entry| {
                Ok((
                    entry[0].as_str().unwrap_or_default().to_string(),
                    to_canonical(&entry[1])?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()
            .map(CanonicalValue::Object),
        "undef" => Err("WIRE_UNDEF_OUTSIDE_OBJECT".to_string()),
        other => Err(format!("WIRE_TAG_UNKNOWN:{other}")),
    }
}

// ── tx wire → rscore AccountTx ───────────────────────────────────────────────

fn field<'a>(data: &'a Json, name: &str) -> Option<&'a Json> {
    data.get(name).filter(|value| !value.is_null())
}
fn text(data: &Json, name: &str) -> Result<String, String> {
    field(data, name)
        .and_then(Json::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("TX_FIELD_INVALID:{name}"))
}
fn uint(data: &Json, name: &str) -> Result<u64, String> {
    match field(data, name) {
        Some(Json::Number(number)) => number.as_u64().ok_or_else(|| format!("TX_FIELD_INVALID:{name}")),
        Some(Json::String(text)) => text.parse::<u64>().map_err(|_| format!("TX_FIELD_INVALID:{name}")),
        _ => Err(format!("TX_FIELD_INVALID:{name}")),
    }
}
fn big(data: &Json, name: &str) -> Result<BigInt, String> {
    let value = field(data, name).ok_or_else(|| format!("TX_FIELD_INVALID:{name}"))?;
    let text = value
        .as_str()
        .ok_or_else(|| format!("TX_FIELD_NOT_STRING:{name}"))?;
    BigInt::parse_bytes(text.as_bytes(), 10).ok_or_else(|| format!("TX_FIELD_INVALID:{name}"))
}
fn optional_big(data: &Json, name: &str) -> Result<Option<BigInt>, String> {
    match field(data, name) {
        Some(_) => big(data, name).map(Some),
        None => Ok(None),
    }
}
fn optional_u32(data: &Json, name: &str) -> Result<Option<u32>, String> {
    match field(data, name) {
        Some(_) => Ok(Some(u32::try_from(uint(data, name)?).map_err(|_| format!("TX_FIELD_INVALID:{name}"))?)),
        None => Ok(None),
    }
}
fn optional_text(data: &Json, name: &str) -> Option<String> {
    field(data, name).and_then(Json::as_str).map(str::to_string)
}
fn token(data: &Json, name: &str) -> Result<TokenId, String> {
    TokenId::new(u32::try_from(uint(data, name)?).map_err(|_| format!("TX_FIELD_INVALID:{name}"))?)
        .map_err(|error| format!("TX_FIELD_INVALID:{name}:{error}"))
}
fn parse_hex(value: &Json) -> Result<Vec<u8>, String> {
    let text = value.as_str().unwrap_or_default();
    let clean = text.strip_prefix("0x").unwrap_or(text);
    hex::decode(clean).map_err(|_| format!("WIRE_HEX_INVALID:{text}"))
}
fn parse_hex32(value: &Json) -> Result<[u8; 32], String> {
    let bytes = parse_hex(value)?;
    bytes.try_into().map_err(|_| "WIRE_HEX32_INVALID".to_string())
}

fn to_tx(kind: &str, data: &Json) -> Result<AccountTx, String> {
    match kind {
        "direct_payment" => Ok(AccountTx::DirectPayment {
            token_id: token(data, "tokenId")?,
            amount: big(data, "amount")?,
            route: data["route"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|hop| hop.as_str().unwrap_or_default().to_string())
                .collect(),
            description: optional_text(data, "description"),
            from_entity_id: text(data, "fromEntityId")?,
            to_entity_id: text(data, "toEntityId")?,
            delivery_mode: match text(data, "deliveryMode")?.as_str() {
                "direct" => DeliveryMode::Direct,
                "trusted" => DeliveryMode::Trusted,
                other => return Err(format!("TX_FIELD_INVALID:deliveryMode:{other}")),
            },
            trusted_gateway_entity_id: optional_text(data, "trustedGatewayEntityId"),
        }),
        "add_delta" => Ok(AccountTx::AddDelta { token_id: token(data, "tokenId")? }),
        "set_credit_limit" => Ok(AccountTx::SetCreditLimit {
            token_id: token(data, "tokenId")?,
            amount: big(data, "amount")?,
        }),
        "rebalance_policy" => Ok(AccountTx::RebalancePolicy {
            token_id: u32::try_from(uint(data, "tokenId")?).map_err(|_| "TX_FIELD_INVALID:tokenId".to_string())?,
            policy_version: uint(data, "policyVersion")?,
            base_fee: big(data, "baseFee")?,
            liquidity_fee_bps: big(data, "liquidityFeeBps")?,
            gas_fee: big(data, "gasFee")?,
        }),
        "swap_offer" => Ok(AccountTx::SwapOffer {
            offer_id: text(data, "offerId")?,
            give_token_id: u32::try_from(uint(data, "giveTokenId")?).map_err(|_| "TX_FIELD_INVALID".to_string())?,
            give_token_decimals: u32::try_from(uint(data, "giveTokenDecimals")?).map_err(|_| "TX_FIELD_INVALID".to_string())?,
            give_amount: big(data, "giveAmount")?,
            want_token_id: u32::try_from(uint(data, "wantTokenId")?).map_err(|_| "TX_FIELD_INVALID".to_string())?,
            want_token_decimals: u32::try_from(uint(data, "wantTokenDecimals")?).map_err(|_| "TX_FIELD_INVALID".to_string())?,
            want_amount: big(data, "wantAmount")?,
            max_fee: big(data, "maxFee")?,
            min_net_receive: big(data, "minNetReceive")?,
            time_in_force: optional_u32(data, "timeInForce")?
                .map(u8::try_from)
                .transpose()
                .map_err(|_| "TX_FIELD_INVALID:timeInForce".to_string())?,
            price_ticks: optional_big(data, "priceTicks")?,
        }),
        "swap_resolve" => Ok(AccountTx::SwapResolve {
            offer_id: text(data, "offerId")?,
            fill_ratio: u32::try_from(uint(data, "fillRatio")?).map_err(|_| "TX_FIELD_INVALID".to_string())?,
            fill_numerator: optional_big(data, "fillNumerator")?,
            fill_denominator: optional_big(data, "fillDenominator")?,
            cancel_remainder: field(data, "cancelRemainder").and_then(Json::as_bool).unwrap_or(false),
            comment: optional_text(data, "comment"),
            fee_token_id: optional_u32(data, "feeTokenId")?,
            fee_amount: optional_big(data, "feeAmount")?,
            execution_give_amount: optional_big(data, "executionGiveAmount")?,
            execution_want_amount: optional_big(data, "executionWantAmount")?,
            resting_give_token_id: optional_u32(data, "restingGiveTokenId")?,
            resting_want_token_id: optional_u32(data, "restingWantTokenId")?,
            resting_price_ticks: optional_big(data, "restingPriceTicks")?,
            resting_give_amount: optional_big(data, "restingGiveAmount")?,
            resting_want_amount: optional_big(data, "restingWantAmount")?,
            resting_quantized_give: optional_big(data, "restingQuantizedGive")?,
            resting_quantized_want: optional_big(data, "restingQuantizedWant")?,
        }),
        "swap_cancel_request" => Ok(AccountTx::SwapCancelRequest { offer_id: text(data, "offerId")? }),
        "htlc_lock" => Ok(AccountTx::HtlcLock(HtlcLockTx {
            lock_id: text(data, "lockId")?,
            hashlock: HtlcHashlock::parse(&text(data, "hashlock")?).map_err(|e| e.to_string())?,
            timelock: big(data, "timelock")?,
            reveal_before_height: uint(data, "revealBeforeHeight")?,
            amount: big(data, "amount")?,
            token_id: token(data, "tokenId")?,
            delivery_mode: match optional_text(data, "deliveryMode").as_deref() {
                None => None,
                Some("instant") => Some(HtlcDeliveryMode::Instant),
                Some("async") => Some(HtlcDeliveryMode::Async),
                Some(other) => return Err(format!("TX_FIELD_INVALID:deliveryMode:{other}")),
            },
            envelope: match field(data, "envelope") {
                None => None,
                Some(envelope) => Some(OpaqueHtlcCiphertext::parse(
                    envelope["version"].as_str().unwrap_or_default(),
                    envelope["ciphertext"].as_str().unwrap_or_default(),
                ).map_err(|e| e.to_string())?),
            },
        })),
        "htlc_resolve" => Ok(AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: text(data, "lockId")?,
            outcome: match text(data, "outcome")?.as_str() {
                "secret" => HtlcResolveOutcome::Secret { secret: text(data, "secret")? },
                "error" => HtlcResolveOutcome::Error { reason: optional_text(data, "reason") },
                other => return Err(format!("TX_FIELD_INVALID:outcome:{other}")),
            },
        })),
        "j_event_claim" => Ok(AccountTx::JEventClaim(JEventClaimTx {
            j_height: uint(data, "jHeight")?,
            j_block_hash: parse_hex32(&data["jBlockHash"])?,
            events: data["events"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(to_jurisdiction_event)
                .collect::<Result<Vec<_>, _>>()?,
            left_proof: match field(data, "leftProof") {
                Some(proof) => Some(to_proof(proof)?),
                None => None,
            },
            right_proof: match field(data, "rightProof") {
                Some(proof) => Some(to_proof(proof)?),
                None => None,
            },
        })),
        "lending_fund" => Ok(AccountTx::LendingFund {
            position_id: text(data, "positionId")?,
            hub_entity_id: text(data, "hubEntityId")?,
            lender_entity_id: text(data, "lenderEntityId")?,
            token_id: token(data, "tokenId")?,
            amount: big(data, "amount")?,
            term_id: match text(data, "termId")?.as_str() {
                "one_hour" => xln_rscore_engine::LendingTermId::OneHour,
                "one_day" => xln_rscore_engine::LendingTermId::OneDay,
                "one_month" => xln_rscore_engine::LendingTermId::OneMonth,
                other => return Err(format!("TX_FIELD_INVALID:termId:{other}")),
            },
            interest_bps: uint(data, "interestBps")? as i64,
        }),
        "reserve_to_collateral" => Ok(AccountTx::ReserveToCollateral {
            token_id: token(data, "tokenId")?,
            collateral: text(data, "collateral")?,
            ondelta: text(data, "ondelta")?,
            side: match text(data, "side")?.as_str() {
                "receiving" => xln_rscore_engine::ReserveSide::Receiving,
                "counterparty" => xln_rscore_engine::ReserveSide::Counterparty,
                other => return Err(format!("TX_FIELD_INVALID:side:{other}")),
            },
            block_number: i64::try_from(uint(data, "blockNumber")?)
                .map_err(|_| "TX_FIELD_INVALID:blockNumber".to_string())?,
            transaction_hash: text(data, "transactionHash")?,
        }),
        "request_collateral" => Err("TX_KIND_NOT_MODELED_IN_RUST:request_collateral".to_string()),
        other => Err(format!("TX_KIND_UNKNOWN:{other}")),
    }
}

fn to_jurisdiction_event(raw: &Json) -> Result<JurisdictionEvent, String> {
    let data = &raw["data"];
    let field_u64 = |container: &Json, name: &str| -> Result<Option<u64>, String> {
        match container.get(name) {
            Some(Json::Number(number)) => Ok(number.as_u64()),
            Some(Json::String(text)) => Ok(text.parse::<u64>().ok()),
            _ => Ok(None),
        }
    };
    Ok(JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: field_u64(raw, "blockNumber")?,
            block_hash: match raw.get("blockHash") {
                Some(Json::String(text)) => Some(parse_hex32(&Json::String(text.clone()))?),
                _ => None,
            },
            transaction_hash: match raw.get("transactionHash") {
                Some(Json::String(text)) => Some(parse_hex32(&Json::String(text.clone()))?),
                _ => None,
            },
            log_index: field_u64(raw, "logIndex")?,
            event_index: field_u64(raw, "eventIndex")?,
        },
        left_entity: EntityId::parse(&data["leftEntity"].as_str().unwrap_or_default().to_lowercase())
            .map_err(|e| e.to_string())?,
        right_entity: EntityId::parse(&data["rightEntity"].as_str().unwrap_or_default().to_lowercase())
            .map_err(|e| e.to_string())?,
        token_id: TokenId::new(
            u32::try_from(data["tokenId"].as_u64().unwrap_or_default())
                .map_err(|_| "TX_FIELD_INVALID:tokenId".to_string())?,
        )
        .map_err(|e| e.to_string())?,
        left_reserve: parse_bigint_field(&data["leftReserve"], "leftReserve")?,
        right_reserve: parse_bigint_field(&data["rightReserve"], "rightReserve")?,
        collateral: parse_bigint_field(&data["collateral"], "collateral")?,
        ondelta: parse_bigint_field(&data["ondelta"], "ondelta")?,
        nonce: data["nonce"].as_u64().unwrap_or_default(),
    }))
}

/// Mirrors TS normalizeBigNumberish for the wire domain the generator emits:
/// canonical decimal strings (the BigInt branch also accepts them verbatim).
fn parse_bigint_field(value: &Json, name: &str) -> Result<BigInt, String> {
    match value {
        Json::String(text) => BigInt::parse_bytes(text.as_bytes(), 10)
            .ok_or_else(|| format!("TX_FIELD_INVALID:{name}")),
        Json::Number(number) => {
            let integer = number
                .as_u64()
                .ok_or_else(|| format!("TX_FIELD_INVALID:{name}"))?;
            Ok(BigInt::from(integer))
        }
        _ => Err(format!("TX_FIELD_INVALID:{name}")),
    }
}

fn to_proof(proof: &Json) -> Result<JClaimProof, String> {
    let mut nodes = Vec::new();
    for node in proof["nodes"].as_array().unwrap_or(&vec![]) {
        nodes.push(match node["type"].as_str().unwrap_or_default() {
            "leaf" => {
                let record = &node["record"];
                JClaimNode::Leaf {
                    key: parse_hex32(&node["key"])?,
                    record: JClaimRecord {
                        account_key: parse_hex32(&record["accountKey"])?,
                        side: match record["side"].as_str().unwrap_or_default() {
                            "left" => JClaimSide::Left,
                            _ => JClaimSide::Right,
                        },
                        j_height: record["jHeight"].as_u64().unwrap_or_default(),
                        j_block_hash: parse_hex32(&record["jBlockHash"])?,
                        events_hash: parse_hex32(&record["eventsHash"])?,
                    },
                }
            }
            "branch" => JClaimNode::Branch {
                bit: u16::try_from(node["bit"].as_u64().unwrap_or_default())
                    .map_err(|_| "TX_FIELD_INVALID:bit".to_string())?,
                left: parse_hex32(&node["left"])?,
                right: parse_hex32(&node["right"])?,
            },
            other => return Err(format!("PROOF_NODE_TYPE_INVALID:{other}")),
        });
    }
    Ok(JClaimProof { nodes })
}
