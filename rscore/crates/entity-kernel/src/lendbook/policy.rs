use super::state::*;
use crate::{EntityKernelError as E, local_financial::LocalAccountFinancialView};
use xln_rscore_engine::{AccountTx, LendingTermId};
use xln_rscore_protocol::CanonicalValue;
pub fn approved_draw(
    book: &LendingState,
    view: &LocalAccountFinancialView,
    tx: &AccountTx,
    now: u64,
) -> Result<Result<(CanonicalValue, u64, u64), &'static str>, E> {
    let AccountTx::LendingBorrowRequest {
        borrower_entity_id,
        token_id,
        amount,
        term_id,
        max_interest_bps,
        max_late_ms,
        expires_at,
        ..
    } = tx
    else {
        unreachable!()
    };
    if now >= *expires_at {
        return Ok(Err("borrower authorization expired"));
    }
    if *term_id == LendingTermId::Demand {
        return Ok(Err("loan requires a fixed term"));
    }
    let key = format!(
        "{}:{}:{token_id}:{}",
        view.lending.chain_id,
        view.lending.depository_address,
        term_id.wire_name()
    );
    let Some(terms) = book.terms.as_ref().and_then(|rows| find(rows, &key)) else {
        return Ok(Err("bank terms unavailable"));
    };
    if number(terms, "expiresAt")? <= now {
        return Ok(Err("bank terms unavailable"));
    }
    let bps = number(terms, "loanInterestBps")?;
    let late = number(terms, "loanLateMs")?;
    if bps > *max_interest_bps as u64 {
        return Ok(Err("bank rate exceeds requested maximum"));
    }
    if late > *max_late_ms {
        return Ok(Err("bank late-interest window exceeds requested maximum"));
    }
    let key = format!("{borrower_entity_id}:{token_id}:{}", term_id.wire_name());
    let Some(a) = book.facilities.as_ref().and_then(|rows| find(rows, &key)) else {
        return Ok(Err("no active bank approval"));
    };
    if number(a, "expiresAt")? <= now || big(a, "maxPrincipal")? == 0.into() {
        return Ok(Err("no active bank approval"));
    }
    if number(a, "chainId")? != view.lending.chain_id
        || text(a, "depositoryAddress")? != view.lending.depository_address
        || number(a, "jNonce")? != view.lending.j_nonce
    {
        return Ok(Err("approval belongs to another Account epoch"));
    }
    for (_, v) in &book.savings {
        if text(v, "status")? == "queued"
            && text(v, "lenderEntityId")? == borrower_entity_id
            && number(v, "tokenId")? == *token_id
        {
            return Ok(Err("pending withdrawal takes priority on this Account"));
        }
    }
    let mut reserved = num_bigint::BigInt::from(0);
    for (_, v) in &book.loans {
        if text(v, "borrowerEntityId")? == borrower_entity_id
            && number(v, "tokenId")? == *token_id
            && text(v, "termId")? == term_id.wire_name()
            && !matches!(text(v, "status")?, "repaid" | "disputed")
        {
            reserved += big(v, "principalAmount")?;
        }
    }
    if reserved + amount > big(a, "maxPrincipal")? {
        return Ok(Err("approved facility exhausted"));
    }
    Ok(Ok((a.clone(), bps, late)))
}
