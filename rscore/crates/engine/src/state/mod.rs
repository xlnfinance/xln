//! Mirrors `core/account/state`.

pub(crate) mod account_replica_shell;
pub(crate) mod delta;
/// No TypeScript twin file: the account's parties, chain and depository live
/// in `core/types/account.ts`, and this module keeps them validated.
pub(crate) mod identity;

use std::collections::BTreeSet;

use sha2::{Digest, Sha256};
use xln_rscore_protocol::{
    CanonicalValue, PersistentNodeChanges, PersistentNodeRecord, PersistentRadixMap,
    encode_account_state_value, encode_raw_text_key,
};

use crate::state::delta::MAX_ACCOUNT_TOKEN_ROWS;
use crate::swap::SwapOffer;
use crate::tx::handlers::rebalance::BilateralRebalanceFeePolicy;
use crate::{AccountIdentity, Delta, EntityId, HtlcLock, Side, StateError, TokenId};

const MAX_ACCOUNT_DISPUTE_SECONDS: u64 = 365 * 24 * 60 * 60;
const MAX_ACCOUNT_HTLC_LOCKS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountDisputeConfig {
    left_response_seconds: u32,
    right_response_seconds: u32,
}

impl AccountDisputeConfig {
    pub fn new(
        left_response_seconds: u64,
        right_response_seconds: u64,
    ) -> Result<Self, StateError> {
        let left_response_seconds = response_seconds("LEFT", left_response_seconds)?;
        let right_response_seconds = response_seconds("RIGHT", right_response_seconds)?;
        let total = u64::from(left_response_seconds) + u64::from(right_response_seconds);
        if total > MAX_ACCOUNT_DISPUTE_SECONDS {
            return Err(StateError::DisputeResponseTotalExceeded(total));
        }
        Ok(Self {
            left_response_seconds,
            right_response_seconds,
        })
    }

    pub const fn left_response_seconds(self) -> u32 {
        self.left_response_seconds
    }

    pub const fn right_response_seconds(self) -> u32 {
        self.right_response_seconds
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LendingIntentKind {
    Fund,
    Borrow,
    Repay,
    CreditGrant,
    CreditRevoke,
    CloseRequest,
    ClosePayout,
}

impl LendingIntentKind {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Fund => "fund",
            Self::Borrow => "borrow",
            Self::Repay => "repay",
            Self::CreditGrant => "credit-grant",
            Self::CreditRevoke => "credit-revoke",
            Self::CloseRequest => "close-request",
            Self::ClosePayout => "close-payout",
        }
    }
}

#[derive(Clone)]
pub struct AccountState {
    identity: AccountIdentity,
    dispute_config: AccountDisputeConfig,
    deltas: PersistentRadixMap<Delta>,
    locks: PersistentRadixMap<HtlcLock>,
    lending_intents: Option<PersistentRadixMap<LendingIntentKind>>,
    /// Per-token bilateral fee registers. Owned and interpreted here, unlike
    /// the carried sections below.
    rebalance_fee_policies: PersistentRadixMap<BilateralRebalanceFeePolicy>,
    /// Resting same-jurisdiction offers, keyed by offer id.
    swap_offers: PersistentRadixMap<SwapOffer>,
    j_nonce: u64,
    last_finalized_j_height: u64,
    /// Sections no supported transaction mutates; committed verbatim so a
    /// live account with swap/pull/rebalance/J-claim state still reproduces
    /// its exact TypeScript state root.
    carried: crate::commitment::CarriedSections,
    /// Derived, never compared: the per-section memo for this account's state
    /// root. A payment moves one section; the other four are byte-identical to
    /// the previous commit and are reused instead of being rebuilt, encoded
    /// and hashed again.
    root_cache: crate::commitment::AccountRootCache,
}

/// Everything a checkpoint carries for one account, in the same shape the
/// process seed decodes it from the wire.
pub struct AccountStateSeed {
    pub identity: AccountIdentity,
    pub dispute_config: AccountDisputeConfig,
    pub deltas: Vec<Delta>,
    pub locks: Vec<HtlcLock>,
    pub j_nonce: u64,
    pub last_finalized_j_height: u64,
    pub carried: crate::commitment::CarriedSections,
    pub rebalance_fee_policies: Vec<(TokenId, BilateralRebalanceFeePolicy)>,
    pub swap_offers: Vec<SwapOffer>,
    /// Open lending intents, keyed the way the handlers key them. Empty for a
    /// fresh account; a checkpoint restore hands back exactly what it saved.
    pub lending_intents: Vec<(String, LendingIntentKind)>,
}

impl AccountState {
    pub fn new(
        identity: AccountIdentity,
        dispute_config: AccountDisputeConfig,
        deltas: Vec<Delta>,
    ) -> Result<Self, StateError> {
        Self::restore(identity, dispute_config, deltas, Vec::new())
    }

    pub fn restore(
        identity: AccountIdentity,
        dispute_config: AccountDisputeConfig,
        deltas: Vec<Delta>,
        locks: Vec<HtlcLock>,
    ) -> Result<Self, StateError> {
        Self::restore_with_journal(identity, dispute_config, deltas, locks, 0, 0)
    }

    /// Restore with the bilateral J journal counters. The payment profile
    /// commits them verbatim; snapshots taken after J events (faucet
    /// reserve-to-collateral, settlements) restore root-identically.
    pub fn restore_with_journal(
        identity: AccountIdentity,
        dispute_config: AccountDisputeConfig,
        deltas: Vec<Delta>,
        locks: Vec<HtlcLock>,
        j_nonce: u64,
        last_finalized_j_height: u64,
    ) -> Result<Self, StateError> {
        Self::restore_full(AccountStateSeed {
            identity,
            dispute_config,
            deltas,
            locks,
            j_nonce,
            last_finalized_j_height,
            carried: crate::commitment::CarriedSections::default(),
            rebalance_fee_policies: Vec::new(),
            swap_offers: Vec::new(),
            lending_intents: Vec::new(),
        })
    }

    pub fn restore_full(seed: AccountStateSeed) -> Result<Self, StateError> {
        let AccountStateSeed {
            identity,
            dispute_config,
            deltas,
            locks,
            j_nonce,
            last_finalized_j_height,
            carried,
            rebalance_fee_policies,
            swap_offers,
            lending_intents,
        } = seed;
        if deltas.len() > MAX_ACCOUNT_TOKEN_ROWS {
            return Err(StateError::DeltaRowLimitExceeded {
                context: "decode",
                attempted: deltas.len(),
                maximum: MAX_ACCOUNT_TOKEN_ROWS,
            });
        }
        let mut seen = BTreeSet::new();
        let mut map = PersistentRadixMap::empty();
        for delta in deltas {
            if !seen.insert(delta.token_id()) {
                return Err(StateError::DuplicateToken(delta.token_id()));
            }
            map = put_delta_map(&map, delta)?;
        }
        if locks.len() > MAX_ACCOUNT_HTLC_LOCKS {
            return Err(StateError::HtlcRestoreLimitExceeded {
                actual: locks.len(),
                maximum: MAX_ACCOUNT_HTLC_LOCKS,
            });
        }
        let mut seen_locks = BTreeSet::new();
        let mut lock_map = PersistentRadixMap::empty();
        for lock in locks {
            lock.validate_for_restore()?;
            if !seen_locks.insert(lock.lock_id().to_owned()) {
                return Err(StateError::DuplicateHtlcLock(lock.lock_id().to_owned()));
            }
            lock_map = put_htlc_map(&lock_map, lock)?;
        }
        let mut policy_map = PersistentRadixMap::empty();
        let mut seen_policies = BTreeSet::new();
        for (token_id, policy) in rebalance_fee_policies {
            if !seen_policies.insert(token_id) {
                return Err(StateError::DuplicateToken(token_id));
            }
            policy_map = put_policy_map(&policy_map, token_id, policy)?;
        }
        let mut offer_map = PersistentRadixMap::empty();
        for offer in swap_offers {
            offer_map = put_swap_offer_map(&offer_map, offer)?;
        }
        let mut intent_map = if lending_intents.is_empty() {
            None
        } else {
            Some(PersistentRadixMap::empty())
        };
        for (key, kind) in lending_intents {
            let raw_key = text_key(&key)?;
            let digest = canonical_digest(CanonicalValue::String(kind.wire_name().into()))?;
            let map = intent_map.take().unwrap_or_else(PersistentRadixMap::empty);
            intent_map = Some(
                map.updated(raw_key, kind, digest)
                    .map_err(|error| StateError::PersistentMap(error.to_string()))?,
            );
        }
        Ok(Self {
            identity,
            dispute_config,
            deltas: map,
            locks: lock_map,
            lending_intents: intent_map,
            rebalance_fee_policies: policy_map,
            swap_offers: offer_map,
            j_nonce,
            last_finalized_j_height,
            carried,
            root_cache: crate::commitment::AccountRootCache::default(),
        })
    }

    pub const fn identity(&self) -> &AccountIdentity {
        &self.identity
    }

    pub const fn dispute_config(&self) -> AccountDisputeConfig {
        self.dispute_config
    }

    /// Exact TypeScript AccountStateRoot for the isolated payment profile.
    ///
    /// This state type cannot represent swaps, pulls, rebalance policy,
    /// J-claim progress, or settlement workspaces — those sections are
    /// committed at their canonical genesis values and callers must reject a
    /// wider Account snapshot instead of projecting it. The J journal counters
    /// (`jNonce`, `lastFinalizedJHeight`) ARE represented and committed
    /// verbatim.
    /// Section roots this account currently commits.
    fn payment_roots(&self) -> crate::commitment::PaymentAccountRoots {
        crate::commitment::PaymentAccountRoots {
            deltas: self.deltas.root_hash(),
            locks: self.locks.root_hash(),
            lending_intents: self
                .lending_intents
                .as_ref()
                .map_or([0; 32], PersistentRadixMap::root_hash),
            rebalance_fee_policies: self.rebalance_fee_policies.root_hash(),
            swap_offers: self.swap_offers.root_hash(),
        }
    }

    fn journal(&self) -> crate::commitment::AccountJournal {
        crate::commitment::AccountJournal {
            j_nonce: self.j_nonce,
            last_finalized_j_height: self.last_finalized_j_height,
        }
    }

    /// Recompute exactly the sections whose inputs moved and refresh the memo.
    ///
    /// Called once per candidate, after its transitions are applied: from then
    /// on every read of this account's state root — the leaf digest, the query
    /// page, the parity check — is a memo hit.
    pub fn refresh_account_state_root(&mut self) -> Result<[u8; 32], StateError> {
        let roots = self.payment_roots();
        let journal = self.journal();
        crate::commitment::refresh_payment_account_state_root(
            &mut self.root_cache,
            &self.identity,
            self.dispute_config,
            &roots,
            &journal,
            &self.carried,
        )
    }

    pub fn payment_profile_account_state_root(&self) -> Result<[u8; 32], StateError> {
        if let Some(root) = crate::commitment::cached_payment_account_state_root(
            &self.root_cache,
            self.dispute_config,
            &self.payment_roots(),
            &self.journal(),
            &self.carried,
        ) {
            return Ok(root);
        }
        crate::commitment::payment_account_state_root(
            &self.identity,
            self.dispute_config,
            self.payment_roots(),
            self.journal(),
            &self.carried,
        )
    }

    pub fn delta(&self, token_id: TokenId) -> Option<&Delta> {
        self.deltas.get(&token_id.radix_key())
    }

    /// Every delta row in ascending token order, the order a frame lists them.
    pub fn deltas(&self) -> impl Iterator<Item = &Delta> {
        self.deltas.iter().map(|(_, delta)| delta)
    }

    pub fn delta_count(&self) -> usize {
        self.deltas.len()
    }

    pub fn deltas_root(&self) -> [u8; 32] {
        self.deltas.root_hash()
    }

    pub fn lending_intents_root(&self) -> Option<[u8; 32]> {
        self.lending_intents
            .as_ref()
            .map(PersistentRadixMap::root_hash)
    }

    pub fn rebalance_policy(&self, token_id: TokenId) -> Option<&BilateralRebalanceFeePolicy> {
        self.rebalance_fee_policies.get(&token_id.radix_key())
    }

    pub fn rebalance_fee_policies_root(&self) -> [u8; 32] {
        self.rebalance_fee_policies.root_hash()
    }

    pub fn swap_offer(&self, offer_id: &str) -> Option<&SwapOffer> {
        let raw_key = encode_raw_text_key(offer_id).ok()?;
        self.swap_offers.get(&raw_key)
    }

    pub fn swap_offers(&self) -> impl Iterator<Item = &SwapOffer> {
        self.swap_offers.iter().map(|(_, offer)| offer)
    }

    pub fn swap_offer_count(&self) -> usize {
        self.swap_offers.len()
    }

    pub fn swap_offers_root(&self) -> [u8; 32] {
        self.swap_offers.root_hash()
    }

    pub fn htlc_lock(&self, lock_id: &str) -> Option<&HtlcLock> {
        let raw_key = encode_raw_text_key(lock_id).ok()?;
        self.locks.get(&raw_key)
    }

    pub fn htlc_count(&self) -> usize {
        self.locks.len()
    }

    pub fn htlc_locks_root(&self) -> [u8; 32] {
        self.locks.root_hash()
    }

    pub fn lending_intent(&self, key: &str) -> Option<LendingIntentKind> {
        let raw_key = encode_raw_text_key(key).ok()?;
        self.lending_intents
            .as_ref()
            .and_then(|intents| intents.get(&raw_key))
            .copied()
    }

    pub fn delta_node_changes_since(&self, previous: &Self) -> PersistentNodeChanges<Delta> {
        self.deltas.node_changes_since(&previous.deltas)
    }

    pub fn lending_node_changes_since(
        &self,
        previous: &Self,
    ) -> PersistentNodeChanges<LendingIntentKind> {
        let empty = PersistentRadixMap::empty();
        let current = self.lending_intents.as_ref().unwrap_or(&empty);
        let prior = previous.lending_intents.as_ref().unwrap_or(&empty);
        current.node_changes_since(prior)
    }

    pub fn htlc_node_changes_since(&self, previous: &Self) -> PersistentNodeChanges<HtlcLock> {
        self.locks.node_changes_since(&previous.locks)
    }

    pub fn swap_offer_node_changes_since(
        &self,
        previous: &Self,
    ) -> PersistentNodeChanges<SwapOffer> {
        self.swap_offers.node_changes_since(&previous.swap_offers)
    }

    pub fn rebalance_policy_node_changes_since(
        &self,
        previous: &Self,
    ) -> PersistentNodeChanges<BilateralRebalanceFeePolicy> {
        self.rebalance_fee_policies
            .node_changes_since(&previous.rebalance_fee_policies)
    }

    /// Every node of one section, for an account the checkpoint has never
    /// seen: there is no prior tree to diff against, so the whole tree is the
    /// change.
    pub fn delta_node_records(&self) -> Vec<PersistentNodeRecord<Delta>> {
        self.deltas.node_records()
    }

    pub fn htlc_node_records(&self) -> Vec<PersistentNodeRecord<HtlcLock>> {
        self.locks.node_records()
    }

    pub fn lending_node_records(&self) -> Vec<PersistentNodeRecord<LendingIntentKind>> {
        self.lending_intents
            .as_ref()
            .map(PersistentRadixMap::node_records)
            .unwrap_or_default()
    }

    pub fn swap_offer_node_records(&self) -> Vec<PersistentNodeRecord<SwapOffer>> {
        self.swap_offers.node_records()
    }

    pub fn rebalance_policy_node_records(
        &self,
    ) -> Vec<PersistentNodeRecord<BilateralRebalanceFeePolicy>> {
        self.rebalance_fee_policies.node_records()
    }

    pub fn htlc_locks(&self) -> impl Iterator<Item = &HtlcLock> {
        self.locks.iter().map(|(_, lock)| lock)
    }

    /// The intents with their original text keys. `encode_raw_text_key` is a
    /// length prefix over the UTF-8 bytes, so the key a checkpoint restores is
    /// the key the handler wrote.
    pub fn lending_intent_entries(&self) -> Result<Vec<(String, LendingIntentKind)>, StateError> {
        let Some(intents) = self.lending_intents.as_ref() else {
            return Ok(Vec::new());
        };
        let mut entries = Vec::with_capacity(intents.len());
        for (key, kind) in intents.iter() {
            entries.push((decode_raw_text_key(key)?, *kind));
        }
        Ok(entries)
    }

    pub fn rebalance_fee_policy_entries(
        &self,
    ) -> Result<Vec<(TokenId, BilateralRebalanceFeePolicy)>, StateError> {
        let mut entries = Vec::with_capacity(self.rebalance_fee_policies.len());
        for (key, policy) in self.rebalance_fee_policies.iter() {
            entries.push((decode_token_radix_key(key)?, policy.clone()));
        }
        Ok(entries)
    }

    pub const fn j_nonce(&self) -> u64 {
        self.j_nonce
    }

    pub const fn last_finalized_j_height(&self) -> u64 {
        self.last_finalized_j_height
    }

    pub const fn carried(&self) -> &crate::commitment::CarriedSections {
        &self.carried
    }

    pub(crate) fn delta_or_zero(&self, token_id: TokenId) -> Result<Delta, StateError> {
        if let Some(delta) = self.delta(token_id) {
            return Ok(delta.clone());
        }
        if self.deltas.len() >= MAX_ACCOUNT_TOKEN_ROWS {
            return Err(StateError::DeltaRowLimitExceeded {
                context: "insert",
                attempted: self.deltas.len() + 1,
                maximum: MAX_ACCOUNT_TOKEN_ROWS,
            });
        }
        Ok(Delta::zero(token_id))
    }

    pub(crate) fn put_delta(&mut self, delta: Delta) -> Result<(), StateError> {
        self.deltas = put_delta_map(&self.deltas, delta)?;
        Ok(())
    }

    pub(crate) fn put_rebalance_policy(
        &mut self,
        token_id: TokenId,
        policy: BilateralRebalanceFeePolicy,
    ) -> Result<(), StateError> {
        self.rebalance_fee_policies =
            put_policy_map(&self.rebalance_fee_policies, token_id, policy)?;
        Ok(())
    }

    pub(crate) fn put_swap_offer(&mut self, offer: SwapOffer) -> Result<(), StateError> {
        self.swap_offers = put_swap_offer_map(&self.swap_offers, offer)?;
        Ok(())
    }

    pub(crate) fn remove_swap_offer(&mut self, offer_id: &str) -> Result<(), StateError> {
        let key = text_key(offer_id)?;
        self.swap_offers = self.swap_offers.removed(&key);
        Ok(())
    }

    pub(crate) fn put_htlc_lock(&mut self, lock: HtlcLock) -> Result<(), StateError> {
        self.locks = put_htlc_map(&self.locks, lock)?;
        Ok(())
    }

    pub(crate) fn remove_htlc_lock(&mut self, lock_id: &str) -> Result<(), StateError> {
        let key = crate::htlc_lock_radix_key(lock_id)?;
        self.locks = self.locks.removed(&key);
        Ok(())
    }

    pub(crate) fn has_intent(&self, key: &str) -> Result<bool, StateError> {
        let raw_key = text_key(key)?;
        Ok(self
            .lending_intents
            .as_ref()
            .is_some_and(|intents| intents.get(&raw_key).is_some()))
    }

    pub(crate) fn put_intent(
        &mut self,
        key: String,
        kind: LendingIntentKind,
    ) -> Result<(), StateError> {
        let raw_key = text_key(&key)?;
        let digest = canonical_digest(CanonicalValue::String(kind.wire_name().into()))?;
        let intents = self
            .lending_intents
            .as_ref()
            .cloned()
            .unwrap_or_else(PersistentRadixMap::empty);
        self.lending_intents = Some(
            intents
                .updated(raw_key, kind, digest)
                .map_err(|error| StateError::PersistentMap(error.to_string()))?,
        );
        Ok(())
    }
}

#[derive(Clone)]
pub struct AccountReplica {
    owner: EntityId,
    owner_side: Side,
    state: AccountState,
    /// The replica shell the Entity commits around this state: mempool, frame
    /// bindings, hankos, acks. Carried verbatim until the engine derives it.
    envelope: crate::AccountEnvelope,
}

impl AccountReplica {
    pub fn new(owner: EntityId, state: AccountState) -> Result<Self, StateError> {
        let owner_side = state
            .identity
            .side_of(&owner)
            .ok_or_else(|| StateError::InvalidReplicaOwner(owner.to_string()))?;
        Ok(Self {
            owner,
            owner_side,
            state,
            envelope: crate::AccountEnvelope::default(),
        })
    }

    /// Replace the replica shell. The authority hands it over with the last
    /// transition of the frame that produced it.
    pub fn set_envelope(&mut self, envelope: crate::AccountEnvelope) {
        self.envelope = envelope;
    }

    pub const fn envelope(&self) -> &crate::AccountEnvelope {
        &self.envelope
    }

    /// The leaf this replica occupies in the Entity's accounts tree: the whole
    /// shell plus the engine's own financial root. Without an envelope there
    /// is nothing to commit beyond the financial root, and the payment-profile
    /// root is the leaf.
    pub fn entity_account_leaf(&self) -> Result<[u8; 32], StateError> {
        let account_state_root = self.state.payment_profile_account_state_root()?;
        if self.envelope.is_empty() {
            return Ok(account_state_root);
        }
        self.envelope
            .entity_account_leaf(&account_state_root)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }

    pub const fn owner(&self) -> &EntityId {
        &self.owner
    }

    pub const fn state(&self) -> &AccountState {
        &self.state
    }

    /// Refresh this replica's memoized account state root after a candidate
    /// finished its transitions.
    pub fn refresh_account_state_root(&mut self) -> Result<[u8; 32], StateError> {
        self.state.refresh_account_state_root()
    }

    pub(crate) fn state_mut(&mut self) -> &mut AccountState {
        &mut self.state
    }

    pub const fn owner_side(&self) -> Side {
        self.owner_side
    }

    pub fn counterparty(&self) -> &EntityId {
        self.state.identity.entity(self.owner_side().opposite())
    }
}

fn put_delta_map(
    map: &PersistentRadixMap<Delta>,
    delta: Delta,
) -> Result<PersistentRadixMap<Delta>, StateError> {
    let key = delta.token_id().radix_key();
    let digest = delta_digest(&delta)?;
    map.updated(key, delta, digest)
        .map_err(|error| StateError::PersistentMap(error.to_string()))
}

fn put_htlc_map(
    map: &PersistentRadixMap<HtlcLock>,
    lock: HtlcLock,
) -> Result<PersistentRadixMap<HtlcLock>, StateError> {
    let key = crate::htlc_lock_radix_key(lock.lock_id())?;
    let digest = crate::htlc_lock_value_digest(&lock)?;
    map.updated(key, lock, digest)
        .map_err(|error| StateError::PersistentMap(error.to_string()))
}

fn put_swap_offer_map(
    map: &PersistentRadixMap<SwapOffer>,
    offer: SwapOffer,
) -> Result<PersistentRadixMap<SwapOffer>, StateError> {
    let key = text_key(offer.offer_id())?;
    let digest = canonical_digest(offer.canonical())?;
    map.updated(key, offer, digest)
        .map_err(|error| StateError::PersistentMap(error.to_string()))
}

fn put_policy_map(
    map: &PersistentRadixMap<BilateralRebalanceFeePolicy>,
    token_id: TokenId,
    policy: BilateralRebalanceFeePolicy,
) -> Result<PersistentRadixMap<BilateralRebalanceFeePolicy>, StateError> {
    let digest = canonical_digest(policy.canonical())?;
    map.updated(token_id.radix_key(), policy, digest)
        .map_err(|error| StateError::PersistentMap(error.to_string()))
}

fn delta_digest(delta: &Delta) -> Result<[u8; 32], StateError> {
    let mut fields = vec![(
        "tokenId".into(),
        CanonicalValue::Number(f64::from(delta.token_id().get())),
    )];
    fields.extend(
        delta
            .commitment_fields()
            .map(|(name, value)| (name.into(), CanonicalValue::BigInt(value))),
    );
    canonical_digest(CanonicalValue::Object(fields))
}

fn canonical_digest(value: CanonicalValue) -> Result<[u8; 32], StateError> {
    let bytes = encode_account_state_value(&value)
        .map_err(|error| StateError::PersistentMap(error.to_string()))?;
    Ok(Sha256::digest(bytes).into())
}

fn text_key(value: &str) -> Result<Vec<u8>, StateError> {
    encode_raw_text_key(value).map_err(|error| StateError::PersistentMap(error.to_string()))
}

fn response_seconds(side: &'static str, value: u64) -> Result<u32, StateError> {
    u32::try_from(value).map_err(|_| StateError::InvalidDisputeResponseSeconds { side, value })
}

/// Inverse of `encode_raw_text_key`, for the sections a checkpoint restores by
/// key rather than by value.
fn decode_raw_text_key(key: &[u8]) -> Result<String, StateError> {
    if key.len() < 2 {
        return Err(StateError::PersistentMap(format!(
            "TEXT_KEY_TOO_SHORT:{}",
            key.len()
        )));
    }
    let length = usize::from(u16::from_be_bytes([key[0], key[1]]));
    if key.len() != length + 2 {
        return Err(StateError::PersistentMap(format!(
            "TEXT_KEY_LENGTH:{}:{}",
            length,
            key.len() - 2
        )));
    }
    String::from_utf8(key[2..].to_vec())
        .map_err(|_| StateError::PersistentMap("TEXT_KEY_UTF8".to_string()))
}

/// Inverse of `TokenId::radix_key`: 32 bytes, the id in the last two.
fn decode_token_radix_key(key: &[u8]) -> Result<TokenId, StateError> {
    if key.len() != 32 || key[..30].iter().any(|byte| *byte != 0) {
        return Err(StateError::PersistentMap(format!(
            "TOKEN_KEY_SHAPE:{}",
            key.len()
        )));
    }
    TokenId::new(u32::from(u16::from_be_bytes([key[30], key[31]])))
}
