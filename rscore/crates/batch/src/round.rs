//! One Entity input's two visits to the Account layer.
//!
//! An Entity frame touches its accounts exactly twice. On the way in it hands
//! over everything that arrived from peers; the accounts apply it, sharded by
//! account across the pool, and hand back what happened. The Entity then runs
//! its own payment and order-book logic on those events, and on the way out it
//! hands over the transactions that logic produced and names the accounts that
//! should now propose. The second visit returns what to send onward.
//!
//! There is no per-operation call between the two. The inbound visit may return
//! the changed Account bodies because Entity order-book and routing logic read
//! that post-inbound state. The outbound visit returns the final bodies and
//! effects that the parent commits and routes.

use xln_rscore_engine::{AccountDomain, AccountTx, ReceiverClock};
use xln_rscore_protocol::CanonicalValue;

use crate::checkpoint::{AccountCheckpointRows, AccountsCheckpoint};
use crate::consensus::{AccountAdmissionResult, AccountInputResult, AccountInputRow, ProposalRow};
use crate::types::{AccountId, AccountSeed};

/// Everything one Entity input carries inward.
#[derive(Debug)]
pub struct EntityInboundRequest {
    /// The Entity that owns every named account. Checked, never trusted.
    pub owner_entity_id: [u8; 32],
    /// The Account-forest root held by the parent Entity before this attempt.
    /// A prior path-copy candidate is accepted or dropped from this assertion;
    /// there is deliberately no separate Commit/Abort command.
    pub expected_accounts_root: [u8; 32],
    /// The clock this Entity judges arrivals with.
    pub clock: ReceiverClock,
    pub rows: Vec<AccountInputRow>,
    pub post_accounts: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityAccountGenesisPolicy {
    pub expected_domain: AccountDomain,
    pub shadow_policy_root: [u8; 32],
    /// Canonical value-bearing policy rows behind `shadow_policy_root`.
    /// Carrying only the root made a freshly-created Account impossible to
    /// restore without consulting TypeScript state outside the Runtime WAL.
    pub shadow_policy_rows: Vec<(u32, CanonicalValue)>,
    pub delta_transformer: [u8; 20],
    /// Kept explicit in the typed boundary so an eventual pinned-account
    /// policy change cannot silently alter H=0 leaves. Inbound peer genesis is
    /// currently never public-pinned and any true value is rejected.
    pub public_pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountEnvelopeUpdate {
    ClearRebalanceActiveQuote,
    SetRebalancePolicy {
        token_id: u32,
        policy: CanonicalValue,
    },
    /// `submitted_at: None` releases the marker for that token.
    SetRebalanceSubmittedAt {
        token_id: u32,
        submitted_at: Option<u64>,
    },
    ReplaceDisputeLifecycle {
        status: String,
        dispute_prepare: Option<CanonicalValue>,
        active_dispute: Option<CanonicalValue>,
    },
    ApplyDisputeStarted(xln_rscore_engine::AccountDisputeStartedFinality),
    ApplyDisputeFinality(xln_rscore_engine::AccountDisputeFinality),
    ConfirmDisputeBookRemoval {
        order_id: String,
    },
}

/// Everything one Entity input carries outward.
#[derive(Debug)]
pub struct EntityOutboundRequest {
    pub owner_entity_id: [u8; 32],
    /// Current local board authority resolved by the parent Entity registry.
    /// `Unresolved` is rejected; this transient fact is never Account state.
    pub local_certified_board_authority: crate::AccountInputBoardAuthority,
    /// The clock this Entity stamps the frames it proposes with.
    pub timestamp: u64,
    pub j_height: u64,
    /// Accounts created at financial genesis by this Entity input.
    pub creates: Vec<AccountSeed>,
    /// Entity-owned Account envelope mutations applied on the same worker and
    /// in the same candidate as admissions/proposals. They never enter the
    /// bilateral Account frame, but their root is part of the Entity leaf.
    pub envelope_updates: Vec<(AccountId, Vec<AccountEnvelopeUpdate>)>,
    /// Unsigned settlement-Hanko transitions whose hashes are certified by
    /// this Entity frame. They enter the Account candidate in the same final
    /// Account stage, but cannot be proposed until certification attaches the
    /// manifest witnesses. The witness bytes are excluded from the canonical
    /// AccountTx projection, so that later attachment must not move the leaf.
    pub unsigned_settlement_txs: Vec<(AccountId, AccountTx)>,
    /// One canonical final Account-stage worklist. Each Account appears once;
    /// Entity supplies only its Account transactions. The resident worker
    /// derives ACK/proposal behavior from the Account state it exclusively
    /// owns and seals the final leaf after that work.
    pub proposal_work: Vec<(AccountId, Vec<AccountTx>, bool)>,
    /// Export every Account changed since the previous durable checkpoint.
    /// Export itself is repeatable and non-acknowledging. The next inbound
    /// expected root implicitly advances the worker-local durable baseline
    /// only when it names the latest exported root.
    pub checkpoint_due: bool,
    pub post_accounts: bool,
}

/// One exact same-round rollback generated only after an actual downstream
/// HTLC lock was removed. The parent Entity resolves `hashlock` by a point
/// lookup in Paybook; no Account worker scans or stores Entity routing state.
#[derive(Clone, Debug)]
pub struct FailedHtlcFollowup {
    pub failed_account_id: AccountId,
    pub hashlock: [u8; 32],
    pub upstream_account_id: AccountId,
    pub tx: AccountTx,
    pub reason: String,
}

/// What one visit changed.
#[derive(Default)]
pub struct EntityRoundResult {
    pub revision: u64,
    pub accounts_root: [u8; 32],
    pub applied: Vec<AccountInputResult>,
    pub admissions: Vec<AccountAdmissionResult>,
    pub proposals: Vec<ProposalRow>,
    /// Every named account whose leaf moved, with the leaf it now commits.
    pub touched: Vec<(AccountId, [u8; 32])>,
    /// Node changes for the touched accounts, when the caller asked for them.
    pub post_accounts: Vec<AccountCheckpointRows>,
    /// Exact worker-resident changes since the previous exported checkpoint.
    /// `None` means no checkpoint was requested; `Some` is a complete manifest
    /// even when no Account row moved, because its tokens still bind the exact
    /// revision, root, signer configuration and Account count.
    pub checkpoint: Option<AccountsCheckpoint>,
    /// Exact state immediately after an authenticated first H=1 commit for an
    /// Account that was absent at the start of this inbound visit. This is
    /// separate from `post_accounts`: later rows for the same Account may move
    /// its final leaf again before the Entity finishes processing the input.
    pub created_accounts: Vec<AccountCheckpointRows>,
}
