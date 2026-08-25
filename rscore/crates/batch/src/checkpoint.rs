//! The canonical database checkpoint: what moved in the accounts since the
//! runtime last made a checkpoint durable.
//!
//! Parity target: `projectAccountTreeChanges`
//! (core/storage/schema/account-graph-codec.ts) plus the replica fields
//! core/storage/schema/account-field-tags.ts persists beside the trees. The
//! runtime asks for this every hundred or so frames, writes it, and only then
//! acknowledges the revision — so a crash between the two costs a replay from
//! the previous checkpoint, never a hole in the database.

use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountEnvelope, AccountIdentity, AccountReplica,
    BilateralRebalanceFeePolicy, CarriedSections, ConsensusSnapshot, Delta, EntityId, HtlcLock,
    LendingIntentKind, StateError, SwapOffer,
};
use xln_rscore_protocol::PersistentNodeChanges;

use crate::AccountId;

/// The scalar fields of one account, rewritten whole whenever the account
/// moves. They are a few hundred bytes; the trees beside them are the part
/// worth shipping incrementally.
#[derive(Clone)]
pub struct AccountCheckpointHeader {
    pub owner: EntityId,
    /// The signer id this owner's key was derived from. Without it a restore
    /// would have to guess, and a wrong guess signs frames the counterparty
    /// cannot verify.
    pub signer_id: String,
    pub identity: AccountIdentity,
    pub dispute_config: AccountDisputeConfig,
    pub j_nonce: u64,
    pub last_finalized_j_height: u64,
    pub carried: CarriedSections,
    pub envelope: AccountEnvelope,
    /// Jurisdiction proof code address. It is outside AccountState but a
    /// restored authority needs it before it can build the next dispute.
    pub delta_transformer: Option<[u8; 20]>,
}

/// One account's rows: the header, every state tree's node changes, and the
/// consensus state around them.
#[derive(Clone)]
pub struct AccountCheckpointRows {
    pub account_id: AccountId,
    /// The leaf this account occupies in the accounts tree, so a restore can
    /// be checked account by account rather than only at the root.
    pub account_leaf: [u8; 32],
    pub header: AccountCheckpointHeader,
    /// Roots/counts for the five Rust-owned canonical Account namespaces.
    /// Node changes alone cannot update the TS graph manifest without
    /// rebuilding each tree, which would erase the point of an incremental
    /// checkpoint.
    pub sections: AccountCheckpointSections,
    pub deltas: PersistentNodeChanges<Delta>,
    pub locks: PersistentNodeChanges<HtlcLock>,
    pub lending_intents: PersistentNodeChanges<LendingIntentKind>,
    pub swap_offers: PersistentNodeChanges<SwapOffer>,
    pub rebalance_fee_policies: PersistentNodeChanges<BilateralRebalanceFeePolicy>,
    pub consensus: ConsensusSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheckpointTreeDescriptor {
    pub root: [u8; 32],
    pub leaf_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountCheckpointSections {
    pub deltas: CheckpointTreeDescriptor,
    pub locks: CheckpointTreeDescriptor,
    pub lending_intents: CheckpointTreeDescriptor,
    pub swap_offers: CheckpointTreeDescriptor,
    pub rebalance_fee_policies: CheckpointTreeDescriptor,
}

impl AccountCheckpointRows {
    pub fn put_count(&self) -> usize {
        self.deltas.puts.len()
            + self.locks.puts.len()
            + self.lending_intents.puts.len()
            + self.swap_offers.puts.len()
            + self.rebalance_fee_policies.puts.len()
    }

    pub fn del_count(&self) -> usize {
        self.deltas.dels.len()
            + self.locks.dels.len()
            + self.lending_intents.dels.len()
            + self.swap_offers.dels.len()
            + self.rebalance_fee_policies.dels.len()
    }
}

/// The token that names one checkpoint exactly.
///
/// A revision alone does not: two engines at the same revision can hold
/// different accounts, and the accounts root does not cover which signer each
/// account is signed by. The runtime hands this back when the write is
/// durable, and the engine refuses to acknowledge anything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheckpointToken {
    pub base_revision: u64,
    pub revision: u64,
    pub accounts_root: [u8; 32],
    /// Digest over every account's `(id, owner, signerId)`. The accounts root
    /// commits the state; this commits who signs for it, which is not in the
    /// state and would otherwise be swappable in the database.
    pub signer_digest: [u8; 32],
    pub account_count: usize,
}

impl CheckpointToken {
    /// The token persisted beside checkpoint rows and handed to
    /// `RestoreExact` after a process restart. The old base revision only
    /// matters while acknowledging the incremental write to the live engine;
    /// once those rows are durable, that revision is its own restore base.
    pub const fn restore_token(self) -> Self {
        Self {
            base_revision: self.revision,
            revision: self.revision,
            accounts_root: self.accounts_root,
            signer_digest: self.signer_digest,
            account_count: self.account_count,
        }
    }
}

/// One checkpoint: everything that moved between two revisions.
#[derive(Clone)]
pub struct AccountsCheckpoint {
    /// What this checkpoint is, in full. `commit_checkpoint` takes this token
    /// back and accepts nothing else.
    pub token: CheckpointToken,
    pub accounts: Vec<AccountCheckpointRows>,
    /// Accounts the database must drop: gone from the tree since the base.
    pub removed: Vec<AccountId>,
}

impl AccountsCheckpoint {
    pub const fn base_revision(&self) -> u64 {
        self.token.base_revision
    }

    pub const fn revision(&self) -> u64 {
        self.token.revision
    }

    pub const fn accounts_root(&self) -> [u8; 32] {
        self.token.accounts_root
    }

    /// Exact token stored with the materialized rows. This is intentionally
    /// distinct from `token`, which still names the previous durable base and
    /// is the only token `commit_checkpoint` will acknowledge.
    pub const fn restore_token(&self) -> CheckpointToken {
        self.token.restore_token()
    }
}

impl AccountsCheckpoint {
    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty() && self.removed.is_empty()
    }

    pub fn put_count(&self) -> usize {
        self.accounts
            .iter()
            .map(AccountCheckpointRows::put_count)
            .sum()
    }

    pub fn del_count(&self) -> usize {
        self.accounts
            .iter()
            .map(AccountCheckpointRows::del_count)
            .sum()
    }
}

impl std::fmt::Debug for AccountsCheckpoint {
    /// Summary only: the rows are the payload, not something to print.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountsCheckpoint")
            .field("baseRevision", &self.token.base_revision)
            .field("revision", &self.token.revision)
            .field("accounts", &self.accounts.len())
            .field("removed", &self.removed.len())
            .field("puts", &self.put_count())
            .field("dels", &self.del_count())
            .finish()
    }
}

/// What a restore hands back for one account: the committed replica the
/// database holds, and the consensus state that was saved with it.
pub struct AccountRestore {
    pub account_id: AccountId,
    pub replica: AccountReplica,
    pub consensus: ConsensusSnapshot,
    pub signer_id: String,
    /// The leaf this account had when the checkpoint was written. The restore
    /// checks it: a row that rebuilds into a different leaf is a corrupt or
    /// truncated database, not an account.
    pub account_leaf: [u8; 32],
}

/// What the whole restore must reproduce: the token of the checkpoint the
/// database holds. Without it a restore cannot tell a complete load from a
/// partial one, because any subset of accounts rebuilds into a valid tree —
/// and cannot tell a swapped signer from the right one, because the accounts
/// root does not commit to signers at all.
pub type CheckpointExpectation = CheckpointToken;

/// Digest over who signs for what: `(accountId, owner, signerId)` for every
/// account, in account order.
pub fn signer_digest<'a>(rows: impl Iterator<Item = (AccountId, [u8; 32], &'a str)>) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<(AccountId, [u8; 32], String)> = rows
        .map(|(account_id, owner, signer_id)| (account_id, owner, signer_id.to_string()))
        .collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    digest.update(b"xln.rscore.signer-config.v1");
    for (account_id, owner, signer_id) in entries {
        digest.update(account_id.as_bytes());
        digest.update(owner);
        digest.update(
            u32::try_from(signer_id.len())
                .unwrap_or(u32::MAX)
                .to_be_bytes(),
        );
        digest.update(signer_id.as_bytes());
    }
    digest.finalize().into()
}

/// The rows for one account, diffed against the checkpoint's own copy of it.
/// Without a prior copy — a new account — every node is a change.
pub(crate) fn account_rows(
    account_id: AccountId,
    account: &AccountConsensus,
    previous: Option<&AccountConsensus>,
    account_leaf: [u8; 32],
    signer_id: &str,
) -> Result<AccountCheckpointRows, StateError> {
    let state = account.replica().state();
    let (deltas, locks, lending_intents, swap_offers, rebalance_fee_policies) = match previous {
        Some(previous) => {
            let prior = previous.replica().state();
            (
                state.delta_node_changes_since(prior),
                state.htlc_node_changes_since(prior),
                state.lending_node_changes_since(prior),
                state.swap_offer_node_changes_since(prior),
                state.rebalance_policy_node_changes_since(prior),
            )
        }
        None => (
            full(state.delta_node_records()),
            full(state.htlc_node_records()),
            full(state.lending_node_records()),
            full(state.swap_offer_node_records()),
            full(state.rebalance_policy_node_records()),
        ),
    };
    Ok(AccountCheckpointRows {
        account_id,
        account_leaf,
        header: AccountCheckpointHeader {
            owner: account.replica().owner().clone(),
            signer_id: signer_id.to_string(),
            identity: state.identity().clone(),
            dispute_config: state.dispute_config(),
            j_nonce: state.j_nonce(),
            last_finalized_j_height: state.last_finalized_j_height(),
            carried: state.carried().clone(),
            envelope: account.checkpoint_envelope()?,
            delta_transformer: account.replica().delta_transformer().copied(),
        },
        sections: AccountCheckpointSections {
            deltas: CheckpointTreeDescriptor {
                root: state.deltas_root(),
                leaf_count: state.delta_count(),
            },
            locks: CheckpointTreeDescriptor {
                root: state.htlc_locks_root(),
                leaf_count: state.htlc_count(),
            },
            lending_intents: CheckpointTreeDescriptor {
                root: state.lending_intents_root().unwrap_or([0; 32]),
                leaf_count: state.lending_intent_count(),
            },
            swap_offers: CheckpointTreeDescriptor {
                root: state.swap_offers_root(),
                leaf_count: state.swap_offer_count(),
            },
            rebalance_fee_policies: CheckpointTreeDescriptor {
                root: state.rebalance_fee_policies_root(),
                leaf_count: state.rebalance_fee_policy_count(),
            },
        },
        deltas,
        locks,
        lending_intents,
        swap_offers,
        rebalance_fee_policies,
        consensus: account.consensus_snapshot(),
    })
}

fn full<V>(records: Vec<xln_rscore_protocol::PersistentNodeRecord<V>>) -> PersistentNodeChanges<V> {
    PersistentNodeChanges {
        puts: records,
        dels: Vec::new(),
    }
}
