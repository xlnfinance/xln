use crate::lending::{bigint_json, hash_json};
use crate::tx::apply_types::MutationDecision;
use crate::tx::handlers::balance::{DirectPayment, direct_payment};
use crate::{
    AccountRejection, AccountReplica, AccountTx, Side, TokenId, TransitionError,
    ValidationRejection,
};
use num_bigint::BigInt;
pub(super) fn reject(message: impl Into<String>) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(
        ValidationRejection::AccountTx {
            message: message.into(),
        },
    ))
}
pub(super) fn reject_fault(message: String) -> MutationDecision {
    MutationDecision::rejected_with_events(
        AccountRejection::Validation(ValidationRejection::AccountTx {
            message: message.clone(),
        }),
        vec![message],
    )
}
pub(super) fn normalized(s: &str) -> String {
    s.trim().to_lowercase()
}
pub(super) fn intent(id: &str, prefix: &str) -> Result<(), TransitionError> {
    let n = normalized(id);
    if !n.strip_prefix(&format!("{prefix}-")).is_some_and(|s| {
        s.len() == 16
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(TransitionError::LendingIntentIdInvalid(id.into()));
    }
    Ok(())
}
pub(super) fn parties(
    a: &AccountReplica,
    side: Side,
    role: &'static str,
    payer: &str,
    peer: &str,
) -> Result<(), TransitionError> {
    if !payer.strip_prefix("0x").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(TransitionError::LendingRoleInvalid {
            role,
            claimed: payer.into(),
        });
    }
    let identity = a.state().identity();
    let proposer = identity.entity(side).to_string();
    if payer != proposer {
        return Err(TransitionError::LendingRoleNotProposer {
            role,
            claimed: payer.into(),
            proposer,
        });
    }
    let expected = identity.entity(side.opposite()).to_string();
    if peer != expected {
        return Err(TransitionError::LendingCounterpartyInvalid {
            expected,
            actual: peer.into(),
        });
    }
    Ok(())
}
pub(super) fn rate(n: i64) -> Result<(), TransitionError> {
    if !(0..=10000).contains(&n) {
        return Err(TransitionError::LendingInterestBpsInvalid(n));
    }
    Ok(())
}
pub(super) fn payment(
    a: &mut AccountReplica,
    tx: &AccountTx,
    side: Side,
    token: TokenId,
    amount: &BigInt,
) -> Result<MutationDecision, TransitionError> {
    let payer = a.state().identity().entity(side).to_string();
    let peer = a.state().identity().entity(side.opposite()).to_string();
    direct_payment(
        a,
        DirectPayment {
            token_id: token,
            amount,
            route: &[peer.clone()],
            description: Some(&format!("xln:{}", tx.wire_name())),
            from_entity_id: &payer,
            to_entity_id: &peer,
            delivery_mode: crate::DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        },
        side,
    )
}
pub(super) fn auth(a: &AccountReplica, tx: &AccountTx) -> String {
    let (id, hub, borrower, token, amount, term, rate, late, expiry) = match tx {
        AccountTx::LendingBorrowRequest {
            request_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            amount,
            term_id,
            max_interest_bps,
            max_late_ms,
            expires_at,
        } => (
            request_id,
            hub_entity_id,
            borrower_entity_id,
            *token_id,
            amount,
            term_id,
            max_interest_bps,
            max_late_ms,
            expires_at,
        ),
        AccountTx::LendingDisburse {
            request_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            amount,
            term_id,
            max_interest_bps,
            max_late_ms,
            expires_at,
            ..
        } => (
            request_id,
            hub_entity_id,
            borrower_entity_id,
            u64::from(token_id.get()),
            amount,
            term_id,
            max_interest_bps,
            max_late_ms,
            expires_at,
        ),
        _ => unreachable!(),
    };
    let d = a.state().identity().domain();
    format!(
        "authorize:{}",
        hash_json(&serde_json::json!([
            "xln:borrow",
            d.chain_id(),
            format!("0x{}", hex::encode(d.depository_address().bytes())),
            a.state().j_nonce(),
            id,
            hub,
            borrower,
            token,
            bigint_json(amount),
            term.wire_name(),
            rate,
            late,
            expiry
        ]))
    )
}
pub(super) fn applied(d: &MutationDecision) -> bool {
    matches!(d, MutationDecision::Applied { .. })
}
