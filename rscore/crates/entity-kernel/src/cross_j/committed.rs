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
use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice, EntityTxKind};

use super::{
    CrossJurisdictionApplyResult, bigint, canonical_bool, close_binary_hash, collection,
    committed_fill, field, nested_text, normalized, number, projected, required_bigint,
    route_book_owner, route_hash_matches, route_runtime_expired, route_signer, routed,
    routed_for_route, scaled_amount, set, string, terminal_route, text, unsigned,
};

const MAX_FILL_RATIO: u64 = 65_535;

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

pub(super) fn merge_route(
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
    let committed_event = EntityFrameEvent::Status {
        message: format!("🌉 Cross-j swap {order_id} committed by both Account legs"),
    };
    let owner = route_book_owner(&route);
    let admission = projected(
        EntityTxKind::AdmitCrossJurisdictionBookOrder,
        CanonicalValue::Object(vec![
            ("route".into(), route.clone()),
            ("reason".into(), string("atomic_account_pair_committed")),
        ]),
    )?;
    if owner == local {
        let mut applied = super::apply_admit(state, &admission)?;
        applied.events.insert(0, committed_event);
        return Ok(applied);
    }
    if route_signer(&route, &owner).is_none() {
        return Err(committed_invalid(
            kind,
            format!("BOOK_OWNER_SIGNER_MISSING:{order_id}:{owner}"),
        ));
    }
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![routed_for_route(
            &route,
            &owner,
            vec![admission],
            EntityTxKind::AdmitCrossJurisdictionBookOrder,
        )?],
        events: vec![committed_event],
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
        outputs: vec![routed_for_route(
            route,
            &owner,
            vec![tx],
            EntityTxKind::RemoveCrossJurisdictionBookOrder,
        )?],
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

/// TS `withCrossJurisdictionFillProgress` after `validateCrossJurisdictionFillProgress`
/// for the ratio-only exact fraction `ratio / 65535`: both legs claim exactly
/// `floor(total * ratio / 65535)`.
pub(super) fn with_fill_progress(
    route: &mut CanonicalValue,
    next_seq: u64,
    ratio: u64,
    updated_at: u64,
    kind: EntityTxKind,
    prefix: &'static str,
) -> Result<(), EntityKernelError> {
    let previous_seq = unsigned(route, "fillSeq").unwrap_or(0);
    if next_seq != previous_seq.saturating_add(1) {
        return Err(committed_invalid(
            prefix,
            format!("FILL_SEQ:{previous_seq}:{next_seq}"),
        ));
    }
    let (previous_ratio, previous_source, previous_target) = committed_fill(route, kind)?;
    if ratio <= previous_ratio {
        return Err(committed_invalid(
            prefix,
            format!("FILL_RATIO:{previous_ratio}:{ratio}"),
        ));
    }
    let source = required_field(route, "source", prefix)?;
    let target = required_field(route, "target", prefix)?;
    let source_total = required_bigint(source, "amount", kind)?;
    let target_total = required_bigint(target, "amount", kind)?;
    if source_total <= BigInt::from(0) || target_total <= BigInt::from(0) {
        return Err(committed_invalid(prefix, "ROUTE_AMOUNT_NON_POSITIVE"));
    }
    let numerator = BigInt::from(ratio);
    let denominator = BigInt::from(MAX_FILL_RATIO);
    let cumulative_source = scaled_amount(&source_total, &numerator, &denominator);
    let cumulative_target = scaled_amount(&target_total, &numerator, &denominator);
    if cumulative_source <= previous_source || cumulative_target <= previous_target {
        return Err(committed_invalid(prefix, "NO_INCREMENTAL_AMOUNT"));
    }
    let ratio_number = number(ratio, kind, "FILL_RATIO")?;
    set(route, "fillSeq", number(next_seq, kind, "FILL_SEQ")?)?;
    set(route, "cumulativeFillRatio", ratio_number.clone())?;
    set(route, "fillNumerator", CanonicalValue::BigInt(numerator))?;
    set(
        route,
        "fillDenominator",
        CanonicalValue::BigInt(denominator),
    )?;
    set(route, "claimedRatio", ratio_number)?;
    set(
        route,
        "filledSourceAmount",
        CanonicalValue::BigInt(cumulative_source.clone()),
    )?;
    set(
        route,
        "filledTargetAmount",
        CanonicalValue::BigInt(cumulative_target.clone()),
    )?;
    set(
        route,
        "sourceClaimed",
        CanonicalValue::BigInt(cumulative_source),
    )?;
    set(
        route,
        "targetClaimed",
        CanonicalValue::BigInt(cumulative_target),
    )?;
    set(
        route,
        "status",
        string(if ratio >= MAX_FILL_RATIO {
            "clear_requested"
        } else {
            "partially_filled"
        }),
    )?;
    set(route, "updatedAt", number(updated_at, kind, "TIMESTAMP")?)?;
    Ok(())
}

/// Source-Hub view of Hub-internal fill progress (TS
/// `applySourceHubCrossJurisdictionFillProgress`). The route mirror is what
/// the proposer reveals against; a terminal fill or cancel requests the clear.
/// Returns `None` for a duplicate or already-terminal route.
pub(super) fn apply_source_hub_fill_progress(
    state: &mut EntityStateSlice,
    data: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<Option<CrossJurisdictionApplyResult>, EntityKernelError> {
    let prefix = "cross_j_fill";
    let order_id = text(data, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| committed_invalid(prefix, "ORDER_ID_MISSING"))?
        .to_string();
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
        .cloned()
        .ok_or_else(|| {
            committed_invalid(prefix, format!("CROSS_J_FILL_ROUTE_MISSING:{order_id}"))
        })?;
    let local = normalized(&state.entity_id);
    let source_hub = nested_text(&route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| committed_invalid(prefix, "SOURCE_HUB_MISSING"))?;
    if local != source_hub {
        return Err(committed_invalid(
            prefix,
            format!("CROSS_J_FILL_SOURCE_HUB_REQUIRED:{order_id}:{local}"),
        ));
    }
    if !route_hash_matches(data, &route) {
        return Err(committed_invalid(
            prefix,
            format!("CROSS_J_FILL_ROUTE_HASH_MISMATCH:{order_id}"),
        ));
    }
    if terminal_route(&route) {
        return Ok(None);
    }
    // Once the clear is requested the ladder reveal is the only remaining
    // authority: a late fill must never re-open or raise the ratio.
    if matches!(text(&route, "status"), Some("clear_requested" | "clearing")) {
        return Ok(None);
    }
    let ratio = unsigned(data, "cumulativeFillRatio")
        .unwrap_or(0)
        .min(MAX_FILL_RATIO);
    let current_seq = unsigned(&route, "fillSeq").unwrap_or(0);
    let incoming_seq =
        unsigned(data, "fillSeq").ok_or_else(|| committed_invalid(prefix, "FILL_SEQ_MISSING"))?;
    let cancel = canonical_bool(data, "cancelRemainder");
    let is_cancel = cancel && incoming_seq == current_seq;
    let (current_ratio, _, _) = committed_fill(&route, kind)?;
    if !is_cancel && incoming_seq == current_seq && ratio != current_ratio {
        return Err(committed_invalid(
            prefix,
            format!("CROSS_J_FILL_NOTICE_STALE_CONFLICT:{order_id}:{incoming_seq}:{ratio}"),
        ));
    }
    if !is_cancel && incoming_seq <= current_seq {
        return Ok(None);
    }
    let terminal = if cancel && ratio <= current_ratio {
        set(&mut route, "status", string("clear_requested"))?;
        set(&mut route, "clearingPolicy", string("cancel_and_clear"))?;
        true
    } else {
        with_fill_progress(
            &mut route,
            incoming_seq,
            ratio,
            state.timestamp,
            kind,
            "CROSS_J_FILL_PROGRESS_INVALID",
        )?;
        let (_, filled_source, filled_target) = committed_fill(&route, kind)?;
        let source_total =
            required_bigint(required_field(&route, "source", prefix)?, "amount", kind)?;
        let target_total =
            required_bigint(required_field(&route, "target", prefix)?, "amount", kind)?;
        let terminal = ratio >= MAX_FILL_RATIO
            || filled_source >= source_total
            || filled_target >= target_total
            || cancel;
        if terminal {
            set(&mut route, "status", string("clear_requested"))?;
            set(
                &mut route,
                "clearingPolicy",
                string(if cancel || ratio < MAX_FILL_RATIO {
                    "cancel_and_clear"
                } else {
                    "full_fill"
                }),
            )?;
        }
        terminal
    };
    set(
        &mut route,
        "updatedAt",
        number(state.timestamp, kind, "TIMESTAMP")?,
    )?;
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route.clone())?;
    let mut result = CrossJurisdictionApplyResult::default();
    if !terminal {
        return Ok(Some(result));
    }
    // The book owner already removed its row for a terminal progress; only a
    // local book still needs the removal and the admission close here.
    let owner = route_book_owner(&route);
    if owner.is_empty() || owner == local {
        result.orderbook_deltas = close_local_book(state, &route, "fill_closed")?;
    }
    result.outputs.push(routed(
        &local,
        None,
        vec![projected(
            EntityTxKind::RequestCrossJurisdictionClear,
            CanonicalValue::Object(vec![
                ("orderId".into(), string(order_id)),
                ("cancelRemainder".into(), CanonicalValue::Bool(cancel)),
            ]),
        )?],
    ));
    Ok(Some(result))
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
        _ => return Ok(None),
    };
    Ok(Some(result))
}
