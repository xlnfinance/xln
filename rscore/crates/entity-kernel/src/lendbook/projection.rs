use super::state::*;
use crate::EntityKernelError as E;
use std::collections::BTreeMap;
use xln_rscore_engine::lending::LendingAccountView;
use xln_rscore_protocol::CanonicalValue as V;
pub fn summarize_lending_state(
    book: Option<&LendingState>,
    time: u64,
    user: &str,
    token: Option<f64>,
    request: Option<&str>,
    accounts: &BTreeMap<String, LendingAccountView>,
) -> Result<V, E> {
    let empty = LendingState::default();
    let book = book.unwrap_or(&empty);
    let token_matches = |v: &V| -> Result<bool, E> {
        Ok(token.is_none_or(|t| number(v, "tokenId").is_ok_and(|id| id as f64 == t)))
    };
    let mut savings = Vec::new();
    let mut loans = Vec::new();
    let mut savings_total = num_bigint::BigInt::from(0);
    let mut loan_total = num_bigint::BigInt::from(0);
    let mut active_total = num_bigint::BigInt::from(0);
    for (id, v) in &book.savings {
        if !token_matches(v)? {
            continue;
        }
        let status = text(v, "status")?;
        if matches!(status, "open" | "queued") {
            savings_total += big(v, "principalAmount")?;
        }
        let lender = text(v, "lenderEntityId")?;
        if !user.is_empty() && lender.to_lowercase() != user {
            continue;
        }
        let demand = text(v, "termId")? == "demand";
        let claim = if demand && matches!(status, "open" | "queued") {
            Some(
                accounts
                    .get(lender)
                    .and_then(|a| a.claims.get(id))
                    .ok_or_else(|| err("LENDING_DEMAND_ACCOUNT_MISSING"))?,
            )
        } else {
            None
        };
        if let Some(c) = claim {
            if c.kind != "demand"
                || u64::from(c.token_id) != number(v, "tokenId")?
                || c.principal != big(v, "principalAmount")?
            {
                return Err(err("LENDING_DEMAND_CLAIM_BINDING"));
            }
        }
        let mut row = v.clone();
        if let Some(c) = claim {
            set(&mut row, "interestBps", n(c.interest_bps));
        }
        set(
            &mut row,
            "closeAmount",
            V::BigInt(close_amount(v, time, claim)?),
        );
        set(
            &mut row,
            "matured",
            V::Bool(!demand && time >= number(v, "createdAt")? + number(v, "termMs")?),
        );
        set(
            &mut row,
            "rateExpiresAt",
            claim.map_or(V::Null, |c| n(c.opened_at + c.term_ms)),
        );
        savings.push(row);
    }
    for (_, v) in &book.loans {
        if !token_matches(v)? {
            continue;
        }
        let status = text(v, "status")?;
        let principal = big(v, "principalAmount")?;
        if !matches!(status, "repaid" | "disputed") {
            loan_total += &principal;
        }
        if matches!(status, "opening" | "active" | "closing") {
            active_total += principal;
        }
        if !user.is_empty() && text(v, "borrowerEntityId")?.to_lowercase() != user {
            continue;
        }
        let mut row = v.clone();
        if matches!(status, "active" | "defaulted") {
            set(
                &mut row,
                "repaymentAmount",
                V::BigInt(big(v, "repaidAmount")? + loan_clock(v)?.exit(time)),
            );
        }
        loans.push(row);
    }
    let sort = |rows: &mut Vec<V>, id: &str| {
        rows.sort_by(|a, b| {
            number(b, "updatedAt")
                .unwrap()
                .cmp(&number(a, "updatedAt").unwrap())
                .then_with(|| text(a, id).unwrap().cmp(text(b, id).unwrap()))
        });
    };
    sort(&mut savings, "positionId");
    sort(&mut loans, "loanId");
    let terms = book
        .terms
        .iter()
        .flatten()
        .filter_map(|(_, v)| match token_matches(v) {
            Ok(true) => Some(Ok(v.clone())),
            Ok(false) => None,
            Err(e) => Some(Err(e)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let facilities = book
        .facilities
        .iter()
        .flatten()
        .filter_map(|(_, v)| {
            match token_matches(v).and_then(|yes| Ok(yes && text(v, "borrowerEntityId")? == user)) {
                Ok(true) => Some(Ok(v.clone())),
                Ok(false) => None,
                Err(e) => Some(Err(e)),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let request_status = if let Some(id) = request {
        let loan = book.loans.iter().find(|(_, v)| {
            text(v, "requestId") == Ok(id) && text(v, "borrowerEntityId") == Ok(user)
        });
        s(if let Some((_, v)) = loan {
            text(v, "status")?
        } else if accounts.get(user).is_some_and(|a| {
            a.intents.get(&format!("borrow:{id}"))
                == Some(&xln_rscore_engine::LendingIntentKind::Borrow)
        }) {
            "not-funded"
        } else {
            "unseen"
        })
    } else {
        V::Null
    };
    Ok(obj(vec![
        ("requestStatus", request_status),
        ("savings", V::Array(savings)),
        ("loans", V::Array(loans)),
        ("terms", V::Array(terms)),
        ("facilities", V::Array(facilities)),
        (
            "totals",
            obj(vec![
                ("savingsPrincipalAmount", s(savings_total.to_string())),
                ("loanPrincipalAmount", s(loan_total.to_string())),
                ("activePrincipalAmount", s(active_total.to_string())),
            ]),
        ),
    ]))
}
