//! Authenticated Entity commands queue local Account inputs; only bank governance sets policy.
use super::LocalAccountFinancialView;
use crate::lendbook::{codec::*, state::*};
use crate::{
    CanonicalEntityTx, EntityFrameEvent, EntityKernelError as E, EntityStateSlice, EntityTxKind,
};
use std::collections::BTreeMap;
use xln_rscore_engine::AccountTx;
use xln_rscore_protocol::CanonicalValue as V;
fn reject(kind: &'static str, detail: impl Into<String>) -> E {
    E::RejectedEntityTx {
        kind,
        detail: detail.into(),
    }
}
pub(super) fn apply(
    state: &mut EntityStateSlice,
    tx: CanonicalEntityTx,
    views: &BTreeMap<String, LocalAccountFinancialView>,
    out: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wakes: &mut Vec<String>,
) -> Result<(), E> {
    let kind = tx.kind.as_str();
    // Input decoding is a sender reject. Mutation/invariant failures are outside it.
    let result = prepare(state, &tx, views).map_err(|e| match e {
        E::RejectedEntityTx { .. } => e,
        E::SnapshotInvalid { detail } => reject(kind, detail),
        _ => reject(kind, e.to_string()),
    })?;
    match result {
        Prepared::Policy {
            row,
            facility,
            message,
        } => {
            let book = state.lending.get_or_insert_with(Default::default);
            if facility {
                put(
                    book.facilities.get_or_insert_with(Vec::new),
                    facility_key(&row)?,
                    row,
                );
            } else {
                put(
                    book.terms.get_or_insert_with(Vec::new),
                    terms_key(&row)?,
                    row,
                );
            }
            events.push(EntityFrameEvent::Status { message });
        }
        Prepared::Account { hub, tx, message } => {
            out.push((hub, tx));
            events.push(EntityFrameEvent::Status { message });
            wakes.push(state.entity_id.clone());
        }
    }
    Ok(())
}
enum Prepared {
    Policy {
        row: V,
        facility: bool,
        message: String,
    },
    Account {
        hub: String,
        tx: AccountTx,
        message: String,
    },
}
fn prepare(
    state: &EntityStateSlice,
    tx: &CanonicalEntityTx,
    views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<Prepared, E> {
    let d = &tx.wire_data;
    let kind = tx.kind.as_str();
    if matches!(
        tx.kind,
        EntityTxKind::LendingSetTerms | EntityTxKind::LendingApprove
    ) {
        if !state.profile.is_hub {
            return Err(reject(kind, "LENDING_POLICY_BANK_REQUIRED"));
        }
        policy_input(d, tx.kind == EntityTxKind::LendingApprove)?;
        if tx.kind == EntityTxKind::LendingSetTerms {
            validate_terms(d)?;
            return Ok(Prepared::Policy {
                row: d.clone(),
                facility: false,
                message: format!(
                    "Bank terms set: token={} term={}",
                    number(d, "tokenId")?,
                    text(d, "termId")?
                ),
            });
        }
        exact(
            d,
            &[
                "borrowerEntityId",
                "tokenId",
                "termId",
                "maxPrincipal",
                "expiresAt",
            ],
            &[],
            "LENDING_POLICY_INPUT",
        )?;
        let borrower = text(d, "borrowerEntityId")?;
        let token = account_token(number(d, "tokenId")?)
            .ok_or_else(|| reject(kind, "LENDING_FACILITY_ACCOUNT_UNAVAILABLE"))?;
        let view = views
            .get(borrower)
            .filter(|v| v.active && v.owner_out_capacity.contains_key(&token))
            .ok_or_else(|| reject(kind, "LENDING_FACILITY_ACCOUNT_UNAVAILABLE"))?;
        let mut row = d.clone();
        set(&mut row, "chainId", n(view.lending.chain_id));
        set(
            &mut row,
            "depositoryAddress",
            s(&view.lending.depository_address),
        );
        set(&mut row, "jNonce", n(view.lending.j_nonce));
        validate_facility(&row)?;
        return Ok(Prepared::Policy {
            row,
            facility: true,
            message: format!(
                "Bank facility set: borrower={borrower} token={} term={} principal={}",
                number(d, "tokenId")?,
                text(d, "termId")?,
                big(d, "maxPrincipal")?
            ),
        });
    }
    let hub = text(d, "hubEntityId")?.trim().to_lowercase();
    let view = views.get(&hub).ok_or_else(|| {
        reject(
            kind,
            format!(
                "LENDING_HUB_ACCOUNT_MISSING:{}",
                if hub.is_empty() { "missing" } else { &hub }
            ),
        )
    })?;
    let owner = state.entity_id.to_lowercase();
    let id_field = match tx.kind {
        EntityTxKind::LendingOffer | EntityTxKind::LendingClosePosition => "positionId",
        EntityTxKind::LendingBorrow => "requestId",
        _ => "loanId",
    };
    let raw_id = text(d, id_field)?;
    let id = raw_id.trim().to_lowercase();
    let prefix = match id_field {
        "positionId" => "lend",
        "requestId" => "borrow",
        _ => "loan",
    };
    if !id.strip_prefix(&format!("{prefix}-")).is_some_and(|v| {
        v.len() == 16
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(reject(kind, format!("LENDING_INTENT_ID_INVALID:{raw_id}")));
    }
    if tx.kind == EntityTxKind::LendingClosePosition {
        return Ok(Prepared::Account {
            hub: hub.clone(),
            tx: AccountTx::LendingCloseRequest {
                position_id: id,
                hub_entity_id: hub,
                lender_entity_id: owner,
            },
            message: format!("Lending position close requested: {raw_id}"),
        });
    }
    let amount = big(d, "amount")?;
    if amount <= 0.into() {
        return Err(reject(
            kind,
            format!(
                "{}_AMOUNT_MUST_BE_POSITIVE",
                match tx.kind {
                    EntityTxKind::LendingOffer => "LENDING_FUND",
                    EntityTxKind::LendingBorrow => "LENDING_BORROW",
                    _ => "LENDING_REPAY",
                }
            ),
        ));
    }
    let raw_token = number(d, "tokenId")?;
    let tx = match tx.kind {
        EntityTxKind::LendingOffer => {
            let term_id = term(text(d, "termId")?)?;
            let bps = number(d, "interestBps")?;
            if bps > 10000 {
                return Err(err("LENDING_INVALID_INTEREST_BPS"));
            }
            let token =
                account_token(raw_token).filter(|t| view.owner_out_capacity.contains_key(t));
            let Some(token) = token else {
                return Err(reject(
                    kind,
                    format!("LENDING_TOKEN_NOT_ENABLED:{raw_token}"),
                ));
            };
            AccountTx::LendingFund {
                position_id: id,
                hub_entity_id: hub.clone(),
                lender_entity_id: owner,
                token_id: token,
                amount: amount.clone(),
                term_id,
                interest_bps: bps as i64,
            }
        }
        EntityTxKind::LendingBorrow => {
            let bps = number(d, "maxInterestBps")?;
            if bps > 10000 {
                return Err(err("LENDING_INVALID_INTEREST_BPS"));
            }
            AccountTx::LendingBorrowRequest {
                request_id: id,
                hub_entity_id: hub.clone(),
                borrower_entity_id: owner,
                token_id: raw_token,
                amount: amount.clone(),
                term_id: term(text(d, "termId")?)?,
                max_interest_bps: bps as i64,
                max_late_ms: number(d, "maxLateMs")?,
                expires_at: number(d, "expiresAt")?,
            }
        }
        EntityTxKind::LendingRepay => {
            let claim = view
                .lending
                .claims
                .get(&id)
                .ok_or_else(|| reject(kind, format!("LENDING_LOAN_NOT_FOUND:{id}")))?;
            AccountTx::LendingRepay {
                loan_id: id,
                hub_entity_id: hub.clone(),
                borrower_entity_id: owner,
                // The Account, not Entity admission, checks the exact signed token.
                token_id: raw_token,
                amount: amount.clone(),
                claim_hash: claim.hash(),
            }
        }
        _ => return Err(err("LENDING_COMMAND_INVALID")),
    };
    let message = match tx {
        AccountTx::LendingFund { .. } => {
            format!("Lending pool funding requested: {amount} token={raw_token}")
        }
        AccountTx::LendingBorrowRequest { .. } => {
            format!("Loan requested: {amount} token={raw_token}")
        }
        _ => format!("Loan repayment requested: {raw_id}"),
    };
    Ok(Prepared::Account { hub, tx, message })
}
