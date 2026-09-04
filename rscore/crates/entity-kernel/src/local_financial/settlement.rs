use ethabi::ethereum_types::U256;
use xln_rscore_engine::{AccountTx, settlement_workspace_body_hash, validate_settlement_ops};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::j_batch::{CollateralToReserve, Settlement, SettlementDiff};
use crate::{EntityCanonicalCollection, EntityFrameEvent, EntityKernelError, EntityStateSlice};

use super::types::{
    LocalAccountFinancialView, SettleApproveEntityTx, SettleExecuteEntityTx, SettleProposeEntityTx,
    SettleRejectEntityTx, SettleUpdateEntityTx,
};

fn invalid(kind: &'static str, detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local(kind, detail.into())
}

fn view<'a>(
    views: &'a std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account: &str,
    kind: &'static str,
) -> Result<&'a LocalAccountFinancialView, EntityKernelError> {
    views
        .get(account)
        .ok_or_else(|| invalid(kind, format!("ACCOUNT_VIEW_MISSING:{account}")))
}

fn object<'a>(
    value: &'a CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid(kind, detail)),
    }
}

fn field<'a>(fields: &'a [(String, CanonicalValue)], name: &str) -> Option<&'a CanonicalValue> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn required<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &'static str,
    kind: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    field(fields, name).ok_or_else(|| invalid(kind, format!("WORKSPACE_FIELD_MISSING:{name}")))
}

fn string<'a>(
    value: &'a CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<&'a str, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value),
        _ => Err(invalid(kind, detail)),
    }
}

fn boolean(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<bool, EntityKernelError> {
    match value {
        CanonicalValue::Bool(value) => Ok(*value),
        _ => Err(invalid(kind, detail)),
    }
}

fn number(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<u64, EntityKernelError> {
    let CanonicalValue::Number(value) = value else {
        return Err(invalid(kind, detail));
    };
    value
        .as_str()
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(kind, detail))
}

fn canonical_entity(value: &CanonicalValue, kind: &'static str) -> Result<(), EntityKernelError> {
    let value = string(value, kind, "CONTINUATION_ENTITY_INVALID")?;
    let valid = value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64
            && payload.bytes().all(|byte| byte.is_ascii_hexdigit())
            && value == value.to_lowercase()
    });
    if valid {
        Ok(())
    } else {
        Err(invalid(kind, "CONTINUATION_ENTITY_INVALID"))
    }
}

fn validate_continuation(value: &CanonicalValue) -> Result<(), EntityKernelError> {
    const KIND: &str = "settle_propose";
    let fields = object(value, KIND, "CONTINUATION_OBJECT")?;
    if fields.len() != 2
        || field(fields, "actions").is_none()
        || field(fields, "broadcast").is_none()
    {
        return Err(invalid(KIND, "CONTINUATION_FIELDS"));
    }
    let CanonicalValue::Array(actions) = required(fields, "actions", KIND)? else {
        return Err(invalid(KIND, "CONTINUATION_ACTIONS"));
    };
    if actions.len() > 1 {
        return Err(invalid(KIND, "CONTINUATION_ACTION_LIMIT_EXCEEDED"));
    }
    boolean(
        required(fields, "broadcast", KIND)?,
        KIND,
        "CONTINUATION_BROADCAST",
    )?;
    for action in actions {
        let action = object(action, KIND, "CONTINUATION_ACTION_OBJECT")?;
        let action_type = string(
            required(action, "type", KIND)?,
            KIND,
            "CONTINUATION_ACTION_TYPE",
        )?;
        let expected = match action_type {
            "r2r" => &["type", "toEntityId", "tokenId", "amount"][..],
            "r2e" => &["type", "receivingEntity", "tokenId", "amount"][..],
            "r2c" => {
                let valid = action.iter().all(|(key, _)| {
                    matches!(
                        key.as_str(),
                        "type" | "counterpartyId" | "receivingEntityId" | "tokenId" | "amount"
                    )
                }) && field(action, "counterpartyId").is_some()
                    && field(action, "tokenId").is_some()
                    && field(action, "amount").is_some();
                if !valid {
                    return Err(invalid(KIND, "CONTINUATION_ACTION_FIELDS"));
                }
                canonical_entity(required(action, "counterpartyId", KIND)?, KIND)?;
                if let Some(receiving) = field(action, "receivingEntityId") {
                    canonical_entity(receiving, KIND)?;
                }
                &[][..]
            }
            _ => return Err(invalid(KIND, "CONTINUATION_ACTION_TYPE")),
        };
        if !expected.is_empty()
            && (action.len() != expected.len()
                || expected.iter().any(|name| field(action, name).is_none()))
        {
            return Err(invalid(KIND, "CONTINUATION_ACTION_FIELDS"));
        }
        match action_type {
            "r2r" => canonical_entity(required(action, "toEntityId", KIND)?, KIND)?,
            "r2e" => canonical_entity(required(action, "receivingEntity", KIND)?, KIND)?,
            "r2c" => {}
            _ => unreachable!(),
        }
        let token = number(
            required(action, "tokenId", KIND)?,
            KIND,
            "CONTINUATION_TOKEN_INVALID",
        )?;
        if u32::try_from(token).is_err() {
            return Err(invalid(KIND, "CONTINUATION_TOKEN_INVALID"));
        }
        match required(action, "amount", KIND)? {
            CanonicalValue::BigInt(amount) if amount > &0.into() => {}
            _ => return Err(invalid(KIND, "CONTINUATION_AMOUNT_INVALID")),
        }
    }
    Ok(())
}

fn local_is_left(state: &EntityStateSlice, peer: &str) -> bool {
    state.entity_id.as_str() < peer
}

fn pending(view: &LocalAccountFinancialView, kind: &'static str) -> Result<(), EntityKernelError> {
    if view.settlement_transition_pending {
        Err(invalid(kind, "SETTLEMENT_TRANSITION_ALREADY_PENDING"))
    } else {
        Ok(())
    }
}

fn workspace_fields<'a>(
    view: &'a LocalAccountFinancialView,
    kind: &'static str,
) -> Result<Option<&'a [(String, CanonicalValue)]>, EntityKernelError> {
    view.settlement_workspace
        .as_ref()
        .map(|value| object(value, kind, "SETTLEMENT_WORKSPACE_OBJECT_REQUIRED"))
        .transpose()
}

fn number_value(value: u64, kind: &'static str) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| invalid(kind, error.to_string()))
}

pub(crate) fn apply_committed_settlement_followup(
    state: &mut EntityStateSlice,
    counterparty: &str,
    tx: &AccountTx,
    is_last_settlement_transition: bool,
    proposer_is_left: bool,
    view: Option<&LocalAccountFinancialView>,
) -> Result<bool, EntityKernelError> {
    const KIND: &str = "settle_transition";
    let AccountTx::SettleTransition { data } = tx else {
        return Ok(false);
    };
    let transition = object(data, KIND, "SETTLEMENT_TRANSITION_OBJECT")?;
    let transition_kind = string(
        required(transition, "kind", KIND)?,
        KIND,
        "SETTLEMENT_TRANSITION_KIND",
    )?;
    if !matches!(transition_kind, "upsert" | "hanko") || !is_last_settlement_transition {
        return Ok(true);
    }
    let view = view.ok_or_else(|| invalid(KIND, format!("ACCOUNT_VIEW_MISSING:{counterparty}")))?;
    let workspace_value = view
        .settlement_workspace
        .as_ref()
        .ok_or_else(|| invalid(KIND, "COMMITTED_WORKSPACE_MISSING"))?;
    let workspace = object(
        workspace_value,
        KIND,
        "SETTLEMENT_WORKSPACE_OBJECT_REQUIRED",
    )?;
    let revision = number(required(workspace, "revision", KIND)?, KIND, "REVISION")?;
    let transition_revision = number(
        required(transition, "revision", KIND)?,
        KIND,
        "TRANSITION_REVISION",
    )?;
    if revision != transition_revision {
        return Err(invalid(
            KIND,
            format!("COMMITTED_VERSION_MISMATCH:{revision}:{transition_revision}"),
        ));
    }
    let local_is_left = local_is_left(state, counterparty);
    if proposer_is_left == local_is_left {
        return Ok(true);
    }
    let local_post_hanko = field(workspace, "postSettlementDisputeProof")
        .and_then(|proof| object(proof, KIND, "POST_SETTLEMENT_PROOF_OBJECT").ok())
        .and_then(|proof| {
            field(
                proof,
                if local_is_left {
                    "leftHanko"
                } else {
                    "rightHanko"
                },
            )
        })
        .is_some();
    if local_post_hanko || view.settlement_transition_pending {
        return Ok(true);
    }
    let last_modified_by_left = boolean(
        required(workspace, "lastModifiedByLeft", KIND)?,
        KIND,
        "LAST_MODIFIED_BY_LEFT",
    )?;
    let locally_authored = last_modified_by_left == local_is_left;
    let CanonicalValue::Array(ops) = required(workspace, "ops", KIND)? else {
        return Err(invalid(KIND, "WORKSPACE_OPS_ARRAY"));
    };
    if !locally_authored
        && !xln_rscore_engine::can_auto_approve_settlement_ops(
            ops,
            last_modified_by_left,
            local_is_left,
        )
        .map_err(|detail| invalid(KIND, detail))?
    {
        return Ok(true);
    }
    let workspace_hash = string(
        required(workspace, "workspaceHash", KIND)?,
        KIND,
        "WORKSPACE_HASH",
    )?;
    let deferred = state
        .deferred_account_proposals
        .get_or_insert_with(EntityCanonicalCollection::empty);
    if let Some(existing) = deferred.get(counterparty)
        && existing != &CanonicalValue::String(workspace_hash.into())
    {
        return Err(invalid(
            KIND,
            format!("APPROVAL_ALREADY_DEFERRED:{counterparty}"),
        ));
    }
    deferred.insert(
        counterparty.to_string(),
        CanonicalValue::String(workspace_hash.into()),
    )?;
    Ok(true)
}

pub(super) fn apply_propose(
    state: &mut EntityStateSlice,
    tx: SettleProposeEntityTx,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    const KIND: &str = "settle_propose";
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return Err(invalid(KIND, "ACCOUNT_MISSING"));
    }
    let account = view(views, &tx.counterparty_entity_id, KIND)?;
    if let Some(fields) = workspace_fields(account, KIND)? {
        let revision = number(required(fields, "revision", KIND)?, KIND, "REVISION")?;
        events.push(EntityFrameEvent::Status {
            message: format!(
                "⏭️ Settlement propose skipped: workspace already exists (v{revision})"
            ),
        });
        return Ok(());
    }
    pending(account, KIND)?;
    let proposer_is_left = local_is_left(state, &tx.counterparty_entity_id);
    validate_settlement_ops(&tx.ops, proposer_is_left).map_err(|detail| invalid(KIND, detail))?;
    let executor_is_left = tx.executor_is_left.unwrap_or(proposer_is_left);
    if let Some(continuation) = tx.continuation.as_ref() {
        validate_continuation(continuation)?;
        if executor_is_left != proposer_is_left {
            return Err(invalid(
                KIND,
                "SETTLEMENT_CONTINUATION_REQUIRES_LOCAL_EXECUTOR",
            ));
        }
        let (left, right) = if proposer_is_left {
            (state.entity_id.as_str(), tx.counterparty_entity_id.as_str())
        } else {
            (tx.counterparty_entity_id.as_str(), state.entity_id.as_str())
        };
        let workspace_hash = settlement_workspace_body_hash(
            left,
            right,
            1,
            &tx.ops,
            proposer_is_left,
            executor_is_left,
            tx.memo.as_deref(),
        )
        .map_err(|detail| invalid(KIND, detail))?;
        let continuation_fields = object(continuation, KIND, "CONTINUATION_OBJECT")?;
        let value = CanonicalValue::Object(vec![
            (
                "workspaceHash".into(),
                CanonicalValue::String(workspace_hash),
            ),
            (
                "actions".into(),
                required(continuation_fields, "actions", KIND)?.clone(),
            ),
            (
                "broadcast".into(),
                required(continuation_fields, "broadcast", KIND)?.clone(),
            ),
        ]);
        let continuations = state
            .settlement_continuations
            .get_or_insert_with(EntityCanonicalCollection::empty);
        if continuations.get(&tx.counterparty_entity_id).is_some() {
            return Err(invalid(KIND, "SETTLEMENT_CONTINUATION_ALREADY_PENDING"));
        }
        continuations.insert(tx.counterparty_entity_id.clone(), value)?;
    }
    let mut data = vec![
        ("kind".into(), CanonicalValue::String("upsert".into())),
        ("revision".into(), number_value(1, KIND)?),
        ("ops".into(), CanonicalValue::Array(tx.ops)),
        (
            "executorIsLeft".into(),
            CanonicalValue::Bool(executor_is_left),
        ),
    ];
    if let Some(memo) = tx.memo {
        data.push(("memo".into(), CanonicalValue::String(memo)));
    }
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SettleTransition {
            data: CanonicalValue::Object(data),
        },
    ));
    events.push(EntityFrameEvent::Status {
        message: "⚖️ Settlement proposal queued for bilateral Account consensus".into(),
    });
    Ok(())
}

pub(super) fn apply_update(
    state: &EntityStateSlice,
    tx: SettleUpdateEntityTx,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    const KIND: &str = "settle_update";
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return Err(invalid(KIND, "ACCOUNT_MISSING"));
    }
    let account = view(views, &tx.counterparty_entity_id, KIND)?;
    pending(account, KIND)?;
    let fields =
        workspace_fields(account, KIND)?.ok_or_else(|| invalid(KIND, "WORKSPACE_MISSING"))?;
    if field(fields, "leftHanko").is_some() || field(fields, "rightHanko").is_some() {
        return Err(invalid(
            KIND,
            "SETTLEMENT_WORKSPACE_SIGNED_UPDATE_FORBIDDEN",
        ));
    }
    let proposer_is_left = local_is_left(state, &tx.counterparty_entity_id);
    validate_settlement_ops(&tx.ops, proposer_is_left).map_err(|detail| invalid(KIND, detail))?;
    let revision = number(required(fields, "revision", KIND)?, KIND, "REVISION")?
        .checked_add(1)
        .ok_or_else(|| invalid(KIND, "REVISION_OVERFLOW"))?;
    let previous_hash = string(
        required(fields, "workspaceHash", KIND)?,
        KIND,
        "WORKSPACE_HASH",
    )?;
    let executor = tx.executor_is_left.unwrap_or(boolean(
        required(fields, "executorIsLeft", KIND)?,
        KIND,
        "EXECUTOR_IS_LEFT",
    )?);
    let effective_memo = tx.memo.or_else(|| {
        field(fields, "memo").and_then(|value| match value {
            CanonicalValue::String(value) => Some(value.clone()),
            _ => None,
        })
    });
    let mut data = vec![
        ("kind".into(), CanonicalValue::String("upsert".into())),
        ("revision".into(), number_value(revision, KIND)?),
        (
            "previousWorkspaceHash".into(),
            CanonicalValue::String(previous_hash.into()),
        ),
        ("ops".into(), CanonicalValue::Array(tx.ops)),
        ("executorIsLeft".into(), CanonicalValue::Bool(executor)),
    ];
    if let Some(memo) = effective_memo {
        data.push(("memo".into(), CanonicalValue::String(memo)));
    }
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SettleTransition {
            data: CanonicalValue::Object(data),
        },
    ));
    events.push(EntityFrameEvent::Status {
        message: format!("⚖️ Settlement update v{revision} queued for bilateral Account consensus"),
    });
    Ok(())
}

pub(super) fn apply_approve(
    state: &mut EntityStateSlice,
    tx: SettleApproveEntityTx,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    const KIND: &str = "settle_approve";
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return Err(invalid(KIND, "ACCOUNT_MISSING"));
    }
    let account = view(views, &tx.counterparty_entity_id, KIND)?;
    pending(account, KIND)?;
    let fields =
        workspace_fields(account, KIND)?.ok_or_else(|| invalid(KIND, "WORKSPACE_MISSING"))?;
    if string(required(fields, "status", KIND)?, KIND, "WORKSPACE_STATUS")? == "submitted" {
        events.push(EntityFrameEvent::Status {
            message: "⏭️ settle_execute skipped: workspace already submitted".into(),
        });
        return Ok(());
    }
    let canonical_hash = string(
        required(fields, "workspaceHash", KIND)?,
        KIND,
        "WORKSPACE_HASH",
    )?;
    if canonical_hash != tx.workspace_hash {
        return Err(invalid(
            KIND,
            format!(
                "SETTLEMENT_APPROVAL_WORKSPACE_HASH_MISMATCH:{}:{}",
                tx.workspace_hash, canonical_hash
            ),
        ));
    }
    let deferred = state
        .deferred_account_proposals
        .get_or_insert_with(EntityCanonicalCollection::empty);
    if let Some(existing) = deferred.get(&tx.counterparty_entity_id)
        && existing != &CanonicalValue::String(canonical_hash.into())
    {
        return Err(invalid(KIND, "SETTLEMENT_APPROVAL_ALREADY_DEFERRED"));
    }
    deferred.insert(
        tx.counterparty_entity_id,
        CanonicalValue::String(canonical_hash.into()),
    )?;
    events.push(EntityFrameEvent::Status {
        message: "⚖️ Settlement approval accepted; waiting for prior Account work".into(),
    });
    Ok(())
}

pub(super) fn apply_reject(
    state: &EntityStateSlice,
    tx: SettleRejectEntityTx,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    const KIND: &str = "settle_reject";
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return Err(invalid(KIND, "ACCOUNT_MISSING"));
    }
    let account = view(views, &tx.counterparty_entity_id, KIND)?;
    let Some(fields) = workspace_fields(account, KIND)? else {
        return Ok(());
    };
    pending(account, KIND)?;
    if [
        "settlementHash",
        "leftHanko",
        "rightHanko",
        "postSettlementDisputeProof",
    ]
    .iter()
    .any(|name| field(fields, name).is_some())
    {
        return Err(invalid(KIND, "SETTLEMENT_REJECT_SIGNED_FORBIDDEN"));
    }
    let revision = number(required(fields, "revision", KIND)?, KIND, "REVISION")?;
    let workspace_hash = string(
        required(fields, "workspaceHash", KIND)?,
        KIND,
        "WORKSPACE_HASH",
    )?;
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SettleTransition {
            data: CanonicalValue::Object(vec![
                ("kind".into(), CanonicalValue::String("clear".into())),
                ("revision".into(), number_value(revision, KIND)?),
                (
                    "workspaceHash".into(),
                    CanonicalValue::String(workspace_hash.into()),
                ),
            ]),
        },
    ));
    events.push(EntityFrameEvent::Status {
        message: match tx.reason {
            Some(reason) => format!("❌ Settlement clear queued: {reason}"),
            None => "❌ Settlement clear queued".into(),
        },
    });
    Ok(())
}

fn entity_word(value: &str, kind: &'static str) -> Result<[u8; 32], EntityKernelError> {
    let payload = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid(kind, "ENTITY_ID_INVALID"))?;
    if payload.len() != 64 {
        return Err(invalid(kind, "ENTITY_ID_INVALID"));
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(kind, "ENTITY_ID_INVALID"))?;
    }
    Ok(output)
}

fn positive_u256(
    value: &num_bigint::BigInt,
    kind: &'static str,
) -> Result<U256, EntityKernelError> {
    if value <= &num_bigint::BigInt::from(0) {
        return Err(invalid(kind, "SETTLEMENT_C2R_AMOUNT_INVALID"));
    }
    U256::from_dec_str(&value.to_string())
        .map_err(|_| invalid(kind, "SETTLEMENT_C2R_AMOUNT_INVALID"))
}

fn batch_op_count(batch: &crate::JBatch) -> usize {
    batch.reserve_to_reserve.len()
        + batch.reserve_to_collateral.len()
        + batch.collateral_to_reserve.len()
        + batch.settlements.len()
        + batch.dispute_starts.len()
        + batch.counter_disputes.len()
        + batch.dispute_finalizations.len()
        + batch.external_token_to_reserve.len()
        + batch.reserve_to_external_token.len()
        + batch.reveal_secrets.len()
        + batch.hash_ladder_registrations.len()
}

fn add_settlement_to_batch(
    state: &mut EntityStateSlice,
    counterparty: &str,
    disable_c2r_shortcut: bool,
    prepared: &xln_rscore_engine::PreparedSettlementExecution,
) -> Result<bool, EntityKernelError> {
    const KIND: &str = "settle_execute";
    let local_is_left = local_is_left(state, counterparty);
    let (left_text, right_text) = if local_is_left {
        (state.entity_id.as_str(), counterparty)
    } else {
        (counterparty, state.entity_id.as_str())
    };
    let left_entity = entity_word(left_text, KIND)?;
    let right_entity = entity_word(right_text, KIND)?;
    let candidate = Settlement {
        left_entity,
        right_entity,
        diffs: prepared
            .diffs
            .iter()
            .map(|diff| SettlementDiff {
                token_id: U256::from(diff.token_id.get()),
                left_diff: diff.left_diff.clone(),
                right_diff: diff.right_diff.clone(),
                collateral_diff: diff.collateral_diff.clone(),
                ondelta_diff: diff.ondelta_diff.clone(),
            })
            .collect(),
        forgive_debts_in_token_ids: prepared
            .forgive_token_ids
            .iter()
            .map(|token| U256::from(token.get()))
            .collect(),
        sig: prepared.counterparty_hanko.clone(),
        nonce: U256::from(prepared.nonce),
    };
    if candidate.diffs.len() > 32 || candidate.forgive_debts_in_token_ids.len() > 32 {
        return Err(invalid(KIND, "J_BATCH_SETTLEMENT_ROW_LIMIT_EXCEEDED"));
    }
    let batch = state
        .j_batch_state
        .get_or_insert_with(crate::JBatchState::default);
    if batch.sent_batch.is_some() {
        return Ok(false);
    }
    if let Some(existing) = batch.batch.settlements.iter().find(|existing| {
        existing.left_entity == left_entity && existing.right_entity == right_entity
    }) {
        if existing == &candidate {
            return Ok(true);
        }
        return Err(invalid(KIND, "J_BATCH_SETTLEMENT_CONFLICT"));
    }

    let zero = num_bigint::BigInt::from(0);
    let pure_c2r = if candidate.diffs.len() == 1 && candidate.forgive_debts_in_token_ids.is_empty()
    {
        let diff = &candidate.diffs[0];
        if diff.collateral_diff < zero {
            let amount = -&diff.collateral_diff;
            if diff.left_diff == amount && diff.right_diff == zero && diff.ondelta_diff == -&amount
            {
                Some((true, diff.token_id, amount))
            } else if diff.left_diff == zero
                && diff.right_diff == amount
                && diff.ondelta_diff == zero
            {
                Some((false, diff.token_id, amount))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    let shortcut = pure_c2r.filter(|(withdrawer_is_left, _, _)| {
        !disable_c2r_shortcut && *withdrawer_is_left == local_is_left
    });
    let pair_counterparty = shortcut
        .as_ref()
        .map(|(withdrawer_is_left, _, _)| {
            if *withdrawer_is_left {
                right_entity
            } else {
                left_entity
            }
        })
        .unwrap_or(if local_is_left {
            right_entity
        } else {
            left_entity
        });
    if let Some(existing) = batch
        .batch
        .collateral_to_reserve
        .iter()
        .find(|existing| existing.counterparty == pair_counterparty)
    {
        let exact = shortcut.as_ref().is_some_and(|(_, token, amount)| {
            positive_u256(amount, KIND).is_ok_and(|amount| {
                existing.token_id == *token
                    && existing.amount == amount
                    && existing.nonce == candidate.nonce
                    && existing.sig == candidate.sig
            })
        });
        if exact {
            return Ok(true);
        }
        return Err(invalid(KIND, "J_BATCH_SETTLEMENT_CONFLICT"));
    }
    if batch_op_count(&batch.batch) >= 50 {
        return Err(invalid(KIND, "J_BATCH_LIMIT_EXCEEDED:total_ops:51/50"));
    }
    if let Some((withdrawer_is_left, token_id, amount)) = shortcut {
        batch.batch.collateral_to_reserve.push(CollateralToReserve {
            counterparty: if withdrawer_is_left {
                right_entity
            } else {
                left_entity
            },
            token_id,
            amount: positive_u256(&amount, KIND)?,
            nonce: candidate.nonce,
            sig: candidate.sig,
        });
    } else {
        if batch.batch.settlements.len() >= 32 {
            return Err(invalid(KIND, "J_BATCH_LIMIT_EXCEEDED:settlements:33/32"));
        }
        batch.batch.settlements.push(candidate);
    }
    if batch.status == crate::JBatchStatus::Empty {
        batch.status = crate::JBatchStatus::Accumulating;
    }
    Ok(true)
}

pub(super) fn apply_execute(
    state: &mut EntityStateSlice,
    tx: SettleExecuteEntityTx,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    const KIND: &str = "settle_execute";
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "⏭️ settle_execute skipped: no account with {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        });
        return Ok(());
    }
    let account = view(views, &tx.counterparty_entity_id, KIND)?;
    let Some(fields) = workspace_fields(account, KIND)? else {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "⏭️ settle_execute skipped: no workspace with {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        });
        return Ok(());
    };
    pending(account, KIND)?;
    let workspace_hash = string(
        required(fields, "workspaceHash", KIND)?,
        KIND,
        "WORKSPACE_HASH",
    )?;
    if string(required(fields, "status", KIND)?, KIND, "WORKSPACE_STATUS")? == "submitted" {
        events.push(EntityFrameEvent::Status {
            message: "⏭️ settle_execute skipped: settlement already submitted".into(),
        });
        return Ok(());
    }
    let local_left = local_is_left(state, &tx.counterparty_entity_id);
    if boolean(
        required(fields, "executorIsLeft", KIND)?,
        KIND,
        "EXECUTOR_IS_LEFT",
    )? != local_left
    {
        return Err(invalid(KIND, "SETTLEMENT_EXECUTOR_MISMATCH"));
    }
    let peer_hanko = if local_left {
        "rightHanko"
    } else {
        "leftHanko"
    };
    if field(fields, peer_hanko).is_none() {
        events.push(EntityFrameEvent::Status {
            message: "⏭️ settle_execute skipped: missing counterparty signature".into(),
        });
        return Ok(());
    }
    let prepared = account
        .settlement_execution
        .as_ref()
        .map_err(|detail| invalid(KIND, detail.clone()))?;
    if !add_settlement_to_batch(
        state,
        &tx.counterparty_entity_id,
        tx.disable_c2r_shortcut,
        prepared,
    )? {
        events.push(EntityFrameEvent::Status {
            message: "⏭️ settle_execute skipped: jBatch sentBatch pending".into(),
        });
        return Ok(());
    }
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SettleTransition {
            data: CanonicalValue::Object(vec![
                ("kind".into(), CanonicalValue::String("submit".into())),
                ("revision".into(), number_value(prepared.revision, KIND)?),
                (
                    "workspaceHash".into(),
                    CanonicalValue::String(workspace_hash.into()),
                ),
            ]),
        },
    ));
    events.push(EntityFrameEvent::Status {
        message: format!(
            "✅ Settlement submission queued ({} diffs) - use j_broadcast to commit",
            prepared.diffs.len()
        ),
    });
    Ok(())
}

#[cfg(test)]
mod committed_tests {
    use std::collections::BTreeMap;

    use super::*;

    fn n(value: u64) -> CanonicalValue {
        CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe number"))
    }

    fn financial_view(workspace: CanonicalValue) -> LocalAccountFinancialView {
        LocalAccountFinancialView {
            active: true,
            owner_side: xln_rscore_engine::Side::Left,
            owner_out_capacity: BTreeMap::new(),
            owner_peer_credit_limit: BTreeMap::new(),
            settlement_workspace: Some(workspace),
            settlement_transition_pending: false,
            settlement_execution: Err("not executable yet".into()),
            rebalance_active_quote: None,
            htlc_locks: BTreeMap::new(),
            pulls: BTreeMap::new(),
            swap_offers: BTreeMap::new(),
            pending_cross_pull_close_ids: Default::default(),
            pending_cross_swap_ack_ids: Default::default(),
            dispute: None,
        }
    }

    #[test]
    fn peer_committed_safe_final_workspace_defers_exact_account_approval() {
        let local = format!("0x{}", "11".repeat(32));
        let peer = format!("0x{}", "22".repeat(32));
        let workspace_hash = format!("0x{}", "33".repeat(32));
        let workspace = CanonicalValue::Object(vec![
            ("revision".into(), n(1)),
            (
                "workspaceHash".into(),
                CanonicalValue::String(workspace_hash.clone()),
            ),
            ("lastModifiedByLeft".into(), CanonicalValue::Bool(false)),
            (
                "ops".into(),
                CanonicalValue::Array(vec![CanonicalValue::Object(vec![
                    ("type".into(), CanonicalValue::String("r2r".into())),
                    ("tokenId".into(), n(1)),
                    ("amount".into(), CanonicalValue::BigInt(10.into())),
                ])]),
            ),
        ]);
        let view = financial_view(workspace);
        let tx = AccountTx::SettleTransition {
            data: CanonicalValue::Object(vec![
                ("kind".into(), CanonicalValue::String("upsert".into())),
                ("revision".into(), n(1)),
            ]),
        };
        let mut state = EntityStateSlice::empty(local, 1_000);
        assert!(
            apply_committed_settlement_followup(&mut state, &peer, &tx, true, false, Some(&view),)
                .expect("committed settlement followup")
        );
        assert_eq!(
            state
                .deferred_account_proposals
                .as_ref()
                .and_then(|entries| entries.get(&peer)),
            Some(&CanonicalValue::String(workspace_hash))
        );
    }

    #[test]
    fn unsafe_raw_diff_never_auto_approves() {
        let ops = vec![CanonicalValue::Object(vec![
            ("type".into(), CanonicalValue::String("rawDiff".into())),
            ("tokenId".into(), n(1)),
            ("leftDiff".into(), CanonicalValue::BigInt(0.into())),
            ("rightDiff".into(), CanonicalValue::BigInt(0.into())),
            ("collateralDiff".into(), CanonicalValue::BigInt(0.into())),
            ("ondeltaDiff".into(), CanonicalValue::BigInt((-1).into())),
        ])];
        assert!(
            !xln_rscore_engine::can_auto_approve_settlement_ops(&ops, false, true)
                .expect("auto-approve policy")
        );
    }
}
