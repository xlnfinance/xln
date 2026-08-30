use xln_rscore_engine::AccountTx;

use crate::EntityStateSlice;

use super::types::RequestCollateralEntityTx;

pub(super) fn apply_request_collateral(
    state: &EntityStateSlice,
    tx: RequestCollateralEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    wake_targets: &mut Vec<String>,
) {
    // Exact TypeScript behavior: a request for an absent Account is a
    // deterministic no-op. Account validation owns economic bounds once the
    // request reaches the bilateral machine.
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        return;
    }
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::RequestCollateral {
            token_id: tx.token_id,
            amount: tx.amount,
            fee_token_id: tx.fee_token_id,
            fee_amount: tx.fee_amount,
            policy_version: tx.policy_version,
        },
    ));
    wake_targets.push(state.entity_id.clone());
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;
    use xln_rscore_engine::TokenId;

    use super::*;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn exact_ts_request_projection_and_missing_account_noop() {
        let owner = entity("11");
        let peer = entity("22");
        let mut state = EntityStateSlice::empty(owner.clone(), 100);
        let tx = RequestCollateralEntityTx {
            counterparty_entity_id: peer.clone(),
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(5),
            fee_token_id: Some(TokenId::new(2).expect("fee token")),
            fee_amount: BigInt::from(1),
            policy_version: 3,
        };
        let (mut account_txs, mut wakes) = (Vec::new(), Vec::new());
        apply_request_collateral(&state, tx.clone(), &mut account_txs, &mut wakes);
        assert!(account_txs.is_empty() && wakes.is_empty());

        state.known_accounts.insert(peer.clone());
        apply_request_collateral(&state, tx, &mut account_txs, &mut wakes);
        assert!(matches!(
            account_txs.as_slice(),
            [(account_id, AccountTx::RequestCollateral {
                token_id,
                amount,
                fee_token_id: Some(fee_token_id),
                fee_amount,
                policy_version: 3,
            })] if account_id == &peer
                && token_id.get() == 1
                && fee_token_id.get() == 2
                && amount == &BigInt::from(5)
                && fee_amount == &BigInt::from(1)
        ));
        assert_eq!(wakes, vec![owner]);
    }
}
