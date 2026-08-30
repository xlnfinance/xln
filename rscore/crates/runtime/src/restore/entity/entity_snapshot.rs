//! Typed Entity-owned state recovered from the canonical storage graph.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    EntityCanonicalCollection, EntityCommandNonceRecord, EntityCommandNonceState, EntityProfile,
    EntityStateSlice, EntityStateSnapshot, LendingState, PaybookEntry, PaybookState,
    compute_entity_owned_sections,
};

use crate::{EntityCheckpointError, canonical_value_from_tagged_json, entity_checkpoint_crontab};

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

fn profile(value: &Value) -> Result<EntityProfile, EntitySnapshotRestoreError> {
    let value = object(value, "core.profile")?;
    exact_allowed(
        value,
        &[
            "name",
            "isHub",
            "entityKind",
            "sectors",
            "avatar",
            "bio",
            "website",
        ],
        "core.profile",
    )?;
    let sectors = match value.get("sectors") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| text(value, "core.profile.sector"))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(invalid("ARRAY:core.profile.sectors")),
    };
    Ok(EntityProfile {
        name: text(
            required(value, "name", "core.profile")?,
            "core.profile.name",
        )?,
        is_hub: required(value, "isHub", "core.profile")?
            .as_bool()
            .ok_or_else(|| invalid("BOOL:core.profile.isHub"))?,
        entity_kind: optional(value.get("entityKind"), |value| {
            text(value, "core.profile.entityKind")
        })?,
        sectors,
        avatar: text(
            required(value, "avatar", "core.profile")?,
            "core.profile.avatar",
        )?,
        bio: text(required(value, "bio", "core.profile")?, "core.profile.bio")?,
        website: text(
            required(value, "website", "core.profile")?,
            "core.profile.website",
        )?,
    })
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

fn hex32_bytes(value: &Value, path: &str) -> Result<[u8; 32], EntitySnapshotRestoreError> {
    let value = hex32(value, path)?;
    let payload = &value[2..];
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("HEX32:{path}")))?;
    }
    Ok(bytes)
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

fn paybook_entries(
    value: &Value,
) -> Result<BTreeMap<String, PaybookEntry>, EntitySnapshotRestoreError> {
    let mut output = BTreeMap::new();
    for (index, row) in tagged_rows(value, "paybook.entries")?.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("MAP_ROW:paybook.entries:{index}")))?;
        let key = text(&row[0], "paybook.entries.key")?;
        let route = object(&row[1], "paybook.entries.value")?;
        exact_allowed(
            route,
            &[
                "hashlock",
                "description",
                "tokenId",
                "amount",
                "startedAtMs",
                "originated",
                "inboundEntity",
                "outboundEntity",
                "inboundSettled",
                "outboundSettled",
                "secret",
                "secretAckPending",
                "secretAckStartedAt",
                "secretAckDeadlineAt",
                "pendingFee",
                "createdTimestamp",
            ],
            "paybook.entries.value",
        )?;
        let hashlock = text(
            required(route, "hashlock", "paybook.entries.value")?,
            "hashlock",
        )?;
        if key != hashlock {
            return Err(invalid(format!("ROUTE_KEY:{key}:{hashlock}")));
        }
        let route = PaybookEntry {
            hashlock,
            description: optional(route.get("description"), |value| {
                text(value, "route.description")
            })?,
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
            outbound_entity: optional(route.get("outboundEntity"), |value| {
                text(value, "route.outboundEntity")
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
                required(route, "createdTimestamp", "paybook.entries.value")?,
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

fn lending_state(value: &Value) -> Result<LendingState, EntitySnapshotRestoreError> {
    let canonical = canonical_value_from_tagged_json(value)
        .map_err(|error| invalid(format!("LENDING_CANONICAL:{error}")))?;
    xln_rscore_entity_kernel::decode_canonical_lending_state(&canonical)
        .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))
}

fn entity_collection(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<EntityCanonicalCollection>, EntitySnapshotRestoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let entries = tagged_rows(value, path)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let row = row
                .as_array()
                .filter(|row| row.len() == 2)
                .ok_or_else(|| invalid(format!("MAP_ROW:{path}:{index}")))?;
            let key = row[0]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!("MAP_KEY:{path}:{index}")))?;
            Ok((
                key.to_string(),
                canonical_value_from_tagged_json(&row[1])
                    .map_err(|error| invalid(format!("CANONICAL:{path}:{index}:{error}")))?,
            ))
        })
        .collect::<Result<Vec<_>, EntitySnapshotRestoreError>>()?;
    EntityCanonicalCollection::from_entries(entries)
        .map(Some)
        .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))
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
    let paybook = object(required(core, "paybook", "core")?, "core.paybook")?;
    exact_allowed(paybook, &["entries", "feesEarned"], "core.paybook")?;
    let state = EntityStateSlice {
        entity_id,
        height: unsigned(required(core, "height", "core")?, "core.height")?,
        timestamp: unsigned(required(core, "timestamp", "core")?, "core.timestamp")?,
        entity_command_nonces: command_nonces(core.get("entityCommandNonces"))?,
        proposals: xln_rscore_entity_kernel::decode_canonical_entity_proposals(
            &canonical_value_from_tagged_json(required(core, "proposals", "core")?)
                .map_err(|error| invalid(format!("PROPOSALS:{error}")))?,
        )
        .map_err(|error| invalid(format!("PROPOSALS:{error}")))?,
        last_finalized_j_height: unsigned(
            required(core, "lastFinalizedJHeight", "core")?,
            "core.lastFinalizedJHeight",
        )?,
        reserves: reserves(required(core, "reserves", "core")?)?,
        external_wallet: core
            .get("externalWallet")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("EXTERNAL_WALLET:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_external_wallet)
            .transpose()
            .map_err(|error| invalid(format!("EXTERNAL_WALLET:{error}")))?,
        deferred_account_proposals: entity_collection(
            core.get("deferredAccountProposals"),
            "deferredAccountProposals",
        )?,
        settlement_continuations: entity_collection(
            core.get("settlementContinuations"),
            "settlementContinuations",
        )?,
        out_debts_by_token: core
            .get("outDebtsByToken")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("OUT_DEBTS:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_debt_ledger)
            .transpose()
            .map_err(|error| invalid(format!("OUT_DEBTS:{error}")))?,
        in_debts_by_token: core
            .get("inDebtsByToken")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("IN_DEBTS:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_debt_ledger)
            .transpose()
            .map_err(|error| invalid(format!("IN_DEBTS:{error}")))?,
        entity_encryption_public_key: hex32_bytes(
            required(core, "entityEncryptionPublicKey", "core")?,
            "core.entityEncryptionPublicKey",
        )?,
        profile: profile(required(core, "profile", "core")?)?,
        j_batch_state: core
            .get("jBatchState")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("J_BATCH_STATE:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_j_batch_state)
            .transpose()
            .map_err(|error| invalid(format!("J_BATCH_STATE:{error}")))?,
        entity_provider_action_state: core
            .get("entityProviderActionState")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("ENTITY_PROVIDER_ACTION_STATE:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_entity_provider_action_state)
            .transpose()
            .map_err(|error| invalid(format!("ENTITY_PROVIDER_ACTION_STATE:{error}")))?,
        certified_board_state: core
            .get("certifiedBoardState")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("CERTIFIED_BOARD_STATE:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_certified_board_state)
            .transpose()
            .map_err(|error| invalid(format!("CERTIFIED_BOARD_STATE:{error}")))?,
        known_accounts: known_accounts.into(),
        paybook: PaybookState::from_entries(
            paybook_entries(required(paybook, "entries", "core.paybook")?)?.into_values(),
            bigint(
                required(paybook, "feesEarned", "core.paybook")?,
                "core.paybook.feesEarned",
            )?,
        )
        .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))?,
        crontab: entity_checkpoint_crontab(&wrap_core(graph.core.clone()))?,
        hub_rebalance_config: core
            .get("hubRebalanceConfig")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("HUB_REBALANCE_CONFIG:{error}")))?,
        orderbook: orderbook
            .as_ref()
            .map(|value| value.snapshot.clone())
            .map(xln_rscore_entity_kernel::OrderbookState::restore)
            .transpose()
            .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))?,
        orderbook_metadata: orderbook.as_ref().map(|value| value.metadata.clone()),
        swap_trading_pairs: core
            .get("swapTradingPairs")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("SWAP_TRADING_PAIRS:{error}")))?
            .as_ref()
            .map(xln_rscore_entity_kernel::decode_canonical_swap_trading_pairs)
            .transpose()
            .map_err(|error| invalid(format!("SWAP_TRADING_PAIRS:{error}")))?,
        lending: core.get("lending").map(lending_state).transpose()?,
        cross_jurisdiction_swaps: entity_collection(
            core.get("crossJurisdictionSwaps"),
            "crossJurisdictionSwaps",
        )?,
        cross_jurisdiction_authorizations: entity_collection(
            core.get("crossJurisdictionAuthorizations"),
            "crossJurisdictionAuthorizations",
        )?,
        pending_cross_jurisdiction_fill_acks: entity_collection(
            core.get("pendingCrossJurisdictionFillAcks"),
            "pendingCrossJurisdictionFillAcks",
        )?,
        cross_jurisdiction_book_admissions: entity_collection(
            core.get("crossJurisdictionBookAdmissions"),
            "crossJurisdictionBookAdmissions",
        )?,
        j_history_finality: core
            .get("jHistoryFinality")
            .map(canonical_value_from_tagged_json)
            .transpose()
            .map_err(|error| invalid(format!("J_HISTORY_FINALITY:{error}")))?,
    };
    let expected_owned_sections =
        compute_entity_owned_sections(&state, accounts_root, state.known_accounts.len())
            .map_err(|error| EntitySnapshotRestoreError::Kernel(error.to_string()))?;
    Ok(EntityStateSnapshot {
        entity_id: state.entity_id,
        height: state.height,
        timestamp: state.timestamp,
        entity_command_nonces: state.entity_command_nonces,
        proposals: state.proposals,
        last_finalized_j_height: state.last_finalized_j_height,
        reserves: state.reserves,
        out_debts_by_token: state.out_debts_by_token,
        in_debts_by_token: state.in_debts_by_token,
        external_wallet: state.external_wallet,
        deferred_account_proposals: state.deferred_account_proposals,
        settlement_continuations: state.settlement_continuations,
        entity_encryption_public_key: state.entity_encryption_public_key,
        profile: state.profile,
        j_batch_state: state.j_batch_state,
        entity_provider_action_state: state.entity_provider_action_state,
        certified_board_state: state.certified_board_state,
        known_accounts: state.known_accounts.iter().cloned().collect(),
        paybook: state.paybook,
        crontab: state.crontab,
        hub_rebalance_config: state.hub_rebalance_config,
        orderbook: orderbook.map(|value| value.snapshot),
        orderbook_metadata: state.orderbook_metadata,
        swap_trading_pairs: state.swap_trading_pairs,
        lending: state.lending,
        cross_jurisdiction_swaps: state.cross_jurisdiction_swaps,
        cross_jurisdiction_authorizations: state.cross_jurisdiction_authorizations,
        pending_cross_jurisdiction_fill_acks: state.pending_cross_jurisdiction_fill_acks,
        cross_jurisdiction_book_admissions: state.cross_jurisdiction_book_admissions,
        j_history_finality: state.j_history_finality,
        expected_owned_sections,
    })
}
