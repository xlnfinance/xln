use super::state::*;
use crate::{EntityKernelError as E, EntityStateSlice, LocalAccountFinancialView};
use std::collections::{BTreeMap, BTreeSet};
use xln_rscore_engine::AccountTx;
fn claim<'a>(
    v: &xln_rscore_protocol::CanonicalValue,
    view: &'a LocalAccountFinancialView,
) -> Result<&'a xln_rscore_engine::lending::LendingCovenant, E> {
    let c = view
        .lending
        .claims
        .get(text(v, "positionId")?)
        .ok_or_else(|| err("LENDING_DEMAND_ACCOUNT_MISSING"))?;
    if c.kind != "demand"
        || u64::from(c.token_id) != number(v, "tokenId")?
        || c.principal != big(v, "principalAmount")?
        || c.creditor_is_left == (view.owner_side == xln_rscore_engine::Side::Left)
    {
        return Err(err("LENDING_DEMAND_CLAIM_BINDING"));
    }
    Ok(c)
}
/// Stage 2 servicing, after inbound commits, before outbound proposals.
pub(crate) fn withdrawals(
    state: &EntityStateSlice,
    views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<Vec<(String, AccountTx)>, E> {
    let Some(book) = &state.lending else {
        return Ok(Vec::new());
    };
    let mut pending = Vec::new();
    for (_, v) in &book.savings {
        if text(v, "status")? == "queued" {
            let due = if text(v, "termId")? == "demand" {
                number(v, "updatedAt")?
            } else {
                (number(v, "createdAt")? + number(v, "termMs")?).min(number(v, "updatedAt")?)
            };
            pending.push((due, number(v, "closeOrder")?, v));
        }
    }
    pending.sort_by_key(|(due, order, _)| (*due, *order));
    let mut seen = BTreeSet::new();
    let mut lanes = BTreeSet::new();
    let mut out = Vec::new();
    for (_, _, v) in pending {
        let peer = text(v, "lenderEntityId")?;
        let Some(token) = account_token(number(v, "tokenId")?) else {
            // TS sees no delta for this exact token, hence zero payout capacity.
            continue;
        };
        if seen.contains(peer) || !lanes.insert((peer, token)) {
            continue;
        }
        let view = views.get(peer).ok_or_else(|| {
            err(format!(
                "LENDING_WITHDRAWAL_ACCOUNT_MISSING:{}",
                text(v, "positionId").unwrap_or("")
            ))
        })?;
        if !view.active || view.lending.busy {
            continue;
        }
        let c = if text(v, "termId")? == "demand" {
            Some(claim(v, view)?)
        } else {
            None
        };
        let amount = close_amount(v, state.timestamp, c)?;
        if view
            .owner_out_capacity
            .get(&token)
            .cloned()
            .unwrap_or_default()
            < amount
        {
            continue;
        }
        seen.insert(peer);
        out.push((
            peer.into(),
            AccountTx::LendingClosePayout {
                position_id: text(v, "positionId")?.into(),
                hub_entity_id: state.entity_id.clone(),
                lender_entity_id: peer.into(),
                token_id: token,
                amount: c.map_or(amount, |c| c.maximum()),
            },
        ));
    }
    Ok(out)
}
pub(crate) fn renewals(
    state: &EntityStateSlice,
    views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<Vec<(u64, String, AccountTx)>, E> {
    let Some(book) = &state.lending else {
        return Ok(Vec::new());
    };
    let mut queued = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (_, v) in &book.savings {
        if text(v, "status")? == "queued" {
            queued.insert((text(v, "lenderEntityId")?, number(v, "tokenId")?));
        }
    }
    for (_, v) in &book.savings {
        let peer = text(v, "lenderEntityId")?;
        let token = number(v, "tokenId")?;
        if text(v, "termId")? != "demand"
            || text(v, "status")? != "open"
            || seen.contains(peer)
            || queued.contains(&(peer, token))
        {
            continue;
        }
        let view = views
            .get(peer)
            .ok_or_else(|| err("LENDING_DEMAND_ACCOUNT_MISSING"))?;
        if !view.active || view.lending.busy {
            continue;
        }
        let c = claim(v, view)?;
        let key = format!(
            "{}:{}:{token}:demand",
            view.lending.chain_id, view.lending.depository_address
        );
        let Some(t) = book.terms.as_ref().and_then(|rows| find(rows, &key)) else {
            continue;
        };
        if number(t, "expiresAt")? <= state.timestamp {
            continue;
        }
        let bps = number(t, "savingsInterestBps")?;
        let trigger = if c.interest_bps != bps {
            state.timestamp.max(c.accrued_at + 1)
        } else {
            c.opened_at + c.term_ms - 86400000
        };
        if trigger >= number(t, "expiresAt")? {
            continue;
        }
        let Ok(next) = c.renew(bps, trigger.max(state.timestamp)) else {
            continue;
        };
        let extra = next.maximum() - c.maximum();
        let capacity = view
            .lending
            .coupon_capacity
            .get(&(
                u16::try_from(token).map_err(|_| err("LENDING_DEMAND_RISK_MISSING"))?,
                !c.creditor_is_left,
            ))
            .ok_or_else(|| err("LENDING_DEMAND_RISK_MISSING"))?;
        if extra > 0.into() && &extra > capacity {
            continue;
        }
        if trigger <= state.timestamp {
            seen.insert(peer);
        }
        out.push((
            trigger,
            peer.into(),
            AccountTx::LendingRate {
                position_id: text(v, "positionId")?.into(),
                hub_entity_id: state.entity_id.clone(),
                lender_entity_id: peer.into(),
                token_id: account_token(token).ok_or_else(|| err("LENDING_DEMAND_RISK_MISSING"))?,
                claim_hash: c.hash(),
                interest_bps: bps as i64,
            },
        ));
    }
    Ok(out)
}

pub(crate) fn overdue(state: &EntityStateSlice) -> Result<Vec<super::OverdueLendingLoan>, E> {
    let mut rows = Vec::new();
    for (id, v) in state.lending.iter().flat_map(|book| &book.loans) {
        if text(v, "status")? == "active" && number(v, "dueAt")? <= state.timestamp {
            rows.push((
                number(v, "dueAt")?,
                id.clone(),
                super::OverdueLendingLoan {
                    loan_id: id.clone(),
                    borrower_entity_id: text(v, "borrowerEntityId")?.into(),
                    token_id: account_token(number(v, "tokenId")?)
                        .ok_or_else(|| err("LENDING_COVENANT_TOKEN"))?,
                    committed_credit_limit: 0.into(),
                },
            ));
        }
    }
    rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(rows.into_iter().map(|(_, _, v)| v).collect())
}
pub fn deadlines(
    state: &EntityStateSlice,
    views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<Vec<(String, u64)>, E> {
    let mut out = Vec::new();
    for (id, v) in state.lending.iter().flat_map(|book| &book.loans) {
        if text(v, "status")? == "active" {
            out.push((format!("lending-overdue:{id}"), number(v, "dueAt")?));
        }
    }
    for (time, _, tx) in renewals(state, views)? {
        let AccountTx::LendingRate { position_id, .. } = tx else {
            unreachable!()
        };
        out.push((format!("lending-renewal:{position_id}"), time));
    }
    Ok(out)
}

/// Only authenticated J finality releases reservations from the old Account epoch.
pub(crate) fn retire_disputed(
    state: &mut EntityStateSlice,
    peer: &str,
    claim_ids: &[String],
) -> Result<(), E> {
    let Some(book) = &mut state.lending else {
        return Ok(());
    };
    for (_, loan) in &mut book.loans {
        if text(loan, "status")? == "opening" && text(loan, "borrowerEntityId")? == peer {
            set(loan, "status", s("disputed"));
            set(loan, "updatedAt", n(state.timestamp));
        }
    }
    for id in claim_ids {
        if let Some(loan) = find_mut(&mut book.loans, id) {
            if !matches!(text(loan, "status")?, "repaid" | "disputed") {
                set(loan, "status", s("disputed"));
                set(loan, "updatedAt", n(state.timestamp));
            }
        } else if let Some(saving) = find_mut(&mut book.savings, id) {
            if matches!(text(saving, "status")?, "open" | "queued") {
                set(saving, "status", s("disputed"));
                set(saving, "updatedAt", n(state.timestamp));
            }
        }
    }
    Ok(())
}
