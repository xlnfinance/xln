use std::collections::BTreeSet;

use sha2::{Digest, Sha256};
use xln_rscore_protocol::{
    CanonicalValue, PersistentNodeChanges, PersistentRadixMap, encode_account_state_value,
    encode_raw_text_key,
};

use crate::delta::MAX_ACCOUNT_TOKEN_ROWS;
use crate::{AccountIdentity, Delta, EntityId, Side, StateError, TokenId};

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
    deltas: PersistentRadixMap<Delta>,
    lending_intents: Option<PersistentRadixMap<LendingIntentKind>>,
}

impl AccountState {
    pub fn new(identity: AccountIdentity, deltas: Vec<Delta>) -> Result<Self, StateError> {
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
        Ok(Self {
            identity,
            deltas: map,
            lending_intents: None,
        })
    }

    pub const fn identity(&self) -> &AccountIdentity {
        &self.identity
    }

    pub fn delta(&self, token_id: TokenId) -> Option<&Delta> {
        self.deltas.get(&token_id.radix_key())
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
        })
    }

    pub const fn owner(&self) -> &EntityId {
        &self.owner
    }

    pub const fn state(&self) -> &AccountState {
        &self.state
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
