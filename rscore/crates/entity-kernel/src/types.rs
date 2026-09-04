use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use num_bigint::BigInt;
use sha2::{Digest as _, Sha256};
use xln_rscore_engine::{AccountDomain, AccountOutput, AccountTx, OpaqueHtlcCiphertext};
use xln_rscore_protocol::{
    CanonicalValue, PersistentRadixMap, encode_canonical_consensus_bytes, encode_raw_text_key,
};

use crate::lending::LendingState;
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
    /// Position of the Entity input that committed this frame. Local effects
    /// it triggers (HTLC forwards, resolves) are first-touched right after it
    /// in TS `storageChanges`, so the Runtime frame publishes them there.
    pub inbound_position: usize,
    pub transitions: Vec<CommittedAccountTransition>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcPreparedBinding {
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub domain: AccountDomain,
    pub account_frame_hash: String,
    pub account_height: u64,
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
pub struct PaybookEntry {
    pub hashlock: String,
    pub description: Option<String>,
    pub token_id: Option<u16>,
    pub amount: Option<BigInt>,
    pub started_at_ms: Option<u64>,
    pub originated: bool,
    pub inbound_entity: Option<String>,
    pub outbound_entity: Option<String>,
    pub inbound_settled: bool,
    pub outbound_settled: bool,
    pub secret: Option<String>,
    pub secret_ack_pending: bool,
    pub secret_ack_started_at: Option<u64>,
    pub secret_ack_deadline_at: Option<u64>,
    pub pending_fee: Option<BigInt>,
    pub created_timestamp: u64,
}

#[derive(Clone)]
pub struct PaybookState {
    pub entries: PersistentRadixMap<PaybookEntry>,
    pub fees_earned: BigInt,
}

impl std::fmt::Debug for PaybookState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PaybookState")
            .field("entries", &self.entries.iter().collect::<Vec<_>>())
            .field("fees_earned", &self.fees_earned)
            .finish()
    }
}

impl PartialEq for PaybookState {
    fn eq(&self, other: &Self) -> bool {
        self.fees_earned == other.fees_earned
            && self.entries.len() == other.entries.len()
            && self.entries.iter().eq(other.entries.iter())
    }
}

impl Eq for PaybookState {}

/// Resident membership mirror for the Account forest.
///
/// The Account forest remains the authority. Entity apply needs cheap textual
/// membership checks before it constructs Account work, so this derived mirror
/// uses the same persistent radix implementation instead of cloning an
/// unbounded `BTreeSet` with every candidate state.
#[derive(Clone)]
pub struct KnownAccounts {
    entries: PersistentRadixMap<String>,
}

impl KnownAccounts {
    pub fn empty() -> Self {
        Self {
            entries: PersistentRadixMap::empty(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, entity_id: &str) -> bool {
        encode_raw_text_key(entity_id)
            .ok()
            .is_some_and(|key| self.entries.get(&key).is_some())
    }

    pub fn insert(&mut self, entity_id: String) -> bool {
        let key = encode_raw_text_key(&entity_id).expect("KNOWN_ACCOUNT_RADIX_KEY_INVALID");
        if self.entries.get(&key).is_some() {
            return false;
        }
        let mut digest = Sha256::new();
        digest.update(b"xln.entity.known-account.v1");
        digest.update(entity_id.as_bytes());
        self.entries = self
            .entries
            .updated(key, entity_id, digest.finalize().into())
            .expect("KNOWN_ACCOUNT_RADIX_UPDATE_FAILED");
        true
    }

    pub fn iter(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(_, entity_id)| entity_id)
    }
}

impl Default for KnownAccounts {
    fn default() -> Self {
        Self::empty()
    }
}

impl From<BTreeSet<String>> for KnownAccounts {
    fn from(entity_ids: BTreeSet<String>) -> Self {
        entity_ids.into_iter().collect()
    }
}

impl FromIterator<String> for KnownAccounts {
    fn from_iter<T: IntoIterator<Item = String>>(entity_ids: T) -> Self {
        let mut accounts = Self::empty();
        for entity_id in entity_ids {
            accounts.insert(entity_id);
        }
        accounts
    }
}

impl Extend<String> for KnownAccounts {
    fn extend<T: IntoIterator<Item = String>>(&mut self, entity_ids: T) {
        for entity_id in entity_ids {
            self.insert(entity_id);
        }
    }
}

impl fmt::Debug for KnownAccounts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_set().entries(self.iter()).finish()
    }
}

impl PartialEq for KnownAccounts {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().eq(other.iter())
    }
}

impl Eq for KnownAccounts {}

/// One canonical Entity-owned unbounded collection.
///
/// Cross-j values stay in their exact consensus projection because the same
/// route shape crosses TypeScript, Rust, checkpoint storage and dispute
/// tooling. The Patricia map is the only resident representation; this type
/// must not grow a parallel index or `BTreeMap` mirror.
#[derive(Clone)]
pub struct EntityCanonicalCollection {
    entries: PersistentRadixMap<CanonicalValue>,
}

const MAX_ENTITY_COLLECTION_LEAF_BYTES: usize = 10_000;

fn contains_nested_collection(value: &CanonicalValue) -> bool {
    match value {
        CanonicalValue::Map(_) | CanonicalValue::Set(_) => true,
        CanonicalValue::Array(values) => values.iter().any(contains_nested_collection),
        CanonicalValue::Object(fields) => fields
            .iter()
            .any(|(_, value)| contains_nested_collection(value)),
        CanonicalValue::Null
        | CanonicalValue::Bool(_)
        | CanonicalValue::Number(_)
        | CanonicalValue::BigInt(_)
        | CanonicalValue::String(_) => false,
    }
}

impl EntityCanonicalCollection {
    pub fn empty() -> Self {
        Self {
            entries: PersistentRadixMap::empty(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn root_hash(&self) -> [u8; 32] {
        self.entries.root_hash()
    }

    pub fn get(&self, key: &str) -> Option<&CanonicalValue> {
        encode_raw_text_key(key)
            .ok()
            .and_then(|key| self.entries.get(&key))
    }

    pub fn insert(
        &mut self,
        key: String,
        value: CanonicalValue,
    ) -> Result<Option<CanonicalValue>, crate::EntityKernelError> {
        if contains_nested_collection(&value) {
            return Err(crate::EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_COLLECTION_LEAF_NESTED_COLLECTION_FORBIDDEN".to_string(),
            });
        }
        let encoded_key = encode_raw_text_key(&key).map_err(|error| {
            crate::EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            }
        })?;
        let prior = self.entries.get(&encoded_key).cloned();
        let encoded_value = encode_canonical_consensus_bytes(&value).map_err(|error| {
            crate::EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            }
        })?;
        if encoded_value.len() > MAX_ENTITY_COLLECTION_LEAF_BYTES {
            return Err(crate::EntityKernelError::CommitmentEncoding {
                detail: format!(
                    "ENTITY_COLLECTION_LEAF_TOO_LARGE:{}:{MAX_ENTITY_COLLECTION_LEAF_BYTES}",
                    encoded_value.len()
                ),
            });
        }
        self.entries = self
            .entries
            .updated(encoded_key, value, Sha256::digest(encoded_value).into())
            .map_err(|error| crate::EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?;
        Ok(prior)
    }

    pub fn remove(
        &mut self,
        key: &str,
    ) -> Result<Option<CanonicalValue>, crate::EntityKernelError> {
        let encoded_key = encode_raw_text_key(key).map_err(|error| {
            crate::EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            }
        })?;
        let prior = self.entries.get(&encoded_key).cloned();
        self.entries = self.entries.removed(&encoded_key).map_err(|error| {
            crate::EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            }
        })?;
        Ok(prior)
    }

    pub fn keyed_values(&self) -> impl Iterator<Item = (&[u8], &CanonicalValue)> {
        self.entries.iter()
    }

    pub fn text_entries(&self) -> Result<Vec<(String, CanonicalValue)>, crate::EntityKernelError> {
        self.entries
            .iter()
            .map(|(encoded, value)| {
                if encoded.len() < 2 {
                    return Err(crate::EntityKernelError::CommitmentEncoding {
                        detail: "ENTITY_COLLECTION_TEXT_KEY_TRUNCATED".into(),
                    });
                }
                let length = usize::from(u16::from_be_bytes([encoded[0], encoded[1]]));
                if encoded.len() != length.saturating_add(2) {
                    return Err(crate::EntityKernelError::CommitmentEncoding {
                        detail: "ENTITY_COLLECTION_TEXT_KEY_LENGTH".into(),
                    });
                }
                let key = std::str::from_utf8(&encoded[2..])
                    .map_err(|_| crate::EntityKernelError::CommitmentEncoding {
                        detail: "ENTITY_COLLECTION_TEXT_KEY_UTF8".into(),
                    })?
                    .to_string();
                Ok((key, value.clone()))
            })
            .collect()
    }

    pub fn from_entries(
        entries: impl IntoIterator<Item = (String, CanonicalValue)>,
    ) -> Result<Self, crate::EntityKernelError> {
        let mut collection = Self::empty();
        for (key, value) in entries {
            if collection.insert(key.clone(), value)?.is_some() {
                return Err(crate::EntityKernelError::CommitmentEncoding {
                    detail: format!("ENTITY_COLLECTION_DUPLICATE:{key}"),
                });
            }
        }
        Ok(collection)
    }
}

impl fmt::Debug for EntityCanonicalCollection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_list()
            .entries(self.entries.iter().map(|(_, value)| value))
            .finish()
    }
}

impl PartialEq for EntityCanonicalCollection {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.entries.iter().eq(other.entries.iter())
    }
}

impl Eq for EntityCanonicalCollection {}

/// Exact TS `EntitySwapPair`. This is configured market state, not a cache of
/// books: a permitted pair exists before its first order and therefore cannot
/// be reconstructed from `orderbookExt.books` after restore.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntitySwapPair {
    pub base_token_id: u32,
    pub quote_token_id: u32,
    pub pair_id: String,
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
    /// Bounded live governance proposals. Executed/rejected proposals are
    /// removed; the certified Runtime WAL is their historical record.
    pub proposals: crate::EntityProposals,
    pub last_finalized_j_height: u64,
    /// Canonical Entity-owned jurisdiction reserves, keyed by token id.
    /// Account collateral is deliberately not duplicated here.
    pub reserves: BTreeMap<u16, BigInt>,
    pub out_debts_by_token: Option<crate::DebtLedger>,
    pub in_debts_by_token: Option<crate::DebtLedger>,
    pub external_wallet: Option<crate::ExternalWalletState>,
    /// One exact approved workspace hash per Account waiting for the bilateral
    /// Account machine to become proposable. The Patricia body is the only
    /// representation; the Entity root commits its leaf count and root.
    pub deferred_account_proposals: Option<EntityCanonicalCollection>,
    /// Entity-owned post-settlement work, keyed by the Account counterparty.
    /// Values retain the exact TS canonical action plan inside the same
    /// Patricia collection used by every other unbounded Entity map.
    pub settlement_continuations: Option<EntityCanonicalCollection>,
    /// One Entity-wide X25519 public key. The matching private key is Runtime
    /// infrastructure; this public half is committed Entity State and is the
    /// only source used by gossip and HTLC admission after genesis/import.
    pub entity_encryption_public_key: [u8; 32],
    /// Canonical public Entity profile. This is committed Entity State; gossip
    /// is only a post-commit projection and must never become a second oracle.
    pub profile: EntityProfile,
    pub j_batch_state: Option<crate::JBatchState>,
    /// Bounded current EntityProvider intent. Runtime submission receipts are
    /// replica-local; only this exact action and confirmed on-chain nonce are
    /// part of Entity consensus.
    pub entity_provider_action_state: Option<crate::EntityProviderActionState>,
    /// Receipt-authenticated board registry used by Entity command, provider
    /// governance and Account dispute verification. Records are one
    /// persistent radix authority; `board_registry_root` is its exact TS
    /// Patricia commitment, not a second lookup table.
    pub certified_board_state: Option<crate::CertifiedBoardState>,
    pub known_accounts: KnownAccounts,
    pub paybook: PaybookState,
    pub crontab: Option<CrontabState>,
    /// Exact committed hub configuration. Keeping the canonical value here
    /// makes restore and live commitment use the same bytes while the Entity
    /// kernel reads only the fields needed for native policy generation.
    pub hub_rebalance_config: Option<CanonicalValue>,
    pub orderbook: Option<OrderbookState>,
    /// Exact Entity-consensus fields that surround the mutable books. They are
    /// installed once with the resident state; matching never rewrites them.
    pub orderbook_metadata: Option<OrderbookConsensusMetadata>,
    pub swap_trading_pairs: Option<Vec<EntitySwapPair>>,
    pub lending: Option<LendingState>,
    pub cross_jurisdiction_swaps: Option<EntityCanonicalCollection>,
    pub cross_jurisdiction_authorizations: Option<EntityCanonicalCollection>,
    pub cross_jurisdiction_book_admissions: Option<EntityCanonicalCollection>,
    /// Exact committed `jHistoryFinality` anchor. Native J-event finalization
    /// mutates it together with `last_finalized_j_height`; both fields must be
    /// projected into the same Entity frame and checkpoint root.
    pub j_history_finality: Option<CanonicalValue>,
}

impl EntityStateSlice {
    pub fn empty(entity_id: impl Into<String>, timestamp: u64) -> Self {
        let entity_id = entity_id.into();
        Self {
            profile: EntityProfile::default_for_entity(&entity_id),
            j_batch_state: None,
            entity_provider_action_state: None,
            certified_board_state: None,
            entity_id,
            height: 0,
            timestamp,
            entity_command_nonces: None,
            proposals: BTreeMap::new(),
            last_finalized_j_height: 0,
            reserves: BTreeMap::new(),
            out_debts_by_token: None,
            in_debts_by_token: None,
            external_wallet: None,
            deferred_account_proposals: None,
            settlement_continuations: None,
            entity_encryption_public_key: [0; 32],
            known_accounts: KnownAccounts::empty(),
            paybook: PaybookState {
                entries: PersistentRadixMap::empty(),
                fees_earned: BigInt::from(0),
            },
            // TS `createEntityReplica` installs `initCrontab()` at genesis.
            // A native Entity must commit the same scheduler state before its
            // first frame; otherwise the first successful forwarded HTLC
            // cannot arm its secret-ACK timeout and fail-stops live H1.
            crontab: Some(CrontabState::default()),
            hub_rebalance_config: None,
            orderbook: None,
            orderbook_metadata: None,
            swap_trading_pairs: None,
            lending: None,
            cross_jurisdiction_swaps: None,
            cross_jurisdiction_authorizations: None,
            cross_jurisdiction_book_admissions: None,
            j_history_finality: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProfile {
    pub name: String,
    pub is_hub: bool,
    pub entity_kind: Option<String>,
    pub sectors: Vec<String>,
    pub avatar: String,
    pub bio: String,
    pub website: String,
}

impl EntityProfile {
    pub fn default_for_entity(entity_id: &str) -> Self {
        let suffix = entity_id
            .get(entity_id.len().saturating_sub(4)..)
            .unwrap_or(entity_id);
        Self {
            name: format!("Entity {suffix}"),
            is_hub: false,
            entity_kind: None,
            sectors: Vec::new(),
            avatar: String::new(),
            bio: String::new(),
            website: String::new(),
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
    Debug {
        payload: CanonicalValue,
    },
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
    /// Exact fresh-request receipt emitted by Account. No receipt exists for
    /// an applied duplicate/no-op request.
    RequestCollateralCommitted {
        entity_id: String,
        account_id: String,
        token_id: u16,
        requested_amount: BigInt,
        prepaid_fee: BigInt,
        requested_at: u64,
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
        description: Option<String>,
    },
    HtlcReceived {
        entity_id: String,
        from_entity: String,
        to_entity: String,
        hashlock: String,
        lock_id: String,
        token_id: Option<u16>,
        amount: Option<BigInt>,
        description: Option<String>,
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
        description: Option<String>,
        started_at_ms: Option<u64>,
        jurisdiction_id: Option<String>,
        finalized_at_ms: u64,
    },
    SwapMatched {
        entity_id: String,
        count: u64,
    },
}

/// Ordered Entity child output for the Jurisdiction machine. Runtime releases
/// it only after the owning Runtime frame is durable; it is not a transport
/// outbox row and does not duplicate the committed JBatch state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityJOutput {
    BatchIntent {
        jurisdiction_name: String,
        batch_hash: [u8; 32],
        entity_nonce: u64,
        batch_generation: u64,
        fee_overrides: Option<crate::j_batch::JBatchFeeOverrides>,
    },
    MintReserves {
        jurisdiction_name: String,
        entity_id: [u8; 32],
        token_id: u64,
        amount: BigInt,
        timestamp: u64,
    },
    EntityProviderActionIntent {
        jurisdiction_name: String,
        intent: crate::EntityProviderActionIntent,
        signer_id: String,
    },
    GovernanceIntent {
        jurisdiction_name: String,
        intent: EntityProviderGovernanceIntent,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlBoardSupporterVote {
    pub entity_id: [u8; 32],
    /// Absent only for the current shareholder Entity: its Hanko is produced
    /// from the enclosing Entity frame's HashToSign manifest.
    pub hanko_signature: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityProviderGovernanceIntent {
    ProposeControlBoard {
        shareholder_entity_id: [u8; 32],
        target_entity_id: [u8; 32],
        new_board_hash: [u8; 32],
        target_board_epoch: u64,
        action_nonce: ethabi::ethereum_types::U256,
        proposal_hash: [u8; 32],
        supporter_votes: Vec<ControlBoardSupporterVote>,
        signer_id: String,
        timestamp: u64,
    },
    ActivateBoard {
        entity_id: [u8; 32],
        target_entity_id: [u8; 32],
        signer_id: String,
        timestamp: u64,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CrontabTaskMethod;

    #[test]
    fn fresh_entity_installs_the_canonical_ts_crontab() {
        let state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 7);
        let crontab = state.crontab.expect("fresh Entity crontab");
        let task = crontab
            .tasks
            .get(&CrontabTaskMethod::HubRebalance)
            .expect("hubRebalance task");
        assert_eq!(task.interval_ms, 1_000);
        assert_eq!(task.last_run, 0);
        assert!(task.enabled);
        assert!(task.params.is_empty());
        assert!(crontab.hooks.is_empty());
    }
}
