use xln_rscore_engine::AccountTx;

use crate::{EntityFrameEvent, EntityStateSlice};

use super::types::ExtendCreditEntityTx;

pub(super) fn apply_extend_credit(
    state: &EntityStateSlice,
    tx: ExtendCreditEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wake_targets: &mut Vec<String>,
) {
    // TypeScript treats a missing Account as an unchanged Entity transition.
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return;
    }
    events.push(EntityFrameEvent::Status {
        message: format!(
            "💳 Extended credit of {} to {}",
            tx.amount,
            &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
        ),
    });
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SetCreditLimit {
            token_id: tx.token_id,
            amount: tx.amount,
        },
    ));
    wake_targets.push(state.entity_id.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigInt;
    use xln_rscore_engine::TokenId;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn exact_ts_credit_projection_and_missing_account_noop() {
        let owner = entity("11");
        let peer = entity("22");
        let mut state = EntityStateSlice::empty(owner.clone(), 100);
        let tx = ExtendCreditEntityTx {
            counterparty_entity_id: peer.clone(),
            token_id: TokenId::new(2).expect("token"),
            amount: BigInt::from(7),
        };
        let (mut account_txs, mut events, mut wakes) = (Vec::new(), Vec::new(), Vec::new());
        apply_extend_credit(
            &state,
            tx.clone(),
            &mut account_txs,
            &mut events,
            &mut wakes,
        );
        assert!(account_txs.is_empty() && events.is_empty() && wakes.is_empty());

        state.known_accounts.insert(peer.clone());
        apply_extend_credit(&state, tx, &mut account_txs, &mut events, &mut wakes);
        assert!(matches!(
            account_txs.as_slice(),
            [(account_id, AccountTx::SetCreditLimit { token_id, amount })]
                if account_id == &peer && token_id.get() == 2 && amount == &BigInt::from(7)
        ));
        assert_eq!(wakes, vec![owner]);
        assert!(
            matches!(events.as_slice(), [EntityFrameEvent::Status { message }] if message.ends_with("2222"))
        );
    }
}
