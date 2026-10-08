//! Mirrors `handleRequestCreditEntityTx` in
//! `core/entity/tx/handlers/account/credit-request.ts`: local admission of the
//! requester's `credit_request`. The Account handler owns the binding checks
//! (requester = frame proposer, token lane, replay).

use num_bigint::BigInt;
use xln_rscore_engine::AccountTx;

use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice};

use super::types::RequestCreditEntityTx;

const KIND: &str = "requestCredit";

fn rejected(detail: String) -> EntityKernelError {
    EntityKernelError::RejectedEntityTx { kind: KIND, detail }
}

fn valid_request_id(value: &str) -> bool {
    value.strip_prefix("credit-").is_some_and(|suffix| {
        suffix.len() == 16
            && suffix
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

pub(super) fn apply_request_credit(
    state: &EntityStateSlice,
    tx: RequestCreditEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wake_targets: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return Err(rejected(format!(
            "CREDIT_REQUEST_ACCOUNT_MISSING:{}",
            tx.counterparty_entity_id
        )));
    }
    if !valid_request_id(&tx.request_id) {
        return Err(rejected(format!(
            "CREDIT_REQUEST_ID_INVALID:{}",
            tx.request_id
        )));
    }
    if tx.amount <= BigInt::from(0) {
        return Err(rejected("CREDIT_REQUEST_AMOUNT_MUST_BE_POSITIVE".into()));
    }
    events.push(EntityFrameEvent::Status {
        message: format!("Credit requested: {} token={}", tx.amount, tx.token_id),
    });
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::CreditRequest {
            request_id: tx.request_id,
            requester_entity_id: state.entity_id.clone(),
            token_id: tx.token_id,
            amount: tx.amount,
        },
    ));
    wake_targets.push(state.entity_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use xln_rscore_engine::TokenId;

    use super::*;

    const HUB: &str = "0x1010101010101010101010101010101010101010101010101010101010101010";
    const USER: &str = "0x3030303030303030303030303030303030303030303030303030303030303030";

    fn tx(counterparty: &str, request_id: &str, amount: u64) -> RequestCreditEntityTx {
        RequestCreditEntityTx {
            counterparty_entity_id: counterparty.into(),
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(amount),
            request_id: request_id.into(),
        }
    }

    #[test]
    fn admits_the_exact_typescript_credit_request() {
        let mut state = EntityStateSlice::empty(USER, 1_000);
        state.known_accounts.insert(HUB.to_string());
        let (mut account_txs, mut events, mut wakes) = (Vec::new(), Vec::new(), Vec::new());
        apply_request_credit(
            &state,
            tx(HUB, "credit-1111111111111111", 25_000_000),
            &mut account_txs,
            &mut events,
            &mut wakes,
        )
        .expect("admitted");
        assert_eq!(
            account_txs,
            vec![(
                HUB.to_string(),
                AccountTx::CreditRequest {
                    request_id: "credit-1111111111111111".into(),
                    requester_entity_id: USER.into(),
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(25_000_000),
                },
            )]
        );
        assert_eq!(
            events,
            vec![EntityFrameEvent::Status {
                message: "Credit requested: 25000000 token=1".into()
            }]
        );
        assert_eq!(wakes, vec![USER.to_string()]);
    }

    #[test]
    fn rejects_missing_account_bad_id_and_zero_amount() {
        let mut state = EntityStateSlice::empty(USER, 1_000);
        state.known_accounts.insert(HUB.to_string());
        let mut sink = (Vec::new(), Vec::new(), Vec::new());
        let mut run = |tx| apply_request_credit(&state, tx, &mut sink.0, &mut sink.1, &mut sink.2);
        assert!(run(tx(USER, "credit-1111111111111111", 1)).is_err());
        assert!(run(tx(HUB, "credit-XYZ", 1)).is_err());
        assert!(run(tx(HUB, "credit-1111111111111111", 0)).is_err());
    }
}
