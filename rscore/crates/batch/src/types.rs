use std::fmt;

use sha2::{Digest, Sha256};
use xln_rscore_engine::{
    AccountExecutionContext, AccountOutput, AccountRejection, AccountReplica, AccountTx, EntityId,
    Side,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AccountId([u8; 32]);

impl AccountId {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Rebuild the id from a tree key, which is the account id itself.
    pub fn from_key(key: &[u8]) -> Self {
        let mut bytes = [0_u8; 32];
        let width = key.len().min(32);
        bytes[..width].copy_from_slice(&key[..width]);
        Self(bytes)
    }
}

impl fmt::Display for AccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineGeneration([u8; 8]);

impl EngineGeneration {
    pub const fn from_bytes(bytes: [u8; 8]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 8] {
        &self.0
    }
}

/// The identity of one abortable batch attempt inside an engine instance.
///
/// Revisions and roots describe state, not an attempt: aborting and preparing
/// the same inputs again deliberately reproduces both.  The monotonic attempt
/// makes those candidates distinct, while the process layer adds its fresh
/// incarnation and session binding before exposing an opaque capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CandidateId([u8; 32]);

impl CandidateId {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub(crate) fn derive(
        engine_generation: EngineGeneration,
        attempt: u64,
        base_revision: u64,
        base_accounts_root: [u8; 32],
    ) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"xln.rscore.batch-candidate.v1\0");
        digest.update(engine_generation.as_bytes());
        digest.update(attempt.to_be_bytes());
        digest.update(base_revision.to_be_bytes());
        digest.update(base_accounts_root);
        Self(digest.finalize().into())
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for CandidateId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct AccountSeed {
    pub account_id: AccountId,
    pub replica: AccountReplica,
    /// Where consensus stands for this account, when the seed carries it. A
    /// mirror seed does not: it is handed each frame and never proposes one.
    pub consensus: Option<xln_rscore_engine::ConsensusSnapshot>,
}

impl fmt::Debug for AccountSeed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AccountSeed")
            .field("account_id", &self.account_id)
            .field("owner", self.replica.owner())
            .field("has_consensus", &self.consensus.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReplicaFingerprint {
    pub owner: EntityId,
    pub owner_side: Side,
    pub payment_profile_root: [u8; 32],
}

// The carried replica shell holds canonical numbers, so the job is comparable
// but not Eq.
/// The proof that an account input came from the counterparty it claims.
///
/// One secp256k1 recovery over the frame digest, compared against the signer
/// the authority expects — the same check TypeScript performs before it admits
/// an input (`verifyAccountSignature`). Absent only for locally originated
/// work, which no peer signed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountInputAuthority {
    pub digest: [u8; 32],
    /// `r || s || v`, with `v` already normalized to 0/1.
    pub signature: [u8; 65],
    pub expected_signer: [u8; 20],
}

#[derive(Clone, Debug, PartialEq)]
pub struct BatchJob {
    pub input_index: u32,
    pub account_id: AccountId,
    pub proposer: Side,
    pub context: AccountExecutionContext,
    pub tx: AccountTx,
    /// The authority's post-frame replica shell, handed over with the last
    /// transition of the frame that produced it. Present until the engine
    /// derives the shell itself; `None` on every other job of the frame.
    pub envelope: Option<xln_rscore_engine::AccountEnvelope>,
    /// Signature to verify before this job's transaction is applied.
    pub authority: Option<AccountInputAuthority>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BatchVerdict {
    Applied,
    Rejected(AccountRejection),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedResult {
    pub input_index: u32,
    pub account_id: AccountId,
    pub verdict: BatchVerdict,
    pub events: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedOutput {
    pub input_index: u32,
    pub output_index: u32,
    pub account_id: AccountId,
    pub output: AccountOutput,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchResponse {
    pub committed_revision: u64,
    /// Accounts-level Patricia root after this commit (radix 16, leaf =
    /// per-account payment-profile state root).
    pub accounts_root: [u8; 32],
    pub results: Vec<IndexedResult>,
    pub outputs: Vec<IndexedOutput>,
}

pub struct PreparedBatch {
    pub(crate) candidate_id: CandidateId,
    pub(crate) engine_generation: EngineGeneration,
    pub(crate) base_revision: u64,
    pub(crate) next_revision: u64,
    pub(crate) updates: Vec<(AccountId, ReplicaFingerprint, AccountReplica)>,
    pub(crate) results: Vec<IndexedResult>,
    pub(crate) outputs: Vec<IndexedOutput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedPaymentProfileRoot {
    pub account_id: AccountId,
    pub payment_profile_root: [u8; 32],
}

impl PreparedBatch {
    pub const fn candidate_id(&self) -> CandidateId {
        self.candidate_id
    }

    pub const fn base_revision(&self) -> u64 {
        self.base_revision
    }

    pub const fn next_revision(&self) -> u64 {
        self.next_revision
    }

    pub fn results(&self) -> &[IndexedResult] {
        &self.results
    }

    pub fn outputs(&self) -> &[IndexedOutput] {
        &self.outputs
    }

    pub fn payment_profile_roots(
        &self,
    ) -> Result<Vec<PreparedPaymentProfileRoot>, xln_rscore_engine::StateError> {
        self.updates
            .iter()
            .map(|(account_id, _, replica)| {
                Ok(PreparedPaymentProfileRoot {
                    account_id: *account_id,
                    payment_profile_root: replica.state().payment_profile_account_state_root()?,
                })
            })
            .collect()
    }
}
