//! One exact projection from the owned Runtime result to durable WAL bytes.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use thiserror::Error;
use xln_rscore_batch::AccountInputKind;
use xln_rscore_engine::AccountTx;
use xln_rscore_entity_kernel::{LocalEntityOutput, LocalEntityOutputTx};

use crate::storage::native::{
    CanonicalRuntimeFrameDraft, CanonicalStateCommitment, CheckpointGraph, EncodedRuntimeFrame,
    PathNodeChange, RuntimeFrameEntityHash, RuntimeMachineGraphRoot, RuntimeMachineLeafRow,
    TouchedAccount, build_runtime_frame_commit,
};
use crate::{
    CanonicalRuntimeEntityHash, RuntimeApplyResult, RuntimeCommitmentError, RuntimeComponentDigest,
    RuntimeEntityKey, TaggedJsonError, compute_canonical_runtime_state_hash,
    compute_runtime_component_digest,
};

use super::checkpoint_projection::{AccountCheckpointProjectionError, prepare_account_checkpoint};
use super::context_projection::{EntityContextProjectionError, prepare_entity_context_rows};
use super::entity_checkpoint_projection::{
    EntityCheckpointProjectionError, prepare_entity_checkpoint,
};
use super::machine_snapshot::{RuntimeMachineProjectionError, prepare_runtime_machine_graph};
use super::replica_meta::{PreparedReplicaMeta, ReplicaMetaProjectionError, prepare_replica_meta};
use super::{EntityOutputEncodingError, EntityRouteError, EntityRouteTable};

static PROFILE_PROJECTION: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// One process-wide gate owns all fine-grained Runtime wall diagnostics.
/// Keeping the lookup here prevents projection, reducer and storage from
/// drifting onto separate profiling modes or paying an environment lookup per
/// frame.
pub(super) fn runtime_profile_enabled() -> bool {
    *PROFILE_PROJECTION
        .get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_PROJECTION").as_deref() == Ok("1"))
}

fn output_key(output: &crate::RuntimeEntityOutputs) -> RuntimeEntityKey {
    RuntimeEntityKey {
        entity_id: output.entity_id,
        signer_id: output.signer_id.clone(),
    }
}

pub(crate) fn checkpoint_graph_due(result: &RuntimeApplyResult) -> bool {
    let checkpoint_barrier = result.applied_frame.as_ref().is_some_and(|frame| {
        frame.runtime_txs.len() == 1
            && matches!(frame.runtime_txs[0], crate::RuntimeTx::CheckpointBarrier)
    });
    checkpoint_barrier
        || result
            .outputs
            .entities
            .iter()
            .any(|output| output.checkpoint.is_some())
}

/// Mirror delivery/identity.ts: a pure proposal is live only while it is the
/// sender's exact pending height/hash. An attached ACK remains owed even after
/// that proposal commits or rolls back, so the whole envelope must survive.
pub(super) fn replay_proposal_settled(
    replica: &mut crate::RuntimeReplica,
    output: &Value,
) -> Result<bool, RuntimeFrameProjectionError> {
    let proposals = output["entityTxs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|tx| tx["type"] == "accountInput" && tx["data"]["kind"] == "ack_frame")
        .map(|tx| &tx["data"])
        .collect::<Vec<_>>();
    if proposals.is_empty() || proposals.iter().any(|data| !data["ack"].is_null()) {
        return Ok(false);
    }
    for data in proposals {
        let field = |value: &Value, field: &str| {
            value[field].as_str().map(str::to_owned).ok_or_else(|| {
                RuntimeFrameProjectionError::ReplayOutbox(format!("FIELD_INVALID:{field}"))
            })
        };
        let owner_text = field(data, "fromEntityId")?;
        let counterparty_text = field(data, "toEntityId")?;
        let owner = parse_digest(&owner_text)?;
        let counterparty = parse_digest(&counterparty_text)?;
        let frame = &data["proposal"]["frame"];
        let height = frame["height"].as_u64().ok_or_else(|| {
            RuntimeFrameProjectionError::ReplayOutbox("PROPOSAL_HEIGHT_INVALID".into())
        })?;
        let hash = parse_digest(&field(frame, "stateHash")?)?;
        let mut source = None;
        for (key, live) in &mut replica.e_replicas {
            if key.entity_id == owner {
                source = live.accounts.account_status(
                    xln_rscore_batch::AccountId::from_bytes(counterparty),
                    Vec::new(),
                )?;
                if source.is_some() {
                    break;
                }
            }
        }
        let source = source.ok_or_else(|| {
            RuntimeFrameProjectionError::ReplayOutbox(format!(
                "ACCOUNT_PROPOSAL_SOURCE_MISSING:{owner_text}:{counterparty_text}:{height}",
            ))
        })?;
        if source.pending_frame_height == Some(height)
            && source.pending_frame_state_hash == Some(hash)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn plan_replay_outbox(
    replica: &mut crate::RuntimeReplica,
    routes: &EntityRouteTable,
    retained: super::replay_outbox::RetainedReplayOutbox,
    current: Vec<super::routing::BoundEntityOutput>,
) -> Result<Vec<super::routing::BoundEntityOutput>, RuntimeFrameProjectionError> {
    use super::routing::BoundEntityOutput;
    let mut remote = retained.into_values();
    for (index, output) in remote.iter().enumerate() {
        routes.validate_retained_output(output, index)?;
    }
    let mut local = Vec::new();
    for output in current {
        match output {
            BoundEntityOutput::Remote { value, .. } => remote.push(value),
            BoundEntityOutput::Local(input) => local.push(BoundEntityOutput::Local(input)),
        }
    }
    let mut pending = Vec::new();
    for output in remote {
        if !replay_proposal_settled(replica, &output)? {
            pending.push(output);
        }
    }
    let mut bound = super::replay_outbox::merge_replay_outbox(pending)
        .map_err(RuntimeFrameProjectionError::ReplayOutbox)?
        .into_iter()
        .map(|value| {
            let row = crate::transport::msgpack::encode_framed(&value)?;
            Ok(BoundEntityOutput::Remote { row, value })
        })
        .collect::<Result<Vec<_>, crate::transport::RuntimeTransportError>>()?;
    bound.extend(local);
    Ok(bound)
}

fn export_checkpoint_barrier(
    result: &mut RuntimeApplyResult,
    enabled: bool,
) -> Result<
    BTreeMap<RuntimeEntityKey, xln_rscore_batch::AccountsCheckpoint>,
    RuntimeFrameProjectionError,
> {
    if !enabled {
        return Ok(BTreeMap::new());
    }
    let height = result.replica.state.height;
    let mut checkpoints = BTreeMap::new();
    for (key, live) in &mut result.replica.e_replicas {
        checkpoints.insert(key.clone(), live.accounts.export_checkpoint()?);
        live.last_materialized_height = height;
    }
    Ok(checkpoints)
}

fn prepare_checkpoint_graph_changes(
    result: &RuntimeApplyResult,
    replica_metas: &[(RuntimeEntityKey, PreparedReplicaMeta)],
    prior: &BTreeMap<Vec<u8>, Vec<u8>>,
    barrier: bool,
    barrier_checkpoints: &BTreeMap<RuntimeEntityKey, xln_rscore_batch::AccountsCheckpoint>,
) -> Result<Vec<PathNodeChange>, RuntimeFrameProjectionError> {
    let mut changes = Vec::new();
    let mut append = |key: &RuntimeEntityKey, accounts: &xln_rscore_batch::AccountsCheckpoint| {
        let state = result
            .replica
            .state
            .e_replicas
            .get(key)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
        let live = result
            .replica
            .e_replicas
            .get(key)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
        let meta = replica_metas
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, meta)| meta)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
        let entity = prepare_entity_checkpoint(state, live, &meta.entry, prior)?;
        let account = prepare_account_checkpoint(
            accounts,
            key.entity_id,
            entity.protocol_fingerprint,
            prior,
        )?;
        changes = merge_checkpoint_changes(std::mem::take(&mut changes), entity.changes)?;
        changes = merge_checkpoint_changes(std::mem::take(&mut changes), account.changes)?;
        Ok::<(), RuntimeFrameProjectionError>(())
    };
    if barrier {
        for (key, accounts) in barrier_checkpoints {
            append(key, accounts)?;
        }
    } else {
        for output in &result.outputs.entities {
            if let Some(accounts) = output.checkpoint.as_ref() {
                append(&output_key(output), accounts)?;
            }
        }
    }
    Ok(changes)
}

pub(crate) struct ProjectedRuntimeFrame {
    pub encoded: EncodedRuntimeFrame,
    pub expected_previous_hash: [u8; 32],
    pub replica: crate::RuntimeReplica,
    pub commitments: super::RuntimeDurableCommitments,
    /// Ordered replay evidence captured by the one authoritative Runtime
    /// transition. This is deliberately diagnostic-only: it is returned only
    /// after WAL fsync and never becomes a second consensus commitment.
    pub account_commits: Vec<crate::AccountCommitEvidence>,
    /// Exact self-routed Runtime inputs derived during exact replay. They are
    /// compared with the TS plan seam and never enqueued or persisted.
    pub local_continuations: Vec<serde_json::Value>,
    pub post_commit_j_attempts: Vec<crate::j_submit::DurableJAttempt>,
    pub accepted_payments: usize,
    pub completed_payments: usize,
    pub matched_swaps: usize,
    /// Exact zero-fill swap resolutions emitted by the Entity matcher. These
    /// are terminal orderbook rejections/cancels, not missing submitted work.
    pub zero_fill_swap_cancels: usize,
    pub paybook_open: usize,
    pub runtime_entity_inputs: usize,
    pub account_inputs: usize,
    pub canonical_input_bytes: usize,
    pub entity_txs_selected: usize,
    pub entity_txs_pending: usize,
    pub projection_input: std::time::Duration,
    pub projection_machine: std::time::Duration,
    pub projection_meta: std::time::Duration,
    pub projection_context: std::time::Duration,
    pub projection_checkpoint: std::time::Duration,
    pub projection_encode: std::time::Duration,
}

pub(crate) enum DurableProjection {
    Idle(Box<crate::RuntimeReplica>),
    Frame(Box<ProjectedRuntimeFrame>),
}

fn zero_fill_swap_cancels(outputs: &[LocalEntityOutput]) -> usize {
    outputs
        .iter()
        .flat_map(|output| output.entity_txs.iter())
        .flat_map(|tx| match tx {
            LocalEntityOutputTx::AccountInput(input) => match &input.kind {
                AccountInputKind::AckFrame { frame, .. } => frame.frame.txs.iter(),
                AccountInputKind::Ack(_)
                | AccountInputKind::Dispute(_)
                | AccountInputKind::BoardHankoRefresh(_) => [].iter(),
            },
            LocalEntityOutputTx::Projected(_) => [].iter(),
        })
        .filter(|tx| {
            matches!(
                tx,
                AccountTx::SwapResolve {
                    fill_ratio: 0,
                    cancel_remainder: true,
                    ..
                }
            )
        })
        .count()
}

#[derive(Default)]
struct LocalOutputMeasure {
    account_inputs: usize,
    ack_inputs: usize,
    ack_frame_inputs: usize,
    frame_txs: usize,
    frame_hankos: usize,
    frame_hanko_bytes: usize,
    dispute_hankos: usize,
    dispute_hanko_bytes: usize,
}

impl LocalOutputMeasure {
    fn add_assign(&mut self, other: &Self) {
        self.account_inputs += other.account_inputs;
        self.ack_inputs += other.ack_inputs;
        self.ack_frame_inputs += other.ack_frame_inputs;
        self.frame_txs += other.frame_txs;
        self.frame_hankos += other.frame_hankos;
        self.frame_hanko_bytes += other.frame_hanko_bytes;
        self.dispute_hankos += other.dispute_hankos;
        self.dispute_hanko_bytes += other.dispute_hanko_bytes;
    }
}

fn measure_hanko(measure: &mut LocalOutputMeasure, hanko: Option<&Vec<u8>>, dispute: bool) {
    let Some(hanko) = hanko else {
        return;
    };
    if dispute {
        measure.dispute_hankos += 1;
        measure.dispute_hanko_bytes += hanko.len();
    } else {
        measure.frame_hankos += 1;
        measure.frame_hanko_bytes += hanko.len();
    }
}

fn measure_dispute(
    measure: &mut LocalOutputMeasure,
    dispute: Option<&xln_rscore_engine::CounterpartyDispute>,
) {
    measure_hanko(
        measure,
        dispute.and_then(|value| value.hanko.as_ref()),
        true,
    );
}

/// Count exact owned Hanko bytes before the output moves into the encoder.
/// This is profiler-only and never adds a production traversal.
fn measure_local_outputs(outputs: &[LocalEntityOutput]) -> LocalOutputMeasure {
    let mut measure = LocalOutputMeasure::default();
    for input in outputs
        .iter()
        .flat_map(|output| output.entity_txs.iter())
        .filter_map(|tx| match tx {
            LocalEntityOutputTx::AccountInput(input) => Some(input),
            LocalEntityOutputTx::Projected(_) => None,
        })
    {
        measure.account_inputs += 1;
        match &input.kind {
            AccountInputKind::Ack(ack) => {
                measure.ack_inputs += 1;
                measure_hanko(&mut measure, ack.frame_hanko.as_ref(), false);
                measure_dispute(&mut measure, ack.dispute.as_ref());
            }
            AccountInputKind::AckFrame { ack, frame } => {
                measure.ack_frame_inputs += 1;
                measure.frame_txs += frame.frame.txs.len();
                measure_hanko(
                    &mut measure,
                    ack.as_ref().and_then(|ack| ack.frame_hanko.as_ref()),
                    false,
                );
                measure_hanko(&mut measure, frame.frame_hanko.as_ref(), false);
                measure_dispute(
                    &mut measure,
                    ack.as_ref().and_then(|ack| ack.dispute.as_ref()),
                );
                measure_dispute(&mut measure, frame.dispute.as_ref());
            }
            AccountInputKind::Dispute(dispute) => {
                measure_dispute(&mut measure, Some(dispute));
            }
            AccountInputKind::BoardHankoRefresh(refresh) => {
                measure_hanko(&mut measure, refresh.frame_hanko.as_ref(), false);
                measure_dispute(&mut measure, refresh.dispute.as_ref());
            }
        }
    }
    measure
}

/// Project one already-certified reducer result. Current financial outputs
/// come only from that result. Replay may additionally retain exact prior
/// native WAL output as proven transport evidence, never synthesize a new body.
pub(crate) fn project_durable_frame(
    mut result: RuntimeApplyResult,
    routes: &EntityRouteTable,
    prior_checkpoint_rows: Option<&BTreeMap<Vec<u8>, Vec<u8>>>,
    materialize_runtime: bool,
    capture_replay_diagnostics: bool,
    exact_replay: bool,
    retained_replay_outbox: super::replay_outbox::RetainedReplayOutbox,
) -> Result<DurableProjection, RuntimeFrameProjectionError> {
    let checkpoint_due = materialize_runtime || checkpoint_graph_due(&result);
    let Some(applied) = result.applied_frame.take() else {
        if result.applied_input.is_some()
            || !result.outputs.entities.is_empty()
            || result.outputs.touches != crate::RuntimeFrameTouches::default()
            || !result.account_commits.is_empty()
            || !result.post_commit_j_attempts.is_empty()
        {
            return Err(RuntimeFrameProjectionError::IdleShape);
        }
        return Ok(DurableProjection::Idle(Box::new(result.replica)));
    };
    let profile = runtime_profile_enabled();
    let prelude_started = std::time::Instant::now();
    let post_commit_j_attempts = std::mem::take(&mut result.post_commit_j_attempts);
    let applied_input = result
        .applied_input
        .as_ref()
        .ok_or(RuntimeFrameProjectionError::AppliedInputMissing)?;
    let runtime_entity_inputs = applied_input.entity_inputs;
    let account_inputs = applied_input.account_inputs;
    let canonical_input_bytes = applied_input.canonical_wire_bytes;
    let entity_txs_selected = applied_input.entity_txs_selected;
    let entity_txs_pending = applied_input.entity_txs_pending;
    let entity_frame_count = applied.entity_frame_count;
    let checkpoint_barrier = applied.runtime_txs.len() == 1
        && matches!(applied.runtime_txs[0], crate::RuntimeTx::CheckpointBarrier);
    if checkpoint_due && prior_checkpoint_rows.is_none() {
        // A cadence checkpoint is one indivisible graph. Persisting only its
        // RuntimeFrame would make the WAL tail unrecoverable, so fail before
        // writing anything until the exact 0x17-0x38 projector is available.
        return Err(RuntimeFrameProjectionError::CheckpointGraphUnavailable(
            result.replica.state.height,
        ));
    }
    if entity_frame_count != result.outputs.entities.len() {
        return Err(RuntimeFrameProjectionError::CertifiedFrameMismatch(
            format!(
                "COUNT:applied={entity_frame_count}:outputs={}",
                result.outputs.entities.len()
            ),
        ));
    }
    if entity_frame_count == 0 && !result.account_commits.is_empty() {
        return Err(RuntimeFrameProjectionError::RuntimeOnlyShape);
    }
    let mut entity_commitments = Vec::with_capacity(entity_frame_count);
    // Production only reports the event cardinality. The owned vector is a
    // replay-only oracle input; cloning every event into it in live H1 was
    // pure data movement that could not affect the committed frame.
    let mut frame_events = capture_replay_diagnostics.then(Vec::new);
    let mut final_output_indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
    for (index, output) in result.outputs.entities.iter().enumerate() {
        final_output_indexes.insert(output_key(output), index);
    }
    for (index, output) in result.outputs.entities.iter().enumerate() {
        let key = output_key(output);
        if final_output_indexes.get(&key) == Some(&index) {
            assert_certified_result(&result, output)?;
        }
        if let Some(events) = frame_events.as_mut() {
            events.extend(output.entity_frame_events.iter().cloned());
        }
        entity_commitments.push(super::RuntimeDurableEntityCommitment {
            entity_id: output.entity_id,
            certified_frame_hash: parse_digest(&output.entity_frame_hash)?,
            state_root: parse_digest(&output.entity_state_root)?,
            authority_root: parse_digest(&output.entity_authority_root)?,
            accounts_root: output.accounts_root,
        });
    }
    let shape_done = prelude_started.elapsed();
    let entity_event_count_usize =
        result
            .outputs
            .entities
            .iter()
            .try_fold(0_usize, |count, output| {
                count.checked_add(output.entity_frame_events.len()).ok_or(
                    RuntimeFrameProjectionError::EventCount(output.entity_frame_events.len()),
                )
            })?;
    let entity_event_count = u64::try_from(entity_event_count_usize)
        .map_err(|_| RuntimeFrameProjectionError::EventCount(entity_event_count_usize))?;
    let events_parity_digest = frame_events.as_ref().map_or(Ok([0; 32]), |events| {
        xln_rscore_entity_kernel::compute_entity_events_parity_digest(events)
    })?;
    let event_digest_done = prelude_started.elapsed();
    let entity_effect_count_usize =
        result
            .outputs
            .entities
            .iter()
            .try_fold(0_usize, |count, output| {
                let observed = output
                    .entity_events
                    .iter()
                    .filter(|event| event.is_runtime_event())
                    .count();
                count
                    .checked_add(observed)
                    .ok_or(RuntimeFrameProjectionError::EntityEffectCount(observed))
            })?;
    let entity_effect_count = u64::try_from(entity_effect_count_usize)
        .map_err(|_| RuntimeFrameProjectionError::EntityEffectCount(entity_effect_count_usize))?;
    let entity_events = capture_replay_diagnostics.then(|| {
        result
            .outputs
            .entities
            .iter()
            .flat_map(|output| output.entity_events.iter().cloned())
            .collect::<Vec<_>>()
    });
    let entity_effects_parity_digest = entity_events.as_ref().map_or(Ok([0; 32]), |events| {
        xln_rscore_entity_kernel::compute_entity_effects_parity_digest(events)
    })?;
    let effect_digest_done = prelude_started.elapsed();
    let (accepted_payments, completed_payments, matched_swaps) = result
        .outputs
        .entities
        .iter()
        .flat_map(|output| output.entity_events.iter())
        .try_fold(
            (0_usize, 0_usize, 0_u64),
            |counts, event| -> Result<_, RuntimeFrameProjectionError> {
                let (accepted, completed, matched) = counts;
                match event {
                    xln_rscore_entity_kernel::EntityKernelOutput::HtlcForwardAccepted {
                        ..
                    } => Ok((
                        accepted.checked_add(1).ok_or(
                            RuntimeFrameProjectionError::EntityEffectCount(
                                entity_effect_count_usize,
                            ),
                        )?,
                        completed,
                        matched,
                    )),
                    xln_rscore_entity_kernel::EntityKernelOutput::HtlcReceived { .. } => Ok((
                        accepted,
                        completed.checked_add(1).ok_or(
                            RuntimeFrameProjectionError::EntityEffectCount(
                                entity_effect_count_usize,
                            ),
                        )?,
                        matched,
                    )),
                    xln_rscore_entity_kernel::EntityKernelOutput::SwapMatched { count, .. } => {
                        Ok((
                            accepted,
                            completed,
                            matched
                                .checked_add(*count)
                                .ok_or(RuntimeFrameProjectionError::SwapCount(*count))?,
                        ))
                    }
                    _ => Ok((accepted, completed, matched)),
                }
            },
        )?;
    let matched_swaps = usize::try_from(matched_swaps)
        .map_err(|_| RuntimeFrameProjectionError::SwapCount(matched_swaps))?;
    let count_done = prelude_started.elapsed();
    let paybook_open = result
        .replica
        .state
        .e_replicas
        .values()
        .map(|state| state.entity.paybook.entries.len())
        .sum();
    let account_commits = std::mem::take(&mut result.account_commits);

    let zero_fill_swap_cancels = result
        .outputs
        .entities
        .iter()
        .map(|output| zero_fill_swap_cancels(&output.local_entity_outputs))
        .sum();
    let output_measure = if profile {
        {
            result.outputs.entities.iter().fold(
                LocalOutputMeasure::default(),
                |mut total, output| {
                    let measured = measure_local_outputs(&output.local_entity_outputs);
                    total.add_assign(&measured);
                    total
                },
            )
        }
    } else {
        Default::default()
    };
    let mut local_outputs = Vec::new();
    for entity in &mut result.outputs.entities {
        let atomic_pair = entity.atomic_cross_jurisdiction_pair.clone();
        local_outputs.extend(
            std::mem::take(&mut entity.local_entity_outputs)
                .into_iter()
                .map(|output| {
                    (
                        entity.entity_id,
                        entity.signer_id.clone(),
                        atomic_pair.clone(),
                        output,
                    )
                }),
        );
    }
    let local_output_done = prelude_started.elapsed();
    let worker_key = local_outputs
        .first()
        .map(|(entity_id, signer_id, _, _)| RuntimeEntityKey {
            entity_id: *entity_id,
            signer_id: signer_id.clone(),
        });
    // Resolve every read-only source identity without returning early. The
    // worker replies remain in dense input order, so collecting their Results
    // below preserves the serial path's first failing output index exactly.
    let projection_outputs = local_outputs
        .into_iter()
        .enumerate()
        .map(|(index, (entity_id, signer_id, atomic_pair, output))| {
            let key = RuntimeEntityKey {
                entity_id,
                signer_id: signer_id.clone(),
            };
            let source_entity_id = result
                .replica
                .state
                .e_replicas
                .get(&key)
                .map(|state| state.entity.entity_id.clone());
            (index, source_entity_id, signer_id, atomic_pair, output)
        })
        .collect::<Vec<_>>();
    let bound = if let Some(worker_key) = worker_key {
        let source_height = result.replica.state.height;
        let source_timestamp = result.replica.state.timestamp;
        let routes = routes.clone();
        result
            .replica
            .e_replicas
            .get_mut(&worker_key)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?
            .accounts
            .map_stateless_ordered(
                projection_outputs,
                move |(index, source_entity_id, signer_id, atomic_pair, output)| {
                    let source_entity_id = source_entity_id
                        .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
                    let value = super::output::encode_local_entity_output(
                        index,
                        output,
                        &source_entity_id,
                        &signer_id,
                    )?;
                    let mut bound = routes.bind_and_encode_one(
                        value,
                        index,
                        source_height,
                        source_timestamp,
                        &source_entity_id,
                        &signer_id,
                    )?;
                    if let Some(pair) = atomic_pair {
                        let super::routing::BoundEntityOutput::Remote { row, value } = &mut bound
                        else {
                            return Err(RuntimeFrameProjectionError::AtomicPairLocalOutput);
                        };
                        let object = value
                            .as_object_mut()
                            .ok_or(RuntimeFrameProjectionError::AtomicPairOutputObject)?;
                        object.insert(
                            "atomicCrossJurisdictionPair".into(),
                            serde_json::json!({
                                "phase": pair.phase,
                                "pairKey": pair.pair_key,
                            }),
                        );
                        *row = crate::transport::msgpack::encode_framed(value)?;
                    }
                    Ok::<_, RuntimeFrameProjectionError>(bound)
                },
            )?
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let bound = if exact_replay {
        plan_replay_outbox(&mut result.replica, routes, retained_replay_outbox, bound)?
    } else {
        bound
    };
    let bound_outputs = EntityRouteTable::collect_bound(bound);
    let bind_done = prelude_started.elapsed();
    let local_continuations =
        local_continuation_evidence(&bound_outputs.local_continuations, exact_replay);
    enqueue_local_continuations(
        &mut result.replica.mempool,
        result.replica.limits,
        bound_outputs.local_continuations,
        &applied.frame,
        exact_replay,
    )?;
    let continuation_done = prelude_started.elapsed();

    // The first native checkpoint owns the entire initial Entity inventory,
    // including height-zero siblings not selected by this Runtime input.
    let full_checkpoint = materialize_runtime
        || checkpoint_barrier
        || (checkpoint_due && prior_checkpoint_rows.is_some_and(BTreeMap::is_empty));
    let barrier_checkpoints = export_checkpoint_barrier(&mut result, full_checkpoint)?;
    let phase_started = std::time::Instant::now();
    let runtime_input = runtime_input(applied.runtime_txs, applied.entity_inputs)?;
    let projection_input = phase_started.elapsed();
    let component_digests = component_digests(&result.replica.durable)?;
    let machine_done = phase_started.elapsed();
    let projection_machine = machine_done.saturating_sub(projection_input);
    let mut replica_metas = Vec::with_capacity(result.replica.state.e_replicas.len());
    for key in result.replica.state.e_replicas.keys() {
        replica_metas.push((
            key.clone(),
            prepare_replica_meta(&result, key, checkpoint_due)?,
        ));
    }
    let replica_meta_entries = replica_metas
        .iter()
        .map(|(_, meta)| meta.entry.clone())
        .collect::<Vec<_>>();
    let replica_meta_digest = parse_digest(&crate::compute_storage_replica_meta_digest(
        &replica_meta_entries,
    )?)?;
    let meta_done = phase_started.elapsed();
    let projection_meta = meta_done.saturating_sub(machine_done);

    let mut context_parts = Vec::with_capacity(result.outputs.entities.len());
    for output in &result.outputs.entities {
        let key = output_key(output);
        let entity_id = result
            .replica
            .state
            .e_replicas
            .get(&key)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?
            .entity
            .entity_id
            .to_ascii_lowercase();
        context_parts.push(prepare_entity_context_rows(
            &format!("{}:{}", entity_id, output.signer_id),
            &output.entity_context,
        )?);
    }
    // An evicted-only proposal has no certified Entity output, but replay
    // must receive the exact context consumed by its rejected attempt. These
    // use the existing height-keyed WAL context rows, never a second journal.
    for (key, contexts) in &applied.frame.entity_contexts {
        let entity_id = format!("0x{}", hex::encode(key.entity_id));
        for context in contexts {
            context_parts.push(prepare_entity_context_rows(
                &format!("{}:{}", entity_id, key.signer_id),
                &context.canonical,
            )?);
        }
    }
    let entity_contexts = crate::storage::native::EntityContextPayloadRows::merge(context_parts)?;
    let context_done = phase_started.elapsed();
    let projection_context = context_done.saturating_sub(meta_done);

    let expected_previous_hash = result.replica.durable.prev_frame_hash();
    let checkpoint_changes = match (checkpoint_due, prior_checkpoint_rows) {
        (true, Some(prior)) => Some(prepare_checkpoint_graph_changes(
            &result,
            &replica_metas,
            prior,
            full_checkpoint,
            &barrier_checkpoints,
        )?),
        (false, None) => None,
        _ => {
            return Err(RuntimeFrameProjectionError::CheckpointGraphUnavailable(
                result.replica.state.height,
            ));
        }
    };
    let height = result.replica.state.height;
    let canonical_period = result.replica.limits.canonical_hash_period_frames;
    let materialized_state = checkpoint_changes.is_some();
    let canonical_due = materialized_state
        || (canonical_period > 0 && (height == 1 || height.is_multiple_of(canonical_period)));
    let canonical_state = if canonical_due {
        Some(canonical_state(&result)?)
    } else {
        None
    };
    let (runtime_machine_root, frame_graph) = if materialized_state {
        let machine = runtime_machine(&result)?;
        let graph = prepare_runtime_machine_graph(&machine)?;
        let canonical = canonical_state.as_ref().ok_or(
            RuntimeFrameProjectionError::CheckpointGraphUnavailable(height),
        )?;
        let root = RuntimeMachineGraphRoot {
            root_hash: graph.root_hash,
            leaf_count: graph.leaf_count,
        };
        let checkpoint = CheckpointGraph {
            state_root: canonical.state_hash,
            full: false,
            // This vector has a single owner after projection. Moving it
            // avoids cloning every changed Account/Entity path at each
            // materialization cadence before the same rows enter WAL.
            node_changes: checkpoint_changes.unwrap_or_default(),
            runtime_machine_leaves: graph
                .leaves
                .into_iter()
                .map(|leaf| RuntimeMachineLeafRow {
                    path_bytes: leaf.path_bytes,
                    value_bytes: leaf.value_bytes,
                })
                .collect(),
        };
        (Some(root), Some(checkpoint))
    } else {
        (None, None)
    };
    let draft = CanonicalRuntimeFrameDraft {
        height: result.replica.state.height,
        timestamp: result.replica.state.timestamp,
        prev_frame_hash: expected_previous_hash,
        replica_meta_digest,
        runtime_component_digests: component_digests,
        materialized_state,
        canonical_state,
        runtime_input,
        runtime_machine_root,
        // The canonical TS Runtime frame does not commit an implementation-
        // specific Account-engine handle. Path-keyed node changes at the
        // materialization cadence are sufficient for either engine.
        account_authority_checkpoints: Vec::new(),
        // Parity target: `storageRefsFromOverlay` (core/storage/schema/
        // overlay-docs.ts) keys touches by ref, so an Account or Entity that
        // committed twice inside one Runtime frame (an external input plus its
        // derived account-work frame) is recorded once, in first-touch order.
        touched_entities: dedup_first_touch(result.outputs.touches.entity_ids.iter().cloned()),
        touched_accounts: {
            let mut seen = std::collections::BTreeSet::new();
            result
                .outputs
                .touches
                .accounts
                .iter()
                .filter(|account| {
                    seen.insert((account.entity_id.clone(), account.counterparty_id.clone()))
                })
                .map(|account| TouchedAccount {
                    entity_id: account.entity_id.clone(),
                    counterparty_id: account.counterparty_id.clone(),
                })
                .collect()
        },
        touched_book_entities: dedup_first_touch(
            result.outputs.touches.book_entity_ids.iter().cloned(),
        ),
    };
    let pre_encode_done = phase_started.elapsed();
    let projection_checkpoint = pre_encode_done.saturating_sub(context_done);
    let mut encoded =
        build_runtime_frame_commit(draft, entity_contexts, bound_outputs.rows, frame_graph)?;
    debug_assert_eq!(
        encoded.commit.outputs.len(),
        bound_outputs.resident_rows.len(),
        "RSCORE_RESIDENT_OUTPUT_CARDINALITY_DIVERGED"
    );
    encoded.resident_output_values = Some(bound_outputs.resident_rows);
    let projection_encode = phase_started.elapsed().saturating_sub(pre_encode_done);
    if profile {
        let total = phase_started.elapsed().as_micros();
        let (checkpoint_rows, checkpoint_bytes) = encoded
            .commit
            .checkpoint
            .as_ref()
            .map(|checkpoint| {
                (
                    checkpoint.node_changes.len(),
                    checkpoint
                        .node_changes
                        .iter()
                        .filter_map(|change| change.value.as_ref())
                        .map(Vec::len)
                        .sum::<usize>(),
                )
            })
            .unwrap_or_default();
        let output_bytes = encoded.commit.outputs.iter().map(Vec::len).sum::<usize>();
        eprintln!(
            "RSCORE_PROJECTION_PHASE h={} prelude_shape={} events_digest={} effects_digest={} effect_counts={} local_outputs={} bind_outputs={} continuations={} input={input_micros} machine={} meta={} context={} checkpoint_canonical={} encode={} total={total} input_bytes={canonical_input_bytes} checkpoint_rows={checkpoint_rows} checkpoint_bytes={checkpoint_bytes} frame_bytes={} output_bytes={output_bytes} output_account_inputs={} output_acks={} output_ack_frames={} output_frame_txs={} output_frame_hankos={} output_frame_hanko_bytes={} output_dispute_hankos={} output_dispute_hanko_bytes={}",
            result.replica.state.height,
            shape_done.as_micros(),
            event_digest_done.saturating_sub(shape_done).as_micros(),
            effect_digest_done
                .saturating_sub(event_digest_done)
                .as_micros(),
            count_done.saturating_sub(effect_digest_done).as_micros(),
            local_output_done.saturating_sub(count_done).as_micros(),
            bind_done.saturating_sub(local_output_done).as_micros(),
            continuation_done.saturating_sub(bind_done).as_micros(),
            projection_machine.as_micros(),
            projection_meta.as_micros(),
            projection_context.as_micros(),
            projection_checkpoint.as_micros(),
            projection_encode.as_micros(),
            encoded.commit.frame_bytes.len(),
            output_measure.account_inputs,
            output_measure.ack_inputs,
            output_measure.ack_frame_inputs,
            output_measure.frame_txs,
            output_measure.frame_hankos,
            output_measure.frame_hanko_bytes,
            output_measure.dispute_hankos,
            output_measure.dispute_hanko_bytes,
            input_micros = projection_input.as_micros(),
        );
    }
    let commitments = super::RuntimeDurableCommitments {
        height: result.replica.state.height,
        runtime_frame_hash: encoded.frame_hash,
        post_state_hash: encoded.post_state_hash,
        entities: entity_commitments,
        entity_event_count,
        events_parity_digest,
        entity_effect_count,
        entity_effects_parity_digest,
        runtime_output_count: u64::try_from(encoded.commit.outputs.len())
            .map_err(|_| RuntimeFrameProjectionError::OutputCount(encoded.commit.outputs.len()))?,
        runtime_outputs_digest: encoded.output_digest,
    };
    for (entity_id, meta) in replica_metas {
        let live = result
            .replica
            .e_replicas
            .get_mut(&entity_id)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
        live.replica_metadata = meta.value;
    }
    Ok(DurableProjection::Frame(Box::new(ProjectedRuntimeFrame {
        encoded,
        expected_previous_hash,
        replica: result.replica,
        commitments,
        account_commits,
        local_continuations,
        post_commit_j_attempts,
        accepted_payments,
        completed_payments,
        matched_swaps,
        zero_fill_swap_cancels,
        paybook_open,
        runtime_entity_inputs,
        account_inputs,
        canonical_input_bytes,
        entity_txs_selected,
        entity_txs_pending,
        projection_input,
        projection_machine,
        projection_meta,
        projection_context,
        projection_checkpoint,
        projection_encode,
    })))
}

fn enqueue_local_continuations(
    mempool: &mut crate::RuntimeMempool,
    limits: crate::RuntimeLimits,
    entity_inputs: Vec<crate::RuntimeEntityInput>,
    frame: &crate::RuntimeFrameContext,
    exact_replay: bool,
) -> Result<(), RuntimeFrameProjectionError> {
    // The WAL already owns the exact height and order of every locally routed
    // continuation. Re-deriving one while replaying an earlier frame moves it
    // ahead of ingress that TS had already accepted, producing a different
    // RuntimeInput even though Entity/Account execution is identical.
    if exact_replay || entity_inputs.is_empty() {
        return Ok(());
    }
    let mut input = crate::RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs,
        frame: frame.clone(),
    };
    crate::enqueue_runtime_input(mempool, &mut input, limits)?;
    Ok(())
}

fn local_continuation_evidence(
    inputs: &[crate::RuntimeEntityInput],
    exact_replay: bool,
) -> Vec<Value> {
    if !exact_replay {
        return Vec::new();
    }
    inputs
        .iter()
        .map(|input| input.canonical().clone())
        .collect()
}

#[cfg(test)]
mod prepared_wal_roundtrip_tests {
    #[test]
    fn native_prepared_transaction_wal_uses_one_runtime_envelope() {
        let data = crate::j_submit::JPreparedTransactionData {
            jurisdiction_name: "Testnet".into(),
            attempt_id: "committed-attempt".into(),
            raw_transaction: "0x02abcd".into(),
        };
        let tx = crate::RuntimeTx::RecordJPreparedTransaction(data.clone());
        let encoded = super::encode_runtime_txs(std::iter::once(&tx)).unwrap();
        assert_eq!(encoded[0]["type"], "recordJPreparedTransaction");
        // Native WAL restoration passes this exact data object to decode_prepared.
        // A second {type,data} envelope made accepted signed batches unrecoverable.
        assert_eq!(
            crate::j_submit::decode_prepared(&encoded[0]["data"]).unwrap(),
            data
        );
    }
}

#[cfg(test)]
mod local_continuation_tests {
    use serde_json::json;

    use super::{enqueue_local_continuations, local_continuation_evidence};

    fn input(entity_txs: serde_json::Value) -> crate::RuntimeEntityInput {
        crate::RuntimeEntityInput::decode(json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": "local-signer",
            "entityTxs": entity_txs,
        }))
        .expect("local continuation")
    }

    #[test]
    fn exact_replay_consumes_recorded_continuations_without_rederiving_them() {
        let frame = crate::RuntimeFrameContext {
            timestamp: 77,
            finalized_j_height: 0,
            entity_contexts: std::collections::BTreeMap::new(),
        };
        let limits = crate::RuntimeLimits::hlt();
        let mut replay = crate::RuntimeMempool::empty();
        let continuation = input(json!([]));
        let evidence = local_continuation_evidence(std::slice::from_ref(&continuation), true);
        assert_eq!(evidence, vec![continuation.canonical().clone()]);
        assert!(local_continuation_evidence(std::slice::from_ref(&continuation), false).is_empty());
        enqueue_local_continuations(&mut replay, limits, vec![continuation], &frame, true)
            .expect("exact replay projection");
        assert!(replay.is_empty());

        let mut live = crate::RuntimeMempool::empty();
        enqueue_local_continuations(&mut live, limits, vec![input(json!([]))], &frame, false)
            .expect("live projection");
        assert_eq!(live.entity_input_count(), 1);
        assert_eq!(live.queued_at(), Some(77));
    }
}

fn runtime_input(
    runtime_txs: Vec<crate::RuntimeTx>,
    entity_inputs: Vec<Value>,
) -> Result<Value, RuntimeFrameProjectionError> {
    let runtime_txs = encode_runtime_txs(runtime_txs.iter())?;
    Ok(object([
        ("runtimeTxs", Value::Array(runtime_txs)),
        ("entityInputs", Value::Array(entity_inputs)),
    ]))
}

fn encode_runtime_txs<'a>(
    txs: impl Iterator<Item = &'a crate::RuntimeTx>,
) -> Result<Vec<Value>, RuntimeFrameProjectionError> {
    txs.map(|tx| match tx {
        crate::RuntimeTx::CheckpointBarrier => Ok(object([
            ("type", Value::String("checkpointBarrier".into())),
            ("data", Value::Object(Map::new())),
        ])),
        crate::RuntimeTx::RecordRuntimeAdapterCommand(value) => Ok(object([
            ("type", Value::String("recordRuntimeAdapterCommand".into())),
            (
                "data",
                object([
                    ("laneId", Value::String(value.lane_id.clone())),
                    ("sequence", Value::Number(value.sequence.into())),
                    ("commandId", Value::String(value.command_id.clone())),
                    ("inputHash", Value::String(value.input_hash.clone())),
                    (
                        "expiresAtMs",
                        value
                            .expires_at_ms
                            .map_or(Value::Null, |value| Value::Number(value.into())),
                    ),
                ]),
            ),
        ])),
        crate::RuntimeTx::ReplaceJPreparedTransaction(value) => Ok(object([
            ("type", Value::String("replaceJPreparedTransaction".into())),
            ("data", value.encode()),
        ])),
        crate::RuntimeTx::RecordJPreparedTransaction(value) => {
            crate::j_submit::encode_j_prepared_transaction(value)
                .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string()))
        }
        crate::RuntimeTx::ImportReplica(value) => Ok(value.encode()),
        crate::RuntimeTx::ImportJ(value) => Ok(object([
            ("type", Value::String("importJ".into())),
            ("data", crate::j_import::encode_import_request(value)),
        ])),
        crate::RuntimeTx::ReplaceNumberedRegistrationIntent(value) => Ok(object([
            (
                "type",
                Value::String("replaceNumberedRegistrationIntent".into()),
            ),
            ("data", value.encode()),
        ])),
        crate::RuntimeTx::RecordAuthenticatedJAuthority(value) => Ok(object([
            (
                "type",
                Value::String("recordAuthenticatedJAuthority".into()),
            ),
            ("data", value.encode()),
        ])),
        crate::RuntimeTx::CompleteImportJ(value) => Ok(object([
            ("type", Value::String("completeImportJ".into())),
            ("data", crate::j_import::encode_import_result(value)),
        ])),
        crate::RuntimeTx::ObserveJRange(value) => Ok(object([
            ("type", Value::String("observeJRange".into())),
            (
                "data",
                crate::j_watcher::encode_observe_j_range(value)
                    .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string()))?,
            ),
        ])),
        crate::RuntimeTx::AdvanceJWatcherCursor {
            depository_address,
            chain_id,
            block_number,
        } => Ok(object([
            ("type", Value::String("advanceJWatcherCursor".into())),
            (
                "data",
                object([
                    (
                        "depositoryAddress",
                        Value::String(depository_address.clone()),
                    ),
                    ("chainId", Value::Number((*chain_id).into())),
                    ("blockNumber", Value::Number((*block_number).into())),
                ]),
            ),
        ])),
        crate::RuntimeTx::RewindJHistory(value) => Ok(object([
            ("type", Value::String("rewindJHistory".into())),
            (
                "data",
                object([
                    (
                        "entityId",
                        Value::String(format!("0x{}", hex::encode(value.entity_id))),
                    ),
                    ("signerId", Value::String(value.signer_id.clone())),
                    (
                        "jurisdictionRef",
                        Value::String(value.jurisdiction_ref.clone()),
                    ),
                    (
                        "conflictingHeight",
                        Value::Number(value.conflicting_height.into()),
                    ),
                    (
                        "conflictingBlockHash",
                        Value::String(format!("0x{}", hex::encode(value.conflicting_block_hash))),
                    ),
                ]),
            ),
        ])),
        crate::RuntimeTx::RetryJSubmit(value) => crate::j_submit::encode_retry_j_submit(value)
            .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string())),
        crate::RuntimeTx::RecordJSubmitResult(value) => {
            crate::j_submit::encode_j_submit_result(value)
                .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string()))
        }
        crate::RuntimeTx::RetryEntityProviderAction(value) => {
            crate::j_submit::encode_retry_entity_provider_action(value)
                .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string()))
        }
        crate::RuntimeTx::RecordEntityProviderActionSubmitResult(value) => {
            crate::j_submit::encode_entity_provider_action_result(value)
                .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string()))
        }
        crate::RuntimeTx::RecordGovernanceJSubmitResult(value) => {
            crate::j_submit::encode_governance_result(value)
                .map_err(|error| RuntimeFrameProjectionError::RuntimeTx(error.to_string()))
        }
        crate::RuntimeTx::Unsupported { kind } => {
            Err(RuntimeFrameProjectionError::RuntimeTx(kind.clone()))
        }
    })
    .collect()
}

/// The Runtime mempool is ephemeral replica-envelope state: it is never a
/// durable Runtime-machine component, so no pending queue is projected here.
fn runtime_machine(result: &RuntimeApplyResult) -> Result<Value, RuntimeFrameProjectionError> {
    let envelope = &result.replica.durable;
    let mut machine = object([
        (
            "runtimeId",
            Value::String(envelope.runtime_id().to_string()),
        ),
        ("runtimeConfig", envelope.runtime_config().value()),
        (
            "infrastructure",
            super::envelope::project_durable_infrastructure(envelope.infrastructure())?,
        ),
        (
            "jReplicas",
            super::envelope::project_durable_j_replicas(envelope.j_replicas()),
        ),
    ]);
    if let Some(name) = envelope.active_jurisdiction() {
        machine
            .as_object_mut()
            .expect("Runtime machine object")
            .insert("activeJurisdiction".into(), Value::String(name.to_owned()));
    }
    Ok(machine)
}

/// Hash the replay-verifiable machine components without first cloning them
/// into a second serde tree. The complete machine projection is materialized
/// only at checkpoint cadence; canonical-only frames never build it.
fn component_digests(
    envelope: &super::envelope::RuntimeDurableEnvelope,
) -> Result<Vec<RuntimeComponentDigest>, RuntimeFrameProjectionError> {
    let cache = envelope.component_digest_cache();
    let j_replicas = super::envelope::project_durable_j_replicas(envelope.j_replicas());
    let runtime_id = Value::String(envelope.runtime_id().to_string());
    let infrastructure =
        super::envelope::project_durable_infrastructure(envelope.infrastructure())?;
    // Each digest commits the same canonical value every frame until its
    // component mutates; the envelope clears the matching cell on mutation,
    // so a cache hit is byte-identical to recomputation.
    [
        ("runtimeId", &runtime_id, &cache.runtime_id),
        ("infrastructure", &infrastructure, &cache.infrastructure),
        ("jReplicas", &j_replicas, &cache.j_replicas),
    ]
    .into_iter()
    // TypeScript's replay post-state view omits an empty infrastructure
    // component, even though checkpoint machines retain an explicit {}.
    .filter(|(key, value, _)| {
        *key != "infrastructure" || value.as_object().is_some_and(|row| !row.is_empty())
    })
    .map(|(key, value, cell)| {
        // End the immutable RefCell guard before a cache miss writes the
        // computed digest back. Matching directly on `cell.borrow()` extends
        // the temporary guard through the match arm and panics on borrow_mut.
        let cached = cell.borrow().clone();
        let value_hash = match cached {
            Some(digest) => digest,
            None => {
                let canonical = crate::canonical_value_from_tagged_json(value)?;
                let digest = compute_runtime_component_digest(&canonical)?;
                *cell.borrow_mut() = Some(digest.clone());
                digest
            }
        };
        Ok(RuntimeComponentDigest {
            key: key.into(),
            value_hash,
        })
    })
    .collect()
}

fn assert_certified_result(
    result: &RuntimeApplyResult,
    output: &crate::RuntimeEntityOutputs,
) -> Result<(), RuntimeFrameProjectionError> {
    let key = output_key(output);
    let state = result
        .replica
        .state
        .e_replicas
        .get(&key)
        .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
    let frame = result
        .replica
        .e_replicas
        .get(&key)
        .and_then(|live| live.entity_consensus.certified_frame_head.as_ref())
        .map(|head| &head.frame)
        .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
    if frame.height != output.entity_frame_height
        || frame.height != state.entity.height
        || frame.timestamp != output.entity_frame_timestamp
        || frame.timestamp != state.entity.timestamp
        || frame.hash != output.entity_frame_hash
        || frame.state_root != output.entity_state_root
        || frame.authority_root != output.entity_authority_root
        || state.accounts_root != output.accounts_root
    {
        return Err(RuntimeFrameProjectionError::CertifiedFrameMismatch(
            format!(
                concat!(
                    "ENTITY:{:?}:frameHeight={}:outputHeight={}:stateHeight={}",
                    ":frameTimestamp={}:outputTimestamp={}:stateTimestamp={}",
                    ":frameHash={}:outputHash={}",
                    ":frameStateRoot={}:outputStateRoot={}:frameAuthorityRoot={}:outputAuthorityRoot={}"
                ),
                key,
                frame.height,
                output.entity_frame_height,
                state.entity.height,
                frame.timestamp,
                output.entity_frame_timestamp,
                state.entity.timestamp,
                frame.hash,
                output.entity_frame_hash,
                frame.state_root,
                output.entity_state_root,
                frame.authority_root,
                output.entity_authority_root,
            ),
        ));
    }
    Ok(())
}

fn canonical_state(
    result: &RuntimeApplyResult,
) -> Result<CanonicalStateCommitment, RuntimeFrameProjectionError> {
    let mut entity_hashes = Vec::with_capacity(result.replica.state.e_replicas.len());
    let mut stored_entity_hashes = Vec::with_capacity(result.replica.state.e_replicas.len());
    for (entity_id, state) in &result.replica.state.e_replicas {
        let live = result
            .replica
            .e_replicas
            .get(entity_id)
            .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
        // Genesis owners have committed state but no fabricated Entity frame.
        // Use the same section projection as restore; later heights require
        // the exact certified head and may never enter this genesis case.
        let state_root = match (
            state.entity.height,
            live.entity_consensus.certified_frame_head.as_ref(),
        ) {
            (0, None) => {
                let owned = xln_rscore_entity_kernel::compute_entity_owned_sections(
                    &state.entity,
                    state.accounts_root,
                    live.accounts.account_count(),
                )?;
                let sections = xln_rscore_entity_kernel::project_entity_consensus_sections(
                    &live.entity_consensus.state.sections,
                    owned,
                    &live.entity_consensus.state.authority,
                    state.entity.height,
                )?;
                xln_rscore_entity_kernel::compute_entity_consensus_root(&sections)?
            }
            (1.., Some(head)) => head.frame.state_root.clone(),
            (0, Some(_)) => {
                return Err(RuntimeFrameProjectionError::CertifiedFrameMismatch(
                    "GENESIS_CERTIFICATE_FORBIDDEN".into(),
                ));
            }
            (1.., None) => return Err(RuntimeFrameProjectionError::CertifiedFrameMissing),
        };
        let entity_id = state.entity.entity_id.to_ascii_lowercase();
        entity_hashes.push(CanonicalRuntimeEntityHash {
            entity_id: entity_id.clone(),
            hash: state_root.clone(),
            cell_count: 1,
        });
        stored_entity_hashes.push(RuntimeFrameEntityHash {
            entity_id,
            hash: parse_digest(&state_root)?,
            cell_count: 1,
        });
    }
    let state_hash = compute_canonical_runtime_state_hash(
        result.replica.state.height,
        result.replica.state.timestamp,
        &entity_hashes,
    )?;
    Ok(CanonicalStateCommitment {
        state_hash: parse_digest(&state_hash)?,
        entity_hashes: stored_entity_hashes,
    })
}

fn merge_checkpoint_changes(
    left: Vec<PathNodeChange>,
    right: Vec<PathNodeChange>,
) -> Result<Vec<PathNodeChange>, RuntimeFrameProjectionError> {
    let mut merged = BTreeMap::<Vec<u8>, Option<Vec<u8>>>::new();
    for change in left.into_iter().chain(right) {
        let key = change.key.into_bytes();
        if merged.insert(key.clone(), change.value).is_some() {
            return Err(RuntimeFrameProjectionError::CheckpointKey(key));
        }
    }
    merged
        .into_iter()
        .map(|(key, value)| {
            Ok(PathNodeChange {
                key: crate::storage::native::PathNodeKey::new(key)?,
                value,
            })
        })
        .collect::<Result<_, crate::storage::native::NativeStorageError>>()
        .map_err(RuntimeFrameProjectionError::CheckpointStorage)
}

fn parse_digest(value: &str) -> Result<[u8; 32], RuntimeFrameProjectionError> {
    parse_hex(value, 32)?
        .try_into()
        .map_err(|_| RuntimeFrameProjectionError::Digest(value.into()))
}

fn parse_hex(value: &str, bytes: usize) -> Result<Vec<u8>, RuntimeFrameProjectionError> {
    let normalized = normalize_hex(value, bytes)
        .ok_or_else(|| RuntimeFrameProjectionError::Digest(value.into()))?;
    (0..bytes)
        .map(|index| {
            u8::from_str_radix(&normalized[2 + index * 2..4 + index * 2], 16)
                .map_err(|_| RuntimeFrameProjectionError::Digest(value.into()))
        })
        .collect()
}

fn normalize_hex(value: &str, bytes: usize) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x")?;
    (body.len() == bytes * 2 && body.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(normalized)
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(Map::from_iter(
        entries
            .into_iter()
            .map(|(field, value)| (field.to_string(), value)),
    ))
}

#[derive(Debug, Error)]
pub(crate) enum RuntimeFrameProjectionError {
    #[error("RRS_PROCESSOR_REPLAY_OUTBOX:{0}")]
    ReplayOutbox(String),
    #[error("RRS_PROCESSOR_IDLE_RESULT_INVALID")]
    IdleShape,
    #[error("RRS_PROCESSOR_RUNTIME_TX_UNSUPPORTED:{0}")]
    RuntimeTx(String),
    #[error("RRS_PROCESSOR_APPLIED_INPUT_MISSING")]
    AppliedInputMissing,
    #[error("RRS_PROCESSOR_CERTIFIED_FRAME_MISSING")]
    CertifiedFrameMissing,
    #[error("RRS_PROCESSOR_CERTIFIED_FRAME_MISMATCH:{0}")]
    CertifiedFrameMismatch(String),
    #[error("RRS_PROCESSOR_RUNTIME_ONLY_RESULT_INVALID")]
    RuntimeOnlyShape,
    #[error("RRS_PROCESSOR_DIGEST:{0}")]
    Digest(String),
    #[error("RRS_PROCESSOR_EVENT_COUNT:{0}")]
    EventCount(usize),
    #[error("RRS_PROCESSOR_ENTITY_EFFECT_COUNT:{0}")]
    EntityEffectCount(usize),
    #[error("RRS_PROCESSOR_SWAP_COUNT:{0}")]
    SwapCount(u64),
    #[error("RRS_PROCESSOR_OUTPUT_COUNT:{0}")]
    OutputCount(usize),
    #[error("RRS_PROCESSOR_ATOMIC_PAIR_LOCAL_OUTPUT")]
    AtomicPairLocalOutput,
    #[error("RRS_PROCESSOR_ATOMIC_PAIR_OUTPUT_OBJECT")]
    AtomicPairOutputObject,
    #[error("RRS_PROCESSOR_CHECKPOINT_GRAPH_UNAVAILABLE:{0}")]
    CheckpointGraphUnavailable(u64),
    #[error("RRS_PROCESSOR_CHECKPOINT_KEY_DUPLICATE:{0:?}")]
    CheckpointKey(Vec<u8>),
    #[error(transparent)]
    Tagged(#[from] TaggedJsonError),
    #[error(transparent)]
    Commitment(#[from] RuntimeCommitmentError),
    #[error(transparent)]
    Output(#[from] EntityOutputEncodingError),
    #[error(transparent)]
    EntityConsensus(#[from] xln_rscore_entity_kernel::EntityConsensusError),
    #[error(transparent)]
    EntityTransition(#[from] xln_rscore_entity_kernel::EntityTransitionError),
    #[error(transparent)]
    EntityKernel(#[from] xln_rscore_entity_kernel::EntityKernelError),
    #[error(transparent)]
    Route(#[from] EntityRouteError),
    #[error(transparent)]
    Context(#[from] EntityContextProjectionError),
    #[error(transparent)]
    ContextPayload(#[from] crate::storage::native::EntityContextPayloadError),
    #[error(transparent)]
    Machine(#[from] RuntimeMachineProjectionError),
    #[error(transparent)]
    RuntimeMachine(#[from] crate::RuntimeMachineError),
    #[error(transparent)]
    Envelope(#[from] super::envelope::RuntimeDurableEnvelopeError),
    #[error(transparent)]
    AccountBatch(#[from] xln_rscore_batch::BatchError),
    #[error(transparent)]
    Frame(#[from] crate::storage::native::RuntimeFrameCodecError),
    #[error(transparent)]
    Transport(#[from] crate::transport::RuntimeTransportError),
    #[error(transparent)]
    Authority(#[from] xln_rscore_entity_kernel::EntityAuthorityError),
    #[error(transparent)]
    EntityFrame(#[from] xln_rscore_entity_kernel::EntityFrameError),
    #[error(transparent)]
    ReplicaMeta(#[from] ReplicaMetaProjectionError),
    #[error(transparent)]
    AccountCheckpoint(Box<AccountCheckpointProjectionError>),
    #[error(transparent)]
    EntityCheckpoint(Box<EntityCheckpointProjectionError>),
    #[error(transparent)]
    CheckpointStorage(#[from] crate::storage::native::NativeStorageError),
}

impl From<AccountCheckpointProjectionError> for RuntimeFrameProjectionError {
    fn from(error: AccountCheckpointProjectionError) -> Self {
        Self::AccountCheckpoint(Box::new(error))
    }
}

impl From<EntityCheckpointProjectionError> for RuntimeFrameProjectionError {
    fn from(error: EntityCheckpointProjectionError) -> Self {
        Self::EntityCheckpoint(Box::new(error))
    }
}

fn dedup_first_touch(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    values.filter(|value| seen.insert(value.clone())).collect()
}

#[cfg(test)]
mod settlement_rejection_tests {
    use super::*;
    use crate::machine::tests::settlement_rejection::{input, pending_replica};

    #[test]
    fn actual_tvm_import_matches_typescript_durable_j_projection() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/native-tron-import-v1.json"
        ))
        .unwrap();
        let mut envelope =
            super::super::envelope::RuntimeDurableEnvelope::decode(&fixture["machine"], [0; 32])
                .unwrap();
        for tx in fixture["imports"].as_array().unwrap() {
            let result = crate::j_import::decode_import_result(&tx["data"]).unwrap();
            crate::j_import::apply_import_result(&mut envelope, &result).unwrap();
        }
        assert_eq!(
            super::super::envelope::project_durable_j_replicas(envelope.j_replicas()),
            fixture["expectedView"]["jReplicas"]
        );
        assert!(
            super::super::envelope::project_durable_infrastructure(envelope.infrastructure())
                .unwrap()
                .as_object()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn completed_j_import_omits_empty_post_state_infrastructure() {
        let machine = serde_json::json!({
            "runtimeId": format!("0x{}", "11".repeat(20)),
            "runtimeConfig": {"loopIntervalMs": 0, "minFrameDelayMs": 5},
            "infrastructure": {}, "jReplicas": []
        });
        let mut envelope =
            super::super::envelope::RuntimeDurableEnvelope::decode(&machine, [0; 32]).unwrap();
        let keys = |envelope: &super::super::envelope::RuntimeDurableEnvelope| {
            component_digests(envelope)
                .unwrap()
                .into_iter()
                .map(|entry| entry.key)
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&envelope), ["runtimeId", "jReplicas"]);
        envelope.infrastructure_mut()["maxEntityInputsPerFrame"] = serde_json::json!(10);
        envelope.invalidate_infrastructure_digest();
        assert_eq!(
            keys(&envelope),
            ["runtimeId", "infrastructure", "jReplicas"]
        );
    }

    fn separated_round(reject_last: bool) {
        use crate::machine::tests::settlement_rejection::separated_attempts;
        let (runtime, inputs) = separated_attempts(reject_last);
        let result = crate::apply_runtime_live(
            runtime,
            crate::RuntimeLiveInput {
                runtime_txs: Vec::new(),
                entity_inputs: inputs.clone(),
                timestamp: 200,
                finalized_j_height: 0,
            },
            &mut crate::CanonicalEntityInfraMaterializer::new(),
        )
        .expect("separated live segments");
        let routes = EntityRouteTable::new(Vec::new()).expect("routes");
        let DurableProjection::Frame(live) = project_durable_frame(
            result,
            &routes,
            None,
            false,
            true,
            false,
            super::super::replay_outbox::RetainedReplayOutbox::default(),
        )
        .expect("live WAL projection") else {
            panic!("live frame")
        };
        let contexts = live
            .encoded
            .commit
            .entity_contexts
            .rebuild_contexts()
            .expect("unique height contexts");
        assert_eq!(contexts.len(), 2);
        let mut frame = crate::RuntimeFrameContext {
            timestamp: 200,
            finalized_j_height: 0,
            entity_contexts: BTreeMap::new(),
        };
        for (id, value) in &contexts {
            let parts = id.split(':').collect::<Vec<_>>();
            let entity_id = hex::decode(parts[0].trim_start_matches("0x"))
                .expect("entity id")
                .try_into()
                .expect("32 bytes");
            let key = crate::RuntimeEntityKey::new(entity_id, parts[1]).expect("key");
            frame.entity_contexts.entry(key).or_default().push_back(
                crate::RuntimeEntityFrameContext {
                    execution: crate::entity_context_json::decode_entity_frame_context(value)
                        .expect("WAL execution context"),
                    canonical: crate::canonical_value_from_tagged_json(value)
                        .expect("WAL canonical context"),
                },
            );
        }
        let replay = crate::apply_runtime(
            separated_attempts(reject_last).0,
            crate::RuntimeInput {
                runtime_txs: Vec::new(),
                entity_inputs: inputs,
                frame,
            },
        )
        .expect("same segmented WAL replay");
        let DurableProjection::Frame(replay) = project_durable_frame(
            replay,
            &routes,
            None,
            false,
            true,
            true,
            super::super::replay_outbox::RetainedReplayOutbox::default(),
        )
        .expect("replay WAL projection") else {
            panic!("replay frame")
        };
        assert_eq!(live.encoded.frame_hash, replay.encoded.frame_hash);
        assert_eq!(live.encoded.post_state_hash, replay.encoded.post_state_hash);
        assert_eq!(live.encoded.output_digest, replay.encoded.output_digest);
        assert_eq!(
            contexts,
            replay
                .encoded
                .commit
                .entity_contexts
                .rebuild_contexts()
                .expect("replay contexts")
        );
    }

    #[test]
    fn rejected_settlement_segment_before_success_replays_one_height_context() {
        separated_round(false);
    }

    #[test]
    fn rejected_settlement_segments_share_one_wal_height_context() {
        separated_round(true);
    }

    #[test]
    fn rejected_settlement_wal_preserves_context_without_entity_certificate() {
        let bad = input(serde_json::json!([
            {"type":"settle_execute","data":{"counterpartyEntityId":format!("0x{}", "ff".repeat(32))}}
        ]));
        let result = crate::apply_runtime_live(
            pending_replica(),
            crate::RuntimeLiveInput {
                runtime_txs: Vec::new(),
                entity_inputs: vec![bad.clone(), bad],
                timestamp: 200,
                finalized_j_height: 0,
            },
            &mut crate::CanonicalEntityInfraMaterializer::new(),
        )
        .expect("reject both outer commands");
        assert!(result.outputs.entities.is_empty());
        let expected = result
            .applied_frame
            .as_ref()
            .expect("Runtime frame")
            .frame
            .entity_contexts
            .values()
            .next()
            .expect("context")
            .front()
            .expect("context row")
            .canonical
            .clone();
        let DurableProjection::Frame(projected) = project_durable_frame(
            result,
            &EntityRouteTable::new(Vec::new()).expect("routes"),
            None,
            false,
            true,
            false,
            super::super::replay_outbox::RetainedReplayOutbox::default(),
        )
        .expect("WAL projection") else {
            panic!("Runtime WAL must remain")
        };
        let contexts = projected
            .encoded
            .commit
            .entity_contexts
            .rebuild_contexts()
            .expect("canonical context rows");
        assert_eq!(contexts.len(), 1);
        assert_eq!(
            crate::canonical_value_from_tagged_json(contexts.values().next().expect("context"))
                .expect("canonical"),
            expected
        );
        assert_eq!(projected.runtime_entity_inputs, 2);
        assert!(projected.account_commits.is_empty());
    }
}
