use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;
use xln_rscore_engine::EntityId;
use xln_rscore_entity_kernel::FinalizedJEventBatch;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const ACCOUNT_SETTLED_TOPIC: [u8; 32] = [
    0x78, 0x45, 0x75, 0x54, 0x51, 0x24, 0xee, 0xf2, 0x7f, 0x8f, 0xcc, 0x14, 0x72, 0xfb, 0x5f, 0x24,
    0x83, 0xbe, 0xb9, 0xcc, 0x23, 0xe6, 0xfe, 0x3d, 0xbf, 0x58, 0x8e, 0xb7, 0xbd, 0x50, 0x1f, 0x7c,
];

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WatchedExternalWallet {
    pub entity_id: EntityId,
    pub owner: [u8; 20],
    pub watch_after_block: u64,
    /// Token address -> (canonical token id, snapshot height).
    pub balances: BTreeMap<[u8; 20], (u64, u64)>,
    /// (token address, spender) -> snapshot height.
    pub allowances: BTreeMap<([u8; 20], [u8; 20]), u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WatchedHashLadder {
    pub writer: EntityId,
    pub counterparty: EntityId,
    pub ladder_hash: [u8; 32],
    pub target_role: bool,
}

pub trait JsonRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JWatcherConfig {
    pub chain_id: u64,
    pub depository_address: [u8; 20],
    pub entity_provider_address: [u8; 20],
    pub entity_id: EntityId,
    /// Complete ERC20 registry snapshot for this poll. Advancing with a stale
    /// registry would permanently omit newly registered token logs.
    pub erc20_tokens: BTreeMap<[u8; 20], u64>,
    pub external_wallets: Vec<WatchedExternalWallet>,
    /// Reverse-role hash-ladder evidence is relevant only when the committed
    /// Entity route names the exact writer/counterparty/ladder/role tuple.
    pub hash_ladders: BTreeSet<WatchedHashLadder>,
    pub confirmation_depth: u64,
    pub max_blocks_per_poll: u64,
}

impl JWatcherConfig {
    pub(crate) fn validate(&self) -> Result<(), JWatcherError> {
        if self.chain_id == 0 || self.chain_id > MAX_SAFE_INTEGER {
            return Err(JWatcherError::ChainId(self.chain_id));
        }
        if self.max_blocks_per_poll == 0 {
            return Err(JWatcherError::RangeLimit);
        }
        if self.depository_address == self.entity_provider_address
            || self.erc20_tokens.contains_key(&self.depository_address)
            || self
                .erc20_tokens
                .contains_key(&self.entity_provider_address)
        {
            return Err(JWatcherError::CarrierAddressCollision);
        }
        if self
            .erc20_tokens
            .values()
            .any(|token_id| *token_id > MAX_SAFE_INTEGER)
        {
            return Err(JWatcherError::WalletTokenRegistryMismatch);
        }
        for wallet in &self.external_wallets {
            if wallet.entity_id != self.entity_id {
                return Err(JWatcherError::WalletEntityMismatch);
            }
            if wallet.watch_after_block > MAX_SAFE_INTEGER
                || wallet
                    .balances
                    .values()
                    .any(|(_, height)| *height > MAX_SAFE_INTEGER)
                || wallet
                    .allowances
                    .values()
                    .any(|height| *height > MAX_SAFE_INTEGER)
            {
                return Err(JWatcherError::WalletCursor);
            }
            if wallet
                .balances
                .iter()
                .any(|(address, (token_id, _))| self.erc20_tokens.get(address) != Some(token_id))
                || wallet
                    .allowances
                    .keys()
                    .any(|(address, _)| !self.erc20_tokens.contains_key(address))
            {
                return Err(JWatcherError::WalletTokenRegistryMismatch);
            }
        }
        let mut wallet_owners = BTreeSet::new();
        if self
            .external_wallets
            .iter()
            .any(|wallet| !wallet_owners.insert(wallet.owner))
        {
            return Err(JWatcherError::DuplicateWalletOwner);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FinalizedWatcherCursor {
    pub scanned_through: u64,
    pub block_hash: Option<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedJHeader {
    pub j_height: u64,
    pub j_block_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JWatcherPoll {
    pub cursor: FinalizedWatcherCursor,
    /// Every authenticated header in the advanced range, including empty
    /// event blocks. These bytes make the reorg anchor replayable from the
    /// accepted Runtime WAL input instead of a storage sidecar.
    pub headers: Vec<FinalizedJHeader>,
    pub batches: Vec<FinalizedJEventBatch>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcBlock {
    pub number: Value,
    pub hash: String,
    pub parent_hash: String,
    pub receipts_root: String,
    pub transactions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcLog {
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
    pub block_number: Value,
    pub block_hash: String,
    pub transaction_hash: String,
    pub transaction_index: Value,
    pub log_index: Option<Value>,
    pub index: Option<Value>,
    pub removed: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcReceipt {
    pub transaction_hash: String,
    pub transaction_index: Value,
    pub block_number: Value,
    pub block_hash: String,
    #[serde(rename = "type")]
    pub receipt_type: Option<Value>,
    pub status: Option<Value>,
    pub root: Option<String>,
    pub cumulative_gas_used: Value,
    pub logs_bloom: String,
    pub logs: Vec<RpcLog>,
    pub deposit_nonce: Option<Value>,
    pub deposit_receipt_version: Option<Value>,
}

#[derive(Debug, Error)]
pub enum JWatcherError {
    #[error("J_WATCHER_OBSERVATION:{0}")]
    Observation(String),
    #[error("J_WATCHER_RPC:{0}")]
    Rpc(String),
    #[error("J_WATCHER_RPC_RESPONSE:{0}")]
    RpcResponse(String),
    #[error("J_WATCHER_CHAIN_ID_INVALID:{0}")]
    ChainId(u64),
    #[error("J_WATCHER_CHAIN_ID_MISMATCH:expected={expected}:actual={actual}")]
    ChainIdMismatch { expected: u64, actual: u64 },
    #[error("J_WATCHER_RANGE_LIMIT_INVALID")]
    RangeLimit,
    #[error("J_WATCHER_CARRIER_ADDRESS_COLLISION")]
    CarrierAddressCollision,
    #[error("J_WATCHER_WALLET_CURSOR_INVALID")]
    WalletCursor,
    #[error("J_WATCHER_WALLET_ENTITY_MISMATCH")]
    WalletEntityMismatch,
    #[error("J_WATCHER_WALLET_TOKEN_REGISTRY_MISMATCH")]
    WalletTokenRegistryMismatch,
    #[error("J_WATCHER_WALLET_OWNER_DUPLICATE")]
    DuplicateWalletOwner,
    #[error("J_WATCHER_SAFE_HEAD_UNDERFLOW")]
    SafeHeadUnderflow,
    #[error("J_WATCHER_QUANTITY_INVALID:{0}")]
    Quantity(&'static str),
    #[error("J_WATCHER_SAFE_INTEGER_INVALID:{0}")]
    SafeInteger(&'static str),
    #[error("J_WATCHER_HEX_INVALID:{0}")]
    Hex(&'static str),
    #[error("J_WATCHER_BLOCK_MISSING:{0}")]
    BlockMissing(u64),
    #[error("J_WATCHER_RECEIPT_MISSING:{0}")]
    ReceiptMissing(String),
    #[error("J_WATCHER_BLOCK_NUMBER_MISMATCH:{expected}:{actual}")]
    BlockNumber { expected: u64, actual: u64 },
    #[error("J_WATCHER_RANGE_PARENT_MISMATCH:{0}")]
    ParentMismatch(u64),
    #[error("J_WATCHER_FINALIZED_REORG:{0}")]
    FinalizedReorg(u64),
    #[error("J_WATCHER_RANGE_CHANGED:{0}")]
    RangeChanged(u64),
    #[error("J_WATCHER_RECEIPT_COUNT:{expected}:{actual}")]
    ReceiptCount { expected: usize, actual: usize },
    #[error("J_WATCHER_RECEIPT_INDEX:{expected}:{actual}")]
    ReceiptIndex { expected: usize, actual: u64 },
    #[error("J_WATCHER_RECEIPT_COORDINATES:{0}")]
    ReceiptCoordinates(String),
    #[error("J_WATCHER_RECEIPT_TYPE:{0}")]
    ReceiptType(String),
    #[error("J_WATCHER_RECEIPT_OUTCOME")]
    ReceiptOutcome,
    #[error("J_WATCHER_RECEIPT_ROOT_MISMATCH")]
    ReceiptRootMismatch,
    #[error("J_WATCHER_LOG_REMOVED")]
    RemovedLog,
    #[error("J_WATCHER_LOG_COORDINATES:{0}")]
    LogCoordinates(String),
    #[error("J_WATCHER_ACCOUNT_SETTLED_ABI:{0}")]
    AccountSettledAbi(&'static str),
    #[error("J_WATCHER_EVENT_ABI:{0}")]
    EventAbi(&'static str),
    #[error("J_WATCHER_DISPUTE_CALLDATA_REQUIRED")]
    DisputeCalldataRequired,
    #[error("J_WATCHER_DISPUTE_CALLDATA:{0}")]
    DisputeCalldata(String),
    #[error("J_WATCHER_DISPUTE_EVIDENCE_MISMATCH:{0}")]
    DisputeEvidence(&'static str),
    #[error("J_WATCHER_TRANSACTION_MISSING")]
    TransactionMissing,
    #[error("J_WATCHER_TRANSACTION_FIELD:{0}")]
    TransactionField(&'static str),
    #[error("J_WATCHER_TRANSACTION_TYPE:{0}")]
    TransactionType(u64),
    #[error("J_WATCHER_TRANSACTION_HASH_MISMATCH")]
    TransactionHashMismatch,
    #[error("J_WATCHER_ACCOUNT_SETTLED_NONCE:{0}")]
    AccountSettledNonce(String),
    #[error("J_WATCHER_ACCOUNT_SETTLED_TOKEN:{0}")]
    AccountSettledToken(String),
    #[error("J_WATCHER_ACCOUNT_SETTLED_DUPLICATE")]
    DuplicateEvent,
    #[error("J_WATCHER_CURSOR_INVALID")]
    Cursor,
    #[error("J_WATCHER_ACCOUNT:{0}")]
    Account(String),
}
