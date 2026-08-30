//! Rust mirror of `canonicalJEventDataForFrameHash` in
//! `core/entity/consensus/frame.ts`.

mod events;
mod normalize;

use serde_json::{Map, Number, Value};

use super::EntityFrameError;
use events::normalize_event_data;
use normalize::{invalid, metadata, record};

const FRAME_VERSION: &str = "xln:j-event-range-frame:v1";

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, EntityFrameError> {
    value
        .as_object()
        .ok_or_else(|| EntityFrameError::Value(format!("OBJECT:{path}")))
}

fn required<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<&'a Value, EntityFrameError> {
    object
        .get(name)
        .ok_or_else(|| EntityFrameError::Value(format!("FIELD:{path}.{name}")))
}

fn to_int(value: Option<&Value>) -> Value {
    let number = match value {
        None | Some(Value::Null) => 0,
        Some(Value::Bool(true)) => 1,
        Some(Value::Bool(false)) => 0,
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse::<i64>().unwrap_or(0),
        Some(_) => 0,
    };
    Value::Number(Number::from(number))
}

fn lowercase(value: Option<&Value>) -> Value {
    Value::String(
        value
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase(),
    )
}

fn lowercase_trimmed(value: Option<&Value>) -> Value {
    Value::String(
        value
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase(),
    )
}

fn raw_j_events(data: &Map<String, Value>) -> Result<Vec<&Value>, EntityFrameError> {
    match data.get("events") {
        Some(Value::Array(events)) => Ok(events.iter().collect()),
        Some(_) => Err(EntityFrameError::Value(
            "JURISDICTION_EVENTS_ARRAY_REQUIRED".into(),
        )),
        None => match data.get("event") {
            Some(event) => Ok(vec![event]),
            None => Ok(Vec::new()),
        },
    }
}

fn meta_null(event: &Map<String, Value>, name: &str, lower: bool) -> Value {
    match event.get(name) {
        Some(Value::String(text)) if lower => Value::String(text.to_ascii_lowercase()),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}

fn project_event(value: &Value, index: usize) -> Result<Value, EntityFrameError> {
    let event = record(value).ok_or_else(|| invalid(index))?;
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(index))?;
    let data = event
        .get("data")
        .and_then(record)
        .ok_or_else(|| invalid(index))?;
    let normalized = normalize_event_data(kind, data).ok_or_else(|| invalid(index))?;
    let meta = metadata(event);
    Ok(Value::Object(Map::from_iter([
        ("blockNumber".into(), meta_null(&meta, "blockNumber", false)),
        ("blockHash".into(), meta_null(&meta, "blockHash", true)),
        (
            "transactionHash".into(),
            meta_null(&meta, "transactionHash", true),
        ),
        ("logIndex".into(), meta_null(&meta, "logIndex", false)),
        ("eventIndex".into(), meta_null(&meta, "eventIndex", false)),
        ("type".into(), Value::String(kind.to_string())),
        ("data".into(), normalized),
    ])))
}

fn canonical_events(data: &Map<String, Value>) -> Result<Vec<Value>, EntityFrameError> {
    raw_j_events(data)?
        .into_iter()
        .enumerate()
        .map(|(index, value)| project_event(value, index))
        .collect()
}

fn project_block(value: &Value, index: usize) -> Result<Value, EntityFrameError> {
    let path = format!("j_event.blocks[{index}]");
    let block = object(value, &path)?;
    Ok(Value::Object(Map::from_iter([
        ("blockNumber".into(), to_int(block.get("blockNumber"))),
        ("blockHash".into(), lowercase(block.get("blockHash"))),
        ("eventsHash".into(), lowercase(block.get("eventsHash"))),
        ("events".into(), Value::Array(canonical_events(block)?)),
        (
            "disputeFinalizationEvidenceHash".into(),
            lowercase(block.get("disputeFinalizationEvidenceHash")),
        ),
    ])))
}

/// Canonical `j_event` data for Entity-frame hashing.
pub(super) fn canonical_j_event_data_for_frame_hash(
    value: &Value,
) -> Result<Value, EntityFrameError> {
    let data = object(value, "j_event")?;
    if !data.get("blocks").is_some_and(Value::is_array) || data.get("rangeHash").is_none() {
        return Err(EntityFrameError::Value(
            "ENTITY_FRAME_J_EVENT_RANGE_REQUIRED".into(),
        ));
    }
    let blocks = required(data, "blocks", "j_event")?
        .as_array()
        .ok_or_else(|| EntityFrameError::Value("ARRAY:j_event.blocks".into()))?;
    let projected = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| project_block(block, index))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Object(Map::from_iter([
        ("version".into(), Value::String(FRAME_VERSION.into())),
        ("from".into(), lowercase(data.get("from"))),
        (
            "jurisdictionRef".into(),
            lowercase_trimmed(data.get("jurisdictionRef")),
        ),
        ("baseHeight".into(), to_int(data.get("baseHeight"))),
        (
            "scannedThroughHeight".into(),
            to_int(data.get("scannedThroughHeight")),
        ),
        ("tipBlockHash".into(), lowercase(data.get("tipBlockHash"))),
        (
            "eventHistoryRoot".into(),
            lowercase(data.get("eventHistoryRoot")),
        ),
        ("rangeHash".into(), lowercase(data.get("rangeHash"))),
        ("blocks".into(), Value::Array(projected)),
        ("signature".into(), lowercase(data.get("signature"))),
        ("observedAt".into(), to_int(data.get("observedAt"))),
    ])))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    fn addr(byte: &str) -> String {
        format!("0x{}", byte.repeat(20))
    }

    fn wrap(events: serde_json::Value) -> Value {
        let hash = entity("ab");
        json!({
            "from": "0xAA",
            "jurisdictionRef": " Ethereum ",
            "baseHeight": 3,
            "scannedThroughHeight": 9,
            "tipBlockHash": hash,
            "eventHistoryRoot": hash,
            "rangeHash": hash,
            "signature": "0xCD",
            "observedAt": 42,
            "blocks": [{
                "blockNumber": 100,
                "blockHash": hash,
                "eventsHash": hash,
                "disputeFinalizationEvidenceHash": hash,
                "events": events
            }]
        })
    }

    fn project_events(events: serde_json::Value) -> Value {
        canonical_j_event_data_for_frame_hash(&wrap(events)).expect("project")["blocks"][0]["events"]
            .clone()
    }

    #[test]
    fn account_settled_j_event_projects_exact_canonical_data() {
        let left = entity("11");
        let right = entity("22");
        let hash = entity("ab");
        let input = wrap(json!([{
            "type": "AccountSettled",
            "blockNumber": 100,
            "blockHash": hash,
            "transactionHash": hash,
            "logIndex": 2,
            "eventIndex": 1,
            "data": {
                "leftEntity": left,
                "rightEntity": right,
                "tokenId": 1,
                "leftReserve": "10",
                "rightReserve": "20",
                "collateral": "30",
                "ondelta": "-5",
                "nonce": 7
            }
        }]));
        let projected = canonical_j_event_data_for_frame_hash(&input).expect("project");
        assert_eq!(projected["from"], "0xaa");
        assert_eq!(projected["jurisdictionRef"], "ethereum");
        let event = &projected["blocks"][0]["events"][0];
        assert_eq!(event["type"], "AccountSettled");
        assert_eq!(event["data"]["leftEntity"], left);
        assert_eq!(event["data"]["ondelta"], "-5");
        assert_eq!(event["logIndex"], 2);
    }

    #[test]
    fn board_activated_rejects_zero_previous_valid_until() {
        let hash = entity("ab");
        let err = canonical_j_event_data_for_frame_hash(&wrap(json!([{
            "type": "BoardActivated",
            "data": {
                "entityId": hash,
                "previousBoardHash": hash,
                "newBoardHash": hash,
                "previousBoardValidUntil": "0"
            }
        }])))
        .expect_err("zero until");
        assert!(err.to_string().contains("JURISDICTION_EVENT_INVALID:0"));
    }

    #[test]
    fn wallet_snapshot_sorts_token_balances() {
        let owner = addr("aa");
        let events = project_events(json!([{
            "type": "ExternalWalletSnapshot",
            "data": {
                "entityId": "  0xBB  ",
                "owner": owner,
                "tokenBalances": [
                    { "tokenAddress": addr("cc"), "balance": "2", "tokenId": 1 },
                    { "tokenAddress": addr("aa"), "balance": "1" }
                ]
            }
        }]));
        let balances = events[0]["data"]["tokenBalances"]
            .as_array()
            .expect("sorted");
        assert_eq!(balances[0]["tokenAddress"], addr("aa"));
        assert_eq!(balances[1]["tokenAddress"], addr("cc"));
        assert_eq!(events[0]["data"]["entityId"], "0xbb");
    }

    #[test]
    fn hanko_and_provider_and_debt_normalize() {
        let hash = entity("ab");
        let events = project_events(json!([
            {
                "type": "HankoBatchProcessed",
                "data": { "entityId": hash, "batchHash": hash, "nonce": 1 }
            },
            {
                "type": "EntityProviderActionExecuted",
                "data": { "entityId": hash, "actionNonce": "1", "actionHash": hash, "actionKind": 0 }
            },
            {
                "type": "DebtCreated",
                "data": {
                    "debtor": entity("11"),
                    "creditor": entity("22"),
                    "tokenId": 1,
                    "amount": "BigInt(9)",
                    "debtIndex": 0
                }
            },
            {
                "type": "FoundationBootstrapped",
                "data": {
                    "recipient": addr("11"),
                    "boardHash": hash,
                    "controlTokenId": "1",
                    "dividendTokenId": "2"
                }
            },
            {
                "type": "ReserveUpdated",
                "data": { "entity": entity("33"), "tokenId": 7, "newBalance": "8" }
            },
            {
                "type": "SecretRevealed",
                "data": { "hashlock": "H", "revealer": "AbC", "secret": "s" }
            }
        ]));
        assert_eq!(events[0]["data"]["nonce"], 1);
        assert_eq!(events[1]["data"]["actionKind"], 0);
        assert_eq!(events[2]["data"]["amount"], "9");
        assert_eq!(events[5]["data"]["revealer"], "abc");
    }

    #[test]
    fn dispute_and_hash_ladder_events_project() {
        let hash = entity("ab");
        let proof = json!({
            "watchSeed": hash,
            "leftResponseSeconds": 10,
            "rightResponseSeconds": 20,
            "offdeltas": [{"__xlnType":"BigInt","value":"-1"}],
            "tokenIds": [{"__xlnType":"BigInt","value":"7"}],
            "transformers": []
        });
        let events = project_events(json!([
            {"type":"DisputeStarted","data":{
                "sender":entity("11"),"counterentity":entity("22"),"nonce":"7",
                "proposerIsLeft":true,"proofbodyHash":hash,"watchSeed":hash,
                "starterInitialArguments":"0x","starterCounterArguments":"0x",
                "starterCounterProofCommitment":hash,"initialProofbody":proof,
                "disputeTimeout":130,"disputeStartTimestamp":100,
                "leftResponseSeconds":10,"rightResponseSeconds":20
            }},
            {"type":"DisputeFinalized","data":{
                "sender":entity("11"),"counterentity":entity("22"),"initialNonce":"7",
                "initialProofbodyHash":hash,"finalProofbodyHash":hash,
                "finalizationEvidenceHash":hash,"finalProofbody":proof
            }},
            {"type":"CounterDisputeRegistered","data":{
                "sender":entity("11"),"counterentity":entity("22"),"nonce":8,
                "proposerIsLeft":false,"proofbodyHash":hash,"counterProofbody":proof
            }},
            {"type":"HashLadderRevealRegistered","data":{
                "entity":entity("11"),"counterpartyEntity":entity("22"),"ladderHash":hash,
                "fillRatio":65535,"fullSecret":hash,"reveals":[hash,hash,hash,hash],
                "targetRole":true,"revealedAt":101
            }}
        ]));
        assert_eq!(events.as_array().expect("events").len(), 4);
        assert_eq!(events[0]["data"]["nonce"], "7");
        assert_eq!(
            events[0]["data"]["initialProofbody"]["tokenIds"][0]["value"],
            "7"
        );
        assert_eq!(events[3]["data"]["fillRatio"], 65535);
    }
}
