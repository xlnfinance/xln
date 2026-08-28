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
    pub delta_transformer: [u8; 20],
    /// Kept explicit in the typed boundary so an eventual pinned-account
    /// policy change cannot silently alter H=0 leaves. Inbound peer genesis is
    /// currently never public-pinned and any true value is rejected.
    pub public_pinned: bool,
}

/// Everything one Entity input carries outward.
#[derive(Debug)]
pub struct EntityOutboundRequest {
    pub owner_entity_id: [u8; 32],
    /// The clock this Entity stamps the frames it proposes with.
    pub timestamp: u64,
    pub j_height: u64,
    /// Accounts created at financial genesis by this Entity input.
    pub creates: Vec<AccountSeed>,
    /// Transactions the Entity's own logic produced, per account.
    pub admits: Vec<(AccountId, Vec<AccountTx>)>,
    /// The accounts asked to propose once their transactions are queued.
    pub propose: Vec<AccountId>,
    /// Accounts changed on the inbound visit whose final bodies the parent
    /// needs only after all Entity-derived work has run.
    pub materialize: Vec<AccountId>,
    /// Active forwarded-payment routes whose downstream Account may reject a
    /// lock during this proposal pass. These are Entity-owned routing facts,
    /// supplied before execution so Rust can enqueue the exact upstream
    /// resolve and finish the canonical worklist without a third process call.
    pub failed_htlc_routes: Vec<FailedHtlcRoute>,
    /// Export every Account changed since the previous durable checkpoint.
    /// Export itself is repeatable and non-acknowledging. The next inbound
    /// expected root implicitly advances the worker-local durable baseline
    /// only when it names the latest exported root.
    pub checkpoint_due: bool,
    pub post_accounts: bool,
}

#[derive(Clone, Debug)]
pub struct FailedHtlcRoute {
    pub hashlock: [u8; 32],
    pub outbound_account_id: AccountId,
    pub outbound_lock_id: String,
    pub inbound_account_id: AccountId,
    pub inbound_lock_id: String,
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
