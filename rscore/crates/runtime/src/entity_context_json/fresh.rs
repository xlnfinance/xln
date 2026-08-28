//! Canonical proposer context for live resident Runtime frames.

#[path = "fresh/htlc.rs"]
mod htlc;

use std::collections::BTreeSet;

use num_bigint::BigInt;
use serde_json::{Value, json};
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use xln_rscore_batch::{AccountInputKind, AccountInputRow};
use xln_rscore_engine::AccountTx;
use xln_rscore_entity_kernel::{
    DeterministicContext, LocalEntityFinancialTx, PreparedContextError,
};
use xln_rscore_protocol::CanonicalValue;

use self::htlc::materialize_inbound_htlc_context;

use crate::{
    EntityContextJsonError, RuntimeReplica, TaggedJsonError, canonical_value_from_tagged_json,
    decode_entity_deterministic_context,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum FreshEntityContextError {
    #[error("RRS_FRESH_CONTEXT_HEIGHT_OVERFLOW")]
    HeightOverflow,
    #[error("RRS_FRESH_CONTEXT_HEIGHT_UNSAFE:{0}")]
    HeightUnsafe(u64),
    #[error("RRS_FRESH_CONTEXT_LINEAGE:state={state}:head={head}")]
    Lineage { state: u64, head: String },
    #[error("RRS_FRESH_CONTEXT_HTLC_INFRA_REQUIRED")]
    HtlcInfrastructureRequired,
    #[error("RRS_FRESH_CONTEXT_HTLC_ORIGIN_REQUIRED")]
    HtlcOriginRequired,
    #[error("RRS_FRESH_CONTEXT_HTLC_INFRA_INVALID:{0}")]
    HtlcInfrastructureInvalid(String),
    #[error("RRS_FRESH_CONTEXT_HTLC_ACCOUNT_READ:{0}")]
    HtlcAccountRead(String),
    #[error(transparent)]
    Htlc(#[from] PreparedContextError),
    #[error(transparent)]
    Decode(#[from] EntityContextJsonError),
    #[error(transparent)]
    Canonical(#[from] TaggedJsonError),
}

pub struct EntityInfraMaterializeRequest<'a> {
    pub replica: &'a mut RuntimeReplica,
    /// Exact Account rows remaining after Runtime FIFO and Entity wire fitting.
    pub account_inputs: &'a [&'a AccountInputRow],
    /// Exact effective local operations after Entity-command expansion.
    pub local_financial_txs: &'a [&'a LocalEntityFinancialTx],
    pub timestamp: u64,
    pub finalized_j_height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaterializedEntityInfraContext {
    pub execution: DeterministicContext,
    pub canonical: CanonicalValue,
}

/// Live infrastructure is invoked once, after the exact Runtime/Entity prefix
/// is fixed and before any Account or Entity mutation. Replay bypasses this
/// trait and consumes the context already committed in its Runtime frame.
pub trait EntityInfraMaterializer {
    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundHtlcInfrastructure {
    pub entity_encryption_public_key: [u8; 32],
    pub entity_encryption_private_key: [u8; 32],
    pub routing_fee_ppm: u32,
    pub routing_base_fee: BigInt,
    pub known_profile_entity_ids: BTreeSet<String>,
    pub online_entity_ids: BTreeSet<String>,
}

impl InboundHtlcInfrastructure {
    pub fn validate(self) -> Result<Self, FreshEntityContextError> {
        let canonical = |value: &String| {
            value.len() == 66
                && value.starts_with("0x")
                && value == &value.to_ascii_lowercase()
                && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        };
        let derived_public =
            *PublicKey::from(&StaticSecret::from(self.entity_encryption_private_key)).as_bytes();
        if derived_public != self.entity_encryption_public_key
            || self.routing_fee_ppm > 999_999
            || self.routing_base_fee < BigInt::from(0)
            || self
                .known_profile_entity_ids
                .iter()
                .any(|value| !canonical(value))
            || self.online_entity_ids.iter().any(|value| !canonical(value))
            || !self
                .online_entity_ids
                .is_subset(&self.known_profile_entity_ids)
        {
            return Err(FreshEntityContextError::HtlcInfrastructureInvalid(
                "KEYPAIR_OR_FIELDS".into(),
            ));
        }
        Ok(self)
    }
}

/// Canonical direct-payment/same-J/J-event materializer. HTLC work is rejected
/// until profile, liveness, encryption and onion inputs are installed here;
/// it must never silently execute with an empty context.
pub struct CanonicalEntityInfraMaterializer {
    policy: Value,
    inbound_htlc: Option<InboundHtlcInfrastructure>,
}

impl CanonicalEntityInfraMaterializer {
    pub fn new(policy: Value) -> Self {
        Self {
            policy,
            inbound_htlc: None,
        }
    }

    pub fn with_inbound_htlc(
        policy: Value,
        infrastructure: InboundHtlcInfrastructure,
    ) -> Result<Self, FreshEntityContextError> {
        Ok(Self {
            policy,
            inbound_htlc: Some(infrastructure.validate()?),
        })
    }
}

impl EntityInfraMaterializer for CanonicalEntityInfraMaterializer {
    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
        materialize_fresh_entity_context(&self.policy, self.inbound_htlc.as_ref(), request)
    }
}

fn frame_needs_htlc_context(frame: &xln_rscore_engine::AccountFrame) -> bool {
    frame
        .txs
        .iter()
        .any(|tx| matches!(tx, AccountTx::HtlcLock(lock) if lock.envelope.is_some()))
}

fn needs_htlc_context(request: &EntityInfraMaterializeRequest<'_>) -> bool {
    request
        .account_inputs
        .iter()
        .any(|row| match &row.input.kind {
            AccountInputKind::Frame(frame) => frame_needs_htlc_context(&frame.frame),
            AccountInputKind::FrameAck { frame, .. } => frame_needs_htlc_context(&frame.frame),
            AccountInputKind::Ack(_)
            | AccountInputKind::Dispute(_)
            | AccountInputKind::BoardHankoRefresh(_) => false,
        })
        || request
            .local_financial_txs
            .iter()
            .any(|tx| matches!(tx, LocalEntityFinancialTx::HtlcPayment(_)))
}

fn needs_originated_htlc(request: &EntityInfraMaterializeRequest<'_>) -> bool {
    request
        .local_financial_txs
        .iter()
        .any(|tx| matches!(tx, LocalEntityFinancialTx::HtlcPayment(_)))
}

/// Build the exact empty-infrastructure Entity context used by TypeScript for
/// direct payments, same-J swaps, J-events and ordinary Account ACK traffic.
pub fn materialize_fresh_entity_context(
    policy: &Value,
    inbound_htlc: Option<&InboundHtlcInfrastructure>,
    mut request: EntityInfraMaterializeRequest<'_>,
) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
    if needs_originated_htlc(&request) {
        return Err(FreshEntityContextError::HtlcOriginRequired);
    }
    if needs_htlc_context(&request) && inbound_htlc.is_none() {
        return Err(FreshEntityContextError::HtlcInfrastructureRequired);
    }
    let (entries, peer_assertions) = match inbound_htlc {
        Some(infrastructure) => materialize_inbound_htlc_context(infrastructure, &mut request)?,
        None => (Vec::new(), Vec::new()),
    };
    let replica = &request.replica;
    let height = replica
        .state
        .entity
        .height
        .checked_add(1)
        .ok_or(FreshEntityContextError::HeightOverflow)?;
    if height > MAX_SAFE_INTEGER {
        return Err(FreshEntityContextError::HeightUnsafe(height));
    }
    let parent_frame_hash = match replica.entity_consensus.certified_frame_head.as_ref() {
        Some(head) if head.frame.height == replica.state.entity.height => head.frame.hash.clone(),
        Some(head) => {
            return Err(FreshEntityContextError::Lineage {
                state: replica.state.entity.height,
                head: head.frame.height.to_string(),
            });
        }
        None if replica.state.entity.height == 0 => "genesis".to_string(),
        None => {
            return Err(FreshEntityContextError::Lineage {
                state: replica.state.entity.height,
                head: "missing".into(),
            });
        }
    };
    let entity_id = replica.state.entity.entity_id.clone();
    let signer_id = replica.signer_id.clone();
    let canonical_json = json!({
        "version": 1,
        "proposerReplicaId": format!("{entity_id}:{signer_id}"),
        "entityId": entity_id,
        "proposerSignerId": signer_id,
        "parentFrameHash": parent_frame_hash,
        "height": height,
        "gossipProfiles": [],
        "peerAssertions": peer_assertions,
        "htlc": { "version": 1, "entries": entries, "originated": [] },
    });
    Ok(MaterializedEntityInfraContext {
        execution: decode_entity_deterministic_context(policy, &canonical_json)?,
        canonical: canonical_value_from_tagged_json(&canonical_json)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbound_htlc_infrastructure_requires_the_checkpoint_keypair() {
        let private_key = [7_u8; 32];
        let public_key = *PublicKey::from(&StaticSecret::from(private_key)).as_bytes();
        let valid = InboundHtlcInfrastructure {
            entity_encryption_public_key: public_key,
            entity_encryption_private_key: private_key,
            routing_fee_ppm: 1,
            routing_base_fee: BigInt::from(0),
            known_profile_entity_ids: BTreeSet::new(),
            online_entity_ids: BTreeSet::new(),
        };
        valid.clone().validate().expect("matching keypair");
        assert!(matches!(
            InboundHtlcInfrastructure {
                entity_encryption_public_key: [8; 32],
                ..valid
            }
            .validate(),
            Err(FreshEntityContextError::HtlcInfrastructureInvalid(_))
        ));
    }
}
