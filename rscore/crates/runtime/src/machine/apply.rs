use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Instant;

use sha3::{Digest as _, Keccak256};
use xln_rscore_batch::{AccountId, AccountInputVerdict, EntityInboundRequest, ReceiverClock};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, EntityCommandBoard, EntityCommandDisposition, EntityFrameEvent,
    EntityFrameWireMeasureBody, EntityTransitionCertificationRequest, EntityTransitionError,
    HashType, MAX_ENTITY_FRAME_TX_BYTES, MAX_ENTITY_PROPOSAL_WIRE_BYTES,
    MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, PendingNonMutatingWake, ResidentEntityRequest,
    ScheduledWake, UNREGISTERED_ENTITY_COMMAND_STACK_KEY, advance_entity_command_nonce,
    apply_resident_entity_round_core, assert_signed_entity_command,
    build_collective_entity_command, build_required_j_prefix_certificate,
    certify_entity_transition, collect_due_scheduled_wake_jobs, current_entity_command_board_hash,
    measure_entity_frame_wire, normalize_entity_command_nonce_board,
};
use xln_rscore_protocol::CanonicalValue;

use crate::{
    EntityInfraMaterializeRequest, EntityInfraMaterializer, MaterializedEntityInfraContext,
};

use super::inbound_genesis::attach_inbound_genesis_policies;
use super::types::EntityPendingWork;
use super::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RuntimeApplyResult, RuntimeFrameContext, RuntimeFrameTouches, RuntimeInput, RuntimeLiveInput,
    RuntimeMachineError, RuntimeOutputs, RuntimeReplica, RuntimeWake, enqueue_runtime_input,
    scheduled_input::{empty_entity_input, scheduled_wake_entity_input},
    select_runtime_frame,
};

fn profile_runtime_apply() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
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
    let entity_mempool = !replica.entity_mempool.is_empty();
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
    if !entity_mempool && !account_mempool && scheduled.is_none() {
        return Ok(None);
    }
    Ok(Some(RuntimeWake {
        entity_mempool,
        account_mempool,
        scheduled,
    }))
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
}

fn prepare_entity_prefix<'a>(
    replica: &RuntimeReplica,
    work: impl Iterator<Item = &'a EntityPendingWork>,
) -> Result<PreparedEntityPrefix<'a>, RuntimeMachineError> {
    let work = work.collect::<Vec<_>>();
    let has_commands = work.iter().any(|work| {
        matches!(
            work,
            EntityPendingWork::LocalBatch { .. } | EntityPendingWork::Command { .. }
        )
    });
    let board = has_commands.then(|| command_board(replica)).transpose()?;
    let mut command_nonces = replica.state.entity.entity_command_nonces.clone();
    if let Some(board) = board.as_ref() {
        normalize_entity_command_nonce_board(&mut command_nonces, board)?;
    }
    let mut txs = Vec::with_capacity(work.len());
    let mut rows = Vec::new();
    let mut local_financial_txs = Vec::new();
    for work in work {
        match work {
            EntityPendingWork::Account { projected, row } => {
                txs.push(PreparedFrameTx::Borrowed(projected));
                rows.push(row);
            }
            EntityPendingWork::LocalBatch { projected, native } => {
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (command, command_projection) = build_collective_entity_command(
                    &replica.entity_signer,
                    board,
                    command_nonces.as_ref(),
                    &render_word(&replica.entity_id),
                    projected,
                )?;
                if command.native_txs != *native {
                    return Err(RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_NATIVE_PROJECTION_MISMATCH".into(),
                    ));
                }
                txs.push(PreparedFrameTx::Owned(command_projection));
                local_financial_txs.extend(native.iter());
                advance_entity_command_nonce(&mut command_nonces, board, &command)?;
            }
            EntityPendingWork::Command { projected, command } => {
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (_, disposition) = assert_signed_entity_command(
                    &replica.state.entity.entity_id,
                    &replica.entity_consensus.state.authority,
                    &board.signer,
                    board.board_epoch,
                    &board.stack_key,
                    command_nonces.as_ref(),
                    command,
                )?;
                if disposition == EntityCommandDisposition::Next {
                    local_financial_txs.extend(command.native_txs.iter());
                }
                txs.push(PreparedFrameTx::Borrowed(projected));
                advance_entity_command_nonce(&mut command_nonces, board, command)?;
            }
            EntityPendingWork::Projected(projected) => {
                txs.push(PreparedFrameTx::Borrowed(projected));
            }
        }
    }
    Ok(PreparedEntityPrefix {
        txs,
        rows,
        local_financial_txs,
    })
}

fn measure_prepared_entity_prefix(
    replica: &RuntimeReplica,
    frame: &RuntimeFrameContext,
    prepared: &PreparedEntityPrefix<'_>,
    entity_context: &CanonicalValue,
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<xln_rscore_entity_kernel::EntityFrameWireMeasure, RuntimeMachineError> {
    const DUMMY_ROOT: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
    let parent_frame_hash = replica
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
        height: replica
            .state
            .entity
            .height
            .checked_add(1)
            .ok_or(RuntimeMachineError::EntityHeightOverflow)?,
        timestamp: frame.timestamp,
        txs: &txs,
        events: &[] as &[EntityFrameEvent],
        entity_id: &replica.state.entity.entity_id,
        state_root: DUMMY_ROOT,
        authority_root: DUMMY_ROOT,
        entity_context,
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
            canonical_field(binding, "lockId").ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(
                    "ENTITY_REPLAY_CONTEXT_HTLC_LOCK_MISSING".into(),
                )
            })?,
            "context.htlc.binding.lockId",
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

fn pending_htlc_keys(
    work: &EntityPendingWork,
) -> Result<std::collections::BTreeSet<String>, RuntimeMachineError> {
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
        let lock = canonical_text(
            canonical_field(data, "lockId").ok_or_else(|| {
                RuntimeMachineError::EntityContextMaterialization(
                    "ENTITY_REPLAY_ACCOUNT_LOCK_ID_MISSING".into(),
                )
            })?,
            "accountFrame.accountTx.lockId",
        )?
        .to_lowercase();
        keys.insert(format!("{frame_hash}:{lock}"));
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
    for (index, work) in work.iter().enumerate() {
        let keys = pending_htlc_keys(work)?;
        if keys.iter().any(|key| !expected.contains(key)) {
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
            "ENTITY_REPLAY_HTLC_PREFIX_MISSING:{}:{}",
            expected.len(),
            observed.len()
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
    replica: &RuntimeReplica,
    work: &std::collections::VecDeque<EntityPendingWork>,
    frame: &RuntimeFrameContext,
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<usize, RuntimeMachineError> {
    let (mut candidate, required) =
        replay_compatible_prefix(work, &frame.canonical_entity_context)?;
    if work.is_empty() {
        return Ok(0);
    }
    if candidate == 0 {
        return Err(RuntimeMachineError::HeadWireUnfittable {
            actual: 1,
            limit: MAX_ENTITY_PROPOSAL_WIRE_BYTES,
        });
    }
    for _ in 0..16 {
        let prepared = prepare_entity_prefix(replica, work.iter().take(candidate))?;
        let measured = measure_prepared_entity_prefix(
            replica,
            frame,
            &prepared,
            &frame.canonical_entity_context,
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
            return Ok(candidate);
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
    replica: &mut RuntimeReplica,
    work: &std::collections::VecDeque<EntityPendingWork>,
    frame: &RuntimeFrameContext,
    materializer: &mut dyn EntityInfraMaterializer,
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<(usize, MaterializedEntityInfraContext), RuntimeMachineError> {
    let mut candidate = work.len();
    for _ in 0..16 {
        let prepared = prepare_entity_prefix(replica, work.iter().take(candidate))?;
        let materialized = materializer
            .materialize(EntityInfraMaterializeRequest {
                replica,
                account_inputs: &prepared.rows,
                local_financial_txs: &prepared.local_financial_txs,
                timestamp: frame.timestamp,
                finalized_j_height: frame.finalized_j_height,
            })
            .map_err(|error| {
                RuntimeMachineError::EntityContextMaterialization(error.to_string())
            })?;
        let measured = measure_prepared_entity_prefix(
            replica,
            frame,
            &prepared,
            &materialized.canonical,
            j_prefix_certificate,
        )?;
        if measured.total_bytes <= MAX_ENTITY_PROPOSAL_WIRE_BYTES
            && measured.tx_bytes <= MAX_ENTITY_FRAME_TX_BYTES
        {
            return Ok((candidate, materialized));
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
    }
    Err(RuntimeMachineError::EntityContextMaterialization(
        "ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED".into(),
    ))
}

struct SelectedEntityWork {
    txs: Vec<CanonicalEntityTx>,
    rows: Vec<xln_rscore_batch::AccountInputRow>,
    local_financial_txs: Vec<xln_rscore_entity_kernel::LocalEntityFinancialTx>,
    command_nonces: Option<xln_rscore_entity_kernel::EntityCommandNonceState>,
}

fn take_entity_prefix(
    replica: &RuntimeReplica,
    work: &mut std::collections::VecDeque<EntityPendingWork>,
    count: usize,
) -> Result<SelectedEntityWork, RuntimeMachineError> {
    let has_commands = work.iter().take(count).any(|work| {
        matches!(
            work,
            EntityPendingWork::LocalBatch { .. } | EntityPendingWork::Command { .. }
        )
    });
    let board = has_commands.then(|| command_board(replica)).transpose()?;
    let mut command_nonces = replica.state.entity.entity_command_nonces.clone();
    if let Some(board) = board.as_ref() {
        normalize_entity_command_nonce_board(&mut command_nonces, board)?;
    }
    let mut selected = SelectedEntityWork {
        txs: Vec::with_capacity(count),
        rows: Vec::new(),
        local_financial_txs: Vec::new(),
        command_nonces,
    };
    for _ in 0..count {
        let work = work
            .pop_front()
            .ok_or(RuntimeMachineError::InputCountOverflow)?;
        match work {
            EntityPendingWork::Account { projected, row } => {
                selected.txs.push(projected);
                selected.rows.push(row);
            }
            EntityPendingWork::LocalBatch { projected, native } => {
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (command, command_projection) = build_collective_entity_command(
                    &replica.entity_signer,
                    board,
                    selected.command_nonces.as_ref(),
                    &render_word(&replica.entity_id),
                    &projected,
                )?;
                if command.native_txs != native {
                    return Err(RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_NATIVE_PROJECTION_MISMATCH".into(),
                    ));
                }
                selected.txs.push(command_projection);
                selected.local_financial_txs.extend(native);
                advance_entity_command_nonce(&mut selected.command_nonces, board, &command)?;
            }
            EntityPendingWork::Command { projected, command } => {
                let board = board.as_ref().ok_or_else(|| {
                    RuntimeMachineError::EntityCommandContext(
                        "ENTITY_COMMAND_BOARD_CONTEXT_REQUIRED".into(),
                    )
                })?;
                let (_, disposition) = assert_signed_entity_command(
                    &replica.state.entity.entity_id,
                    &replica.entity_consensus.state.authority,
                    &board.signer,
                    board.board_epoch,
                    &board.stack_key,
                    selected.command_nonces.as_ref(),
                    &command,
                )?;
                advance_entity_command_nonce(&mut selected.command_nonces, board, &command)?;
                if disposition == EntityCommandDisposition::Next {
                    selected.local_financial_txs.extend(command.native_txs);
                }
                selected.txs.push(projected);
            }
            EntityPendingWork::Projected(projected) => selected.txs.push(projected),
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
    mut materializer: Option<&mut dyn EntityInfraMaterializer>,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    let total_started = Instant::now();
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
                entity_txs_selected: 0,
                entity_txs_pending: 0,
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
    let mut canonical_entity_inputs = Vec::with_capacity(frame.receipt.entity_inputs);
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
        replica
            .entity_mempool
            .push_front(EntityPendingWork::Projected(tx));
        canonical_entity_inputs.push(canonical);
    }
    let had_external_entity_inputs = !frame.entity_inputs.is_empty();
    for entity_input in frame.entity_inputs {
        let (canonical, pending_work) = entity_input.into_parts();
        canonical_entity_inputs.push(canonical);
        replica.entity_mempool.extend(pending_work);
    }
    if !had_external_entity_inputs
        && frame
            .receipt
            .wake
            .as_ref()
            .is_some_and(|wake| wake.scheduled.is_none())
    {
        let canonical = empty_entity_input(replica.entity_id, &replica.signer_id);
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
        canonical_entity_inputs.push(canonical);
    }

    let j_prefix_pending_local_event = j_prefix_pending_local_event(
        &replica.replica_metadata,
        replica.state.entity.last_finalized_j_height,
        replica.state.entity.j_history_finality.is_some(),
    )
    .map_err(|error| {
        RuntimeMachineError::ReplicaMetadata(format!("J_PREFIX_HISTORY_DECODE:{error}"))
    })?;
    let parent_frame_hash = replica
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .map_or("genesis", |head| head.frame.hash.as_str());
    let fit_j_prefix_certificate = build_required_j_prefix_certificate(
        &replica.entity_signer,
        &replica.entity_consensus.state.authority,
        &replica.state.entity,
        next_entity_height,
        parent_frame_hash,
        j_prefix_pending_local_event,
    )
    .map_err(EntityTransitionError::from)?;

    let materialize_started = Instant::now();
    let mut entity_mempool = std::mem::take(&mut replica.entity_mempool);
    let (selected_count, materialized) = match materializer.as_deref_mut() {
        Some(materializer) => {
            let (selected_count, materialized) = fit_live_entity_prefix(
                &mut replica,
                &entity_mempool,
                &frame.frame,
                materializer,
                fit_j_prefix_certificate.as_ref(),
            )?;
            (selected_count, Some(materialized))
        }
        None => {
            let selected_count = fit_replay_entity_prefix(
                &replica,
                &entity_mempool,
                &frame.frame,
                fit_j_prefix_certificate.as_ref(),
            )?;
            (selected_count, None)
        }
    };
    let selected = take_entity_prefix(&replica, &mut entity_mempool, selected_count)?;
    frame.receipt.entity_txs_selected = selected_count;
    frame.receipt.entity_txs_pending = entity_mempool.len();
    replica.entity_mempool = entity_mempool;
    let mut rows = selected.rows;
    let canonical_entity_txs = selected.txs;
    let local_financial_txs = selected.local_financial_txs;
    let command_nonces = selected.command_nonces;
    if let Some(materialized) = materialized {
        frame.frame.entity_context = materialized.execution;
        frame.frame.canonical_entity_context = materialized.canonical;
    }
    let prepared = total_started.elapsed();
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
    let resolved = total_started.elapsed();

    let materialize = materialize_started.elapsed();
    let materialize_done = total_started.elapsed();

    let checkpoint_due = replica.entity_mempool.is_empty()
        && super::materialization_due(
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
        checkpoint_due: false,
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
    let core_started = Instant::now();
    let mut core = apply_resident_entity_round_core(
        &mut replica.accounts,
        replica.state.entity,
        request,
        &frame.frame.entity_context,
    )?;
    let core_elapsed = core_started.elapsed();
    core.state.entity_command_nonces = command_nonces;
    let account_commits = account_commit_evidence(&core.inbound.applied);
    let accounts_root = core.outbound.accounts_root;
    let account_count = replica.accounts.account_count();
    let post_authority = replica.entity_consensus.state.authority.clone();
    let RuntimeReplica {
        durable,
        entity_id,
        signer_id,
        mut accounts,
        mempool,
        entity_mempool,
        limits,
        entity_consensus,
        entity_signer,
        protocol_fingerprint,
        replica_metadata,
        certified_board_registry,
        last_materialized_height,
        ..
    } = replica;
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
    let certify_started = Instant::now();
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
    let certify_elapsed = certify_started.elapsed();
    let mut dispute_hankos = BTreeMap::new();
    for (hash, witness) in &certified.manifest_hankos {
        if witness.kind != HashType::Dispute {
            continue;
        }
        let digest = parse_hex32(hash).ok_or_else(|| {
            RuntimeMachineError::ReplicaMetadata(format!(
                "ENTITY_MANIFEST_DISPUTE_HASH_INVALID:{hash}"
            ))
        })?;
        if dispute_hankos
            .insert(digest, witness.hanko.clone())
            .is_some()
        {
            return Err(RuntimeMachineError::ReplicaMetadata(format!(
                "ENTITY_MANIFEST_DISPUTE_HASH_DUPLICATE:{hash}"
            )));
        }
    }
    accounts.attach_local_dispute_hankos(&touched_account_ids, dispute_hankos)?;
    let checkpoint = if checkpoint_due {
        Some(accounts.export_checkpoint()?)
    } else {
        None
    };
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
        entity_mempool,
        scheduled_wakes,
        limits,
    };
    let applied_frame = AppliedRuntimeFrame {
        runtime_txs: frame.runtime_txs,
        entity_inputs: canonical_entity_inputs,
        frame: frame.frame,
        entity_frame_committed: true,
    };
    if profile_runtime_apply() {
        let total = total_started.elapsed();
        eprintln!(
            "RSCORE_RUNTIME_APPLY_PHASE h={} prepare={} resolve={} materialize={} request={} core={} corePost={} certify={} finalize={} total={}",
            next_height,
            prepared.as_micros(),
            resolved.saturating_sub(prepared).as_micros(),
            materialize.as_micros(),
            core_started
                .duration_since(total_started)
                .saturating_sub(materialize_done)
                .as_micros(),
            core_elapsed.as_micros(),
            certify_started
                .duration_since(core_started)
                .saturating_sub(core_elapsed)
                .as_micros(),
            certify_elapsed.as_micros(),
            total
                .saturating_sub(certify_started.duration_since(total_started))
                .saturating_sub(certify_elapsed)
                .as_micros(),
            total.as_micros(),
        );
    }
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
    use std::collections::VecDeque;

    use xln_rscore_batch::{AccountInputResult, AccountInputVerdict};
    use xln_rscore_engine::{
        AccountDomain, AccountFrame, CommittedFrameEvidence, DepositoryAddress,
    };
    use xln_rscore_entity_kernel::{CanonicalEntityTx, EntityTxKind};
    use xln_rscore_protocol::CanonicalValue;

    use crate::RuntimeEntityInput;

    use super::{
        AccountCommitSource, AccountId, EntityPendingWork, RuntimeFrameContext,
        account_commit_evidence, fit_replay_entity_prefix, replay_compatible_prefix,
        take_entity_prefix,
    };

    #[test]
    fn entity_wire_fit_keeps_exact_fifo_prefix_and_tail() {
        let replica =
            crate::machine::tests::replica(crate::RuntimeLimits::hlt()).expect("runtime replica");
        let tx = || {
            CanonicalEntityTx::from_frame_projection(
                EntityTxKind::DirectPayment,
                CanonicalValue::String("x".repeat(3_000_000)),
            )
            .expect("large canonical tx")
        };
        let mut work = VecDeque::from([
            EntityPendingWork::Projected(tx()),
            EntityPendingWork::Projected(tx()),
        ]);
        let frame = RuntimeFrameContext {
            timestamp: 1,
            finalized_j_height: 0,
            hub_rebalance_has_pending_work: false,
            entity_context: xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
            canonical_entity_context: CanonicalValue::Object(Vec::new()),
        };
        let selected =
            fit_replay_entity_prefix(&replica, &work, &frame, None).expect("bounded prefix");
        assert_eq!(selected, 1);
        let taken = take_entity_prefix(&replica, &mut work, selected).expect("take prefix");
        assert_eq!(taken.txs.len(), 1);
        assert_eq!(work.len(), 1);
    }

    fn replay_account_work(frame_hash: &str, lock_id: &str) -> EntityPendingWork {
        let owner = super::render_word(&crate::machine::tests::owner_bytes());
        let input = RuntimeEntityInput::decode(serde_json::json!({
            "entityId": owner,
            "signerId": crate::machine::tests::SIGNER,
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
        let (_, mut work) = input.into_parts();
        let EntityPendingWork::Account { projected, .. } = &mut work[0] else {
            panic!("AccountInput work")
        };
        projected.wire_data = crate::canonical_value_from_tagged_json(&serde_json::json!({
            "proposal": {
                "frame": {
                    "stateHash": frame_hash,
                    "accountTxs": [{
                        "type": "htlc_lock",
                        "data": {"lockId": lock_id, "envelope": {}}
                    }]
                }
            }
        }))
        .expect("canonical Account proposal");
        work.pop().expect("one Account work")
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
                    {"binding": {"accountFrameHash": frame_a, "lockId": lock_a}},
                    {"binding": {"accountFrameHash": frame_b, "lockId": lock_b}}
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
                ack_dispute_signature: None,
                ack_dispute_hanko: None,
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
            response: xln_rscore_batch::AccountResponseDirective::Preserve,
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
