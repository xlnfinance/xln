use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::{AccountDomain, AccountOutput, AccountTx, OpaqueHtlcCiphertext};
use xln_rscore_protocol::CanonicalValue;

use crate::orderbook::{OrderbookState, PairPolicy};
use crate::scheduler::CrontabState;

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
        description: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginatedHtlcDeliveryMode {
    Instant,
    Async,
}

/// Exact proposer materialization for one local `htlcPayment` EntityTx.
/// The onion envelope contains proposer entropy; all remaining fields are
/// deterministic evidence validators check against the EntityTx and profiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedOriginatedHtlcPayment {
    pub tx_hash: String,
    pub target_entity_id: String,
    pub token_id: u16,
    pub recipient_amount: BigInt,
    pub route: Vec<String>,
    pub description: String,
    pub delivery_mode: OriginatedHtlcDeliveryMode,
    pub started_at_ms: u64,
    pub hashlock: String,
    pub sender_lock_amount: BigInt,
    pub max_sender_debit: BigInt,
    pub total_fee: BigInt,
    pub lock_id: String,
    pub timelock: BigInt,
    pub reveal_before_height: u64,
    pub next_hop_entity_id: String,
    pub envelope: OpaqueHtlcCiphertext,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeterministicContext {
    pub minimum_trade_size: BigInt,
    pub swap_taker_fee_bps: u16,
    pub jurisdiction_id: Option<String>,
    pub pair_policies: BTreeMap<String, PairPolicy>,
    pub prepared_htlcs: BTreeMap<(String, String), PreparedHtlcEntry>,
    pub originated_htlcs: BTreeMap<String, PreparedOriginatedHtlcPayment>,
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
            originated_htlcs: BTreeMap::new(),
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
    pub height: u64,
    pub timestamp: u64,
    /// Bounded latest signed-command slot per current board member. This is
    /// Entity State, not replica admission metadata: retry/cancel semantics
    /// must survive checkpoint restore and remain in the certified root.
    pub entity_command_nonces: Option<crate::EntityCommandNonceState>,
    pub last_finalized_j_height: u64,
    /// Canonical Entity-owned jurisdiction reserves, keyed by token id.
    /// Account collateral is deliberately not duplicated here.
    pub reserves: BTreeMap<u16, BigInt>,
    pub known_accounts: BTreeSet<String>,
    pub htlc_routes: BTreeMap<String, HtlcRoute>,
    pub htlc_fees_earned: BigInt,
    pub lock_book: BTreeMap<String, LockBookEntry>,
    pub crontab: Option<CrontabState>,
    /// Exact committed hub configuration. Keeping the canonical value here
    /// makes restore and live commitment use the same bytes while the Entity
    /// kernel reads only the fields needed for native policy generation.
    pub hub_rebalance_config: Option<CanonicalValue>,
    pub orderbook: Option<OrderbookState>,
    /// Exact Entity-consensus fields that surround the mutable books. They are
    /// installed once with the resident state; matching never rewrites them.
    pub orderbook_metadata: Option<OrderbookConsensusMetadata>,
    /// Exact committed `jHistoryFinality` anchor. Never mutated by the
    /// resident reducer (Rust does not yet own J-event finalization); carried
    /// unchanged across transitions exactly like `hub_rebalance_config`, and
    /// read only to build the local J-prefix base claim/certificate.
    pub j_history_finality: Option<CanonicalValue>,
}

impl EntityStateSlice {
    pub fn empty(entity_id: impl Into<String>, timestamp: u64) -> Self {
        Self {
            entity_id: entity_id.into(),
            height: 0,
            timestamp,
            entity_command_nonces: None,
            last_finalized_j_height: 0,
            reserves: BTreeMap::new(),
            known_accounts: BTreeSet::new(),
            htlc_routes: BTreeMap::new(),
            htlc_fees_earned: BigInt::from(0),
            lock_book: BTreeMap::new(),
            crontab: None,
            hub_rebalance_config: None,
            orderbook: None,
            orderbook_metadata: None,
            j_history_finality: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpreadDistribution {
    pub maker_bps: u32,
    pub taker_bps: u32,
    pub hub_bps: u32,
    pub maker_referrer_bps: u32,
    pub taker_referrer_bps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubProfile {
    pub entity_id: String,
    pub name: String,
    pub spread_distribution: SpreadDistribution,
    pub reference_token_id: u32,
    pub usd_quote_authority_entity_id: String,
    pub min_trade_size: BigInt,
    pub supported_pairs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityReferral {
    pub entity_id: String,
    pub referrer_id: Option<String>,
    pub timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderbookConsensusMetadata {
    pub hub_profile: HubProfile,
    pub referrals: BTreeMap<String, EntityReferral>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountProposalWork {
    pub account_id: String,
    pub txs: Vec<AccountTx>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityKernelOutput {
    /// Exact semantic projection of the TS runtimeEvent + paired REB_STEP
    /// diagnostic emitted when a bilateral J-event claim finalizes.
    AccountSettledFinalizedBilateral {
        entity_id: String,
        account_id: String,
        token_id: u16,
        j_height: u64,
        collateral: BigInt,
        ondelta: BigInt,
    },
    HtlcInitiated {
        entity_id: String,
        from_entity: String,
        to_entity: String,
        token_id: u16,
        amount: BigInt,
        sender_amount: BigInt,
        fee: BigInt,
        hashlock: String,
        lock_id: String,
        route: Vec<String>,
        description: Option<String>,
        started_at_ms: u64,
    },
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
