use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

use sha3::{Digest as _, Keccak256};
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputVerdict, CertifiedBoardAuthorityResolver,
    CertifiedSettlementHankoDraft, EntityInboundRequest, ReceiverClock,
    ResidentAccountFinancialViewRequest, ResidentCrossJMaterializationView,
};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, EntityCommandBoard, EntityCommandDisposition, EntityFrameEvent,
    EntityFrameWireMeasureBody, EntityTransitionCertificationRequest, EntityTransitionError,
    EntityTxKind, HashType, JPrefixRangeClaim, LocalEntityOutput, LocalEntityOutputTx,
    LocalEntityTx, MAX_ENTITY_FRAME_TX_BYTES, MAX_ENTITY_FRAME_TXS, MAX_ENTITY_PROPOSAL_WIRE_BYTES,
    MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, PendingNonMutatingWake, ResidentEntityOperation,
    ResidentEntityRequest, ScheduledWake, ScheduledWakeJob, ScheduledWakeJobKind, SchedulerError,
    UNREGISTERED_ENTITY_COMMAND_STACK_KEY, advance_entity_command_nonce,
    apply_resident_entity_round_core, assert_signed_entity_command,
    build_locally_authored_entity_command, build_proposer_materializations,
    build_required_j_prefix_certificate, certify_entity_transition,
    collect_due_scheduled_wake_jobs, current_entity_command_board_hash, decode_local_entity_tx,
    encode_entity_frame_context, measure_entity_frame_tx_bytes, measure_entity_frame_wire,
    normalize_entity_command_nonce_board, proposer_materialization_account_view_requests,
    resolve_board_handover_authority, sign_j_event_range,
};
use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

use crate::entity_context_json::apply_entity_state_policy;
use crate::{
    EntityInfraMaterializeRequest, EntityInfraMaterializer, MaterializedEntityInfraContext,
};

use super::inbound_genesis::{attach_inbound_genesis_policies, derive_policy};
use super::scheduled_input::decode_recorded_scheduled_wake;
use super::types::EntityPendingWork;
use super::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RuntimeApplyPhaseProfile, RuntimeApplyResult, RuntimeEntityFrameContext, RuntimeEntityInput,
    RuntimeEntityKey, RuntimeEntityOutputs, RuntimeEntityReplica, RuntimeEntityState,
    RuntimeFrameContext, RuntimeFrameTouches, RuntimeInput, RuntimeLiveInput, RuntimeMachineError,
    RuntimeOutputs, RuntimeReplica, RuntimeWake, enqueue_runtime_input,
    scheduled_input::{empty_entity_input, scheduled_wake_entity_input},
    select_runtime_frame,
};

mod cross_j_commit_phase;

use cross_j_commit_phase::{
    MaterializationAdmission, materialization_admission, select_commit_phase_work,
};

struct EntityApplySlot {
    state: RuntimeEntityState,
    replica: RuntimeEntityReplica,
}

struct PreparedJPrefixRange {
    tx: CanonicalEntityTx,
    claim: JPrefixRangeClaim,
    signature: String,
}

fn j_range_error(detail: impl Into<String>) -> RuntimeMachineError {
    RuntimeMachineError::ReplicaMetadata(format!("J_PREFIX_RANGE:{}", detail.into()))
}

fn canonical_j_history_root(
    state: &xln_rscore_entity_kernel::EntityStateSlice,
) -> Result<[u8; 32], RuntimeMachineError> {
    let Some(finality) = state.j_history_finality.as_ref() else {
        return Ok(xln_rscore_entity_kernel::EMPTY_J_HISTORY_ROOT);
    };
    let root = match finality {
        CanonicalValue::Object(fields) => fields
            .iter()
            .find_map(|(field, value)| (field == "eventHistoryRoot").then_some(value)),
        _ => None,
    };
    let CanonicalValue::String(root) = root.ok_or_else(|| j_range_error("HISTORY_ROOT_MISSING"))?
    else {
        return Err(j_range_error("HISTORY_ROOT_TYPE"));
    };
    parse_hex32(root).ok_or_else(|| j_range_error("HISTORY_ROOT_INVALID"))
}

fn j_event_wire_blocks(
    observation: &crate::j_watcher::ObserveJRange,
) -> Result<Vec<serde_json::Value>, RuntimeMachineError> {
    let encoded = crate::j_watcher::encode_observe_j_range(observation)
        .map_err(|error| j_range_error(error.to_string()))?;
    let blocks = encoded
        .get("blocks")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| j_range_error("BLOCKS_MISSING"))?;
    blocks
        .iter()
        .map(|block| {
            let block = block
                .as_object()
                .ok_or_else(|| j_range_error("BLOCK_OBJECT"))?;
            let mut wire = serde_json::Map::new();
            wire.insert(
                "blockNumber".into(),
                block
                    .get("jHeight")
                    .cloned()
                    .ok_or_else(|| j_range_error("BLOCK_HEIGHT"))?,
            );
            wire.insert(
                "blockHash".into(),
                block
                    .get("jBlockHash")
                    .cloned()
                    .ok_or_else(|| j_range_error("BLOCK_HASH"))?,
            );
            for field in [
                "eventsHash",
                "events",
                "disputeFinalizationEvidence",
                "disputeFinalizationEvidenceHash",
            ] {
                if let Some(value) = block.get(field) {
                    wire.insert(field.into(), value.clone());
                }
            }
            Ok(serde_json::Value::Object(wire))
        })
        .collect()
}

fn prepare_j_prefix_range(
    slot: &EntityApplySlot,
    observation: &crate::j_watcher::ObserveJRange,
) -> Result<PreparedJPrefixRange, RuntimeMachineError> {
    prepare_j_prefix_range_from_parts(&slot.state, &slot.replica, observation)
}

fn prepare_j_prefix_range_from_parts(
    runtime_state: &crate::RuntimeEntityState,
    runtime_replica: &crate::RuntimeEntityReplica,
    observation: &crate::j_watcher::ObserveJRange,
) -> Result<PreparedJPrefixRange, RuntimeMachineError> {
    let state = &runtime_state.entity;
    if runtime_replica.entity_signer.signer_id() != observation.signer_id {
        return Err(j_range_error("SIGNER_MISMATCH"));
    }
    let base_height = state.last_finalized_j_height;
    if observation.scanned_through_height <= base_height {
        return Err(j_range_error("EMPTY_OR_STALE"));
    }
    let expected_header_count = observation.scanned_through_height - base_height;
    if u64::try_from(observation.headers.len()).ok() != Some(expected_header_count)
        || observation
            .headers
            .iter()
            .enumerate()
            .any(|(index, header)| {
                header.j_height != base_height + u64::try_from(index).unwrap_or(u64::MAX) + 1
            })
    {
        return Err(j_range_error(format!(
            "HEADER_RANGE:entity={}:base={base_height}:tip={}:headers={}:first={:?}:last={:?}",
            state.entity_id,
            observation.scanned_through_height,
            observation.headers.len(),
            observation.headers.first().map(|header| header.j_height),
            observation.headers.last().map(|header| header.j_height),
        )));
    }
    let blocks = xln_rscore_entity_kernel::canonical_j_event_blocks(&observation.batches)
        .map_err(|error| j_range_error(error.to_string()))?;
    let event_history_root = xln_rscore_entity_kernel::fold_j_history_root(
        canonical_j_history_root(state)?,
        &observation.jurisdiction_ref,
        &blocks,
    );
    let range_hash = xln_rscore_entity_kernel::canonical_j_event_range_hash(&blocks)
        .map_err(|error| j_range_error(error.to_string()))?;
    let signature = sign_j_event_range(
        &runtime_replica.entity_signer,
        &state.entity_id,
        &observation.jurisdiction_ref,
        base_height,
        observation.scanned_through_height,
        &observation.tip_block_hash,
        &event_history_root,
        &range_hash,
    )
    .map_err(|error| j_range_error(error.to_string()))?;
    let wire_blocks = j_event_wire_blocks(observation)?;
    let block_values = wire_blocks
        .iter()
        .map(crate::canonical_value_from_tagged_json)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| j_range_error(error.to_string()))?;
    let header_values = observation
        .headers
        .iter()
        .map(|header| {
            crate::canonical_value_from_tagged_json(&serde_json::json!({
                "jHeight": header.j_height,
                "jBlockHash": render_word(&header.j_block_hash),
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| j_range_error(error.to_string()))?;
    let claim = JPrefixRangeClaim {
        jurisdiction_ref: observation.jurisdiction_ref.clone(),
        base_height,
        scanned_through_height: observation.scanned_through_height,
        tip_block_hash: render_word(&observation.tip_block_hash),
        event_history_root: render_word(&event_history_root),
        range_hash: render_word(&range_hash),
        headers: header_values,
        blocks: block_values,
    };
    let data = serde_json::json!({
        "from": observation.signer_id,
        "jurisdictionRef": claim.jurisdiction_ref,
        "baseHeight": claim.base_height,
        "scannedThroughHeight": claim.scanned_through_height,
        "tipBlockHash": claim.tip_block_hash,
        "eventHistoryRoot": claim.event_history_root,
        "rangeHash": claim.range_hash,
        "blocks": wire_blocks,
        "signature": signature.clone(),
        "observedAt": claim.scanned_through_height,
    });
    let tx = crate::entity_frame::project_entity_tx(&serde_json::json!({
        "type": "j_event",
        "data": data,
    }))
    .map_err(|error| j_range_error(error.to_string()))?;
    Ok(PreparedJPrefixRange {
        tx,
        claim,
        signature,
    })
}

/// Build the exact single-signer Entity input that TS records beside an
/// ordered watcher observation. This is a pure admission projection: the
/// observation remains a RuntimeTx and no Entity frame is applied until this
/// returned input is selected into the same durable Runtime WAL frame.
pub(crate) fn build_local_j_prefix_entity_input(
    replica: &crate::RuntimeReplica,
    observation: &crate::j_watcher::ObserveJRange,
) -> Result<Option<RuntimeEntityInput>, RuntimeMachineError> {
    let (state, live) = replica
        .entity_slot(observation.entity_id.as_bytes(), &observation.signer_id)
        .ok_or(RuntimeMachineError::EntityOwnerMismatch)?;
    let prior_frame_hash = live
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .map_or("genesis", |head| head.frame.hash.as_str());
    // Header-only transport progress never manufactures an Entity frame for
    // an unregistered Entity. A semantic range is different: TS certifies its
    // exact authenticated prefix on demand even before registration finality.
    if observation.batches.is_empty()
        && build_required_j_prefix_certificate(
            &live.entity_signer,
            &live.entity_consensus.state.authority,
            &state.entity,
            state
                .entity
                .height
                .checked_add(1)
                .ok_or(RuntimeMachineError::EntityHeightOverflow)?,
            prior_frame_hash,
            None,
        )
        .map_err(EntityTransitionError::from)?
        .is_none()
    {
        return Ok(None);
    }
    let complete = complete_local_j_prefix_observation(state, live, Some(observation), false)?
        .ok_or_else(|| j_range_error("LOCAL_HISTORY_MISSING"))?;
    let prepared = prepare_j_prefix_range_from_parts(state, live, &complete)?;
    let Some(certificate) = build_required_j_prefix_certificate(
        &live.entity_signer,
        &live.entity_consensus.state.authority,
        &state.entity,
        state
            .entity
            .height
            .checked_add(1)
            .ok_or(RuntimeMachineError::EntityHeightOverflow)?,
        prior_frame_hash,
        Some(&prepared.claim),
    )
    .map_err(EntityTransitionError::from)?
    else {
        return Ok(None);
    };
    let certificate = crate::tagged_json_from_canonical_value(&certificate)
        .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
    let attestation = certificate
        .get("attestations")
        .and_then(|value| value.get("value"))
        .and_then(serde_json::Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(serde_json::Value::as_array)
        .filter(|row| row.len() == 2 && row[0].as_str() == Some(&observation.signer_id))
        .map(|row| row[1].clone())
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_PREFIX_CERTIFICATE_SIGNER_MISSING".into())
        })?;
    RuntimeEntityInput::decode(serde_json::json!({
        "entityId": complete.entity_id.as_hex(),
        "signerId": complete.signer_id,
        "jPrefixAttestations": {
            "__xlnType": "Map",
            "value": [[complete.signer_id, attestation]],
        },
    }))
    .map(Some)
}

pub(crate) fn build_pending_local_j_prefix_entity_input(
    replica: &crate::RuntimeReplica,
    entity_id: &[u8; 32],
    signer_id: &str,
) -> Result<Option<RuntimeEntityInput>, RuntimeMachineError> {
    let (state, live) = replica
        .entity_slot(entity_id, signer_id)
        .ok_or(RuntimeMachineError::EntityOwnerMismatch)?;
    let Some(observation) = complete_local_j_prefix_observation(state, live, None, false)? else {
        return Ok(None);
    };
    build_local_j_prefix_entity_input(replica, &observation)
}

fn complete_local_j_prefix_observation(
    state: &RuntimeEntityState,
    live: &RuntimeEntityReplica,
    suffix: Option<&crate::j_watcher::ObserveJRange>,
    include_header_only: bool,
) -> Result<Option<crate::j_watcher::ObserveJRange>, RuntimeMachineError> {
    let base_height = state.entity.last_finalized_j_height;
    let history = live
        .replica_metadata
        .get("jHistory")
        .and_then(serde_json::Value::as_object);
    let history_tip = history
        .and_then(|value| value.get("contiguousThroughHeight"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(base_height);
    let target = suffix.map_or(history_tip, |value| {
        value.scanned_through_height.max(history_tip)
    });
    if target <= base_height {
        return Ok(None);
    }
    let jurisdiction_ref = suffix
        .map(|value| value.jurisdiction_ref.clone())
        .or_else(|| {
            history
                .and_then(|value| value.get("jurisdictionRef"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| j_range_error("LOCAL_JURISDICTION_MISSING"))?;
    let mut hashes = tagged_height_map(
        history.and_then(|value| value.get("blockHashes")),
        "blockHashes",
    )?;
    let mut blocks = tagged_height_map(
        history.and_then(|value| value.get("eventBlocks")),
        "eventBlocks",
    )?;
    if let Some(suffix) = suffix {
        for header in &suffix.headers {
            hashes.insert(
                header.j_height,
                serde_json::Value::String(render_word(&header.j_block_hash)),
            );
        }
        let encoded = crate::j_watcher::encode_observe_j_range(suffix)
            .map_err(|error| j_range_error(error.to_string()))?;
        let suffix_blocks = encoded
            .get("blocks")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| j_range_error("LOCAL_BLOCKS_MISSING"))?;
        for block in suffix_blocks.iter().cloned() {
            let height = block
                .get("jHeight")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| j_range_error("LOCAL_BLOCK_HEIGHT"))?;
            blocks.insert(height, block);
        }
    }
    let headers = (base_height + 1..=target)
        .map(|height| {
            let hash = hashes
                .get(&height)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| j_range_error(format!("LOCAL_HEADER_MISSING:{height}")))?;
            Ok(serde_json::json!({"jHeight":height,"jBlockHash":hash}))
        })
        .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
    let tip_block_hash = headers
        .last()
        .and_then(|header| header.get("jBlockHash"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| j_range_error("LOCAL_TIP_MISSING"))?;
    let blocks = blocks
        .into_iter()
        .filter_map(|(height, block)| (height > base_height && height <= target).then_some(block))
        .collect::<Vec<_>>();
    if suffix.is_none() && blocks.is_empty() && !include_header_only {
        return Ok(None);
    }
    let value = serde_json::json!({
        "entityId": state.entity.entity_id,
        "signerId": live.signer_id,
        "jurisdictionRef": jurisdiction_ref,
        "scannedThroughHeight": target,
        "tipBlockHash": tip_block_hash,
        "headers": headers,
        "blocks": blocks,
    });
    crate::j_watcher::decode_observe_j_range(&value)
        .map(Some)
        .map_err(|error| j_range_error(error.to_string()))
}

fn profile_runtime_apply() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RUNTIME_APPLY_PROFILE").as_deref() == Ok("1"))
}

fn profile_account_input_outcomes_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

fn profiled_elapsed(started: Option<Instant>) -> std::time::Duration {
    started.map_or(std::time::Duration::ZERO, |started| started.elapsed())
}

fn finish_runtime_apply_profile(
    enabled: bool,
    started: Option<Instant>,
    runtime_height: u64,
    mut profile: RuntimeApplyPhaseProfile,
) -> Option<RuntimeApplyPhaseProfile> {
    if !enabled {
        return None;
    }
    profile.total = profiled_elapsed(started);
    profile.residual = profile.total.saturating_sub(profile.accounted());
    eprintln!(
        "RSCORE_RUNTIME_APPLY_PHASES runtimeHeight={} fitMicros={} residentCoreMicros={} postCorePrepareMicros={} certificationMicros={} settlementAttachMicros={} postCertJMicros={} residualMicros={} totalMicros={} entityGroups={} entityTxsSelected={} accountInputs={} settlementHankos={} postCertJActions={}",
        runtime_height,
        profile.fit.as_micros(),
        profile.resident_core.as_micros(),
        profile.post_core_prepare.as_micros(),
        profile.certification.as_micros(),
        profile.settlement_attach.as_micros(),
        profile.post_cert_j.as_micros(),
        profile.residual.as_micros(),
        profile.total.as_micros(),
        profile.entity_groups,
        profile.entity_txs_selected,
        profile.account_inputs,
        profile.settlement_hankos,
        profile.post_cert_j_actions,
    );
    Some(profile)
}

#[derive(Default)]
struct AccountInputOutcomeProfile {
    ack: usize,
    ack_frame_with_ack: usize,
    ack_frame_without_ack: usize,
    ack_committed: usize,
    ack_accepted: usize,
    ack_rejected: usize,
    frame_committed: usize,
    frame_duplicate: usize,
    frame_collision: usize,
    frame_stale: usize,
    frame_rejected: usize,
    force_ack_true: usize,
    force_ack_false: usize,
    force_ack_none: usize,
    input_other: usize,
    outcome_other: usize,
}

#[derive(Clone, Copy)]
enum ProfileAccountInputKind {
    Ack,
    AckFrameWithAck,
    AckFrameWithoutAck,
    Other,
}

impl From<&AccountInputKind> for ProfileAccountInputKind {
    fn from(kind: &AccountInputKind) -> Self {
        match kind {
            AccountInputKind::Ack(_) => Self::Ack,
            AccountInputKind::AckFrame { ack: Some(_), .. } => Self::AckFrameWithAck,
            AccountInputKind::AckFrame { ack: None, .. } => Self::AckFrameWithoutAck,
            AccountInputKind::Dispute(_) | AccountInputKind::BoardHankoRefresh(_) => Self::Other,
        }
    }
}

impl AccountInputOutcomeProfile {
    fn observe_ack(&mut self, verdict: &AccountInputVerdict) {
        match verdict {
            AccountInputVerdict::AckCommitted { .. } => self.ack_committed += 1,
            AccountInputVerdict::AckAccepted { .. } => self.ack_accepted += 1,
            AccountInputVerdict::AckRejected { .. } => self.ack_rejected += 1,
            _ => self.outcome_other += 1,
        }
    }

    fn observe_frame(&mut self, verdict: &AccountInputVerdict) {
        match verdict {
            AccountInputVerdict::FrameCommitted { .. } => self.frame_committed += 1,
            AccountInputVerdict::FrameDuplicate { .. } => self.frame_duplicate += 1,
            AccountInputVerdict::FrameCollisionIgnored { .. } => self.frame_collision += 1,
            AccountInputVerdict::FrameStale { .. } => self.frame_stale += 1,
            AccountInputVerdict::FrameRejected { .. } => self.frame_rejected += 1,
            _ => self.outcome_other += 1,
        }
    }

    fn observe_input(&mut self, kind: ProfileAccountInputKind) {
        match kind {
            ProfileAccountInputKind::Ack => self.ack += 1,
            ProfileAccountInputKind::AckFrameWithAck => self.ack_frame_with_ack += 1,
            ProfileAccountInputKind::AckFrameWithoutAck => self.ack_frame_without_ack += 1,
            ProfileAccountInputKind::Other => self.input_other += 1,
        }
    }

    fn observe_outcome(&mut self, kind: ProfileAccountInputKind, verdict: &AccountInputVerdict) {
        match (kind, verdict) {
            (ProfileAccountInputKind::Ack, verdict) => {
                self.observe_ack(verdict);
            }
            (
                ProfileAccountInputKind::AckFrameWithAck,
                AccountInputVerdict::AckFrameApplied {
                    ack: ack_verdict,
                    frame,
                },
            ) => {
                self.observe_ack(ack_verdict);
                self.observe_frame(frame);
            }
            (ProfileAccountInputKind::AckFrameWithoutAck, verdict) => self.observe_frame(verdict),
            (ProfileAccountInputKind::AckFrameWithAck, _) => self.outcome_other += 1,
            _ => self.outcome_other += 1,
        }
    }
}

fn profile_account_input_outcomes(
    runtime_height: u64,
    entity_height: u64,
    finalized_j_height: u64,
    accounts_root: [u8; 32],
    inputs: &[ProfileAccountInputKind],
    results: &[xln_rscore_batch::AccountInputResult],
) {
    let mut profile = AccountInputOutcomeProfile::default();
    for kind in inputs {
        profile.observe_input(*kind);
    }
    for (kind, result) in inputs.iter().zip(results) {
        profile.observe_outcome(*kind, &result.verdict);
    }
    for result in results {
        match result.force_ack {
            Some(true) => profile.force_ack_true += 1,
            Some(false) => profile.force_ack_false += 1,
            None => profile.force_ack_none += 1,
        }
    }
    eprintln!(
        "RSCORE_ACCOUNT_INPUT_OUTCOMES runtimeHeight={} entityHeight={} finalizedJHeight={} accountsRoot={} inputs={} results={} pairingMismatch={} ack={} ackFrameWithAck={} ackFrameWithoutAck={} inputOther={} ackCommitted={} ackAccepted={} ackRejected={} frameCommitted={} frameDuplicate={} frameCollision={} frameStale={} frameRejected={} forceAckTrue={} forceAckFalse={} forceAckNone={} outcomeOther={}",
        runtime_height,
        entity_height,
        finalized_j_height,
        render_word(&accounts_root),
        inputs.len(),
        results.len(),
        inputs.len().abs_diff(results.len()),
        profile.ack,
        profile.ack_frame_with_ack,
        profile.ack_frame_without_ack,
        profile.input_other,
        profile.ack_committed,
        profile.ack_accepted,
        profile.ack_rejected,
        profile.frame_committed,
        profile.frame_duplicate,
        profile.frame_collision,
        profile.frame_stale,
        profile.frame_rejected,
        profile.force_ack_true,
        profile.force_ack_false,
        profile.force_ack_none,
        profile.outcome_other,
    );
}

/// Exact `getLocalJPrefixAttestableHeight`/`getValidatorJContiguousThroughHeight`
/// port (`core/jurisdiction/machine/history/j-prefix-consensus.ts`,
/// `core/jurisdiction/machine/local-history/index.ts`). Reads the
/// validator-local watcher scan (`jHistory`, an opaque restored
/// replica-envelope field, tagged `Map`s as `{ value: [[key, value], ...] }`)
/// and returns the single highest height this validator can honestly attest
/// this round, or `None` when TS would defer (sparse gap / no certified
/// anchor yet). The native base-claim J-prefix path only ever signs exactly
/// `base_height`; any other outcome — a higher contiguous height already
/// available, a sparse pending event, missing jHistory, or a local scan that
/// has fallen behind the finalized anchor — must fail loudly rather than
/// silently certify a stale (or incomplete) prefix.
fn local_j_prefix_attestable_height(
    replica_metadata: &serde_json::Value,
    base_height: u64,
    has_j_history_finality: bool,
) -> Result<Option<u64>, String> {
    let Some(history) = replica_metadata.get("jHistory") else {
        return Ok(None);
    };
    let require_u64 = |field: &str| -> Result<u64, String> {
        history
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| field.to_string())
    };
    let tagged_map_heights = |field: &str| -> Result<Vec<u64>, String> {
        let entries = history
            .get(field)
            .and_then(|value| value.get("value"))
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| field.to_string())?;
        entries
            .iter()
            .map(|entry| {
                entry
                    .get(0)
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| format!("{field}_KEY"))
            })
            .collect()
    };

    let scanned_through_height = require_u64("scannedThroughHeight")?;
    if scanned_through_height < base_height {
        return Err(format!(
            "J_HISTORY_LOCAL_BEHIND_FINALIZED_ANCHOR:{scanned_through_height}:{base_height}"
        ));
    }
    let contiguous_through_height_field = require_u64("contiguousThroughHeight")?;
    let header_heights: std::collections::BTreeSet<u64> =
        tagged_map_heights("blockHashes")?.into_iter().collect();
    let mut contiguous_through_height = base_height.max(contiguous_through_height_field);
    while contiguous_through_height < scanned_through_height {
        let next_height = contiguous_through_height
            .checked_add(1)
            .ok_or_else(|| "CONTIGUOUS_THROUGH_HEIGHT_OVERFLOW".to_string())?;
        if !header_heights.contains(&next_height) {
            break;
        }
        contiguous_through_height = next_height;
    }
    if contiguous_through_height > base_height {
        return Ok(Some(contiguous_through_height));
    }

    let event_block_heights = tagged_map_heights("eventBlocks")?;
    let has_sparse_pending_event = event_block_heights
        .iter()
        .any(|height| *height > base_height && *height <= scanned_through_height);
    if has_sparse_pending_event || !has_j_history_finality {
        return Ok(None);
    }
    Ok(Some(base_height))
}

fn command_board(slot: &EntityApplySlot) -> Result<EntityCommandBoard, RuntimeMachineError> {
    command_board_for_replica(&slot.replica, slot.state.certified_board_authority())
}

fn command_board_for_replica(
    replica: &RuntimeEntityReplica,
    certified_boards: crate::CertifiedBoardAuthorityView<'_>,
) -> Result<EntityCommandBoard, RuntimeMachineError> {
    let authority = replica
        .entity_consensus
        .state
        .authority
        .validate_and_normalize()
        .map_err(|error| RuntimeMachineError::EntityCommandContext(error.to_string()))?;
    let signer = replica
        .entity_signer
        .signer_address()
        .map(|value| render_bytes(&value))
        .ok_or_else(|| {
            RuntimeMachineError::EntityCommandContext(
                "ENTITY_COMMAND_BOARD_SIGNER_UNAVAILABLE".into(),
            )
        })?;
    let board_hash = current_entity_command_board_hash(&authority, &signer)?;
    let board_bytes = parse_hex32(&board_hash).ok_or_else(|| {
        RuntimeMachineError::EntityCommandContext("ENTITY_COMMAND_BOARD_HASH_INVALID".into())
    })?;
    let stack_key = authority
        .config
        .jurisdiction
        .as_ref()
        .map(jurisdiction_stack_key)
        .transpose()?
        .unwrap_or_else(|| UNREGISTERED_ENTITY_COMMAND_STACK_KEY.to_string());
    let board_epoch = if replica.entity_id == board_bytes {
        0
    } else {
        let record = certified_boards
            .entity_command_board(&replica.entity_id)
            .ok_or_else(|| {
                RuntimeMachineError::EntityCommandContext(format!(
                    "ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED:{}",
                    render_word(&replica.entity_id)
                ))
            })?;
        if record.board_hash != board_bytes {
            return Err(RuntimeMachineError::EntityCommandContext(format!(
                "ENTITY_COMMAND_CERTIFIED_BOARD_CONFIG_MISMATCH:{}:{}",
                render_word(&record.board_hash),
                board_hash
            )));
        }
        record.board_epoch
    };
    let signer_id = replica.entity_signer.signer_id().to_string();
    if !authority.config.validators.contains(&signer_id) {
        return Err(RuntimeMachineError::EntityCommandContext(format!(
            "ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD:{signer_id}"
        )));
    }
    Ok(EntityCommandBoard {
        board_hash,
        board_epoch,
        stack_key,
        signer,
        signer_id,
    })
}

fn jurisdiction_field<'a>(
    value: &'a xln_rscore_protocol::CanonicalValue,
    name: &str,
) -> Result<&'a xln_rscore_protocol::CanonicalValue, RuntimeMachineError> {
    let xln_rscore_protocol::CanonicalValue::Object(fields) = value else {
        return Err(RuntimeMachineError::EntityCommandContext(
            "ENTITY_COMMAND_JURISDICTION_INVALID".into(),
        ));
    };
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| {
            RuntimeMachineError::EntityCommandContext(format!(
                "ENTITY_COMMAND_JURISDICTION_FIELD_REQUIRED:{name}"
            ))
        })
}

fn jurisdiction_stack_key(
    value: &xln_rscore_protocol::CanonicalValue,
) -> Result<String, RuntimeMachineError> {
    let chain_id = match jurisdiction_field(value, "chainId")? {
        xln_rscore_protocol::CanonicalValue::Number(value) => value.as_str().parse::<u64>().ok(),
        _ => None,
    }
    .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
    .ok_or_else(|| {
        RuntimeMachineError::EntityCommandContext("ENTITY_COMMAND_STACK_CHAIN_INVALID".into())
    })?;
    let address = |name| match jurisdiction_field(value, name)? {
        xln_rscore_protocol::CanonicalValue::String(value) => parse_hex20(value).ok_or_else(|| {
            RuntimeMachineError::EntityCommandContext(format!(
                "ENTITY_COMMAND_STACK_ADDRESS_INVALID:{name}"
            ))
        }),
        _ => Err(RuntimeMachineError::EntityCommandContext(format!(
            "ENTITY_COMMAND_STACK_ADDRESS_INVALID:{name}"
        ))),
    };
    let mut encoded = [0_u8; 128];
    encoded[..32].copy_from_slice(&Keccak256::digest(b"xln.certified-board.stack.v1"));
    encoded[56..64].copy_from_slice(&chain_id.to_be_bytes());
    encoded[76..96].copy_from_slice(&address("depositoryAddress")?);
    encoded[108..128].copy_from_slice(&address("entityProviderAddress")?);
    Ok(render_word(&Keccak256::digest(encoded).into()))
}

fn parse_hex32(value: &str) -> Option<[u8; 32]> {
    let payload = value.strip_prefix("0x").filter(|value| value.len() == 64)?;
    let mut output = [0_u8; 32];
    hex::decode_to_slice(payload, &mut output).ok()?;
    Some(output)
}

fn parse_hex20(value: &str) -> Option<[u8; 20]> {
    let payload = value.strip_prefix("0x").filter(|value| value.len() == 40)?;
    let mut output = [0_u8; 20];
    hex::decode_to_slice(payload, &mut output).ok()?;
    Some(output)
}

fn render_word(value: &[u8; 32]) -> String {
    render_bytes(value)
}

fn render_bytes(value: &[u8]) -> String {
    use std::fmt::Write as _;
    value.iter().fold(String::from("0x"), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn collect_account_commit_evidence(
    entity_id: [u8; 32],
    account_id: AccountId,
    verdict: &AccountInputVerdict,
    evidence: &mut Vec<AccountCommitEvidence>,
) {
    match verdict {
        AccountInputVerdict::AckCommitted {
            height,
            state_hash,
            committed_frame,
            ..
        } => evidence.push(AccountCommitEvidence {
            entity_id,
            account_id,
            source: AccountCommitSource::AckCommit,
            frame_height: *height,
            state_hash: *state_hash,
            account_state_root: committed_frame.frame.account_state_root,
        }),
        AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            committed_frame,
            ..
        } => evidence.push(AccountCommitEvidence {
            entity_id,
            account_id,
            source: AccountCommitSource::CounterpartyCommit,
            frame_height: *height,
            state_hash: *state_hash,
            account_state_root: committed_frame.frame.account_state_root,
        }),
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            // TypeScript commits a valid ACK before applying the bundled peer
            // frame. A rejected second half must never erase the first row.
            collect_account_commit_evidence(entity_id, account_id, ack, evidence);
            collect_account_commit_evidence(entity_id, account_id, frame, evidence);
        }
        _ => {}
    }
}

fn account_commit_evidence(
    entity_id: [u8; 32],
    applied: &[xln_rscore_batch::AccountInputResult],
) -> Vec<AccountCommitEvidence> {
    let mut evidence = Vec::new();
    for row in applied {
        collect_account_commit_evidence(entity_id, row.account_id, &row.verdict, &mut evidence);
    }
    evidence
}

fn validate_selected_context(
    replica: &RuntimeReplica,
    frame: &RuntimeFrameContext,
) -> Result<(), RuntimeMachineError> {
    if frame.timestamp < replica.state.timestamp {
        return Err(RuntimeMachineError::TimestampRegression {
            previous: replica.state.timestamp,
            next: frame.timestamp,
        });
    }
    if frame.finalized_j_height < replica.state.finalized_j_height {
        return Err(RuntimeMachineError::FinalizedJHeightRegression {
            previous: replica.state.finalized_j_height,
            next: frame.finalized_j_height,
        });
    }
    Ok(())
}

/// The finalized J height is committed by the selected Runtime transactions,
/// not supplied by the live service or replay driver. Deriving it here keeps
/// Account clocks identical when the same WAL input is replayed after restart.
fn derive_selected_finalized_j_height(previous: u64, runtime_txs: &[super::RuntimeTx]) -> u64 {
    runtime_txs.iter().fold(previous, |height, tx| match tx {
        super::RuntimeTx::ObserveJRange(observation) => {
            height.max(observation.scanned_through_height)
        }
        _ => height,
    })
}

fn internal_wake(
    state: &RuntimeEntityState,
    replica: &RuntimeEntityReplica,
    frame: &RuntimeFrameContext,
) -> Result<Option<RuntimeWake>, RuntimeMachineError> {
    let entity_mempool = !replica.entity_mempool.is_empty();
    let account_mempool = replica.accounts.has_proposable_accounts()?;
    let hub_rebalance_has_pending_work = state.entity.hub_rebalance_config.is_some()
        && (replica
            .accounts
            .selected_has_rebalance_work(state.accounts_root)?
            || state
                .entity
                .j_batch_state
                .as_ref()
                .is_some_and(|batch| batch.sent_batch.is_some()));
    let derived = derived_wake_jobs(state, replica, frame.timestamp)?;
    let scheduled = scheduled_wake_from_state(
        state,
        &replica.signer_id,
        frame,
        hub_rebalance_has_pending_work,
        derived,
    )?;
    if !entity_mempool && !account_mempool && scheduled.is_none() {
        return Ok(None);
    }
    Ok(Some(RuntimeWake {
        entity_mempool,
        account_mempool,
        scheduled,
    }))
}

/// TS `collectDerivedDeadlines`: per-payment deadlines come from committed
/// Account locks (`timelock`) and paybook secret-ack waits, not from hooks.
/// The jobs keep the historical hook ids so the wake wire is unchanged.
fn derived_wake_jobs(
    state: &RuntimeEntityState,
    replica: &RuntimeEntityReplica,
    now: u64,
) -> Result<Vec<ScheduledWakeJob>, RuntimeMachineError> {
    let (_, due_locks) = replica
        .accounts
        .selected_htlc_deadlines(state.accounts_root, now)?;
    let mut jobs = due_locks
        .into_iter()
        .map(|(_, lock_id, timelock)| ScheduledWakeJob {
            kind: ScheduledWakeJobKind::Hook,
            id: format!("htlc-timeout:{lock_id}"),
            due_at: timelock,
        })
        .collect::<Vec<_>>();
    let lock_deadlines = replica
        .accounts
        .selected_htlc_deadlines(
            state.accounts_root,
            now.saturating_add(xln_rscore_engine::HTLC_ENFORCEMENT_RESERVE_MS),
        )?
        .1
        .into_iter()
        .map(|(account, hashlock, timelock)| {
            (
                (format!("0x{}", hex::encode(account.as_bytes())), hashlock),
                timelock,
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    for (_, entry) in state.entity.paybook.entries.iter() {
        let (Some(deadline), Some(started_at)) =
            (entry.secret_ack_deadline_at, entry.secret_ack_started_at)
        else {
            continue;
        };
        let trigger_at = xln_rscore_entity_kernel::secret_ack_trigger_at(
            deadline,
            started_at,
            entry
                .inbound_entity
                .as_ref()
                .and_then(|counterparty| {
                    lock_deadlines.get(&(counterparty.clone(), entry.hashlock.clone()))
                })
                .copied(),
        );
        if entry.secret_ack_pending
            && entry.secret.is_some()
            && entry.inbound_entity.is_some()
            && deadline >= started_at
            && trigger_at <= now
        {
            jobs.push(ScheduledWakeJob {
                kind: ScheduledWakeJobKind::Hook,
                id: format!("htlc-secret-ack:{}", entry.hashlock),
                due_at: trigger_at,
            });
        }
    }
    // Committed lending state carries `due_at`, so an overdue loan derives its
    // settlement deadline exactly like an Account timelock. TS
    // `collectDerivedDeadlines` emits the same `lending-overdue:<loanId>` id.
    if let Some(lending) = state.entity.lending.as_ref() {
        for loan in lending.loans() {
            if loan.status == xln_rscore_entity_kernel::LendingLoanStatus::Active
                && loan.due_at <= now
            {
                jobs.push(ScheduledWakeJob {
                    kind: ScheduledWakeJobKind::Hook,
                    id: format!("lending-overdue:{}", loan.loan_id),
                    due_at: loan.due_at,
                });
            }
        }
    }
    Ok(jobs)
}

fn scheduled_wake_from_state(
    state: &RuntimeEntityState,
    signer_id: &str,
    frame: &RuntimeFrameContext,
    hub_rebalance_has_pending_work: bool,
    derived: Vec<ScheduledWakeJob>,
) -> Result<Option<ScheduledWake>, RuntimeMachineError> {
    let mut jobs = match &state.entity.crontab {
        Some(crontab) => collect_due_scheduled_wake_jobs(
            crontab,
            frame.timestamp,
            hub_rebalance_has_pending_work,
        )?,
        None => Vec::new(),
    };
    jobs.extend(derived);
    jobs.sort();
    let scheduled = jobs
        .first()
        .map(|first| first.due_at)
        .map(|due_at| ScheduledWake {
            version: 1,
            proposer_signer_id: signer_id.to_string(),
            due_at,
            jobs: jobs
                .into_iter()
                .take(MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS)
                .collect(),
        });
    Ok(scheduled)
}

enum PreparedFrameTx<'a> {
    Borrowed(&'a CanonicalEntityTx),
    Owned(CanonicalEntityTx),
}

impl PreparedFrameTx<'_> {
    fn as_ref(&self) -> &CanonicalEntityTx {
        match self {
            Self::Borrowed(tx) => tx,
            Self::Owned(tx) => tx,
        }
    }
}

struct PreparedEntityPrefix<'a> {
    txs: Vec<PreparedFrameTx<'a>>,
    rows: Vec<&'a xln_rscore_batch::AccountInputRow>,
    local_financial_txs: Vec<&'a xln_rscore_entity_kernel::LocalEntityFinancialTx>,
    originated_j_heights: BTreeMap<String, u64>,
    /// Pending work items this prefix consumed. Differs from `txs.len()` when a
    /// stale (Retry/Cancel) EntityCommand is evicted without entering the frame.
    consumed: usize,
}

fn prepare_entity_prefix<'a>(
    slot: &EntityApplySlot,
    work: impl Iterator<Item = &'a EntityPendingWork>,
    max_tx_bytes: Option<usize>,
) -> Result<PreparedEntityPrefix<'a>, RuntimeMachineError> {
    let mut board = None;
    let mut command_nonces = slot.state.entity.entity_command_nonces.clone();
    let mut txs = Vec::new();
    let mut rows = Vec::new();
    let mut local_financial_txs = Vec::new();
    let mut originated_j_heights = BTreeMap::new();
    let mut origin_j_height = slot.state.entity.last_finalized_j_height;
    let mut tx_bytes = 0_usize;
    let mut consumed = 0_usize;
    for work in work {
        let local_start = local_financial_txs.len();
        // TS `selectEntityFrameTxByteBudgetWithMeter`: the frame prefix is cut by
        // count before bytes, deterministically, ahead of any apply.
        if txs.len() >= MAX_ENTITY_FRAME_TXS {
            break;
        }
        match work {
            EntityPendingWork::LocalOpenAccount(_) => {
                return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                    "UNMATERIALIZED_OPEN_ACCOUNT",
                ));
            }
            EntityPendingWork::Account { projected, row, .. } => {
                if !accept_entity_tx_bytes(&mut tx_bytes, projected, max_tx_bytes)? {
                    break;
                }
                txs.push(PreparedFrameTx::Borrowed(projected));
                rows.push(row.as_ref());
            }
            EntityPendingWork::LocalBatch { projected, native } => {
                if board.is_none() {
                    let value = command_board(slot)?;
                    normalize_entity_command_nonce_board(&mut command_nonces, &value)?;
                    board = Some(value);
                }
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (command, command_projection) = build_locally_authored_entity_command(
                    &slot.replica.entity_signer,
                    board,
                    command_nonces.as_ref(),
                    &render_word(&slot.replica.entity_id),
                    projected,
                )?;
                if !accept_entity_tx_bytes(&mut tx_bytes, &command_projection, max_tx_bytes)? {
                    break;
                }
                txs.push(PreparedFrameTx::Owned(command_projection));
                local_financial_txs.extend(native.iter().filter_map(|tx| match tx {
                    xln_rscore_entity_kernel::LocalEntityTx::Financial(tx) => Some(tx),
                    xln_rscore_entity_kernel::LocalEntityTx::Control(_)
                    | xln_rscore_entity_kernel::LocalEntityTx::CrossJurisdiction(_)
                    | xln_rscore_entity_kernel::LocalEntityTx::RuntimeOutput(_) => None,
                }));
                advance_entity_command_nonce(&mut command_nonces, board, &command)?;
            }
            EntityPendingWork::Command { projected, command } => {
                if board.is_none() {
                    let value = command_board(slot)?;
                    normalize_entity_command_nonce_board(&mut command_nonces, &value)?;
                    board = Some(value);
                }
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (_, disposition) = assert_signed_entity_command(
                    &slot.state.entity.entity_id,
                    &slot.replica.entity_consensus.state.authority,
                    &board.signer,
                    board.board_epoch,
                    &board.stack_key,
                    command_nonces.as_ref(),
                    command,
                )?;
                // Parity target: TS `mergeEntityCommandTransactions` skips an
                // exact retry or a cancelled slot before the frame exists. The
                // stale command is consumed (evicted) but never certified.
                if disposition != EntityCommandDisposition::Next {
                    consumed += 1;
                    continue;
                }
                if !accept_entity_tx_bytes(&mut tx_bytes, projected, max_tx_bytes)? {
                    break;
                }
                local_financial_txs.extend(command.native_txs.iter().filter_map(|tx| match tx {
                    xln_rscore_entity_kernel::LocalEntityTx::Financial(tx) => Some(tx),
                    xln_rscore_entity_kernel::LocalEntityTx::Control(_)
                    | xln_rscore_entity_kernel::LocalEntityTx::CrossJurisdiction(_)
                    | xln_rscore_entity_kernel::LocalEntityTx::RuntimeOutput(_) => None,
                }));
                txs.push(PreparedFrameTx::Borrowed(projected));
                advance_entity_command_nonce(&mut command_nonces, board, command)?;
            }
            EntityPendingWork::ProposerMaterialized { projected, .. } => {
                if !accept_entity_tx_bytes(&mut tx_bytes, projected, max_tx_bytes)? {
                    break;
                }
                txs.push(PreparedFrameTx::Borrowed(projected));
            }
            EntityPendingWork::Projected(projected) => {
                if !accept_entity_tx_bytes(&mut tx_bytes, projected, max_tx_bytes)? {
                    break;
                }
                txs.push(PreparedFrameTx::Borrowed(projected));
            }
        }
        // A payment uses its Entity's local cursor, advanced only by a J
        // event preceding it in this exact selected prefix. Another J and a
        // later event must never shorten its reveal window.
        if let Some(tx) = txs.last().map(PreparedFrameTx::as_ref)
            && tx.kind == EntityTxKind::JEvent
        {
            let data = crate::tagged_json_from_canonical_value(&tx.wire_data).map_err(|error| {
                RuntimeMachineError::EntityContextMaterialization(error.to_string())
            })?;
            origin_j_height = data
                .get("scannedThroughHeight")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    RuntimeMachineError::EntityContextMaterialization(
                        "ENTITY_ORIGIN_J_HEIGHT_INVALID".into(),
                    )
                })?;
        }
        for tx in &local_financial_txs[local_start..] {
            if let xln_rscore_entity_kernel::LocalEntityFinancialTx::HtlcPayment(payment) = tx {
                originated_j_heights.insert(payment.tx_hash.clone(), origin_j_height);
            }
        }
        consumed += 1;
    }
    Ok(PreparedEntityPrefix {
        txs,
        rows,
        local_financial_txs,
        originated_j_heights,
        consumed,
    })
}

fn accept_entity_tx_bytes(
    total: &mut usize,
    tx: &CanonicalEntityTx,
    limit: Option<usize>,
) -> Result<bool, RuntimeMachineError> {
    let bytes = measure_entity_frame_tx_bytes(tx)
        .map_err(EntityTransitionError::from)
        .map_err(RuntimeMachineError::from)?;
    let next = total
        .checked_add(bytes)
        .ok_or(RuntimeMachineError::InputCountOverflow)?;
    if let Some(limit) = limit
        && next > limit
    {
        if *total == 0 {
            return Err(RuntimeMachineError::HeadWireUnfittable {
                actual: bytes,
                limit,
            });
        }
        return Ok(false);
    }
    *total = next;
    Ok(true)
}

fn materialize_local_open_accounts(
    pending: &mut [EntityPendingWork],
    slot: &EntityApplySlot,
    runtime_seed: &str,
    runtime_id: &str,
) -> Result<(), RuntimeMachineError> {
    for work in pending {
        let EntityPendingWork::LocalOpenAccount(tx) = work else {
            continue;
        };
        let jurisdiction = slot
            .replica
            .entity_consensus
            .state
            .authority
            .config
            .jurisdiction
            .as_ref()
            .ok_or_else(|| j_range_error("OPEN_ACCOUNT_JURISDICTION"))?;
        let jurisdiction = crate::tagged_json_from_canonical_value(jurisdiction)
            .map_err(|error| j_range_error(error.to_string()))?;
        let domain = serde_json::json!({"chainId":jurisdiction["chainId"],
            "depositoryAddress":jurisdiction["depositoryAddress"]});
        let data = crate::tagged_json_from_canonical_value(&tx.wire_data)
            .map_err(|error| j_range_error(error.to_string()))?;
        let mut wire = serde_json::json!({"type":"openAccount","data":data});
        let data = wire["data"]
            .as_object_mut()
            .ok_or_else(|| j_range_error("OPEN_ACCOUNT_DATA"))?;
        if data
            .get("accountDomain")
            .is_some_and(|value| value != &domain)
        {
            return Err(j_range_error("OPEN_ACCOUNT_DOMAIN_MISMATCH"));
        }
        data.insert("accountDomain".into(), domain);
        if !data.contains_key("watchSeed") {
            if runtime_seed.is_empty() {
                return Err(j_range_error("OPEN_ACCOUNT_RUNTIME_SEED"));
            }
            let target = data
                .get("targetEntityId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| j_range_error("OPEN_ACCOUNT_TARGET"))?
                .trim()
                .to_ascii_lowercase();
            let preimage = format!(
                "xln:account-watch-seed:v1|{}|{}|{}|{}",
                runtime_seed,
                runtime_id.to_ascii_lowercase(),
                slot.state.entity.entity_id.to_ascii_lowercase(),
                target
            );
            let hash: [u8; 32] = Keccak256::digest(preimage.as_bytes()).into();
            data.insert("watchSeed".into(), serde_json::json!(render_word(&hash)));
        }
        let projected = crate::entity_frame::project_entity_tx(&wire)?;
        let native = decode_local_entity_tx(&projected)
            .map_err(RuntimeMachineError::EntityFinancial)?
            .ok_or(RuntimeMachineError::EntityTxExecutionUnsupported(
                "openAccount",
            ))?;
        *work = EntityPendingWork::LocalBatch {
            projected: vec![projected],
            native: vec![native],
        };
    }
    Ok(())
}

fn enqueue_proposer_materializations(
    slot: &mut EntityApplySlot,
    runtime_seed: &str,
    runtime_timestamp: u64,
    append_to_fresh_individual_run: bool,
) -> Result<MaterializationAdmission, RuntimeMachineError> {
    let admission = materialization_admission(&slot.replica.entity_mempool)?;
    let mut merged =
        BTreeMap::<String, xln_rscore_entity_kernel::CrossJurisdictionAccountViewRequest>::new();
    for request in proposer_materialization_account_view_requests(&slot.state.entity)
        .map_err(RuntimeMachineError::EntityFinancial)?
    {
        let merged_request = merged.entry(request.account_id.clone()).or_insert_with(|| {
            xln_rscore_entity_kernel::CrossJurisdictionAccountViewRequest {
                account_id: request.account_id.clone(),
                ..Default::default()
            }
        });
        merged_request.pull_ids.extend(request.pull_ids);
        merged_request.swap_offer_ids.extend(request.swap_offer_ids);
        merged_request.dispute |= request.dispute;
    }
    let requests = merged
        .into_values()
        .map(|mut request| {
            request.pull_ids.sort();
            request.pull_ids.dedup();
            request.swap_offer_ids.sort();
            request.swap_offer_ids.dedup();
            let account_id = parse_hex32(&request.account_id).ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(format!(
                    "PROPOSER_MATERIALIZATION_ACCOUNT_ID_INVALID:{}",
                    request.account_id
                ))
            })?;
            Ok((
                AccountId::from_bytes(account_id),
                ResidentAccountFinancialViewRequest {
                    pull_ids: request.pull_ids,
                    swap_offer_ids: request.swap_offer_ids,
                    dispute: request.dispute,
                    ..Default::default()
                },
            ))
        })
        .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
    let account_views = if requests.is_empty() {
        BTreeMap::<String, ResidentCrossJMaterializationView>::new()
    } else {
        slot.replica
            .accounts
            .cross_j_materialization_views(requests)?
            .into_iter()
            .map(|(account_id, view)| (render_word(account_id.as_bytes()), view))
            .collect::<BTreeMap<_, _>>()
    };
    let additions = build_proposer_materializations(
        &slot.state.entity,
        runtime_seed,
        runtime_timestamp,
        &slot.replica.signer_id,
        &slot.replica.entity_consensus.state.authority,
        &account_views,
        &admission.pending_keys,
        admission.commit_phase,
    )
    .map_err(RuntimeMachineError::EntityFinancial)?;
    let mut native_additions = Vec::with_capacity(additions.len());
    for projected in &additions {
        let Some(native) =
            decode_local_entity_tx(projected).map_err(RuntimeMachineError::EntityFinancial)?
        else {
            return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                projected.kind.as_str(),
            ));
        };
        if !matches!(native, LocalEntityTx::CrossJurisdiction(_)) {
            return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                projected.kind.as_str(),
            ));
        }
        native_additions.push(native);
    }
    if !additions.is_empty() {
        // TS prepares one locally authored individual command run. These
        // materializations require the proposer's signature and next command
        // nonce; only already-authenticated Runtime outputs are bare protocol.
        if append_to_fresh_individual_run {
            let Some(EntityPendingWork::LocalBatch { projected, native }) =
                slot.replica.entity_mempool.back_mut()
            else {
                return Err(RuntimeMachineError::EntityCommandContext(
                    "FRESH_INDIVIDUAL_COMMAND_RUN_MISSING".into(),
                ));
            };
            projected.extend(additions);
            native.extend(native_additions);
        } else {
            slot.replica
                .entity_mempool
                .push_back(EntityPendingWork::LocalBatch {
                    projected: additions,
                    native: native_additions,
                });
        }
    }
    Ok(admission)
}

fn measure_prepared_entity_prefix(
    slot: &EntityApplySlot,
    frame: &RuntimeFrameContext,
    prepared: &PreparedEntityPrefix<'_>,
    entity_context_bytes: &[u8],
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<xln_rscore_entity_kernel::EntityFrameWireMeasure, RuntimeMachineError> {
    const DUMMY_ROOT: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
    let parent_frame_hash = slot
        .replica
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .map_or("genesis", |head| head.frame.hash.as_str());
    let txs = prepared
        .txs
        .iter()
        .map(PreparedFrameTx::as_ref)
        .collect::<Vec<_>>();
    measure_entity_frame_wire(&EntityFrameWireMeasureBody {
        parent_frame_hash,
        height: slot
            .state
            .entity
            .height
            .checked_add(1)
            .ok_or(RuntimeMachineError::EntityHeightOverflow)?,
        timestamp: frame.timestamp,
        txs: &txs,
        events: &[] as &[EntityFrameEvent],
        entity_id: &slot.state.entity.entity_id,
        state_root: DUMMY_ROOT,
        authority_root: DUMMY_ROOT,
        entity_context_bytes,
        j_prefix_certificate,
    })
    .map_err(EntityTransitionError::from)
    .map_err(RuntimeMachineError::from)
}

fn canonical_field<'a>(value: &'a CanonicalValue, field: &str) -> Option<&'a CanonicalValue> {
    match value {
        CanonicalValue::Object(fields) => fields
            .iter()
            .find_map(|(key, value)| (key == field).then_some(value)),
        _ => None,
    }
}

fn canonical_array<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a [CanonicalValue], RuntimeMachineError> {
    match value {
        CanonicalValue::Array(values) => Ok(values),
        _ => Err(RuntimeMachineError::EntityContextMaterialization(format!(
            "ENTITY_REPLAY_ARRAY_REQUIRED:{path}"
        ))),
    }
}

fn canonical_text<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a str, RuntimeMachineError> {
    match value {
        CanonicalValue::String(value) => Ok(value),
        _ => Err(RuntimeMachineError::EntityContextMaterialization(format!(
            "ENTITY_REPLAY_STRING_REQUIRED:{path}"
        ))),
    }
}

fn persisted_htlc_keys(
    context: &CanonicalValue,
) -> Result<std::collections::BTreeSet<String>, RuntimeMachineError> {
    let Some(htlc) = canonical_field(context, "htlc") else {
        return Ok(std::collections::BTreeSet::new());
    };
    let entries = canonical_array(
        canonical_field(htlc, "entries").ok_or_else(|| {
            RuntimeMachineError::EntityContextMaterialization(
                "ENTITY_REPLAY_CONTEXT_HTLC_ENTRIES_MISSING".into(),
            )
        })?,
        "context.htlc.entries",
    )?;
    let mut keys = std::collections::BTreeSet::new();
    for entry in entries {
        let binding = canonical_field(entry, "binding").ok_or_else(|| {
            RuntimeMachineError::EntityContextMaterialization(
                "ENTITY_REPLAY_CONTEXT_HTLC_BINDING_MISSING".into(),
            )
        })?;
        let frame = canonical_text(
            canonical_field(binding, "accountFrameHash").ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(
                    "ENTITY_REPLAY_CONTEXT_HTLC_FRAME_MISSING".into(),
                )
            })?,
            "context.htlc.binding.accountFrameHash",
        )?
        .to_lowercase();
        let lock = canonical_text(
            canonical_field(binding, "hashlock").ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(
                    "ENTITY_REPLAY_CONTEXT_HTLC_HASHLOCK_MISSING".into(),
                )
            })?,
            "context.htlc.binding.hashlock",
        )?
        .to_lowercase();
        if !keys.insert(format!("{frame}:{lock}")) {
            return Err(RuntimeMachineError::EntityContextMaterialization(format!(
                "ENTITY_REPLAY_CONTEXT_HTLC_DUPLICATE:{frame}:{lock}"
            )));
        }
    }
    Ok(keys)
}

fn pending_work_kind(work: &EntityPendingWork) -> &'static str {
    match work {
        EntityPendingWork::Account { .. } => "account",
        EntityPendingWork::LocalBatch { .. } => "local-batch",
        EntityPendingWork::LocalOpenAccount(_) => "local-open-account",
        EntityPendingWork::Command { .. } => "command",
        EntityPendingWork::ProposerMaterialized { .. } => "proposer-materialized",
        EntityPendingWork::Projected(_) => "projected",
    }
}

fn pending_htlc_keys(
    work: &EntityPendingWork,
) -> Result<std::collections::BTreeSet<String>, RuntimeMachineError> {
    Ok(pending_htlc_key_pairs(work)?
        .into_iter()
        .map(|(frame, hashlock)| format!("{frame}:{hashlock}"))
        .collect())
}

fn pending_htlc_key_pairs(
    work: &EntityPendingWork,
) -> Result<std::collections::BTreeSet<(String, String)>, RuntimeMachineError> {
    let EntityPendingWork::Account { projected, .. } = work else {
        return Ok(std::collections::BTreeSet::new());
    };
    let Some(proposal) = canonical_field(&projected.wire_data, "proposal") else {
        return Ok(std::collections::BTreeSet::new());
    };
    let frame = canonical_field(proposal, "frame").ok_or_else(|| {
        RuntimeMachineError::EntityContextMaterialization(
            "ENTITY_REPLAY_ACCOUNT_PROPOSAL_FRAME_MISSING".into(),
        )
    })?;
    let frame_hash = canonical_text(
        canonical_field(frame, "stateHash").ok_or_else(|| {
            RuntimeMachineError::EntityContextMaterialization(
                "ENTITY_REPLAY_ACCOUNT_FRAME_HASH_MISSING".into(),
            )
        })?,
        "accountFrame.stateHash",
    )?
    .to_lowercase();
    let txs = canonical_array(
        canonical_field(frame, "accountTxs").ok_or_else(|| {
            RuntimeMachineError::EntityContextMaterialization(
                "ENTITY_REPLAY_ACCOUNT_TXS_MISSING".into(),
            )
        })?,
        "accountFrame.accountTxs",
    )?;
    let mut keys = std::collections::BTreeSet::new();
    for tx in txs {
        if canonical_field(tx, "type").and_then(|value| match value {
            CanonicalValue::String(value) => Some(value.as_str()),
            _ => None,
        }) != Some("htlc_lock")
        {
            continue;
        }
        let data = canonical_field(tx, "data").ok_or_else(|| {
            RuntimeMachineError::EntityContextMaterialization(
                "ENTITY_REPLAY_ACCOUNT_TX_DATA_MISSING".into(),
            )
        })?;
        if canonical_field(data, "envelope").is_none() {
            continue;
        }
        let hashlock = canonical_text(
            canonical_field(data, "hashlock").ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(
                    "ENTITY_REPLAY_ACCOUNT_HASHLOCK_MISSING".into(),
                )
            })?,
            "accountFrame.accountTx.hashlock",
        )?
        .to_lowercase();
        keys.insert((frame_hash.clone(), hashlock));
    }
    Ok(keys)
}

fn replay_compatible_prefix(
    work: &std::collections::VecDeque<EntityPendingWork>,
    context: &CanonicalValue,
) -> Result<(usize, usize), RuntimeMachineError> {
    let expected = persisted_htlc_keys(context)?;
    let mut observed = std::collections::BTreeSet::new();
    let mut compatible = 0_usize;
    let mut complete = expected.is_empty().then_some(0_usize);
    let mut stop = None;
    for (index, work) in work.iter().enumerate() {
        let keys = pending_htlc_keys(work)?;
        if let Some(unknown) = keys.iter().find(|key| !expected.contains(*key)) {
            stop = Some(format!(
                "index={index}:kind={}:key={unknown}",
                pending_work_kind(work)
            ));
            break;
        }
        observed.extend(keys);
        compatible = index + 1;
        if complete.is_none() && observed.len() == expected.len() {
            complete = Some(compatible);
        }
    }
    let complete = complete.ok_or_else(|| {
        RuntimeMachineError::EntityContextMaterialization(format!(
            "ENTITY_REPLAY_HTLC_PREFIX_MISSING:{}:{}:queue={}:{}",
            expected.len(),
            observed.len(),
            work.len(),
            stop.unwrap_or_else(|| "exhausted".into())
        ))
    })?;
    if observed != expected {
        return Err(RuntimeMachineError::EntityContextMaterialization(format!(
            "ENTITY_REPLAY_HTLC_PREFIX_MISMATCH:{}:{}",
            expected.len(),
            observed.len()
        )));
    }
    Ok((compatible, complete))
}

fn fit_replay_entity_prefix(
    slot: &EntityApplySlot,
    work: &std::collections::VecDeque<EntityPendingWork>,
    frame: &RuntimeFrameContext,
    entity_context: &CanonicalValue,
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<(usize, Vec<u8>), RuntimeMachineError> {
    let (compatible, required) = replay_compatible_prefix(work, entity_context)?;
    let mut candidate = compatible.min(MAX_ENTITY_FRAME_TXS);
    let entity_context_bytes = encode_entity_frame_context(entity_context)
        .map_err(EntityTransitionError::from)
        .map_err(RuntimeMachineError::from)?;
    if work.is_empty() {
        return Ok((0, entity_context_bytes));
    }
    if candidate == 0 {
        return Err(RuntimeMachineError::HeadWireUnfittable {
            actual: 1,
            limit: MAX_ENTITY_PROPOSAL_WIRE_BYTES,
        });
    }
    for _ in 0..16 {
        let prepared = prepare_entity_prefix(slot, work.iter().take(candidate), None)?;
        let measured = measure_prepared_entity_prefix(
            slot,
            frame,
            &prepared,
            &entity_context_bytes,
            j_prefix_certificate,
        )?;
        if measured.total_bytes <= MAX_ENTITY_PROPOSAL_WIRE_BYTES
            && measured.tx_bytes <= MAX_ENTITY_FRAME_TX_BYTES
        {
            if candidate < required {
                return Err(RuntimeMachineError::HeadWireUnfittable {
                    actual: candidate,
                    limit: required,
                });
            }
            return Ok((candidate, entity_context_bytes));
        }
        let ratio = (MAX_ENTITY_PROPOSAL_WIRE_BYTES as f64 / measured.total_bytes as f64)
            .min(MAX_ENTITY_FRAME_TX_BYTES as f64 / measured.tx_bytes.max(1) as f64);
        let scaled = (candidate as f64 * 0.9 * ratio).floor() as usize;
        let next = candidate.saturating_sub(1).min(scaled);
        if next < required.max(1) {
            return Err(RuntimeMachineError::HeadWireUnfittable {
                actual: measured.total_bytes.max(measured.tx_bytes),
                limit: MAX_ENTITY_PROPOSAL_WIRE_BYTES,
            });
        }
        candidate = next;
    }
    Err(RuntimeMachineError::EntityContextMaterialization(
        "ENTITY_REPLAY_WIRE_BUDGET_FIT_EXHAUSTED".into(),
    ))
}

fn fit_live_entity_prefix(
    slot: &mut EntityApplySlot,
    work: &std::collections::VecDeque<EntityPendingWork>,
    frame: &RuntimeFrameContext,
    materializer: &mut dyn EntityInfraMaterializer,
    j_prefix_certificate: Option<&CanonicalValue>,
    entity_encryption_seed: Option<&str>,
) -> Result<(usize, MaterializedEntityInfraContext, Vec<u8>), RuntimeMachineError> {
    let fit_started = Instant::now();
    let prepare_started = Instant::now();
    let mut prepared = prepare_entity_prefix(slot, work.iter(), Some(MAX_ENTITY_FRAME_TX_BYTES))?;
    let mut prepare_elapsed = prepare_started.elapsed();
    let materialize_started = Instant::now();
    let mut materialized = materializer
        .materialize(EntityInfraMaterializeRequest {
            entity_encryption_seed,
            state: &slot.state,
            replica: &mut slot.replica,
            account_inputs: &prepared.rows,
            local_financial_txs: &prepared.local_financial_txs,
            originated_j_heights: &prepared.originated_j_heights,
            timestamp: frame.timestamp,
            finalized_j_height: frame.finalized_j_height,
        })
        .map_err(|error| RuntimeMachineError::EntityContextMaterialization(error.to_string()))?;
    let materialize_elapsed = materialize_started.elapsed();
    let mut measure_elapsed = std::time::Duration::ZERO;
    let mut attempts = 0_usize;
    let mut candidate = prepared.consumed;
    for _ in 0..16 {
        attempts += 1;
        let measure_started = Instant::now();
        let entity_context_bytes = encode_entity_frame_context(&materialized.canonical)
            .map_err(EntityTransitionError::from)
            .map_err(RuntimeMachineError::from)?;
        let measured = measure_prepared_entity_prefix(
            slot,
            frame,
            &prepared,
            &entity_context_bytes,
            j_prefix_certificate,
        )?;
        measure_elapsed = measure_elapsed.saturating_add(measure_started.elapsed());
        if measured.total_bytes <= MAX_ENTITY_PROPOSAL_WIRE_BYTES
            && measured.tx_bytes <= MAX_ENTITY_FRAME_TX_BYTES
        {
            if profile_runtime_apply() {
                let total = fit_started.elapsed();
                let accounted = prepare_elapsed
                    .saturating_add(materialize_elapsed)
                    .saturating_add(measure_elapsed);
                eprintln!(
                    "RSCORE_ENTITY_FIT_PHASE prepare={} context={} measure={} control={} total={} attempts={} txs={} rows={} txBytes={} totalBytes={}",
                    prepare_elapsed.as_micros(),
                    materialize_elapsed.as_micros(),
                    measure_elapsed.as_micros(),
                    total.saturating_sub(accounted).as_micros(),
                    total.as_micros(),
                    attempts,
                    candidate,
                    prepared.rows.len(),
                    measured.tx_bytes,
                    measured.total_bytes,
                );
            }
            return Ok((candidate, materialized, entity_context_bytes));
        }
        if candidate <= 1 {
            return Err(RuntimeMachineError::HeadWireUnfittable {
                actual: measured.total_bytes.max(measured.tx_bytes),
                limit: MAX_ENTITY_PROPOSAL_WIRE_BYTES,
            });
        }
        let ratio = (MAX_ENTITY_PROPOSAL_WIRE_BYTES as f64 / measured.total_bytes as f64)
            .min(MAX_ENTITY_FRAME_TX_BYTES as f64 / measured.tx_bytes.max(1) as f64);
        let scaled = (candidate as f64 * 0.9 * ratio).floor() as usize;
        candidate = candidate.saturating_sub(1).min(scaled).max(1);
        let prepare_started = Instant::now();
        prepared = prepare_entity_prefix(slot, work.iter().take(candidate), None)?;
        prepare_elapsed = prepare_elapsed.saturating_add(prepare_started.elapsed());
        let mut retained = std::collections::BTreeSet::new();
        for item in work.iter().take(candidate) {
            retained.extend(pending_htlc_key_pairs(item)?);
        }
        let originated = prepared
            .local_financial_txs
            .iter()
            .filter_map(|tx| match tx {
                xln_rscore_entity_kernel::LocalEntityFinancialTx::HtlcPayment(payment) => {
                    Some(payment.tx_hash.clone())
                }
                _ => None,
            })
            .collect();
        materialized
            .retain_inbound_htlc_keys(&retained, &originated)
            .map_err(|error| {
                RuntimeMachineError::EntityContextMaterialization(error.to_string())
            })?;
    }
    Err(RuntimeMachineError::EntityContextMaterialization(
        "ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED".into(),
    ))
}

struct SelectedEntityWork {
    /// `operations` position -> position of the work item that opened it.
    /// Only the FIRST work item of a merged `AccountRange` is recorded here, so
    /// this vector may only be used to evict a whole `Local` operation.
    operation_work_indices: Vec<usize>,
    /// `rows` position -> position of the work item that contributed it. Each
    /// `EntityPendingWork::Account` is exactly one row and exactly one parent
    /// `accountInput` Entity tx, so this is the map a rejected inbound Account
    /// input needs; `operation_work_indices` is too coarse for it.
    row_work_indices: Vec<usize>,
    txs: Vec<CanonicalEntityTx>,
    rows: Vec<xln_rscore_batch::AccountInputRow>,
    operations: Vec<ResidentEntityOperation>,
    command_nonces: Option<xln_rscore_entity_kernel::EntityCommandNonceState>,
}

fn take_entity_prefix(
    slot: &EntityApplySlot,
    work: &mut std::collections::VecDeque<EntityPendingWork>,
    count: usize,
) -> Result<SelectedEntityWork, RuntimeMachineError> {
    let has_commands = work.iter().take(count).any(|work| {
        matches!(
            work,
            EntityPendingWork::LocalBatch { .. } | EntityPendingWork::Command { .. }
        )
    });
    let board = has_commands.then(|| command_board(slot)).transpose()?;
    let mut command_nonces = slot.state.entity.entity_command_nonces.clone();
    if let Some(board) = board.as_ref() {
        normalize_entity_command_nonce_board(&mut command_nonces, board)?;
    }
    let mut selected = SelectedEntityWork {
        operation_work_indices: Vec::new(),
        row_work_indices: Vec::new(),
        txs: Vec::with_capacity(count),
        rows: Vec::new(),
        operations: Vec::new(),
        command_nonces,
    };
    for work_index in 0..count {
        let operations_before = selected.operations.len();
        let work = work
            .pop_front()
            .ok_or(RuntimeMachineError::InputCountOverflow)?;
        match work {
            EntityPendingWork::LocalOpenAccount(_) => {
                return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                    "UNMATERIALIZED_OPEN_ACCOUNT",
                ));
            }
            EntityPendingWork::Account { projected, row, .. } => {
                selected.txs.push(projected);
                let start = selected.rows.len();
                selected.rows.push(*row);
                selected.row_work_indices.push(work_index);
                match selected.operations.last_mut() {
                    Some(ResidentEntityOperation::AccountRange {
                        start: prior_start,
                        len,
                    }) if prior_start.saturating_add(*len) == start => *len += 1,
                    _ => selected
                        .operations
                        .push(ResidentEntityOperation::AccountRange { start, len: 1 }),
                }
            }
            EntityPendingWork::LocalBatch {
                projected,
                native: _,
            } => {
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (command, command_projection) = build_locally_authored_entity_command(
                    &slot.replica.entity_signer,
                    board,
                    selected.command_nonces.as_ref(),
                    &render_word(&slot.replica.entity_id),
                    &projected,
                )?;
                selected.txs.push(command_projection);
                advance_entity_command_nonce(&mut selected.command_nonces, board, &command)?;
                let signer_id = command.author_signer_id.clone();
                selected.operations.push(ResidentEntityOperation::Local(
                    command
                        .native_txs
                        .into_iter()
                        .map(|tx| xln_rscore_entity_kernel::AdmittedLocalEntityTx {
                            signer_id: signer_id.clone(),
                            board_epoch: command.board_epoch,
                            tx,
                        })
                        .collect(),
                ));
            }
            EntityPendingWork::Command { projected, command } => {
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (_, disposition) = assert_signed_entity_command(
                    &slot.state.entity.entity_id,
                    &slot.replica.entity_consensus.state.authority,
                    &board.signer,
                    board.board_epoch,
                    &board.stack_key,
                    selected.command_nonces.as_ref(),
                    &command,
                )?;
                advance_entity_command_nonce(&mut selected.command_nonces, board, &command)?;
                // Same rule as `prepare_entity_prefix`: a Retry/Cancel command
                // is evicted here and never enters the certified frame.
                if disposition != EntityCommandDisposition::Next {
                    continue;
                }
                let signer_id = command.author_signer_id.clone();
                selected.operations.push(ResidentEntityOperation::Local(
                    command
                        .native_txs
                        .into_iter()
                        .map(|tx| xln_rscore_entity_kernel::AdmittedLocalEntityTx {
                            signer_id: signer_id.clone(),
                            board_epoch: command.board_epoch,
                            tx,
                        })
                        .collect(),
                ));
                selected.txs.push(projected);
            }
            EntityPendingWork::ProposerMaterialized { projected, native } => {
                let board_epoch = command_board(slot)?.board_epoch;
                selected.txs.push(projected);
                selected
                    .operations
                    .push(ResidentEntityOperation::Local(vec![
                        xln_rscore_entity_kernel::AdmittedLocalEntityTx {
                            signer_id: slot.replica.signer_id.clone(),
                            board_epoch,
                            tx: *native,
                        },
                    ]));
            }
            EntityPendingWork::Projected(projected) => selected.txs.push(projected),
        }
        if selected.operations.len() > operations_before {
            selected.operation_work_indices.push(work_index);
        }
    }
    Ok(selected)
}

/// Apply at most one bounded Runtime frame.
///
/// The replica is consumed. Any error after Account mutation therefore leaves
/// no value that a caller can continue using; production must reload the last
/// durable checkpoint+WAL instead of guessing an inverse transition.
pub fn apply_runtime(
    replica: RuntimeReplica,
    input: RuntimeInput,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    apply_runtime_inner(replica, input, None, profile_runtime_apply())
}

/// Apply one live input after selecting its exact FIFO prefix and then
/// materializing the Entity context for that prefix. The caller never sees a
/// candidate or a commit/abort handle.
pub fn apply_runtime_live(
    replica: RuntimeReplica,
    input: RuntimeLiveInput,
    materializer: &mut dyn EntityInfraMaterializer,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    apply_runtime_inner(
        replica,
        input.into_selection_input(),
        Some(materializer),
        profile_runtime_apply(),
    )
}

#[cfg(test)]
pub(super) fn apply_runtime_with_profile_for_test(
    replica: RuntimeReplica,
    input: RuntimeInput,
    profile: bool,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    apply_runtime_inner(replica, input, None, profile)
}

struct PendingEntityGroup {
    entity_id: [u8; 32],
    signer_id: String,
    pending: Vec<EntityPendingWork>,
    input_positions: Vec<usize>,
    wake: Option<RuntimeWake>,
    recorded_scheduled_wake: bool,
    j_observation: Option<crate::j_watcher::ObserveJRange>,
    j_attestation_wire: Option<serde_json::Value>,
    /// Runtime-envelope metadata copied from an admitted atomic proposal pair
    /// onto the resulting ACK outputs. It never enters Entity consensus.
    atomic_output_pair: Option<super::types::RuntimeAtomicCrossJurisdictionPair>,
    cause: PendingEntityCause,
}

struct PendingEntitySegment {
    groups: Vec<PendingEntityGroup>,
    derived: bool,
    admission: SegmentAdmission,
}

enum SegmentAdmission {
    Inline,
    AtomicPair,
    Deferred(Vec<PendingEntityInputAdmission>),
    Prepared,
}

struct PendingEntityInputAdmission {
    key: RuntimeEntityKey,
    pending: Vec<EntityPendingWork>,
}

fn flush_deferred_entity_groups(
    segments: &mut Vec<PendingEntitySegment>,
    groups: &mut Vec<PendingEntityGroup>,
    admissions: &mut Vec<PendingEntityInputAdmission>,
) {
    // TS deferred.flush drains immediate events after each owner proposal.
    // Combining owners here lets a later intent alter an earlier opening
    // cohort before it is signed (production cross-J R4 h45).
    let mut batch = Some(std::mem::take(admissions));
    segments.extend(groups.drain(..).map(|group| {
        PendingEntitySegment {
            groups: vec![group],
            derived: false,
            admission: batch
                .take()
                .map_or(SegmentAdmission::Prepared, SegmentAdmission::Deferred),
        }
    }));
}

fn pending_ends_in_individual_run(pending: &[EntityPendingWork]) -> bool {
    matches!(pending.last(), Some(EntityPendingWork::LocalBatch { projected, .. })
        if projected.first().is_some_and(|tx|
            xln_rscore_entity_kernel::is_individual_entity_command_tx_kind(tx.kind)))
}

fn admit_deferred_entity_inputs(
    staged: &mut BTreeMap<RuntimeEntityKey, EntityApplySlot>,
    admissions: Vec<PendingEntityInputAdmission>,
    runtime_seed: &str,
    runtime_id: &str,
    runtime_timestamp: u64,
) -> Result<(), RuntimeMachineError> {
    // Admission is positional across all inputs before any deferred owner
    // proposes. Materialize on the first eligible input, not the merged tail:
    // [chat A], [chat B] must sign [A, materialize], then [B] (R4 regression).
    for mut admission in admissions {
        let slot = staged.get_mut(&admission.key).ok_or_else(|| {
            RuntimeMachineError::EntityStateMap("ADMISSION_ENTITY_SLOT_MISSING".into())
        })?;
        materialize_local_open_accounts(&mut admission.pending, slot, runtime_seed, runtime_id)?;
        let append_to_run = pending_ends_in_individual_run(&admission.pending);
        append_entity_pending_work(&mut slot.replica.entity_mempool, admission.pending)?;
        enqueue_proposer_materializations(slot, runtime_seed, runtime_timestamp, append_to_run)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PendingEntityCause {
    External,
    CrossJurisdiction,
    AccountWork,
}

struct ImmediateCrossJCommand {
    source_entity_id: String,
    source_signer_id: String,
    target: RuntimeEntityKey,
    entity_txs: Vec<CanonicalEntityTx>,
}

fn canonical_entity_tx_value(
    tx: &CanonicalEntityTx,
) -> Result<CanonicalValue, RuntimeMachineError> {
    Ok(CanonicalValue::Object(vec![
        (
            "type".into(),
            CanonicalValue::String(tx.kind.as_str().into()),
        ),
        (
            "data".into(),
            tx.frame_data()
                .cloned()
                .ok_or(RuntimeMachineError::EntityTxExecutionUnsupported(
                    tx.kind.as_str(),
                ))?,
        ),
    ]))
}

fn assert_cross_j_register_pulls(
    tx: &CanonicalEntityTx,
    stage: &'static str,
) -> Result<(), RuntimeMachineError> {
    if tx.kind != EntityTxKind::RegisterCrossJurisdictionSwap {
        return Ok(());
    }
    let route = match tx.frame_data() {
        Some(CanonicalValue::Object(data)) => data
            .iter()
            .find_map(|(field, value)| (field == "route").then_some(value)),
        _ => None,
    };
    let has_pull = |name: &str| matches!(route, Some(CanonicalValue::Object(fields)) if fields.iter().any(|(field, _)| field == name));
    if !has_pull("sourcePull") || !has_pull("targetPull") {
        return Err(RuntimeMachineError::EntityStateMap(format!(
            "RUNTIME_CROSS_J_REGISTER_PULLS_LOST:{stage}"
        )));
    }
    Ok(())
}

fn immediate_cross_j_group(
    command: ImmediateCrossJCommand,
) -> Result<PendingEntityGroup, RuntimeMachineError> {
    let nested = command
        .entity_txs
        .iter()
        .map(canonical_entity_tx_value)
        .collect::<Result<Vec<_>, _>>()?;
    let runtime_output = CanonicalEntityTx::from_frame_projection(
        EntityTxKind::RuntimeOutput,
        CanonicalValue::Object(vec![
            ("protocol".into(), CanonicalValue::String("cross-j".into())),
            (
                "sourceEntityId".into(),
                CanonicalValue::String(command.source_entity_id),
            ),
            (
                "sourceSignerId".into(),
                CanonicalValue::String(command.source_signer_id),
            ),
            (
                "targetEntityId".into(),
                CanonicalValue::String(render_word(&command.target.entity_id)),
            ),
            ("entityTxs".into(), CanonicalValue::Array(nested)),
        ]),
    )
    .map_err(EntityTransitionError::from)?;
    let Some(LocalEntityTx::RuntimeOutput(decoded)) =
        decode_local_entity_tx(&runtime_output).map_err(RuntimeMachineError::EntityFinancial)?
    else {
        return Err(RuntimeMachineError::EntityStateMap(
            "RUNTIME_CROSS_J_WRAPPER_DECODE_FAILED".into(),
        ));
    };
    for tx in &decoded.entity_txs {
        assert_cross_j_register_pulls(tx, "WRAPPER_DECODE")?;
    }
    Ok(PendingEntityGroup {
        entity_id: command.target.entity_id,
        signer_id: command.target.signer_id,
        // RuntimeOutput is already the canonical direct Entity-frame tx, so
        // wrapping it in EntityCommand would change the certified bytes. Keep
        // that projection while executing the decoded local transition once.
        pending: vec![EntityPendingWork::ProposerMaterialized {
            projected: runtime_output,
            native: Box::new(LocalEntityTx::RuntimeOutput(decoded)),
        }],
        input_positions: Vec::new(),
        wake: None,
        recorded_scheduled_wake: false,
        j_observation: None,
        j_attestation_wire: None,
        atomic_output_pair: None,
        cause: PendingEntityCause::CrossJurisdiction,
    })
}

fn collect_immediate_cross_j_commands(
    source_entity_id: &str,
    source_signer_id: &str,
    local_keys: &BTreeSet<RuntimeEntityKey>,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<Vec<ImmediateCrossJCommand>, RuntimeMachineError> {
    let mut retained = Vec::with_capacity(outputs.len());
    let mut commands = Vec::<ImmediateCrossJCommand>::new();
    let mut positions = BTreeMap::<RuntimeEntityKey, usize>::new();
    for output in std::mem::take(outputs) {
        let all_projected = !output.entity_txs.is_empty()
            && output
                .entity_txs
                .iter()
                .all(|tx| matches!(tx, LocalEntityOutputTx::Projected(_)));
        if !all_projected {
            retained.push(output);
            continue;
        }
        let target_signer_id = output.target_signer_id.as_deref().ok_or_else(|| {
            RuntimeMachineError::EntityStateMap("CROSS_J_LOCAL_OUTPUT_TARGET_SIGNER_MISSING".into())
        })?;
        let target_entity_id = parse_hex32(&output.entity_id).ok_or_else(|| {
            RuntimeMachineError::EntityStateMap(format!(
                "CROSS_J_LOCAL_OUTPUT_TARGET_INVALID:{}",
                output.entity_id
            ))
        })?;
        let target = RuntimeEntityKey::new(target_entity_id, target_signer_id)?;
        if !local_keys.contains(&target) {
            retained.push(output);
            continue;
        }
        let entity_txs = output
            .entity_txs
            .into_iter()
            .map(|tx| match tx {
                LocalEntityOutputTx::Projected(tx) => Ok(tx),
                LocalEntityOutputTx::AccountInput(_) => Err(RuntimeMachineError::EntityStateMap(
                    "CROSS_J_LOCAL_OUTPUT_PROTOCOL_MIXED".into(),
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        for tx in &entity_txs {
            assert_cross_j_register_pulls(tx, "ENTITY_OUTPUT")?;
        }
        if let Some(position) = positions.get(&target).copied() {
            commands[position].entity_txs.extend(entity_txs);
        } else {
            positions.insert(target.clone(), commands.len());
            commands.push(ImmediateCrossJCommand {
                source_entity_id: source_entity_id.to_string(),
                source_signer_id: source_signer_id.to_string(),
                target,
                entity_txs,
            });
        }
    }
    *outputs = retained;
    Ok(commands)
}

fn account_work_group(key: RuntimeEntityKey) -> PendingEntityGroup {
    PendingEntityGroup {
        entity_id: key.entity_id,
        signer_id: key.signer_id,
        pending: Vec::new(),
        input_positions: Vec::new(),
        wake: None,
        recorded_scheduled_wake: false,
        j_observation: None,
        j_attestation_wire: None,
        atomic_output_pair: None,
        cause: PendingEntityCause::AccountWork,
    }
}

fn take_entity_mempool_for_group(
    cause: PendingEntityCause,
    retained_count: usize,
    entity_mempool: &mut std::collections::VecDeque<EntityPendingWork>,
) -> Result<std::collections::VecDeque<EntityPendingWork>, RuntimeMachineError> {
    match cause {
        PendingEntityCause::AccountWork => Ok(VecDeque::new()),
        PendingEntityCause::External => Ok(std::mem::take(entity_mempool)),
        PendingEntityCause::CrossJurisdiction => {
            // Trusted local events select their authenticated input and its
            // fresh proposer additions. Earlier deferred user commands stay
            // queued for their own flush, never mixed into this signature.
            if !matches!(entity_mempool.get(retained_count),
                Some(EntityPendingWork::ProposerMaterialized { projected, .. })
                    if projected.kind == EntityTxKind::RuntimeOutput)
            {
                return Err(RuntimeMachineError::EntityStateMap(
                    "RUNTIME_CROSS_J_LOCAL_EVENT_INPUT_MISSING".into(),
                ));
            }
            Ok(entity_mempool.split_off(retained_count))
        }
    }
}

fn account_work_selection_emits_frame(
    selection: &xln_rscore_entity_kernel::CrossJOpeningProposalSelection,
) -> bool {
    !matches!(
        selection,
        xln_rscore_entity_kernel::CrossJOpeningProposalSelection::Wait
    )
}

fn external_entity_group_has_no_admitted_work(
    slot: &EntityApplySlot,
    group: &PendingEntityGroup,
) -> Result<bool, RuntimeMachineError> {
    if group.cause != PendingEntityCause::External
        || !group.pending.is_empty()
        || !slot.replica.entity_mempool.is_empty()
        || group.wake.is_some()
        || group.j_observation.is_some()
        || group.j_attestation_wire.is_some()
        || group.atomic_output_pair.is_some()
        || slot.replica.accounts.has_proposable_accounts()?
    {
        return Ok(false);
    }
    let metadata = &slot.replica.replica_metadata;
    if [
        "proposal",
        "candidate",
        "lockedFrame",
        "pendingLeaderCertificate",
        "jPrefixRound",
    ]
    .iter()
    .any(|field| metadata.get(*field).is_some_and(|value| !value.is_null()))
        || metadata.get("leaderVotes").is_some_and(|value| {
            !value
                .get("value")
                .and_then(serde_json::Value::as_array)
                .is_some_and(Vec::is_empty)
        })
    {
        return Ok(false);
    }
    if metadata.get("jHistory").is_some() {
        let height = local_j_prefix_attestable_height(
            metadata,
            slot.state.entity.last_finalized_j_height,
            slot.state.entity.j_history_finality.is_some(),
        )
        .map_err(|error| {
            RuntimeMachineError::ReplicaMetadata(format!("J_PREFIX_HISTORY_DECODE:{error}"))
        })?;
        if height != Some(slot.state.entity.last_finalized_j_height) {
            return Ok(false);
        }
    }
    // No admitted EntityTx, Account work or leader/J-prefix transition exists.
    // The caller must still run canonical proposer admission: a committed
    // cross-J intent can produce work from an otherwise empty wake (R4 h45).
    Ok(true)
}

fn account_work_has_selectable_proposal(
    slot: &mut EntityApplySlot,
    siblings: &[xln_rscore_entity_kernel::CrossJOpeningSiblingEntityView],
) -> Result<bool, RuntimeMachineError> {
    if !slot.replica.accounts.has_proposable_accounts()? {
        return Ok(false);
    }
    let account_ids = slot.replica.accounts.proposable_account_ids()?;
    let views = slot
        .replica
        .accounts
        .cross_j_opening_account_views(account_ids.clone())?;
    if views.len() != account_ids.len() {
        return Err(RuntimeMachineError::EntityStateMap(
            "RUNTIME_ACCOUNT_WORK_VIEW_COUNT_MISMATCH".into(),
        ));
    }
    for (account_id, view) in account_ids.into_iter().zip(views) {
        if !view
            .counterparty_entity_id
            .eq_ignore_ascii_case(&render_account_id(&account_id))
        {
            return Err(RuntimeMachineError::EntityStateMap(
                "RUNTIME_ACCOUNT_WORK_VIEW_ORDER_MISMATCH".into(),
            ));
        }
        let selection = xln_rscore_entity_kernel::select_cross_j_opening_proposal(
            &slot.state.entity.entity_id,
            &view.counterparty_entity_id,
            &view.mempool,
            siblings,
        )
        .map_err(|error| {
            RuntimeMachineError::EntityFinancial(
                xln_rscore_entity_kernel::EntityKernelError::InvalidLocalEntityTx {
                    kind: "accountWork",
                    detail: error.to_string(),
                },
            )
        })?;
        if account_work_selection_emits_frame(&selection) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn enqueue_derived_groups(
    segments: &mut VecDeque<PendingEntitySegment>,
    groups: Vec<PendingEntityGroup>,
) {
    // Existing derived work is older and keeps its FIFO position. New work is
    // inserted immediately before the next external segment, never at the
    // front: source registration must not jump ahead of the target
    // registration already emitted by the materialization frame.
    let mut insertion = segments
        .iter()
        .position(|pending| !pending.derived)
        .unwrap_or(segments.len());
    for group in groups {
        segments.insert(
            insertion,
            PendingEntitySegment {
                groups: vec![group],
                derived: true,
                admission: SegmentAdmission::Inline,
            },
        );
        insertion += 1;
    }
}

fn runtime_cross_j_sibling_views(
    staged: &mut BTreeMap<RuntimeEntityKey, EntityApplySlot>,
    live_states: &BTreeMap<RuntimeEntityKey, RuntimeEntityState>,
    live_replicas: &mut BTreeMap<RuntimeEntityKey, RuntimeEntityReplica>,
) -> Result<Vec<xln_rscore_entity_kernel::CrossJOpeningSiblingEntityView>, RuntimeMachineError> {
    let staged_sources = staged.iter_mut().map(|(key, slot)| {
        super::CrossJOpeningRuntimeSlot::new(key, &slot.state, &mut slot.replica)
    });
    let live_sources = live_replicas.iter_mut().map(|(key, replica)| {
        let state = live_states
            .get(key)
            .expect("Runtime live Entity replica must have a committed state slot");
        super::CrossJOpeningRuntimeSlot::new(key, state, replica)
    });
    super::collect_cross_j_opening_sibling_views(staged_sources, live_sources)
}

fn account_input_wire_digest(work: &EntityPendingWork) -> Option<[u8; 32]> {
    match work {
        EntityPendingWork::Account { wire_digest, .. } => Some(*wire_digest),
        _ => None,
    }
}

pub(super) fn append_entity_pending_work(
    mempool: &mut VecDeque<EntityPendingWork>,
    pending: Vec<EntityPendingWork>,
) -> Result<(), RuntimeMachineError> {
    // Validators may forward one retained AccountInput several times before
    // its Entity frame commits. Compare the complete canonical child input,
    // not its claimed frame hash: a hostile body may reuse claimed scalars.
    // The set is deliberately pending-only. After commit, an exact retry must
    // reach Account duplicate handling so the peer can recover a lost ACK.
    let mut seen = mempool
        .iter()
        .filter_map(account_input_wire_digest)
        .collect::<BTreeSet<_>>();
    for work in pending {
        let Some(wire) = account_input_wire_digest(&work) else {
            mempool.push_back(work);
            continue;
        };
        if seen.insert(wire) {
            mempool.push_back(work);
        }
    }
    Ok(())
}

fn push_pending_entity_input(
    groups: &mut Vec<PendingEntityGroup>,
    indexes: &mut BTreeMap<RuntimeEntityKey, usize>,
    entity_id: [u8; 32],
    signer_id: String,
    pending: Vec<EntityPendingWork>,
    position: usize,
) -> Result<usize, RuntimeMachineError> {
    let key = RuntimeEntityKey::new(entity_id, &signer_id)?;
    let index = match indexes.get(&key).copied() {
        Some(index) => index,
        None => {
            let index = groups.len();
            indexes.insert(key, index);
            groups.push(PendingEntityGroup {
                entity_id,
                signer_id,
                pending: Vec::new(),
                input_positions: Vec::new(),
                wake: None,
                recorded_scheduled_wake: false,
                j_observation: None,
                j_attestation_wire: None,
                atomic_output_pair: None,
                cause: PendingEntityCause::External,
            });
            index
        }
    };
    groups[index].pending.extend(pending);
    groups[index].input_positions.push(position);
    Ok(index)
}

fn attach_j_prefix_attestation(
    group: &mut PendingEntityGroup,
    attestation: Option<&super::types::RuntimeJPrefixAttestation>,
) -> Result<(), RuntimeMachineError> {
    let Some(attestation) = attestation else {
        return Ok(());
    };
    if let Some(existing) = group.j_attestation_wire.as_ref() {
        if existing != &attestation.wire {
            return Err(RuntimeMachineError::ReplicaMetadata(
                "J_PREFIX_ATTESTATION_COLLISION".into(),
            ));
        }
        return Ok(());
    }
    group.j_observation = Some(attestation.observation.clone());
    group.j_attestation_wire = Some(attestation.wire.clone());
    Ok(())
}

// Stale authenticated votes retire only their old round. They never replace
// the current certified J anchor; any new vote is derived from local history.
fn refresh_stale_j_prefix(
    slot: &EntityApplySlot,
    group: &mut PendingEntityGroup,
) -> Result<bool, RuntimeMachineError> {
    let Some(wire) = group.j_attestation_wire.as_ref() else {
        return Ok(false);
    };
    let target = wire["targetEntityHeight"]
        .as_u64()
        .filter(|height| *height > 0 && *height <= 9_007_199_254_740_991)
        .ok_or_else(|| j_range_error("ATTESTATION_TARGET"))?;
    if target > slot.state.entity.height {
        return Ok(false);
    }
    let parent = wire["parentFrameHash"]
        .as_str()
        .ok_or_else(|| j_range_error("ATTESTATION_PARENT"))?;
    if (target == 1 && parent != "genesis") || (target > 1 && parse_hex32(parent).is_none()) {
        return Err(j_range_error("ATTESTATION_PARENT"));
    }
    let observation = group
        .j_observation
        .as_ref()
        .ok_or_else(|| j_range_error("ATTESTATION_OBSERVATION"))?;
    let (_, _, expected_jurisdiction) = certified_j_anchor(&slot.state.entity)?
        .ok_or_else(|| j_range_error("ATTESTATION_CERTIFIED_ANCHOR_MISSING"))?;
    if observation.jurisdiction_ref != expected_jurisdiction {
        return Err(j_range_error("ATTESTATION_JURISDICTION"));
    }
    let base = wire["baseHeight"]
        .as_u64()
        .ok_or_else(|| j_range_error("ATTESTATION_BASE"))?;
    if observation.scanned_through_height < base
        || observation.headers.len() as u64 != observation.scanned_through_height - base
        || observation
            .headers
            .first()
            .is_some_and(|header| header.j_height != base + 1)
    {
        return Err(j_range_error("ATTESTATION_HEADERS"));
    }
    let blocks = xln_rscore_entity_kernel::canonical_j_event_blocks(&observation.batches)
        .map_err(|error| j_range_error(error.to_string()))?;
    let range_hash = xln_rscore_entity_kernel::canonical_j_event_range_hash(&blocks)
        .map_err(|error| j_range_error(error.to_string()))?;
    if wire["rangeHash"].as_str() != Some(render_word(&range_hash).as_str()) {
        return Err(j_range_error("ATTESTATION_RANGE_HASH"));
    }
    let mut unsigned = wire
        .as_object()
        .cloned()
        .ok_or_else(|| j_range_error("ATTESTATION_OBJECT"))?;
    let signature = unsigned
        .remove("signature")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| j_range_error("ATTESTATION_SIGNATURE"))?;
    unsigned.insert(
        "domain".into(),
        serde_json::json!("xln:j-prefix-attestation:v1"),
    );
    let canonical = crate::canonical_value_from_tagged_json(&serde_json::Value::Object(unsigned))
        .map_err(|error| j_range_error(error.to_string()))?;
    let encoded = encode_canonical_consensus_bytes(&canonical)
        .map_err(|error| j_range_error(error.to_string()))?;
    let digest: [u8; 32] = Keccak256::digest(encoded).into();
    let signature: [u8; 65] = hex::decode(signature.strip_prefix("0x").unwrap_or(""))
        .map_err(|_| j_range_error("ATTESTATION_SIGNATURE"))?
        .try_into()
        .map_err(|_| j_range_error("ATTESTATION_SIGNATURE"))?;
    let signer = xln_rscore_crypto::recover_signer_address(&digest, &signature)
        .ok_or_else(|| j_range_error("ATTESTATION_SIGNATURE"))?;
    if Some(signer) != parse_hex20(&group.signer_id) {
        return Err(j_range_error("ATTESTATION_SIGNATURE"));
    }
    group.j_observation =
        complete_local_j_prefix_observation(&slot.state, &slot.replica, None, false)?;
    group.j_attestation_wire = None;
    Ok(true)
}

fn assert_j_prefix_attestation_certified(
    certificate: Option<&CanonicalValue>,
    signer_id: &str,
    expected: Option<&serde_json::Value>,
) -> Result<(), RuntimeMachineError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let certificate = certificate.ok_or_else(|| {
        RuntimeMachineError::ReplicaMetadata("J_PREFIX_CERTIFICATE_MISSING".into())
    })?;
    let wire = crate::tagged_json_from_canonical_value(certificate)
        .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
    let rows = wire
        .get("attestations")
        .and_then(|value| value.get("value"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_PREFIX_CERTIFICATE_ATTESTATIONS".into())
        })?;
    let certified = rows
        .iter()
        .find_map(|row| {
            row.as_array()
                .filter(|pair| pair.len() == 2 && pair[0].as_str() == Some(signer_id))
                .map(|pair| &pair[1])
        })
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_PREFIX_CERTIFICATE_SIGNER_MISSING".into())
        })?;
    if certified != expected {
        return Err(RuntimeMachineError::ReplicaMetadata(
            "J_PREFIX_ATTESTATION_CERTIFICATE_MISMATCH".into(),
        ));
    }
    Ok(())
}

fn recorded_scheduled_wake(
    input: &RuntimeEntityInput,
) -> Result<Option<ScheduledWake>, RuntimeMachineError> {
    let Some(recorded) = input.scheduled_wake() else {
        return Ok(None);
    };
    decode_recorded_scheduled_wake(recorded)
        .map(Some)
        .map_err(RuntimeMachineError::from)
}

struct AppliedEntityGroup {
    evicted_context: Option<(RuntimeEntityKey, u64, RuntimeEntityFrameContext)>,
    state: RuntimeEntityState,
    replica: RuntimeEntityReplica,
    outputs: Option<RuntimeEntityOutputs>,
    account_commits: Vec<AccountCommitEvidence>,
    touched_accounts: Vec<super::RuntimeTouchedAccount>,
    book_touched: bool,
    synthetic_input: Option<serde_json::Value>,
    selected_count: usize,
    pending_count: usize,
    post_commit_j_actions: Vec<crate::j_submit::DurableJAttempt>,
    apply_profile: RuntimeApplyPhaseProfile,
}

/// Untrusted remote EntityCommands are checked against the committed board
/// and nonce state before any frame mutation. One invalid command rejects
/// every input of the same origin (Entity, signer, source Runtime), logs it,
/// and leaves the rest of the frame untouched; local input stays fail-stop.
///
/// Parity target: TS `restoreUndurableRuntimeInput` +
/// `discardRejectedEntityInput` (core/runtime/frame/intake/discard.ts), which
/// roll the candidate frame back and remove exactly that origin.
fn reject_invalid_remote_commands(
    replica: &RuntimeReplica,
    input: &mut RuntimeInput,
) -> Result<(), RuntimeMachineError> {
    let mut rejected: BTreeSet<(RuntimeEntityKey, String)> = BTreeSet::new();
    let mut boards: BTreeMap<
        RuntimeEntityKey,
        (
            EntityCommandBoard,
            Option<xln_rscore_entity_kernel::EntityCommandNonceState>,
        ),
    > = BTreeMap::new();
    for entity_input in &input.entity_inputs {
        let Some(source) = entity_input.source_runtime_id() else {
            continue;
        };
        if !entity_input
            .pending_work()
            .iter()
            .any(|work| matches!(work, EntityPendingWork::Command { .. }))
        {
            continue;
        }
        let key = RuntimeEntityKey::new(*entity_input.entity_id(), entity_input.signer_id())?;
        if rejected.contains(&(key.clone(), source.to_string())) {
            continue;
        }
        let (Some(entity_replica), Some(entity_state)) = (
            replica.e_replicas.get(&key),
            replica.state.e_replicas.get(&key),
        ) else {
            continue;
        };
        if !boards.contains_key(&key) {
            let board = command_board_for_replica(
                entity_replica,
                entity_state.certified_board_authority(),
            )?;
            let mut nonce_state = entity_state.entity.entity_command_nonces.clone();
            normalize_entity_command_nonce_board(&mut nonce_state, &board)?;
            boards.insert(key.clone(), (board, nonce_state));
        }
        let (board, nonce_state) = boards.get_mut(&key).expect("board inserted above");
        let entity_id = render_word(&key.entity_id);
        for work in entity_input.pending_work() {
            let EntityPendingWork::Command { command, .. } = work else {
                continue;
            };
            let verdict = assert_signed_entity_command(
                &entity_id,
                &entity_replica.entity_consensus.state.authority,
                &board.signer,
                board.board_epoch,
                &board.stack_key,
                nonce_state.as_ref(),
                command,
            )
            .and_then(|_| advance_entity_command_nonce(nonce_state, board, command));
            if let Err(error) = verdict {
                eprintln!(
                    "RSCORE_RUNTIME_INGRESS_REJECTED entity={entity_id} signer={} from={source} reason={error}",
                    key.signer_id
                );
                rejected.insert((key.clone(), source.to_string()));
                break;
            }
        }
    }
    if rejected.is_empty() {
        return Ok(());
    }
    input.entity_inputs.retain(|entity_input| {
        let Some(source) = entity_input.source_runtime_id() else {
            return true;
        };
        RuntimeEntityKey::new(*entity_input.entity_id(), entity_input.signer_id())
            .map(|key| !rejected.contains(&(key, source.to_string())))
            .unwrap_or(true)
    });
    Ok(())
}

pub(super) fn merge_runtime_output_inputs(
    inputs: Vec<RuntimeEntityInput>,
) -> Result<Vec<RuntimeEntityInput>, RuntimeMachineError> {
    // Match the TS merge boundary: an exact repeated Runtime output keeps its
    // first position and does not divide the surrounding Account lane again.
    // The source frame is part of this identity; a later committed output with
    // the same financial body must still reach the canonical Entity transition.
    let mut seen_runtime_outputs = BTreeMap::new();
    let mut unique_inputs = Vec::with_capacity(inputs.len());
    for input in inputs {
        if input.runtime_output().is_some() {
            let wire = input.canonical();
            let identity = serde_json::json!([
                wire["entityId"],
                wire["signerId"],
                wire["from"],
                wire["runtimeId"],
                wire["sourceRuntimeFrame"],
                wire["entityTxs"][0],
            ]);
            let identity = crate::transport::msgpack::encode_transport(&identity)
                .map_err(|error| RuntimeMachineError::EntityInputEncoding(error.to_string()))?;
            let attestation = wire.get("jPrefixAttestations").cloned();
            if let Some(first_attestation) = seen_runtime_outputs.get(&identity) {
                // An authenticated duplicate may not erase conflicting J
                // evidence, including the first-absent/second-present case.
                if first_attestation != &attestation {
                    return Err(RuntimeMachineError::EntityInputTransportInvalid(
                        "ENTITY_INPUT_J_PREFIX_EQUIVOCATION".into(),
                    ));
                }
                continue;
            }
            seen_runtime_outputs.insert(identity, attestation);
        }
        unique_inputs.push(input);
    }
    Ok(unique_inputs)
}

fn apply_runtime_inner(
    mut replica: RuntimeReplica,
    mut input: RuntimeInput,
    mut materializer: Option<&mut dyn EntityInfraMaterializer>,
    profile_enabled: bool,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    let profile_started = profile_enabled.then(Instant::now);
    let mut apply_profile = RuntimeApplyPhaseProfile::default();
    // Live execution derives resident/Crontab work and persists the resulting
    // explicit Entity inputs in the Runtime WAL. Exact execution already
    // receives those inputs from that WAL, so deriving them again would apply
    // one committed wake twice after restoring the pre-frame checkpoint.
    let derive_internal_wakes = materializer.is_some();
    for entity_input in &input.entity_inputs {
        let Some((_, slot)) =
            replica.entity_slot(entity_input.entity_id(), entity_input.signer_id())
        else {
            return Err(if replica.contains_entity_id(entity_input.entity_id()) {
                RuntimeMachineError::EntitySignerMismatch
            } else {
                RuntimeMachineError::EntityOwnerMismatch
            });
        };
        debug_assert_eq!(&slot.entity_id, entity_input.entity_id());
    }

    // Live ingress only: exact replay re-applies the WAL, which never holds a
    // rejected input on either engine.
    if derive_internal_wakes {
        reject_invalid_remote_commands(&replica, &mut input)?;
    }
    enqueue_runtime_input(&mut replica.mempool, &mut input, replica.limits)?;
    let entity_heights = replica
        .state
        .e_replicas
        .iter()
        .map(|(key, state)| (key.clone(), state.entity.height))
        .collect();
    let mut selected = select_runtime_frame(
        &mut replica.mempool,
        replica.limits,
        &entity_heights,
        input.frame.clone(),
    )?;
    let mut selected_context = selected
        .as_ref()
        .map_or_else(|| input.frame.clone(), |selected| selected.frame.clone());
    selected_context.finalized_j_height = derive_selected_finalized_j_height(
        replica.state.finalized_j_height,
        selected
            .as_ref()
            .map_or(&[][..], |selected| selected.runtime_txs.as_slice()),
    );
    if let Some(selected) = &mut selected {
        selected.frame.finalized_j_height = selected_context.finalized_j_height;
    }
    validate_selected_context(&replica, &selected_context)?;

    let mut wakes = Vec::new();
    if derive_internal_wakes {
        for (key, state) in &replica.state.e_replicas {
            let live = replica
                .e_replicas
                .get(key)
                .ok_or(RuntimeMachineError::EntityOwnerMismatch)?;
            if let Some(wake) = internal_wake(state, live, &selected_context)? {
                wakes.push(super::RuntimeEntityWake {
                    entity_id: key.entity_id,
                    signer_id: key.signer_id.clone(),
                    wake,
                });
            }
        }
    }
    let Some(mut frame) = selected.or_else(|| {
        (!wakes.is_empty()).then(|| super::SelectedRuntimeFrame {
            runtime_txs: Vec::new(),
            entity_inputs: Vec::new(),
            frame: selected_context.clone(),
            receipt: AppliedRuntimeInput {
                entity_inputs: 0,
                account_inputs: 0,
                canonical_wire_bytes: 0,
                entity_txs_selected: 0,
                entity_txs_pending: 0,
                wakes: Vec::new(),
            },
        })
    }) else {
        return Ok(RuntimeApplyResult {
            replica,
            applied_input: None,
            applied_frame: None,
            outputs: RuntimeOutputs {
                entities: Vec::new(),
                touches: RuntimeFrameTouches::default(),
            },
            account_commits: Vec::new(),
            post_commit_j_attempts: Vec::new(),
            apply_profile: None,
        });
    };
    frame.receipt.wakes = wakes.clone();
    frame.entity_inputs = merge_runtime_output_inputs(std::mem::take(&mut frame.entity_inputs))?;
    let (mut post_commit_j_attempts, runtime_tx_touched_entities) =
        apply_runtime_txs(&mut replica, &frame.runtime_txs, frame.frame.timestamp)?;
    let next_height = replica
        .state
        .height
        .checked_add(1)
        .ok_or(RuntimeMachineError::HeightOverflow)?;

    let external_count = frame.entity_inputs.len();
    let mut canonical_slots = (0..external_count).map(|_| None).collect::<Vec<_>>();
    let mut segments = Vec::<PendingEntitySegment>::new();
    let mut deferred_groups = Vec::<PendingEntityGroup>::new();
    let mut deferred_admissions = Vec::<PendingEntityInputAdmission>::new();
    let mut deferred_indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
    let mut inputs = std::collections::VecDeque::from(frame.entity_inputs);
    let mut position = 0_usize;
    while let Some(input) = inputs.pop_front() {
        let recorded_wake = (!derive_internal_wakes)
            .then(|| recorded_scheduled_wake(&input))
            .transpose()?
            .flatten();
        let marker = input.atomic_pair().cloned();
        if let Some(marker) = marker {
            if recorded_wake.is_some() {
                return Err(RuntimeMachineError::Scheduler(
                    SchedulerError::InvalidWake {
                        detail: "RECORDED_ATOMIC".into(),
                    },
                ));
            }
            if !deferred_groups.is_empty() {
                flush_deferred_entity_groups(
                    &mut segments,
                    &mut deferred_groups,
                    &mut deferred_admissions,
                );
                deferred_indexes.clear();
            }
            let next = inputs.pop_front().ok_or_else(|| {
                RuntimeMachineError::AtomicCrossJurisdictionPairInvalid("MISSING_SECOND_LEG".into())
            })?;
            let next_marker = next.atomic_pair().ok_or_else(|| {
                RuntimeMachineError::AtomicCrossJurisdictionPairInvalid(
                    "SECOND_LEG_UNTAGGED".into(),
                )
            })?;
            if marker != *next_marker || input.entity_id() == next.entity_id() {
                return Err(RuntimeMachineError::AtomicCrossJurisdictionPairInvalid(
                    "PAIR_MISMATCH".into(),
                ));
            }
            let mut groups = Vec::with_capacity(2);
            let mut indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
            for (input_position, input) in [(position, input), (position + 1, next)] {
                let entity_id = *input.entity_id();
                let signer_id = input.signer_id().to_string();
                let j_prefix_attestation = input.j_prefix_attestation().cloned();
                let (canonical, pending, _) = input.into_parts();
                canonical_slots[input_position] = Some(canonical);
                let group_index = push_pending_entity_input(
                    &mut groups,
                    &mut indexes,
                    entity_id,
                    signer_id,
                    pending,
                    input_position,
                )?;
                attach_j_prefix_attestation(
                    &mut groups[group_index],
                    j_prefix_attestation.as_ref(),
                )?;
                if marker.phase == "proposal" {
                    groups[group_index].atomic_output_pair =
                        Some(super::types::RuntimeAtomicCrossJurisdictionPair {
                            phase: "ack".to_string(),
                            pair_key: marker.pair_key.clone(),
                        });
                }
            }
            segments.push(PendingEntitySegment {
                groups,
                derived: false,
                admission: SegmentAdmission::AtomicPair,
            });
            position += 2;
            continue;
        }
        let entity_id = *input.entity_id();
        let signer_id = input.signer_id().to_string();
        // Authenticated remote runtimeOutput is still an ordinary deferred
        // Entity input. R6 h65 commits [Account ACK, runtimeOutput] together;
        // its transport provenance does not create another Entity frame.
        let isolated_protocol_input = input.is_board_handover_only();
        let j_prefix_attestation = input.j_prefix_attestation().cloned();
        let (canonical, pending, _) = input.into_parts();
        canonical_slots[position] = Some(canonical);
        if isolated_protocol_input {
            if !deferred_groups.is_empty() {
                flush_deferred_entity_groups(
                    &mut segments,
                    &mut deferred_groups,
                    &mut deferred_admissions,
                );
                deferred_indexes.clear();
            }
            let mut groups = Vec::with_capacity(1);
            let mut indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
            let group_index = push_pending_entity_input(
                &mut groups,
                &mut indexes,
                entity_id,
                signer_id,
                pending,
                position,
            )?;
            attach_j_prefix_attestation(&mut groups[group_index], j_prefix_attestation.as_ref())?;
            segments.push(PendingEntitySegment {
                groups,
                derived: false,
                admission: SegmentAdmission::Inline,
            });
            position += 1;
            continue;
        }
        deferred_admissions.push(PendingEntityInputAdmission {
            key: RuntimeEntityKey::new(entity_id, &signer_id)?,
            pending,
        });
        let group_index = push_pending_entity_input(
            &mut deferred_groups,
            &mut deferred_indexes,
            entity_id,
            signer_id,
            Vec::new(),
            position,
        )?;
        attach_j_prefix_attestation(
            &mut deferred_groups[group_index],
            j_prefix_attestation.as_ref(),
        )?;
        if let Some(scheduled) = recorded_wake {
            let group = &mut deferred_groups[group_index];
            if group.recorded_scheduled_wake {
                return Err(RuntimeMachineError::Scheduler(
                    SchedulerError::InvalidWake {
                        detail: "RECORDED_DUPLICATE".into(),
                    },
                ));
            }
            group.wake = Some(RuntimeWake {
                entity_mempool: false,
                account_mempool: false,
                scheduled: Some(scheduled),
            });
            group.recorded_scheduled_wake = true;
        }
        position += 1;
    }
    flush_deferred_entity_groups(
        &mut segments,
        &mut deferred_groups,
        &mut deferred_admissions,
    );

    if !wakes.is_empty() {
        let mut groups = Vec::<PendingEntityGroup>::new();
        for entity_wake in wakes {
            let key = RuntimeEntityKey::new(entity_wake.entity_id, &entity_wake.signer_id)?;
            // Exact replay coalesces the recorded scheduledWake with this
            // owner's J-prefix input. Live must select the same Entity round:
            // a standalone wake before the attestation would try to certify
            // the old J anchor while accepted local history already advanced.
            if let Some(prefix_group) = segments
                .iter_mut()
                .flat_map(|segment| &mut segment.groups)
                .find(|group| {
                    group.entity_id == key.entity_id
                        && group.signer_id == key.signer_id
                        && group.j_observation.is_some()
                        && group.wake.is_none()
                })
            {
                prefix_group.wake = Some(entity_wake.wake);
                continue;
            }
            let signer_id = replica
                .e_replicas
                .get(&key)
                .ok_or(RuntimeMachineError::EntityOwnerMismatch)?
                .signer_id
                .clone();
            groups.push(PendingEntityGroup {
                entity_id: entity_wake.entity_id,
                signer_id,
                pending: Vec::new(),
                input_positions: Vec::new(),
                wake: Some(entity_wake.wake),
                recorded_scheduled_wake: false,
                j_observation: None,
                j_attestation_wire: None,
                atomic_output_pair: None,
                cause: PendingEntityCause::External,
            });
        }
        if !groups.is_empty() {
            segments.insert(
                0,
                PendingEntitySegment {
                    groups,
                    derived: false,
                    admission: SegmentAdmission::Inline,
                },
            );
        }
    }

    if segments.is_empty() {
        crate::j_submit::prune_completed_prepared_attempts(&mut replica)
            .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
        replica.state.height = next_height;
        replica.state.timestamp = frame.frame.timestamp;
        replica.state.finalized_j_height = frame.frame.finalized_j_height;
        return Ok(RuntimeApplyResult {
            replica,
            applied_input: Some(frame.receipt),
            applied_frame: Some(AppliedRuntimeFrame {
                runtime_txs: frame.runtime_txs,
                entity_inputs: Vec::new(),
                frame: frame.frame,
                entity_frame_count: 0,
            }),
            outputs: RuntimeOutputs {
                entities: Vec::new(),
                touches: RuntimeFrameTouches {
                    entity_ids: runtime_tx_touched_entities,
                    ..RuntimeFrameTouches::default()
                },
            },
            account_commits: Vec::new(),
            post_commit_j_attempts,
            apply_profile: finish_runtime_apply_profile(
                profile_enabled,
                profile_started,
                next_height,
                apply_profile,
            ),
        });
    }

    // Move every local Entity slot into one transaction-local map. Immediate
    // cross-J outputs may target a sibling that was absent from the external
    // Runtime input, so staging only the preselected keys makes the derived
    // target impossible to apply atomically. Values are moved, never cloned,
    // and no slot is reinstalled until the complete Runtime transition ends.
    let group_count = segments.iter().map(|segment| segment.groups.len()).sum();
    let entity_order = replica.state.e_replicas.keys().cloned().collect::<Vec<_>>();
    let local_keys = entity_order.iter().cloned().collect::<BTreeSet<_>>();
    let mut staged = BTreeMap::<RuntimeEntityKey, EntityApplySlot>::new();
    for key in &entity_order {
        let (state, live) = replica
            .take_entity_slot(&key.entity_id, &key.signer_id)
            .ok_or(RuntimeMachineError::EntityOwnerMismatch)?;
        if staged
            .insert(
                key.clone(),
                EntityApplySlot {
                    state,
                    replica: live,
                },
            )
            .is_some()
        {
            return Err(RuntimeMachineError::EntityStateMap(
                "DUPLICATE_STAGED_ENTITY_SLOT".into(),
            ));
        }
    }
    let mut evicted_contexts = BTreeMap::new();
    let mut outputs = RuntimeOutputs {
        entities: Vec::with_capacity(group_count),
        touches: RuntimeFrameTouches {
            entity_ids: runtime_tx_touched_entities,
            ..RuntimeFrameTouches::default()
        },
    };
    let mut account_commits = Vec::new();
    let mut synthetic_inputs = Vec::new();
    let mut segments = VecDeque::from(segments);
    let mut cascade_round = 0_usize;
    let mut local_event_count = 0_usize;
    let mut cascade_fingerprints = BTreeSet::<Vec<u8>>::new();
    let mut last_output_by_entity = BTreeMap::<RuntimeEntityKey, usize>::new();
    while let Some(segment) = segments.pop_front() {
        // Both tagged legs prepare before either sibling is published. Reading
        // the first ACK's new state while preparing the second opens its next
        // Account cohort early (R6 h44). Derived work reads the post-pair state.
        let atomic_sibling_views = if matches!(&segment.admission, SegmentAdmission::AtomicPair) {
            Some(runtime_cross_j_sibling_views(
                &mut staged,
                &replica.state.e_replicas,
                &mut replica.e_replicas,
            )?)
        } else {
            None
        };
        let proposer_admitted = match segment.admission {
            SegmentAdmission::Inline | SegmentAdmission::AtomicPair => false,
            SegmentAdmission::Prepared => true,
            SegmentAdmission::Deferred(admissions) => {
                admit_deferred_entity_inputs(
                    &mut staged,
                    admissions,
                    &replica.proposer_runtime_seed,
                    replica.durable.runtime_id(),
                    frame.frame.timestamp,
                )?;
                true
            }
        };
        if segment.derived {
            cascade_round = cascade_round
                .checked_add(1)
                .ok_or(RuntimeMachineError::InputCountOverflow)?;
            local_event_count = local_event_count
                .checked_add(1)
                .ok_or(RuntimeMachineError::InputCountOverflow)?;
            let replica_count = local_keys.len();
            if cascade_round > 64 + replica_count || local_event_count > 1_000 + 64 * replica_count
            {
                return Err(RuntimeMachineError::EntityStateMap(format!(
                    "RUNTIME_CROSS_J_EVENT_CASCADE_LIMIT:rounds={cascade_round}:events={local_event_count}"
                )));
            }
        } else {
            cascade_round = 0;
            cascade_fingerprints.clear();
        }
        let mut derived_groups = Vec::<PendingEntityGroup>::new();
        for group in segment.groups {
            let cause = group.cause;
            if cause == PendingEntityCause::CrossJurisdiction {
                let [
                    EntityPendingWork::ProposerMaterialized {
                        projected: runtime_output,
                        native: _,
                    },
                ] = group.pending.as_slice()
                else {
                    return Err(RuntimeMachineError::EntityStateMap(
                        "RUNTIME_CROSS_J_DERIVED_COMMAND_SHAPE".into(),
                    ));
                };
                if runtime_output.kind != EntityTxKind::RuntimeOutput {
                    return Err(RuntimeMachineError::EntityStateMap(
                        "RUNTIME_CROSS_J_DERIVED_COMMAND_KIND".into(),
                    ));
                }
                // TS fingerprints the complete transient command, including
                // the target signer carried by the outer Entity envelope.
                // The nested runtimeOutput wire data intentionally omits that
                // envelope field, so hashing it alone conflates two local
                // replicas of the same Entity under different signers.
                let fingerprint = encode_canonical_consensus_bytes(&CanonicalValue::Object(vec![
                    (
                        "targetSignerId".into(),
                        CanonicalValue::String(group.signer_id.clone()),
                    ),
                    ("runtimeOutput".into(), runtime_output.wire_data.clone()),
                ]))
                .map_err(|error| RuntimeMachineError::EntityInputEncoding(error.to_string()))?;
                if !cascade_fingerprints.insert(fingerprint) {
                    return Err(RuntimeMachineError::EntityStateMap(format!(
                        "RUNTIME_CROSS_J_EVENT_CYCLE:round={cascade_round}:entity={}",
                        render_word(&group.entity_id)
                    )));
                }
            }
            let key = RuntimeEntityKey::new(group.entity_id, &group.signer_id)?;
            let cross_j_opening_sibling_views = if let Some(views) = &atomic_sibling_views {
                views.clone()
            } else {
                runtime_cross_j_sibling_views(
                    &mut staged,
                    &replica.state.e_replicas,
                    &mut replica.e_replicas,
                )?
            };
            let mut slot = staged.remove(&key).ok_or_else(|| {
                RuntimeMachineError::EntityStateMap("STAGED_ENTITY_SLOT_MISSING".into())
            })?;
            let otherwise_idle = external_entity_group_has_no_admitted_work(&slot, &group)?;
            // Deferred flush re-enters canonical admission with an empty
            // input: an earlier owner's cascade may have committed a new
            // intent after this owner's initial admission. Existing setup
            // keys prevent duplicate materialization or command re-signing.
            let prepared_materialization = if proposer_admitted || otherwise_idle {
                Some(enqueue_proposer_materializations(
                    &mut slot,
                    &replica.proposer_runtime_seed,
                    frame.frame.timestamp,
                    false,
                )?)
            } else {
                None
            };
            if (otherwise_idle && slot.replica.entity_mempool.is_empty())
                || (cause == PendingEntityCause::AccountWork
                    && !account_work_has_selectable_proposal(
                        &mut slot,
                        &cross_j_opening_sibling_views,
                    )?)
            {
                if staged.insert(key, slot).is_some() {
                    return Err(RuntimeMachineError::EntityStateMap(
                        "STAGED_ENTITY_SLOT_ALREADY_PRESENT".into(),
                    ));
                }
                continue;
            }
            let mut applied = apply_entity_group(
                slot,
                group,
                next_height,
                &mut frame.frame,
                replica.durable.j_replicas(),
                replica.durable.infrastructure(),
                &replica.proposer_runtime_seed,
                replica.durable.runtime_id(),
                prepared_materialization,
                replica.limits,
                false,
                cross_j_opening_sibling_views,
                &mut materializer,
                profile_enabled,
            )?;
            apply_profile.fit += applied.apply_profile.fit;
            apply_profile.resident_core += applied.apply_profile.resident_core;
            apply_profile.post_core_prepare += applied.apply_profile.post_core_prepare;
            apply_profile.certification += applied.apply_profile.certification;
            apply_profile.settlement_attach += applied.apply_profile.settlement_attach;
            apply_profile.post_cert_j += applied.apply_profile.post_cert_j;
            apply_profile.entity_groups = apply_profile.entity_groups.saturating_add(1);
            apply_profile.entity_txs_selected = apply_profile
                .entity_txs_selected
                .saturating_add(applied.apply_profile.entity_txs_selected);
            apply_profile.account_inputs = apply_profile
                .account_inputs
                .saturating_add(applied.apply_profile.account_inputs);
            apply_profile.settlement_hankos = apply_profile
                .settlement_hankos
                .saturating_add(applied.apply_profile.settlement_hankos);
            apply_profile.post_cert_j_actions = apply_profile
                .post_cert_j_actions
                .saturating_add(applied.apply_profile.post_cert_j_actions);
            if let Some(context) = applied.evicted_context.take() {
                evicted_contexts
                    .entry((context.0, context.1))
                    .or_insert(context.2);
            }
            let entity_id_text = state_entity_id(&applied.state.entity);
            if applied.outputs.is_some() {
                outputs.touches.entity_ids.push(entity_id_text.clone());
            }
            outputs.touches.accounts.extend(applied.touched_accounts);
            if applied.book_touched {
                outputs.touches.book_entity_ids.push(entity_id_text.clone());
            }
            // These two counters measure real fitter/Entity work, including
            // transient cascade frames. Authority stays external-input-only:
            // derived groups are forbidden below from adding entity_inputs,
            // canonical_wire_bytes, or AppliedRuntimeFrame.entity_inputs.
            frame.receipt.entity_txs_selected = frame
                .receipt
                .entity_txs_selected
                .checked_add(applied.selected_count)
                .ok_or(RuntimeMachineError::InputCountOverflow)?;
            frame.receipt.entity_txs_pending = frame
                .receipt
                .entity_txs_pending
                .checked_add(applied.pending_count)
                .ok_or(RuntimeMachineError::InputCountOverflow)?;
            if cause != PendingEntityCause::External && applied.synthetic_input.is_some() {
                return Err(RuntimeMachineError::EntityStateMap(
                    "RUNTIME_CROSS_J_DERIVED_INPUT_BECAME_DURABLE".into(),
                ));
            }
            if let Some(canonical) = applied.synthetic_input {
                let wire_bytes = crate::transport::msgpack::encode_transport(&canonical)
                    .map_err(|error| {
                        RuntimeMachineError::SyntheticEntityInputEncoding(error.to_string())
                    })?
                    .len();
                frame.receipt.entity_inputs = frame
                    .receipt
                    .entity_inputs
                    .checked_add(1)
                    .ok_or(RuntimeMachineError::InputCountOverflow)?;
                frame.receipt.canonical_wire_bytes = frame
                    .receipt
                    .canonical_wire_bytes
                    .checked_add(wire_bytes)
                    .ok_or(RuntimeMachineError::WireBytesOverflow)?;
                synthetic_inputs.push(canonical);
            }
            account_commits.extend(applied.account_commits);
            for action in &applied.post_commit_j_actions {
                if let crate::j_submit::DurableJAttempt::Governance(attempt) = action {
                    crate::j_submit::register_governance_attempt(&mut replica, attempt)
                        .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
                }
            }
            post_commit_j_attempts.extend(applied.post_commit_j_actions);
            if let Some(mut entity_output) = applied.outputs {
                let immediate = collect_immediate_cross_j_commands(
                    &entity_id_text,
                    &key.signer_id,
                    &local_keys,
                    &mut entity_output.local_entity_outputs,
                )?;
                derived_groups.extend(
                    immediate
                        .into_iter()
                        .map(immediate_cross_j_group)
                        .collect::<Result<Vec<_>, _>>()?,
                );
                last_output_by_entity.insert(key.clone(), outputs.entities.len());
                outputs.entities.push(entity_output);
            }
            if staged
                .insert(
                    key.clone(),
                    EntityApplySlot {
                        state: applied.state,
                        replica: applied.replica,
                    },
                )
                .is_some()
            {
                return Err(RuntimeMachineError::EntityStateMap(
                    "STAGED_ENTITY_SLOT_ALREADY_PRESENT".into(),
                ));
            }
            if cause != PendingEntityCause::AccountWork {
                for (ready_key, ready_slot) in &staged {
                    if !ready_slot.replica.signer_id.trim().eq_ignore_ascii_case(
                        ready_slot
                            .replica
                            .entity_consensus
                            .state
                            .authority
                            .leader_state
                            .active_validator_id
                            .trim(),
                    ) || !ready_slot.replica.accounts.has_proposable_accounts()?
                        || derived_groups.iter().any(|group| {
                            group.cause == PendingEntityCause::AccountWork
                                && group.entity_id == ready_key.entity_id
                                && group.signer_id == ready_key.signer_id
                        })
                        || segments.iter().any(|segment| {
                            segment.groups.iter().any(|group| {
                                group.cause == PendingEntityCause::AccountWork
                                    && group.entity_id == ready_key.entity_id
                                    && group.signer_id == ready_key.signer_id
                            })
                        })
                    {
                        continue;
                    }
                    derived_groups.push(account_work_group(ready_key.clone()));
                }
            }
        }
        enqueue_derived_groups(&mut segments, derived_groups);
    }
    // A dynamic local cascade can revisit an Entity after any earlier output,
    // so only the final touched output may carry that Entity's checkpoint.
    for (key, output_index) in last_output_by_entity {
        let slot = staged.get_mut(&key).ok_or_else(|| {
            RuntimeMachineError::EntityStateMap("FINAL_ENTITY_SLOT_MISSING".into())
        })?;
        if slot.replica.entity_mempool.is_empty()
            && super::materialization_due(
                next_height,
                slot.replica.last_materialized_height,
                replica.limits.checkpoint_period_frames,
            )
        {
            if outputs.entities[output_index].checkpoint.is_some() {
                return Err(RuntimeMachineError::EntityStateMap(
                    "RUNTIME_CROSS_J_INTERMEDIATE_CHECKPOINT_PRESENT".into(),
                ));
            }
            outputs.entities[output_index].checkpoint =
                Some(slot.replica.accounts.export_checkpoint()?);
            slot.replica.last_materialized_height = next_height;
        }
    }
    for key in entity_order {
        let slot = staged.remove(&key).ok_or_else(|| {
            RuntimeMachineError::EntityStateMap("FINAL_ENTITY_SLOT_MISSING".into())
        })?;
        replica.install_entity_slot(key, slot.state, slot.replica)?;
    }
    if !staged.is_empty() {
        return Err(RuntimeMachineError::EntityStateMap(
            "ENTITY_SEGMENT_EXECUTION_INCOMPLETE".into(),
        ));
    }
    for (key, height) in evicted_contexts.keys() {
        if outputs.entities.iter().any(|output| {
            output.entity_id == key.entity_id
                && output.signer_id == key.signer_id
                && output.entity_frame_height == *height
        }) {
            continue;
        }
        if materializer.is_none() {
            frame
                .frame
                .entity_contexts
                .get_mut(key)
                .and_then(|contexts| contexts.pop_front())
                .ok_or_else(|| {
                    RuntimeMachineError::EntityContextMaterialization(
                        "ENTITY_REPLAY_REJECTED_CONTEXT_MISSING".into(),
                    )
                })?;
        }
    }
    if let Some((key, contexts)) = frame
        .frame
        .entity_contexts
        .iter()
        .find(|(_, contexts)| !contexts.is_empty())
    {
        return Err(RuntimeMachineError::EntityContextMaterialization(format!(
            "ENTITY_REPLAY_CONTEXT_UNCONSUMED:{}:{}:{}:emitted={}",
            render_word(&key.entity_id),
            key.signer_id,
            contexts.len(),
            outputs
                .entities
                .iter()
                .map(|output| format!(
                    "{}@{}={}:events={:?}:out={}",
                    render_word(&output.entity_id),
                    output.entity_frame_height,
                    output.entity_frame_hash,
                    output.entity_frame_events,
                    output.local_entity_outputs.len(),
                ))
                .collect::<Vec<_>>()
                .join("|"),
        )));
    }
    for ((key, height), context) in evicted_contexts {
        if let Some(output) = outputs.entities.iter().find(|output| {
            output.entity_id == key.entity_id
                && output.signer_id == key.signer_id
                && output.entity_frame_height == height
        }) {
            if output.entity_context != context.canonical {
                return Err(RuntimeMachineError::EntityContextMaterialization(format!(
                    "RUNTIME_ENTITY_CONTEXT_COLLISION:{}:{}:{height}",
                    render_word(&key.entity_id),
                    key.signer_id
                )));
            }
            continue;
        }
        frame
            .frame
            .entity_contexts
            .entry(key)
            .or_default()
            .push_back(context);
    }
    crate::j_submit::prune_completed_prepared_attempts(&mut replica)
        .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
    replica.state.height = next_height;
    replica.state.timestamp = frame.frame.timestamp;
    replica.state.finalized_j_height = frame.frame.finalized_j_height;

    let mut canonical_entity_inputs = canonical_slots
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(RuntimeMachineError::InputCountOverflow)?;
    canonical_entity_inputs.extend(synthetic_inputs);
    let entity_frame_count = outputs.entities.len();
    Ok(RuntimeApplyResult {
        replica,
        applied_input: Some(frame.receipt),
        applied_frame: Some(AppliedRuntimeFrame {
            runtime_txs: frame.runtime_txs,
            entity_inputs: canonical_entity_inputs,
            frame: frame.frame,
            entity_frame_count,
        }),
        outputs,
        account_commits,
        post_commit_j_attempts,
        apply_profile: finish_runtime_apply_profile(
            profile_enabled,
            profile_started,
            next_height,
            apply_profile,
        ),
    })
}

// Storage book touches track concrete book rows, not orderbook configuration.
// In particular initOrderbookExt creates metadata but no book row.
fn book_commitments(
    state: &xln_rscore_entity_kernel::EntityStateSlice,
) -> Result<BTreeMap<String, String>, RuntimeMachineError> {
    state
        .orderbook
        .as_ref()
        .into_iter()
        .flat_map(|book| book.books.iter())
        .map(|(pair, book)| {
            xln_rscore_entity_kernel::compute_book_commitment_hash(book)
                .map(|hash| (pair.clone(), hash))
                .map_err(RuntimeMachineError::EntityFinancial)
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn apply_entity_group(
    mut slot: EntityApplySlot,
    mut group: PendingEntityGroup,
    runtime_height: u64,
    frame: &mut RuntimeFrameContext,
    j_replicas: &serde_json::Value,
    infrastructure: &serde_json::Value,
    proposer_runtime_seed: &str,
    runtime_id: &str,
    prepared_materialization: Option<MaterializationAdmission>,
    limits: super::RuntimeLimits,
    allow_checkpoint: bool,
    cross_j_opening_sibling_views: Vec<xln_rscore_entity_kernel::CrossJOpeningSiblingEntityView>,
    materializer: &mut Option<&mut dyn EntityInfraMaterializer>,
    profile_enabled: bool,
) -> Result<AppliedEntityGroup, RuntimeMachineError> {
    let mut apply_profile = RuntimeApplyPhaseProfile::default();
    let group_key = RuntimeEntityKey::new(group.entity_id, &group.signer_id)?;
    let resident_root = slot.replica.accounts.accounts_root();
    if slot.state.accounts_root != resident_root {
        return Err(RuntimeMachineError::AccountsRootMismatch {
            committed: slot.state.accounts_root,
            resident: resident_root,
        });
    }
    let next_entity_height = slot
        .state
        .entity
        .height
        .checked_add(1)
        .ok_or(RuntimeMachineError::EntityHeightOverflow)?;
    // TS appends materializations before signing consecutive fresh individual
    // inputs. A retained or already-signed command remains a nonce boundary.
    materialize_local_open_accounts(&mut group.pending, &slot, proposer_runtime_seed, runtime_id)?;
    let stale_prefix = refresh_stale_j_prefix(&slot, &mut group)?;
    if stale_prefix
        && group.j_observation.is_none()
        && group.pending.is_empty()
        && group.wake.is_none()
        && slot.replica.entity_mempool.is_empty()
    {
        return Ok(AppliedEntityGroup {
            evicted_context: None,
            state: slot.state,
            replica: slot.replica,
            outputs: None,
            account_commits: Vec::new(),
            touched_accounts: Vec::new(),
            book_touched: false,
            synthetic_input: None,
            selected_count: 0,
            pending_count: 0,
            post_commit_j_actions: Vec::new(),
            apply_profile,
        });
    }
    let append_to_fresh_individual_run = pending_ends_in_individual_run(&group.pending);
    let retained_entity_work = slot.replica.entity_mempool.len();
    append_entity_pending_work(&mut slot.replica.entity_mempool, group.pending)?;
    let mut synthetic_input = None;
    if let Some(scheduled) = group.wake.as_ref().and_then(|wake| wake.scheduled.as_ref()) {
        if !group.recorded_scheduled_wake {
            let (tx, canonical) = scheduled_wake_entity_input(group.entity_id, scheduled)?;
            slot.replica
                .entity_mempool
                .push_front(EntityPendingWork::Projected(tx));
            synthetic_input = Some(canonical);
        }
    } else if group.input_positions.is_empty() && group.wake.is_some() {
        synthetic_input = Some(empty_entity_input(group.entity_id, &group.signer_id));
    }

    let prepared_j_range = group
        .j_observation
        .as_ref()
        .map(|observation| prepare_j_prefix_range(&slot, observation))
        .transpose()?;
    if let Some(prepared) = prepared_j_range.as_ref() {
        let position = usize::from(
            slot.replica
                .entity_mempool
                .front()
                .and_then(EntityPendingWork::scheduled_wake)
                .is_some(),
        );
        slot.replica
            .entity_mempool
            .insert(position, EntityPendingWork::Projected(prepared.tx.clone()));
    }

    let j_prefix_attestable_height = local_j_prefix_attestable_height(
        &slot.replica.replica_metadata,
        slot.state.entity.last_finalized_j_height,
        slot.state.entity.j_history_finality.is_some(),
    )
    .map_err(|error| {
        RuntimeMachineError::ReplicaMetadata(format!("J_PREFIX_HISTORY_DECODE:{error}"))
    })?;
    let j_prefix_pending_local_event =
        j_prefix_attestable_height != Some(slot.state.entity.last_finalized_j_height);
    // A prior header-only watcher input advances the authenticated local
    // head. Its first subsequent Entity frame must include the signed j_event
    // before Account work, even when that J range contains no events.
    let cached_header_range = if prepared_j_range.is_none()
        && j_prefix_attestable_height
            .is_some_and(|height| height > slot.state.entity.last_finalized_j_height)
    {
        match complete_local_j_prefix_observation(&slot.state, &slot.replica, None, true)? {
            Some(observation) if observation.batches.is_empty() => {
                let prepared = prepare_j_prefix_range(&slot, &observation)?;
                Some((observation, prepared))
            }
            _ => None,
        }
    } else {
        None
    };
    if let Some((_, prepared)) = cached_header_range.as_ref() {
        let position = usize::from(
            slot.replica
                .entity_mempool
                .front()
                .and_then(EntityPendingWork::scheduled_wake)
                .is_some(),
        );
        slot.replica
            .entity_mempool
            .insert(position, EntityPendingWork::Projected(prepared.tx.clone()));
    }
    let parent_frame_hash = slot
        .replica
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .map_or("genesis", |head| head.frame.hash.as_str());
    let fit_j_prefix_certificate = build_required_j_prefix_certificate(
        &slot.replica.entity_signer,
        &slot.replica.entity_consensus.state.authority,
        &slot.state.entity,
        next_entity_height,
        parent_frame_hash,
        prepared_j_range
            .as_ref()
            .map(|prepared| &prepared.claim)
            .or_else(|| {
                cached_header_range
                    .as_ref()
                    .map(|(_, prepared)| &prepared.claim)
            }),
    )
    .map_err(EntityTransitionError::from)?;
    if j_prefix_pending_local_event
        && prepared_j_range.is_none()
        && cached_header_range.is_none()
        && fit_j_prefix_certificate.is_some()
    {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_PREFIX_PENDING_RANGE_WITHOUT_OBSERVATION:entity={}:signer={}:entityHeight={}:baseHeight={}:attestableHeight={:?}:runtimeHeight={runtime_height}",
            render_word(&group_key.entity_id),
            group_key.signer_id,
            slot.state.entity.height,
            slot.state.entity.last_finalized_j_height,
            j_prefix_attestable_height,
        )));
    }

    // A derived AccountWork group is the TS `queueCommittedAccountWork`
    // preview: it may propose already-admitted Account mempool work, but it
    // never consumes or materializes an unrelated Entity intent. The latter
    // remains FIFO for the next real Entity input.
    let account_work_only = group.cause == PendingEntityCause::AccountWork;
    // The caller already performed admission for deferred flushes and
    // potentially-idle wakes. Reuse that exact result for this group.
    let materialization_admission = match prepared_materialization {
        Some(admission) => admission,
        None if account_work_only => MaterializationAdmission::default(),
        None => enqueue_proposer_materializations(
            &mut slot,
            proposer_runtime_seed,
            frame.timestamp,
            append_to_fresh_individual_run,
        )?,
    };
    let has_local_authored_work = materialization_admission.requires_commit_phase_selection()
        && slot
            .replica
            .entity_mempool
            .iter()
            .any(|work| matches!(work, EntityPendingWork::LocalBatch { .. }));
    let local_author = has_local_authored_work
        .then(|| command_board(&slot))
        .transpose()?
        .map(|board| {
            format!(
                "{}:{}:{}",
                board.board_hash, board.board_epoch, board.signer_id
            )
            .to_lowercase()
        });
    let selected_entity_mempool = take_entity_mempool_for_group(
        group.cause,
        retained_entity_work,
        &mut slot.replica.entity_mempool,
    )?;
    let mut commit_phase_work = select_commit_phase_work(
        selected_entity_mempool,
        &materialization_admission,
        local_author.as_deref(),
    )?;
    let mut replay_attempt_context: Option<RuntimeEntityFrameContext> = None;
    let (
        selected_count,
        selected,
        context,
        entity_context_bytes,
        mut core,
        profiled_account_inputs,
        prior_orderbook_digest,
    ) = loop {
        let fit_started = profile_enabled.then(Instant::now);
        let (selected_count, mut context, entity_context_bytes) = match materializer.as_deref_mut()
        {
            Some(materializer) => {
                let (count, materialized, entity_context_bytes) = fit_live_entity_prefix(
                    &mut slot,
                    &commit_phase_work.selected,
                    frame,
                    materializer,
                    fit_j_prefix_certificate.as_ref(),
                    entity_encryption_seed(infrastructure, &render_word(&group.entity_id))?,
                )?;
                (
                    count,
                    RuntimeEntityFrameContext {
                        execution: materialized.execution,
                        canonical: materialized.canonical,
                    },
                    entity_context_bytes,
                )
            }
            None => {
                let context = replay_attempt_context.as_ref().or_else(|| frame
                .entity_contexts
                .get(&group_key)
                .and_then(|contexts| contexts.front()))
                .ok_or_else(|| {
                    RuntimeMachineError::EntityContextMaterialization(format!(
                        "ENTITY_REPLAY_CONTEXT_MISSING:{}:runtimeHeight={runtime_height}:entityHeight={}:cause={:?}:selectedWork={}",
                        render_word(&group.entity_id),
                        slot.state.entity.height,
                        group.cause,
                        commit_phase_work.selected.len(),
                    ))
                })?;
                let (count, entity_context_bytes) = fit_replay_entity_prefix(
                    &slot,
                    &commit_phase_work.selected,
                    frame,
                    &context.canonical,
                    fit_j_prefix_certificate.as_ref(),
                )?;
                let context = match replay_attempt_context.as_ref() {
                    Some(context) => context.clone(),
                    None => {
                        let context = frame
                            .entity_contexts
                            .get_mut(&group_key)
                            .and_then(|contexts| contexts.front().cloned())
                            .ok_or_else(|| {
                                RuntimeMachineError::EntityContextMaterialization(
                                    "ENTITY_REPLAY_CONTEXT_CONSUME".into(),
                                )
                            })?;
                        replay_attempt_context = Some(context.clone());
                        context
                    }
                };
                (count, context, entity_context_bytes)
            }
        };
        apply_profile.fit = profiled_elapsed(fit_started);
        apply_profile.entity_txs_selected = selected_count;
        let mut attempt_work = commit_phase_work
            .selected
            .iter()
            .take(selected_count)
            .cloned()
            .collect();
        let mut selected = take_entity_prefix(&slot, &mut attempt_work, selected_count)?;
        let mut rows = std::mem::take(&mut selected.rows);
        for (expected, row) in rows.iter_mut().enumerate() {
            row.operation_index =
                u64::try_from(expected).map_err(|_| RuntimeMachineError::InputCountOverflow)?;
            row.resolve_certified_boards(&slot.state.certified_board_authority())?;
        }
        attach_inbound_genesis_policies(
            &mut rows,
            &slot.state.entity.known_accounts,
            slot.replica
                .entity_consensus
                .state
                .authority
                .config
                .jurisdiction
                .as_ref(),
            j_replicas,
        )?;
        apply_profile.account_inputs = rows.len();
        let profiled_account_inputs = profile_account_input_outcomes_enabled().then(|| {
            rows.iter()
                .map(|row| ProfileAccountInputKind::from(&row.input.kind))
                .collect::<Vec<_>>()
        });
        let needs_local_account_genesis =
            selected.operations.iter().any(|operation| match operation {
                ResidentEntityOperation::Local(txs) => txs.iter().any(|admitted| {
                    match &admitted.tx {
                        LocalEntityTx::Financial(xln_rscore_entity_kernel::LocalEntityFinancialTx::OpenAccount(_)) => true,
                        LocalEntityTx::Control(xln_rscore_entity_kernel::LocalEntityControlTx::Propose(proposal)) => {
                            canonical_field(&proposal.action, "data")
                                .and_then(|data| canonical_field(data, "txs"))
                                .is_some_and(|value| matches!(value, CanonicalValue::Array(txs)
                                    if txs.iter().any(|tx| matches!(canonical_field(tx, "type"),
                                        Some(CanonicalValue::String(kind)) if kind == "openAccount"))))
                        }
                        _ => false,
                    }
                }),
                ResidentEntityOperation::AccountRange { .. } => false,
            });
        let local_account_genesis_policy = needs_local_account_genesis
            .then(|| {
                derive_policy(
                    slot.replica
                        .entity_consensus
                        .state
                        .authority
                        .config
                        .jurisdiction
                        .as_ref()
                        .ok_or_else(|| {
                            RuntimeMachineError::InboundGenesisPolicy(
                                "JURISDICTION_REQUIRED".into(),
                            )
                        })?,
                    j_replicas,
                )
            })
            .transpose()?;
        let finalized_j_events = group
            .j_observation
            .as_ref()
            .zip(prepared_j_range.as_ref())
            .or_else(|| {
                cached_header_range
                    .as_ref()
                    .map(|(observation, prepared)| (observation, prepared))
            })
            .map(
                |(observation, prepared)| xln_rscore_entity_kernel::ResidentJEventProjection {
                    scanned_through: observation.scanned_through_height,
                    batches: observation.batches.clone(),
                    runtime_seed: proposer_runtime_seed.to_string(),
                    claim: prepared.claim.clone(),
                    proposer_signer_id: observation.signer_id.clone(),
                    proposer_signature: prepared.signature.clone(),
                },
            );
        // Recovery markers in this exact certified prefix, in frame order.
        // Order is the reducer emission order the Entity flush must preserve;
        // Account ids never choose it.
        let propose_accounts_now = selected
            .txs
            .iter()
            .filter(|tx| tx.kind == EntityTxKind::ProposeAccountsNow)
            .map(|tx| {
                xln_rscore_entity_kernel::decode_propose_accounts_now(&tx.wire_data)
                    .map_err(|error| RuntimeMachineError::EntityTxPayloadInvalid(error.to_string()))
            })
            .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
        let request = ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: group.entity_id,
                expected_accounts_root: resident_root,
                clock: ReceiverClock {
                    entity_timestamp: frame.timestamp,
                    finalized_j_height: frame.finalized_j_height,
                },
                owning_entity_is_hub: slot.state.entity.hub_rebalance_config.is_some(),
                rows,
                post_accounts: false,
            },
            local_certified_board_authority: slot
                .state
                .certified_board_authority()
                .resolve_certified_board(&group.entity_id)?,
            entity_height: next_entity_height,
            outbound_timestamp: frame.timestamp,
            outbound_j_height: finalized_j_events
                .as_ref()
                .map_or(frame.finalized_j_height, |events| events.scanned_through),
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: Some(proposer_runtime_seed.to_string()),
            scheduled_wake: group.wake.as_ref().and_then(|wake| wake.scheduled.clone()),
            propose_accounts_now,
            expected_proposer_signer_id: group.signer_id.clone(),
            finalized_j_events,
            entity_authority: Some(slot.replica.entity_consensus.state.authority.clone()),
            local_account_genesis_policy,
            cross_j_opening_sibling_views: cross_j_opening_sibling_views.clone(),
            operations: std::mem::take(&mut selected.operations),
        };
        let prior_orderbook_digest = book_commitments(&slot.state.entity)?;
        apply_entity_state_policy(
            &mut context.execution,
            &slot.state,
            slot.replica
                .entity_consensus
                .state
                .authority
                .config
                .jurisdiction
                .as_ref(),
        )
        .map_err(|error| RuntimeMachineError::EntityContextMaterialization(error.to_string()))?;
        let resident_core_started = profile_enabled.then(Instant::now);
        // Entity collections are persistent; Account shards own their existing
        // candidate/abort lifecycle. A rejected outer command never publishes
        // its prefix mutations, nonces, roots or ordered outputs.
        let core = match apply_resident_entity_round_core(
            &mut slot.replica.accounts,
            slot.state.entity.clone(),
            request,
            &context.execution,
        ) {
            // Owner canon (AGENTS.md REJECT POLICY): an authenticated peer
            // Account input the Account engine rejected is a sender-caused
            // reject, never a halt. The kernel already wrote the
            // `[ERROR][reject]` audit line and aborted the round, so nothing it
            // touched was published and no env is read here. TS
            // `buildEntityProposalEvictingRejected` evicts one rejected tx per
            // attempt and rebuilds the frame; mirror that exactly — evict the
            // first reject's parent `accountInput` tx and rebuild, letting the
            // retry surface any further reject.
            Ok(core) if !core.rejected_inbound_inputs.is_empty() => {
                let reject = &core.rejected_inbound_inputs[0];
                let row_index = usize::try_from(reject.operation_index)
                    .map_err(|_| RuntimeMachineError::InputCountOverflow)?;
                // A rejected row names one parent `accountInput` transaction.
                // `operation_work_indices` is keyed by operation and a merged
                // `AccountRange` covers many rows, so it would evict the range's
                // first tx instead of the failing one.
                let work_index = *selected
                    .row_work_indices
                    .get(row_index)
                    .ok_or(RuntimeMachineError::InputCountOverflow)?;
                commit_phase_work.evict_selected(work_index)?;
                eprintln!(
                    "RSCORE_ENTITY_INBOUND_INPUT_EVICTED:entity={}:work={work_index}:row={row_index}:account={}:{}:{}",
                    slot.state.entity.entity_id, reject.account_id, reject.verdict, reject.reason
                );
                if commit_phase_work.selected.is_empty() {
                    slot.replica.entity_mempool = commit_phase_work.into_remaining()?;
                    let pending_count = slot.replica.entity_mempool.len();
                    return Ok(AppliedEntityGroup {
                        evicted_context: Some((group_key, next_entity_height, context)),
                        state: slot.state,
                        replica: slot.replica,
                        outputs: None,
                        account_commits: Vec::new(),
                        touched_accounts: Vec::new(),
                        book_touched: false,
                        synthetic_input,
                        selected_count: 0,
                        pending_count,
                        post_commit_j_actions: Vec::new(),
                        apply_profile,
                    });
                }
                continue;
            }
            Ok(core) => core,
            // Frame-shape refusal, never a halt. This frame's certified J range
            // activates a counterparty's board, so it may not also carry that
            // counterparty's `accountInput`: the two engines resolve the row's
            // certified board on opposite sides of the frame's J ingress and
            // would fork silently. TS defers the same row at proposal
            // (`withoutCounterpartyBoardActivationConflicts`) and refuses the
            // shape at frame validation; defer it here and rebuild, so the row
            // is proposed again once the activation is committed.
            Err(
                xln_rscore_entity_kernel::ResidentEntityError::CounterpartyBoardActivationMixed {
                    row_index,
                    counterparty,
                },
            ) => {
                let work_index = *selected
                    .row_work_indices
                    .get(row_index)
                    .ok_or(RuntimeMachineError::InputCountOverflow)?;
                commit_phase_work.defer_selected(work_index)?;
                eprintln!(
                    "RSCORE_ENTITY_COUNTERPARTY_BOARD_ACTIVATION_DEFERRED:entity={}:work={work_index}:row={row_index}:counterparty={counterparty}",
                    slot.state.entity.entity_id
                );
                if commit_phase_work.selected.is_empty() {
                    slot.replica.entity_mempool = commit_phase_work.into_remaining()?;
                    let pending_count = slot.replica.entity_mempool.len();
                    return Ok(AppliedEntityGroup {
                        evicted_context: Some((group_key, next_entity_height, context)),
                        state: slot.state,
                        replica: slot.replica,
                        outputs: None,
                        account_commits: Vec::new(),
                        touched_accounts: Vec::new(),
                        book_touched: false,
                        synthetic_input,
                        selected_count: 0,
                        pending_count,
                        post_commit_j_actions: Vec::new(),
                        apply_profile,
                    });
                }
                continue;
            }
            Err(
                error @ (xln_rscore_entity_kernel::ResidentEntityError::LocalCommandRejected {
                    ..
                }
                | xln_rscore_entity_kernel::ResidentEntityError::InboundAdmissionRejected {
                    ..
                }),
            ) => {
                let (work_index, kind, detail) = match error {
                    xln_rscore_entity_kernel::ResidentEntityError::LocalCommandRejected {
                        operation_index,
                        kind,
                        detail,
                    } => (
                        selected.operation_work_indices.get(operation_index),
                        kind,
                        detail,
                    ),
                    xln_rscore_entity_kernel::ResidentEntityError::InboundAdmissionRejected {
                        row_index,
                        detail,
                    } => (
                        selected.row_work_indices.get(row_index),
                        "accountInput",
                        detail,
                    ),
                    _ => unreachable!("matched typed reject"),
                };
                let work_index = *work_index.ok_or(RuntimeMachineError::InputCountOverflow)?;
                commit_phase_work.evict_selected(work_index)?;
                eprintln!(
                    "RSCORE_ENTITY_OUTER_COMMAND_EVICTED:entity={}:work={work_index}:{kind}:{detail}",
                    slot.state.entity.entity_id
                );
                if commit_phase_work.selected.is_empty() {
                    slot.replica.entity_mempool = commit_phase_work.into_remaining()?;
                    let pending_count = slot.replica.entity_mempool.len();
                    return Ok(AppliedEntityGroup {
                        evicted_context: Some((group_key, next_entity_height, context)),
                        state: slot.state,
                        replica: slot.replica,
                        outputs: None,
                        account_commits: Vec::new(),
                        touched_accounts: Vec::new(),
                        book_touched: false,
                        synthetic_input,
                        selected_count: 0,
                        pending_count,
                        post_commit_j_actions: Vec::new(),
                        apply_profile,
                    });
                }
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        // WAL contexts belong to a certified Entity height, not an attempt.
        // A rejected segment must leave this row available to a later segment
        // at the same height; only a successful candidate consumes it.
        if materializer.is_none() {
            frame
                .entity_contexts
                .get_mut(&group_key)
                .and_then(|contexts| contexts.pop_front())
                .ok_or_else(|| {
                    RuntimeMachineError::EntityContextMaterialization(
                        "ENTITY_REPLAY_CONTEXT_CONSUME".into(),
                    )
                })?;
        }
        apply_profile.resident_core = profiled_elapsed(resident_core_started);
        break (
            selected_count,
            selected,
            context,
            entity_context_bytes,
            core,
            profiled_account_inputs,
            prior_orderbook_digest,
        );
    };
    commit_phase_work.selected.drain(..selected_count);
    commit_phase_work.consume_selected_prefix(selected_count)?;
    if account_work_only {
        if selected_count != 0 || !commit_phase_work.into_remaining()?.is_empty() {
            return Err(RuntimeMachineError::EntityStateMap(
                "RUNTIME_ACCOUNT_WORK_SELECTED_ENTITY_TX".into(),
            ));
        }
    } else if group.cause == PendingEntityCause::CrossJurisdiction {
        if selected_count == 0 || !commit_phase_work.into_remaining()?.is_empty() {
            return Err(RuntimeMachineError::EntityStateMap(
                "RUNTIME_CROSS_J_LOCAL_EVENT_INPUT_NOT_CONSUMED".into(),
            ));
        }
    } else {
        slot.replica.entity_mempool = commit_phase_work.into_remaining()?;
    }
    let pending_count = slot.replica.entity_mempool.len();
    let checkpoint_due = allow_checkpoint
        && slot.replica.entity_mempool.is_empty()
        && super::materialization_due(
            runtime_height,
            slot.replica.last_materialized_height,
            limits.checkpoint_period_frames,
        );
    let post_core_prepare_started = profile_enabled.then(Instant::now);
    let accounts_root = core.outbound.accounts_root;
    if let Some(inputs) = profiled_account_inputs.as_deref() {
        profile_account_input_outcomes(
            runtime_height,
            next_entity_height,
            frame.finalized_j_height,
            accounts_root,
            inputs,
            &core.inbound.applied,
        );
    }
    core.state.entity_command_nonces = selected.command_nonces;
    let account_commits = account_commit_evidence(group.entity_id, &core.inbound.applied);
    let account_count = slot.replica.accounts.account_count();
    let post_authority = resolve_board_handover_authority(
        &slot.replica.entity_consensus.state.authority,
        &group.entity_id,
        next_entity_height,
        &selected.txs,
        group
            .j_observation
            .as_ref()
            .map_or(&[], |observation| observation.batches.as_slice()),
    )
    .map_err(RuntimeMachineError::EntityFinancial)?;
    assert_j_prefix_attestation_certified(
        fit_j_prefix_certificate.as_ref(),
        &group.signer_id,
        group.j_attestation_wire.as_ref(),
    )?;
    let touched_account_ids = core.account_touch_order;
    let account_outputs = core
        .outbound
        .proposals
        .into_iter()
        .filter_map(|proposal| proposal.outbound_input)
        .collect();
    let routed_output_count = core.routed_entity_outputs.len();
    let non_mutating_wakes = core
        .non_mutating_wake_targets
        .into_iter()
        .enumerate()
        .map(|(output_index, target_entity_id)| {
            Ok(PendingNonMutatingWake {
                output_index: u64::try_from(output_index.saturating_add(routed_output_count))
                    .map_err(|_| RuntimeMachineError::InputCountOverflow)?,
                target_entity_id,
            })
        })
        .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
    let j_outputs = std::mem::take(&mut core.j_outputs);
    apply_profile.post_core_prepare = profiled_elapsed(post_core_prepare_started);
    let certification_started = profile_enabled.then(Instant::now);
    let certified = certify_entity_transition(
        &slot.replica.entity_signer,
        slot.replica.entity_consensus,
        EntityTransitionCertificationRequest {
            post_state: &core.state,
            accounts_root,
            account_count,
            txs: selected.txs,
            events: std::mem::take(&mut core.entity_frame_events),
            entity_context: &context.canonical,
            entity_context_bytes,
            j_prefix_certificate: fit_j_prefix_certificate,
            post_authority,
            secondary_hashes: std::mem::take(&mut core.secondary_hashes),
            presigned_manifest: std::mem::take(&mut core.presigned_manifest),
            account_outputs,
            routed_entity_outputs: std::mem::take(&mut core.routed_entity_outputs),
            non_mutating_wakes,
        },
    )?;
    apply_profile.certification = profiled_elapsed(certification_started);
    slot.replica.entity_consensus = certified.consensus;
    // TS commit finalization always clears the vote round to an explicit
    // empty Map; absence and empty are distinct parent Runtime commitments.
    slot.replica
        .replica_metadata
        .as_object_mut()
        .ok_or_else(|| RuntimeMachineError::ReplicaMetadata("OBJECT_REQUIRED".into()))?
        .insert(
            "leaderVotes".into(),
            serde_json::json!({"__xlnType":"Map","value":[]}),
        );
    prune_finalized_j_history(
        &mut slot.replica.replica_metadata,
        core.state.last_finalized_j_height,
    )?;
    let certified_settlement_hankos = std::mem::take(&mut core.pending_settlement_hankos)
        .into_iter()
        .map(|pending| {
            let settlement_hanko = pending
                .draft
                .settlement_hash
                .map(|hash| {
                    let key = render_word(&hash);
                    let witness = certified.manifest_hankos.get(&key).ok_or_else(|| {
                        RuntimeMachineError::EntityContextMaterialization(format!(
                            "SETTLEMENT_MANIFEST_WITNESS_MISSING:{key}"
                        ))
                    })?;
                    if witness.kind != HashType::Settlement {
                        return Err(RuntimeMachineError::EntityContextMaterialization(format!(
                            "SETTLEMENT_MANIFEST_WITNESS_KIND:{key}"
                        )));
                    }
                    Ok(witness.hanko.clone())
                })
                .transpose()?;
            let dispute_key = render_word(&pending.draft.dispute_hash);
            let dispute = certified.manifest_hankos.get(&dispute_key).ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(format!(
                    "SETTLEMENT_DISPUTE_WITNESS_MISSING:{dispute_key}"
                ))
            })?;
            if dispute.kind != HashType::Dispute {
                return Err(RuntimeMachineError::EntityContextMaterialization(format!(
                    "SETTLEMENT_DISPUTE_WITNESS_KIND:{dispute_key}"
                )));
            }
            Ok(CertifiedSettlementHankoDraft {
                pending,
                settlement_hanko,
                dispute_hanko: dispute.hanko.clone(),
            })
        })
        .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
    apply_profile.settlement_hankos = certified_settlement_hankos.len();
    let settlement_attach_started = profile_enabled.then(Instant::now);
    slot.replica
        .accounts
        .attach_certified_settlement_hankos(certified_settlement_hankos)?;
    apply_profile.settlement_attach = profiled_elapsed(settlement_attach_started);
    let post_cert_j_started = profile_enabled.then(Instant::now);
    let prepared_j = crate::j_submit::prepare_certified_entity_j_intents(
        &core.state,
        &mut slot.replica.replica_metadata,
        &slot.replica.signer_id,
        j_outputs,
        &certified.manifest_hankos,
    )
    .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
    let mut post_commit_j_actions = prepared_j
        .retries
        .into_iter()
        .map(|retry| {
            crate::j_submit::DurableJAttempt::ScheduleRuntimeTx(super::RuntimeTx::RetryJSubmit(
                retry,
            ))
        })
        .collect::<Vec<_>>();
    post_commit_j_actions.extend(prepared_j.provider_actions.into_iter().map(|prepared| {
        crate::j_submit::DurableJAttempt::ScheduleRuntimeTx(
            super::RuntimeTx::RetryEntityProviderAction(
                crate::j_submit::RetryEntityProviderActionData {
                    entity_id: prepared.intent.entity_id,
                    signer_id: prepared.signer_id,
                    jurisdiction_name: prepared.jurisdiction_name,
                    action_hash: render_word(&prepared.intent.action_hash),
                    action_nonce: prepared.intent.action_nonce,
                    generation: prepared.intent.generation,
                },
            ),
        )
    }));
    post_commit_j_actions.extend(
        prepared_j
            .governance
            .into_iter()
            .map(crate::j_submit::DurableJAttempt::Governance),
    );
    post_commit_j_actions.extend(
        prepared_j
            .maintenance
            .into_iter()
            .map(crate::j_submit::DurableJAttempt::Maintenance),
    );
    apply_profile.post_cert_j_actions = post_commit_j_actions.len();
    apply_profile.post_cert_j = profiled_elapsed(post_cert_j_started);
    let checkpoint = checkpoint_due
        .then(|| slot.replica.accounts.export_checkpoint())
        .transpose()?;
    if checkpoint.is_some() {
        slot.replica.last_materialized_height = runtime_height;
    }
    let post_orderbook_digest = book_commitments(&core.state)?;
    let touched_accounts = touched_account_ids
        .into_iter()
        .map(|account_id| super::RuntimeTouchedAccount {
            entity_id: state_entity_id(&core.state),
            counterparty_id: render_account_id(&account_id),
        })
        .collect();
    let certified_frame = slot
        .replica
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .map(|head| &head.frame)
        .ok_or_else(|| {
            RuntimeMachineError::EntityStateMap("CERTIFIED_ENTITY_FRAME_MISSING".into())
        })?;
    if certified_frame.state_root != certified.state_root
        || certified_frame.authority_root != certified.authority_root
    {
        return Err(RuntimeMachineError::EntityStateMap(
            "CERTIFIED_ENTITY_FRAME_OUTPUT_DIVERGED".into(),
        ));
    }
    let outputs = RuntimeEntityOutputs {
        entity_id: group.entity_id,
        signer_id: group.signer_id,
        entity_frame_height: certified_frame.height,
        entity_frame_timestamp: certified_frame.timestamp,
        entity_frame_hash: certified_frame.hash.clone(),
        entity_frame_events: certified_frame.events.clone(),
        entity_context: context.canonical,
        accounts_root,
        entity_events: core.outputs,
        local_entity_outputs: certified.local_outputs,
        atomic_cross_jurisdiction_pair: group.atomic_output_pair,
        entity_state_root: certified.state_root,
        entity_authority_root: certified.authority_root,
        checkpoint,
    };
    slot.state = RuntimeEntityState {
        accounts_root,
        entity: core.state,
    };
    Ok(AppliedEntityGroup {
        evicted_context: None,
        state: slot.state,
        replica: slot.replica,
        outputs: Some(outputs),
        account_commits,
        touched_accounts,
        book_touched: prior_orderbook_digest != post_orderbook_digest,
        synthetic_input,
        selected_count,
        pending_count,
        post_commit_j_actions,
        apply_profile,
    })
}

fn state_entity_id(state: &xln_rscore_entity_kernel::EntityStateSlice) -> String {
    state.entity_id.to_ascii_lowercase()
}

fn render_account_id(account_id: &AccountId) -> String {
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in account_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn apply_runtime_txs(
    replica: &mut crate::RuntimeReplica,
    txs: &[super::RuntimeTx],
    current_timestamp: u64,
) -> Result<(Vec<crate::j_submit::DurableJAttempt>, Vec<String>), RuntimeMachineError> {
    let mut attempts = Vec::new();
    let mut touched_entities = Vec::new();
    for tx in txs {
        match tx {
            super::RuntimeTx::CheckpointBarrier => {}
            super::RuntimeTx::RecordRuntimeAdapterCommand(value) => {
                apply_runtime_adapter_command_marker(replica, value, current_timestamp)?;
            }
            super::RuntimeTx::ImportReplica(input) => {
                touched_entities.push(
                    crate::entity_import::apply(replica, input, current_timestamp)
                        .map_err(RuntimeMachineError::ReplicaMetadata)?,
                );
            }
            super::RuntimeTx::ImportJ(request) => {
                crate::j_import::apply_import_intent(&mut replica.durable, request)
                    .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
            }
            super::RuntimeTx::ReplaceNumberedRegistrationIntent(value) => {
                crate::registration_replacement::apply(&mut replica.durable, value)
                    .map_err(RuntimeMachineError::ReplicaMetadata)?;
            }
            super::RuntimeTx::RecordAuthenticatedJAuthority(evidence) => {
                crate::j_authority::apply(&mut replica.durable, evidence)
                    .map_err(RuntimeMachineError::ReplicaMetadata)?;
            }
            super::RuntimeTx::CompleteImportJ(result) => {
                crate::j_import::apply_import_result(&mut replica.durable, result)
                    .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
            }
            super::RuntimeTx::ObserveJRange(value) => {
                let (state, live) = replica
                    .entity_slot_mut(value.entity_id.as_bytes(), &value.signer_id)
                    .ok_or_else(|| {
                        RuntimeMachineError::ReplicaMetadata(
                            "J_HISTORY_LOCAL_REPLICA_MISSING".into(),
                        )
                    })?;
                if record_j_observation(state, live, value)? {
                    touched_entities.push(render_word(value.entity_id.as_bytes()));
                }
            }
            super::RuntimeTx::AdvanceJWatcherCursor {
                depository_address,
                chain_id,
                block_number,
            } => replica.durable.advance_j_watcher_cursor(
                depository_address,
                *chain_id,
                *block_number,
            )?,
            super::RuntimeTx::RewindJHistory(value) => {
                let (state, live) = replica
                    .entity_slot_mut(&value.entity_id, &value.signer_id)
                    .ok_or_else(|| {
                        RuntimeMachineError::ReplicaMetadata(
                            "J_HISTORY_LOCAL_REPLICA_MISSING".into(),
                        )
                    })?;
                record_j_rewind(state, live, value)?;
                touched_entities.push(render_word(&value.entity_id));
            }
            super::RuntimeTx::RetryJSubmit(retry) => {
                if let Some(attempt) =
                    crate::j_submit::apply_j_submit_retry(replica, retry, current_timestamp)
                        .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?
                {
                    attempts.push(attempt.into());
                }
            }
            super::RuntimeTx::RetryEntityProviderAction(retry) => {
                if let Some(attempt) = crate::j_submit::apply_entity_provider_action_retry(
                    replica,
                    retry,
                    current_timestamp,
                )
                .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?
                {
                    attempts.push(attempt.into());
                }
            }
            super::RuntimeTx::RecordEntityProviderActionSubmitResult(result) => {
                crate::j_submit::apply_entity_provider_action_result(
                    replica,
                    result,
                    current_timestamp,
                )
                .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
            }
            super::RuntimeTx::ReplaceJPreparedTransaction(prepared) => {
                if let Some(attempt) =
                    crate::j_submit::apply_j_prepared_replacement(replica, prepared)
                        .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?
                {
                    attempts.push(attempt.into());
                }
            }
            super::RuntimeTx::RecordJPreparedTransaction(prepared) => {
                if let Some(attempt) =
                    crate::j_submit::apply_j_prepared_transaction(replica, prepared)
                        .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?
                {
                    attempts.push(attempt.into());
                }
            }
            super::RuntimeTx::RecordJSubmitResult(result) => {
                crate::j_submit::apply_j_submit_result(replica, result, current_timestamp)
                    .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
            }
            super::RuntimeTx::RecordGovernanceJSubmitResult(result) => {
                crate::j_submit::apply_governance_result(replica, result, current_timestamp)
                    .map_err(|error| RuntimeMachineError::JSubmit(error.to_string()))?;
            }
            super::RuntimeTx::Unsupported { kind } => {
                return Err(RuntimeMachineError::UnsupportedRuntimeTx { kind: kind.clone() });
            }
        }
    }
    Ok((attempts, touched_entities))
}

const MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES: usize = 1_024;

fn apply_runtime_adapter_command_marker(
    replica: &mut crate::RuntimeReplica,
    marker: &crate::RuntimeAdapterCommandMarker,
    current_timestamp: u64,
) -> Result<(), RuntimeMachineError> {
    let infrastructure = replica
        .durable
        .infrastructure_mut()
        .as_object_mut()
        .ok_or_else(|| RuntimeMachineError::ReplicaMetadata("INFRASTRUCTURE_OBJECT".into()))?;
    let tagged = infrastructure
        .entry("runtimeAdapterCommandFrontiers")
        .or_insert_with(|| serde_json::json!({"__xlnType":"Map","value":[]}));
    let tagged = tagged.as_object_mut().ok_or_else(|| {
        RuntimeMachineError::ReplicaMetadata("RADAPTER_COMMAND_FRONTIERS_OBJECT".into())
    })?;
    if tagged.get("__xlnType").and_then(serde_json::Value::as_str) != Some("Map") {
        return Err(RuntimeMachineError::ReplicaMetadata(
            "RADAPTER_COMMAND_FRONTIERS_TAG".into(),
        ));
    }
    let rows = tagged
        .get_mut("value")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("RADAPTER_COMMAND_FRONTIERS_ROWS".into())
        })?;
    rows.retain(|row| {
        let Some(pair) = row.as_array().filter(|pair| pair.len() == 2) else {
            return true;
        };
        if pair[0].as_str() == Some(marker.lane_id.as_str()) {
            return true;
        }
        pair[1]
            .get("expiresAtMs")
            .and_then(serde_json::Value::as_u64)
            .is_none_or(|expiry| expiry > current_timestamp)
    });
    let existing_index = rows.iter().position(|row| {
        row.as_array()
            .filter(|pair| pair.len() == 2)
            .and_then(|pair| pair[0].as_str())
            == Some(marker.lane_id.as_str())
    });
    let prior_sequence = existing_index
        .and_then(|index| rows[index].get(1))
        .and_then(|value| value.get("lastContiguousSequence"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let expected = prior_sequence
        .checked_add(1)
        .ok_or(RuntimeMachineError::HeightOverflow)?;
    if marker.sequence != expected {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "RADAPTER_COMMAND_FRONTIER_NONCONTIGUOUS:lane={}:expected={expected}:actual={}",
            marker.lane_id, marker.sequence
        )));
    }
    if existing_index.is_none() && rows.len() >= MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "RADAPTER_COMMAND_FRONTIER_CAPACITY_EXCEEDED:{}",
            rows.len()
        )));
    }
    let frontier = serde_json::json!({
        "lastContiguousSequence": marker.sequence,
        "lastInputHash": marker.input_hash,
        "lastCommandId": marker.command_id,
        "observedHeight": replica.state.height.checked_add(1).ok_or(RuntimeMachineError::HeightOverflow)?,
        "expiresAtMs": marker.expires_at_ms,
    });
    match existing_index {
        Some(index) => rows[index] = serde_json::json!([marker.lane_id, frontier]),
        None => rows.push(serde_json::json!([marker.lane_id, frontier])),
    }
    replica.durable.invalidate_infrastructure_digest();
    Ok(())
}

fn record_j_rewind(
    state: &mut crate::RuntimeEntityState,
    replica: &mut crate::RuntimeEntityReplica,
    rewind: &crate::RewindJHistory,
) -> Result<(), RuntimeMachineError> {
    let source = replica
        .replica_metadata
        .as_object_mut()
        .ok_or_else(|| RuntimeMachineError::ReplicaMetadata("OBJECT_REQUIRED".into()))?;
    let history = source
        .get("jHistory")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_REWIND_TARGET_HISTORY_MISSING".into())
        })?;
    let history_ref = history
        .get("jurisdictionRef")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCAL_JURISDICTION_CORRUPTION".into())
        })?;
    if history_ref != rewind.jurisdiction_ref {
        return Err(RuntimeMachineError::ReplicaMetadata(
            "J_HISTORY_REWIND_JURISDICTION_MISMATCH".into(),
        ));
    }
    let anchor = certified_j_anchor(&state.entity)?;
    if anchor
        .as_ref()
        .is_some_and(|(height, _, _)| rewind.conflicting_height <= *height)
    {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_FINALIZED_REORG:{}",
            rewind.conflicting_height
        )));
    }
    if locked_frame_covers_j_height(source.get("lockedFrame"), rewind.conflicting_height)? {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_SIGNED_LOCK_REORG:entity={}:signer={}:jHeight={}",
            render_word(&rewind.entity_id),
            rewind.signer_id,
            rewind.conflicting_height
        )));
    }
    let Some((height, hash, jurisdiction_ref)) = anchor else {
        source.remove("jHistory");
        return Ok(());
    };
    let hashes = tagged_height_map(history.get("blockHashes"), "blockHashes")?;
    if let Some(local_hash) = hashes.get(&height).and_then(serde_json::Value::as_str)
        && parse_hex32(local_hash) != Some(hash)
    {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_FINALIZED_REORG:{height}"
        )));
    }
    let hash = render_word(&hash);
    source.insert(
        "jHistory".into(),
        serde_json::json!({
            "jurisdictionRef": jurisdiction_ref,
            "scannedThroughHeight": height,
            "contiguousThroughHeight": height,
            "tipBlockHash": hash,
            "eventBlocks": {"__xlnType":"Map","value":[]},
            "blockHashes": {"__xlnType":"Map","value":[[height,hash]]},
        }),
    );
    Ok(())
}

/// Entity certification moves semantic J events into committed Entity state.
/// Keep only the authenticated anchor hash and any validator-local suffix that
/// has not yet been certified. Pruning at observation time would lose evidence
/// needed by the current proposal; pruning here mirrors the TS post-commit
/// seam exactly.
fn prune_finalized_j_history(
    metadata: &mut serde_json::Value,
    finalized_through_height: u64,
) -> Result<(), RuntimeMachineError> {
    let source = metadata
        .as_object_mut()
        .ok_or_else(|| RuntimeMachineError::ReplicaMetadata("OBJECT_REQUIRED".into()))?;
    let Some(history) = source
        .get_mut("jHistory")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(());
    };
    let scanned_through_height = history
        .get("scannedThroughHeight")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata(
                "J_HISTORY_LOCAL_PRUNE_SCANNED_HEIGHT_INVALID".into(),
            )
        })?;
    if finalized_through_height > scanned_through_height {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_LOCAL_PRUNE_HEIGHT_INVALID:{finalized_through_height}:{scanned_through_height}"
        )));
    }
    let contiguous = history
        .get("contiguousThroughHeight")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata(
                "J_HISTORY_LOCAL_PRUNE_CONTIGUOUS_HEIGHT_INVALID".into(),
            )
        })?
        .max(finalized_through_height);
    let mut blocks = tagged_height_map(history.get("eventBlocks"), "eventBlocks")?;
    let mut hashes = tagged_height_map(history.get("blockHashes"), "blockHashes")?;
    blocks.retain(|height, _| *height > finalized_through_height);
    hashes.retain(|height, _| *height >= finalized_through_height);
    history.insert(
        "contiguousThroughHeight".into(),
        serde_json::Value::from(contiguous),
    );
    history.insert(
        "eventBlocks".into(),
        serde_json::json!({
            "__xlnType":"Map",
            "value":blocks.into_iter().map(|(height,value)|serde_json::json!([height,value])).collect::<Vec<_>>(),
        }),
    );
    history.insert(
        "blockHashes".into(),
        serde_json::json!({
            "__xlnType":"Map",
            "value":hashes.into_iter().map(|(height,value)|serde_json::json!([height,value])).collect::<Vec<_>>(),
        }),
    );
    Ok(())
}

fn certified_j_anchor(
    state: &xln_rscore_entity_kernel::EntityStateSlice,
) -> Result<Option<(u64, [u8; 32], String)>, RuntimeMachineError> {
    let Some(value) = state.j_history_finality.as_ref() else {
        return Ok(None);
    };
    let value = crate::tagged_json_from_canonical_value(value)
        .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
    let height = value
        .get("finalizedThroughHeight")
        .and_then(serde_json::Value::as_u64)
        .filter(|height| *height > 0 && *height == state.last_finalized_j_height)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_FINALITY_HEIGHT_CORRUPTION".into())
        })?;
    let hash = value
        .get("tipBlockHash")
        .and_then(serde_json::Value::as_str)
        .and_then(parse_hex32)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_FINALITY_HASH_CORRUPTION".into())
        })?;
    let jurisdiction_ref = value
        .get("jurisdictionRef")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata(
                "J_HISTORY_FINALITY_JURISDICTION_CORRUPTION".into(),
            )
        })?;
    Ok(Some((height, hash, jurisdiction_ref)))
}

fn locked_frame_covers_j_height(
    value: Option<&serde_json::Value>,
    conflicting_height: u64,
) -> Result<bool, RuntimeMachineError> {
    let Some(value) = value else {
        return Ok(false);
    };
    let frame = value.as_object().ok_or_else(|| {
        RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCKED_FRAME_CORRUPTION".into())
    })?;
    let txs = frame
        .get("txs")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCKED_FRAME_TXS_CORRUPTION".into())
        })?;
    for tx in txs {
        if tx.get("type").and_then(serde_json::Value::as_str) != Some("j_event") {
            continue;
        }
        let data = tx.get("data").ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCKED_J_EVENT_CORRUPTION".into())
        })?;
        let base = data
            .get("baseHeight")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCKED_J_EVENT_BASE".into())
            })?;
        let through = data
            .get("scannedThroughHeight")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCKED_J_EVENT_THROUGH".into())
            })?;
        if conflicting_height > base && conflicting_height <= through {
            return Ok(true);
        }
    }
    Ok(false)
}

fn record_j_observation(
    state: &mut crate::RuntimeEntityState,
    replica: &mut crate::RuntimeEntityReplica,
    observation: &crate::j_watcher::ObserveJRange,
) -> Result<bool, RuntimeMachineError> {
    let jurisdiction = replica
        .entity_consensus
        .state
        .authority
        .config
        .jurisdiction
        .as_ref()
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata(
                "J_HISTORY_OBSERVATION_JURISDICTION_MISSING".into(),
            )
        })?;
    let chain_id = match jurisdiction_field(jurisdiction, "chainId")? {
        xln_rscore_protocol::CanonicalValue::Number(value) => value.as_str().parse::<u64>().ok(),
        _ => None,
    }
    .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
    .ok_or_else(|| {
        RuntimeMachineError::ReplicaMetadata("J_HISTORY_OBSERVATION_CHAIN_INVALID".into())
    })?;
    let depository = match jurisdiction_field(jurisdiction, "depositoryAddress")? {
        xln_rscore_protocol::CanonicalValue::String(value) => parse_hex20(value),
        _ => None,
    }
    .ok_or_else(|| {
        RuntimeMachineError::ReplicaMetadata("J_HISTORY_OBSERVATION_DEPOSITORY_INVALID".into())
    })?;
    let expected_jurisdiction_ref = format!("stack:{chain_id}:0x{}", hex::encode(depository));
    if observation.jurisdiction_ref != expected_jurisdiction_ref {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_OBSERVATION_JURISDICTION_MISMATCH:{}:{}",
            expected_jurisdiction_ref, observation.jurisdiction_ref
        )));
    }
    let encoded = crate::j_watcher::encode_observe_j_range(observation)
        .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
    let data = encoded.as_object().ok_or_else(|| {
        RuntimeMachineError::ReplicaMetadata("J_HISTORY_OBSERVATION_OBJECT".into())
    })?;
    if let Some((height, hash, jurisdiction_ref)) = certified_j_anchor(&state.entity)?
        && observation.scanned_through_height < height
    {
        assert_local_j_history_anchor(&replica.replica_metadata, height, hash, &jurisdiction_ref)?;
        return Ok(false);
    }
    let source = replica
        .replica_metadata
        .as_object_mut()
        .ok_or_else(|| RuntimeMachineError::ReplicaMetadata("OBJECT_REQUIRED".into()))?;
    let previous = source
        .get("jHistory")
        .and_then(serde_json::Value::as_object);
    if previous
        .and_then(|value| value.get("jurisdictionRef"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value != observation.jurisdiction_ref)
    {
        return Err(RuntimeMachineError::ReplicaMetadata(
            "J_HISTORY_LOCAL_JURISDICTION_REBIND".into(),
        ));
    }
    let prior_scanned = previous
        .and_then(|value| value.get("scannedThroughHeight"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let base_height = state.entity.last_finalized_j_height;
    let mut hashes = tagged_height_map(
        previous.and_then(|value| value.get("blockHashes")),
        "blockHashes",
    )?;
    let mut blocks = tagged_height_map(
        previous.and_then(|value| value.get("eventBlocks")),
        "eventBlocks",
    )?;
    hashes.retain(|height, _| *height >= base_height);
    blocks.retain(|height, _| *height > base_height);
    if let Some(finality) = state.entity.j_history_finality.as_ref() {
        let json = crate::tagged_json_from_canonical_value(finality)
            .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
        if let (Some(height), Some(hash)) = (
            json.get("finalizedThroughHeight")
                .and_then(serde_json::Value::as_u64),
            json.get("tipBlockHash").and_then(serde_json::Value::as_str),
        ) {
            insert_j_history_row(
                &mut hashes,
                height,
                serde_json::Value::String(hash.to_owned()),
            )?;
        }
    }
    for header in &observation.headers {
        insert_j_history_row(
            &mut hashes,
            header.j_height,
            serde_json::Value::String(render_word(&header.j_block_hash)),
        )?;
    }
    for block in data
        .get("blocks")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let height = block
            .get("jHeight")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCAL_BLOCK_HEIGHT_INVALID".into())
            })?;
        insert_j_history_row(&mut blocks, height, block.clone())?;
    }
    let next_scanned = prior_scanned.max(observation.scanned_through_height);
    let mut contiguous = previous
        .and_then(|value| value.get("contiguousThroughHeight"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(base_height)
        .max(base_height);
    while contiguous < next_scanned && hashes.contains_key(&(contiguous + 1)) {
        contiguous += 1;
    }
    let tip = if observation.scanned_through_height >= prior_scanned {
        render_word(&observation.tip_block_hash)
    } else {
        previous
            .and_then(|value| value.get("tipBlockHash"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                RuntimeMachineError::ReplicaMetadata("J_HISTORY_LOCAL_TIP_CORRUPTION".into())
            })?
            .to_owned()
    };
    source.insert("jHistory".into(), serde_json::json!({
        "jurisdictionRef": observation.jurisdiction_ref,
        "scannedThroughHeight": next_scanned,
        "contiguousThroughHeight": contiguous,
        "tipBlockHash": tip,
        "eventBlocks": {"__xlnType":"Map","value": blocks.into_iter().map(|(height,value)|serde_json::json!([height,value])).collect::<Vec<_>>()},
        "blockHashes": {"__xlnType":"Map","value": hashes.into_iter().map(|(height,value)|serde_json::json!([height,value])).collect::<Vec<_>>()},
    }));
    Ok(true)
}

fn assert_local_j_history_anchor(
    metadata: &serde_json::Value,
    height: u64,
    hash: [u8; 32],
    jurisdiction_ref: &str,
) -> Result<(), RuntimeMachineError> {
    let history = metadata
        .get("jHistory")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata("J_HISTORY_CERTIFIED_ANCHOR_MISSING".into())
        })?;
    if history
        .get("jurisdictionRef")
        .and_then(serde_json::Value::as_str)
        != Some(jurisdiction_ref)
    {
        return Err(RuntimeMachineError::ReplicaMetadata(
            "J_HISTORY_CERTIFIED_ANCHOR_JURISDICTION".into(),
        ));
    }
    let hashes = tagged_height_map(history.get("blockHashes"), "blockHashes")?;
    if hashes
        .get(&height)
        .and_then(serde_json::Value::as_str)
        .and_then(parse_hex32)
        != Some(hash)
    {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_FINALIZED_REORG:{height}"
        )));
    }
    Ok(())
}

fn tagged_height_map(
    value: Option<&serde_json::Value>,
    field: &'static str,
) -> Result<BTreeMap<u64, serde_json::Value>, RuntimeMachineError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let rows = value
        .get("value")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RuntimeMachineError::ReplicaMetadata(format!("J_HISTORY_{field}_MAP")))?;
    let mut output = BTreeMap::new();
    for row in rows {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| {
                RuntimeMachineError::ReplicaMetadata(format!("J_HISTORY_{field}_ROW"))
            })?;
        let height = pair[0].as_u64().ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata(format!("J_HISTORY_{field}_KEY"))
        })?;
        if output.insert(height, pair[1].clone()).is_some() {
            return Err(RuntimeMachineError::ReplicaMetadata(format!(
                "J_HISTORY_{field}_DUPLICATE"
            )));
        }
    }
    Ok(output)
}

fn insert_j_history_row(
    rows: &mut BTreeMap<u64, serde_json::Value>,
    height: u64,
    value: serde_json::Value,
) -> Result<(), RuntimeMachineError> {
    if rows.get(&height).is_some_and(|existing| existing != &value) {
        return Err(RuntimeMachineError::ReplicaMetadata(format!(
            "J_HISTORY_LOCAL_REORG_AT_BLOCK:{height}"
        )));
    }
    rows.insert(height, value);
    Ok(())
}

fn entity_encryption_seed<'a>(
    infrastructure: &'a serde_json::Value,
    entity_id: &str,
) -> Result<Option<&'a str>, RuntimeMachineError> {
    let Some(seeds) = infrastructure.get("entityEncryptionSeeds") else {
        return Ok(None);
    };
    let rows = seeds["value"].as_array().ok_or_else(|| {
        RuntimeMachineError::EntityContextMaterialization("ENTITY_ENCRYPTION_SEEDS_MAP".into())
    })?;
    rows.iter()
        .find(|row| row[0].as_str() == Some(entity_id))
        .map(|row| {
            row[1].as_str().ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(
                    "ENTITY_ENCRYPTION_SEED_TYPE".into(),
                )
            })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    #[test]
    fn entity_encryption_seed_allows_absence_but_rejects_malformed_present_map() {
        use serde_json::json;
        assert_eq!(
            super::entity_encryption_seed(&json!({}), "owner").unwrap(),
            None
        );
        for seeds in [
            json!(null),
            json!({"__xlnType": "Map"}),
            json!({"value": 7}),
        ] {
            assert!(
                super::entity_encryption_seed(&json!({"entityEncryptionSeeds": seeds}), "owner")
                    .is_err()
            );
        }
        let infrastructure =
            json!({"entityEncryptionSeeds": {"__xlnType": "Map", "value": [["owner", "seed"]]}});
        assert_eq!(
            super::entity_encryption_seed(&infrastructure, "owner").unwrap(),
            Some("seed")
        );
        assert_eq!(
            super::entity_encryption_seed(&infrastructure, "other").unwrap(),
            None
        );
        assert!(
            super::entity_encryption_seed(
                &json!({"entityEncryptionSeeds": {"__xlnType": "Map", "value": [["owner", 1]]}}),
                "owner"
            )
            .is_err()
        );
    }
    #[test]
    fn untrusted_hex_rejects_unicode_and_preserves_valid_words() {
        for prefix in ["€", "0€", "+1", "gg"] {
            assert!(
                super::parse_hex32(&format!("0x{prefix}{}", "0".repeat(64 - prefix.len())))
                    .is_none()
            );
            assert!(
                super::parse_hex20(&format!("0x{prefix}{}", "0".repeat(40 - prefix.len())))
                    .is_none()
            );
        }
        assert_eq!(
            super::parse_hex32(&format!("0x{}", "aB".repeat(32))),
            Some([0xab; 32])
        );
        assert_eq!(
            super::parse_hex20(&format!("0x{}", "aB".repeat(20))),
            Some([0xab; 20])
        );
    }

    use std::collections::{BTreeMap, VecDeque};

    use xln_rscore_batch::{AccountInputResult, AccountInputVerdict};
    use xln_rscore_engine::{
        AccountDomain, AccountFrame, CommittedFrameEvidence, DepositoryAddress, EntityId,
        JEventMetadata, JurisdictionEvent, ReserveUpdatedEvent,
    };
    use xln_rscore_entity_kernel::{
        CanonicalEntityTx, EntityTxKind, LocalEntityOutput, LocalEntityOutputTx, LocalEntityTx,
        decode_local_entity_tx,
    };
    use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

    use crate::{
        FinalizedJEventBatch, FinalizedJHeader, ObserveJRange, RuntimeEntityFrameContext,
        RuntimeEntityInput, RuntimeInput, RuntimeTx,
    };

    use super::{
        AccountCommitSource, AccountId, AccountInputOutcomeProfile, EntityApplySlot,
        EntityPendingWork, PendingEntityCause, PendingEntitySegment, ProfileAccountInputKind,
        RuntimeEntityKey, RuntimeFrameContext, account_commit_evidence, account_work_group,
        account_work_selection_emits_frame, collect_immediate_cross_j_commands,
        enqueue_derived_groups, fit_replay_entity_prefix, immediate_cross_j_group,
        prepare_entity_prefix, prepare_j_prefix_range, replay_compatible_prefix,
        take_entity_mempool_for_group, take_entity_prefix,
    };

    fn projected(kind: EntityTxKind, order_id: &str) -> CanonicalEntityTx {
        let mut route = vec![("orderId".into(), CanonicalValue::String(order_id.into()))];
        if kind == EntityTxKind::RegisterCrossJurisdictionSwap {
            route.extend([
                (
                    "sourcePull".into(),
                    CanonicalValue::Object(vec![(
                        "pullId".into(),
                        CanonicalValue::String("source-pull".into()),
                    )]),
                ),
                (
                    "targetPull".into(),
                    CanonicalValue::Object(vec![(
                        "pullId".into(),
                        CanonicalValue::String("target-pull".into()),
                    )]),
                ),
            ]);
        }
        CanonicalEntityTx::from_frame_projection(
            kind,
            CanonicalValue::Object(vec![("route".into(), CanonicalValue::Object(route))]),
        )
        .expect("projected cross-j tx")
    }

    fn key(byte: u8, signer: &str) -> RuntimeEntityKey {
        RuntimeEntityKey::new([byte; 32], signer).expect("runtime Entity key")
    }

    fn group_name(group: &super::PendingEntityGroup) -> &'static str {
        match group.cause {
            PendingEntityCause::CrossJurisdiction if group.entity_id == [0x11; 32] => {
                "source-register"
            }
            PendingEntityCause::CrossJurisdiction if group.entity_id == [0x22; 32] => {
                "target-register"
            }
            PendingEntityCause::AccountWork if group.entity_id == [0x11; 32] => "source-work",
            PendingEntityCause::AccountWork if group.entity_id == [0x22; 32] => "target-work",
            _ => "unexpected",
        }
    }

    #[test]
    fn account_work_preserves_two_prequeued_entity_intents_and_discards_idle_preview() {
        let first = projected(EntityTxKind::CrossJurisdictionFillNotice, "intent-1");
        let second = projected(EntityTxKind::CrossJurisdictionFillNotice, "intent-2");
        let mut entity_mempool = VecDeque::from([
            EntityPendingWork::Projected(first.clone()),
            EntityPendingWork::Projected(second.clone()),
        ]);
        let selected =
            take_entity_mempool_for_group(PendingEntityCause::AccountWork, 0, &mut entity_mempool)
                .expect("account-work selection");
        assert!(selected.is_empty(), "AccountWork selects no Entity intent");
        assert_eq!(entity_mempool.len(), 2);
        assert!(matches!(
            &entity_mempool[0],
            EntityPendingWork::Projected(tx) if tx == &first
        ));
        assert!(matches!(
            &entity_mempool[1],
            EntityPendingWork::Projected(tx) if tx == &second
        ));
        assert!(!account_work_selection_emits_frame(
            &xln_rscore_entity_kernel::CrossJOpeningProposalSelection::Wait,
        ));
    }

    #[test]
    fn cross_j_r4_h29_empty_entity_input_preserves_runtime_receipt_and_pending_work() {
        let owner = crate::machine::tests::owner_bytes();
        let signer = crate::machine::tests::entity_signer_id();
        let input = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": super::render_word(&owner), "signerId": signer, "entityTxs": [],
        }))
        .unwrap();
        let mut frame = crate::machine::tests::frame_for_test(101, vec![input.clone()]);
        frame.frame.entity_contexts.clear();
        let result = crate::apply_runtime(
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).unwrap(),
            frame,
        )
        .unwrap();
        assert_eq!(result.replica.state.height, 1);
        assert_eq!(result.replica.state.timestamp, 101);
        assert!(result.outputs.entities.is_empty());
        let applied = result.applied_frame.unwrap();
        assert_eq!(applied.entity_inputs, vec![input.canonical().clone()]);
        assert_eq!(applied.entity_frame_count, 0);

        let mut pending = crate::machine::tests::replica(crate::RuntimeLimits::hlt()).unwrap();
        let credit = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": super::render_word(&owner), "signerId": signer,
            "entityTxs": [{"type": "extendCredit", "data": {
                "counterpartyEntityId": format!("0x{}", "ff".repeat(32)), "tokenId": 1,
                "amount": {"__xlnType": "BigInt", "value": "7"}
            }}],
        }))
        .unwrap();
        let (_, work, _) = credit.into_parts();
        pending
            .e_replicas
            .get_mut(&RuntimeEntityKey::new(owner, &signer).unwrap())
            .unwrap()
            .entity_mempool
            .extend(work);
        let result = crate::apply_runtime(
            pending,
            crate::machine::tests::frame_for_test(101, vec![input]),
        )
        .unwrap();
        assert_eq!(
            result.outputs.entities.len(),
            1,
            "an empty wake must consume already-admitted work"
        );
        assert_eq!(
            result
                .replica
                .state
                .e_replicas
                .values()
                .next()
                .unwrap()
                .entity
                .height,
            1
        );
    }

    #[test]
    fn materialize_local_cascade_preserves_ts_five_step_fifo_without_durable_inputs() {
        let source = key(0x11, "source-signer");
        let target = key(0x22, "target-signer");
        let local = std::collections::BTreeSet::from([source.clone(), target.clone()]);
        let mut outputs = vec![
            LocalEntityOutput {
                entity_id: super::render_word(&source.entity_id),
                target_signer_id: Some(source.signer_id.clone()),
                entity_txs: vec![LocalEntityOutputTx::Projected(projected(
                    EntityTxKind::RegisterCrossJurisdictionSwap,
                    "opening-1",
                ))],
            },
            LocalEntityOutput {
                entity_id: super::render_word(&target.entity_id),
                target_signer_id: Some(target.signer_id.clone()),
                entity_txs: vec![LocalEntityOutputTx::Projected(projected(
                    EntityTxKind::RegisterCrossJurisdictionSwap,
                    "opening-1",
                ))],
            },
        ];
        let commands = collect_immediate_cross_j_commands(
            &super::render_word(&source.entity_id),
            &source.signer_id,
            &local,
            &mut outputs,
        )
        .expect("local materialization outputs");
        assert!(
            outputs.is_empty(),
            "local register outputs never enter flat outbox"
        );

        let groups = commands
            .into_iter()
            .map(immediate_cross_j_group)
            .collect::<Result<Vec<_>, _>>()
            .expect("derived register groups");
        let mut queue = VecDeque::<PendingEntitySegment>::new();
        enqueue_derived_groups(&mut queue, groups);
        let mut sequence = vec!["materialize"];

        let source_register = queue.pop_front().expect("source register");
        sequence.push(group_name(&source_register.groups[0]));
        enqueue_derived_groups(&mut queue, vec![account_work_group(source.clone())]);
        let target_register = queue.pop_front().expect("target register");
        sequence.push(group_name(&target_register.groups[0]));
        enqueue_derived_groups(&mut queue, vec![account_work_group(target.clone())]);
        while let Some(segment) = queue.pop_front() {
            let group = &segment.groups[0];
            sequence.push(group_name(group));
            assert!(
                group.input_positions.is_empty(),
                "derived frames have no durable external input position"
            );
            assert!(
                group.wake.is_none(),
                "derived frames cannot manufacture a synthetic durable input"
            );
        }
        assert_eq!(
            sequence,
            [
                "materialize",
                "source-register",
                "target-register",
                "source-work",
                "target-work",
            ]
        );
    }

    #[test]
    fn immediate_cross_j_wrapper_preserves_register_pulls_byte_for_byte() {
        let source = key(0x11, "source-signer");
        let target = key(0x22, "target-signer");
        let route = CanonicalValue::Object(vec![
            ("orderId".into(), CanonicalValue::String("opening-1".into())),
            (
                "sourcePull".into(),
                CanonicalValue::Object(vec![(
                    "pullId".into(),
                    CanonicalValue::String("source-pull".into()),
                )]),
            ),
            (
                "targetPull".into(),
                CanonicalValue::Object(vec![(
                    "pullId".into(),
                    CanonicalValue::String("target-pull".into()),
                )]),
            ),
        ]);
        let register = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::RegisterCrossJurisdictionSwap,
            CanonicalValue::Object(vec![("route".into(), route)]),
        )
        .expect("register projection");
        let expected =
            encode_canonical_consensus_bytes(register.frame_data().expect("register data"))
                .expect("register bytes");
        let mut outputs = vec![LocalEntityOutput {
            entity_id: super::render_word(&target.entity_id),
            target_signer_id: Some(target.signer_id.clone()),
            entity_txs: vec![LocalEntityOutputTx::Projected(register)],
        }];
        let local = std::collections::BTreeSet::from([source.clone(), target]);
        let command = collect_immediate_cross_j_commands(
            &super::render_word(&source.entity_id),
            &source.signer_id,
            &local,
            &mut outputs,
        )
        .expect("collect immediate output")
        .pop()
        .expect("immediate command");
        assert_eq!(
            encode_canonical_consensus_bytes(
                command.entity_txs[0]
                    .frame_data()
                    .expect("command register data"),
            )
            .expect("command bytes"),
            expected,
            "LocalEntityOutput to immediate command must preserve both pull bodies",
        );

        let group = immediate_cross_j_group(command).expect("immediate group");
        let EntityPendingWork::ProposerMaterialized {
            projected: wrapper,
            native: _,
        } = &group.pending[0]
        else {
            panic!("derived group wrapper")
        };
        let Some(LocalEntityTx::RuntimeOutput(decoded)) =
            decode_local_entity_tx(wrapper).expect("decode runtimeOutput")
        else {
            panic!("runtimeOutput local tx")
        };
        assert_eq!(
            encode_canonical_consensus_bytes(
                decoded.entity_txs[0]
                    .frame_data()
                    .expect("decoded register data"),
            )
            .expect("decoded bytes"),
            expected,
            "RuntimeOutput wrapping and decode must preserve both pull bodies",
        );
    }

    #[test]
    fn account_profile_counts_direct_and_bundled_replays() {
        let duplicate = || AccountInputVerdict::FrameDuplicate {
            height: 7,
            state_hash: [9; 32],
            ack_hanko: vec![1],
            ack_dispute: None,
        };
        let mut profile = AccountInputOutcomeProfile::default();
        profile.observe_input(ProfileAccountInputKind::AckFrameWithoutAck);
        profile.observe_outcome(ProfileAccountInputKind::AckFrameWithoutAck, &duplicate());
        profile.observe_input(ProfileAccountInputKind::AckFrameWithAck);
        profile.observe_outcome(
            ProfileAccountInputKind::AckFrameWithAck,
            &AccountInputVerdict::AckFrameApplied {
                ack: Box::new(AccountInputVerdict::AckAccepted { height: 7 }),
                frame: Box::new(duplicate()),
            },
        );
        assert_eq!(profile.ack_frame_without_ack, 1);
        assert_eq!(profile.ack_frame_with_ack, 1);
        assert_eq!(profile.ack_accepted, 1);
        assert_eq!(profile.frame_duplicate, 2);
        assert_eq!(profile.outcome_other, 0);
    }

    #[test]
    fn entity_wire_fit_keeps_exact_fifo_prefix_and_tail() {
        let mut replica =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let signer_id = crate::machine::tests::entity_signer_id();
        let entity_key =
            crate::RuntimeEntityKey::new(crate::machine::tests::owner_bytes(), &signer_id)
                .expect("fixture Entity key");
        let (state, entity_replica) = replica
            .take_entity_slot(&entity_key.entity_id, &entity_key.signer_id)
            .expect("fixture Entity slot");
        let slot = super::EntityApplySlot {
            state,
            replica: entity_replica,
        };
        // Two of these exceed the tx byte budget; one fits.
        let tx = || {
            CanonicalEntityTx::from_frame_projection(
                EntityTxKind::DirectPayment,
                CanonicalValue::String("x".repeat(super::MAX_ENTITY_FRAME_TX_BYTES / 2 + 1_000)),
            )
            .expect("large canonical tx")
        };
        let mut work = VecDeque::from([
            EntityPendingWork::Projected(tx()),
            EntityPendingWork::Projected(tx()),
        ]);
        let canonical_context = CanonicalValue::Object(Vec::new());
        let frame = RuntimeFrameContext {
            timestamp: 1,
            finalized_j_height: 0,
            entity_contexts: std::collections::BTreeMap::from([(
                entity_key,
                std::collections::VecDeque::from([crate::RuntimeEntityFrameContext {
                    execution: xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
                    canonical: canonical_context.clone(),
                }]),
            )]),
        };
        let (selected, _) =
            fit_replay_entity_prefix(&slot, &work, &frame, &canonical_context, None)
                .expect("bounded prefix");
        assert_eq!(selected, 1);
        assert_eq!(
            prepare_entity_prefix(&slot, work.iter(), Some(super::MAX_ENTITY_FRAME_TX_BYTES),)
                .expect("live tx-byte prefix")
                .txs
                .len(),
            1,
        );
        let taken = take_entity_prefix(&slot, &mut work, selected).expect("take prefix");
        assert_eq!(taken.txs.len(), 1);
        assert_eq!(work.len(), 1);
    }

    fn replay_account_work(frame_hash: &str, lock_id: &str) -> EntityPendingWork {
        let owner = super::render_word(&crate::machine::tests::owner_bytes());
        let signer_id = crate::machine::tests::entity_signer_id();
        let input = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": owner,
            "signerId": signer_id,
            "entityTxs": [{
                "type": "accountInput",
                "data": {
                    "fromEntityId": format!("0x{}", "ff".repeat(32)),
                    "toEntityId": owner,
                    "domain": {
                        "chainId": 31_337,
                        "depositoryAddress": format!("0x{}", "88".repeat(20))
                    },
                    "disputeConfig": {
                        "leftResponseSeconds": 10,
                        "rightResponseSeconds": 10
                    },
                    "watchSeed": format!("0x{}", "99".repeat(32)),
                    "kind": "ack",
                    "ack": {
                        "height": 1,
                        "frameHash": format!("0x{}", "77".repeat(32)),
                        "frameHanko": "0x0304"
                    }
                }
            }]
        }))
        .expect("real AccountInput admission");
        let (_, mut work, _) = input.into_parts();
        let EntityPendingWork::Account { projected, .. } = &mut work[0] else {
            panic!("AccountInput work")
        };
        projected.wire_data = crate::canonical_value_from_tagged_json(&serde_json::json!({
            "proposal": {
                "frame": {
                    "stateHash": frame_hash,
                    "accountTxs": [{
                        "type": "htlc_lock",
                        "data": {"hashlock": lock_id, "envelope": {}}
                    }]
                }
            }
        }))
        .expect("canonical Account proposal");
        work.pop().expect("one Account work")
    }

    /// The index trap behind the reject-eviction path.
    ///
    /// `RejectedInboundAccountInput::operation_index` is a position inside
    /// `EntityInboundRequest::rows`, and a contiguous run of `accountInput`
    /// work merges into ONE `AccountRange` operation. `operation_work_indices`
    /// is keyed by operation, so it records only the first work item of that
    /// run: indexing it with a row position either evicts an innocent sibling
    /// `accountInput` tx or runs off the end. `row_work_indices` is the only
    /// map that names the exact parent tx of each rejected row.
    #[test]
    fn account_rows_map_to_their_own_work_item_not_the_merged_range() {
        let mut replica =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let signer_id = crate::machine::tests::entity_signer_id();
        let entity_key =
            crate::RuntimeEntityKey::new(crate::machine::tests::owner_bytes(), &signer_id)
                .expect("fixture Entity key");
        let (state, entity_replica) = replica
            .take_entity_slot(&entity_key.entity_id, &entity_key.signer_id)
            .expect("fixture Entity slot");
        let slot = super::EntityApplySlot {
            state,
            replica: entity_replica,
        };
        let digest = |byte: &str| format!("0x{}", byte.repeat(32));
        let mut work = VecDeque::from([
            EntityPendingWork::Projected(
                CanonicalEntityTx::from_frame_projection(
                    EntityTxKind::DirectPayment,
                    CanonicalValue::Null,
                )
                .expect("ordinary projected tx"),
            ),
            replay_account_work(&digest("11"), &digest("aa")),
            replay_account_work(&digest("22"), &digest("bb")),
            replay_account_work(&digest("33"), &digest("cc")),
        ]);
        let taken = take_entity_prefix(&slot, &mut work, 4).expect("take prefix");
        assert_eq!(taken.rows.len(), 3);
        assert_eq!(
            taken.operations.len(),
            1,
            "three consecutive Account work items merge into one AccountRange",
        );
        assert_eq!(
            taken.operation_work_indices,
            vec![1],
            "operation index space records only the work item that opened the range",
        );
        assert_eq!(
            taken.row_work_indices,
            vec![1, 2, 3],
            "row index space names the parent accountInput tx of every row",
        );
    }

    #[test]
    fn replay_context_selects_complete_htlc_prefix_and_leaves_unknown_tail() {
        let frame_a = format!("0x{}", "11".repeat(32));
        let frame_b = format!("0x{}", "22".repeat(32));
        let frame_tail = format!("0x{}", "33".repeat(32));
        let lock_a = format!("0x{}", "aa".repeat(32));
        let lock_b = format!("0x{}", "bb".repeat(32));
        let lock_tail = format!("0x{}", "cc".repeat(32));
        let work = VecDeque::from([
            EntityPendingWork::Projected(
                CanonicalEntityTx::from_frame_projection(
                    EntityTxKind::DirectPayment,
                    CanonicalValue::Null,
                )
                .expect("ordinary projected tx"),
            ),
            replay_account_work(&frame_a, &lock_a),
            replay_account_work(&frame_b, &lock_b),
            replay_account_work(&frame_tail, &lock_tail),
        ]);
        let context = crate::canonical_value_from_tagged_json(&serde_json::json!({
            "htlc": {
                "entries": [
                    {"binding": {"accountFrameHash": frame_a, "hashlock": lock_a}},
                    {"binding": {"accountFrameHash": frame_b, "hashlock": lock_b}}
                ]
            }
        }))
        .expect("canonical persisted context");

        let (compatible, required) =
            replay_compatible_prefix(&work, &context).expect("exact replay prefix");
        assert_eq!((compatible, required), (3, 3));
    }

    fn committed_frame(height: u64, root_byte: u8, peer: bool) -> CommittedFrameEvidence {
        CommittedFrameEvidence {
            frame: AccountFrame {
                height,
                timestamp: 1_700_000_000_000 + height,
                j_height: 100,
                txs: Vec::new(),
                prev_frame_hash: "genesis".into(),
                account_state_root: [root_byte; 32],
            },
            state_hash: [root_byte.wrapping_add(1); 32],
            domain: AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                    .expect("fixture depository"),
            )
            .expect("fixture domain"),
            outputs_by_tx: Vec::new(),
            committed_via_new_frame: peer,
        }
    }

    #[test]
    fn ack_frame_commit_evidence_preserves_ack_then_peer_order() {
        let account_id = AccountId::from_bytes([0x44; 32]);
        let ack_frame = committed_frame(7, 0x71, false);
        let peer_frame = committed_frame(8, 0x81, true);
        let verdict = AccountInputVerdict::AckFrameApplied {
            ack: Box::new(AccountInputVerdict::AckCommitted {
                height: ack_frame.frame.height,
                state_hash: ack_frame.state_hash,
                events: Vec::new(),
                committed_frame: Box::new(ack_frame),
            }),
            frame: Box::new(AccountInputVerdict::FrameCommitted {
                height: peer_frame.frame.height,
                state_hash: peer_frame.state_hash,
                ack_signature: [0_u8; 65],
                ack_hanko: Vec::new(),
                ack_dispute_signature: None,
                ack_dispute_hanko: None,
                events: Vec::new(),
                rolled_back: None,
                committed_frame: Box::new(peer_frame),
                ack_dispute: None,
            }),
        };
        let evidence = account_commit_evidence(
            crate::machine::tests::owner_bytes(),
            &[AccountInputResult {
                operation_index: 0,
                account_id,
                verdict,
                rebalance_work_after_input: false,
                force_ack: None,
            }],
        );

        assert_eq!(evidence.len(), 2);
        assert_eq!(evidence[0].source, AccountCommitSource::AckCommit);
        assert_eq!(evidence[0].frame_height, 7);
        assert_eq!(evidence[0].account_state_root, [0x71; 32]);
        assert_eq!(evidence[1].source, AccountCommitSource::CounterpartyCommit);
        assert_eq!(evidence[1].frame_height, 8);
        assert_eq!(evidence[1].account_state_root, [0x81; 32]);
    }

    use super::local_j_prefix_attestable_height;

    fn j_history(
        scanned_through_height: u64,
        contiguous_through_height: u64,
        event_block_heights: &[u64],
        header_heights: &[u64],
    ) -> serde_json::Value {
        let event_blocks: Vec<serde_json::Value> = event_block_heights
            .iter()
            .map(|height| serde_json::json!([height, {"jHeight": height}]))
            .collect();
        let block_hashes: Vec<serde_json::Value> = header_heights
            .iter()
            .map(|height| serde_json::json!([height, format!("0x{height}")]))
            .collect();
        serde_json::json!({
            "jHistory": {
                "scannedThroughHeight": scanned_through_height,
                "contiguousThroughHeight": contiguous_through_height,
                "eventBlocks": {"value": event_blocks},
                "blockHashes": {"value": block_hashes},
            }
        })
    }

    #[test]
    fn j_prefix_base_case_fully_caught_up_is_not_pending() {
        let metadata = j_history(35, 35, &[], &[]);
        assert_eq!(
            local_j_prefix_attestable_height(&metadata, 35, true),
            Ok(Some(35))
        );
    }

    #[test]
    fn j_prefix_contiguous_advance_across_empty_block_refuses_stale_base() {
        // contiguousThroughHeight already advanced to 36 with zero events:
        // the base-claim path must not silently certify stale height 35.
        let metadata = j_history(36, 36, &[], &[]);
        assert_eq!(
            local_j_prefix_attestable_height(&metadata, 35, true),
            Ok(Some(36))
        );
    }

    #[test]
    fn j_prefix_missing_local_history_refuses() {
        let metadata = serde_json::json!({});
        assert_eq!(
            local_j_prefix_attestable_height(&metadata, 35, true),
            Ok(None)
        );
    }

    #[test]
    fn j_prefix_semantic_event_refuses() {
        let metadata = j_history(36, 35, &[36], &[]);
        assert_eq!(
            local_j_prefix_attestable_height(&metadata, 35, true),
            Ok(None)
        );
    }

    #[test]
    fn certified_j_history_prune_keeps_only_the_anchor_hash_at_the_tip() {
        let mut metadata = j_history(36, 35, &[35, 36], &[35, 36]);
        super::prune_finalized_j_history(&mut metadata, 36).expect("prune certified tip");
        assert_eq!(metadata["jHistory"]["contiguousThroughHeight"], 36);
        assert_eq!(
            metadata["jHistory"]["eventBlocks"]["value"],
            serde_json::json!([]),
        );
        assert_eq!(
            metadata["jHistory"]["blockHashes"]["value"],
            serde_json::json!([[36, "0x36"]]),
        );
    }

    #[test]
    fn certified_j_history_prune_retains_uncertified_tail() {
        let mut metadata = j_history(37, 34, &[34, 35, 36, 37], &[34, 35, 36, 37]);
        super::prune_finalized_j_history(&mut metadata, 35).expect("prune with local tail");
        assert_eq!(metadata["jHistory"]["contiguousThroughHeight"], 35);
        assert_eq!(
            metadata["jHistory"]["eventBlocks"]["value"],
            serde_json::json!([[36, {"jHeight":36}], [37, {"jHeight":37}]]),
        );
        assert_eq!(
            metadata["jHistory"]["blockHashes"]["value"],
            serde_json::json!([[35, "0x35"], [36, "0x36"], [37, "0x37"]]),
        );
    }

    #[test]
    fn actual_stale_j_prefix_authenticates_before_terminal_noop() {
        let input: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/entity-consensus/stale-native-prefix.json"
        ))
        .unwrap();
        let mut runtime = crate::machine::tests::replica(crate::RuntimeLimits::hlt()).unwrap();
        let (mut state, replica) = runtime
            .take_entity_slot(
                &crate::machine::tests::owner_bytes(),
                &crate::machine::tests::entity_signer_id(),
            )
            .unwrap();
        let wire = &input["jPrefixAttestations"]["value"][0][1];
        state.entity.entity_id = input["entityId"].as_str().unwrap().into();
        state.entity.height = 1;
        state.entity.last_finalized_j_height = 22;
        state.entity.j_history_finality = Some(
            crate::canonical_value_from_tagged_json(
                &serde_json::json!({"finalizedThroughHeight":22,
                "tipBlockHash": wire["headers"][19]["jBlockHash"],
                "jurisdictionRef": wire["jurisdictionRef"]}),
            )
            .unwrap(),
        );
        let slot = EntityApplySlot { state, replica };
        for tamper in [false, true] {
            let mut candidate = input.clone();
            if tamper {
                candidate["jPrefixAttestations"]["value"][0][1]["eventHistoryRoot"] =
                    serde_json::json!(format!("0x{}", "12".repeat(32)));
            }
            let decoded = RuntimeEntityInput::decode(candidate).unwrap();
            let mut groups = Vec::new();
            super::push_pending_entity_input(
                &mut groups,
                &mut BTreeMap::new(),
                *decoded.entity_id(),
                decoded.signer_id().into(),
                Vec::new(),
                0,
            )
            .unwrap();
            super::attach_j_prefix_attestation(&mut groups[0], decoded.j_prefix_attestation())
                .unwrap();
            let result = super::refresh_stale_j_prefix(&slot, &mut groups[0]);
            if tamper {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("ATTESTATION_SIGNATURE")
                );
                assert!(groups[0].j_attestation_wire.is_some());
            } else {
                assert!(result.unwrap());
                assert!(groups[0].j_observation.is_none());
                assert!(groups[0].j_attestation_wire.is_none());
            }
            assert_eq!(slot.state.entity.last_finalized_j_height, 22);
        }
    }

    #[test]
    fn watcher_range_builds_one_signed_j_event_and_one_identical_certificate_claim() {
        let mut runtime =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let signer_id = crate::machine::tests::entity_signer_id();
        let entity_key =
            crate::RuntimeEntityKey::new(crate::machine::tests::owner_bytes(), &signer_id)
                .expect("fixture Entity key");
        let (mut state, mut replica) = runtime
            .take_entity_slot(&entity_key.entity_id, &entity_key.signer_id)
            .expect("fixture Entity slot");
        let number = |value| {
            CanonicalValue::Number(
                xln_rscore_protocol::CanonicalNumber::try_from_u64(value).expect("safe number"),
            )
        };
        let jurisdiction_ref = format!("stack:31337:0x{}", "88".repeat(20));
        state.entity.last_finalized_j_height = 35;
        state.entity.j_history_finality = Some(CanonicalValue::Object(vec![
            (
                "jurisdictionRef".into(),
                CanonicalValue::String(jurisdiction_ref.clone()),
            ),
            ("finalizedThroughHeight".into(), number(35)),
            (
                "tipBlockHash".into(),
                CanonicalValue::String(format!("0x{}", "35".repeat(32))),
            ),
            (
                "eventHistoryRoot".into(),
                CanonicalValue::String(format!("0x{}", "11".repeat(32))),
            ),
        ]));
        replica.entity_consensus.state.authority.config.jurisdiction =
            Some(CanonicalValue::Object(vec![
                ("chainId".into(), number(31_337)),
                (
                    "depositoryAddress".into(),
                    CanonicalValue::String(format!("0x{}", "88".repeat(20))),
                ),
                (
                    "entityProviderAddress".into(),
                    CanonicalValue::String(format!("0x{}", "99".repeat(20))),
                ),
            ]));
        let block_hash = [0x44; 32];
        let observation = ObserveJRange {
            entity_id: EntityId::parse(&super::render_word(&entity_key.entity_id))
                .expect("entity id"),
            signer_id,
            jurisdiction_ref,
            scanned_through_height: 36,
            tip_block_hash: block_hash,
            headers_present: true,
            headers: vec![FinalizedJHeader {
                j_height: 36,
                j_block_hash: block_hash,
            }],
            batches: vec![FinalizedJEventBatch {
                j_height: 36,
                j_block_hash: block_hash,
                events: vec![JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
                    metadata: JEventMetadata {
                        block_number: Some(36),
                        block_hash: Some(block_hash),
                        transaction_hash: Some([0x55; 32]),
                        log_index: Some(0),
                        event_index: None,
                    },
                    entity: super::render_word(&entity_key.entity_id),
                    token_id: 1,
                    new_balance: num_bigint::BigInt::from(10_u8),
                })],
                dispute_finalization_evidence: Vec::new(),
                reserve_updates: Vec::new(),
                account_claims: Vec::new(),
            }],
        };
        let prepared = prepare_j_prefix_range(&EntityApplySlot { state, replica }, &observation)
            .expect("prepared J range");
        assert_eq!(prepared.tx.kind, EntityTxKind::JEvent);
        assert_eq!(prepared.claim.base_height, 35);
        assert_eq!(prepared.claim.scanned_through_height, 36);
        assert_eq!(prepared.claim.blocks.len(), 1);
        assert_eq!(prepared.claim.headers.len(), 1);
        let frame_data = prepared.tx.frame_data().expect("frame projection");
        let CanonicalValue::Object(fields) = frame_data else {
            panic!("J event projection object")
        };
        assert!(fields.iter().any(|(field, value)| {
            field == "rangeHash"
                && matches!(value, CanonicalValue::String(hash) if hash == &prepared.claim.range_hash)
        }));
    }

    #[test]
    fn header_only_j_watcher_scan_is_certified_in_next_entity_frame() {
        let mut runtime =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let entity_id = crate::machine::tests::owner_bytes();
        let signer_id = crate::machine::tests::entity_signer_id();
        let jurisdiction_ref = format!("stack:31337:0x{}", "88".repeat(20));
        runtime
            .entity_slot_mut(&entity_id, &signer_id)
            .expect("entity slot")
            .1
            .entity_consensus
            .state
            .authority
            .config
            .jurisdiction = Some(CanonicalValue::Object(vec![
            (
                "chainId".into(),
                CanonicalValue::Number(
                    xln_rscore_protocol::CanonicalNumber::try_from_u64(31_337)
                        .expect("safe chain id"),
                ),
            ),
            (
                "depositoryAddress".into(),
                CanonicalValue::String(format!("0x{}", "88".repeat(20))),
            ),
            (
                "entityProviderAddress".into(),
                CanonicalValue::String(format!("0x{}", "99".repeat(20))),
            ),
        ]));
        let observation = ObserveJRange {
            entity_id: EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
            signer_id,
            jurisdiction_ref,
            scanned_through_height: 1,
            tip_block_hash: [0x44; 32],
            headers_present: true,
            headers: vec![FinalizedJHeader {
                j_height: 1,
                j_block_hash: [0x44; 32],
            }],
            batches: Vec::new(),
        };
        assert!(
            super::build_local_j_prefix_entity_input(&runtime, &observation)
                .expect("optional prefix")
                .is_none()
        );
        let result = super::apply_runtime(
            runtime,
            RuntimeInput {
                runtime_txs: vec![RuntimeTx::ObserveJRange(observation)],
                entity_inputs: Vec::new(),
                frame: RuntimeFrameContext {
                    timestamp: 100,
                    finalized_j_height: 0,
                    entity_contexts: std::collections::BTreeMap::new(),
                },
            },
        )
        .expect("header-only Runtime frame");
        assert!(result.outputs.entities.is_empty());
        assert_eq!(
            result.outputs.touches.entity_ids,
            vec![super::render_word(&entity_id)]
        );
        let (state, live) = result
            .replica
            .entity_slot(&entity_id, &crate::machine::tests::entity_signer_id())
            .expect("observed entity slot");
        let cached = super::complete_local_j_prefix_observation(state, live, None, true)
            .expect("cached header claim")
            .expect("contiguous header range");
        assert_eq!(cached.scanned_through_height, 1);
        assert!(cached.batches.is_empty());
        let next_input = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": super::render_word(&entity_id),
            "signerId": crate::machine::tests::entity_signer_id(),
            "entityTxs": [{"type": "extendCredit", "data": {
                "counterpartyEntityId": format!("0x{}", "ff".repeat(32)),
                "tokenId": 1, "amount": {"__xlnType": "BigInt", "value": "7"}
            }}],
        }))
        .expect("next entity work");
        let next = super::apply_runtime(
            result.replica,
            crate::machine::tests::frame_for_test(101, vec![next_input]),
        )
        .expect("next Entity frame certifies cached header range");
        let (state, live) = next
            .replica
            .entity_slot(&entity_id, &crate::machine::tests::entity_signer_id())
            .expect("certified entity slot");
        assert_eq!(state.entity.last_finalized_j_height, 1);
        let head = &live
            .entity_consensus
            .certified_frame_head
            .as_ref()
            .expect("certified frame")
            .frame;
        assert_eq!(head.txs[0].kind, EntityTxKind::JEvent);
        assert_eq!(head.txs.len(), 2);
    }

    #[test]
    fn unregistered_semantic_j_observation_certifies_on_demand_and_applies_reserve() {
        let mut runtime =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let entity_id = crate::machine::tests::owner_bytes();
        let signer_id = crate::machine::tests::entity_signer_id();
        let number = |value| {
            CanonicalValue::Number(
                xln_rscore_protocol::CanonicalNumber::try_from_u64(value).expect("safe number"),
            )
        };
        runtime
            .entity_slot_mut(&entity_id, &signer_id)
            .expect("entity slot")
            .1
            .entity_consensus
            .state
            .authority
            .config
            .jurisdiction = Some(CanonicalValue::Object(vec![
            ("chainId".into(), number(31_337)),
            (
                "depositoryAddress".into(),
                CanonicalValue::String(format!("0x{}", "88".repeat(20))),
            ),
            (
                "entityProviderAddress".into(),
                CanonicalValue::String(format!("0x{}", "99".repeat(20))),
            ),
        ]));
        let block_hash = [0x44; 32];
        let event = JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
            metadata: JEventMetadata {
                block_number: Some(1),
                block_hash: Some(block_hash),
                transaction_hash: Some([0x55; 32]),
                log_index: Some(0),
                event_index: None,
            },
            entity: super::render_word(&entity_id),
            token_id: 1,
            new_balance: num_bigint::BigInt::from(10_u8),
        });
        let observation = ObserveJRange {
            entity_id: EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
            signer_id: signer_id.clone(),
            jurisdiction_ref: format!("stack:31337:0x{}", "88".repeat(20)),
            scanned_through_height: 1,
            tip_block_hash: block_hash,
            headers_present: true,
            headers: vec![FinalizedJHeader {
                j_height: 1,
                j_block_hash: block_hash,
            }],
            batches: vec![
                xln_rscore_entity_kernel::project_finalized_j_event_batch(
                    &EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
                    1,
                    block_hash,
                    vec![event],
                    Vec::new(),
                )
                .expect("projected J batch"),
            ],
        };
        let prefix_input = super::build_local_j_prefix_entity_input(&runtime, &observation)
            .expect("on-demand prefix")
            .expect("semantic range requires a prefix");
        let key = crate::RuntimeEntityKey::new(entity_id, &signer_id).expect("entity key");
        let event_observation = ObserveJRange {
            headers_present: false,
            headers: Vec::new(),
            ..observation.clone()
        };
        let header_observation = ObserveJRange {
            batches: Vec::new(),
            ..observation
        };
        let result = super::apply_runtime(
            runtime,
            RuntimeInput {
                runtime_txs: vec![
                    RuntimeTx::ObserveJRange(event_observation),
                    RuntimeTx::ObserveJRange(header_observation),
                ],
                entity_inputs: vec![prefix_input],
                frame: RuntimeFrameContext {
                    timestamp: 100,
                    finalized_j_height: 0,
                    entity_contexts: std::collections::BTreeMap::from([(
                        key.clone(),
                        VecDeque::from([RuntimeEntityFrameContext {
                            execution: xln_rscore_entity_kernel::DeterministicContext::hlt_default(
                            ),
                            canonical: CanonicalValue::Object(Vec::new()),
                        }]),
                    )]),
                },
            },
        )
        .expect("on-demand semantic Entity frame");
        let (state, replica) = result
            .replica
            .entity_slot(&entity_id, &signer_id)
            .expect("local replica");
        assert_eq!(state.entity.last_finalized_j_height, 1);
        assert_eq!(
            state.entity.reserves.get(&1),
            Some(&num_bigint::BigInt::from(10_u8)),
        );
        let history = replica
            .replica_metadata
            .get("jHistory")
            .expect("durable local J history");
        assert_eq!(history["scannedThroughHeight"], 1);
        assert_eq!(history["contiguousThroughHeight"], 1);
        assert_eq!(
            history["eventBlocks"]["value"].as_array().map(Vec::len),
            Some(0),
        );
    }

    fn ordered_observation_fixture() -> (crate::RuntimeReplica, RuntimeInput) {
        let mut runtime =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let entity_id = crate::machine::tests::owner_bytes();
        let signer_id = crate::machine::tests::entity_signer_id();
        let key = crate::RuntimeEntityKey::new(entity_id, &signer_id).expect("entity key");
        let number = |value| {
            CanonicalValue::Number(
                xln_rscore_protocol::CanonicalNumber::try_from_u64(value).expect("safe number"),
            )
        };
        let jurisdiction_ref = format!("stack:31337:0x{}", "88".repeat(20));
        let (state, replica) = runtime
            .entity_slot_mut(&entity_id, &signer_id)
            .expect("entity slot");
        state.entity.last_finalized_j_height = 35;
        state.entity.j_history_finality = Some(CanonicalValue::Object(vec![
            (
                "jurisdictionRef".into(),
                CanonicalValue::String(jurisdiction_ref.clone()),
            ),
            ("finalizedThroughHeight".into(), number(35)),
            (
                "tipBlockHash".into(),
                CanonicalValue::String(format!("0x{}", "35".repeat(32))),
            ),
            (
                "eventHistoryRoot".into(),
                CanonicalValue::String(format!("0x{}", "11".repeat(32))),
            ),
        ]));
        replica.entity_consensus.state.authority.config.jurisdiction =
            Some(CanonicalValue::Object(vec![
                ("chainId".into(), number(31_337)),
                (
                    "depositoryAddress".into(),
                    CanonicalValue::String(format!("0x{}", "88".repeat(20))),
                ),
                (
                    "entityProviderAddress".into(),
                    CanonicalValue::String(format!("0x{}", "99".repeat(20))),
                ),
            ]));
        let block_hash = [0x44; 32];
        let event = JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
            metadata: JEventMetadata {
                block_number: Some(36),
                block_hash: Some(block_hash),
                transaction_hash: Some([0x55; 32]),
                log_index: Some(0),
                event_index: None,
            },
            entity: super::render_word(&entity_id),
            token_id: 1,
            new_balance: num_bigint::BigInt::from(10_u8),
        });
        let observation = ObserveJRange {
            entity_id: EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
            signer_id: signer_id.clone(),
            jurisdiction_ref,
            scanned_through_height: 36,
            tip_block_hash: block_hash,
            headers_present: true,
            headers: vec![FinalizedJHeader {
                j_height: 36,
                j_block_hash: block_hash,
            }],
            batches: vec![
                xln_rscore_entity_kernel::project_finalized_j_event_batch(
                    &EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
                    36,
                    block_hash,
                    vec![event],
                    Vec::new(),
                )
                .expect("projected J batch"),
            ],
        };
        let prefix_input = super::build_local_j_prefix_entity_input(&runtime, &observation)
            .expect("live canonical prefix input")
            .expect("required prefix certificate");
        let event_observation = ObserveJRange {
            headers_present: false,
            headers: Vec::new(),
            ..observation.clone()
        };
        let header_observation = ObserveJRange {
            batches: Vec::new(),
            ..observation
        };
        let input = RuntimeInput {
            runtime_txs: vec![
                RuntimeTx::ObserveJRange(event_observation),
                RuntimeTx::ObserveJRange(header_observation),
            ],
            entity_inputs: vec![prefix_input],
            frame: RuntimeFrameContext {
                timestamp: 1_001,
                // Replay has only the prior committed Runtime height here;
                // ObserveJRange is the canonical source for this frame.
                finalized_j_height: 0,
                entity_contexts: std::collections::BTreeMap::from([(
                    key.clone(),
                    VecDeque::from([RuntimeEntityFrameContext {
                        execution: xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
                        canonical: CanonicalValue::Object(Vec::new()),
                    }]),
                )]),
            },
        };
        (runtime, input)
    }

    #[test]
    fn live_due_wake_and_observed_j_prefix_share_one_entity_round_and_replay_exactly() {
        let setup = || {
            let (mut runtime, input) = ordered_observation_fixture();
            let key = crate::RuntimeEntityKey::new(
                crate::machine::tests::owner_bytes(),
                &crate::machine::tests::entity_signer_id(),
            )
            .unwrap();
            runtime
                .state
                .e_replicas
                .get_mut(&key)
                .unwrap()
                .entity
                .crontab = Some(xln_rscore_entity_kernel::CrontabState {
                tasks: BTreeMap::new(),
                hooks: xln_rscore_entity_kernel::ScheduledHookMap::restore(BTreeMap::from([(
                    "dispute-deadline:due".into(),
                    xln_rscore_entity_kernel::ScheduledHook {
                        id: "dispute-deadline:due".into(),
                        trigger_at: 1_000,
                        kind: xln_rscore_entity_kernel::ScheduledHookKind::DisputeDeadline {
                            account_id: "peer".into(),
                        },
                    },
                )]))
                .unwrap(),
            });
            (runtime, input, key)
        };
        let (runtime, input, key) = setup();
        let live = super::apply_runtime_live(
            runtime,
            crate::RuntimeLiveInput {
                runtime_txs: input.runtime_txs,
                entity_inputs: input.entity_inputs,
                timestamp: input.frame.timestamp,
                finalized_j_height: input.frame.finalized_j_height,
            },
            &mut crate::CanonicalEntityInfraMaterializer::new(),
        )
        .expect("live wake must not run before its selected J-prefix observation");
        let accepted = live.applied_frame.as_ref().unwrap();
        assert_eq!(accepted.entity_frame_count, 1);
        assert_eq!(accepted.entity_inputs.len(), 2);
        let head = &live.replica.e_replicas[&key]
            .entity_consensus
            .certified_frame_head
            .as_ref()
            .unwrap()
            .frame;
        assert_eq!(
            head.txs.iter().map(|tx| tx.kind).collect::<Vec<_>>(),
            vec![EntityTxKind::ScheduledWake, EntityTxKind::JEvent]
        );
        assert_eq!(
            live.replica.state.e_replicas[&key]
                .entity
                .last_finalized_j_height,
            36
        );
        let (replay_runtime, _, _) = setup();
        let mut replay_frame = accepted.frame.clone();
        replay_frame.entity_contexts = BTreeMap::from([(
            key.clone(),
            VecDeque::from([RuntimeEntityFrameContext {
                execution: xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
                canonical: live.outputs.entities[0].entity_context.clone(),
            }]),
        )]);
        let replay = super::apply_runtime(
            replay_runtime,
            RuntimeInput {
                runtime_txs: accepted.runtime_txs.clone(),
                entity_inputs: accepted
                    .entity_inputs
                    .iter()
                    .cloned()
                    .map(RuntimeEntityInput::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap(),
                frame: replay_frame,
            },
        )
        .expect("same accepted WAL input replays");
        assert_eq!(
            replay.applied_frame.as_ref().unwrap().entity_inputs,
            accepted.entity_inputs
        );
        assert_eq!(replay.outputs.entities.len(), 1);
        let actual = &replay.outputs.entities[0];
        let expected = &live.outputs.entities[0];
        assert_eq!(actual.entity_frame_hash, expected.entity_frame_hash);
        assert_eq!(actual.entity_state_root, expected.entity_state_root);
        assert_eq!(actual.accounts_root, expected.accounts_root);
        assert_eq!(actual.entity_frame_events, expected.entity_frame_events);
        assert_eq!(
            format!("{:?}", actual.local_entity_outputs),
            format!("{:?}", expected.local_entity_outputs)
        );
        assert_eq!(
            replay.replica.e_replicas[&key].replica_metadata,
            live.replica.e_replicas[&key].replica_metadata
        );
    }

    #[test]
    fn ordered_observations_are_certified_only_by_the_recorded_prefix_attestation() {
        let (runtime, input) = ordered_observation_fixture();
        let entity_id = crate::machine::tests::owner_bytes();
        let signer_id = crate::machine::tests::entity_signer_id();
        let key = crate::RuntimeEntityKey::new(entity_id, &signer_id).unwrap();
        let result = super::apply_runtime(runtime, input).expect("J range Runtime replay");
        let applied = result
            .applied_frame
            .as_ref()
            .expect("durable Runtime frame");
        assert!(matches!(
            applied.runtime_txs.as_slice(),
            [RuntimeTx::ObserveJRange(_), RuntimeTx::ObserveJRange(_)]
        ));
        assert_eq!(applied.entity_inputs.len(), 1);
        assert!(
            applied.entity_inputs[0]
                .get("jPrefixAttestations")
                .is_some()
        );
        let state = result.replica.state.e_replicas.get(&key).expect("state");
        let replica = result.replica.e_replicas.get(&key).expect("replica");
        let frame = &replica
            .entity_consensus
            .certified_frame_head
            .as_ref()
            .expect("certified frame")
            .frame;
        assert_eq!(state.entity.last_finalized_j_height, 36);
        assert_eq!(frame.txs.len(), 1);
        assert_eq!(frame.txs[0].kind, EntityTxKind::JEvent);
        assert!(frame.j_prefix_certificate.is_some());

        let mut committed = result.replica;
        let before = committed
            .entity_slot(&entity_id, &signer_id)
            .expect("committed slot")
            .1
            .replica_metadata
            .clone();
        let stale = ObserveJRange {
            entity_id: EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
            signer_id: signer_id.clone(),
            jurisdiction_ref: format!("stack:31337:0x{}", "88".repeat(20)),
            scanned_through_height: 35,
            tip_block_hash: [0x35; 32],
            headers_present: false,
            headers: Vec::new(),
            batches: Vec::new(),
        };
        let (state, replica) = committed
            .entity_slot_mut(&entity_id, &signer_id)
            .expect("committed mutable slot");
        super::record_j_observation(state, replica, &stale)
            .expect("stale observation validates without mutation");
        assert_eq!(replica.replica_metadata, before);
    }

    #[test]
    fn stale_remote_entity_command_is_rejected_by_origin_without_touching_local_input() {
        let mut replica =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let signer_id = crate::machine::tests::entity_signer_id();
        let owner = crate::machine::tests::owner_bytes();
        let entity_key = crate::RuntimeEntityKey::new(owner, &signer_id).expect("key");
        let (state, entity_replica) = replica
            .take_entity_slot(&entity_key.entity_id, &entity_key.signer_id)
            .expect("fixture Entity slot");
        let slot = super::EntityApplySlot {
            state,
            replica: entity_replica,
        };
        let board = super::command_board(&slot).expect("board");
        let entity_id = super::render_word(&owner);
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::Chat,
            CanonicalValue::Object(vec![
                ("from".into(), CanonicalValue::String(signer_id.clone())),
                ("message".into(), CanonicalValue::String("stale".into())),
            ]),
        )
        .expect("chat tx");
        // Nonce 1 is the only admissible first command; advance a private
        // nonce state so the remote command claims nonce 2.
        let mut advanced = slot.state.entity.entity_command_nonces.clone();
        super::normalize_entity_command_nonce_board(&mut advanced, &board).expect("board");
        let (first, _) = xln_rscore_entity_kernel::build_locally_authored_entity_command(
            &slot.replica.entity_signer,
            &board,
            advanced.as_ref(),
            &entity_id,
            std::slice::from_ref(&tx),
        )
        .expect("first command");
        xln_rscore_entity_kernel::advance_entity_command_nonce(&mut advanced, &board, &first)
            .expect("advance");
        let (_, stale) = xln_rscore_entity_kernel::build_locally_authored_entity_command(
            &slot.replica.entity_signer,
            &board,
            advanced.as_ref(),
            &entity_id,
            std::slice::from_ref(&tx),
        )
        .expect("stale command");
        replica
            .install_entity_slot(entity_key.clone(), slot.state, slot.replica)
            .expect("restore slot");
        let remote = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": entity_id,
            "signerId": signer_id,
            "from": format!("0x{}", "ab".repeat(20)),
            "runtimeId": format!("0x{}", "cd".repeat(20)),
            "sourceRuntimeFrame": {"height": 1, "timestamp": 1},
            "entityTxs": [{
                "type": "entityCommand",
                "data": crate::tagged_json_from_canonical_value(&stale.wire_data)
                    .expect("tagged command"),
            }],
        }))
        .expect("remote input");
        let local = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": entity_id,
            "signerId": signer_id,
            "entityTxs": [{"type": "chat", "data": {"from": signer_id, "message": "local"}}],
        }))
        .expect("local input");
        let mut input = crate::machine::tests::frame_for_test(1, vec![remote, local]);
        super::reject_invalid_remote_commands(&replica, &mut input).expect("preflight");
        assert_eq!(input.entity_inputs.len(), 1);
        assert!(input.entity_inputs[0].source_runtime_id().is_none());
    }
}
