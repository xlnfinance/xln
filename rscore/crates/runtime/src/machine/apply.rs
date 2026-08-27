use sha3::{Digest as _, Keccak256};
use xln_rscore_batch::{AccountId, AccountInputVerdict, EntityInboundRequest, ReceiverClock};
use xln_rscore_entity_kernel::{
    EntityCommandBoard, EntityCommandDisposition, EntityTransitionCertificationRequest,
    MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, PendingNonMutatingWake, ResidentEntityRequest,
    ScheduledWake, UNREGISTERED_ENTITY_COMMAND_STACK_KEY, advance_entity_command_nonce,
    apply_resident_entity_round_core, assert_signed_entity_command,
    build_collective_entity_command, certify_entity_transition, collect_due_scheduled_wake_jobs,
    current_entity_command_board_hash, normalize_entity_command_nonce_board,
};

use crate::{EntityInfraMaterializeRequest, EntityInfraMaterializer};

use super::inbound_genesis::attach_inbound_genesis_policies;
use super::types::EntityExecutionStep;
use super::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RuntimeApplyResult, RuntimeFrameContext, RuntimeFrameTouches, RuntimeInput, RuntimeLiveInput,
    RuntimeMachineError, RuntimeOutputs, RuntimeReplica, RuntimeWake, enqueue_runtime_input,
    scheduled_input::scheduled_wake_entity_input, select_runtime_frame,
};

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

/// `true` unless the native base-claim path can honestly attest exactly
/// `base_height` this round (see `local_j_prefix_attestable_height`). `true`
/// routes to `JPrefixError::PendingLocalEventUnsupported`, refusing to
/// certify rather than guessing.
fn j_prefix_pending_local_event(
    replica_metadata: &serde_json::Value,
    base_height: u64,
    has_j_history_finality: bool,
) -> Result<bool, String> {
    Ok(
        local_j_prefix_attestable_height(replica_metadata, base_height, has_j_history_finality)?
            != Some(base_height),
    )
}

fn command_board(replica: &RuntimeReplica) -> Result<EntityCommandBoard, RuntimeMachineError> {
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
        let record = replica
            .certified_board_registry
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
    let signer_id = authority.config.validators[0].clone();
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
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(output)
}

fn parse_hex20(value: &str) -> Option<[u8; 20]> {
    let payload = value.strip_prefix("0x").filter(|value| value.len() == 40)?;
    let mut output = [0_u8; 20];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16).ok()?;
    }
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
            account_id,
            source: AccountCommitSource::PeerCommit,
            frame_height: *height,
            state_hash: *state_hash,
            account_state_root: committed_frame.frame.account_state_root,
        }),
        AccountInputVerdict::FrameAckApplied { ack, frame } => {
            // TypeScript commits a valid ACK before applying the bundled peer
            // frame. A rejected second half must never erase the first row.
            collect_account_commit_evidence(account_id, ack, evidence);
            collect_account_commit_evidence(account_id, frame, evidence);
        }
        _ => {}
    }
}

fn account_commit_evidence(
    applied: &[xln_rscore_batch::AccountInputResult],
) -> Vec<AccountCommitEvidence> {
    let mut evidence = Vec::new();
    for row in applied {
        collect_account_commit_evidence(row.account_id, &row.verdict, &mut evidence);
    }
    evidence
}

fn validate_frame_context(
    replica: &RuntimeReplica,
    input: &RuntimeInput,
) -> Result<(), RuntimeMachineError> {
    validate_selected_context(replica, &input.frame)
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

fn internal_wake(
    replica: &RuntimeReplica,
    frame: &RuntimeFrameContext,
) -> Result<Option<RuntimeWake>, RuntimeMachineError> {
    let account_mempool = replica.accounts.has_proposable_accounts()?;
    let jobs = match &replica.state.entity.crontab {
        Some(crontab) => collect_due_scheduled_wake_jobs(
            crontab,
            frame.timestamp,
            frame.hub_rebalance_has_pending_work,
        )?,
        None => Vec::new(),
    };
    let scheduled = jobs
        .first()
        .map(|first| first.due_at)
        .map(|due_at| ScheduledWake {
            version: 1,
            proposer_signer_id: replica.signer_id.clone(),
            due_at,
            jobs: jobs
                .into_iter()
                .take(MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS)
                .collect(),
        });
    if !account_mempool && scheduled.is_none() {
        return Ok(None);
    }
    Ok(Some(RuntimeWake {
        account_mempool,
        scheduled,
    }))
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
    apply_runtime_inner(replica, input, None)
}

/// Apply one live input after selecting its exact FIFO prefix and then
/// materializing the Entity context for that prefix. The caller never sees a
/// candidate or a commit/abort handle.
pub fn apply_runtime_live(
    replica: RuntimeReplica,
    input: RuntimeLiveInput,
    materializer: &mut dyn EntityInfraMaterializer,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    apply_runtime_inner(replica, input.into_selection_input(), Some(materializer))
}

fn apply_runtime_inner(
    mut replica: RuntimeReplica,
    mut input: RuntimeInput,
    materializer: Option<&mut dyn EntityInfraMaterializer>,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    validate_frame_context(&replica, &input)?;
    for entity_input in &input.entity_inputs {
        if entity_input.entity_id() != &replica.entity_id {
            return Err(RuntimeMachineError::EntityOwnerMismatch);
        }
        if entity_input.signer_id() != replica.signer_id {
            return Err(RuntimeMachineError::EntitySignerMismatch);
        }
    }
    enqueue_runtime_input(&mut replica.mempool, &mut input, replica.limits)?;
    let selected = select_runtime_frame(
        &mut replica.mempool,
        replica.limits,
        replica.state.entity.height,
        input.frame.clone(),
    )?;
    let selected_context = match selected.as_ref() {
        Some(selected) => selected.frame.clone(),
        None => input.frame.clone(),
    };
    validate_selected_context(&replica, &selected_context)?;
    let wake = internal_wake(&replica, &selected_context)?;
    let Some(mut frame) = selected.or_else(|| {
        wake.as_ref().map(|_| super::SelectedRuntimeFrame {
            runtime_txs: Vec::new(),
            entity_inputs: Vec::new(),
            frame: selected_context.clone(),
            receipt: AppliedRuntimeInput {
                entity_inputs: 0,
                account_inputs: 0,
                canonical_wire_bytes: 0,
                wake: None,
            },
        })
    }) else {
        return Ok(RuntimeApplyResult {
            replica,
            applied_input: None,
            applied_frame: None,
            outputs: RuntimeOutputs {
                entity_events: Vec::new(),
                local_entity_outputs: Vec::new(),
                entity_state_root: None,
                entity_authority_root: None,
                checkpoint: None,
                touches: RuntimeFrameTouches::default(),
            },
            account_commits: Vec::new(),
        });
    };
    frame.receipt.wake = wake;
    apply_runtime_txs(&mut replica.durable, &frame.runtime_txs)?;

    let resident_root = replica.accounts.accounts_root();
    if replica.state.accounts_root != resident_root {
        return Err(RuntimeMachineError::AccountsRootMismatch {
            committed: replica.state.accounts_root,
            resident: resident_root,
        });
    }
    let next_height = replica
        .state
        .height
        .checked_add(1)
        .ok_or(RuntimeMachineError::HeightOverflow)?;
    if frame.entity_inputs.is_empty() && frame.receipt.wake.is_none() {
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
                entity_frame_committed: false,
            }),
            outputs: RuntimeOutputs {
                entity_events: Vec::new(),
                local_entity_outputs: Vec::new(),
                entity_state_root: None,
                entity_authority_root: None,
                checkpoint: None,
                touches: RuntimeFrameTouches::default(),
            },
            account_commits: Vec::new(),
        });
    }
    let next_entity_height = replica
        .state
        .entity
        .height
        .checked_add(1)
        .ok_or(RuntimeMachineError::EntityHeightOverflow)?;
    let mut rows = Vec::with_capacity(frame.receipt.account_inputs);
    let mut canonical_entity_inputs = Vec::with_capacity(frame.receipt.entity_inputs);
    let mut canonical_entity_txs = Vec::new();
    let mut command_nonces = replica.state.entity.entity_command_nonces.clone();
    let mut execution_steps = Vec::new();
    if let Some(scheduled) = frame
        .receipt
        .wake
        .as_ref()
        .and_then(|wake| wake.scheduled.as_ref())
    {
        let (tx, canonical) = scheduled_wake_entity_input(replica.entity_id, scheduled)?;
        let wire_bytes = crate::transport::msgpack::encode_transport(&canonical)
            .map_err(|error| RuntimeMachineError::SyntheticEntityInputEncoding(error.to_string()))?
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
        canonical_entity_txs.push(tx);
        canonical_entity_inputs.push(canonical);
    }
    for entity_input in frame.entity_inputs {
        let (canonical, projected_txs, account_rows, steps) = entity_input.into_parts();
        canonical_entity_inputs.push(canonical);
        canonical_entity_txs.extend(projected_txs);
        rows.extend(account_rows);
        execution_steps.extend(steps);
    }
    let has_commands = execution_steps.iter().any(|step| {
        matches!(
            step,
            EntityExecutionStep::LocalBatch { .. } | EntityExecutionStep::Command { .. }
        )
    });
    // Match the TypeScript transition: an existing nonce fence is inert until
    // an Entity command is actually evaluated. Resolving board/stack context
    // merely because the checkpoint contains nonce state makes unrelated
    // Account traffic depend on observer registry availability.
    let command_board = has_commands.then(|| command_board(&replica)).transpose()?;
    if let Some(board) = command_board.as_ref() {
        normalize_entity_command_nonce_board(&mut command_nonces, board)?;
    }
    let mut local_financial_txs = Vec::new();
    for step in execution_steps {
        match step {
            EntityExecutionStep::LocalBatch { projected, native } => {
                let command_board = command_board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (command, command_projection) = build_collective_entity_command(
                    &replica.entity_signer,
                    command_board,
                    command_nonces.as_ref(),
                    &render_word(&replica.entity_id),
                    &projected,
                )?;
                if command.native_txs != native {
                    return Err(RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_NATIVE_PROJECTION_MISMATCH".into(),
                    ));
                }
                canonical_entity_txs.push(command_projection);
                local_financial_txs.extend(native);
                advance_entity_command_nonce(&mut command_nonces, command_board, &command)?;
            }
            EntityExecutionStep::Command { projected, command } => {
                let command_board = command_board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (_, disposition) = assert_signed_entity_command(
                    &replica.state.entity.entity_id,
                    &replica.entity_consensus.state.authority,
                    &command_board.signer,
                    command_board.board_epoch,
                    &command_board.stack_key,
                    command_nonces.as_ref(),
                    &command,
                )?;
                if disposition == EntityCommandDisposition::Next {
                    local_financial_txs.extend(command.native_txs.clone());
                }
                canonical_entity_txs.push(projected);
                advance_entity_command_nonce(&mut command_nonces, command_board, &command)?;
            }
        }
    }
    // operation_index is a wave-local receipt key, not peer authority. Rebase
    // after FIFO selection so a deferred Entity envelope starts the next
    // Runtime frame at zero without asking the decoder to predict batching.
    for (expected, row) in rows.iter_mut().enumerate() {
        row.operation_index =
            u64::try_from(expected).map_err(|_| RuntimeMachineError::InputCountOverflow)?;
        row.resolve_certified_boards(&replica.certified_board_registry)?;
    }
    attach_inbound_genesis_policies(
        &mut rows,
        &replica.state.entity.known_accounts,
        replica
            .entity_consensus
            .state
            .authority
            .config
            .jurisdiction
            .as_ref(),
        replica.durable.j_replicas(),
    )?;

    if let Some(materializer) = materializer {
        let materialized = materializer
            .materialize(EntityInfraMaterializeRequest {
                replica: &mut replica,
                account_inputs: &rows,
                local_financial_txs: &local_financial_txs,
                timestamp: frame.frame.timestamp,
                finalized_j_height: frame.frame.finalized_j_height,
            })
            .map_err(|error| {
                RuntimeMachineError::EntityContextMaterialization(error.to_string())
            })?;
        frame.frame.entity_context = materialized.execution;
        frame.frame.canonical_entity_context = materialized.canonical;
    }

    let checkpoint_due = super::materialization_due(
        next_height,
        replica.last_materialized_height,
        replica.limits.checkpoint_period_frames,
    );
    let request = ResidentEntityRequest {
        inbound: EntityInboundRequest {
            owner_entity_id: replica.entity_id,
            expected_accounts_root: resident_root,
            clock: ReceiverClock {
                entity_timestamp: frame.frame.timestamp,
                finalized_j_height: frame.frame.finalized_j_height,
            },
            rows,
            post_accounts: false,
        },
        entity_height: next_entity_height,
        outbound_timestamp: frame.frame.timestamp,
        outbound_j_height: frame.frame.finalized_j_height,
        checkpoint_due,
        post_accounts: false,
        scheduled_wake: frame
            .receipt
            .wake
            .as_ref()
            .and_then(|wake| wake.scheduled.clone()),
        expected_proposer_signer_id: replica.signer_id.clone(),
        hub_rebalance_has_pending_work: frame.frame.hub_rebalance_has_pending_work,
        finalized_j_events: None,
        local_financial_txs,
    };
    let prior_orderbook_digest = replica
        .entity_consensus
        .state
        .sections
        .iter()
        .find(|section| section.field == "orderbookExt")
        .map(|section| section.digest.clone());
    let mut core = apply_resident_entity_round_core(
        &mut replica.accounts,
        replica.state.entity,
        request,
        &frame.frame.entity_context,
    )?;
    core.state.entity_command_nonces = command_nonces;
    let account_commits = account_commit_evidence(&core.inbound.applied);
    let accounts_root = core.outbound.accounts_root;
    let account_count = replica.accounts.account_count();
    let post_authority = replica.entity_consensus.state.authority.clone();
    let RuntimeReplica {
        durable,
        entity_id,
        signer_id,
        accounts,
        mempool,
        limits,
        entity_consensus,
        entity_signer,
        protocol_fingerprint,
        replica_metadata,
        certified_board_registry,
        last_materialized_height,
        ..
    } = replica;
    // The base-claim J-prefix path (`certify_entity_transition`) builds and
    // signs the certificate natively from `post_state.j_history_finality`; it
    // never reads a certificate from storage. This flag only tells it whether
    // the validator-local watcher (`jHistory`, still an opaque envelope field
    // restored from checkpoint/WAL) can honestly attest anything beyond
    // exactly the last finalized height this round, which the base-claim path
    // does not cover.
    let j_prefix_pending_local_event = j_prefix_pending_local_event(
        &replica_metadata,
        core.state.last_finalized_j_height,
        core.state.j_history_finality.is_some(),
    )
    .map_err(|error| {
        RuntimeMachineError::ReplicaMetadata(format!("J_PREFIX_HISTORY_DECODE:{error}"))
    })?;
    let touched_account_ids = core.account_touch_order;
    let account_outputs = core
        .outbound
        .proposals
        .into_iter()
        .filter_map(|proposal| proposal.outbound_input)
        .collect();
    let non_mutating_wakes = core
        .non_mutating_wake_targets
        .into_iter()
        .enumerate()
        .map(|(output_index, target_entity_id)| {
            Ok(PendingNonMutatingWake {
                output_index: u64::try_from(output_index)
                    .map_err(|_| RuntimeMachineError::InputCountOverflow)?,
                target_entity_id,
            })
        })
        .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
    let certified = certify_entity_transition(
        &entity_signer,
        entity_consensus,
        EntityTransitionCertificationRequest {
            post_state: &core.state,
            accounts_root,
            account_count,
            txs: &canonical_entity_txs,
            events: &core.entity_frame_events,
            entity_context: &frame.frame.canonical_entity_context,
            j_prefix_pending_local_event,
            post_authority,
            secondary_hashes: core.secondary_hashes.clone(),
            presigned_manifest: std::mem::take(&mut core.presigned_manifest),
            account_outputs,
            non_mutating_wakes,
        },
    )?;
    let checkpoint = core.outbound.checkpoint;
    let last_materialized_height = if checkpoint.is_some() {
        next_height
    } else {
        last_materialized_height
    };
    let entity_events = core.outputs;
    let entity_state_root = certified.state_root.clone();
    let entity_authority_root = certified.authority_root.clone();
    let local_entity_outputs = certified.local_outputs;
    let post_orderbook_digest = certified
        .consensus
        .state
        .sections
        .iter()
        .find(|section| section.field == "orderbookExt")
        .map(|section| section.digest.clone());
    let touches = RuntimeFrameTouches {
        entity_ids: vec![state_entity_id(&core.state)],
        account_ids: touched_account_ids
            .into_iter()
            .map(|account_id| render_account_id(&account_id))
            .collect(),
        book_entity_ids: (prior_orderbook_digest != post_orderbook_digest)
            .then(|| state_entity_id(&core.state))
            .into_iter()
            .collect(),
    };
    let state = super::RuntimeState {
        height: next_height,
        timestamp: frame.frame.timestamp,
        finalized_j_height: frame.frame.finalized_j_height,
        accounts_root,
        entity: core.state,
    };
    let scheduled_wakes = super::ScheduledWakeIndex::from_entity_state(&state.entity)?;
    let replica = RuntimeReplica {
        state,
        durable,
        entity_id,
        signer_id,
        accounts,
        entity_consensus: certified.consensus,
        entity_signer,
        protocol_fingerprint,
        replica_metadata,
        certified_board_registry,
        last_materialized_height,
        mempool,
        scheduled_wakes,
        limits,
    };
    let applied_frame = AppliedRuntimeFrame {
        runtime_txs: frame.runtime_txs,
        entity_inputs: canonical_entity_inputs,
        frame: frame.frame,
        entity_frame_committed: true,
    };
    Ok(RuntimeApplyResult {
        replica,
        applied_input: Some(frame.receipt),
        applied_frame: Some(applied_frame),
        outputs: RuntimeOutputs {
            entity_events,
            local_entity_outputs,
            entity_state_root: Some(entity_state_root),
            entity_authority_root: Some(entity_authority_root),
            checkpoint,
            touches,
        },
        account_commits,
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
    durable: &mut crate::RuntimeDurableEnvelope,
    txs: &[super::RuntimeTx],
) -> Result<(), RuntimeMachineError> {
    for tx in txs {
        match tx {
            super::RuntimeTx::AdvanceJWatcherCursor {
                depository_address,
                chain_id,
                block_number,
            } => durable.advance_j_watcher_cursor(depository_address, *chain_id, *block_number)?,
            super::RuntimeTx::Unsupported { kind } => {
                return Err(RuntimeMachineError::UnsupportedRuntimeTx { kind: kind.clone() });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use xln_rscore_batch::{AccountInputResult, AccountInputVerdict};
    use xln_rscore_engine::{
        AccountDomain, AccountFrame, CommittedFrameEvidence, DepositoryAddress,
    };

    use super::{AccountCommitSource, AccountId, account_commit_evidence};

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
    fn frame_ack_commit_evidence_preserves_ack_then_peer_order() {
        let account_id = AccountId::from_bytes([0x44; 32]);
        let ack_frame = committed_frame(7, 0x71, false);
        let peer_frame = committed_frame(8, 0x81, true);
        let verdict = AccountInputVerdict::FrameAckApplied {
            ack: Box::new(AccountInputVerdict::AckCommitted {
                height: ack_frame.frame.height,
                state_hash: ack_frame.state_hash,
                outputs: Vec::new(),
                events: Vec::new(),
                committed_frame: Box::new(ack_frame),
            }),
            frame: Box::new(AccountInputVerdict::FrameCommitted {
                height: peer_frame.frame.height,
                state_hash: peer_frame.state_hash,
                ack_signature: [0_u8; 65],
                ack_hanko: Vec::new(),
                outputs: Vec::new(),
                events: Vec::new(),
                rolled_back: None,
                committed_frame: Box::new(peer_frame),
                ack_dispute: None,
            }),
        };
        let evidence = account_commit_evidence(&[AccountInputResult {
            operation_index: 0,
            account_id,
            verdict,
        }]);

        assert_eq!(evidence.len(), 2);
        assert_eq!(evidence[0].source, AccountCommitSource::AckCommit);
        assert_eq!(evidence[0].frame_height, 7);
        assert_eq!(evidence[0].account_state_root, [0x71; 32]);
        assert_eq!(evidence[1].source, AccountCommitSource::PeerCommit);
        assert_eq!(evidence[1].frame_height, 8);
        assert_eq!(evidence[1].account_state_root, [0x81; 32]);
    }

    use super::j_prefix_pending_local_event;

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
        assert_eq!(j_prefix_pending_local_event(&metadata, 35, true), Ok(false));
    }

    #[test]
    fn j_prefix_contiguous_advance_across_empty_block_refuses_stale_base() {
        // contiguousThroughHeight already advanced to 36 with zero events:
        // the base-claim path must not silently certify stale height 35.
        let metadata = j_history(36, 36, &[], &[]);
        assert_eq!(j_prefix_pending_local_event(&metadata, 35, true), Ok(true));
    }

    #[test]
    fn j_prefix_missing_local_history_refuses() {
        let metadata = serde_json::json!({});
        assert_eq!(j_prefix_pending_local_event(&metadata, 35, true), Ok(true));
    }

    #[test]
    fn j_prefix_semantic_event_refuses() {
        let metadata = j_history(36, 35, &[36], &[]);
        assert_eq!(j_prefix_pending_local_event(&metadata, 35, true), Ok(true));
    }
}
