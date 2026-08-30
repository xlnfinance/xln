//! Canonical Runtime jurisdiction import intent and completion transition.
//!
//! Import is a two-frame state machine. `importJ` commits a normalized intent;
//! only a locally prepared `completeImportJ` result may then install the exact
//! RPC-backed J replica. Replay executes those same bytes and performs no RPC.

use num_bigint::BigUint;
use serde_json::{Map, Number, Value, json};
use sha3::{Digest, Keccak256};
use thiserror::Error;
use url::Url;

use crate::processor::RuntimeDurableEnvelope;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JurisdictionContracts {
    pub depository: String,
    pub entity_provider: String,
    pub account: String,
    pub delta_transformer: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JurisdictionImportRequest {
    pub name: String,
    pub chain_id: u64,
    pub ticker: String,
    pub rpcs: Vec<String>,
    pub entity_provider_deployment_block: u64,
    pub block_time_ms: Option<u64>,
    pub start_at_current_block: Option<bool>,
    pub rpc_policy_single: bool,
    pub contracts: JurisdictionContracts,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JurisdictionTokenInfo {
    pub symbol: String,
    pub name: String,
    pub address: String,
    pub decimals: u8,
    pub token_id: u64,
    pub token_type: u8,
    pub external_token_id: BigUint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JurisdictionImportResult {
    pub import_id: [u8; 32],
    pub request_hash: [u8; 32],
    pub name: String,
    pub chain_id: u64,
    pub ticker: String,
    pub rpcs: Vec<String>,
    pub block_time_ms: Option<u64>,
    pub block_number: BigUint,
    pub watcher_confirmation_depth: u64,
    pub token_registry: Vec<JurisdictionTokenInfo>,
    pub entity_provider_deployment_block: u64,
    pub contracts: JurisdictionContracts,
}

#[derive(Debug, Error)]
#[error("RSCORE_J_IMPORT:{0}")]
pub struct JurisdictionImportError(String);

fn err(code: impl Into<String>) -> JurisdictionImportError {
    JurisdictionImportError(code.into())
}

fn object<'a>(
    value: &'a Value,
    code: &str,
) -> Result<&'a Map<String, Value>, JurisdictionImportError> {
    value
        .as_object()
        .ok_or_else(|| err(format!("{code}_OBJECT")))
}

fn exact(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    code: &str,
) -> Result<(), JurisdictionImportError> {
    if let Some(field) = required.iter().find(|field| !object.contains_key(**field)) {
        return Err(err(format!("{code}_MISSING:{field}")));
    }
    if let Some(field) = object
        .keys()
        .find(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
    {
        return Err(err(format!("{code}_UNSUPPORTED:{field}")));
    }
    Ok(())
}

fn text(
    object: &Map<String, Value>,
    field: &str,
    code: &str,
) -> Result<String, JurisdictionImportError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| err(format!("{code}_{field}_STRING")))
}

fn safe_u64(value: &Value, code: &str) -> Result<u64, JurisdictionImportError> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| err(format!("{code}_SAFE_INTEGER")))
}

fn normalized_address(value: &str, code: &str) -> Result<String, JurisdictionImportError> {
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() == 40 && body.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| err(format!("{code}_ADDRESS")))?;
    if body.bytes().all(|byte| byte == b'0') {
        return Err(err(format!("{code}_ADDRESS_ZERO")));
    }
    let normalized = format!("0x{}", body.to_ascii_lowercase());
    if normalized != value {
        return Err(err(format!("{code}_ADDRESS_NON_CANONICAL")));
    }
    Ok(normalized)
}

fn digest(value: &str, code: &str) -> Result<[u8; 32], JurisdictionImportError> {
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() == 64 && body.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| err(format!("{code}_DIGEST")))?;
    if body.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(err(format!("{code}_DIGEST_NON_CANONICAL")));
    }
    hex::decode(body)
        .map_err(|_| err(format!("{code}_DIGEST")))?
        .try_into()
        .map_err(|_| err(format!("{code}_DIGEST")))
}

fn hex32(value: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(value))
}

fn decode_contracts(
    value: &Value,
    code: &str,
) -> Result<JurisdictionContracts, JurisdictionImportError> {
    let row = object(value, code)?;
    exact(
        row,
        &[
            "depository",
            "entityProvider",
            "account",
            "deltaTransformer",
        ],
        &[],
        code,
    )?;
    Ok(JurisdictionContracts {
        depository: normalized_address(
            &text(row, "depository", code)?,
            &format!("{code}_DEPOSITORY"),
        )?,
        entity_provider: normalized_address(
            &text(row, "entityProvider", code)?,
            &format!("{code}_ENTITY_PROVIDER"),
        )?,
        account: normalized_address(&text(row, "account", code)?, &format!("{code}_ACCOUNT"))?,
        delta_transformer: normalized_address(
            &text(row, "deltaTransformer", code)?,
            &format!("{code}_DELTA_TRANSFORMER"),
        )?,
    })
}

fn encode_contracts(value: &JurisdictionContracts) -> Value {
    json!({"account":value.account,"deltaTransformer":value.delta_transformer,"depository":value.depository,"entityProvider":value.entity_provider})
}

pub(crate) fn decode_import_request(
    value: &Value,
) -> Result<JurisdictionImportRequest, JurisdictionImportError> {
    let row = object(value, "REQUEST")?;
    exact(
        row,
        &[
            "name",
            "chainId",
            "ticker",
            "rpcs",
            "entityProviderDeploymentBlock",
            "contracts",
        ],
        &["blockTimeMs", "startAtCurrentBlock", "rpcPolicy"],
        "REQUEST",
    )?;
    let name = text(row, "name", "REQUEST")?;
    if name.is_empty() || name.trim() != name || name.chars().count() > 128 {
        return Err(err("NAME_INVALID"));
    }
    let ticker = text(row, "ticker", "REQUEST")?;
    if ticker.is_empty()
        || ticker.chars().count() > 16
        || ticker.trim().to_ascii_uppercase() != ticker
    {
        return Err(err("TICKER_INVALID"));
    }
    let chain_id = safe_u64(&row["chainId"], "CHAIN_ID")?;
    if chain_id == 0 {
        return Err(err("CHAIN_ID_ZERO"));
    }
    let raw_rpcs = row["rpcs"].as_array().ok_or_else(|| err("RPCS_ARRAY"))?;
    if raw_rpcs.len() != 1 {
        return Err(err(format!("RPC_COUNT_UNSUPPORTED:{}", raw_rpcs.len())));
    }
    let mut rpcs = Vec::with_capacity(1);
    for raw in raw_rpcs {
        let source = raw.as_str().ok_or_else(|| err("RPC_STRING"))?;
        let parsed = Url::parse(source).map_err(|_| err("RPC_URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(err("RPC_PROTOCOL"));
        }
        let canonical = parsed.to_string();
        if canonical != source {
            return Err(err("RPC_NON_CANONICAL"));
        }
        rpcs.push(canonical);
    }
    let deployment = safe_u64(&row["entityProviderDeploymentBlock"], "DEPLOYMENT_BLOCK")?;
    if deployment == 0 {
        return Err(err("DEPLOYMENT_BLOCK_ZERO"));
    }
    let block_time_ms = row
        .get("blockTimeMs")
        .map(|value| safe_u64(value, "BLOCK_TIME"))
        .transpose()?;
    if block_time_ms == Some(0) {
        return Err(err("BLOCK_TIME_ZERO"));
    }
    let start_at_current_block = row
        .get("startAtCurrentBlock")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| err("START_AT_CURRENT_BLOCK_BOOL"))
        })
        .transpose()?;
    let rpc_policy_single = match row.get("rpcPolicy") {
        None => false,
        Some(Value::String(value)) if value == "single" => true,
        Some(_) => return Err(err("RPC_POLICY_UNSUPPORTED")),
    };
    Ok(JurisdictionImportRequest {
        name,
        chain_id,
        ticker,
        rpcs,
        entity_provider_deployment_block: deployment,
        block_time_ms,
        start_at_current_block,
        rpc_policy_single,
        contracts: decode_contracts(&row["contracts"], "CONTRACTS")?,
    })
}

pub(crate) fn encode_import_request(value: &JurisdictionImportRequest) -> Value {
    let mut row = Map::from_iter([
        (
            "chainId".into(),
            Value::Number(Number::from(value.chain_id)),
        ),
        ("contracts".into(), encode_contracts(&value.contracts)),
        (
            "entityProviderDeploymentBlock".into(),
            Value::Number(Number::from(value.entity_provider_deployment_block)),
        ),
        ("name".into(), Value::String(value.name.clone())),
        (
            "rpcs".into(),
            Value::Array(value.rpcs.iter().cloned().map(Value::String).collect()),
        ),
        ("ticker".into(), Value::String(value.ticker.clone())),
    ]);
    if let Some(number) = value.block_time_ms {
        row.insert("blockTimeMs".into(), Value::Number(Number::from(number)));
    }
    if let Some(flag) = value.start_at_current_block {
        row.insert("startAtCurrentBlock".into(), Value::Bool(flag));
    }
    if value.rpc_policy_single {
        row.insert("rpcPolicy".into(), Value::String("single".into()));
    }
    Value::Object(row)
}

fn request_hash(value: &JurisdictionImportRequest) -> Result<[u8; 32], JurisdictionImportError> {
    let input =
        json!({"domain":"xln/jurisdiction-import/v1","request":encode_import_request(value)});
    let bytes = serde_json::to_vec(&input).map_err(|_| err("REQUEST_JSON"))?;
    Ok(Keccak256::digest(bytes).into())
}

fn decode_biguint(value: &Value, code: &str) -> Result<BigUint, JurisdictionImportError> {
    let row = object(value, code)?;
    exact(row, &["__xlnType", "value"], &[], code)?;
    if row["__xlnType"] != "BigInt" {
        return Err(err(format!("{code}_BIGINT_TAG")));
    }
    let text = row["value"]
        .as_str()
        .ok_or_else(|| err(format!("{code}_BIGINT_STRING")))?;
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(err(format!("{code}_BIGINT_CANONICAL")));
    }
    BigUint::parse_bytes(text.as_bytes(), 10).ok_or_else(|| err(format!("{code}_BIGINT")))
}

fn encode_biguint(value: &BigUint) -> Value {
    json!({"__xlnType":"BigInt","value":value.to_string()})
}

pub(crate) fn decode_token_registry(
    value: &Value,
) -> Result<Vec<JurisdictionTokenInfo>, JurisdictionImportError> {
    let rows = value
        .as_array()
        .ok_or_else(|| err("TOKEN_REGISTRY_ARRAY"))?;
    let mut output = Vec::with_capacity(rows.len());
    let mut prior_id = 0;
    let mut addresses = std::collections::BTreeSet::new();
    for (index, value) in rows.iter().enumerate() {
        let code = format!("TOKEN_{index}");
        let row = object(value, &code)?;
        exact(
            row,
            &[
                "symbol",
                "name",
                "address",
                "decimals",
                "tokenId",
                "tokenType",
                "externalTokenId",
            ],
            &[],
            &code,
        )?;
        let token_id = safe_u64(&row["tokenId"], &format!("{code}_ID"))?;
        let token_type = safe_u64(&row["tokenType"], &format!("{code}_TYPE"))?;
        let decimals = safe_u64(&row["decimals"], &format!("{code}_DECIMALS"))?;
        if token_id == 0 || token_id <= prior_id || token_type > 2 || decimals > 255 {
            return Err(err(format!("{code}_CANONICAL")));
        }
        let address =
            normalized_address(&text(row, "address", &code)?, &format!("{code}_ADDRESS"))?;
        if !addresses.insert(address.clone()) {
            return Err(err(format!("{code}_ADDRESS_DUPLICATE")));
        }
        output.push(JurisdictionTokenInfo {
            symbol: text(row, "symbol", &code)?,
            name: text(row, "name", &code)?,
            address,
            decimals: decimals as u8,
            token_id,
            token_type: token_type as u8,
            external_token_id: decode_biguint(
                &row["externalTokenId"],
                &format!("{code}_EXTERNAL"),
            )?,
        });
        prior_id = token_id;
    }
    Ok(output)
}

fn encode_token_registry(value: &[JurisdictionTokenInfo]) -> Value {
    Value::Array(value.iter().map(|token| json!({"address":token.address,"decimals":token.decimals,"externalTokenId":encode_biguint(&token.external_token_id),"name":token.name,"symbol":token.symbol,"tokenId":token.token_id,"tokenType":token.token_type})).collect())
}

pub(crate) fn decode_import_result(
    value: &Value,
) -> Result<JurisdictionImportResult, JurisdictionImportError> {
    let row = object(value, "RESULT")?;
    exact(
        row,
        &[
            "importId",
            "requestHash",
            "name",
            "chainId",
            "ticker",
            "rpcs",
            "blockNumber",
            "stateRoot",
            "watcherConfirmationDepth",
            "tokenRegistry",
            "entityProviderDeploymentBlock",
            "contracts",
        ],
        &["blockTimeMs"],
        "RESULT",
    )?;
    if !row["stateRoot"].is_null() {
        return Err(err("RPC_STATE_ROOT_MUST_BE_NULL"));
    }
    let rpcs = row["rpcs"]
        .as_array()
        .ok_or_else(|| err("RESULT_RPCS_ARRAY"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| err("RESULT_RPC_STRING"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(JurisdictionImportResult {
        import_id: digest(&text(row, "importId", "RESULT")?, "IMPORT_ID")?,
        request_hash: digest(&text(row, "requestHash", "RESULT")?, "REQUEST_HASH")?,
        name: text(row, "name", "RESULT")?,
        chain_id: safe_u64(&row["chainId"], "RESULT_CHAIN")?,
        ticker: text(row, "ticker", "RESULT")?,
        rpcs,
        block_time_ms: row
            .get("blockTimeMs")
            .map(|value| safe_u64(value, "RESULT_BLOCK_TIME"))
            .transpose()?,
        block_number: {
            let text = text(row, "blockNumber", "RESULT")?;
            if text.len() > 1 && text.starts_with('0') {
                return Err(err("RESULT_BLOCK_NUMBER_CANONICAL"));
            }
            BigUint::parse_bytes(text.as_bytes(), 10).ok_or_else(|| err("RESULT_BLOCK_NUMBER"))?
        },
        watcher_confirmation_depth: safe_u64(
            &row["watcherConfirmationDepth"],
            "RESULT_CONFIRMATIONS",
        )?,
        token_registry: decode_token_registry(&row["tokenRegistry"])?,
        entity_provider_deployment_block: safe_u64(
            &row["entityProviderDeploymentBlock"],
            "RESULT_DEPLOYMENT",
        )?,
        contracts: decode_contracts(&row["contracts"], "RESULT_CONTRACTS")?,
    })
}

pub(crate) fn encode_import_result(value: &JurisdictionImportResult) -> Value {
    let mut row = Map::from_iter([
        (
            "blockNumber".into(),
            Value::String(value.block_number.to_string()),
        ),
        (
            "chainId".into(),
            Value::Number(Number::from(value.chain_id)),
        ),
        ("contracts".into(), encode_contracts(&value.contracts)),
        (
            "entityProviderDeploymentBlock".into(),
            Value::Number(Number::from(value.entity_provider_deployment_block)),
        ),
        ("importId".into(), Value::String(hex32(&value.import_id))),
        ("name".into(), Value::String(value.name.clone())),
        (
            "requestHash".into(),
            Value::String(hex32(&value.request_hash)),
        ),
        (
            "rpcs".into(),
            Value::Array(value.rpcs.iter().cloned().map(Value::String).collect()),
        ),
        ("stateRoot".into(), Value::Null),
        ("ticker".into(), Value::String(value.ticker.clone())),
        (
            "tokenRegistry".into(),
            encode_token_registry(&value.token_registry),
        ),
        (
            "watcherConfirmationDepth".into(),
            Value::Number(Number::from(value.watcher_confirmation_depth)),
        ),
    ]);
    if let Some(number) = value.block_time_ms {
        row.insert("blockTimeMs".into(), Value::Number(Number::from(number)));
    }
    Value::Object(row)
}

fn map_entries_mut<'a>(
    infrastructure: &'a mut Value,
    field: &str,
) -> Result<&'a mut Vec<Value>, JurisdictionImportError> {
    let object = infrastructure
        .as_object_mut()
        .ok_or_else(|| err("INFRASTRUCTURE_OBJECT"))?;
    if !object.contains_key(field) {
        object.insert(field.into(), json!({"__xlnType":"Map","value":[]}));
    }
    object
        .get_mut(field)
        .and_then(Value::as_object_mut)
        .filter(|row| row.get("__xlnType").and_then(Value::as_str) == Some("Map"))
        .and_then(|row| row.get_mut("value"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| err(format!("{field}_MAP")))
}

fn pending_request(
    value: &Value,
) -> Result<([u8; 32], [u8; 32], JurisdictionImportRequest), JurisdictionImportError> {
    let row = object(value, "PENDING")?;
    exact(row, &["importId", "requestHash", "request"], &[], "PENDING")?;
    Ok((
        digest(&text(row, "importId", "PENDING")?, "PENDING_ID")?,
        digest(&text(row, "requestHash", "PENDING")?, "PENDING_HASH")?,
        decode_import_request(&row["request"])?,
    ))
}

pub(crate) fn apply_import_intent(
    envelope: &mut RuntimeDurableEnvelope,
    request: &JurisdictionImportRequest,
) -> Result<(), JurisdictionImportError> {
    let hash = request_hash(request)?;
    let name_key = request.name.to_ascii_lowercase();
    if let Some(existing) = find_replica(envelope.j_replicas(), &name_key)? {
        assert_replica_request(existing, request)?;
        return Ok(());
    }
    let entries = map_entries_mut(envelope.infrastructure_mut(), "pendingJurisdictionImports")?;
    for pair in entries.iter() {
        let pair = pair
            .as_array()
            .filter(|p| p.len() == 2)
            .ok_or_else(|| err("PENDING_PAIR"))?;
        let (_, existing_hash, existing) = pending_request(&pair[1])?;
        if existing.name.to_ascii_lowercase() != name_key {
            continue;
        }
        if existing_hash == hash {
            return Ok(());
        }
        return Err(err(format!("PENDING_CONFLICT:{}", request.name)));
    }
    entries.push(json!([hex32(&hash),{"importId":hex32(&hash),"request":encode_import_request(request),"requestHash":hex32(&hash)}]));
    envelope.invalidate_infrastructure_digest();
    Ok(())
}

fn find_replica<'a>(
    value: &'a Value,
    name_key: &str,
) -> Result<Option<&'a Value>, JurisdictionImportError> {
    for row in value.as_array().ok_or_else(|| err("J_REPLICAS_ARRAY"))? {
        let pair = row
            .as_array()
            .filter(|p| p.len() == 2)
            .ok_or_else(|| err("J_REPLICA_PAIR"))?;
        if pair[0]
            .as_str()
            .is_some_and(|name| name.trim().to_ascii_lowercase() == name_key)
        {
            return Ok(Some(&pair[1]));
        }
    }
    Ok(None)
}

fn assert_replica_request(
    value: &Value,
    request: &JurisdictionImportRequest,
) -> Result<(), JurisdictionImportError> {
    let row = object(value, "EXISTING")?;
    if row.get("chainId").and_then(Value::as_u64) != Some(request.chain_id)
        || row
            .get("entityProviderDeploymentBlock")
            .and_then(Value::as_u64)
            != Some(request.entity_provider_deployment_block)
        || row.get("contracts") != Some(&encode_contracts(&request.contracts))
    {
        return Err(err(format!("EXISTING_CONFLICT:{}", request.name)));
    }
    Ok(())
}

pub(crate) fn apply_import_result(
    envelope: &mut RuntimeDurableEnvelope,
    result: &JurisdictionImportResult,
    timestamp: u64,
) -> Result<(), JurisdictionImportError> {
    let name_key = result.name.trim().to_ascii_lowercase();
    let mut pending_request_value = None;
    {
        let entries = map_entries_mut(envelope.infrastructure_mut(), "pendingJurisdictionImports")?;
        for pair in entries.iter() {
            let pair = pair
                .as_array()
                .filter(|p| p.len() == 2)
                .ok_or_else(|| err("PENDING_PAIR"))?;
            let (id, hash, request) = pending_request(&pair[1])?;
            if id == result.import_id {
                if hash != result.request_hash {
                    return Err(err("RESULT_HASH_MISMATCH"));
                }
                pending_request_value = Some(request);
                break;
            }
        }
    }
    if pending_request_value.is_none() {
        if let Some(existing) = find_replica(envelope.j_replicas(), &name_key)? {
            return assert_replica_result(existing, result);
        }
        return Err(err(format!("RESULT_STALE:{}", hex32(&result.import_id))));
    }
    let request = pending_request_value.expect("checked");
    assert_result_matches_request(result, &request)?;
    if let Some(existing) = find_replica(envelope.j_replicas(), &name_key)? {
        assert_replica_result(existing, result)?;
    } else {
        for row in envelope
            .j_replicas()
            .as_array()
            .ok_or_else(|| err("J_REPLICAS_ARRAY"))?
        {
            let pair = row
                .as_array()
                .filter(|p| p.len() == 2)
                .ok_or_else(|| err("J_REPLICA_PAIR"))?;
            let existing = object(&pair[1], "J_REPLICA")?;
            if existing.get("chainId").and_then(Value::as_u64) == Some(result.chain_id)
                && existing
                    .get("contracts")
                    .and_then(Value::as_object)
                    .and_then(|v| v.get("depository"))
                    == Some(&Value::String(result.contracts.depository.clone()))
            {
                return Err(err("WATCHER_IDENTITY_CONFLICT"));
            }
        }
        let replica = json!({"blockDelayMs":300,"blockNumber":encode_biguint(&result.block_number),"chainId":result.chain_id,"contracts":encode_contracts(&result.contracts),"entityProviderDeploymentBlock":result.entity_provider_deployment_block,"lastBlockTimestamp":timestamp,"mempool":[],"name":result.name,"position":{"x":0,"y":50,"z":0},"rpcs":result.rpcs,"stateRoot":null,"tokenRegistry":encode_token_registry(&result.token_registry),"watcherConfirmationDepth":result.watcher_confirmation_depth});
        let replica = if let Some(ms) = result.block_time_ms {
            let mut row = replica.as_object().expect("object").clone();
            row.insert("blockTimeMs".into(), Value::Number(Number::from(ms)));
            Value::Object(row)
        } else {
            replica
        };
        envelope
            .j_replicas_mut()
            .as_array_mut()
            .ok_or_else(|| err("J_REPLICAS_ARRAY"))?
            .push(json!([result.name, replica]));
        envelope.invalidate_j_replicas_digest();
    }
    {
        let entries = map_entries_mut(envelope.infrastructure_mut(), "pendingJurisdictionImports")?;
        entries.retain(|pair| {
            pair.as_array()
                .and_then(|p| p.first())
                .and_then(Value::as_str)
                != Some(hex32(&result.import_id).as_str())
        });
    }
    envelope.invalidate_infrastructure_digest();
    if envelope.active_jurisdiction().is_empty() {
        envelope.set_active_jurisdiction(result.name.clone());
    }
    Ok(())
}

fn assert_result_matches_request(
    result: &JurisdictionImportResult,
    request: &JurisdictionImportRequest,
) -> Result<(), JurisdictionImportError> {
    let hash = request_hash(request)?;
    if result.import_id != hash
        || result.request_hash != hash
        || result.name != request.name
        || result.chain_id != request.chain_id
        || result.ticker != request.ticker
        || result.rpcs != request.rpcs
        || result.block_time_ms != request.block_time_ms
        || result.contracts != request.contracts
        || result.entity_provider_deployment_block != request.entity_provider_deployment_block
    {
        return Err(err("RESULT_INTENT_MISMATCH"));
    }
    Ok(())
}

fn assert_replica_result(
    value: &Value,
    result: &JurisdictionImportResult,
) -> Result<(), JurisdictionImportError> {
    let row = object(value, "EXISTING_RESULT")?;
    if row.get("blockNumber") != Some(&encode_biguint(&result.block_number))
        || row.get("watcherConfirmationDepth").and_then(Value::as_u64)
            != Some(result.watcher_confirmation_depth)
        || row.get("tokenRegistry") != Some(&encode_token_registry(&result.token_registry))
    {
        return Err(err("RESULT_EXISTING_CONFLICT"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_normalizes_to_typescript_hash() {
        let request=decode_import_request(&json!({"name":"Local","chainId":31337,"ticker":"LOC","rpcs":["http://127.0.0.1:8545/"],"entityProviderDeploymentBlock":1,"rpcPolicy":"single","contracts":{"depository":"0x1111111111111111111111111111111111111111","entityProvider":"0x2222222222222222222222222222222222222222","account":"0x3333333333333333333333333333333333333333","deltaTransformer":"0x4444444444444444444444444444444444444444"}})).expect("request");
        assert_eq!(encode_import_request(&request)["ticker"], "LOC");
        assert_eq!(
            hex32(&request_hash(&request).expect("hash")),
            "0x9fe2f50ff1c0877f6ff21fd868fea6d56977721571a8887873d4844c37f5b436"
        );
    }
}
