//! Zero-JS resident xln Runtime process.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use sha3::{Digest as _, Keccak256};
use xln_rscore_crypto::{address_of_private_key, derive_signer_key};
use xln_rscore_engine::{Side, TokenId};
use xln_rscore_entity_kernel::{BookSideLevel, ORDERBOOK_PRICE_SCALE, Side as OrderbookSide};
use xln_rscore_process::native_genesis::{
    NativeGenesisConfig, create_native_genesis_runtime_processor, native_store_is_pristine,
};
use xln_rscore_process::native_runtime::restore_native_runtime_processor;
use xln_rscore_process::runtime_http::{
    NativeOffchainFaucetRequest, RuntimeHttpCommand, RuntimeHttpServer, RuntimeHttpState,
    runtime_http_command_channel,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_canonical_consensus_bytes};
use xln_rscore_runtime::processor::{EntityRoute, EntityRouteTable};
use xln_rscore_runtime::transport::{DirectRuntimeIngress, DirectRuntimeIngressConfig};
use xln_rscore_runtime::{
    CanonicalEntityInfraMaterializer, ResidentRuntimeService, RuntimeEntityInput, RuntimeEntityKey,
    RuntimeEntityReplica, RuntimeEntityState, RuntimeReplica,
};

fn argument(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("RRS_RUNTIME_ARG_MISSING:{name}"))?;
    args.get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("RRS_RUNTIME_ARG_MISSING:{name}"))
}

fn optional_usize(args: &[String], name: &str, default: usize) -> Result<usize, String> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(default);
    };
    args.get(index + 1)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("RRS_RUNTIME_ARG_INVALID:{name}"))
}

fn digest_hex(value: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(66);
    encoded.push_str("0x");
    for byte in value {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn wall_clock_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "RRS_RUNTIME_LOCAL_COMMAND_CLOCK".to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "RRS_RUNTIME_LOCAL_COMMAND_CLOCK".to_string())
}

fn bytes_hex(value: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2 + 2);
    encoded.push_str("0x");
    for byte in value {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn parse_hex32(value: &str, field: &str) -> Result<[u8; 32], String> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .filter(|_| value == value.to_ascii_lowercase())
        .ok_or_else(|| format!("RRS_RUNTIME_{field}_FORMAT"))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("RRS_RUNTIME_{field}_FORMAT"))?;
    }
    Ok(output)
}

fn keccak(value: &[u8]) -> [u8; 32] {
    Keccak256::digest(value).into()
}

fn canonical_field<'a>(value: &'a CanonicalValue, field: &str) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find_map(|(name, value)| (name == field).then_some(value))
}

fn profile_jurisdiction(value: Option<&CanonicalValue>) -> Option<CanonicalValue> {
    let value = value?;
    let name = canonical_field(value, "name")?.clone();
    let chain_id = canonical_field(value, "chainId")?.clone();
    let depository = canonical_field(value, "depositoryAddress")?.clone();
    let provider = canonical_field(value, "entityProviderAddress")?.clone();
    Some(CanonicalValue::Object(vec![
        ("name".into(), name),
        ("chainId".into(), chain_id),
        ("depositoryAddress".into(), depository),
        ("entityProviderAddress".into(), provider),
    ]))
}

fn profile_swap_taker_fee_bps(hub_config: Option<&CanonicalValue>) -> Result<Option<u16>, String> {
    let Some(config) = hub_config else {
        return Ok(None);
    };
    let value = canonical_field(config, "swapTakerFeeBps")
        .ok_or_else(|| "RRS_RUNTIME_PROFILE_SWAP_TAKER_FEE_MISSING".to_string())?;
    let CanonicalValue::Number(value) = value else {
        return Err("RRS_RUNTIME_PROFILE_SWAP_TAKER_FEE_TYPE".into());
    };
    value
        .as_str()
        .parse::<u16>()
        .ok()
        .filter(|fee| *fee <= 10_000)
        .map(Some)
        .ok_or_else(|| "RRS_RUNTIME_PROFILE_SWAP_TAKER_FEE_RANGE".to_string())
}

fn entity_slot<'a>(
    replica: &'a RuntimeReplica,
    entity_key: &RuntimeEntityKey,
) -> Result<(&'a RuntimeEntityState, &'a RuntimeEntityReplica), String> {
    let state = replica.state.e_replicas.get(entity_key).ok_or_else(|| {
        format!(
            "RRS_RUNTIME_ENTITY_STATE_MISSING:{}",
            entity_key.replica_id()
        )
    })?;
    let live = replica.e_replicas.get(entity_key).ok_or_else(|| {
        format!(
            "RRS_RUNTIME_ENTITY_REPLICA_MISSING:{}",
            entity_key.replica_id()
        )
    })?;
    Ok((state, live))
}

fn native_profile(
    service: &ResidentRuntimeService,
    entity_key: &RuntimeEntityKey,
    routing_fee_ppm: u32,
    routing_base_fee: &num_bigint::BigInt,
) -> Result<Value, String> {
    let replica = service
        .processor()
        .replica()
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_REPLICA:{error}"))?;
    let (entity_state, entity_replica) = entity_slot(replica, entity_key)?;
    let entity = &entity_state.entity;
    let authority = &entity_replica.entity_consensus.state.authority.config;
    let jurisdiction = profile_jurisdiction(authority.jurisdiction.as_ref());
    let swap_taker_fee_bps = profile_swap_taker_fee_bps(entity.hub_rebalance_config.as_ref())?;
    let mut metadata = vec![
        ("isHub".into(), CanonicalValue::Bool(entity.profile.is_hub)),
        (
            "routingFeePPM".into(),
            CanonicalValue::Number(CanonicalNumber::from_u32(routing_fee_ppm)),
        ),
        (
            "baseFee".into(),
            CanonicalValue::BigInt(routing_base_fee.clone()),
        ),
    ];
    if let Some(kind) = &entity.profile.entity_kind {
        metadata.push(("entityKind".into(), CanonicalValue::String(kind.clone())));
    }
    if !entity.profile.sectors.is_empty() {
        metadata.push((
            "sectors".into(),
            CanonicalValue::Array(
                entity
                    .profile
                    .sectors
                    .iter()
                    .cloned()
                    .map(CanonicalValue::String)
                    .collect(),
            ),
        ));
    }
    if let Some(jurisdiction) = &jurisdiction {
        metadata.push(("jurisdiction".into(), jurisdiction.clone()));
    }
    if let Some(fee) = swap_taker_fee_bps {
        metadata.push((
            "swapTakerFeeBps".into(),
            CanonicalValue::Number(CanonicalNumber::from_u16(fee)),
        ));
    }
    let descriptor = CanonicalValue::Object(vec![
        (
            "entityId".into(),
            CanonicalValue::String(entity.entity_id.clone()),
        ),
        (
            "entityEncryptionPublicKey".into(),
            CanonicalValue::String(bytes_hex(&entity.entity_encryption_public_key)),
        ),
        (
            "name".into(),
            CanonicalValue::String(entity.profile.name.clone()),
        ),
        (
            "avatar".into(),
            CanonicalValue::String(entity.profile.avatar.clone()),
        ),
        (
            "bio".into(),
            CanonicalValue::String(entity.profile.bio.clone()),
        ),
        (
            "website".into(),
            CanonicalValue::String(entity.profile.website.clone()),
        ),
        ("publicAccounts".into(), CanonicalValue::Array(Vec::new())),
        ("accounts".into(), CanonicalValue::Array(Vec::new())),
        ("metadata".into(), CanonicalValue::Object(metadata)),
    ]);
    let descriptor_bytes = encode_canonical_consensus_bytes(&descriptor)
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_ENCODE:{error}"))?;
    let profile_digest = keccak(&descriptor_bytes);
    let last_updated = replica.state.timestamp.max(1);
    let runtime_id = service.runtime_id();
    let runtime_encryption_public_key = service.encryption_public_key();
    let ws_url = format!("ws://{}/ws", service.local_address());
    let route = serde_json::json!({
        "domain": "xln-profile-runtime-route-v1",
        "profileHash": bytes_hex(&profile_digest),
        "entityId": entity.entity_id,
        "runtimeId": runtime_id,
        "runtimeEncPubKey": runtime_encryption_public_key,
        "lastUpdated": last_updated,
        "wsUrl": ws_url,
        "relays": [],
        "mirrors": [],
    });
    let route_bytes = serde_json::to_vec(&route)
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_ROUTE_JSON:{error}"))?;
    let (hanko, route_signature) = entity_replica
        .entity_signer
        .sign_public_projection(&profile_digest, &keccak(&route_bytes))
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_SIGN:{error}"))?;
    let jurisdiction_json = jurisdiction
        .as_ref()
        .map(xln_rscore_runtime::tagged_json_from_canonical_value)
        .transpose()
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_JURISDICTION:{error}"))?;
    let mut profile_metadata = serde_json::json!({
        "isHub": entity.profile.is_hub,
        "routingFeePPM": routing_fee_ppm,
        "baseFee": {"__xlnType":"BigInt","value":routing_base_fee.to_string()},
        "profileHanko": bytes_hex(&hanko),
    });
    let profile_metadata = profile_metadata
        .as_object_mut()
        .ok_or_else(|| "RRS_RUNTIME_PROFILE_METADATA".to_string())?;
    if let Some(kind) = &entity.profile.entity_kind {
        profile_metadata.insert("entityKind".into(), Value::String(kind.clone()));
    }
    if !entity.profile.sectors.is_empty() {
        profile_metadata.insert(
            "sectors".into(),
            Value::Array(
                entity
                    .profile
                    .sectors
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    if let Some(jurisdiction) = jurisdiction_json {
        profile_metadata.insert("jurisdiction".into(), jurisdiction);
    }
    if let Some(fee) = swap_taker_fee_bps {
        profile_metadata.insert("swapTakerFeeBps".into(), Value::from(fee));
    }
    Ok(serde_json::json!({
        "entityId": entity.entity_id,
        "entityEncryptionPublicKey": bytes_hex(&entity.entity_encryption_public_key),
        "name": entity.profile.name,
        "avatar": entity.profile.avatar,
        "bio": entity.profile.bio,
        "website": entity.profile.website,
        "lastUpdated": last_updated,
        "runtimeId": runtime_id,
        "runtimeEncPubKey": runtime_encryption_public_key,
        "runtimeSignature": bytes_hex(&route_signature),
        "publicAccounts": [],
        "wsUrl": ws_url,
        "relays": [],
        "metadata": profile_metadata,
        "accounts": [],
    }))
}

fn native_account_status(
    service: &mut ResidentRuntimeService,
    hub_entity_id: [u8; 32],
    local_signer_id: &str,
    hub_entity_id_text: &str,
    counterparty: xln_rscore_batch::AccountId,
    counterparty_text: &str,
    token_ids: Vec<TokenId>,
) -> Result<Value, String> {
    let hub_entity_key = RuntimeEntityKey::new(hub_entity_id, local_signer_id)
        .map_err(|error| format!("RRS_RUNTIME_ACCOUNT_STATUS_KEY:{error}"))?;
    let (height, timestamp, owns_entity) = {
        let replica = service
            .processor()
            .replica()
            .map_err(|error| format!("RRS_RUNTIME_ACCOUNT_STATUS_REPLICA:{error}"))?;
        (
            replica.state.height,
            replica.state.timestamp,
            replica.e_replicas.contains_key(&hub_entity_key),
        )
    };
    let status = if owns_entity {
        service
            .account_status(&hub_entity_key, counterparty, token_ids.clone())
            .map_err(|error| format!("RRS_RUNTIME_ACCOUNT_STATUS:{error}"))?
    } else {
        None
    };
    let tokens = token_ids
        .into_iter()
        .map(|token_id| {
            let delta = status
                .as_ref()
                .and_then(|status| status.tokens.get(&token_id))
                .and_then(Option::as_ref);
            let encoded_delta = delta.map(|delta| {
                serde_json::json!({
                    "collateral": delta.collateral().to_string(),
                    "ondelta": delta.ondelta().to_string(),
                    "offdelta": delta.offdelta().to_string(),
                    "leftCreditLimit": delta.left_credit_limit().to_string(),
                    "rightCreditLimit": delta.right_credit_limit().to_string(),
                    "leftHold": delta.hold(Side::Left).to_string(),
                    "rightHold": delta.hold(Side::Right).to_string(),
                })
            });
            serde_json::json!({
                "tokenId": u32::from(token_id.get()),
                "hasDelta": delta.is_some(),
                "hubGranted": status
                    .as_ref()
                    .and_then(|status| status.owner_peer_credit_limit.get(&token_id))
                    .map_or_else(|| "0".to_string(), ToString::to_string),
                "peerGranted": status
                    .as_ref()
                    .and_then(|status| status.owner_own_credit_limit.get(&token_id))
                    .map_or_else(|| "0".to_string(), ToString::to_string),
                "hubOutCapacity": status
                    .as_ref()
                    .and_then(|status| status.owner_out_capacity.get(&token_id))
                    .map_or_else(|| "0".to_string(), ToString::to_string),
                "delta": encoded_delta,
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "success": true,
        "hubEntityId": hub_entity_id_text,
        "counterpartyEntityId": counterparty_text,
        "hasAccount": status.is_some(),
        "status": status.as_ref().map_or("missing", |status| status.status.as_str()),
        "ready": status.as_ref().is_some_and(|status| {
            status.active
                && status.current_height > 0
                && status.pending_frame_height.is_none()
                && status.mempool_len == 0
        }),
        "currentHeight": status.as_ref().map_or(0, |status| status.current_height),
        "pendingFrameHeight": status.as_ref().and_then(|status| status.pending_frame_height),
        "mempool": status.as_ref().map_or(0, |status| status.mempool_len),
        "disputeObservedOnChain": status.as_ref().is_some_and(|status| status.dispute_observed_on_chain),
        "disputeObservedBlockNumber": status.as_ref().and_then(|status| status.dispute_observed_block_number),
        "settlementWorkspaceHash": status.as_ref().and_then(|status| status.settlement_workspace_hash.as_deref()),
        "settlementWorkspaceStatus": status.as_ref().and_then(|status| status.settlement_workspace_status.as_deref()),
        "jNonce": status.as_ref().map_or(0, |status| status.j_nonce),
        "tokens": tokens,
        "runtime": {
            "height": height,
            "timestamp": timestamp,
        },
    }))
}

fn native_market_slot<'a>(
    service: &'a ResidentRuntimeService,
    hub_entity_id: [u8; 32],
    local_signer_id: &str,
) -> Result<(&'a RuntimeEntityState, &'a RuntimeEntityReplica), String> {
    let entity_key = RuntimeEntityKey::new(hub_entity_id, local_signer_id)
        .map_err(|error| format!("RRS_RUNTIME_MARKET_KEY:{error}"))?;
    let replica = service
        .processor()
        .replica()
        .map_err(|error| format!("RRS_RUNTIME_MARKET_REPLICA:{error}"))?;
    entity_slot(replica, &entity_key)
}

fn canonical_string<'a>(value: &'a CanonicalValue, field: &str) -> Result<&'a str, String> {
    match canonical_field(value, field) {
        Some(CanonicalValue::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(format!("RRS_RUNTIME_MARKET_JURISDICTION_{field}")),
    }
}

fn canonical_u64(value: &CanonicalValue, field: &str) -> Result<u64, String> {
    match canonical_field(value, field) {
        Some(CanonicalValue::Number(value)) => value
            .as_str()
            .parse::<u64>()
            .map_err(|_| format!("RRS_RUNTIME_MARKET_JURISDICTION_{field}")),
        _ => Err(format!("RRS_RUNTIME_MARKET_JURISDICTION_{field}")),
    }
}

fn market_jurisdiction(entity_replica: &RuntimeEntityReplica) -> Result<(String, String), String> {
    let jurisdiction = entity_replica
        .entity_consensus
        .state
        .authority
        .config
        .jurisdiction
        .as_ref()
        .ok_or_else(|| "RRS_RUNTIME_MARKET_JURISDICTION_MISSING".to_string())?;
    let name = canonical_string(jurisdiction, "name")?.to_string();
    let chain_id = canonical_u64(jurisdiction, "chainId")?;
    let depository = canonical_string(jurisdiction, "depositoryAddress")?.to_ascii_lowercase();
    Ok((name, format!("stack:{chain_id}:{depository}")))
}

fn certified_entity_hash(entity_replica: &RuntimeEntityReplica) -> Option<&str> {
    entity_replica
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .map(|head| head.frame.hash.as_str())
}

fn native_market_catalog(
    service: &ResidentRuntimeService,
    local_signer_id: &str,
    hub_entity_id: [u8; 32],
    hub_entity_id_text: &str,
) -> Result<Value, String> {
    let (entity_state, entity_replica) =
        native_market_slot(service, hub_entity_id, local_signer_id)?;
    let (_, jurisdiction_ref) = market_jurisdiction(entity_replica)?;
    let pair_ids = entity_state
        .entity
        .orderbook
        .as_ref()
        .map(|orderbook| orderbook.books.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "format":"market-pair-catalog",
        "hubEntityId":hub_entity_id_text,
        "jurisdictionRef":jurisdiction_ref,
        "pairIds":pair_ids,
        "entityHeight":entity_state.entity.height,
        "entityStateHash":certified_entity_hash(entity_replica),
        "updatedAt":wall_clock_ms()?,
    }))
}

fn market_levels(levels: Vec<BookSideLevel>) -> Vec<Value> {
    let mut running = num_bigint::BigInt::from(0_u8);
    levels
        .into_iter()
        .map(|level| {
            running += &level.qty_lots;
            serde_json::json!({
                "price":level.price_ticks.to_string(),
                "size":level.qty_lots.to_string(),
                "total":running.to_string(),
                "orderCount":level.order_ids.len(),
                "ownerIds":level.owner_ids,
                "orderIds":level.order_ids,
            })
        })
        .collect()
}

fn market_spread_percent(spread: &num_bigint::BigInt, ask: &num_bigint::BigInt) -> String {
    let numerator = spread.to_string().parse::<f64>().unwrap_or(f64::NAN);
    let denominator = ask.to_string().parse::<f64>().unwrap_or(f64::NAN);
    if !numerator.is_finite() || !denominator.is_finite() || numerator <= 0.0 || denominator <= 0.0
    {
        "-".to_string()
    } else {
        format!("{:.3}", numerator / denominator * 100.0)
    }
}

fn native_market_snapshots(
    service: &ResidentRuntimeService,
    local_signer_id: &str,
    hub_entity_id: [u8; 32],
    hub_entity_id_text: &str,
    pair_ids: &[String],
    depth: usize,
) -> Result<Value, String> {
    let (entity_state, entity_replica) =
        native_market_slot(service, hub_entity_id, local_signer_id)?;
    let (_, jurisdiction_ref) = market_jurisdiction(entity_replica)?;
    let orderbook = entity_state.entity.orderbook.as_ref();
    let updated_at = wall_clock_ms()?;
    let snapshots = pair_ids
        .iter()
        .map(|pair_id| {
            let book = orderbook.and_then(|orderbook| orderbook.books.get(pair_id));
            let bid_rows = book
                .map(|book| book.side_levels(OrderbookSide::Bid, depth))
                .transpose()
                .map_err(|error| format!("RRS_RUNTIME_MARKET_LEVELS:{error}"))?
                .unwrap_or_default();
            let ask_rows = book
                .map(|book| book.side_levels(OrderbookSide::Ask, depth))
                .transpose()
                .map_err(|error| format!("RRS_RUNTIME_MARKET_LEVELS:{error}"))?
                .unwrap_or_default();
            let best_bid = bid_rows.first().map(|level| &level.price_ticks);
            let best_ask = ask_rows.first().map(|level| &level.price_ticks);
            let spread = best_bid.zip(best_ask).map(|(bid, ask)| ask - bid);
            let spread_percent = spread
                .as_ref()
                .zip(best_ask)
                .map_or_else(|| "-".to_string(), |(spread, ask)| market_spread_percent(spread, ask));
            Ok(serde_json::json!({
                "format":"exact-price-levels",
                "hubEntityId":hub_entity_id_text,
                "jurisdictionRef":jurisdiction_ref.as_str(),
                "pairId":pair_id,
                "depth":depth,
                "displayDecimals":4,
                "priceScale":ORDERBOOK_PRICE_SCALE.to_string(),
                "bucketWidthTicks":book.map(|book| book.bucket_width_ticks.to_string()),
                "bids":market_levels(bid_rows),
                "asks":market_levels(ask_rows),
                "spread":spread.map(|value| value.to_string()),
                "spreadPercent":spread_percent,
                "lastTradePrice":book.and_then(|book| (book.trade_count > 0 && book.last_trade_price_ticks > num_bigint::BigInt::from(0_u8)).then(|| book.last_trade_price_ticks.to_string())),
                "tradeCount":book.map_or(0, |book| book.trade_count),
                "source":"orderbookExt",
                "entityHeight":entity_state.entity.height,
                "entityStateHash":certified_entity_hash(entity_replica),
                "hubUpdatedAt":entity_state.entity.timestamp,
                "updatedAt":updated_at,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(serde_json::json!({
        "hubEntityId":hub_entity_id_text,
        "depth":depth,
        "snapshots":snapshots,
    }))
}

fn native_market_tokens(service: &ResidentRuntimeService) -> Result<Value, String> {
    let replica = service
        .processor()
        .replica()
        .map_err(|error| format!("RRS_RUNTIME_MARKET_REPLICA:{error}"))?;
    let wanted = replica.durable.active_jurisdiction();
    let rows = replica
        .durable
        .j_replicas()
        .as_array()
        .ok_or_else(|| "RRS_RUNTIME_MARKET_J_REPLICAS".to_string())?;
    let row = rows
        .iter()
        .find_map(|row| {
            let row = row.as_array().filter(|row| row.len() == 2)?;
            (row[0].as_str()? == wanted).then_some(&row[1])
        })
        .ok_or_else(|| format!("RRS_RUNTIME_MARKET_JURISDICTION_UNKNOWN:{wanted}"))?;
    let tokens = row
        .get("tokenRegistry")
        .and_then(Value::as_array)
        .ok_or_else(|| "RRS_RUNTIME_MARKET_TOKEN_REGISTRY".to_string())?;
    Ok(serde_json::json!({"tokens":tokens}))
}

fn native_token_decimals(
    replica: &RuntimeReplica,
    jurisdiction_name: &str,
    token_id: TokenId,
) -> Result<u32, String> {
    let rows = replica
        .durable
        .j_replicas()
        .as_array()
        .ok_or_else(|| "RRS_RUNTIME_FAUCET_J_REPLICAS".to_string())?;
    let tokens = rows
        .iter()
        .find_map(|row| {
            let row = row.as_array().filter(|row| row.len() == 2)?;
            (row[0].as_str()? == jurisdiction_name)
                .then(|| row[1].get("tokenRegistry").and_then(Value::as_array))
                .flatten()
        })
        .ok_or_else(|| format!("RRS_RUNTIME_FAUCET_JURISDICTION:{jurisdiction_name}"))?;
    tokens
        .iter()
        .find_map(|token| {
            (token.get("tokenId").and_then(Value::as_u64) == Some(u64::from(token_id.get())))
                .then(|| token.get("decimals").and_then(Value::as_u64))
                .flatten()
        })
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= 255)
        .ok_or_else(|| format!("RRS_RUNTIME_FAUCET_TOKEN:{}", token_id.get()))
}

fn parse_token_amount(value: &str, decimals: u32) -> Result<num_bigint::BigInt, String> {
    let value = value.trim();
    let (whole, fraction) = value.split_once('.').map_or((value, ""), |parts| parts);
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > decimals as usize
    {
        return Err("FAUCET_AMOUNT_INVALID".into());
    }
    let whole = whole
        .parse::<num_bigint::BigInt>()
        .map_err(|_| "FAUCET_AMOUNT_INVALID".to_string())?;
    let scale = num_bigint::BigInt::from(10_u8).pow(decimals);
    let fraction = if fraction.is_empty() {
        num_bigint::BigInt::from(0_u8)
    } else {
        let value = fraction
            .parse::<num_bigint::BigInt>()
            .map_err(|_| "FAUCET_AMOUNT_INVALID".to_string())?;
        value * num_bigint::BigInt::from(10_u8).pow(decimals - fraction.len() as u32)
    };
    let amount = whole * scale + fraction;
    (amount > num_bigint::BigInt::from(0_u8))
        .then_some(amount)
        .ok_or_else(|| "FAUCET_AMOUNT_INVALID".to_string())
}

fn faucet_policy_description(
    config: Option<&CanonicalValue>,
    token_decimals: u32,
) -> Result<String, String> {
    let policy_version = config
        .and_then(|value| canonical_field(value, "policyVersion"))
        .and_then(|value| match value {
            CanonicalValue::Number(value) => value.as_str().parse::<u64>().ok(),
            _ => None,
        })
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let liquidity_fee = config
        .and_then(|value| canonical_field(value, "rebalanceLiquidityFeeBps"))
        .and_then(|value| match value {
            CanonicalValue::BigInt(value) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "1".to_string());
    if token_decimals == 0 {
        return Err("FAUCET_TOKEN_AMOUNT_PRECISION".into());
    }
    let base_fee = num_bigint::BigInt::from(10_u8).pow(token_decimals - 1);
    Ok(format!(
        "rebalance-policy:reason=faucet-offchain;v={policy_version};base={base_fee};liq={liquidity_fee};gas=0"
    ))
}

fn faucet_failure(status: u16, code: &str, error: impl Into<String>) -> (u16, Value) {
    (
        status,
        serde_json::json!({"success":false,"code":code,"error":error.into()}),
    )
}

fn native_offchain_faucet(
    service: &mut ResidentRuntimeService,
    local_signer_id: &str,
    request: NativeOffchainFaucetRequest,
) -> Result<(u16, Value), String> {
    let entity_key = RuntimeEntityKey::new(request.hub_entity_id, local_signer_id)
        .map_err(|error| format!("RRS_RUNTIME_FAUCET_KEY:{error}"))?;
    let (token_decimals, description, runtime_height) = {
        let replica = service
            .processor()
            .replica()
            .map_err(|error| format!("RRS_RUNTIME_FAUCET_REPLICA:{error}"))?;
        let Some(entity_state) = replica.state.e_replicas.get(&entity_key) else {
            return Ok(faucet_failure(
                404,
                "FAUCET_REQUESTED_HUB_NOT_FOUND",
                format!("Requested hub not found: {}", request.hub_entity_id_text),
            ));
        };
        let entity_replica = replica
            .e_replicas
            .get(&entity_key)
            .ok_or_else(|| "RRS_RUNTIME_FAUCET_ENTITY_REPLICA".to_string())?;
        let (jurisdiction_name, _) = market_jurisdiction(entity_replica)?;
        let decimals = native_token_decimals(replica, &jurisdiction_name, request.token_id)?;
        (
            decimals,
            faucet_policy_description(entity_state.entity.hub_rebalance_config.as_ref(), decimals)?,
            replica.state.height,
        )
    };
    let amount = match parse_token_amount(&request.amount, token_decimals) {
        Ok(amount) => amount,
        Err(_) => {
            return Ok(faucet_failure(
                400,
                "FAUCET_INVALID_AMOUNT",
                format!("Invalid amount: {}", request.amount),
            ));
        }
    };
    let status = service
        .account_status(&entity_key, request.user_entity_id, vec![request.token_id])
        .map_err(|error| format!("RRS_RUNTIME_FAUCET_ACCOUNT:{error}"))?;
    let Some(status) = status else {
        return Ok(faucet_failure(
            409,
            "FAUCET_ACCOUNT_NOT_OPEN",
            "No bilateral account with selected hub. Open account first, then retry faucet.",
        ));
    };
    let settled = status.current_height > 0
        && status.pending_frame_height.is_none()
        && status.mempool_len == 0;
    let out_capacity = status
        .owner_out_capacity
        .get(&request.token_id)
        .cloned()
        .unwrap_or_else(|| num_bigint::BigInt::from(0_u8));
    if settled && out_capacity < amount {
        return Ok(faucet_failure(
            409,
            "FAUCET_INSUFFICIENT_OUT_CAPACITY",
            "Selected hub does not have enough outbound capacity for offchain faucet.",
        ));
    }
    let input = RuntimeEntityInput::decode(serde_json::json!({
        "entityId":request.hub_entity_id_text,
        "signerId":local_signer_id,
        "entityTxs":[{
            "type":"directPayment",
            "data":{
                "targetEntityId":request.user_entity_id_text,
                "tokenId":u32::from(request.token_id.get()),
                "amount":{"__xlnType":"BigInt","value":amount.to_string()},
                "route":[request.hub_entity_id_text,request.user_entity_id_text],
                "description":description,
                "deliveryMode":"direct"
            }
        }]
    }))
    .map_err(|error| format!("RRS_RUNTIME_FAUCET_INPUT:{error}"))?;
    let report = service
        .process_local_entity_inputs_at(vec![input], wall_clock_ms()?)
        .map_err(|error| format!("RRS_RUNTIME_FAUCET_APPLY:{error}"))?
        .ok_or_else(|| "RRS_RUNTIME_FAUCET_IDLE".to_string())?;
    let committed_height = report
        .commitments
        .as_ref()
        .map(|commitments| commitments.height)
        .ok_or_else(|| "RRS_RUNTIME_FAUCET_COMMITMENT".to_string())?;
    service
        .sync_committed()
        .map_err(|error| format!("RRS_RUNTIME_FAUCET_COMMIT:{error}"))?;
    let request_id = format!(
        "offchain_{}_{}",
        runtime_height.saturating_add(1),
        &request.user_runtime_id[2..10]
    );
    Ok((
        200,
        serde_json::json!({
            "success":true,
            "type":"offchain",
            "status":"queued",
            "requestId":request_id,
            "amount":request.amount,
            "tokenId":u32::from(request.token_id.get()),
            "from":format!("{}...", &request.hub_entity_id_text[..16]),
            "to":format!("{}...", &request.user_entity_id_text[..16]),
            "accountReady":settled,
            "accountState":{
                "exists":true,
                "currentHeight":status.current_height,
                "pendingFrameHeight":status.pending_frame_height,
                "mempool":status.mempool_len,
                "settledCapacitySnapshot":settled
            },
            "senderOutCapacity":out_capacity.to_string(),
            "committedHeight":committed_height
        }),
    ))
}

fn http_snapshot(
    service: &ResidentRuntimeService,
    primary_entity_key: &RuntimeEntityKey,
    name: &str,
    api_address: SocketAddr,
    metrics: Value,
) -> Result<Value, String> {
    let replica = service
        .processor()
        .replica()
        .map_err(|error| format!("RRS_RUNTIME_HTTP_REPLICA:{error}"))?;
    let peers = service
        .open_runtime_ids()
        .map_err(|error| format!("RRS_RUNTIME_HTTP_PEERS:{error}"))?;
    let runtime_id = service.runtime_id();
    let (entity_state, entity_replica) = entity_slot(replica, primary_entity_key)?;
    let entity_id = &entity_state.entity.entity_id;
    let hub_entities = replica
        .state
        .e_replicas
        .iter()
        .map(|(key, state)| {
            let live = replica.e_replicas.get(key).ok_or_else(|| {
                format!("RRS_RUNTIME_ENTITY_REPLICA_MISSING:{}", key.replica_id())
            })?;
            Ok(serde_json::json!({
                "entityId": state.entity.entity_id,
                "signerId": live.signer_id,
                "name": state.entity.profile.name,
                "primary": key == primary_entity_key,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let direct_peers = peers
        .iter()
        .map(|peer| {
            serde_json::json!({
                "runtimeId": peer,
                "endpoint": "authenticated-inbound",
                "open": true,
            })
        })
        .collect::<Vec<_>>();
    let committed_reserves = entity_state
        .entity
        .reserves
        .iter()
        .map(|(token_id, current)| {
            serde_json::json!({
                "tokenId": u32::from(*token_id),
                "current": current.to_string(),
            })
        })
        .collect::<Vec<_>>();
    let bootstrap_reserves_ready = entity_state.entity.reserves.len() >= 3
        && entity_state
            .entity
            .reserves
            .values()
            .all(|current| current > &num_bigint::BigInt::from(0_u8));
    let orderbook_min_trade_size = entity_state.entity.orderbook_metadata.as_ref().map_or_else(
        || "0".to_string(),
        |metadata| metadata.hub_profile.min_trade_size.to_string(),
    );
    Ok(serde_json::json!({
        "info": {
            "name": name,
            "entityId": entity_id,
            "hubEntities": hub_entities,
            "runtimeId": runtime_id,
            "apiUrl": format!("http://{api_address}"),
            "directWsUrl": format!("ws://{}/ws", service.local_address()),
            "workers": entity_replica.accounts.worker_count(),
            "minFrameDelayMs": service.min_frame_delay_ms()
                .map_err(|error| format!("RRS_RUNTIME_FRAME_INTERVAL:{error}"))?,
            "height": replica.state.height,
            "runtimeFrameHash": digest_hex(&replica.durable.prev_frame_hash()),
            "accountsRoot": digest_hex(&entity_state.accounts_root),
            "orderbookMinTradeSize": orderbook_min_trade_size,
            "storage": {"persistencePaused": false},
        },
        "health": {
            "ok": true,
            "name": name,
            "height": replica.state.height,
            "entityId": entity_id,
            "runtimeId": runtime_id,
            "directWsUrl": format!("ws://{}/ws", service.local_address()),
            "runtime": {
                "halted": false,
                "lifecyclePhase": "ready",
            },
            "quiescence": {
                "ready": service.publication_backlog().rows == 0,
                "pendingNetworkOutputs": service.publication_backlog().rows,
            },
            "p2p": {"directPeers": direct_peers},
            // These gates remain false until the native bootstrap producer has
            // committed the corresponding Account/J state. Socket presence is
            // not financial readiness.
            "gossip": {"ready": false, "visibleHubNames": [], "visibleHubIds": []},
            "mesh": {"ready": false, "pairs": []},
            "bootstrapReserves": {
                "ok": bootstrap_reserves_ready,
                "targetMet": bootstrap_reserves_ready,
                "tokens": committed_reserves,
            },
        },
        "metrics": metrics,
    }))
}

fn extend_json_object(
    target: &mut Map<String, Value>,
    value: Value,
    label: &str,
) -> Result<(), String> {
    let Value::Object(fields) = value else {
        return Err(format!("RRS_RUNTIME_METRIC_OBJECT:{label}"));
    };
    target.extend(fields);
    Ok(())
}

fn account_phase_metric_value(
    metric: &xln_rscore_batch::AccountPhaseMetric,
) -> Result<Value, String> {
    let mut object = Map::new();
    extend_json_object(
        &mut object,
        serde_json::json!({
            "kind": match metric.kind {
                xln_rscore_batch::AccountPhaseKind::Inbound => "inbound",
                xln_rscore_batch::AccountPhaseKind::OutboundReset => "outboundReset",
                xln_rscore_batch::AccountPhaseKind::OutboundFailedHtlcFollowup => {
                    "outboundFailedHtlcFollowup"
                }
                xln_rscore_batch::AccountPhaseKind::OutboundSettlementHankoAttach => {
                    "outboundSettlementHankoAttach"
                }
            },
            "invocations": metric.invocations,
            "coordinatorWallMicros": metric.coordinator_wall_nanos / 1_000,
            "coordinatorPreDispatchMicros": metric.coordinator_pre_dispatch_nanos / 1_000,
            "runLanesWallMicros": metric.run_lanes_wall_nanos / 1_000,
            "coordinatorPostJoinMicros": metric.coordinator_post_join_nanos / 1_000,
            "workerSamples": metric.worker_samples,
            "workerWorkSumMicros": metric.worker_work_sum_nanos / 1_000,
            "workerCriticalPathMicros": metric.worker_critical_path_nanos / 1_000,
            "workerPhaseSpanMicros": metric.worker_phase_span_nanos / 1_000,
            "coordinatorDispatchJoinMicros": metric.coordinator_dispatch_join_nanos / 1_000,
            "workerBarrierWaitSumMicros": metric.worker_barrier_wait_sum_nanos / 1_000,
            "workerRows": &metric.worker_rows,
            "workerWorkNanos": &metric.worker_work_nanos,
        }),
        "accountPhaseTiming",
    )?;
    extend_json_object(
        &mut object,
        serde_json::json!({
            "coordinatorFoldMicros": metric.coordinator_fold_nanos / 1_000,
            "touchedRows": metric.touched_rows,
            "touchedShards": metric.touched_shards,
            "workersWithWork": metric.workers_with_work,
            "shardHandleClones": metric.shard_handle_clones,
            "candidateBaseReads": metric.candidate_base_reads,
            "continuationRounds": metric.continuation_rounds,
            "restartRounds": metric.restart_rounds,
        }),
        "accountPhaseWork",
    )?;
    extend_json_object(
        &mut object,
        serde_json::json!({
            "ecdsaRecoveryCalls": metric.ecdsa_recovery_calls,
            "ecdsaRecoveryExactRepeats": metric.ecdsa_recovery_exact_repeats,
            "ecdsaRecoveryMicros": metric.ecdsa_recovery_wall_nanos / 1_000,
            "workerEcdsaRecoveryCalls": &metric.worker_ecdsa_recovery_calls,
            "workerEcdsaRecoveryExactRepeats": &metric.worker_ecdsa_recovery_exact_repeats,
            "workerEcdsaRecoveryNanos": &metric.worker_ecdsa_recovery_wall_nanos,
        }),
        "accountPhaseCrypto",
    )?;
    Ok(Value::Object(object))
}

fn optional_url(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, String> {
    match object.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(format!("RRS_RUNTIME_ROUTE_FIELD:{field}")),
    }
}

fn text<'a>(object: &'a serde_json::Map<String, Value>, field: &str) -> Result<&'a str, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("RRS_RUNTIME_ROUTE_FIELD:{field}"))
}

fn routes(path: &Path) -> Result<EntityRouteTable, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("RRS_RUNTIME_ROUTES_READ:{error}"))?;
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("RRS_RUNTIME_ROUTES_JSON:{error}"))?;
    let rows = value
        .as_array()
        .ok_or_else(|| "RRS_RUNTIME_ROUTES_ARRAY".to_string())?;
    let mut routes = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let object = row
            .as_object()
            .ok_or_else(|| format!("RRS_RUNTIME_ROUTE_OBJECT:{index}"))?;
        if object.len() != 4
            || ![
                "targetEntityId",
                "targetRuntimeId",
                "targetSignerId",
                "websocketUrl",
            ]
            .iter()
            .all(|field| object.contains_key(*field))
        {
            return Err(format!("RRS_RUNTIME_ROUTE_FIELDS:{index}"));
        }
        routes.push(EntityRoute {
            target_entity_id: text(object, "targetEntityId")?.into(),
            target_runtime_id: text(object, "targetRuntimeId")?.into(),
            target_signer_id: text(object, "targetSignerId")?.into(),
            websocket_url: optional_url(object, "websocketUrl")?,
        });
    }
    EntityRouteTable::new(routes).map_err(|error| format!("RRS_RUNTIME_ROUTES:{error}"))
}

fn secret_key(path: &Path) -> Result<[u8; 32], String> {
    let value = std::fs::read_to_string(path)
        .map_err(|error| format!("RRS_RUNTIME_HTLC_SECRET_READ:{error}"))?;
    let value = value.trim();
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .filter(|_| value == value.to_ascii_lowercase())
        .ok_or_else(|| "RRS_RUNTIME_HTLC_SECRET_FORMAT".to_string())?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| "RRS_RUNTIME_HTLC_SECRET_FORMAT".to_string())?;
    }
    Ok(output)
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let native_database = PathBuf::from(argument(&args, "--native-db")?);
    let runtime_seed_file = PathBuf::from(argument(&args, "--runtime-seed-file")?);
    let entity_encryption_private_key = secret_key(&PathBuf::from(argument(
        &args,
        "--entity-encryption-private-key-file",
    )?))?;
    let runtime_signer_label = argument(&args, "--runtime-signer-label")?;
    let entity_signer_label = argument(&args, "--entity-signer-label")?;
    let primary_entity_id = parse_hex32(
        &argument(&args, "--primary-entity-id")?,
        "PRIMARY_ENTITY_ID",
    )?;
    let name = argument(&args, "--name")?;
    let api_address = argument(&args, "--api-bind")?
        .parse::<SocketAddr>()
        .map_err(|error| format!("RRS_RUNTIME_API_BIND:{error}"))?;
    let bind_address = argument(&args, "--bind")?
        .parse::<SocketAddr>()
        .map_err(|error| format!("RRS_RUNTIME_BIND:{error}"))?;
    let route_table = routes(&PathBuf::from(argument(&args, "--routes")?))?;
    let workers = optional_usize(&args, "--workers", 8)?;
    let frame_wait_ms = optional_usize(&args, "--frame-wait-ms", 1)?;
    let metrics_ms = optional_usize(&args, "--metrics-ms", 1_000)?;
    let runtime_seed = std::fs::read_to_string(runtime_seed_file)
        .map_err(|error| format!("RRS_RUNTIME_SEED_READ:{error}"))?;
    let runtime_seed = runtime_seed.trim();
    if runtime_seed.is_empty() {
        return Err("RRS_RUNTIME_SEED_EMPTY".into());
    }
    let entity_signer_key = derive_signer_key(runtime_seed, &entity_signer_label)
        .map_err(|error| format!("RRS_RUNTIME_ENTITY_SIGNER_KEY:{error}"))?;
    let local_entity_signer_id = bytes_hex(
        &address_of_private_key(&entity_signer_key)
            .ok_or_else(|| "RRS_RUNTIME_ENTITY_SIGNER_ADDRESS".to_string())?,
    );
    let primary_entity_key = RuntimeEntityKey::new(primary_entity_id, &local_entity_signer_id)
        .map_err(|error| format!("RRS_RUNTIME_PRIMARY_ENTITY_KEY:{error}"))?;

    if args.iter().any(|value| value == "--offline-ts-import") {
        return Err("RRS_RUNTIME_OFFLINE_TS_IMPORT_FORBIDDEN".into());
    }
    let ready = if native_store_is_pristine(&native_database)? {
        let genesis_path = PathBuf::from(argument(&args, "--genesis-config")?);
        create_native_genesis_runtime_processor(
            native_database,
            NativeGenesisConfig::read(genesis_path)?,
            runtime_seed,
            &runtime_signer_label,
            &entity_signer_label,
            workers,
            route_table,
        )?
    } else {
        restore_native_runtime_processor(
            native_database,
            runtime_seed,
            &runtime_signer_label,
            &entity_signer_label,
            workers,
            route_table,
            None,
        )?
    };
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        bind_address,
        runtime_seed,
        &runtime_signer_label,
    ))
    .map_err(|error| format!("RRS_RUNTIME_INGRESS:{error}"))?;
    let entity_encryption_public_key = {
        let replica = ready
            .processor
            .replica()
            .map_err(|error| format!("RRS_RUNTIME_ENTITY_KEY_REPLICA:{error}"))?;
        entity_slot(replica, &primary_entity_key)?
            .0
            .entity
            .entity_encryption_public_key
    };
    let profile_routing_fee_ppm = ready.htlc_routing_fee_ppm;
    let profile_routing_base_fee = ready.htlc_routing_base_fee.clone();
    let materializer = CanonicalEntityInfraMaterializer::with_inbound_htlc(
        xln_rscore_runtime::InboundHtlcInfrastructure {
            entity_encryption_public_key,
            entity_encryption_private_key,
            routing_fee_ppm: ready.htlc_routing_fee_ppm,
            routing_base_fee: ready.htlc_routing_base_fee,
        },
    )
    .map_err(|error| format!("RRS_RUNTIME_HTLC_INFRA:{error}"))?;
    let restore_micros = ready.restore_elapsed.as_micros();
    let restored_frames = ready.restored_wal_frames;
    let mut service = ResidentRuntimeService::new_with_j_submit_key(
        ready.processor,
        ingress,
        Box::new(materializer),
        entity_signer_key,
    )
    .map_err(|error| format!("RRS_RUNTIME_SERVICE:{error}"))?;
    let (http_command_sender, http_commands) = runtime_http_command_channel();
    let http_state = RuntimeHttpState::with_commands(
        http_snapshot(
            &service,
            &primary_entity_key,
            &name,
            api_address,
            serde_json::json!({}),
        )?,
        http_command_sender,
    )?;
    let http = RuntimeHttpServer::bind(api_address, http_state.clone())?;
    let restored = service
        .processor()
        .replica()
        .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
    let (restored_entity, _) = entity_slot(restored, &primary_entity_key)?;
    let min_frame_delay_ms = service
        .min_frame_delay_ms()
        .map_err(|error| format!("RRS_RUNTIME_FRAME_INTERVAL:{error}"))?;
    println!(
        concat!(
            "{{\"status\":\"ready\",\"runtimeId\":\"{}\",\"listen\":\"{}\",",
            "\"workers\":{},\"minFrameDelayMs\":{},\"height\":{},\"runtimeFrameHash\":\"{}\",",
            "\"accountsRoot\":\"{}\",\"restoredFrames\":{},",
            "\"restoreMicros\":{}}}"
        ),
        service.runtime_id(),
        service.local_address(),
        workers,
        min_frame_delay_ms,
        restored.state.height,
        digest_hex(&restored.durable.prev_frame_hash()),
        digest_hex(&restored_entity.accounts_root),
        restored_frames,
        restore_micros,
    );
    let wait = Duration::from_millis(
        u64::try_from(frame_wait_ms).map_err(|_| "RRS_RUNTIME_WAIT_OVERFLOW".to_string())?,
    );
    let mut metric_started = Instant::now();
    let mut frames = 0_u64;
    let mut outputs = 0_u64;
    let mut envelopes = 0_u64;
    let mut apply_micros = 0_u128;
    let mut projection_micros = 0_u128;
    let mut storage_micros = 0_u128;
    let mut publication_micros = 0_u128;
    let mut total_frames = 0_u64;
    let mut total_outputs = 0_u64;
    let mut total_envelopes = 0_u64;
    let mut total_apply_micros = 0_u128;
    let mut total_projection_micros = 0_u128;
    let mut total_storage_micros = 0_u128;
    let mut total_publication_micros = 0_u128;
    let mut total_runtime_entity_inputs = 0_u64;
    // Cumulative frame-size histogram. The HLT diffs this at the economic
    // boundary, so worker-count A/B runs prove whether faster workers merely
    // seal more small Runtime frames. Buckets: 0, 1, 2..7, 8..31, 32..127,
    // 128..511, 512+ EntityInputs. Diagnostics only; never enters consensus.
    let mut runtime_entity_input_frame_buckets = [0_u64; 7];
    let mut total_account_inputs = 0_u64;
    let mut total_canonical_input_bytes = 0_u64;
    let mut total_entity_txs_selected = 0_u64;
    let mut entity_txs_pending = 0_u64;
    let mut total_projection_input_micros = 0_u128;
    let mut total_projection_machine_micros = 0_u128;
    let mut total_projection_meta_micros = 0_u128;
    let mut total_projection_context_micros = 0_u128;
    let mut total_projection_checkpoint_micros = 0_u128;
    let mut total_projection_encode_micros = 0_u128;
    let mut total_storage_prepare_validate_micros = 0_u128;
    let mut total_storage_batch_build_micros = 0_u128;
    let mut total_storage_db_write_sync_micros = 0_u128;
    let mut total_storage_directory_sync_micros = 0_u128;
    let mut total_storage_post_commit_micros = 0_u128;
    let mut total_barrier_wait_for_previous_commit_micros = 0_u128;
    let mut total_committer_busy_micros = 0_u128;
    let mut total_committer_idle_micros = 0_u128;
    let mut previous_runtime_entity_inputs = 0_u64;
    let mut previous_account_inputs = 0_u64;
    let mut previous_shard_work_items = Vec::<u64>::new();
    let mut previous_shard_fold_leaves = Vec::<u64>::new();
    let mut previous_shard_work_nanos = Vec::<u64>::new();
    let mut previous_shard_fold_nanos = Vec::<u64>::new();
    let mut previous_coordinator_wall_nanos = 0_u64;
    let mut previous_coordinator_fold_nanos = 0_u64;
    let mut previous_worker_work_sum_nanos = 0_u64;
    let mut previous_worker_barrier_wait_sum_nanos = 0_u64;
    let mut previous_workers_with_work = 0_u64;
    let mut previous_touched_shards = 0_u64;
    let mut total_accepted_payments = 0_u64;
    let mut total_completed_payments = 0_u64;
    let mut total_matched_swaps = 0_u64;
    let mut total_zero_fill_swap_cancels = 0_u64;
    let mut paybook_open = 0_u64;
    let mut last_completed_at_unix_micros = 0_u128;
    let mut last_accepted_at_unix_micros = 0_u128;
    let mut last_matched_at_unix_micros = 0_u128;
    let mut post_state_hash = format!("0x{}", "00".repeat(32));
    let mut latest_metrics = serde_json::json!({});
    loop {
        if http_state.quiescing() {
            drop(http);
            return Ok(());
        }
        let local_command = http_commands.try_recv().ok();
        let local_apply = match local_command {
            Some(RuntimeHttpCommand::AccountStatus {
                hub_entity_id,
                hub_entity_id_text,
                counterparty,
                counterparty_text,
                token_ids,
                response,
            }) => {
                let status = native_account_status(
                    &mut service,
                    hub_entity_id,
                    &local_entity_signer_id,
                    &hub_entity_id_text,
                    counterparty,
                    &counterparty_text,
                    token_ids,
                );
                let _ = response.send(status);
                continue;
            }
            Some(RuntimeHttpCommand::EntityProfile {
                entity_id,
                entity_id_text,
                response,
            }) => {
                let profile = {
                    let entity_key = RuntimeEntityKey::new(entity_id, &local_entity_signer_id)
                        .map_err(|error| format!("RRS_RUNTIME_PROFILE_KEY:{error}"))?;
                    let replica = service
                        .processor()
                        .replica()
                        .map_err(|error| format!("RRS_RUNTIME_PROFILE_REPLICA:{error}"))?;
                    let state_exists = replica.state.e_replicas.contains_key(&entity_key);
                    let live_exists = replica.e_replicas.contains_key(&entity_key);
                    if state_exists != live_exists {
                        Err(format!(
                            "RRS_RUNTIME_PROFILE_SLOT_DIVERGED:{entity_id_text}:state={state_exists}:replica={live_exists}"
                        ))
                    } else if !state_exists {
                        Ok(None)
                    } else {
                        native_profile(
                            &service,
                            &entity_key,
                            profile_routing_fee_ppm,
                            &profile_routing_base_fee,
                        )
                        .and_then(|profile| {
                            (profile.get("entityId").and_then(Value::as_str)
                                == Some(entity_id_text.as_str()))
                            .then_some(Some(profile))
                            .ok_or_else(|| format!("RRS_RUNTIME_PROFILE_IDENTITY:{entity_id_text}"))
                        })
                    }
                };
                let _ = response.send(profile);
                continue;
            }
            Some(RuntimeHttpCommand::MarketCatalog {
                hub_entity_id,
                hub_entity_id_text,
                response,
            }) => {
                let catalog = native_market_catalog(
                    &service,
                    &local_entity_signer_id,
                    hub_entity_id,
                    &hub_entity_id_text,
                );
                let _ = response.send(catalog);
                continue;
            }
            Some(RuntimeHttpCommand::MarketSnapshots {
                hub_entity_id,
                hub_entity_id_text,
                pair_ids,
                depth,
                response,
            }) => {
                let snapshots = native_market_snapshots(
                    &service,
                    &local_entity_signer_id,
                    hub_entity_id,
                    &hub_entity_id_text,
                    &pair_ids,
                    depth,
                );
                let _ = response.send(snapshots);
                continue;
            }
            Some(RuntimeHttpCommand::Tokens { response }) => {
                let tokens = native_market_tokens(&service);
                let _ = response.send(tokens);
                continue;
            }
            Some(RuntimeHttpCommand::FaucetOffchain { request, response }) => {
                let result = native_offchain_faucet(&mut service, &local_entity_signer_id, request);
                let _ = response.send(result);
                continue;
            }
            Some(RuntimeHttpCommand::ApplyEntityInputs {
                command_id,
                entity_inputs,
                committed,
            }) => Some((command_id, entity_inputs, committed)),
            None => None,
        };
        let local_command_id = local_apply
            .as_ref()
            .map(|(command_id, _, _)| command_id.clone());
        let local_command_committed = local_apply
            .as_ref()
            .map(|(_, _, committed)| committed.clone());
        let report = match local_apply {
            Some((_, entity_inputs, _)) => service.process_local_entity_inputs(entity_inputs),
            None => service.process_next(wait),
        }
        .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
        if report.is_none()
            && let Some(command_id) = local_command_id.as_ref()
        {
            let error = format!("RRS_RUNTIME_LOCAL_COMMAND_IDLE:{command_id}");
            if let Some(committed) = local_command_committed {
                let _ = committed.send(Err(error));
            }
            continue;
        }
        if let Some(report) = report {
            if let Some(command_id) = local_command_id {
                // The commit for this frame may still be on the committer
                // thread; a local-command acknowledgement must name a durable
                // height, so drain the pipeline before replying.
                let height = report
                    .commitments
                    .as_ref()
                    .map(|commitments| commitments.height)
                    .ok_or_else(|| format!("RRS_RUNTIME_LOCAL_COMMAND_IDLE:{command_id}"))?;
                service
                    .sync_committed()
                    .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
                let committed = local_command_committed
                    .ok_or_else(|| format!("RRS_RUNTIME_LOCAL_COMMAND_REPLY:{command_id}"))?;
                // The Runtime frame is already durable. HTTP delivery is a
                // best-effort process result and cannot roll back or poison it.
                let _ = committed.send(Ok(height));
            }
            frames = frames
                .checked_add(1)
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:frames".to_string())?;
            outputs = outputs
                .checked_add(
                    u64::try_from(report.outputs_published)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:outputs".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:outputs".to_string())?;
            envelopes = envelopes
                .checked_add(
                    u64::try_from(report.envelopes_published)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:envelopes".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:envelopes".to_string())?;
            apply_micros = apply_micros.saturating_add(report.timings.apply.as_micros());
            projection_micros =
                projection_micros.saturating_add(report.timings.projection.as_micros());
            storage_micros = storage_micros.saturating_add(report.timings.storage.as_micros());
            publication_micros =
                publication_micros.saturating_add(report.timings.publication.as_micros());
            total_frames = total_frames.saturating_add(1);
            total_outputs = total_outputs.saturating_add(
                u64::try_from(report.outputs_published)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:totalOutputs".to_string())?,
            );
            total_envelopes = total_envelopes.saturating_add(
                u64::try_from(report.envelopes_published)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:totalEnvelopes".to_string())?,
            );
            total_apply_micros =
                total_apply_micros.saturating_add(report.timings.apply.as_micros());
            total_projection_micros =
                total_projection_micros.saturating_add(report.timings.projection.as_micros());
            total_storage_micros =
                total_storage_micros.saturating_add(report.timings.storage.as_micros());
            total_publication_micros =
                total_publication_micros.saturating_add(report.timings.publication.as_micros());
            total_runtime_entity_inputs = total_runtime_entity_inputs.saturating_add(
                u64::try_from(report.runtime_entity_inputs)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:runtimeEntityInputs".to_string())?,
            );
            let frame_bucket = match report.runtime_entity_inputs {
                0 => 0,
                1 => 1,
                2..=7 => 2,
                8..=31 => 3,
                32..=127 => 4,
                128..=511 => 5,
                _ => 6,
            };
            runtime_entity_input_frame_buckets[frame_bucket] =
                runtime_entity_input_frame_buckets[frame_bucket].saturating_add(1);
            total_account_inputs = total_account_inputs.saturating_add(
                u64::try_from(report.account_inputs)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:accountInputs".to_string())?,
            );
            total_canonical_input_bytes = total_canonical_input_bytes.saturating_add(
                u64::try_from(report.canonical_input_bytes)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:canonicalInputBytes".to_string())?,
            );
            total_entity_txs_selected =
                total_entity_txs_selected
                    .saturating_add(u64::try_from(report.entity_txs_selected).map_err(|_| {
                        "RRS_RUNTIME_METRIC_OVERFLOW:entityTxsSelected".to_string()
                    })?);
            entity_txs_pending = u64::try_from(report.entity_txs_pending)
                .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:entityTxsPending".to_string())?;
            total_projection_input_micros = total_projection_input_micros
                .saturating_add(report.timings.projection_input.as_micros());
            total_projection_machine_micros = total_projection_machine_micros
                .saturating_add(report.timings.projection_machine.as_micros());
            total_projection_meta_micros = total_projection_meta_micros
                .saturating_add(report.timings.projection_meta.as_micros());
            total_projection_context_micros = total_projection_context_micros
                .saturating_add(report.timings.projection_context.as_micros());
            total_projection_checkpoint_micros = total_projection_checkpoint_micros
                .saturating_add(report.timings.projection_checkpoint.as_micros());
            total_projection_encode_micros = total_projection_encode_micros
                .saturating_add(report.timings.projection_encode.as_micros());
            total_storage_prepare_validate_micros = total_storage_prepare_validate_micros
                .saturating_add(report.timings.storage_prepare_validate.as_micros());
            total_storage_batch_build_micros = total_storage_batch_build_micros
                .saturating_add(report.timings.storage_batch_build.as_micros());
            total_storage_db_write_sync_micros = total_storage_db_write_sync_micros
                .saturating_add(report.timings.storage_db_write_sync.as_micros());
            total_storage_directory_sync_micros = total_storage_directory_sync_micros
                .saturating_add(report.timings.storage_directory_sync.as_micros());
            total_storage_post_commit_micros = total_storage_post_commit_micros
                .saturating_add(report.timings.storage_post_commit.as_micros());
            total_barrier_wait_for_previous_commit_micros =
                total_barrier_wait_for_previous_commit_micros
                    .saturating_add(report.timings.barrier_wait_for_previous_commit.as_micros());
            total_committer_busy_micros = total_committer_busy_micros
                .saturating_add(report.timings.committer_busy.as_micros());
            total_committer_idle_micros = total_committer_idle_micros
                .saturating_add(report.timings.committer_idle.as_micros());
            total_accepted_payments = total_accepted_payments
                .checked_add(
                    u64::try_from(report.accepted_payments)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:acceptedPayments".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:acceptedPayments".to_string())?;
            total_completed_payments = total_completed_payments
                .checked_add(
                    u64::try_from(report.completed_payments)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:completedPayments".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:completedPayments".to_string())?;
            total_matched_swaps = total_matched_swaps
                .checked_add(
                    u64::try_from(report.matched_swaps)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:matchedSwaps".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:matchedSwaps".to_string())?;
            total_zero_fill_swap_cancels =
                total_zero_fill_swap_cancels
                    .checked_add(u64::try_from(report.zero_fill_swap_cancels).map_err(|_| {
                        "RRS_RUNTIME_METRIC_OVERFLOW:zeroFillSwapCancels".to_string()
                    })?)
                    .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:zeroFillSwapCancels".to_string())?;
            if let Some(open) = report.paybook_open {
                paybook_open = u64::try_from(open)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:paybookOpen".to_string())?;
            }
            if report.completed_payments > 0 {
                last_completed_at_unix_micros = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "RRS_RUNTIME_METRIC_CLOCK_BEFORE_EPOCH".to_string())?
                    .as_micros();
            }
            if report.accepted_payments > 0 {
                last_accepted_at_unix_micros = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "RRS_RUNTIME_METRIC_CLOCK_BEFORE_EPOCH".to_string())?
                    .as_micros();
            }
            if report.matched_swaps > 0 {
                last_matched_at_unix_micros = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "RRS_RUNTIME_METRIC_CLOCK_BEFORE_EPOCH".to_string())?
                    .as_micros();
            }
            if let Some(commitments) = report.commitments.as_ref() {
                post_state_hash = digest_hex(&commitments.post_state_hash);
            }
            http_state.publish(http_snapshot(
                &service,
                &primary_entity_key,
                &name,
                api_address,
                latest_metrics.clone(),
            )?)?;
        }
        if metric_started.elapsed()
            >= Duration::from_millis(
                u64::try_from(metrics_ms)
                    .map_err(|_| "RRS_RUNTIME_METRICS_INTERVAL_OVERFLOW".to_string())?,
            )
        {
            let elapsed = metric_started.elapsed();
            let ingress = service.ingress_metrics();
            let (backlog, retained_wal_bytes) = service
                .processor()
                .publication_backlog_and_retained_wal_bytes()
                .map_err(|error| format!("RRS_RUNTIME_STORAGE_HEAD:{error}"))?;
            let height = service
                .processor()
                .replica()
                .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?
                .state
                .height;
            let replica = service
                .processor()
                .replica()
                .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
            let (entity_state, entity_replica) = entity_slot(replica, &primary_entity_key)?;
            let paybook_fees_earned = entity_state.entity.paybook.fees_earned.to_string();
            let (
                orderbook_trade_count,
                open_book_orders,
                open_swap_offers,
                resolving_swap_offers,
                open_swap_offer_ids,
                open_swap_offer_ids_truncated,
            ) = match entity_state.entity.orderbook.as_ref() {
                Some(orderbook) => {
                    let trade_count = orderbook.books.values().try_fold(0_u64, |total, book| {
                        total.checked_add(book.trade_count).ok_or_else(|| {
                            "RRS_RUNTIME_METRIC_OVERFLOW:orderbookTradeCount".to_string()
                        })
                    })?;
                    let book_orders = orderbook.books.values().try_fold(0_u64, |total, book| {
                        let count = u64::try_from(book.orders.len()).map_err(|_| {
                            "RRS_RUNTIME_METRIC_OVERFLOW:openBookOrders".to_string()
                        })?;
                        total
                            .checked_add(count)
                            .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:openBookOrders".to_string())
                    })?;
                    let offer_count = orderbook.offers.len();
                    (
                        trade_count,
                        book_orders,
                        u64::try_from(offer_count).map_err(|_| {
                            "RRS_RUNTIME_METRIC_OVERFLOW:openSwapOffers".to_string()
                        })?,
                        u64::try_from(orderbook.resolving_offers.len()).map_err(|_| {
                            "RRS_RUNTIME_METRIC_OVERFLOW:resolvingSwapOffers".to_string()
                        })?,
                        orderbook
                            .offers
                            .values()
                            .take(256)
                            .map(|offer| offer.offer_id.clone())
                            .collect::<Vec<_>>(),
                        offer_count > 256,
                    )
                }
                None => (0, 0, 0, 0, Vec::new(), false),
            };
            let shard_metrics = entity_replica.accounts.account_shard_metrics();
            if previous_shard_work_items.len() != shard_metrics.len() {
                previous_shard_work_items.resize(shard_metrics.len(), 0);
                previous_shard_fold_leaves.resize(shard_metrics.len(), 0);
                previous_shard_work_nanos.resize(shard_metrics.len(), 0);
                previous_shard_fold_nanos.resize(shard_metrics.len(), 0);
            }
            let mut worker_items = vec![0_u64; entity_replica.accounts.worker_count()];
            let mut worker_nanos = vec![0_u64; entity_replica.accounts.worker_count()];
            let mut worker_fold_leaves = vec![0_u64; entity_replica.accounts.worker_count()];
            let mut worker_fold_nanos = vec![0_u64; entity_replica.accounts.worker_count()];
            let mut window_worker_items = vec![0_u64; entity_replica.accounts.worker_count()];
            let mut window_worker_nanos = vec![0_u64; entity_replica.accounts.worker_count()];
            let mut active_shards = 0_u64;
            for (index, metric) in shard_metrics.into_iter().enumerate() {
                let worker = usize::from(metric.worker);
                let work_items = metric
                    .work_items
                    .saturating_sub(previous_shard_work_items[index]);
                let fold_leaves = metric
                    .fold_leaves
                    .saturating_sub(previous_shard_fold_leaves[index]);
                let work_nanos = metric
                    .work_nanos
                    .saturating_sub(previous_shard_work_nanos[index]);
                let fold_nanos = metric
                    .fold_nanos
                    .saturating_sub(previous_shard_fold_nanos[index]);
                worker_items[worker] = worker_items[worker].saturating_add(metric.work_items);
                worker_nanos[worker] = worker_nanos[worker]
                    .saturating_add(metric.work_nanos)
                    .saturating_add(metric.fold_nanos);
                worker_fold_leaves[worker] =
                    worker_fold_leaves[worker].saturating_add(metric.fold_leaves);
                worker_fold_nanos[worker] =
                    worker_fold_nanos[worker].saturating_add(metric.fold_nanos);
                window_worker_items[worker] =
                    window_worker_items[worker].saturating_add(work_items);
                window_worker_nanos[worker] = window_worker_nanos[worker]
                    .saturating_add(work_nanos)
                    .saturating_add(fold_nanos);
                active_shards =
                    active_shards.saturating_add(u64::from(work_items > 0 || fold_leaves > 0));
                previous_shard_work_items[index] = metric.work_items;
                previous_shard_fold_leaves[index] = metric.fold_leaves;
                previous_shard_work_nanos[index] = metric.work_nanos;
                previous_shard_fold_nanos[index] = metric.fold_nanos;
            }
            let phase_metrics = entity_replica.accounts.account_phase_metrics();
            let (entity_worker_items, entity_worker_nanos) =
                entity_replica.accounts.entity_worker_metrics();
            let entity_worker_items = entity_worker_items.to_vec();
            let entity_worker_nanos = entity_worker_nanos.to_vec();
            let account_coordinator_wall_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_wall_nanos)
                .sum::<u64>();
            let account_coordinator_pre_dispatch_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_pre_dispatch_nanos)
                .sum::<u64>();
            let account_run_lanes_wall_nanos = phase_metrics
                .iter()
                .map(|metric| metric.run_lanes_wall_nanos)
                .sum::<u64>();
            let account_coordinator_post_join_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_post_join_nanos)
                .sum::<u64>();
            let account_coordinator_fold_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_fold_nanos)
                .sum::<u64>();
            let account_worker_work_max_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_work_max_nanos)
                .max()
                .unwrap_or(0);
            let account_worker_work_sum_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_work_sum_nanos)
                .sum::<u64>();
            let account_worker_critical_path_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_critical_path_nanos)
                .sum::<u64>();
            let account_worker_phase_span_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_phase_span_nanos)
                .sum::<u64>();
            let account_coordinator_dispatch_join_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_dispatch_join_nanos)
                .sum::<u64>();
            let account_worker_barrier_wait_max_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_barrier_wait_max_nanos)
                .max()
                .unwrap_or(0);
            let account_worker_barrier_wait_sum_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_barrier_wait_sum_nanos)
                .sum::<u64>();
            let total_account_workers_with_work = phase_metrics
                .iter()
                .map(|metric| metric.workers_with_work)
                .sum::<u64>();
            let total_account_touched_shards = phase_metrics
                .iter()
                .map(|metric| metric.touched_shards)
                .sum::<u64>();
            let window_runtime_entity_inputs =
                total_runtime_entity_inputs.saturating_sub(previous_runtime_entity_inputs);
            let window_account_inputs =
                total_account_inputs.saturating_sub(previous_account_inputs);
            let window_coordinator_wall_nanos =
                account_coordinator_wall_nanos.saturating_sub(previous_coordinator_wall_nanos);
            let window_coordinator_fold_nanos =
                account_coordinator_fold_nanos.saturating_sub(previous_coordinator_fold_nanos);
            let window_worker_work_sum_nanos =
                account_worker_work_sum_nanos.saturating_sub(previous_worker_work_sum_nanos);
            let window_worker_barrier_wait_sum_nanos = account_worker_barrier_wait_sum_nanos
                .saturating_sub(previous_worker_barrier_wait_sum_nanos);
            let window_workers_with_work =
                total_account_workers_with_work.saturating_sub(previous_workers_with_work);
            let window_touched_shards =
                total_account_touched_shards.saturating_sub(previous_touched_shards);
            // Keep the groups small. One giant json! expansion exceeds the
            // compiler recursion limit and makes telemetry affect the build.
            let mut metric_object = Map::new();
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "status": "metrics",
                    "windowMs": elapsed.as_millis(),
                    "height": height,
                    "frames": frames,
                    "acceptedBatches": ingress.accepted_batches,
                    "acceptedEntityInputs": ingress.accepted_entity_inputs,
                    "pendingBatches": ingress.pending_batches,
                    "pendingBatchesHighWater": ingress.pending_batches_high_water,
                    "backpressureEvents": ingress.backpressure_events,
                    "backpressureWaitMicros": ingress.backpressure_wait_micros,
                    "backpressureWaitMaxMicros": ingress.backpressure_wait_max_micros,
                    "acceptedConnections": ingress.accepted_connections,
                    "authenticatedSessions": ingress.authenticated_sessions,
                    "rejectedSessions": ingress.rejected_sessions,
                    "openSessions": ingress.open_sessions,
                    "lastSessionError": service.last_session_error(),
                    "queueRejections": ingress.queue_rejections,
                    "outputsPublished": outputs,
                    "envelopesPublished": envelopes,
                    "outboxTargetsPending": backlog.targets,
                    "outboxRowsPending": backlog.rows,
                    "outboxBytesPending": backlog.bytes,
                    "outboxFailures": backlog.failures.len(),
                    "retainedWalBytes": retained_wal_bytes,
                    "acceptedPayments": total_accepted_payments,
                    "completedPayments": total_completed_payments,
                    "matchedSwaps": total_matched_swaps,
                    "zeroFillSwapCancels": total_zero_fill_swap_cancels,
                    "paybookOpen": paybook_open,
                    "orderbookTradeCount": orderbook_trade_count,
                    "openBookOrders": open_book_orders,
                    "openSwapOffers": open_swap_offers,
                    "resolvingSwapOffers": resolving_swap_offers,
                    "openSwapOfferIds": open_swap_offer_ids,
                    "openSwapOfferIdsTruncated": open_swap_offer_ids_truncated,
                    "lastCompletedAtUnixMicros": last_completed_at_unix_micros,
                    "lastAcceptedAtUnixMicros": last_accepted_at_unix_micros,
                    "lastMatchedAtUnixMicros": last_matched_at_unix_micros,
                    "postStateHash": post_state_hash,
                    "paybookFeesEarned": paybook_fees_earned,
                }),
                "runtime",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "applyMicros": apply_micros,
                    "projectionMicros": projection_micros,
                    "storageMicros": storage_micros,
                    "publicationMicros": publication_micros,
                    "totalFrames": total_frames,
                    "totalOutputsPublished": total_outputs,
                    "totalEnvelopesPublished": total_envelopes,
                    "totalApplyMicros": total_apply_micros,
                    "totalProjectionMicros": total_projection_micros,
                    "totalStorageMicros": total_storage_micros,
                    "totalPublicationMicros": total_publication_micros,
                }),
                "phases",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "totalRuntimeEntityInputs": total_runtime_entity_inputs,
                    "runtimeEntityInputFrameBuckets": runtime_entity_input_frame_buckets,
                    "totalAccountInputs": total_account_inputs,
                    "totalCanonicalInputBytes": total_canonical_input_bytes,
                    "totalEntityTxsSelected": total_entity_txs_selected,
                    "entityTxsPending": entity_txs_pending,
                    "totalProjectionInputMicros": total_projection_input_micros,
                    "totalProjectionMachineMicros": total_projection_machine_micros,
                    "totalProjectionMetaMicros": total_projection_meta_micros,
                    "totalProjectionContextMicros": total_projection_context_micros,
                    "totalProjectionCheckpointMicros": total_projection_checkpoint_micros,
                    "totalProjectionEncodeMicros": total_projection_encode_micros,
                }),
                "projectionDetail",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "totalStoragePrepareValidateMicros": total_storage_prepare_validate_micros,
                    "totalStorageBatchBuildMicros": total_storage_batch_build_micros,
                    "totalStorageDbWriteSyncMicros": total_storage_db_write_sync_micros,
                    "totalStorageDirectorySyncMicros": total_storage_directory_sync_micros,
                    "totalStoragePostCommitMicros": total_storage_post_commit_micros,
                    "totalBarrierWaitForPreviousCommitMicros": total_barrier_wait_for_previous_commit_micros,
                    "totalCommitterBusyMicros": total_committer_busy_micros,
                    "totalCommitterIdleMicros": total_committer_idle_micros,
                }),
                "storageDetail",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "accountCoordinatorPreDispatchMicros": account_coordinator_pre_dispatch_nanos / 1_000,
                    "accountRunLanesWallMicros": account_run_lanes_wall_nanos / 1_000,
                    "accountCoordinatorPostJoinMicros": account_coordinator_post_join_nanos / 1_000,
                }),
                "accountPhaseTiming",
            )?;
            let account_phase_metrics = phase_metrics
                .iter()
                .map(account_phase_metric_value)
                .collect::<Result<Vec<_>, _>>()?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "accountCoordinatorWallMicros": account_coordinator_wall_nanos / 1_000,
                    "accountCoordinatorFoldMicros": account_coordinator_fold_nanos / 1_000,
                    "accountWorkerWorkSumMicros": account_worker_work_sum_nanos / 1_000,
                    "accountWorkerWorkMaxMicros": account_worker_work_max_nanos / 1_000,
                    "accountWorkerCriticalPathMicros": account_worker_critical_path_nanos / 1_000,
                    "accountWorkerPhaseSpanMicros": account_worker_phase_span_nanos / 1_000,
                    "accountCoordinatorDispatchJoinMicros": account_coordinator_dispatch_join_nanos / 1_000,
                    "accountWorkerBarrierWaitSumMicros": account_worker_barrier_wait_sum_nanos / 1_000,
                    "accountWorkerBarrierWaitMaxMicros": account_worker_barrier_wait_max_nanos / 1_000,
                    "accountWorkersWithWork": total_account_workers_with_work,
                    "accountTouchedShards": total_account_touched_shards,
                    "activeShards": active_shards,
                    "workerItems": worker_items,
                    "workerNanos": worker_nanos,
                    "workerFoldLeaves": worker_fold_leaves,
                    "workerFoldNanos": worker_fold_nanos,
                    "entityWorkerItems": entity_worker_items,
                    "entityWorkerNanos": entity_worker_nanos,
                    "accountPhaseMetrics": account_phase_metrics,
                    "windowRuntimeEntityInputs": window_runtime_entity_inputs,
                    "windowAccountInputs": window_account_inputs,
                    "windowCoordinatorWallMicros": window_coordinator_wall_nanos / 1_000,
                    "windowCoordinatorFoldMicros": window_coordinator_fold_nanos / 1_000,
                    "windowWorkerWorkSumMicros": window_worker_work_sum_nanos / 1_000,
                    "windowWorkerBarrierWaitSumMicros": window_worker_barrier_wait_sum_nanos / 1_000,
                }),
                "accountWorkers",
            )?;
            if std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1") {
                eprintln!(
                    "RSCORE_RUNTIME_WINDOW frames={frames} apply={apply_micros} projection={projection_micros} storage={storage_micros} publication={publication_micros} runtimeEntityInputs={window_runtime_entity_inputs} accountInputs={window_account_inputs} coordinatorWall={} coordinatorFold={} workerWorkSum={} barrierWaitSum={} busyWorkers={window_workers_with_work} touchedShards={window_touched_shards} activeShards={active_shards} workerItems={window_worker_items:?} workerNanos={window_worker_nanos:?}",
                    window_coordinator_wall_nanos / 1_000,
                    window_coordinator_fold_nanos / 1_000,
                    window_worker_work_sum_nanos / 1_000,
                    window_worker_barrier_wait_sum_nanos / 1_000,
                );
            }
            latest_metrics = Value::Object(metric_object);
            println!("{latest_metrics}");
            http_state.publish(http_snapshot(
                &service,
                &primary_entity_key,
                &name,
                api_address,
                latest_metrics.clone(),
            )?)?;
            metric_started = Instant::now();
            frames = 0;
            outputs = 0;
            envelopes = 0;
            apply_micros = 0;
            projection_micros = 0;
            storage_micros = 0;
            publication_micros = 0;
            previous_runtime_entity_inputs = total_runtime_entity_inputs;
            previous_account_inputs = total_account_inputs;
            previous_coordinator_wall_nanos = account_coordinator_wall_nanos;
            previous_coordinator_fold_nanos = account_coordinator_fold_nanos;
            previous_worker_work_sum_nanos = account_worker_work_sum_nanos;
            previous_worker_barrier_wait_sum_nanos = account_worker_barrier_wait_sum_nanos;
            previous_workers_with_work = total_account_workers_with_work;
            previous_touched_shards = total_account_touched_shards;
        }
    }
}
