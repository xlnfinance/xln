//! Projection of already-committed cross-j Account transactions into Entity.
//!
//! Account consensus is the financial authority. This module performs only
//! the canonical parent follow-up that TypeScript performs after the Account
//! frame commits: advance the one route value, update the one shared book and
//! emit the next Entity/Account work. It never reconstructs Account history.

use num_bigint::BigInt;
use xln_rscore_engine::AccountTx;
use xln_rscore_protocol::CanonicalValue;

use crate::orderbook::SameJOutputDelta;
use crate::scheduler::{ScheduledHook, ScheduledHookKind, cancel_hook, schedule_hook};
use crate::{EntityKernelError, EntityStateSlice, EntityTxKind};

use super::{
    CrossJurisdictionApplyResult, bigint, canonical_bool, close_binary_hash, collection,
    committed_fill, exact_fill, field, nested_text, normalized, number, projected, required_bigint,
    required_u32, route_book_owner, route_runtime_expired, route_signer, routed, scaled_amount,
    set, string, terminal_route, text, unsigned,
};

fn committed_invalid(kind: &'static str, detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local(kind, detail)
}

fn required_text<'a>(
    value: &'a CanonicalValue,
    name: &'static str,
    kind: &'static str,
) -> Result<&'a str, EntityKernelError> {
    text(value, name)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| committed_invalid(kind, format!("{name}:STRING")))
}

fn required_field<'a>(
    value: &'a CanonicalValue,
    name: &'static str,
    kind: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    field(value, name).ok_or_else(|| committed_invalid(kind, format!("{name}:MISSING")))
}

fn merge_route(
    prior: Option<&CanonicalValue>,
    carried: &CanonicalValue,
) -> Result<CanonicalValue, EntityKernelError> {
    let CanonicalValue::Object(carried_fields) = carried else {
        return Err(committed_invalid("cross_pull_lock", "ROUTE:OBJECT"));
    };
    let mut merged = prior
        .cloned()
        .unwrap_or_else(|| CanonicalValue::Object(Vec::new()));
    for (name, value) in carried_fields {
        set(&mut merged, name, value.clone())?;
    }
    Ok(merged)
}

fn pull_role(
    route: &CanonicalValue,
    local: &str,
    counterparty: &str,
    pull_id: &str,
) -> Result<(&'static str, bool), EntityKernelError> {
    let source_pull = required_field(route, "sourcePull", "cross_j_committed")?;
    let target_pull = required_field(route, "targetPull", "cross_j_committed")?;
    let source = text(source_pull, "pullId") == Some(pull_id)
        && ((nested_text(route, "source", "entityId")
            .is_some_and(|value| normalized(value) == local)
            && nested_text(route, "source", "counterpartyEntityId")
                .is_some_and(|value| normalized(value) == counterparty))
            || (nested_text(route, "source", "counterpartyEntityId")
                .is_some_and(|value| normalized(value) == local)
                && nested_text(route, "source", "entityId")
                    .is_some_and(|value| normalized(value) == counterparty)));
    let target = text(target_pull, "pullId") == Some(pull_id)
        && ((nested_text(route, "target", "entityId")
            .is_some_and(|value| normalized(value) == local)
            && nested_text(route, "target", "counterpartyEntityId")
                .is_some_and(|value| normalized(value) == counterparty))
            || (nested_text(route, "target", "counterpartyEntityId")
                .is_some_and(|value| normalized(value) == local)
                && nested_text(route, "target", "entityId")
                    .is_some_and(|value| normalized(value) == counterparty)));
    if source == target {
        return Err(committed_invalid(
            "cross_j_committed",
            format!("PULL_ROLE_INVALID:{pull_id}:{local}:{counterparty}"),
        ));
    }
    let source_hub = nested_text(route, "source", "counterpartyEntityId")
        .is_some_and(|value| normalized(value) == local);
    Ok((if source { "source" } else { "target" }, source_hub))
}

fn validate_pull_binding(
    data: &CanonicalValue,
    route: &CanonicalValue,
    leg: &str,
) -> Result<(), EntityKernelError> {
    let kind = "cross_pull_lock";
    let binding = required_field(data, "crossJurisdiction", kind)?;
    let route_pull = required_field(
        route,
        if leg == "source" {
            "sourcePull"
        } else {
            "targetPull"
        },
        kind,
    )?;
    let route_id = required_text(route, "orderId", kind)?;
    if required_text(binding, "orderId", kind)? != route_id
        || required_text(binding, "leg", kind)? != leg
        || text(binding, "routeHash").map(normalized) != text(route, "routeHash").map(normalized)
        || text(data, "pullId") != text(route_pull, "pullId")
        || field(data, "tokenId") != field(route_pull, "tokenId")
        || field(data, "amount") != field(route_pull, "signedAmount")
        || text(data, "fullHash").map(normalized) != text(route_pull, "fullHash").map(normalized)
        || text(data, "partialRoot").map(normalized)
            != text(route_pull, "partialRoot").map(normalized)
    {
        return Err(committed_invalid(
            kind,
            format!("ROUTE_MISMATCH:{route_id}:{leg}"),
        ));
    }
    Ok(())
}

fn schedule_route_expiry(
    state: &mut EntityStateSlice,
    route: &CanonicalValue,
) -> Result<(), EntityKernelError> {
    let order_id = required_text(route, "orderId", "cross_pull_lock")?;
    let expires_at = unsigned(route, "expiresAt")
        .filter(|value| *value > state.timestamp)
        .ok_or_else(|| {
            committed_invalid("cross_pull_lock", format!("EXPIRY_INVALID:{order_id}"))
        })?;
    let crontab = state.crontab.as_mut().ok_or_else(|| {
        committed_invalid(
            "cross_pull_lock",
            format!("EXPIRY_CRONTAB_MISSING:{order_id}"),
        )
    })?;
    schedule_hook(
        crontab,
        ScheduledHook {
            id: format!("cross-j-expiry:{order_id}"),
            trigger_at: expires_at,
            kind: ScheduledHookKind::CrossJOrderbookSweep {
                reason: format!("cross-j-expiry:{order_id}"),
            },
        },
    )
}

fn committed_pull_lock(
    state: &mut EntityStateSlice,
    counterparty: &str,
    data: &CanonicalValue,
    committed_at: u64,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let kind = "cross_pull_lock";
    let binding = required_field(data, "crossJurisdiction", kind)?;
    let order_id = required_text(binding, "orderId", kind)?.to_string();
    let carried = required_field(data, "crossJurisdictionRoute", kind)?;
    if required_text(carried, "orderId", kind)? != order_id {
        return Err(committed_invalid(
            kind,
            format!("ROUTE_ID_MISMATCH:{order_id}"),
        ));
    }
    let prior = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id));
    if let Some(prior) = prior
        && text(prior, "routeHash").map(normalized) != text(carried, "routeHash").map(normalized)
    {
        return Err(committed_invalid(
            kind,
            format!("ROUTE_CONFLICT:{order_id}"),
        ));
    }
    let mut route = merge_route(prior, carried)?;
    let local = normalized(&state.entity_id);
    let counterparty = normalized(counterparty);
    let pull_id = required_text(data, "pullId", kind)?;
    let (leg, source_hub_committed) = pull_role(&route, &local, &counterparty, pull_id)?;
    validate_pull_binding(data, &route, leg)?;

    let user_leg = nested_text(&route, "source", "entityId")
        .is_some_and(|value| normalized(value) == local)
        || nested_text(&route, "target", "counterpartyEntityId")
            .is_some_and(|value| normalized(value) == local);
    if user_leg {
        let authorization = state
            .cross_jurisdiction_authorizations
            .as_ref()
            .and_then(|values| values.get(&order_id))
            .ok_or_else(|| committed_invalid(kind, format!("AUTH_MISSING:{order_id}:{local}")))?;
        if text(authorization, "routeHash").map(normalized)
            != text(&route, "routeHash").map(normalized)
        {
            return Err(committed_invalid(
                kind,
                format!("AUTH_MISMATCH:{order_id}:{local}"),
            ));
        }
        collection(&mut state.cross_jurisdiction_authorizations).remove(&order_id)?;
    }
    set(&mut route, "status", string("resting"))?;
    set(
        &mut route,
        "updatedAt",
        number(
            committed_at,
            EntityTxKind::AdmitCrossJurisdictionBookOrder,
            "TIMESTAMP",
        )?,
    )?;
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route.clone())?;
    if !source_hub_committed {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    schedule_route_expiry(state, &route)?;
    let owner = route_book_owner(&route);
    let admission = projected(
        EntityTxKind::AdmitCrossJurisdictionBookOrder,
        CanonicalValue::Object(vec![
            ("route".into(), route.clone()),
            ("reason".into(), string("atomic_account_pair_committed")),
        ]),
    )?;
    if owner == local {
        return super::apply_admit(state, &admission);
    }
    if route_signer(&route, &owner).is_none() {
        return Err(committed_invalid(
            kind,
            format!("BOOK_OWNER_SIGNER_MISSING:{order_id}:{owner}"),
        ));
    }
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![routed(&owner, vec![admission])],
        ..Default::default()
    })
}

fn cancel_route_expiry(
    state: &mut EntityStateSlice,
    order_id: &str,
) -> Result<(), EntityKernelError> {
    if let Some(crontab) = state.crontab.as_mut() {
        cancel_hook(crontab, &format!("cross-j-expiry:{order_id}"))?;
    }
    Ok(())
}

fn close_local_book(
    state: &mut EntityStateSlice,
    route: &CanonicalValue,
    reason: &str,
) -> Result<Vec<SameJOutputDelta>, EntityKernelError> {
    let order_id = required_text(route, "orderId", "cross_pull_close")?.to_string();
    let source_entity = nested_text(route, "source", "entityId")
        .map(normalized)
        .ok_or_else(|| committed_invalid("cross_pull_close", "SOURCE_ENTITY_MISSING"))?;
    let key = format!("{source_entity}:{order_id}");
    if let Some(mut admission) = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&key))
        .cloned()
    {
        set(&mut admission, "status", string("closed"))?;
        set(
            &mut admission,
            "closedAt",
            number(
                state.timestamp,
                EntityTxKind::RemoveCrossJurisdictionBookOrder,
                "TIMESTAMP",
            )?,
        )?;
        set(&mut admission, "closeReason", string(reason))?;
        set(
            &mut admission,
            "updatedAt",
            number(
                state.timestamp,
                EntityTxKind::RemoveCrossJurisdictionBookOrder,
                "TIMESTAMP",
            )?,
        )?;
        collection(&mut state.cross_jurisdiction_book_admissions).insert(key, admission)?;
    }
    Ok(vec![SameJOutputDelta::Remove {
        account_id: source_entity,
        offer_id: order_id,
    }])
}

fn remove_book(
    state: &mut EntityStateSlice,
    route: &CanonicalValue,
    reason: &str,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let local = normalized(&state.entity_id);
    let owner = route_book_owner(route);
    if owner == local {
        return Ok(CrossJurisdictionApplyResult {
            orderbook_deltas: close_local_book(state, route, reason)?,
            ..Default::default()
        });
    }
    if route_signer(route, &owner).is_none() {
        return Err(committed_invalid(
            "cross_pull_close",
            "BOOK_OWNER_SIGNER_MISSING",
        ));
    }
    let order_id = required_text(route, "orderId", "cross_pull_close")?;
    let source_entity = nested_text(route, "source", "entityId")
        .map(normalized)
        .ok_or_else(|| committed_invalid("cross_pull_close", "SOURCE_ENTITY_MISSING"))?;
    let tx = projected(
        EntityTxKind::RemoveCrossJurisdictionBookOrder,
        CanonicalValue::Object(vec![
            ("orderId".into(), string(order_id)),
            ("sourceEntityId".into(), string(&source_entity)),
            ("sourceAccountId".into(), string(&source_entity)),
            ("route".into(), route.clone()),
            ("reason".into(), string(reason)),
        ]),
    )?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![routed(&owner, vec![tx])],
        ..Default::default()
    })
}

fn committed_pull_close(
    state: &mut EntityStateSlice,
    counterparty: &str,
    data: &CanonicalValue,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let kind = "cross_pull_close";
    let pull_id = required_text(data, "pullId", kind)?;
    let binary = text(data, "binary").ok_or_else(|| committed_invalid(kind, "BINARY:MISSING"))?;
    let proof = required_field(data, "proof", kind)?;
    let order_id = required_text(proof, "orderId", kind)?.to_string();
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
        .cloned()
        .ok_or_else(|| committed_invalid(kind, format!("ROUTE_MISSING:{order_id}")))?;
    let local = normalized(&state.entity_id);
    let counterparty = normalized(counterparty);
    let (leg, source_hub_committed) = pull_role(&route, &local, &counterparty, pull_id)?;
    let commitment = required_field(
        &route,
        if leg == "source" {
            "sourcePull"
        } else {
            "targetPull"
        },
        kind,
    )?;
    let ratio = xln_rscore_engine::verify_hash_ladder_binary(
        text(commitment, "fullHash").unwrap_or(""),
        text(commitment, "partialRoot").unwrap_or(""),
        binary,
    )
    .map_err(|detail| committed_invalid(kind, detail))?;
    if unsigned(proof, "fillRatio") != Some(ratio)
        || text(proof, "routeHash").map(normalized) != text(&route, "routeHash").map(normalized)
        || text(proof, "sourcePullId")
            != field(&route, "sourcePull").and_then(|pull| text(pull, "pullId"))
        || text(proof, "targetPullId")
            != field(&route, "targetPull").and_then(|pull| text(pull, "pullId"))
        || text(proof, "binaryHash").map(normalized)
            != Some(normalized(&close_binary_hash(
                binary,
                EntityTxKind::CrossPullClose,
            )?))
    {
        return Err(committed_invalid(
            kind,
            format!("PROOF_MISMATCH:{order_id}"),
        ));
    }
    let (committed_ratio, committed_source, committed_target) =
        committed_fill(&route, EntityTxKind::CrossPullClose)?;
    if ratio < committed_ratio
        || bigint(proof, "cumulativeSourceAmount") != Some(committed_source)
        || bigint(proof, "cumulativeTargetAmount") != Some(committed_target)
    {
        return Err(committed_invalid(
            kind,
            format!("ECONOMICS_MISMATCH:{order_id}"),
        ));
    }
    if terminal_route(&route) {
        if field(&route, "sourceCloseProof") != Some(proof) {
            return Err(committed_invalid(
                kind,
                format!("TERMINAL_REPLAY_MISMATCH:{order_id}"),
            ));
        }
        return if source_hub_committed {
            remove_book(state, &route, "settled")
        } else {
            Ok(Default::default())
        };
    }
    if ratio > 0 {
        let allowed = if leg == "source" {
            matches!(text(&route, "status"), Some("clearing" | "clear_requested"))
        } else {
            matches!(
                text(&route, "status"),
                Some("resting" | "partially_filled" | "clear_requested" | "clearing")
            )
        };
        if !allowed {
            return Err(committed_invalid(
                kind,
                format!("STATUS_INVALID:{order_id}:{leg}"),
            ));
        }
    }
    for (target, source) in [
        ("cumulativeFillRatio", "fillRatio"),
        ("claimedRatio", "fillRatio"),
        ("filledSourceAmount", "cumulativeSourceAmount"),
        ("filledTargetAmount", "cumulativeTargetAmount"),
        ("sourceClaimed", "cumulativeSourceAmount"),
        ("targetClaimed", "cumulativeTargetAmount"),
    ] {
        set(
            &mut route,
            target,
            required_field(proof, source, kind)?.clone(),
        )?;
    }
    set(&mut route, "sourceCloseProof", proof.clone())?;
    set(&mut route, "targetCloseProof", proof.clone())?;
    let terminal = if ratio > 0 {
        "settled"
    } else if route_runtime_expired(&route, state.timestamp) {
        "expired"
    } else {
        "cancelled"
    };
    set(&mut route, "status", string(terminal))?;
    set(
        &mut route,
        "updatedAt",
        number(state.timestamp, EntityTxKind::CrossPullClose, "TIMESTAMP")?,
    )?;
    if terminal == "settled" {
        set(
            &mut route,
            "settledAt",
            number(state.timestamp, EntityTxKind::CrossPullClose, "TIMESTAMP")?,
        )?;
    }
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route.clone())?;
    cancel_route_expiry(state, &order_id)?;
    if source_hub_committed {
        remove_book(state, &route, terminal)
    } else {
        Ok(Default::default())
    }
}

fn order_id(data: &CanonicalValue, kind: &'static str) -> Result<String, EntityKernelError> {
    text(data, "offerId")
        .or_else(|| text(data, "routeId"))
        .or_else(|| text(data, "orderId"))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| committed_invalid(kind, "OFFER_ID_MISSING"))
}

fn exact_progress(
    route: &CanonicalValue,
    data: &CanonicalValue,
    kind: &'static str,
) -> Result<(u64, BigInt, BigInt, BigInt, BigInt), EntityKernelError> {
    let entity_kind = EntityTxKind::ApplyCrossJurisdictionBookProgress;
    let (numerator, denominator, ratio) = exact_fill(data, entity_kind)?;
    let source_leg = required_field(route, "source", kind)?;
    let target_leg = required_field(route, "target", kind)?;
    let source_total = required_bigint(source_leg, "amount", entity_kind)?;
    let target_total = required_bigint(target_leg, "amount", entity_kind)?;
    if source_total <= BigInt::from(0) || target_total <= BigInt::from(0) {
        return Err(committed_invalid(kind, "ROUTE_AMOUNT_NON_POSITIVE"));
    }
    let cumulative_source = scaled_amount(&source_total, &numerator, &denominator);
    let cumulative_target = scaled_amount(&target_total, &numerator, &denominator);
    for (name, expected) in [
        ("cumulativeSourceAmount", &cumulative_source),
        ("cumulativeTargetAmount", &cumulative_target),
    ] {
        if bigint(data, name).as_ref() != Some(expected) {
            return Err(committed_invalid(
                kind,
                format!("{name}_MISMATCH:{expected}"),
            ));
        }
    }
    let (_, previous_source, previous_target) = committed_fill(route, entity_kind)?;
    let incremental_source = &cumulative_source - &previous_source;
    let incremental_target = &cumulative_target - &previous_target;
    if incremental_source <= BigInt::from(0) || incremental_target <= BigInt::from(0) {
        return Err(committed_invalid(kind, "INCREMENTAL_AMOUNT_NON_POSITIVE"));
    }
    for (name, expected) in [
        ("incrementalSourceAmount", &incremental_source),
        ("incrementalTargetAmount", &incremental_target),
    ] {
        if bigint(data, name).as_ref() != Some(expected) {
            return Err(committed_invalid(
                kind,
                format!("{name}_MISMATCH:{expected}"),
            ));
        }
    }

    let policy = required_field(route, "settlementPolicy", kind)?;
    let quantized_source = if ratio >= 65_535 {
        source_total.clone()
    } else {
        &source_total * BigInt::from(ratio) / BigInt::from(65_535_u32)
    };
    let quantized_target = if ratio >= 65_535 {
        target_total.clone()
    } else {
        &target_total * BigInt::from(ratio) / BigInt::from(65_535_u32)
    };
    let source_dust = if quantized_source >= cumulative_source {
        &quantized_source - &cumulative_source
    } else {
        &cumulative_source - &quantized_source
    };
    let target_dust = if quantized_target >= cumulative_target {
        &quantized_target - &cumulative_target
    } else {
        &cumulative_target - &quantized_target
    };
    let max_source_dust = required_bigint(policy, "maxSourceDust", entity_kind)?;
    let max_target_dust = required_bigint(policy, "maxTargetDust", entity_kind)?;
    let min_source = bigint(policy, "minSourceFillAmount").unwrap_or_default();
    let min_target = bigint(policy, "minTargetFillAmount").unwrap_or_default();
    if cumulative_source < min_source
        || cumulative_target < min_target
        || source_dust > max_source_dust
        || target_dust > max_target_dust
    {
        return Err(committed_invalid(kind, "QUANTIZATION_POLICY"));
    }
    Ok((
        ratio,
        cumulative_source,
        cumulative_target,
        source_total,
        target_total,
    ))
}

fn dust_terminal(
    route: &CanonicalValue,
    cumulative_source: &BigInt,
    cumulative_target: &BigInt,
    source_total: &BigInt,
    target_total: &BigInt,
) -> Result<bool, EntityKernelError> {
    let kind = EntityTxKind::ApplyCrossJurisdictionBookProgress;
    let source = required_field(route, "source", "cross_j_progress")?;
    let target = required_field(route, "target", "cross_j_progress")?;
    let source_token = required_u32(source, "tokenId", kind)?;
    let target_token = required_u32(target, "tokenId", kind)?;
    let source_decimals = crate::canonical_token_decimals(source_token)
        .ok_or_else(|| committed_invalid("cross_j_progress", "SOURCE_TOKEN_METADATA"))?;
    let target_decimals = crate::canonical_token_decimals(target_token)
        .ok_or_else(|| committed_invalid("cross_j_progress", "TARGET_TOKEN_METADATA"))?;
    let source_remaining = source_total - cumulative_source;
    let target_remaining = target_total - cumulative_target;
    if source_remaining <= BigInt::from(0) || target_remaining <= BigInt::from(0) {
        return Ok(true);
    }
    let source_lot = crate::orderbook::lot_scale(source_decimals);
    let target_lot = crate::orderbook::lot_scale(target_decimals);
    Ok(source_total >= &source_lot
        && target_total >= &target_lot
        && (source_remaining < source_lot || target_remaining < target_lot))
}

pub(super) fn apply_fill(
    state: &mut EntityStateSlice,
    data: &CanonicalValue,
    kind: &'static str,
) -> Result<(CanonicalValue, bool), EntityKernelError> {
    let order_id = order_id(data, kind)?;
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
        .cloned()
        .ok_or_else(|| committed_invalid(kind, format!("ROUTE_MISSING:{order_id}")))?;
    let previous_seq = unsigned(&route, "fillSeq").unwrap_or(0);
    let next_seq =
        unsigned(data, "fillSeq").ok_or_else(|| committed_invalid(kind, "FILL_SEQ_MISSING"))?;
    let cancel = canonical_bool(data, "cancelRemainder");
    if (cancel && next_seq != previous_seq && next_seq != previous_seq.saturating_add(1))
        || (!cancel && next_seq != previous_seq.saturating_add(1))
    {
        return Err(committed_invalid(
            kind,
            format!("FILL_SEQ:{previous_seq}:{next_seq}"),
        ));
    }
    let (previous_ratio, _, _) =
        committed_fill(&route, EntityTxKind::ApplyCrossJurisdictionBookProgress)?;
    let supplied_ratio = unsigned(data, "cumulativeFillRatio")
        .ok_or_else(|| committed_invalid(kind, "FILL_RATIO_MISSING"))?;
    if cancel && supplied_ratio <= previous_ratio {
        set(&mut route, "status", string("clear_requested"))?;
        set(&mut route, "clearingPolicy", string("cancel_and_clear"))?;
        set(
            &mut route,
            "updatedAt",
            number(
                state.timestamp,
                EntityTxKind::ApplyCrossJurisdictionBookProgress,
                "TIMESTAMP",
            )?,
        )?;
        collection(&mut state.cross_jurisdiction_swaps).insert(order_id, route.clone())?;
        return Ok((route, true));
    }
    if supplied_ratio <= previous_ratio {
        return Err(committed_invalid(
            kind,
            format!("FILL_RATIO:{previous_ratio}:{supplied_ratio}"),
        ));
    }
    let (ratio, source, target, source_total, target_total) = exact_progress(&route, data, kind)?;
    for (source_name, target_name) in [
        ("fillSeq", "fillSeq"),
        ("cumulativeFillRatio", "cumulativeFillRatio"),
        ("fillNumerator", "fillNumerator"),
        ("fillDenominator", "fillDenominator"),
        ("cumulativeSourceAmount", "filledSourceAmount"),
        ("cumulativeTargetAmount", "filledTargetAmount"),
    ] {
        if let Some(value) = field(data, source_name) {
            set(&mut route, target_name, value.clone())?;
        }
    }
    set(
        &mut route,
        "claimedRatio",
        CanonicalValue::Number(
            xln_rscore_protocol::CanonicalNumber::try_from_u64(ratio)
                .map_err(|_| committed_invalid(kind, "FILL_RATIO_UNSAFE"))?,
        ),
    )?;
    set(
        &mut route,
        "sourceClaimed",
        CanonicalValue::BigInt(source.clone()),
    )?;
    set(
        &mut route,
        "targetClaimed",
        CanonicalValue::BigInt(target.clone()),
    )?;
    if let Some(improvement) = bigint(data, "priceImprovementAmount") {
        if improvement < BigInt::from(0) {
            return Err(committed_invalid(kind, "PRICE_IMPROVEMENT_NEGATIVE"));
        }
        let cumulative = bigint(&route, "priceImprovementSourceAmount").unwrap_or_default();
        set(
            &mut route,
            "priceImprovementSourceAmount",
            CanonicalValue::BigInt(cumulative + improvement),
        )?;
    }
    let dust_close = dust_terminal(&route, &source, &target, &source_total, &target_total)?;
    let terminal =
        cancel || ratio >= 65_535 || source >= source_total || target >= target_total || dust_close;
    set(
        &mut route,
        "status",
        string(if terminal {
            "clear_requested"
        } else {
            "partially_filled"
        }),
    )?;
    if terminal {
        set(
            &mut route,
            "clearingPolicy",
            string(if cancel || dust_close || ratio < 65_535 {
                "cancel_and_clear"
            } else {
                "full_fill"
            }),
        )?;
    }
    set(
        &mut route,
        "updatedAt",
        number(
            state.timestamp,
            EntityTxKind::ApplyCrossJurisdictionBookProgress,
            "TIMESTAMP",
        )?,
    )?;
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id, route.clone())?;
    Ok((route, terminal))
}

fn progress_tx(
    route: &CanonicalValue,
    data: &CanonicalValue,
) -> Result<crate::CanonicalEntityTx, EntityKernelError> {
    let mut fields = vec![
        (
            "orderId".into(),
            string(order_id(data, "cross_swap_fill_ack")?),
        ),
        (
            "sourceEntityId".into(),
            string(
                nested_text(route, "source", "entityId")
                    .ok_or_else(|| committed_invalid("cross_swap_fill_ack", "SOURCE_ENTITY"))?,
            ),
        ),
    ];
    for name in [
        "fillSeq",
        "incrementalSourceAmount",
        "incrementalTargetAmount",
        "cumulativeSourceAmount",
        "cumulativeTargetAmount",
        "cumulativeFillRatio",
        "fillNumerator",
        "fillDenominator",
        "priceImprovementMode",
        "priceImprovementAmount",
        "priceImprovementTokenId",
        "cancelRemainder",
    ] {
        if let Some(value) = field(data, name) {
            fields.push((name.into(), value.clone()));
        }
    }
    fields.push(("reason".into(), string("fill_ack_committed")));
    projected(
        EntityTxKind::ApplyCrossJurisdictionBookProgress,
        CanonicalValue::Object(fields),
    )
}

fn committed_fill_ack(
    state: &mut EntityStateSlice,
    data: &CanonicalValue,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    if let Some(mode) = text(data, "priceImprovementMode")
        && mode != "source_savings"
    {
        return Err(committed_invalid(
            "cross_swap_fill_ack",
            format!("PRICE_IMPROVEMENT_MODE:{mode}"),
        ));
    }
    let (route, terminal) = apply_fill(state, data, "cross_swap_fill_ack")?;
    let local = normalized(&state.entity_id);
    let source_hub = nested_text(&route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| committed_invalid("cross_swap_fill_ack", "SOURCE_HUB_MISSING"))?;
    if local != source_hub {
        return Ok(Default::default());
    }
    let mut result = if terminal {
        remove_book(state, &route, "fill_ack_closed")?
    } else {
        let owner = route_book_owner(&route);
        if owner == local {
            super::apply_progress(state, &progress_tx(&route, data)?)?
        } else {
            if route_signer(&route, &owner).is_none() {
                return Err(committed_invalid(
                    "cross_swap_fill_ack",
                    "BOOK_OWNER_SIGNER_MISSING",
                ));
            }
            CrossJurisdictionApplyResult {
                outputs: vec![routed(&owner, vec![progress_tx(&route, data)?])],
                ..Default::default()
            }
        }
    };
    if terminal {
        result.outputs.push(routed(
            &local,
            vec![projected(
                EntityTxKind::RequestCrossJurisdictionClear,
                CanonicalValue::Object(vec![
                    (
                        "orderId".into(),
                        string(order_id(data, "cross_swap_fill_ack")?),
                    ),
                    (
                        "cancelRemainder".into(),
                        CanonicalValue::Bool(canonical_bool(data, "cancelRemainder")),
                    ),
                ]),
            )?],
        ));
    }
    Ok(result)
}

fn committed_pull_progress(
    state: &mut EntityStateSlice,
    counterparty: &str,
    data: &CanonicalValue,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let pull_id = required_text(data, "pullId", "cross_pull_progress")?;
    let fill = required_field(data, "fill", "cross_pull_progress")?;
    let order_id = order_id(fill, "cross_pull_progress")?;
    let route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
        .cloned()
        .ok_or_else(|| {
            committed_invalid("cross_pull_progress", format!("ROUTE_MISSING:{order_id}"))
        })?;
    let (leg, _) = pull_role(
        &route,
        &normalized(&state.entity_id),
        &normalized(counterparty),
        pull_id,
    )?;
    if leg != "target" {
        return Err(committed_invalid(
            "cross_pull_progress",
            format!("TARGET_ACCOUNT_MISMATCH:{order_id}:{pull_id}"),
        ));
    }
    apply_fill(state, fill, "cross_pull_progress")?;
    Ok(Default::default())
}

pub(crate) fn apply_committed_account_tx_followup(
    state: &mut EntityStateSlice,
    counterparty: &str,
    frame_timestamp: u64,
    tx: &AccountTx,
) -> Result<Option<CrossJurisdictionApplyResult>, EntityKernelError> {
    let result = match tx {
        AccountTx::CrossPullLock { data } => {
            committed_pull_lock(state, counterparty, data, frame_timestamp)?
        }
        AccountTx::CrossPullClose { data } => committed_pull_close(state, counterparty, data)?,
        AccountTx::CrossPullProgress { data } => {
            committed_pull_progress(state, counterparty, data)?
        }
        AccountTx::CrossSwapFillAck { data } => committed_fill_ack(state, data)?,
        _ => return Ok(None),
    };
    Ok(Some(result))
}
