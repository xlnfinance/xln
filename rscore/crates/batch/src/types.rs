use std::fmt;

use xln_rscore_engine::AccountReplica;

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
