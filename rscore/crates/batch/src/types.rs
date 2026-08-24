use std::fmt;

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
}

pub struct AccountSeed {
    pub account_id: AccountId,
    pub replica: AccountReplica,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReplicaFingerprint {
    pub owner: EntityId,
    pub owner_side: Side,
    pub payment_profile_root: [u8; 32],
}

// The carried replica shell holds canonical numbers, so the job is comparable
// but not Eq.
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
