use xln_rscore_engine::AccountTx;

use crate::{EntityKernelError, EntityStateSlice};

use super::types::{PlaceSwapOfferEntityTx, ProposeCancelSwapEntityTx};

fn require_account(state: &EntityStateSlice, account_id: &str) -> Result<(), EntityKernelError> {
    if !state.known_accounts.contains(account_id) {
        return Err(EntityKernelError::AccountMissing {
            account_id: account_id.to_string(),
        });
    }
    Ok(())
}

pub(super) fn apply_place_swap_offer(
    state: &EntityStateSlice,
    tx: PlaceSwapOfferEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    wake_targets: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    require_account(state, &tx.counterparty_entity_id)?;
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SwapOffer {
            offer_id: tx.offer_id,
            give_token_id: tx.give_token_id,
            give_token_decimals: tx.give_token_decimals,
            give_amount: tx.give_amount,
            want_token_id: tx.want_token_id,
            want_token_decimals: tx.want_token_decimals,
            want_amount: tx.want_amount,
            max_fee: tx.max_fee,
            min_net_receive: tx.min_net_receive,
            time_in_force: tx.time_in_force,
            price_ticks: tx.price_ticks,
            cross_jurisdiction: None,
        },
    ));
    wake_targets.push(state.entity_id.clone());
    Ok(())
}

pub(super) fn apply_cancel_swap(
    state: &EntityStateSlice,
    tx: ProposeCancelSwapEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    wake_targets: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    require_account(state, &tx.counterparty_entity_id)?;
    account_txs.push((
        tx.counterparty_entity_id,
        AccountTx::SwapCancelRequest {
            offer_id: tx.offer_id,
        },
    ));
    wake_targets.push(state.entity_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigInt;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn same_j_requests_preserve_exact_account_payloads_and_each_wakes_self() {
        let owner = entity("11");
        let peer = entity("22");
        let mut state = EntityStateSlice::empty(owner.clone(), 100);
        state.known_accounts.insert(peer.clone());
        let mut account_txs = Vec::new();
        let mut wakes = Vec::new();
        apply_place_swap_offer(
            &state,
            PlaceSwapOfferEntityTx {
                counterparty_entity_id: peer.clone(),
                offer_id: "offer-1".into(),
                give_token_id: 1,
                give_token_decimals: 6,
                give_amount: BigInt::from(25),
                want_token_id: 2,
                want_token_decimals: 18,
                want_amount: BigInt::from(1),
                max_fee: BigInt::from(3),
                min_net_receive: BigInt::from(22),
                price_ticks: Some(BigInt::from(25_000_000)),
                time_in_force: Some(0),
            },
            &mut account_txs,
            &mut wakes,
        )
        .expect("offer");
        apply_cancel_swap(
            &state,
            ProposeCancelSwapEntityTx {
                counterparty_entity_id: peer.clone(),
                offer_id: "offer-1".into(),
            },
            &mut account_txs,
            &mut wakes,
        )
        .expect("cancel");
        assert_eq!(wakes, vec![owner.clone(), owner]);
        assert!(matches!(
            account_txs.as_slice(),
            [
                (offer_peer, AccountTx::SwapOffer { offer_id, price_ticks, .. }),
                (cancel_peer, AccountTx::SwapCancelRequest { offer_id: cancel_id }),
            ] if offer_peer == &peer
                && cancel_peer == &peer
                && offer_id == "offer-1"
                && cancel_id == "offer-1"
                && price_ticks.as_ref() == Some(&BigInt::from(25_000_000))
        ));
    }
}
