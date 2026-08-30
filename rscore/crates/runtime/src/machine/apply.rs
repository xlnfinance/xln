use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use sha3::{Digest as _, Keccak256};
use xln_rscore_batch::{
    AccountId, AccountInputVerdict, CertifiedBoardAuthorityResolver, CertifiedSettlementHankoDraft,
    EntityInboundRequest, ReceiverClock, ResidentAccountFinancialViewRequest,
    ResidentCrossJMaterializationView,
};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, EntityCommandBoard, EntityCommandDisposition, EntityFrameEvent,
    EntityFrameWireMeasureBody, EntityTransitionCertificationRequest, EntityTransitionError,
    EntityTxKind, HashType, JPrefixRangeClaim, LocalEntityTx, MAX_ENTITY_FRAME_TX_BYTES,
    MAX_ENTITY_PROPOSAL_WIRE_BYTES, MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, PendingNonMutatingWake,
    ResidentEntityOperation, ResidentEntityRequest, ScheduledWake,
    UNREGISTERED_ENTITY_COMMAND_STACK_KEY, advance_entity_command_nonce,
    apply_resident_entity_round_core, assert_signed_entity_command,
    build_collective_entity_command, build_proposer_materializations,
    build_required_j_prefix_certificate, certify_entity_transition,
    collect_due_scheduled_wake_jobs, current_entity_command_board_hash, decode_local_entity_tx,
    measure_entity_frame_tx_bytes, measure_entity_frame_wire, normalize_entity_command_nonce_board,
    proposer_materialization_account_view_requests, proposer_materialization_key,
    resolve_board_handover_authority, sign_j_event_range,
};
use xln_rscore_protocol::CanonicalValue;

use crate::{
    EntityInfraMaterializeRequest, EntityInfraMaterializer, MaterializedEntityInfraContext,
};

use super::inbound_genesis::{attach_inbound_genesis_policies, derive_policy};
use super::types::EntityPendingWork;
use super::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RuntimeApplyResult, RuntimeEntityFrameContext, RuntimeEntityKey, RuntimeEntityOutputs,
    RuntimeEntityReplica, RuntimeEntityState, RuntimeFrameContext, RuntimeFrameTouches,
    RuntimeInput, RuntimeLiveInput, RuntimeMachineError, RuntimeOutputs, RuntimeReplica,
    RuntimeWake, enqueue_runtime_input,
    scheduled_input::{empty_entity_input, scheduled_wake_entity_input},
    select_runtime_frame,
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
    let state = &slot.state.entity;
    if slot.replica.entity_signer.signer_id() != observation.signer_id {
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
        return Err(j_range_error("HEADER_RANGE"));
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
        &slot.replica.entity_signer,
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

fn command_board(slot: &EntityApplySlot) -> Result<EntityCommandBoard, RuntimeMachineError> {
    let authority = slot
        .replica
        .entity_consensus
        .state
        .authority
        .validate_and_normalize()
        .map_err(|error| RuntimeMachineError::EntityCommandContext(error.to_string()))?;
    let signer = slot
        .replica
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
    let board_epoch = if slot.replica.entity_id == board_bytes {
        0
    } else {
        let record = slot
            .replica
            .certified_board_registry
            .entity_command_board(&slot.replica.entity_id)
            .ok_or_else(|| {
                RuntimeMachineError::EntityCommandContext(format!(
                    "ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED:{}",
                    render_word(&slot.replica.entity_id)
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
    let signer_id = slot.replica.entity_signer.signer_id().to_string();
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
            source: AccountCommitSource::PeerCommit,
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
    state: &RuntimeEntityState,
    replica: &RuntimeEntityReplica,
    frame: &RuntimeFrameContext,
) -> Result<Option<RuntimeWake>, RuntimeMachineError> {
    let entity_mempool = !replica.entity_mempool.is_empty();
    let account_mempool = replica.accounts.has_proposable_accounts()?;
    let jobs = match &state.entity.crontab {
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
    slot: &EntityApplySlot,
    work: impl Iterator<Item = &'a EntityPendingWork>,
    max_tx_bytes: Option<usize>,
) -> Result<PreparedEntityPrefix<'a>, RuntimeMachineError> {
    let mut board = None;
    let mut command_nonces = slot.state.entity.entity_command_nonces.clone();
    let mut txs = Vec::new();
    let mut rows = Vec::new();
    let mut local_financial_txs = Vec::new();
    let mut tx_bytes = 0_usize;
    for work in work {
        match work {
            EntityPendingWork::Account { projected, row } => {
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
                let (command, command_projection) = build_collective_entity_command(
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
                if !accept_entity_tx_bytes(&mut tx_bytes, projected, max_tx_bytes)? {
                    break;
                }
                if disposition == EntityCommandDisposition::Next {
                    local_financial_txs.extend(command.native_txs.iter().filter_map(
                        |tx| match tx {
                            xln_rscore_entity_kernel::LocalEntityTx::Financial(tx) => Some(tx),
                            xln_rscore_entity_kernel::LocalEntityTx::Control(_)
                            | xln_rscore_entity_kernel::LocalEntityTx::CrossJurisdiction(_)
                            | xln_rscore_entity_kernel::LocalEntityTx::RuntimeOutput(_) => None,
                        },
                    ));
                }
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
    }
    Ok(PreparedEntityPrefix {
        txs,
        rows,
        local_financial_txs,
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

fn inspect_materialization_tx(
    tx: &CanonicalEntityTx,
    pending_keys: &mut BTreeSet<String>,
    commit_phase: &mut bool,
) -> Result<(), RuntimeMachineError> {
    if let Some(key) = proposer_materialization_key(tx) {
        pending_keys.insert(key);
    }
    *commit_phase |= matches!(
        tx.kind,
        EntityTxKind::CrossJurisdictionFillNotice | EntityTxKind::RegisterCrossJurisdictionSwap
    );
    if tx.kind != EntityTxKind::RuntimeOutput {
        return Ok(());
    }
    let Some(LocalEntityTx::RuntimeOutput(output)) =
        decode_local_entity_tx(tx).map_err(RuntimeMachineError::EntityFinancial)?
    else {
        return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
            tx.kind.as_str(),
        ));
    };
    for nested in &output.entity_txs {
        inspect_materialization_tx(nested, pending_keys, commit_phase)?;
    }
    Ok(())
}

fn inspect_materialization_local_tx(
    tx: &LocalEntityTx,
    pending_keys: &mut BTreeSet<String>,
    commit_phase: &mut bool,
) -> Result<(), RuntimeMachineError> {
    match tx {
        LocalEntityTx::CrossJurisdiction(tx) => {
            inspect_materialization_tx(tx, pending_keys, commit_phase)
        }
        LocalEntityTx::RuntimeOutput(output) => {
            for nested in &output.entity_txs {
                inspect_materialization_tx(nested, pending_keys, commit_phase)?;
            }
            Ok(())
        }
        LocalEntityTx::Financial(_) | LocalEntityTx::Control(_) => Ok(()),
    }
}

fn materialization_admission(
    work: &std::collections::VecDeque<EntityPendingWork>,
) -> Result<(BTreeSet<String>, bool), RuntimeMachineError> {
    let mut pending_keys = BTreeSet::new();
    let mut commit_phase = false;
    for work in work {
        match work {
            EntityPendingWork::Account { .. } => commit_phase = true,
            EntityPendingWork::LocalBatch { native, .. } => {
                for tx in native {
                    inspect_materialization_local_tx(tx, &mut pending_keys, &mut commit_phase)?;
                }
            }
            EntityPendingWork::Command { command, .. } => {
                for tx in &command.native_txs {
                    inspect_materialization_local_tx(tx, &mut pending_keys, &mut commit_phase)?;
                }
            }
            EntityPendingWork::ProposerMaterialized { native, .. } => {
                inspect_materialization_local_tx(native, &mut pending_keys, &mut commit_phase)?;
            }
            EntityPendingWork::Projected(projected) => {
                inspect_materialization_tx(projected, &mut pending_keys, &mut commit_phase)?;
            }
        }
    }
    Ok((pending_keys, commit_phase))
}

fn enqueue_proposer_materializations(
    slot: &mut EntityApplySlot,
    runtime_seed: &str,
) -> Result<(), RuntimeMachineError> {
    let (pending_keys, commit_phase) = materialization_admission(&slot.replica.entity_mempool)?;
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
        &slot.replica.signer_id,
        &slot.replica.entity_consensus.state.authority,
        &account_views,
        &pending_keys,
        commit_phase,
    )
    .map_err(RuntimeMachineError::EntityFinancial)?;
    for projected in additions {
        let Some(native) =
            decode_local_entity_tx(&projected).map_err(RuntimeMachineError::EntityFinancial)?
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
        slot.replica
            .entity_mempool
            .push_back(EntityPendingWork::ProposerMaterialized {
                projected,
                native: Box::new(native),
            });
    }
    Ok(())
}

fn measure_prepared_entity_prefix(
    slot: &EntityApplySlot,
    frame: &RuntimeFrameContext,
    prepared: &PreparedEntityPrefix<'_>,
    entity_context: &CanonicalValue,
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
    slot: &EntityApplySlot,
    work: &std::collections::VecDeque<EntityPendingWork>,
    frame: &RuntimeFrameContext,
    entity_context: &CanonicalValue,
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<usize, RuntimeMachineError> {
    let (mut candidate, required) = replay_compatible_prefix(work, entity_context)?;
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
        let prepared = prepare_entity_prefix(slot, work.iter().take(candidate), None)?;
        let measured = measure_prepared_entity_prefix(
            slot,
            frame,
            &prepared,
            entity_context,
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
    slot: &mut EntityApplySlot,
    work: &std::collections::VecDeque<EntityPendingWork>,
    frame: &RuntimeFrameContext,
    materializer: &mut dyn EntityInfraMaterializer,
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<(usize, MaterializedEntityInfraContext), RuntimeMachineError> {
    let fit_started = Instant::now();
    let prepare_started = Instant::now();
    let mut prepared = prepare_entity_prefix(slot, work.iter(), Some(MAX_ENTITY_FRAME_TX_BYTES))?;
    let mut prepare_elapsed = prepare_started.elapsed();
    let materialize_started = Instant::now();
    let mut materialized = materializer
        .materialize(EntityInfraMaterializeRequest {
            state: &slot.state,
            replica: &mut slot.replica,
            account_inputs: &prepared.rows,
            local_financial_txs: &prepared.local_financial_txs,
            timestamp: frame.timestamp,
            finalized_j_height: frame.finalized_j_height,
        })
        .map_err(|error| RuntimeMachineError::EntityContextMaterialization(error.to_string()))?;
    let materialize_elapsed = materialize_started.elapsed();
    let mut measure_elapsed = std::time::Duration::ZERO;
    let mut attempts = 0_usize;
    let mut candidate = prepared.txs.len();
    for _ in 0..16 {
        attempts += 1;
        let measure_started = Instant::now();
        let measured = measure_prepared_entity_prefix(
            slot,
            frame,
            &prepared,
            &materialized.canonical,
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
        let prepare_started = Instant::now();
        prepared = prepare_entity_prefix(slot, work.iter().take(candidate), None)?;
        prepare_elapsed = prepare_elapsed.saturating_add(prepare_started.elapsed());
        let mut retained = std::collections::BTreeSet::new();
        for item in work.iter().take(candidate) {
            retained.extend(pending_htlc_key_pairs(item)?);
        }
        materialized
            .retain_inbound_htlc_keys(&retained)
            .map_err(|error| {
                RuntimeMachineError::EntityContextMaterialization(error.to_string())
            })?;
    }
    Err(RuntimeMachineError::EntityContextMaterialization(
        "ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED".into(),
    ))
}

struct SelectedEntityWork {
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
        txs: Vec::with_capacity(count),
        rows: Vec::new(),
        operations: Vec::new(),
        command_nonces,
    };
    for _ in 0..count {
        let work = work
            .pop_front()
            .ok_or(RuntimeMachineError::InputCountOverflow)?;
        match work {
            EntityPendingWork::Account { projected, row } => {
                selected.txs.push(projected);
                let start = selected.rows.len();
                selected.rows.push(*row);
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
                let (command, command_projection) = build_collective_entity_command(
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
                if disposition == EntityCommandDisposition::Next {
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

struct PendingEntityGroup {
    entity_id: [u8; 32],
    signer_id: String,
    pending: Vec<EntityPendingWork>,
    input_positions: Vec<usize>,
    wake: Option<RuntimeWake>,
    j_observation: Option<crate::j_watcher::ObserveJRange>,
}

struct PendingEntitySegment {
    groups: Vec<PendingEntityGroup>,
}

fn push_pending_entity_input(
    groups: &mut Vec<PendingEntityGroup>,
    indexes: &mut BTreeMap<RuntimeEntityKey, usize>,
    entity_id: [u8; 32],
    signer_id: String,
    pending: Vec<EntityPendingWork>,
    position: usize,
) -> Result<(), RuntimeMachineError> {
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
                j_observation: None,
            });
            index
        }
    };
    groups[index].pending.extend(pending);
    groups[index].input_positions.push(position);
    Ok(())
}

struct AppliedEntityGroup {
    state: RuntimeEntityState,
    replica: RuntimeEntityReplica,
    outputs: RuntimeEntityOutputs,
    account_commits: Vec<AccountCommitEvidence>,
    touched_accounts: Vec<super::RuntimeTouchedAccount>,
    book_touched: bool,
    synthetic_input: Option<serde_json::Value>,
    selected_count: usize,
    pending_count: usize,
    post_commit_j_actions: Vec<crate::j_submit::DurableJAttempt>,
}

fn apply_runtime_inner(
    mut replica: RuntimeReplica,
    mut input: RuntimeInput,
    mut materializer: Option<&mut dyn EntityInfraMaterializer>,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    validate_frame_context(&replica, &input)?;
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

    enqueue_runtime_input(&mut replica.mempool, &mut input, replica.limits)?;
    let entity_heights = replica
        .state
        .e_replicas
        .iter()
        .map(|(key, state)| (key.clone(), state.entity.height))
        .collect();
    let selected = select_runtime_frame(
        &mut replica.mempool,
        replica.limits,
        &entity_heights,
        input.frame.clone(),
    )?;
    let selected_context = selected
        .as_ref()
        .map_or_else(|| input.frame.clone(), |selected| selected.frame.clone());
    validate_selected_context(&replica, &selected_context)?;

    let mut wakes = Vec::new();
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
        });
    };
    frame.receipt.wakes = wakes.clone();
    let (mut post_commit_j_attempts, mut j_observation) =
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
    let mut deferred_indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
    let mut inputs = std::collections::VecDeque::from(frame.entity_inputs);
    let mut position = 0_usize;
    while let Some(input) = inputs.pop_front() {
        let marker = input.atomic_pair().cloned();
        if let Some(marker) = marker {
            if !deferred_groups.is_empty() {
                segments.push(PendingEntitySegment {
                    groups: std::mem::take(&mut deferred_groups),
                });
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
                let (canonical, pending, _) = input.into_parts();
                canonical_slots[input_position] = Some(canonical);
                push_pending_entity_input(
                    &mut groups,
                    &mut indexes,
                    entity_id,
                    signer_id,
                    pending,
                    input_position,
                )?;
            }
            segments.push(PendingEntitySegment { groups });
            position += 2;
            continue;
        }
        let entity_id = *input.entity_id();
        let signer_id = input.signer_id().to_string();
        let board_handover_only = input.is_board_handover_only();
        let (canonical, pending, _) = input.into_parts();
        canonical_slots[position] = Some(canonical);
        if board_handover_only {
            if !deferred_groups.is_empty() {
                segments.push(PendingEntitySegment {
                    groups: std::mem::take(&mut deferred_groups),
                });
                deferred_indexes.clear();
            }
            let mut groups = Vec::with_capacity(1);
            let mut indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
            push_pending_entity_input(
                &mut groups,
                &mut indexes,
                entity_id,
                signer_id,
                pending,
                position,
            )?;
            segments.push(PendingEntitySegment { groups });
            position += 1;
            continue;
        }
        push_pending_entity_input(
            &mut deferred_groups,
            &mut deferred_indexes,
            entity_id,
            signer_id,
            pending,
            position,
        )?;
        position += 1;
    }
    if !deferred_groups.is_empty() {
        segments.push(PendingEntitySegment {
            groups: deferred_groups,
        });
    }

    // TS certifies a board transition only as one exact two-transaction
    // Entity frame. Attach the authenticated J range to the isolated
    // handover input instead of creating a second Entity height.
    if let Some(observation) = j_observation.as_ref() {
        let entity_id = *observation.entity_id.as_bytes();
        let mut target = None;
        for (segment_index, segment) in segments.iter().enumerate() {
            for (group_index, group) in segment.groups.iter().enumerate() {
                if group.entity_id == entity_id
                    && group.signer_id == observation.signer_id
                    && group.pending.len() == 1
                    && group.pending[0].is_board_handover()
                    && target.replace((segment_index, group_index)).is_some()
                {
                    return Err(RuntimeMachineError::EntityCommandContext(
                        "BOARD_HANDOVER_COUNT_INVALID".into(),
                    ));
                }
            }
        }
        if let Some((segment_index, group_index)) = target {
            segments[segment_index].groups[group_index].j_observation = j_observation.take();
        }
    }

    if !wakes.is_empty() || j_observation.is_some() {
        let mut groups = Vec::<PendingEntityGroup>::new();
        let mut indexes = BTreeMap::<RuntimeEntityKey, usize>::new();
        for entity_wake in wakes {
            let key = RuntimeEntityKey::new(entity_wake.entity_id, &entity_wake.signer_id)?;
            let signer_id = replica
                .e_replicas
                .get(&key)
                .ok_or(RuntimeMachineError::EntityOwnerMismatch)?
                .signer_id
                .clone();
            let index = groups.len();
            indexes.insert(key, index);
            groups.push(PendingEntityGroup {
                entity_id: entity_wake.entity_id,
                signer_id,
                pending: Vec::new(),
                input_positions: Vec::new(),
                wake: Some(entity_wake.wake),
                j_observation: None,
            });
        }
        if let Some(observation) = j_observation {
            let entity_id = *observation.entity_id.as_bytes();
            let key = RuntimeEntityKey::new(entity_id, &observation.signer_id)?;
            if let Some(index) = indexes.get(&key).copied() {
                if groups[index].signer_id != observation.signer_id {
                    return Err(RuntimeMachineError::EntitySignerMismatch);
                }
                groups[index].j_observation = Some(observation);
            } else {
                indexes.insert(key, groups.len());
                groups.push(PendingEntityGroup {
                    entity_id,
                    signer_id: observation.signer_id.clone(),
                    pending: Vec::new(),
                    input_positions: Vec::new(),
                    wake: None,
                    j_observation: Some(observation),
                });
            }
        }
        // J observations are processed before ordinary Entity inputs. A board
        // handover above is the sole exception: its J range and handover are
        // deliberately one atomic Entity frame.
        segments.insert(0, PendingEntitySegment { groups });
    }

    if segments.is_empty() {
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
                touches: RuntimeFrameTouches::default(),
            },
            account_commits: Vec::new(),
            post_commit_j_attempts,
        });
    }

    // Remove every touched committed+live Entity slot before executing the
    // first segment. Nothing is reinstalled until every segment succeeds, so
    // a failure in a later atomic pair cannot expose an earlier transition.
    // `entity_order` is the only source of install/output order; maps below
    // are lookup-only.
    let group_count = segments.iter().map(|segment| segment.groups.len()).sum();
    let mut entity_order = Vec::<RuntimeEntityKey>::new();
    let mut remaining_groups = BTreeMap::<RuntimeEntityKey, usize>::new();
    for segment in &segments {
        for group in &segment.groups {
            let key = RuntimeEntityKey::new(group.entity_id, &group.signer_id)?;
            if !remaining_groups.contains_key(&key) {
                entity_order.push(key.clone());
            }
            let count = remaining_groups.entry(key).or_default();
            *count = count
                .checked_add(1)
                .ok_or(RuntimeMachineError::InputCountOverflow)?;
        }
    }
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

    let mut outputs = RuntimeOutputs {
        entities: Vec::with_capacity(group_count),
        touches: RuntimeFrameTouches::default(),
    };
    let mut account_commits = Vec::new();
    let mut synthetic_inputs = Vec::new();
    for segment in segments {
        for group in segment.groups {
            let key = RuntimeEntityKey::new(group.entity_id, &group.signer_id)?;
            let slot = staged.remove(&key).ok_or_else(|| {
                RuntimeMachineError::EntityStateMap("STAGED_ENTITY_SLOT_MISSING".into())
            })?;
            let remaining = remaining_groups.get_mut(&key).ok_or_else(|| {
                RuntimeMachineError::EntityStateMap("ENTITY_GROUP_COUNT_MISSING".into())
            })?;
            let allow_checkpoint = *remaining == 1;
            *remaining = remaining
                .checked_sub(1)
                .ok_or(RuntimeMachineError::InputCountOverflow)?;
            let applied = apply_entity_group(
                slot,
                group,
                next_height,
                &mut frame.frame,
                replica.durable.j_replicas(),
                &replica.proposer_runtime_seed,
                replica.limits,
                allow_checkpoint,
                &mut materializer,
            )?;
            let entity_id_text = state_entity_id(&applied.state.entity);
            outputs.touches.entity_ids.push(entity_id_text.clone());
            outputs.touches.accounts.extend(applied.touched_accounts);
            if applied.book_touched {
                outputs.touches.book_entity_ids.push(entity_id_text);
            }
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
            outputs.entities.push(applied.outputs);
            if staged
                .insert(
                    key,
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
        }
    }
    for key in entity_order {
        let slot = staged.remove(&key).ok_or_else(|| {
            RuntimeMachineError::EntityStateMap("FINAL_ENTITY_SLOT_MISSING".into())
        })?;
        replica.install_entity_slot(key, slot.state, slot.replica)?;
    }
    if !staged.is_empty() || remaining_groups.values().any(|count| *count != 0) {
        return Err(RuntimeMachineError::EntityStateMap(
            "ENTITY_SEGMENT_EXECUTION_INCOMPLETE".into(),
        ));
    }
    if let Some((key, contexts)) = frame
        .frame
        .entity_contexts
        .iter()
        .find(|(_, contexts)| !contexts.is_empty())
    {
        return Err(RuntimeMachineError::EntityContextMaterialization(format!(
            "ENTITY_REPLAY_CONTEXT_UNCONSUMED:{}:{}:{}",
            render_word(&key.entity_id),
            key.signer_id,
            contexts.len(),
        )));
    }
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
    })
}

#[allow(clippy::too_many_arguments)]
fn apply_entity_group(
    mut slot: EntityApplySlot,
    group: PendingEntityGroup,
    runtime_height: u64,
    frame: &mut RuntimeFrameContext,
    j_replicas: &serde_json::Value,
    proposer_runtime_seed: &str,
    limits: super::RuntimeLimits,
    allow_checkpoint: bool,
    materializer: &mut Option<&mut dyn EntityInfraMaterializer>,
) -> Result<AppliedEntityGroup, RuntimeMachineError> {
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
    slot.replica.entity_mempool.extend(group.pending);
    let mut synthetic_input = None;
    if let Some(scheduled) = group.wake.as_ref().and_then(|wake| wake.scheduled.as_ref()) {
        let (tx, canonical) = scheduled_wake_entity_input(group.entity_id, scheduled)?;
        slot.replica
            .entity_mempool
            .push_front(EntityPendingWork::Projected(tx));
        synthetic_input = Some(canonical);
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

    let j_prefix_pending_local_event = j_prefix_pending_local_event(
        &slot.replica.replica_metadata,
        slot.state.entity.last_finalized_j_height,
        slot.state.entity.j_history_finality.is_some(),
    )
    .map_err(|error| {
        RuntimeMachineError::ReplicaMetadata(format!("J_PREFIX_HISTORY_DECODE:{error}"))
    })?;
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
        prepared_j_range.as_ref().map(|prepared| &prepared.claim),
    )
    .map_err(EntityTransitionError::from)?;
    if j_prefix_pending_local_event
        && prepared_j_range.is_none()
        && fit_j_prefix_certificate.is_some()
    {
        return Err(RuntimeMachineError::ReplicaMetadata(
            "J_PREFIX_PENDING_RANGE_WITHOUT_OBSERVATION".into(),
        ));
    }

    enqueue_proposer_materializations(&mut slot, proposer_runtime_seed)?;

    let mut entity_mempool = std::mem::take(&mut slot.replica.entity_mempool);
    let (selected_count, context) = match materializer.as_deref_mut() {
        Some(materializer) => {
            let (count, materialized) = fit_live_entity_prefix(
                &mut slot,
                &entity_mempool,
                frame,
                materializer,
                fit_j_prefix_certificate.as_ref(),
            )?;
            (
                count,
                RuntimeEntityFrameContext {
                    execution: materialized.execution,
                    canonical: materialized.canonical,
                },
            )
        }
        None => {
            let context = frame
                .entity_contexts
                .get(&group_key)
                .and_then(|contexts| contexts.front())
                .ok_or_else(|| {
                    RuntimeMachineError::EntityContextMaterialization(format!(
                        "ENTITY_REPLAY_CONTEXT_MISSING:{}",
                        render_word(&group.entity_id)
                    ))
                })?;
            let count = fit_replay_entity_prefix(
                &slot,
                &entity_mempool,
                frame,
                &context.canonical,
                fit_j_prefix_certificate.as_ref(),
            )?;
            let context = frame
                .entity_contexts
                .get_mut(&group_key)
                .and_then(|contexts| contexts.pop_front())
                .ok_or_else(|| {
                    RuntimeMachineError::EntityContextMaterialization(
                        "ENTITY_REPLAY_CONTEXT_CONSUME".into(),
                    )
                })?;
            (count, context)
        }
    };
    let selected = take_entity_prefix(&slot, &mut entity_mempool, selected_count)?;
    let pending_count = entity_mempool.len();
    slot.replica.entity_mempool = entity_mempool;
    let mut rows = selected.rows;
    for (expected, row) in rows.iter_mut().enumerate() {
        row.operation_index =
            u64::try_from(expected).map_err(|_| RuntimeMachineError::InputCountOverflow)?;
        row.resolve_certified_boards(&slot.replica.certified_board_registry)?;
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
    let needs_local_account_genesis = selected.operations.iter().any(|operation| match operation {
        ResidentEntityOperation::Local(txs) => txs.iter().any(|admitted| {
            matches!(
                admitted.tx,
                xln_rscore_entity_kernel::LocalEntityTx::Financial(
                    xln_rscore_entity_kernel::LocalEntityFinancialTx::OpenAccount(_)
                )
            )
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
                        RuntimeMachineError::InboundGenesisPolicy("JURISDICTION_REQUIRED".into())
                    })?,
                j_replicas,
            )
        })
        .transpose()?;
    let checkpoint_due = allow_checkpoint
        && slot.replica.entity_mempool.is_empty()
        && super::materialization_due(
            runtime_height,
            slot.replica.last_materialized_height,
            limits.checkpoint_period_frames,
        );
    let finalized_j_events = group
        .j_observation
        .as_ref()
        .zip(prepared_j_range.as_ref())
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
    let request = ResidentEntityRequest {
        inbound: EntityInboundRequest {
            owner_entity_id: group.entity_id,
            expected_accounts_root: resident_root,
            clock: ReceiverClock {
                entity_timestamp: frame.timestamp,
                finalized_j_height: frame.finalized_j_height,
            },
            rows,
            post_accounts: false,
        },
        local_certified_board_authority: slot
            .replica
            .certified_board_registry
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
        expected_proposer_signer_id: group.signer_id.clone(),
        hub_rebalance_has_pending_work: frame.hub_rebalance_has_pending_work,
        finalized_j_events,
        entity_authority: Some(slot.replica.entity_consensus.state.authority.clone()),
        local_account_genesis_policy,
        operations: selected.operations,
    };
    let prior_orderbook_digest = slot
        .replica
        .entity_consensus
        .state
        .sections
        .iter()
        .find(|section| section.field == "orderbookExt")
        .map(|section| section.digest.clone());
    let mut core = apply_resident_entity_round_core(
        &mut slot.replica.accounts,
        slot.state.entity,
        request,
        &context.execution,
    )?;
    core.state.entity_command_nonces = selected.command_nonces;
    let account_commits = account_commit_evidence(group.entity_id, &core.inbound.applied);
    let accounts_root = core.outbound.accounts_root;
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
            j_prefix_certificate: fit_j_prefix_certificate,
            post_authority,
            secondary_hashes: std::mem::take(&mut core.secondary_hashes),
            presigned_manifest: std::mem::take(&mut core.presigned_manifest),
            account_outputs,
            routed_entity_outputs: std::mem::take(&mut core.routed_entity_outputs),
            non_mutating_wakes,
        },
    )?;
    slot.replica.entity_consensus = certified.consensus;
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
    slot.replica
        .accounts
        .admit_certified_settlement_hankos(certified_settlement_hankos)?;
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
    let checkpoint = checkpoint_due
        .then(|| slot.replica.accounts.export_checkpoint())
        .transpose()?;
    if checkpoint.is_some() {
        slot.replica.last_materialized_height = runtime_height;
    }
    let post_orderbook_digest = slot
        .replica
        .entity_consensus
        .state
        .sections
        .iter()
        .find(|section| section.field == "orderbookExt")
        .map(|section| section.digest.clone());
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
        entity_state_root: certified.state_root,
        entity_authority_root: certified.authority_root,
        checkpoint,
    };
    slot.state = RuntimeEntityState {
        accounts_root,
        entity: core.state,
    };
    Ok(AppliedEntityGroup {
        state: slot.state,
        replica: slot.replica,
        outputs,
        account_commits,
        touched_accounts,
        book_touched: prior_orderbook_digest != post_orderbook_digest,
        synthetic_input,
        selected_count,
        pending_count,
        post_commit_j_actions,
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
) -> Result<
    (
        Vec<crate::j_submit::DurableJAttempt>,
        Option<crate::j_watcher::ObserveJRange>,
    ),
    RuntimeMachineError,
> {
    let mut attempts = Vec::new();
    let mut observation = None;
    for tx in txs {
        match tx {
            super::RuntimeTx::RecordRuntimeAdapterCommand(value) => {
                apply_runtime_adapter_command_marker(replica, value, current_timestamp)?;
            }
            super::RuntimeTx::ImportJ(request) => {
                crate::j_import::apply_import_intent(&mut replica.durable, request)
                    .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
            }
            super::RuntimeTx::CompleteImportJ(result) => {
                crate::j_import::apply_import_result(
                    &mut replica.durable,
                    result,
                    current_timestamp,
                )
                .map_err(|error| RuntimeMachineError::ReplicaMetadata(error.to_string()))?;
            }
            super::RuntimeTx::ObserveJRange(value) => {
                if observation.is_some() {
                    return Err(RuntimeMachineError::ReplicaMetadata(
                        "J_HISTORY_MULTIPLE_OBSERVATIONS".into(),
                    ));
                }
                let (state, live) = replica
                    .entity_slot_mut(value.entity_id.as_bytes(), &value.signer_id)
                    .ok_or_else(|| {
                        RuntimeMachineError::ReplicaMetadata(
                            "J_HISTORY_LOCAL_REPLICA_MISSING".into(),
                        )
                    })?;
                record_j_observation(state, live, value)?;
                observation = Some(value.clone());
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
    Ok((attempts, observation))
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
) -> Result<(), RuntimeMachineError> {
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use xln_rscore_batch::{AccountInputResult, AccountInputVerdict};
    use xln_rscore_engine::{
        AccountDomain, AccountFrame, CommittedFrameEvidence, DepositoryAddress, EntityId,
        JEventMetadata, JurisdictionEvent, ReserveUpdatedEvent,
    };
    use xln_rscore_entity_kernel::{CanonicalEntityTx, EntityTxKind};
    use xln_rscore_protocol::CanonicalValue;

    use crate::{
        FinalizedJEventBatch, FinalizedJHeader, ObserveJRange, RuntimeEntityFrameContext,
        RuntimeEntityInput, RuntimeInput, RuntimeTx,
    };

    use super::{
        AccountCommitSource, AccountId, EntityApplySlot, EntityPendingWork, RuntimeFrameContext,
        account_commit_evidence, fit_replay_entity_prefix, prepare_entity_prefix,
        prepare_j_prefix_range, replay_compatible_prefix, take_entity_prefix,
    };

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
        let canonical_context = CanonicalValue::Object(Vec::new());
        let frame = RuntimeFrameContext {
            timestamp: 1,
            finalized_j_height: 0,
            hub_rebalance_has_pending_work: false,
            entity_contexts: std::collections::BTreeMap::from([(
                entity_key,
                std::collections::VecDeque::from([crate::RuntimeEntityFrameContext {
                    execution: xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
                    canonical: canonical_context.clone(),
                }]),
            )]),
        };
        let selected = fit_replay_entity_prefix(&slot, &work, &frame, &canonical_context, None)
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
                response: xln_rscore_batch::AccountResponseDirective::Preserve,
            }],
        );

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
    fn observe_j_range_commits_the_signed_j_event_through_runtime_replay() {
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
        let input = RuntimeInput {
            runtime_txs: vec![RuntimeTx::ObserveJRange(observation)],
            entity_inputs: Vec::new(),
            frame: RuntimeFrameContext {
                timestamp: 1_001,
                finalized_j_height: 36,
                hub_rebalance_has_pending_work: false,
                entity_contexts: std::collections::BTreeMap::from([(
                    key.clone(),
                    VecDeque::from([RuntimeEntityFrameContext {
                        execution: xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
                        canonical: CanonicalValue::Object(Vec::new()),
                    }]),
                )]),
            },
        };
        let result = super::apply_runtime(runtime, input).expect("J range Runtime replay");
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

        let next_hash = [0x66; 32];
        let next_event = JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
            metadata: JEventMetadata {
                block_number: Some(37),
                block_hash: Some(next_hash),
                transaction_hash: Some([0x77; 32]),
                log_index: Some(0),
                event_index: None,
            },
            entity: super::render_word(&entity_id),
            token_id: 1,
            new_balance: num_bigint::BigInt::from(11_u8),
        });
        let next_observation = ObserveJRange {
            entity_id: EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
            signer_id,
            jurisdiction_ref: format!("stack:31337:0x{}", "88".repeat(20)),
            scanned_through_height: 37,
            tip_block_hash: next_hash,
            headers: vec![FinalizedJHeader {
                j_height: 37,
                j_block_hash: next_hash,
            }],
            batches: vec![
                xln_rscore_entity_kernel::project_finalized_j_event_batch(
                    &EntityId::parse(&super::render_word(&entity_id)).expect("entity id"),
                    37,
                    next_hash,
                    vec![next_event],
                    Vec::new(),
                )
                .expect("projected J batch"),
            ],
        };
        let next = super::apply_runtime(
            result.replica,
            RuntimeInput {
                runtime_txs: vec![RuntimeTx::ObserveJRange(next_observation)],
                entity_inputs: Vec::new(),
                frame: RuntimeFrameContext {
                    timestamp: 1_002,
                    finalized_j_height: 37,
                    hub_rebalance_has_pending_work: false,
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
        .expect("second J range Runtime replay");
        let next_state = next.replica.state.e_replicas.get(&key).expect("next state");
        assert_eq!(next_state.entity.last_finalized_j_height, 37);
        let CanonicalValue::Object(finality) = next_state
            .entity
            .j_history_finality
            .as_ref()
            .expect("committed J finality")
        else {
            panic!("J finality object")
        };
        assert!(
            finality.iter().any(|(field, value)| {
                field == "finalizedThroughHeight" && value == &number(37)
            })
        );
    }
}
