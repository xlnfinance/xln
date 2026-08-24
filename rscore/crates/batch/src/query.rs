//! Read-only engine queries: capacity rows and whole-engine reducers.
//!
//! Queries never touch revision or pending state — they read the committed
//! account map, so a session may serve them between Prepare and Commit. The
//! reducers run one bounded pass on the worker pool and return fixed-size
//! accumulators instead of streaming account bodies over the wire.

use num_bigint::BigInt;
use rayon::prelude::*;
use xln_rscore_engine::{DeltaPerspective, Side, TokenId};

use crate::stateful::StatefulBatchEngine;
use crate::types::AccountId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapacityRequest {
    pub account_id: AccountId,
    pub token_id: TokenId,
    pub side: Side,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSummaryRow {
    pub account_id: AccountId,
    pub owner_side: Side,
    pub delta_rows: u64,
    pub htlc_locks: u64,
    pub deltas_root: [u8; 32],
    pub htlc_locks_root: [u8; 32],
    /// The whole account leaf: identity, dispute config, journal counters and
    /// every section — not just the two financial maps. Comparing only the
    /// map roots left carried sections and counters unverified.
    pub account_state_root: [u8; 32],
    /// Engine-owned sections beyond the two financial maps, so a divergence
    /// dump names the section instead of one opaque leaf hash.
    pub swap_offers_root: [u8; 32],
    pub rebalance_fee_policies_root: [u8; 32],
    /// The leaf this account occupies in the Entity's accounts tree: the whole
    /// replica shell plus the financial root.
    pub entity_account_leaf: [u8; 32],
    /// Root of the queued account txs, derived by the engine from the shell.
    pub mempool_root: [u8; 32],
    pub mempool_len: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenTotals {
    pub token_id: TokenId,
    pub rows: u64,
    pub collateral: BigInt,
    pub owner_in_capacity: BigInt,
    pub owner_out_capacity: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineTotals {
    pub accounts: u64,
    pub htlc_locks: u64,
    pub tokens: Vec<TokenTotals>,
}

impl TokenTotals {
    fn empty(token_id: TokenId) -> Self {
        Self {
            token_id,
            rows: 0,
            collateral: BigInt::from(0),
            owner_in_capacity: BigInt::from(0),
            owner_out_capacity: BigInt::from(0),
        }
    }

    fn absorb(&mut self, other: &Self) {
        self.rows += other.rows;
        self.collateral += &other.collateral;
        self.owner_in_capacity += &other.owner_in_capacity;
        self.owner_out_capacity += &other.owner_out_capacity;
    }
}

impl StatefulBatchEngine {
    /// One perspective row per request; `None` marks a missing account or a
    /// token the account has never touched.
    pub fn capacity_batch(&self, requests: &[CapacityRequest]) -> Vec<Option<DeltaPerspective>> {
        requests
            .iter()
            .map(|request| {
                self.account(&request.account_id)
                    .and_then(|replica| replica.state().delta(request.token_id))
                    .map(|delta| delta.perspective(request.side))
            })
            .collect()
    }

    /// Deterministic page of account summaries ordered by account id, starting
    /// strictly after `cursor`.
    pub fn summary_page(
        &self,
        cursor: Option<AccountId>,
        limit: usize,
    ) -> Result<(Vec<AccountSummaryRow>, Option<AccountId>), xln_rscore_engine::StateError> {
        let mut rows = Vec::with_capacity(limit.min(64));
        let mut next_cursor = None;
        for (account_id, replica) in self.accounts_after(cursor) {
            if rows.len() == limit {
                // The cursor is the LAST INCLUDED id, because `accounts_after`
                // resumes strictly after it. Returning the first excluded id
                // here silently dropped exactly one account per page boundary.
                next_cursor = rows.last().map(|row: &AccountSummaryRow| row.account_id);
                break;
            }
            let state = replica.state();
            rows.push(AccountSummaryRow {
                account_id,
                owner_side: replica.owner_side(),
                delta_rows: state.delta_count() as u64,
                htlc_locks: state.htlc_count() as u64,
                deltas_root: state.deltas_root(),
                htlc_locks_root: state.htlc_locks_root(),
                // Fallible: substituting a zero root here turned an encoding
                // or commitment failure into an ordinary-looking mismatch and
                // threw the cause away.
                account_state_root: state.payment_profile_account_state_root()?,
                swap_offers_root: state.swap_offers_root(),
                rebalance_fee_policies_root: state.rebalance_fee_policies_root(),
                entity_account_leaf: replica.entity_account_leaf()?,
                mempool_root: replica
                    .envelope()
                    .mempool_root()
                    .map_err(|error| xln_rscore_engine::StateError::Envelope(error.to_string()))?,
                mempool_len: replica.envelope().mempool_len() as u64,
            });
        }
        Ok((rows, next_cursor))
    }

    /// Whole-engine reducers for the requested tokens, computed in one
    /// parallel pass on the batch worker pool. Capacity sums use each
    /// replica's own (owner) perspective.
    pub fn totals(&self, token_ids: &[TokenId]) -> EngineTotals {
        let accounts: Vec<_> = self.accounts_after(None).collect();
        let fold = |mut acc: (u64, Vec<TokenTotals>),
                    replica: &&xln_rscore_engine::AccountReplica| {
            let state = replica.state();
            acc.0 += state.htlc_count() as u64;
            for slot in &mut acc.1 {
                if let Some(delta) = state.delta(slot.token_id) {
                    let view = delta.perspective(replica.owner_side());
                    slot.rows += 1;
                    slot.collateral += delta.collateral();
                    slot.owner_in_capacity += &view.in_capacity;
                    slot.owner_out_capacity += &view.out_capacity;
                }
            }
            acc
        };
        let empty = || {
            (
                0_u64,
                token_ids
                    .iter()
                    .map(|token| TokenTotals::empty(*token))
                    .collect::<Vec<_>>(),
            )
        };
        let merge = |mut left: (u64, Vec<TokenTotals>), right: (u64, Vec<TokenTotals>)| {
            left.0 += right.0;
            for (slot, other) in left.1.iter_mut().zip(right.1.iter()) {
                slot.absorb(other);
            }
            left
        };
        let (htlc_locks, tokens) = self.pool().install(|| {
            accounts
                .par_iter()
                .map(|(_, replica)| replica)
                .fold(empty, fold)
                .reduce(empty, merge)
        });
        EngineTotals {
            accounts: accounts.len() as u64,
            htlc_locks,
            tokens,
        }
    }
}
