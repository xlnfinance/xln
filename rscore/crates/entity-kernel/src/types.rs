use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::{AccountDomain, AccountOutput, AccountTx, OpaqueHtlcCiphertext};

use crate::orderbook::{OrderbookState, PairPolicy};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JurisdictionScope {
    Same,
    Cross,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedAccountTransition {
    pub tx: AccountTx,
    pub outputs: Vec<AccountOutput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderedAccountCommit {
    pub account_id: String,
    pub domain: AccountDomain,
    pub scope: JurisdictionScope,
    pub committed_via_new_frame: bool,
    pub frame_state_hash: String,
    pub frame_height: u64,
    pub frame_timestamp: u64,
    pub transitions: Vec<CommittedAccountTransition>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcPreparedBinding {
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub domain: AccountDomain,
    pub account_frame_hash: String,
    pub account_height: u64,
    pub lock_id: String,
    pub envelope_hash: String,
    pub hashlock: String,
    pub token_id: u16,
    pub amount: BigInt,
    pub timelock: BigInt,
    pub reveal_before_height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HtlcPreparedOutcome {
    Reject {
        reason: String,
    },
    Final {
        secret: String,
        started_at_ms: Option<u64>,
    },
    Forward {
        next_hop_entity_id: String,
        forward_amount: BigInt,
        inner_envelope: OpaqueHtlcCiphertext,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedHtlcEntry {
    pub binding: HtlcPreparedBinding,
    pub outcome: HtlcPreparedOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeterministicContext {
    pub minimum_trade_size: BigInt,
    pub swap_taker_fee_bps: u16,
    pub jurisdiction_id: Option<String>,
    pub pair_policies: BTreeMap<String, PairPolicy>,
    pub prepared_htlcs: BTreeMap<(String, String), PreparedHtlcEntry>,
}

impl DeterministicContext {
    pub fn hlt_default() -> Self {
        Self {
            minimum_trade_size: BigInt::from(0),
            swap_taker_fee_bps: 1,
            jurisdiction_id: None,
            pair_policies: BTreeMap::from([(
                "1/2".to_string(),
                PairPolicy {
                    price_step_ticks: 1,
                    book_bucket_width_ticks: 10_000,
                    mid_price_ticks: BigInt::from(25_000_000),
                },
            )]),
            prepared_htlcs: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcRoute {
    pub hashlock: String,
    pub token_id: Option<u16>,
    pub amount: Option<BigInt>,
    pub started_at_ms: Option<u64>,
    pub originated: bool,
    pub inbound_entity: Option<String>,
    pub inbound_lock_id: Option<String>,
    pub outbound_entity: Option<String>,
    pub outbound_lock_id: Option<String>,
    pub inbound_settled: bool,
    pub outbound_settled: bool,
    pub secret: Option<String>,
    pub secret_ack_pending: bool,
    pub secret_ack_started_at: Option<u64>,
    pub secret_ack_deadline_at: Option<u64>,
    pub pending_fee: Option<BigInt>,
    pub created_timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockBookEntry {
    pub lock_id: String,
    pub account_id: String,
    pub token_id: u16,
    pub amount: BigInt,
    pub hashlock: String,
    pub timelock: BigInt,
    pub outgoing: bool,
    pub created_at: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityStateSlice {
    pub entity_id: String,
    pub timestamp: u64,
    pub known_accounts: BTreeSet<String>,
    pub htlc_routes: BTreeMap<String, HtlcRoute>,
    pub htlc_fees_earned: BigInt,
    pub lock_book: BTreeMap<String, LockBookEntry>,
    pub orderbook: Option<OrderbookState>,
}

impl EntityStateSlice {
    pub fn empty(entity_id: impl Into<String>, timestamp: u64) -> Self {
        Self {
            entity_id: entity_id.into(),
            timestamp,
            known_accounts: BTreeSet::new(),
            htlc_routes: BTreeMap::new(),
            htlc_fees_earned: BigInt::from(0),
            lock_book: BTreeMap::new(),
            orderbook: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountProposalWork {
    pub account_id: String,
    pub txs: Vec<AccountTx>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityKernelOutput {
    HtlcForwardAccepted {
        entity_id: String,
        hashlock: String,
    },
    HtlcFailed {
        entity_id: String,
        hashlock: String,
        lock_id: Option<String>,
        reason: String,
    },
    HtlcReceived {
        entity_id: String,
        from_entity: String,
        to_entity: String,
        hashlock: String,
        lock_id: String,
        token_id: Option<u16>,
        amount: Option<BigInt>,
        started_at_ms: Option<u64>,
        jurisdiction_id: Option<String>,
        received_at_ms: u64,
    },
    HtlcFinalized {
        entity_id: String,
        from_entity: String,
        to_entity: Option<String>,
        hashlock: String,
        secret: String,
        lock_id: Option<String>,
        token_id: Option<u16>,
        amount: Option<BigInt>,
        started_at_ms: Option<u64>,
        jurisdiction_id: Option<String>,
        finalized_at_ms: u64,
    },
    SwapMatched {
        entity_id: String,
        count: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityKernelCommitments {
    pub paybook_root: String,
    pub orderbook_root: String,
    pub ordered_outbox_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityKernelResult {
    pub state: EntityStateSlice,
    pub proposal_work: Vec<AccountProposalWork>,
    pub outputs: Vec<EntityKernelOutput>,
    pub commitments: EntityKernelCommitments,
}

pub(crate) type TargetedAccountTx = (String, AccountTx);
