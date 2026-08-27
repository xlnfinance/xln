//! Canonical proposer context for live resident Runtime frames.

use serde_json::{Value, json};
use thiserror::Error;
use xln_rscore_batch::{AccountInputKind, AccountInputRow};
use xln_rscore_engine::AccountTx;
use xln_rscore_entity_kernel::{DeterministicContext, LocalEntityFinancialTx};
use xln_rscore_protocol::CanonicalValue;

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
    #[error(transparent)]
    Decode(#[from] EntityContextJsonError),
    #[error(transparent)]
    Canonical(#[from] TaggedJsonError),
}

pub struct EntityInfraMaterializeRequest<'a> {
    pub replica: &'a RuntimeReplica,
    /// Exact Account rows remaining after Runtime FIFO and Entity wire fitting.
    pub account_inputs: &'a [AccountInputRow],
    /// Exact effective local operations after Entity-command expansion.
    pub local_financial_txs: &'a [LocalEntityFinancialTx],
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

/// Canonical direct-payment/same-J/J-event materializer. HTLC work is rejected
/// until profile, liveness, encryption and onion inputs are installed here;
/// it must never silently execute with an empty context.
pub struct CanonicalEntityInfraMaterializer {
    policy: Value,
}

impl CanonicalEntityInfraMaterializer {
    pub fn new(policy: Value) -> Self {
        Self { policy }
    }
}

impl EntityInfraMaterializer for CanonicalEntityInfraMaterializer {
    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
        materialize_fresh_entity_context(&self.policy, request)
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

/// Build the exact empty-infrastructure Entity context used by TypeScript for
/// direct payments, same-J swaps, J-events and ordinary Account ACK traffic.
pub fn materialize_fresh_entity_context(
    policy: &Value,
    request: EntityInfraMaterializeRequest<'_>,
) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
    if needs_htlc_context(&request) {
        return Err(FreshEntityContextError::HtlcInfrastructureRequired);
    }
    let replica = request.replica;
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
        "peerAssertions": [],
        "htlc": { "version": 1, "entries": [], "originated": [] },
    });
    Ok(MaterializedEntityInfraContext {
        execution: decode_entity_deterministic_context(policy, &canonical_json)?,
        canonical: canonical_value_from_tagged_json(&canonical_json)?,
    })
}
