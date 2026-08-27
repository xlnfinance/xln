//! One exact projection from the owned Runtime result to durable WAL bytes.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use thiserror::Error;

use crate::storage::native::{
    CanonicalRuntimeFrameDraft, CanonicalStateCommitment, CheckpointGraph, EncodedRuntimeFrame,
    PathNodeChange, RuntimeFrameEntityHash, RuntimeMachineGraphRoot, RuntimeMachineLeafRow,
    TouchedAccount, build_runtime_frame_commit,
};
use crate::{
    CanonicalRuntimeEntityHash, RuntimeApplyResult, RuntimeCommitmentError, RuntimeComponentDigest,
    TaggedJsonError, compute_canonical_runtime_state_hash, compute_runtime_component_digest,
};

use super::checkpoint_projection::{AccountCheckpointProjectionError, prepare_account_checkpoint};
use super::context_projection::{EntityContextProjectionError, prepare_entity_context_rows};
use super::entity_checkpoint_projection::{
    EntityCheckpointProjectionError, prepare_entity_checkpoint,
};
use super::machine_snapshot::{
    PreparedRuntimeMachineGraph, RuntimeMachineProjectionError, prepare_runtime_machine_graph,
};
use super::replica_meta::{ReplicaMetaProjectionError, prepare_replica_meta};
use super::{EntityOutputEncodingError, EntityRouteError, EntityRouteTable};

static PROFILE_PROJECTION: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub(crate) struct ProjectedRuntimeFrame {
    pub encoded: EncodedRuntimeFrame,
    pub expected_previous_hash: [u8; 32],
    pub replica: crate::RuntimeReplica,
    pub commitments: super::RuntimeDurableCommitments,
    /// Ordered replay evidence captured by the one authoritative Runtime
    /// transition. This is deliberately diagnostic-only: it is returned only
    /// after WAL fsync and never becomes a second consensus commitment.
    pub account_commits: Vec<crate::AccountCommitEvidence>,
}

pub(crate) enum DurableProjection {
    Idle(Box<crate::RuntimeReplica>),
    Frame(Box<ProjectedRuntimeFrame>),
}

/// Project one already-certified reducer result. No caller-supplied hash,
/// touched row, output body or replica-meta digest crosses this boundary.
pub(crate) fn project_durable_frame(
    mut result: RuntimeApplyResult,
    routes: &EntityRouteTable,
    prior_checkpoint_rows: Option<&BTreeMap<Vec<u8>, Vec<u8>>>,
) -> Result<DurableProjection, RuntimeFrameProjectionError> {
    let Some(applied) = result.applied_frame.take() else {
        if result.applied_input.is_some()
            || result.certified_entity_frame().is_some()
            || !result.outputs.local_entity_outputs.is_empty()
        {
            return Err(RuntimeFrameProjectionError::IdleShape);
        }
        return Ok(DurableProjection::Idle(Box::new(result.replica)));
    };
    let entity_frame_committed = applied.entity_frame_committed;
    if result.outputs.checkpoint.is_some() && prior_checkpoint_rows.is_none() {
        // A cadence checkpoint is one indivisible graph. Persisting only its
        // RuntimeFrame would make the WAL tail unrecoverable, so fail before
        // writing anything until the exact 0x17-0x38 projector is available.
        return Err(RuntimeFrameProjectionError::CheckpointGraphUnavailable(
            result.replica.state.height,
        ));
    }
    let frame = result
        .certified_entity_frame()
        .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?;
    if entity_frame_committed {
        assert_certified_result(&result, frame)?;
    } else if result.outputs.entity_state_root.is_some()
        || result.outputs.entity_authority_root.is_some()
        || !result.outputs.entity_events.is_empty()
        || !result.outputs.local_entity_outputs.is_empty()
        || !result.account_commits.is_empty()
    {
        return Err(RuntimeFrameProjectionError::RuntimeOnlyShape);
    }
    let certified_entity_frame_hash = parse_digest(&frame.hash)?;
    let entity_state_root = parse_digest(&frame.state_root)?;
    let entity_authority_root = parse_digest(&frame.authority_root)?;
    let frame_events = if entity_frame_committed {
        frame.events.as_slice()
    } else {
        &[]
    };
    let entity_event_count = u64::try_from(frame_events.len())
        .map_err(|_| RuntimeFrameProjectionError::EventCount(frame_events.len()))?;
    let events_parity_digest =
        xln_rscore_entity_kernel::compute_entity_events_parity_digest(frame_events)?;
    let entity_effect_count = u64::try_from(result.outputs.entity_events.len()).map_err(|_| {
        RuntimeFrameProjectionError::EntityEffectCount(result.outputs.entity_events.len())
    })?;
    let entity_effects_parity_digest =
        xln_rscore_entity_kernel::compute_entity_effects_parity_digest(
            &result.outputs.entity_events,
        )?;
    let account_commits = std::mem::take(&mut result.account_commits);

    let local_outputs = super::encode_local_entity_outputs(std::mem::take(
        &mut result.outputs.local_entity_outputs,
    ))?;
    let bound_outputs = routes.bind_and_encode(
        local_outputs,
        result.replica.state.height,
        result.replica.state.timestamp,
        &result.replica.state.entity.entity_id,
        &result.replica.signer_id,
    )?;
    enqueue_local_continuations(
        &mut result,
        bound_outputs.local_continuations,
        &applied.frame,
    )?;

    let profile = *PROFILE_PROJECTION
        .get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_PROJECTION").as_deref() == Ok("1"));
    let phase_started = std::time::Instant::now();
    let runtime_input = runtime_input(applied.runtime_txs, applied.entity_inputs)?;
    let input_micros = phase_started.elapsed().as_micros();
    let machine = runtime_machine(&result);
    let replay_view = replay_verifiable_view(&result);
    let component_digests = component_digests(&replay_view)?;
    let machine_micros = phase_started.elapsed().as_micros();
    let replica_meta = prepare_replica_meta(&result, result.outputs.checkpoint.is_some())?;
    let replica_meta_digest = replica_meta.digest;
    let signer_id = replica_meta.signer_id;
    let meta_micros = phase_started.elapsed().as_micros();

    let replica_id = format!(
        "{}:{}",
        result.replica.state.entity.entity_id.to_ascii_lowercase(),
        signer_id
    );
    let entity_contexts = if entity_frame_committed {
        prepare_entity_context_rows(&replica_id, &applied.frame.canonical_entity_context)?
    } else {
        crate::storage::native::EntityContextPayloadRows::empty()
    };
    let context_micros = phase_started.elapsed().as_micros();

    let expected_previous_hash = result.replica.durable.prev_frame_hash();
    let checkpoint_changes = match (result.outputs.checkpoint.as_ref(), prior_checkpoint_rows) {
        (Some(accounts), Some(prior)) => {
            let entity = prepare_entity_checkpoint(&result.replica, &replica_meta.entry, prior)?;
            let account = prepare_account_checkpoint(
                accounts,
                result.replica.entity_id,
                entity.protocol_fingerprint,
                prior,
            )?;
            let node_changes = merge_checkpoint_changes(account.changes, entity.changes)?;
            Some(node_changes)
        }
        (None, None) => None,
        _ => {
            return Err(RuntimeFrameProjectionError::CheckpointGraphUnavailable(
                result.replica.state.height,
            ));
        }
    };
    let height = result.replica.state.height;
    let canonical_period = result.replica.limits.canonical_hash_period_frames;
    let canonical_due = checkpoint_changes.is_some()
        || (canonical_period > 0 && (height == 1 || height.is_multiple_of(canonical_period)));
    let canonical_projection = canonical_due
        .then(|| canonical_state(&result, &machine))
        .transpose()?;
    let canonical_state = canonical_projection
        .as_ref()
        .map(|(canonical, _)| canonical.clone());
    let runtime_machine_root =
        canonical_projection
            .as_ref()
            .map(|(_, graph)| RuntimeMachineGraphRoot {
                root_hash: graph.root_hash,
                leaf_count: graph.leaf_count,
            });
    let frame_graph = canonical_projection.map(|(canonical, graph)| CheckpointGraph {
        state_root: canonical.state_hash,
        full: false,
        node_changes: checkpoint_changes.clone().unwrap_or_default(),
        runtime_machine_leaves: graph
            .leaves
            .into_iter()
            .map(|leaf| RuntimeMachineLeafRow {
                path_bytes: leaf.path_bytes,
                value_bytes: leaf.value_bytes,
            })
            .collect(),
    });
    let draft = CanonicalRuntimeFrameDraft {
        height: result.replica.state.height,
        timestamp: result.replica.state.timestamp,
        prev_frame_hash: expected_previous_hash,
        replica_meta_digest,
        runtime_component_digests: component_digests,
        materialized_state: checkpoint_changes.is_some(),
        canonical_state,
        runtime_input,
        runtime_machine_root,
        // The canonical TS Runtime frame does not commit an implementation-
        // specific Account-engine handle. Path-keyed node changes at the
        // materialization cadence are sufficient for either engine.
        account_authority_checkpoints: Vec::new(),
        touched_entities: result.outputs.touches.entity_ids.clone(),
        touched_accounts: result
            .outputs
            .touches
            .account_ids
            .iter()
            .map(|account_id| TouchedAccount {
                entity_id: result.replica.state.entity.entity_id.to_ascii_lowercase(),
                counterparty_id: account_id.clone(),
            })
            .collect(),
        touched_book_entities: result.outputs.touches.book_entity_ids.clone(),
    };
    let pre_encode_micros = phase_started.elapsed().as_micros();
    let encoded =
        build_runtime_frame_commit(draft, entity_contexts, bound_outputs.rows, frame_graph)?;
    if profile {
        let total = phase_started.elapsed().as_micros();
        eprintln!(
            "RSCORE_PROJECTION_PHASE h={} input={input_micros} machine={} meta={} context={} checkpoint_canonical={} encode={} total={total}",
            result.replica.state.height,
            machine_micros - input_micros,
            meta_micros - machine_micros,
            context_micros - meta_micros,
            pre_encode_micros - context_micros,
            total - pre_encode_micros,
        );
    }
    let commitments = super::RuntimeDurableCommitments {
        height: result.replica.state.height,
        runtime_frame_hash: encoded.frame_hash,
        post_state_hash: encoded.post_state_hash,
        certified_entity_frame_hash,
        entity_state_root,
        entity_authority_root,
        accounts_root: result.replica.state.accounts_root,
        entity_event_count,
        events_parity_digest,
        entity_effect_count,
        entity_effects_parity_digest,
        runtime_output_count: u64::try_from(encoded.commit.outputs.len())
            .map_err(|_| RuntimeFrameProjectionError::OutputCount(encoded.commit.outputs.len()))?,
        runtime_outputs_digest: encoded.output_digest,
    };
    result.replica.replica_metadata = replica_meta.value;
    Ok(DurableProjection::Frame(Box::new(ProjectedRuntimeFrame {
        encoded,
        expected_previous_hash,
        replica: result.replica,
        commitments,
        account_commits,
    })))
}

fn enqueue_local_continuations(
    result: &mut RuntimeApplyResult,
    entity_inputs: Vec<crate::RuntimeEntityInput>,
    frame: &crate::RuntimeFrameContext,
) -> Result<(), RuntimeFrameProjectionError> {
    if entity_inputs.is_empty() {
        return Ok(());
    }
    let mut input = crate::RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs,
        frame: frame.clone(),
    };
    let limits = result.replica.limits;
    crate::enqueue_runtime_input(&mut result.replica.mempool, &mut input, limits)?;
    Ok(())
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
        crate::RuntimeTx::Unsupported { kind } => {
            Err(RuntimeFrameProjectionError::RuntimeTx(kind.clone()))
        }
    })
    .collect()
}

/// The Runtime mempool is ephemeral replica-envelope state: it is never a
/// durable Runtime-machine component, so no pending queue is projected here.
fn runtime_machine(result: &RuntimeApplyResult) -> Value {
    let envelope = &result.replica.durable;
    object([
        (
            "runtimeId",
            Value::String(envelope.runtime_id().to_string()),
        ),
        (
            "activeJurisdiction",
            Value::String(envelope.active_jurisdiction().to_string()),
        ),
        ("runtimeConfig", envelope.runtime_config().value()),
        ("infrastructure", envelope.infrastructure().clone()),
        ("jReplicas", envelope.j_replicas().clone()),
    ])
}

/// The replay-verifiable machine components: the full machine view minus
/// `activeJurisdiction` and `runtimeConfig`. Built directly from the envelope
/// instead of cloning the whole machine object and removing two fields.
fn replay_verifiable_view(result: &RuntimeApplyResult) -> Value {
    let envelope = &result.replica.durable;
    object([
        (
            "runtimeId",
            Value::String(envelope.runtime_id().to_string()),
        ),
        ("infrastructure", envelope.infrastructure().clone()),
        ("jReplicas", envelope.j_replicas().clone()),
    ])
}

fn component_digests(
    value: &Value,
) -> Result<Vec<RuntimeComponentDigest>, RuntimeFrameProjectionError> {
    let object = value
        .as_object()
        .ok_or(RuntimeFrameProjectionError::MachineObject)?;
    object
        .iter()
        .map(|(key, value)| {
            let canonical = crate::canonical_value_from_tagged_json(value)?;
            Ok(RuntimeComponentDigest {
                key: key.clone(),
                value_hash: compute_runtime_component_digest(&canonical)?,
            })
        })
        .collect()
}

fn assert_certified_result(
    result: &RuntimeApplyResult,
    frame: &xln_rscore_entity_kernel::EntityFrame,
) -> Result<(), RuntimeFrameProjectionError> {
    if frame.height != result.replica.state.entity.height
        || frame.timestamp != result.replica.state.entity.timestamp
        || frame.state_root
            != result
                .outputs
                .entity_state_root
                .as_deref()
                .unwrap_or_default()
        || frame.authority_root
            != result
                .outputs
                .entity_authority_root
                .as_deref()
                .unwrap_or_default()
    {
        return Err(RuntimeFrameProjectionError::CertifiedFrameMismatch);
    }
    Ok(())
}

fn canonical_state(
    result: &RuntimeApplyResult,
    machine: &Value,
) -> Result<(CanonicalStateCommitment, PreparedRuntimeMachineGraph), RuntimeFrameProjectionError> {
    let entity_id = result.replica.state.entity.entity_id.to_ascii_lowercase();
    let entity_root = result
        .certified_entity_frame()
        .ok_or(RuntimeFrameProjectionError::CertifiedFrameMissing)?
        .state_root
        .as_str();
    let entity_root_bytes = parse_digest(entity_root)?;
    let entity_hashes = [CanonicalRuntimeEntityHash {
        entity_id: entity_id.clone(),
        hash: entity_root.to_string(),
        cell_count: 1,
    }];
    let state_hash = compute_canonical_runtime_state_hash(
        result.replica.state.height,
        result.replica.state.timestamp,
        &entity_hashes,
        Some(machine),
    )?;
    let graph = prepare_runtime_machine_graph(machine)?;
    Ok((
        CanonicalStateCommitment {
            state_hash: parse_digest(&state_hash)?,
            entity_hashes: vec![RuntimeFrameEntityHash {
                entity_id,
                hash: entity_root_bytes,
                cell_count: 1,
            }],
        },
        graph,
    ))
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
    #[error("RRS_PROCESSOR_IDLE_RESULT_INVALID")]
    IdleShape,
    #[error("RRS_PROCESSOR_RUNTIME_TX_UNSUPPORTED:{0}")]
    RuntimeTx(String),
    #[error("RRS_PROCESSOR_CERTIFIED_FRAME_MISSING")]
    CertifiedFrameMissing,
    #[error("RRS_PROCESSOR_CERTIFIED_FRAME_MISMATCH")]
    CertifiedFrameMismatch,
    #[error("RRS_PROCESSOR_RUNTIME_ONLY_RESULT_INVALID")]
    RuntimeOnlyShape,
    #[error("RRS_PROCESSOR_MACHINE_OBJECT")]
    MachineObject,
    #[error("RRS_PROCESSOR_DIGEST:{0}")]
    Digest(String),
    #[error("RRS_PROCESSOR_EVENT_COUNT:{0}")]
    EventCount(usize),
    #[error("RRS_PROCESSOR_ENTITY_EFFECT_COUNT:{0}")]
    EntityEffectCount(usize),
    #[error("RRS_PROCESSOR_OUTPUT_COUNT:{0}")]
    OutputCount(usize),
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
    EntityKernel(#[from] xln_rscore_entity_kernel::EntityKernelError),
    #[error(transparent)]
    Route(#[from] EntityRouteError),
    #[error(transparent)]
    Context(#[from] EntityContextProjectionError),
    #[error(transparent)]
    Machine(#[from] RuntimeMachineProjectionError),
    #[error(transparent)]
    RuntimeMachine(#[from] crate::RuntimeMachineError),
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
