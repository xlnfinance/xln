//! Typed Entity-owned state recovered from the canonical storage graph.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    EntityCommandNonceRecord, EntityCommandNonceState, EntityStateSlice, EntityStateSnapshot,
    HtlcRoute, LockBookEntry, compute_entity_owned_sections,
};

use crate::{EntityCheckpointError, entity_checkpoint_crontab};

use super::entity_graph::HydratedEntityGraph;
use super::orderbook_graph::HydratedOrderbook;

#[derive(Debug, Error)]
pub enum EntitySnapshotRestoreError {
    #[error("RRS_RESTORE_ENTITY_SNAPSHOT:{0}")]
    Invalid(String),
    #[error(transparent)]
    Checkpoint(#[from] EntityCheckpointError),
    #[error("RRS_RESTORE_ENTITY_SNAPSHOT_KERNEL:{0}")]
    Kernel(String),
}

fn invalid(detail: impl Into<String>) -> EntitySnapshotRestoreError {
    EntitySnapshotRestoreError::Invalid(detail.into())
}

fn entity_hex(bytes: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntitySnapshotRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn required<'a>(
    value: &'a Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<&'a Value, EntitySnapshotRestoreError> {
    value
        .get(name)
        .ok_or_else(|| invalid(format!("FIELD:{path}.{name}")))
}

fn text(value: &Value, path: &str) -> Result<String, EntitySnapshotRestoreError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn unsigned(value: &Value, path: &str) -> Result<u64, EntitySnapshotRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn token(value: &Value, path: &str) -> Result<u16, EntitySnapshotRestoreError> {
    u16::try_from(unsigned(value, path)?).map_err(|_| invalid(format!("TOKEN:{path}")))
}

fn bigint(value: &Value, path: &str) -> Result<BigInt, EntitySnapshotRestoreError> {
    let value = object(value, path)?;
    if value.len() != 2 || value.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(invalid(format!("BIGINT:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("BIGINT:{path}")))?
        .parse()
        .map_err(|_| invalid(format!("BIGINT:{path}")))
}

fn optional<T>(
    value: Option<&Value>,
    decode: impl FnOnce(&Value) -> Result<T, EntitySnapshotRestoreError>,
) -> Result<Option<T>, EntitySnapshotRestoreError> {
    value.map(decode).transpose()
}

fn tagged_rows<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a [Value], EntitySnapshotRestoreError> {
    let map = object(value, path)?;
    if map.len() != 2 || map.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(invalid(format!("MAP:{path}")));
    }
    map.get("value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("MAP_ROWS:{path}")))
}

fn exact_allowed(
    value: &Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), EntitySnapshotRestoreError> {
    if let Some(name) = value.keys().find(|name| !allowed.contains(&name.as_str())) {
        return Err(invalid(format!("UNKNOWN_FIELD:{path}.{name}")));
    }
    Ok(())
}

fn hex32(value: &Value, path: &str) -> Result<String, EntitySnapshotRestoreError> {
    let value = text(value, path)?;
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| invalid(format!("HEX32:{path}")))?;
    if value != value.to_lowercase()
        || payload
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(format!("HEX32:{path}")));
    }
    Ok(value)
}

fn command_nonces(
    value: Option<&Value>,
) -> Result<Option<EntityCommandNonceState>, EntitySnapshotRestoreError> {
    let Some(value) = value else { return Ok(None) };
    let state = object(value, "entityCommandNonces")?;
    exact_allowed(
        state,
        &["version", "boardHash", "boardEpoch", "bySigner"],
        "entityCommandNonces",
    )?;
    if state.len() != 4
        || unsigned(
            required(state, "version", "entityCommandNonces")?,
            "entityCommandNonces.version",
        )? != 1
    {
        return Err(invalid("ENTITY_COMMAND_NONCE_STATE_HEADER"));
    }
    let mut by_signer = BTreeMap::new();
    for (index, row) in tagged_rows(
        required(state, "bySigner", "entityCommandNonces")?,
        "entityCommandNonces.bySigner",
    )?
    .iter()
    .enumerate()
    {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("ENTITY_COMMAND_NONCE_ROW:{index}")))?;
        let signer = text(&row[0], "entityCommandNonces.signer")?;
        if signer.is_empty() || signer != signer.trim().to_lowercase() {
            return Err(invalid(format!("ENTITY_COMMAND_NONCE_SIGNER:{signer}")));
        }
        let record = object(&row[1], "entityCommandNonces.record")?;
        exact_allowed(
            record,
            &["nonce", "commandHash"],
            "entityCommandNonces.record",
        )?;
        if record.len() != 2 {
            return Err(invalid("ENTITY_COMMAND_NONCE_RECORD_FIELDS"));
        }
        let nonce = bigint(
            required(record, "nonce", "entityCommandNonces.record")?,
            "entityCommandNonces.nonce",
        )?;
        if nonce < BigInt::from(1_u8) {
            return Err(invalid("ENTITY_COMMAND_NONCE_VALUE"));
        }
        let command_hash = hex32(
            required(record, "commandHash", "entityCommandNonces.record")?,
            "entityCommandNonces.commandHash",
        )?;
        if by_signer
            .insert(
                signer.clone(),
                EntityCommandNonceRecord {
                    nonce,
                    command_hash,
                },
            )
            .is_some()
        {
            return Err(invalid(format!("ENTITY_COMMAND_NONCE_DUPLICATE:{signer}")));
        }
    }
    if by_signer.len() > 100 {
        return Err(invalid("ENTITY_COMMAND_NONCE_STATE_OVERSIZED"));
    }
    Ok(Some(EntityCommandNonceState {
        version: 1,
        board_hash: hex32(
            required(state, "boardHash", "entityCommandNonces")?,
            "entityCommandNonces.boardHash",
        )?,
        board_epoch: unsigned(
            required(state, "boardEpoch", "entityCommandNonces")?,
            "entityCommandNonces.boardEpoch",
        )?,
        by_signer,
    }))
}

fn routes(value: &Value) -> Result<BTreeMap<String, HtlcRoute>, EntitySnapshotRestoreError> {
    let mut output = BTreeMap::new();
    for (index, row) in tagged_rows(value, "htlcRoutes")?.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("MAP_ROW:htlcRoutes:{index}")))?;
        let key = text(&row[0], "htlcRoutes.key")?;
        let route = object(&row[1], "htlcRoutes.value")?;
        exact_allowed(
            route,
            &[
                "hashlock",
                "tokenId",
                "amount",
                "startedAtMs",
                "originated",
                "inboundEntity",
                "inboundLockId",
                "outboundEntity",
                "outboundLockId",
                "inboundSettled",
                "outboundSettled",
                "secret",
                "secretAckPending",
                "secretAckStartedAt",
                "secretAckDeadlineAt",
                "pendingFee",
                "createdTimestamp",
            ],
            "htlcRoutes.value",
        )?;
        let hashlock = text(required(route, "hashlock", "htlcRoutes.value")?, "hashlock")?;
        if key != hashlock {
            return Err(invalid(format!("ROUTE_KEY:{key}:{hashlock}")));
        }
        let route = HtlcRoute {
            hashlock,
            token_id: optional(route.get("tokenId"), |value| token(value, "route.tokenId"))?,
            amount: optional(route.get("amount"), |value| bigint(value, "route.amount"))?,
            started_at_ms: optional(route.get("startedAtMs"), |value| {
                unsigned(value, "route.startedAtMs")
            })?,
            originated: route
                .get("originated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            inbound_entity: optional(route.get("inboundEntity"), |value| {
                text(value, "route.inboundEntity")
            })?,
            inbound_lock_id: optional(route.get("inboundLockId"), |value| {
                text(value, "route.inboundLockId")
            })?,
            outbound_entity: optional(route.get("outboundEntity"), |value| {
                text(value, "route.outboundEntity")
            })?,
            outbound_lock_id: optional(route.get("outboundLockId"), |value| {
                text(value, "route.outboundLockId")
            })?,
            inbound_settled: route
                .get("inboundSettled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            outbound_settled: route
                .get("outboundSettled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            secret: optional(route.get("secret"), |value| text(value, "route.secret"))?,
            secret_ack_pending: route
                .get("secretAckPending")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            secret_ack_started_at: optional(route.get("secretAckStartedAt"), |value| {
                unsigned(value, "route.secretAckStartedAt")
            })?,
            secret_ack_deadline_at: optional(route.get("secretAckDeadlineAt"), |value| {
                unsigned(value, "route.secretAckDeadlineAt")
            })?,
            pending_fee: optional(route.get("pendingFee"), |value| {
                bigint(value, "route.pendingFee")
            })?,
            created_timestamp: unsigned(
                required(route, "createdTimestamp", "htlcRoutes.value")?,
                "route.createdTimestamp",
            )?,
        };
        if output.insert(key.clone(), route).is_some() {
            return Err(invalid(format!("ROUTE_DUPLICATE:{key}")));
        }
    }
    Ok(output)
}

fn reserves(value: &Value) -> Result<BTreeMap<u16, BigInt>, EntitySnapshotRestoreError> {
    let mut output = BTreeMap::new();
    for (index, row) in tagged_rows(value, "reserves")?.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("MAP_ROW:reserves:{index}")))?;
        let token_id = token(&row[0], "reserves.tokenId")?;
        let amount = bigint(&row[1], "reserves.amount")?;
        if token_id == 0 || amount < BigInt::from(0) {
            return Err(invalid(format!("RESERVE_VALUE:{token_id}:{amount}")));
        }
        if output.insert(token_id, amount).is_some() {
            return Err(invalid(format!("RESERVE_DUPLICATE:{token_id}")));
        }
    }
    Ok(output)
}

fn locks(value: &Value) -> Result<BTreeMap<String, LockBookEntry>, EntitySnapshotRestoreError> {
    let mut output = BTreeMap::new();
    for (index, row) in tagged_rows(value, "lockBook")?.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("MAP_ROW:lockBook:{index}")))?;
        let key = text(&row[0], "lockBook.key")?;
        let lock = object(&row[1], "lockBook.value")?;
        exact_allowed(
            lock,
            &[
                "lockId",
                "accountId",
                "tokenId",
                "amount",
                "hashlock",
                "timelock",
                "direction",
                "createdAt",
            ],
            "lockBook.value",
        )?;
        let lock_id = text(required(lock, "lockId", "lockBook.value")?, "lock.lockId")?;
        if key != lock_id {
            return Err(invalid(format!("LOCK_KEY:{key}:{lock_id}")));
        }
        let direction = required(lock, "direction", "lockBook.value")?
            .as_str()
            .ok_or_else(|| invalid("LOCK_DIRECTION"))?;
        let outgoing = match direction {
            "outgoing" => true,
            "incoming" => false,
            _ => return Err(invalid(format!("LOCK_DIRECTION:{direction}"))),
        };
        let entry = LockBookEntry {
            lock_id,
            account_id: text(
                required(lock, "accountId", "lockBook.value")?,
                "lock.accountId",
            )?,
            token_id: token(required(lock, "tokenId", "lockBook.value")?, "lock.tokenId")?,
            amount: bigint(required(lock, "amount", "lockBook.value")?, "lock.amount")?,
            hashlock: text(
                required(lock, "hashlock", "lockBook.value")?,
                "lock.hashlock",
            )?,
            timelock: bigint(
                required(lock, "timelock", "lockBook.value")?,
                "lock.timelock",
            )?,
            outgoing,
            created_at: bigint(
                required(lock, "createdAt", "lockBook.value")?,
                "lock.createdAt",
            )?,
        };
        if output.insert(key.clone(), entry).is_some() {
            return Err(invalid(format!("LOCK_DUPLICATE:{key}")));
        }
    }
    Ok(output)
}

fn wrap_core(core: Value) -> Value {
    Value::Object(Map::from_iter([(
        "state".into(),
        Value::Object(Map::from_iter([("core".into(), core)])),
    )]))
}

pub fn entity_snapshot_from_graph(
    graph: &HydratedEntityGraph,
    known_accounts: BTreeSet<String>,
    accounts_root: [u8; 32],
    orderbook: Option<HydratedOrderbook>,
) -> Result<EntityStateSnapshot, EntitySnapshotRestoreError> {
    let core = object(&graph.core, "core")?;
    let entity_id = text(required(core, "entityId", "core")?, "core.entityId")?;
    let expected_id = entity_hex(&graph.entity_id);
    if entity_id != expected_id {
        return Err(invalid(format!("ENTITY_ID:{entity_id}:{expected_id}")));
    }
    let state = EntityStateSlice {
        entity_id,
        height: unsigned(required(core, "height", "core")?, "core.height")?,
        timestamp: unsigned(required(core, "timestamp", "core")?, "core.timestamp")?,
        entity_command_nonces: command_nonces(core.get("entityCommandNonces"))?,
        last_finalized_j_height: unsigned(
            required(core, "lastFinalizedJHeight", "core")?,
            "core.lastFinalizedJHeight",
        )?,
        reserves: reserves(required(core, "reserves", "core")?)?,
        known_accounts,
        htlc_routes: routes(required(core, "htlcRoutes", "core")?)?,
        htlc_fees_earned: bigint(
            required(core, "htlcFeesEarned", "core")?,
            "core.htlcFeesEarned",
        )?,
        lock_book: locks(required(core, "lockBook", "core")?)?,
        crontab: entity_checkpoint_crontab(&wrap_core(graph.core.clone()))?,
        orderbook: orderbook
            .as_ref()
            .map(|value| value.snapshot.clone())
            .map(xln_rscore_entity_kernel::OrderbookState::restore)
            .transpose()
            .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))?,
        orderbook_metadata: orderbook.as_ref().map(|value| value.metadata.clone()),
    };
    let expected_owned_sections =
        compute_entity_owned_sections(&state, accounts_root, state.known_accounts.len())
            .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))?;
    Ok(EntityStateSnapshot {
        entity_id: state.entity_id,
        height: state.height,
        timestamp: state.timestamp,
        entity_command_nonces: state.entity_command_nonces,
        last_finalized_j_height: state.last_finalized_j_height,
        reserves: state.reserves,
        known_accounts: state.known_accounts,
        htlc_routes: state.htlc_routes,
        htlc_fees_earned: state.htlc_fees_earned,
        lock_book: state.lock_book,
        crontab: state.crontab,
        orderbook: orderbook.map(|value| value.snapshot),
        orderbook_metadata: state.orderbook_metadata,
        expected_owned_sections,
    })
}
