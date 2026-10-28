use super::*;

pub(super) fn fund(
    a: &mut AccountReplica,
    tx: &AccountTx,
    side: Side,
    time: u64,
) -> Result<MutationDecision, TransitionError> {
    let (savings, id, payer, peer, token, amount, term, bps, late) = match tx {
        AccountTx::LendingFund {
            position_id,
            hub_entity_id,
            lender_entity_id,
            token_id,
            amount,
            term_id,
            interest_bps,
        } => (
            true,
            position_id,
            lender_entity_id,
            hub_entity_id,
            *token_id,
            amount,
            *term_id,
            *interest_bps,
            0,
        ),
        AccountTx::LendingDisburse {
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            amount,
            term_id,
            interest_bps,
            late_ms,
            ..
        } => (
            false,
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            *token_id,
            amount,
            *term_id,
            *interest_bps,
            *late_ms,
        ),
        _ => unreachable!(),
    };
    if *id != normalized(id) {
        return Ok(reject("LENDING_POSITION_ID_NON_CANONICAL"));
    }
    intent(id, if savings { "lend" } else { "loan" })?;
    parties(a, side, if savings { "LENDER" } else { "HUB" }, payer, peer)?;
    positive_amount(amount, "LENDING_FUND")?;
    rate(bps)?;
    let kind = if savings {
        Intent::Fund
    } else {
        Intent::Disburse
    };
    let key = format!("{}:{id}", kind.wire_name());
    require_unused_intent(a, &key)?;
    if let AccountTx::LendingDisburse {
        expires_at,
        max_interest_bps,
        max_late_ms,
        ..
    } = tx
    {
        if late > MAX_CLOCK {
            return Ok(reject_fault(format!("LENDING_LATE_WINDOW_INVALID:{late}")));
        }
        if *max_late_ms > MAX_CLOCK {
            return Ok(reject_fault(format!(
                "LENDING_MAX_LATE_WINDOW_INVALID:{max_late_ms}"
            )));
        }
        if time >= *expires_at
            || bps > *max_interest_bps
            || late > *max_late_ms
            || a.state().lending_intent(&auth(a, tx)) != Some(Intent::Borrow)
        {
            return Ok(reject("LENDING_BORROW_AUTHORIZATION_MISMATCH"));
        }
    }
    if savings {
        let insufficient = a.state().delta(token).is_none_or(|d| {
            let v = d.perspective(side);
            let unused = (&v.own_credit_limit - &v.in_own_credit).max(0.into());
            amount + unused > v.out_capacity
        });
        if insufficient {
            return Ok(reject("LENDING_FUND_OWNED_BALANCE_INSUFFICIENT"));
        }
    } else if term == LendingTermId::Demand {
        return Ok(reject("LENDING_LOAN_TERM_REQUIRED"));
    }
    if time
        .checked_add(term_ms(term))
        .is_none_or(|v| v > MAX_CLOCK)
    {
        return Ok(reject("LENDING_SAVINGS_MATURITY_OVERFLOW"));
    }
    let c = LendingCovenant {
        kind: if !savings {
            "loan"
        } else if term == LendingTermId::Demand {
            "demand"
        } else {
            "savings"
        }
        .into(),
        token_id: u32::from(token.get()),
        creditor_is_left: side == Side::Left,
        principal: amount.clone(),
        interest_bps: bps as u64,
        opened_at: time,
        accrued_at: time,
        accrued_interest: 0.into(),
        interest_remainder: 0.into(),
        term_ms: term_ms(term),
        late_ms: late,
    };
    if c.maximum() > (BigInt::from(1) << 256) - 1 {
        return Ok(reject("LENDING_SAVINGS_AMOUNT_OVERFLOW"));
    }
    c.validate()?;
    let authorization = (!savings).then(|| auth(a, tx));
    let result = payment(a, tx, side, token, amount)?;
    if applied(&result) {
        consume_intent(a, key, kind)?;
        if let Some(key) = authorization {
            a.state_mut().remove_intent(&key)?;
        }
        a.state_mut().put_lending_claim(id.clone(), c)?;
    }
    Ok(result)
}
