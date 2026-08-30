//! Rebuild the Entity-local swap-offer cache from exact Account checkpoints.

use std::collections::{BTreeMap, BTreeSet};

use xln_rscore_batch::AccountRestore;
use xln_rscore_engine::AccountTx;
use xln_rscore_entity_kernel::SameJOffer;

fn account_text(account: &xln_rscore_batch::AccountId) -> String {
    format!("0x{account}")
}

pub struct RestoredOrderbookAccounts {
    pub offers: BTreeMap<(String, String), SameJOffer>,
    pub resolving_offers: BTreeSet<(String, String)>,
}

fn resolve_id(tx: &AccountTx) -> Option<&str> {
    match tx {
        AccountTx::SwapResolve { offer_id, .. } => Some(offer_id),
        _ => None,
    }
}

pub fn restore_orderbook_accounts(rows: &[AccountRestore]) -> RestoredOrderbookAccounts {
    let mut offers = BTreeMap::new();
    let mut resolving_offers = BTreeSet::new();
    for row in rows {
        let account_id = account_text(&row.account_id);
        let identity = row.replica.state().identity();
        for offer in row.replica.state().swap_offers() {
            let snapshot =
                offer.snapshot(identity.left().to_string(), identity.right().to_string());
            let offer_id = snapshot.offer_id.clone();
            offers.insert((account_id.clone(), offer_id), SameJOffer::from(snapshot));
        }
        let pending = row
            .consensus
            .pending
            .as_ref()
            .into_iter()
            .flat_map(|pending| pending.frame.txs.iter());
        for offer_id in row
            .consensus
            .mempool
            .iter()
            .chain(pending)
            .filter_map(resolve_id)
        {
            resolving_offers.insert((account_id.clone(), offer_id.to_owned()));
        }
    }
    RestoredOrderbookAccounts {
        offers,
        resolving_offers,
    }
}
