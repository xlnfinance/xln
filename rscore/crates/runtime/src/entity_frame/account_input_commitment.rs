//! Rust mirror of
//! `core/entity/consensus/frame/account-input-commitment.ts`.

use serde_json::{Map, Number, Value};

use super::EntityFrameError;

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

fn integer(value: &Value, path: &str) -> Result<Value, EntityFrameError> {
    if let Some(value) = value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
    {
        return Ok(Value::Number(Number::from(value)));
    }
    if let Some(value) = value
        .as_i64()
        .filter(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
    {
        return Ok(Value::Number(Number::from(value)));
    }
    Err(EntityFrameError::Value(format!("INTEGER:{path}")))
}

fn lowercase(value: &Value, path: &str) -> Result<Value, EntityFrameError> {
    value
        .as_str()
        .map(|value| Value::String(value.to_lowercase()))
        .ok_or_else(|| EntityFrameError::Value(format!("STRING:{path}")))
}

fn require_hex32(value: &Value, path: &str) -> Result<Value, EntityFrameError> {
    let value = value
        .as_str()
        .map(str::to_lowercase)
        .ok_or_else(|| EntityFrameError::Value(format!("HEX32:{path}")))?;
    let valid = value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64 && payload.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    if !valid {
        return Err(EntityFrameError::Value(format!("HEX32:{path}")));
    }
    Ok(Value::String(value))
}

fn settlement_witnesses(frame: &Map<String, Value>) -> Result<Vec<Value>, EntityFrameError> {
    let Some(txs) = frame.get("accountTxs").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut witnesses = Vec::new();
    for (index, tx) in txs.iter().enumerate() {
        let tx = object(tx, &format!("frame.accountTxs[{index}]"))?;
        if tx.get("type").and_then(Value::as_str) != Some("settle_transition") {
            continue;
        }
        let data = object(
            required(tx, "data", "frame.accountTxs")?,
            "frame.accountTxs.data",
        )?;
        if data.get("kind").and_then(Value::as_str) != Some("hanko") {
            continue;
        }
        let post_hanko = data
            .get("postProof")
            .and_then(Value::as_object)
            .and_then(|post| post.get("hanko"));
        if data.get("settlementHanko").is_none() && post_hanko.is_none() {
            continue;
        }
        let mut row = Map::new();
        row.insert(
            "settlementHash".into(),
            require_hex32(
                required(data, "settlementHash", "settlement")?,
                "settlementHash",
            )?,
        );
        if let Some(value) = data.get("settlementHanko") {
            row.insert("settlementHanko".into(), value.clone());
        }
        if let Some(value) = post_hanko {
            row.insert("postProofHanko".into(), value.clone());
        }
        witnesses.push(Value::Object(row));
    }
    Ok(witnesses)
}

fn account_frame_commitment(value: &Value) -> Result<Value, EntityFrameError> {
    let frame = object(value, "accountFrame")?;
    let mut result = Map::from_iter([
        (
            "domain".into(),
            Value::String("xln:account-frame-commitment:v1".into()),
        ),
        (
            "height".into(),
            integer(
                required(frame, "height", "accountFrame")?,
                "accountFrame.height",
            )?,
        ),
        (
            "timestamp".into(),
            integer(
                required(frame, "timestamp", "accountFrame")?,
                "accountFrame.timestamp",
            )?,
        ),
        (
            "jHeight".into(),
            integer(
                required(frame, "jHeight", "accountFrame")?,
                "accountFrame.jHeight",
            )?,
        ),
        (
            "prevFrameHash".into(),
            lowercase(
                required(frame, "prevFrameHash", "accountFrame")?,
                "accountFrame.prevFrameHash",
            )?,
        ),
        (
            "byLeft".into(),
            Value::Bool(frame.get("byLeft").and_then(Value::as_bool) == Some(true)),
        ),
        (
            "accountStateRoot".into(),
            require_hex32(
                required(frame, "accountStateRoot", "accountFrame")?,
                "accountFrame.accountStateRoot",
            )?,
        ),
        (
            "stateHash".into(),
            require_hex32(
                required(frame, "stateHash", "accountFrame")?,
                "accountFrame.stateHash",
            )?,
        ),
    ]);
    let witnesses = settlement_witnesses(frame)?;
    if !witnesses.is_empty() {
        result.insert("inboundSettlementWitnesses".into(), Value::Array(witnesses));
    }
    Ok(Value::Object(result))
}

fn project_ack(value: &Value, path: &str) -> Result<Value, EntityFrameError> {
    let mut ack = object(value, path)?.clone();
    ack.insert(
        "height".into(),
        integer(required(&ack, "height", path)?, &format!("{path}.height"))?,
    );
    ack.insert(
        "frameHash".into(),
        require_hex32(
            required(&ack, "frameHash", path)?,
            &format!("{path}.frameHash"),
        )?,
    );
    Ok(Value::Object(ack))
}

pub(super) fn account_input_commitment(value: &Value) -> Result<Value, EntityFrameError> {
    let data = object(value, "accountInput")?;
    let mut result = data.clone();
    if let Some(value) = data.get("proposal") {
        let mut proposal = object(value, "accountInput.proposal")?.clone();
        proposal.insert(
            "frame".into(),
            account_frame_commitment(required(&proposal, "frame", "accountInput.proposal")?)?,
        );
        result.insert("proposal".into(), Value::Object(proposal));
    }
    if let Some(value) = data.get("ack") {
        result.insert("ack".into(), project_ack(value, "accountInput.ack")?);
    }
    if let Some(value) = data.get("boardHankoRefresh") {
        result.insert(
            "boardHankoRefresh".into(),
            project_ack(value, "accountInput.boardHankoRefresh")?,
        );
    }
    Ok(Value::Object(result))
}
