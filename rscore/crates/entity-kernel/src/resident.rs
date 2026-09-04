//! Resident Entity+Account composition with no intermediate process calls.
//!
//! One call performs the canonical two Account visits: Account inputs enter the
//! resident Account shards, committed transactions feed the Entity paybook and
//! orderbook, and the resulting Account transactions leave through the same
//! shards as signed proposals. The parent supplies its previous Account root
//! on the next call; that root implicitly accepts or discards the prior
//! candidate, so this API has no commit/abort messages.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;
use std::time::Instant;

use thiserror::Error;
use xln_rscore_batch::{
    AccountId, AccountInputVerdict, BatchAccountSelection, BatchError, EntityInboundRequest,
    EntityOutboundRequest, EntityRoundResult, FailedHtlcFollowup, PreparedEntityOutbound,
    ProposalRow, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountTx, CommittedFrameEvidence, Disposition, EntityId, HtlcResolveOutcome, HtlcResolveTx,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, SlotOutcome, SlotWork};

use crate::commitment::compute_commitments;
use crate::j_events::apply_finalized_j_event_batches_in_frame;
use crate::kernel::{
    PreparedEntityBookStage, apply_entity_transitions, finish_orderbook_stage,
    prepare_orderbook_stage,
};
use crate::local_financial::LocalAccountFinancialView;
use crate::orderbook::{OrderbookPairJob, OrderbookPairResult};
use crate::paybook::{PaybookChanges, paybook_entry, terminate_route, terminate_route_in_frame};
use crate::scheduler_runtime::validate_scheduled_wake;
use crate::unsafe_account_frame::{
    UnsafeAccountFrame, UnsafeAccountFrameDisposition, collect_unsafe_account_frames,
    consume_unsafe_account_frames, unsafe_account_view_requests,
};
use crate::{
    AccountProposalWork, CommittedAccountTransition, CrontabExecutionContext, DeterministicContext,
    EntityFrameEvent, EntityKernelCommitments, EntityKernelError, EntityKernelOutput,
    EntityStateSlice, FinalizedJEventBatch, HashToSign, HashType, JurisdictionScope,
    LocalEntityFinancialTx, OrderedAccountCommit, PresignedManifest, PresignedManifestEntry,
    ScheduledHookKind, ScheduledWake, SchedulerCommand, SchedulerError, execute_crontab,
};

fn profile_resident_round() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

fn report_resident_round_profile(
    phases: [u128; 11],
    total: u128,
    account_ranges: usize,
    local_operations: usize,
    failed_followups: usize,
    deferred_settlement_hankos: usize,
) {
    if !profile_resident_round() {
        return;
    }
    eprintln!(
        "RSCORE_ENTITY_PHASE inbound={} commits={} entityApply={} bookStage={} jIngress={} worklist={} proposable={} prepareOutbound={} failedRoutes={} outbound={} finalize={} total={} accountRanges={} localOperations={} failedFollowups={} deferredSettlementHankos={}",
        phases[0],
        phases[1],
        phases[2],
        phases[3],
        phases[4],
        phases[5],
        phases[6],
        phases[7],
        phases[8],
        phases[9],
        phases[10],
        total,
        account_ranges,
        local_operations,
        failed_followups,
        deferred_settlement_hankos,
    );
}

enum BookStageJob {
    Paybook {
        slot: usize,
        work: SlotWork<crate::PaybookEntry>,
        pending: Vec<crate::paybook::PendingPaybookMutation>,
    },
    Orderbook {
        position: usize,
        job: OrderbookPairJob,
    },
}

enum BookStageResult {
    Paybook {
        slot: usize,
        outcome: Result<SlotOutcome<crate::PaybookEntry>, EntityKernelError>,
    },
    Orderbook {
        position: usize,
        outcome: OrderbookPairResult,
    },
}

type PaybookSlotResults = [SlotOutcome<crate::PaybookEntry>; 256];
type PendingPaybookSlots = [Vec<crate::paybook::PendingPaybookMutation>; 256];

fn partition_paybook_pending(
    pending: Vec<crate::paybook::PendingPaybookMutation>,
) -> Result<PendingPaybookSlots, EntityKernelError> {
    let mut pending_slots: PendingPaybookSlots = std::array::from_fn(|_| Vec::new());
    for row in pending {
        let slot =
            usize::from(
                *row.0
                    .first()
                    .ok_or_else(|| EntityKernelError::CommitmentEncoding {
                        detail: "PAYBOOK_SHARD_KEY_EMPTY".into(),
                    })?,
            );
        pending_slots[slot].push(row);
    }
    Ok(pending_slots)
}

fn apply_paybook_slot(
    slot: usize,
    mut work: SlotWork<crate::PaybookEntry>,
    pending: Vec<crate::paybook::PendingPaybookMutation>,
) -> Result<SlotOutcome<crate::PaybookEntry>, EntityKernelError> {
    for row in pending {
        let mutation = crate::paybook::build_paybook_mutation(row)?;
        work.push_two_level_mutation(slot, mutation)
            .map_err(|error| EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?;
    }
    work.apply()
        .map_err(|error| EntityKernelError::CommitmentEncoding {
            detail: error.to_string(),
        })
}

fn dispatch_book_stage(
    accounts: &mut ResidentConsensusEngine,
    paybook_slots: Option<([SlotWork<crate::PaybookEntry>; 256], PendingPaybookSlots)>,
    orderbook_jobs: Vec<OrderbookPairJob>,
    context: &DeterministicContext,
) -> Result<(Option<PaybookSlotResults>, Vec<OrderbookPairResult>), ResidentEntityError> {
    let mut jobs = Vec::new();
    let mut paybook_outcomes = paybook_slots.map(|(slots, pending_slots)| {
        let mut outcomes = (0..slots.len())
            .map(|_| None)
            .collect::<Vec<Option<Result<SlotOutcome<_>, EntityKernelError>>>>();
        for (slot, (work, pending)) in slots.into_iter().zip(pending_slots).enumerate() {
            if !pending.is_empty() {
                jobs.push(BookStageJob::Paybook {
                    slot,
                    work,
                    pending,
                });
            } else {
                outcomes[slot] =
                    Some(
                        work.apply()
                            .map_err(|error| EntityKernelError::CommitmentEncoding {
                                detail: error.to_string(),
                            }),
                    );
            }
        }
        outcomes
    });
    let orderbook_count = orderbook_jobs.len();
    jobs.extend(
        orderbook_jobs
            .into_iter()
            .enumerate()
            .map(|(position, job)| BookStageJob::Orderbook { position, job }),
    );
    let mut orderbook_outcomes = (0..orderbook_count)
        .map(|_| None)
        .collect::<Vec<Option<OrderbookPairResult>>>();
    if !jobs.is_empty() {
        for result in accounts.map_entity_stage_ordered(jobs, {
            let context = context.clone();
            move |job| match job {
                BookStageJob::Paybook {
                    slot,
                    work,
                    pending,
                } => BookStageResult::Paybook {
                    slot,
                    outcome: apply_paybook_slot(slot, work, pending),
                },
                BookStageJob::Orderbook { position, job } => BookStageResult::Orderbook {
                    position,
                    outcome: job.apply(&context),
                },
            }
        })? {
            match result {
                BookStageResult::Paybook { slot, outcome } => {
                    let outcomes = paybook_outcomes.as_mut().ok_or_else(|| {
                        EntityKernelError::CommitmentEncoding {
                            detail: "BOOK_STAGE_UNEXPECTED_PAYBOOK_RESULT".into(),
                        }
                    })?;
                    if slot >= outcomes.len() || outcomes[slot].replace(outcome).is_some() {
                        return Err(EntityKernelError::CommitmentEncoding {
                            detail: format!("BOOK_STAGE_PAYBOOK_SLOT_INVALID:{slot}"),
                        }
                        .into());
                    }
                }
                BookStageResult::Orderbook { position, outcome } => {
                    let slot = orderbook_outcomes.get_mut(position).ok_or_else(|| {
                        EntityKernelError::orderbook(format!(
                            "BOOK_STAGE_ORDERBOOK_SLOT_INVALID:{position}"
                        ))
                    })?;
                    if slot.replace(outcome).is_some() {
                        return Err(EntityKernelError::orderbook(format!(
                            "BOOK_STAGE_ORDERBOOK_SLOT_DUPLICATE:{position}"
                        ))
                        .into());
                    }
                }
            }
        }
    }
    let paybook_outcomes = paybook_outcomes
        .map(|outcomes| {
            let returned = outcomes.iter().filter(|outcome| outcome.is_some()).count();
            outcomes
                .into_iter()
                .map(|outcome| {
                    outcome
                        .ok_or(BatchError::ResidentWorkerResultCount {
                            expected: 256,
                            actual: returned,
                        })?
                        .map_err(ResidentEntityError::from)
                })
                .collect::<Result<Vec<_>, ResidentEntityError>>()?
                .try_into()
                .map_err(|outcomes: Vec<_>| BatchError::ResidentWorkerResultCount {
                    expected: 256,
                    actual: outcomes.len(),
                })
                .map_err(ResidentEntityError::from)
        })
        .transpose()?;
    let returned = orderbook_outcomes
        .iter()
        .filter(|outcome| outcome.is_some())
        .count();
    let orderbook_outcomes = orderbook_outcomes
        .into_iter()
        .map(|outcome| {
            outcome.ok_or_else(|| {
                EntityKernelError::orderbook(format!(
                    "BOOK_STAGE_ORDERBOOK_RESULT_COUNT:{returned}:{orderbook_count}"
                ))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((paybook_outcomes, orderbook_outcomes))
}

fn commit_book_stage(
    accounts: &mut ResidentConsensusEngine,
    kernel: &mut crate::kernel::EntityTransitionResult,
    changes: PaybookChanges,
    mut prepared: PreparedEntityBookStage,
    context: &DeterministicContext,
    scheduled_commands: &[SchedulerCommand],
) -> Result<(), ResidentEntityError> {
    let pending = changes.into_pending();
    let paybook_slots = if pending.is_empty() {
        None
    } else {
        let slots = kernel
            .state
            .paybook
            .entries
            .prepare_two_level_slots()
            .map_err(|error| EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?;
        let pending_slots = partition_paybook_pending(pending)?;
        Some((slots, pending_slots))
    };
    let (paybook_results, orderbook_results) = dispatch_book_stage(
        accounts,
        paybook_slots,
        prepared.take_orderbook_jobs(),
        context,
    )?;
    let updated = match paybook_results {
        Some(results) => kernel
            .state
            .paybook
            .entries
            .reconnect_two_level_slots(results.map(Ok))
            .map_err(|error| EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?,
        None => kernel.state.paybook.entries.clone(),
    };
    finish_orderbook_stage(kernel, prepared, orderbook_results, scheduled_commands)?;
    kernel.state.paybook.entries = updated;
    Ok(())
}

#[derive(Debug, Error)]
pub enum ResidentEntityError {
    #[error(transparent)]
    Account(#[from] BatchError),
    #[error(transparent)]
    Output(#[from] crate::EntityOutputError),
    #[error(transparent)]
    Entity(#[from] EntityKernelError),
    #[error(transparent)]
    CrossJOpening(#[from] crate::CrossJOpeningSelectionError),
    #[error("ENTITY_RESIDENT_OWNER_MISMATCH:state={state}:request={request}")]
    OwnerMismatch { state: String, request: String },
    #[error("ENTITY_RESIDENT_ACCOUNT_ID_INVALID:{value}")]
    InvalidAccountId { value: String },
    #[error("ENTITY_RESIDENT_CROSS_J_LOCAL_ACCOUNT_VIEW_MISSING:{account_id}")]
    CrossJLocalAccountViewMissing { account_id: String },
    #[error("ENTITY_RESIDENT_FRAME_HASH:{detail}")]
    FrameHash { detail: String },
    #[error("ENTITY_RESIDENT_FRAME_HASH_MISMATCH:account={account_id}:height={height}")]
    FrameHashMismatch { account_id: String, height: u64 },
    #[error("FRAME_CONSENSUS_FAILED:ACCOUNT_INPUT_INPUT_REJECTED:account={account_id}:{reason}")]
    InboundFrameRejected { account_id: String, reason: String },
    #[error(
        "ENTITY_RESIDENT_OUTPUT_BINDING:account={account_id}:height={height}:txs={txs}:rows={rows}"
    )]
    OutputBinding {
        account_id: String,
        height: u64,
        txs: usize,
        rows: usize,
    },
    #[error("ENTITY_RESIDENT_CRONTAB_MISSING")]
    CrontabMissing,
    #[error("ENTITY_RESIDENT_MANIFEST_WITNESS_DUPLICATE:{0}")]
    ManifestWitnessDuplicate(String),
    #[error("ENTITY_RESIDENT_OPERATION_PLAN:{0}")]
    OperationPlan(String),
    #[error(transparent)]
    Scheduler(#[from] SchedulerError),
}

fn rejected_inbound_frame_reason(verdict: &AccountInputVerdict) -> Option<&str> {
    match verdict {
        AccountInputVerdict::FrameRejected { reason } => Some(reason),
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            rejected_inbound_frame_reason(ack).or_else(|| rejected_inbound_frame_reason(frame))
        }
        _ => None,
    }
}

fn reject_failed_inbound_frames(
    rows: &[xln_rscore_batch::AccountInputResult],
) -> Result<(), ResidentEntityError> {
    for row in rows {
        if let Some(reason) = rejected_inbound_frame_reason(&row.verdict) {
            return Err(ResidentEntityError::InboundFrameRejected {
                account_id: account_text(row.account_id),
                reason: reason.to_owned(),
            });
        }
    }
    Ok(())
}

/// Runtime-owned facts that surround one Entity transition. Account state is
/// deliberately absent: replicas and their Patricia nodes already reside in
/// `ResidentConsensusEngine`.
#[derive(Clone, Debug)]
pub enum ResidentEntityOperation {
    /// One contiguous WAL-ordered run of AccountInput transactions. All rows
    /// in the run enter the shard workers together, then their returned
    /// effects fold before the next operation.
    AccountRange { start: usize, len: usize },
    /// One authenticated Entity command expanded to its native transactions.
    /// The wrapper remains one Entity-frame tx; these children execute at that
    /// exact positional point.
    Local(Vec<crate::AdmittedLocalEntityTx>),
}

fn validate_operation_plan(
    operations: &[ResidentEntityOperation],
    row_count: usize,
) -> Result<(), ResidentEntityError> {
    let mut next_row = 0_usize;
    for operation in operations {
        match operation {
            ResidentEntityOperation::AccountRange { start, len } => {
                if *start != next_row || *len == 0 {
                    return Err(ResidentEntityError::OperationPlan(format!(
                        "ACCOUNT_RANGE:{start}:{len}:EXPECTED:{next_row}"
                    )));
                }
                next_row = start.checked_add(*len).ok_or_else(|| {
                    ResidentEntityError::OperationPlan("ACCOUNT_RANGE_OVERFLOW".into())
                })?;
                if next_row > row_count {
                    return Err(ResidentEntityError::OperationPlan(format!(
                        "ACCOUNT_RANGE_END:{next_row}:ROWS:{row_count}"
                    )));
                }
            }
            ResidentEntityOperation::Local(_) => {}
        }
    }
    if next_row != row_count {
        return Err(ResidentEntityError::OperationPlan(format!(
            "ACCOUNT_ROWS_UNCOVERED:{next_row}:{row_count}"
        )));
    }
    Ok(())
}

pub struct ResidentEntityRequest {
    pub inbound: EntityInboundRequest,
    /// Parent-registry authority for this local Entity's current board.
    pub local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority,
    pub entity_height: u64,
    pub outbound_timestamp: u64,
    pub outbound_j_height: u64,
    pub checkpoint_due: bool,
    pub post_accounts: bool,
    /// Transient operator seed used only by the default proposer to derive
    /// public cross-J ladder witnesses. It is never committed or checkpointed.
    pub runtime_seed: Option<String>,
    pub scheduled_wake: Option<ScheduledWake>,
    pub expected_proposer_signer_id: String,
    /// One receipt-root-authenticated J prefix selected by Runtime priority.
    /// Runtime must place it in an Entity-only frame; this layer merges the
    /// resulting Account claims into the existing single outbound visit.
    pub finalized_j_events: Option<ResidentJEventProjection>,
    /// Current certified Entity authority. Required by governance txs and
    /// rejected loudly when absent from a proposal/vote frame.
    pub entity_authority: Option<crate::EntityFrameAuthority>,
    /// Runtime-derived owner policy for locally-created H=0 Accounts. Peer
    /// bytes never choose this value.
    pub local_account_genesis_policy: Option<xln_rscore_batch::EntityAccountGenesisPolicy>,
    /// Runtime-projected live sibling Account envelopes used only to choose
    /// the next atomic cross-J opening cohort. Never committed or persisted.
    pub cross_j_opening_sibling_views: Vec<crate::CrossJOpeningSiblingEntityView>,
    /// Exact positional execution plan over `inbound.rows` and authenticated
    /// local commands. It is transient and never enters committed state.
    pub operations: Vec<ResidentEntityOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentJEventProjection {
    pub scanned_through: u64,
    pub batches: Vec<FinalizedJEventBatch>,
    pub runtime_seed: String,
    pub claim: crate::JPrefixRangeClaim,
    pub proposer_signer_id: String,
    pub proposer_signature: String,
}

fn merge_proposal_work(target: &mut Vec<AccountProposalWork>, appended: Vec<AccountProposalWork>) {
    let mut positions = target
        .iter()
        .enumerate()
        .map(|(index, work)| (work.account_id.clone(), index))
        .collect::<BTreeMap<_, _>>();
    for work in appended {
        if let Some(index) = positions.get(&work.account_id).copied() {
            target[index].txs.extend(work.txs);
            continue;
        }
        positions.insert(work.account_id.clone(), target.len());
        target.push(work);
    }
}

fn j_word(value: &str, field: &'static str) -> Result<[u8; 32], EntityKernelError> {
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() == 64)
        .ok_or_else(|| EntityKernelError::JEventInvalid {
            detail: format!("J_FINALITY_{field}"),
        })?;
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).map_err(|_| {
            EntityKernelError::JEventInvalid {
                detail: format!("J_FINALITY_{field}"),
            }
        })?;
    }
    Ok(bytes)
}

fn j_number(value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| EntityKernelError::JEventInvalid {
            detail: "J_FINALITY_NUMBER".into(),
        })
}

fn commit_j_range_finality(
    state: &mut EntityStateSlice,
    authority: Option<&crate::EntityFrameAuthority>,
    entity_height: u64,
    projection: &ResidentJEventProjection,
) -> Result<(), EntityKernelError> {
    let claim = &projection.claim;
    if claim.scanned_through_height != projection.scanned_through
        || state.last_finalized_j_height != projection.scanned_through
    {
        return Err(EntityKernelError::JEventInvalid {
            detail: "J_FINALITY_HEIGHT_BINDING".into(),
        });
    }
    let jurisdiction = authority
        .and_then(|authority| authority.config.jurisdiction.as_ref())
        .ok_or_else(|| EntityKernelError::JEventInvalid {
            detail: "CERTIFIED_BOARD_ENTITY_JURISDICTION_MISSING".into(),
        })?;
    let stack_key = crate::certified_board_stack_key(jurisdiction)?;
    let tip = j_word(&claim.tip_block_hash, "TIP")?;
    let history_root = j_word(&claim.event_history_root, "ROOT")?;
    let registry = state
        .certified_board_state
        .get_or_insert_with(|| crate::CertifiedBoardState::empty(stack_key));
    if registry.stack_key != stack_key {
        return Err(EntityKernelError::JEventInvalid {
            detail: "CERTIFIED_BOARD_STACK_MISMATCH".into(),
        });
    }
    registry.advance_finality(projection.scanned_through, tip, history_root)?;
    state.j_history_finality = Some(CanonicalValue::Object(vec![
        (
            "jurisdictionRef".into(),
            CanonicalValue::String(claim.jurisdiction_ref.clone()),
        ),
        ("baseHeight".into(), j_number(claim.base_height)?),
        (
            "finalizedThroughHeight".into(),
            j_number(claim.scanned_through_height)?,
        ),
        (
            "tipBlockHash".into(),
            CanonicalValue::String(claim.tip_block_hash.clone()),
        ),
        (
            "eventHistoryRoot".into(),
            CanonicalValue::String(claim.event_history_root.clone()),
        ),
        (
            "proposerSignerId".into(),
            CanonicalValue::String(projection.proposer_signer_id.clone()),
        ),
        (
            "proposerSignature".into(),
            CanonicalValue::String(projection.proposer_signature.clone()),
        ),
        ("entityHeight".into(), j_number(entity_height)?),
    ]));
    Ok(())
}

/// Exact result of the fused Entity+Account transition. `inbound` and
/// `outbound` remain separate evidence so parity diagnostics can identify the
/// phase without adding another execution path.
pub struct ResidentEntityResult {
    pub state: EntityStateSlice,
    pub outputs: Vec<EntityKernelOutput>,
    pub entity_frame_events: Vec<EntityFrameEvent>,
    pub secondary_hashes: Vec<HashToSign>,
    pub commitments: EntityKernelCommitments,
    pub inbound: EntityRoundResult,
    pub outbound: EntityRoundResult,
    pub non_mutating_wake_targets: Vec<String>,
    pub routed_entity_outputs: Vec<crate::LocalEntityOutput>,
    pub j_outputs: Vec<crate::EntityJOutput>,
}

/// Production result before canonical Entity commitments are materialized.
/// The authoritative RRS path computes those sections directly from this
/// state; replay may additionally inspect the same roots as diagnostics.
pub struct ResidentEntityCoreResult {
    pub state: EntityStateSlice,
    pub outputs: Vec<EntityKernelOutput>,
    /// Exact Account status rows in Entity execution order. These are signed
    /// Entity-frame bytes, not operational logs that Runtime may reword.
    pub entity_frame_events: Vec<EntityFrameEvent>,
    /// Exact Account-frame/dispute manifest entries the Entity signer must
    /// certify alongside its own frame.
    pub secondary_hashes: Vec<HashToSign>,
    /// Account workers already signed Account-frame entries while updating
    /// their resident replicas. Entity certification consumes these exact
    /// bytes instead of serially signing every digest again.
    pub presigned_manifest: PresignedManifest,
    pub inbound: EntityRoundResult,
    pub outbound: EntityRoundResult,
    /// Exact TS empty self EntityInputs emitted by local direct/swap handlers.
    /// They are non-mutating and unsigned, but their outbox slots are real.
    pub non_mutating_wake_targets: Vec<String>,
    /// Cross-j EntityInputs already authorized by the Entity transition.
    pub routed_entity_outputs: Vec<crate::LocalEntityOutput>,
    pub j_outputs: Vec<crate::EntityJOutput>,
    /// Account leaves in canonical TS `storageChanges` first-touch order.
    /// Worker completion order is deliberately excluded: execution may run in
    /// parallel, while the Runtime frame hash commits deterministic input and
    /// Entity-transition order.
    pub account_touch_order: Vec<AccountId>,
    pub pending_settlement_hankos: Vec<xln_rscore_batch::PendingSettlementHankoDraft>,
    proposal_work: Vec<crate::AccountProposalWork>,
}

impl ResidentEntityCoreResult {
    pub fn with_canonical_commitments(self) -> Result<ResidentEntityResult, ResidentEntityError> {
        let commitments = compute_commitments(&self.state, &self.proposal_work, &self.outputs)?;
        Ok(ResidentEntityResult {
            state: self.state,
            outputs: self.outputs,
            entity_frame_events: self.entity_frame_events,
            secondary_hashes: self.secondary_hashes,
            commitments,
            inbound: self.inbound,
            outbound: self.outbound,
            non_mutating_wake_targets: self.non_mutating_wake_targets,
            routed_entity_outputs: self.routed_entity_outputs,
            j_outputs: self.j_outputs,
        })
    }
}

fn hex_prefixed(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn account_text(account_id: AccountId) -> String {
    hex_prefixed(account_id.as_bytes())
}

fn account_id(value: &str) -> Result<AccountId, ResidentEntityError> {
    EntityId::parse(value)
        .map(|entity| AccountId::from_bytes(*entity.as_bytes()))
        .map_err(|_| ResidentEntityError::InvalidAccountId {
            value: value.to_string(),
        })
}

fn forced_ack_accounts(applied: &[xln_rscore_batch::AccountInputResult]) -> Vec<AccountId> {
    let mut forced = Vec::<Option<AccountId>>::new();
    let mut positions = HashMap::<AccountId, usize>::new();
    for result in applied {
        match result.force_ack {
            None => {}
            Some(false) => {
                if let Some(position) = positions.remove(&result.account_id) {
                    forced[position] = None;
                }
            }
            Some(true) => {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    positions.entry(result.account_id)
                {
                    entry.insert(forced.len());
                    forced.push(Some(result.account_id));
                }
            }
        }
    }
    forced.into_iter().flatten().collect()
}

type AccountProposalRow = (AccountId, Vec<AccountTx>, bool);
type SelectedAccountProposalRow = (AccountId, Vec<AccountTx>, BatchAccountSelection, bool);

fn cross_j_setup_kind(kind: crate::EntityTxKind) -> bool {
    matches!(
        kind,
        crate::EntityTxKind::MaterializeCrossJurisdictionSwap
            | crate::EntityTxKind::MaterializeCrossJurisdictionClear
            | crate::EntityTxKind::RegisterCrossJurisdictionSwap
    )
}

fn local_tx_contains_cross_j_setup(tx: &crate::LocalEntityTx) -> bool {
    match tx {
        crate::LocalEntityTx::CrossJurisdiction(tx) => cross_j_setup_kind(tx.kind),
        crate::LocalEntityTx::RuntimeOutput(output) => output
            .entity_txs
            .iter()
            .any(|tx| cross_j_setup_kind(tx.kind)),
        crate::LocalEntityTx::Financial(_) | crate::LocalEntityTx::Control(_) => false,
    }
}

fn frame_contains_cross_j_setup(operations: &[ResidentEntityOperation]) -> bool {
    operations.iter().any(|operation| match operation {
        ResidentEntityOperation::Local(txs) => {
            txs.iter().any(|tx| local_tx_contains_cross_j_setup(&tx.tx))
        }
        ResidentEntityOperation::AccountRange { .. } => false,
    })
}

fn suppress_setup_frame_proposals(
    rows: Vec<AccountProposalRow>,
) -> Vec<SelectedAccountProposalRow> {
    rows.into_iter()
        .map(|(account, admissions, force)| {
            (
                account,
                admissions,
                BatchAccountSelection::WaitForSibling,
                force,
            )
        })
        .collect()
}

fn take_local_opening_mempool(
    mempools: &mut HashMap<AccountId, Vec<AccountTx>>,
    account: AccountId,
    created_accounts: &BTreeSet<AccountId>,
) -> Result<Vec<AccountTx>, ResidentEntityError> {
    match mempools.remove(&account) {
        Some(mempool) => Ok(mempool),
        None if created_accounts.contains(&account) => Ok(Vec::new()),
        None => Err(ResidentEntityError::CrossJLocalAccountViewMissing {
            account_id: account_text(account),
        }),
    }
}

fn select_cross_j_proposal_work(
    accounts: &mut ResidentConsensusEngine,
    local_entity_id: &str,
    rows: Vec<AccountProposalRow>,
    created_accounts: &BTreeSet<AccountId>,
    siblings: &[crate::CrossJOpeningSiblingEntityView],
    setup_barrier: bool,
) -> Result<Vec<SelectedAccountProposalRow>, ResidentEntityError> {
    if setup_barrier {
        return Ok(suppress_setup_frame_proposals(rows));
    }
    let existing_accounts = rows
        .iter()
        .map(|(account, _, _)| *account)
        .filter(|account| !created_accounts.contains(account))
        .collect();
    let mut local_mempools = accounts
        .cross_j_opening_account_views(existing_accounts)?
        .into_iter()
        .map(|view| Ok((account_id(&view.counterparty_entity_id)?, view.mempool)))
        .collect::<Result<HashMap<_, _>, ResidentEntityError>>()?;
    rows.into_iter()
        .map(|(account, admissions, force)| {
            let mut mempool =
                take_local_opening_mempool(&mut local_mempools, account, created_accounts)?;
            mempool.extend(admissions.iter().cloned());
            let selection = match crate::select_cross_j_opening_proposal(
                local_entity_id,
                &account_text(account),
                &mempool,
                siblings,
            )? {
                crate::CrossJOpeningProposalSelection::Ordinary => {
                    BatchAccountSelection::WholeMempool
                }
                crate::CrossJOpeningProposalSelection::Wait => {
                    BatchAccountSelection::WaitForSibling
                }
                crate::CrossJOpeningProposalSelection::Selected(txs) => {
                    BatchAccountSelection::Selected(txs)
                }
            };
            Ok((account, admissions, selection, force))
        })
        .collect()
}

fn order_proposal_work_by_first_touch(
    rows: Vec<AccountProposalRow>,
    initially_proposable: &[AccountId],
    touch_order: &[AccountId],
) -> Result<Vec<AccountProposalRow>, ResidentEntityError> {
    let mut positions = HashMap::<AccountId, usize>::with_capacity(rows.len());
    for (index, (account_id, _, _)) in rows.iter().enumerate() {
        if positions.insert(*account_id, index).is_some() {
            return Err(ResidentEntityError::OperationPlan(format!(
                "DUPLICATE_ACCOUNT_PROPOSAL_WORK:{}",
                account_text(*account_id),
            )));
        }
    }
    let mut slots = rows.into_iter().map(Some).collect::<Vec<_>>();
    let mut ordered = Vec::with_capacity(slots.len());
    for account_id in initially_proposable.iter().chain(touch_order) {
        let Some(position) = positions.get(account_id).copied() else {
            continue;
        };
        if let Some(row) = slots[position].take() {
            ordered.push(row);
        }
    }
    // Accounts first discovered by a post-input stage retain the order in
    // which that stage admitted them. Account ids are lookup keys only and
    // never choose a new publication position.
    ordered.extend(slots.into_iter().flatten());
    Ok(ordered)
}

/// TS records an inbound commit's local effects (HTLC forwards, resolves)
/// inside that EntityTx's `storageChanges`, so a forward target is first
/// touched right after the input that produced it — not after every input of
/// the frame. Move each origin-bearing candidate to that position; anything
/// without an inbound origin keeps its stage order.
fn interleave_first_touch(
    candidates: Vec<AccountId>,
    inbound_count: usize,
    proposal_origins: &[(String, usize)],
) -> Result<Vec<AccountId>, ResidentEntityError> {
    let mut by_origin = BTreeMap::<usize, Vec<AccountId>>::new();
    let mut placed = BTreeSet::<AccountId>::new();
    for (account, position) in proposal_origins {
        let account = account_id(account)?;
        if placed.insert(account) {
            by_origin.entry(*position).or_default().push(account);
        }
    }
    let mut ordered = Vec::with_capacity(candidates.len());
    let (inbound, rest) = candidates.split_at(inbound_count.min(candidates.len()));
    for (position, account) in inbound.iter().enumerate() {
        ordered.push(*account);
        if let Some(targets) = by_origin.remove(&position) {
            ordered.extend(targets);
        }
    }
    ordered.extend(by_origin.into_values().flatten());
    ordered.extend(rest.iter().copied());
    Ok(ordered)
}

fn canonical_account_touch_order(
    candidates: impl IntoIterator<Item = AccountId>,
    changed: &BTreeSet<AccountId>,
) -> Vec<AccountId> {
    let mut seen = BTreeSet::new();
    candidates
        .into_iter()
        .filter(|account_id| changed.contains(account_id))
        .filter(|account_id| seen.insert(*account_id))
        .collect()
}

fn canonical_entity_tx_account_changes(
    account_ids: impl IntoIterator<Item = AccountId>,
) -> Vec<AccountId> {
    let mut account_ids = account_ids.into_iter().collect::<Vec<_>>();
    // TS emits one EntityTx's `accountChanges` as a sorted unique vector
    // before appending it to frame storage changes. Event arrival order may
    // choose transition order, but it must not choose this frame-hash field.
    account_ids.sort();
    account_ids.dedup();
    account_ids
}

fn proposal_records_account_change(row: &ProposalRow) -> bool {
    row.proposed.is_some()
        || row
            .dropped
            .iter()
            .any(|dropped| dropped.disposition == Disposition::Removed)
}

fn local_financial_view_requests(
    state: &EntityStateSlice,
    txs: &[LocalEntityFinancialTx],
    commits: &[OrderedAccountCommit],
    context: &DeterministicContext,
) -> Result<
    Vec<(
        AccountId,
        xln_rscore_batch::ResidentAccountFinancialViewRequest,
    )>,
    ResidentEntityError,
> {
    #[derive(Default)]
    struct RequestedView {
        token_ids: BTreeSet<xln_rscore_engine::TokenId>,
        htlc_lock_ids: BTreeSet<String>,
        pull_ids: BTreeSet<String>,
        swap_offer_ids: BTreeSet<String>,
        dispute: bool,
    }
    let mut requested = BTreeMap::<AccountId, RequestedView>::new();
    for tx in txs {
        match tx {
            LocalEntityFinancialTx::CrossJurisdictionForceSiblingDispute(tx) => {
                let counterparty = crate::cross_j::force_sibling_dispute_counterparty(
                    state,
                    &tx.route_id,
                    &tx.observed_counterparty_entity_id,
                )?;
                requested
                    .entry(account_id(&counterparty)?)
                    .or_default()
                    .dispute = true;
            }
            LocalEntityFinancialTx::HtlcPayment(tx) => {
                let Some(prepared) = context.originated_htlcs.get(&tx.tx_hash) else {
                    continue;
                };
                if state.known_accounts.contains(&prepared.next_hop_entity_id) {
                    requested
                        .entry(account_id(&prepared.next_hop_entity_id)?)
                        .or_default()
                        .token_ids
                        .insert(tx.token_id);
                }
            }
            LocalEntityFinancialTx::LendingOffer(tx) => {
                if state.known_accounts.contains(&tx.hub_entity_id) {
                    requested
                        .entry(account_id(&tx.hub_entity_id)?)
                        .or_default()
                        .token_ids
                        .insert(tx.token_id);
                }
            }
            LocalEntityFinancialTx::QuoteBackedR2c(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default()
                    .token_ids
                    .insert(tx.token_id);
            }
            LocalEntityFinancialTx::PrepareDispute(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default()
                    .dispute = true;
            }
            LocalEntityFinancialTx::DisputeStart(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default()
                    .dispute = true;
            }
            LocalEntityFinancialTx::DisputeFinalize(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default()
                    .dispute = true;
            }
            LocalEntityFinancialTx::ResolveHtlcLock(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default()
                    .htlc_lock_ids
                    .insert(tx.lock_id.clone());
            }
            LocalEntityFinancialTx::SettleApprove(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default();
            }
            LocalEntityFinancialTx::SettleExecute(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default();
            }
            LocalEntityFinancialTx::SettlePropose(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default();
            }
            LocalEntityFinancialTx::SettleReject(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default();
            }
            LocalEntityFinancialTx::SettleUpdate(tx) => {
                requested
                    .entry(account_id(&tx.counterparty_entity_id)?)
                    .or_default();
            }
            _ => {}
        }
    }
    for commit in commits {
        for transition in &commit.transitions {
            if matches!(transition.tx, AccountTx::SettleTransition { .. }) {
                requested
                    .entry(account_id(&commit.account_id)?)
                    .or_default();
                continue;
            }
            let token = match &transition.tx {
                AccountTx::LendingBorrowRequest { token_id, .. } => u32::try_from(*token_id)
                    .ok()
                    .and_then(|value| xln_rscore_engine::TokenId::new(value).ok()),
                AccountTx::LendingRepay { token_id, .. } => Some(*token_id),
                AccountTx::LendingCloseRequest { position_id, .. } => state
                    .lending
                    .as_ref()
                    .and_then(|lending| lending.pool(position_id))
                    .and_then(|pool| {
                        xln_rscore_engine::TokenId::new(u32::from(pool.token_id)).ok()
                    }),
                _ => continue,
            };
            let entry = &mut requested
                .entry(account_id(&commit.account_id)?)
                .or_default()
                .token_ids;
            if let Some(token) = token {
                entry.insert(token);
            }
        }
    }
    Ok(requested
        .into_iter()
        .map(|(account_id, request)| {
            (
                account_id,
                xln_rscore_batch::ResidentAccountFinancialViewRequest {
                    token_ids: request.token_ids.into_iter().collect(),
                    htlc_lock_ids: request.htlc_lock_ids.into_iter().collect(),
                    pull_ids: request.pull_ids.into_iter().collect(),
                    swap_offer_ids: request.swap_offer_ids.into_iter().collect(),
                    dispute: request.dispute,
                },
            )
        })
        .collect())
}

fn validate_effect_binding(
    account_id: &str,
    state_hash: &[u8; 32],
    evidence: &CommittedFrameEvidence,
) -> Result<(), ResidentEntityError> {
    if evidence.frame.txs.len() != evidence.outputs_by_tx.len() {
        return Err(ResidentEntityError::OutputBinding {
            account_id: account_id.to_string(),
            height: evidence.frame.height,
            txs: evidence.frame.txs.len(),
            rows: evidence.outputs_by_tx.len(),
        });
    }
    if &evidence.state_hash != state_hash {
        return Err(ResidentEntityError::FrameHashMismatch {
            account_id: account_id.to_string(),
            height: evidence.frame.height,
        });
    }
    Ok(())
}

fn ordered_commit(
    account_id: AccountId,
    state_hash: &[u8; 32],
    evidence: &mut CommittedFrameEvidence,
    inbound_position: usize,
) -> Result<OrderedAccountCommit, ResidentEntityError> {
    let account_id = account_text(account_id);
    validate_effect_binding(&account_id, state_hash, evidence)?;
    let transitions = std::mem::take(&mut evidence.frame.txs)
        .into_iter()
        .zip(std::mem::take(&mut evidence.outputs_by_tx))
        .map(|(tx, outputs)| CommittedAccountTransition { tx, outputs })
        .collect();
    Ok(OrderedAccountCommit {
        account_id,
        domain: evidence.domain.clone(),
        // This kernel is deliberately the same-j profile. Cross-j accounts
        // are not imported into its known-account set and fail loudly rather
        // than entering a compatibility bridge.
        scope: JurisdictionScope::Same,
        committed_via_new_frame: evidence.committed_via_new_frame,
        frame_state_hash: hex_prefixed(state_hash),
        inbound_position,
        frame_height: evidence.frame.height,
        frame_timestamp: evidence.frame.timestamp,
        transitions,
    })
}

fn collect_verdict_commits(
    account_id: AccountId,
    verdict: &mut AccountInputVerdict,
    commits: &mut Vec<OrderedAccountCommit>,
    inbound_position: usize,
) -> Result<(), ResidentEntityError> {
    match verdict {
        AccountInputVerdict::FrameCommitted {
            state_hash,
            committed_frame,
            ..
        }
        | AccountInputVerdict::AckCommitted {
            state_hash,
            committed_frame,
            ..
        } => commits.push(ordered_commit(
            account_id,
            state_hash,
            committed_frame,
            inbound_position,
        )?),
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            // TS applies the ACK half before the peer-frame half.
            collect_verdict_commits(account_id, ack, commits, inbound_position)?;
            collect_verdict_commits(account_id, frame, commits, inbound_position)?;
        }
        _ => {}
    }
    Ok(())
}

fn account_hash_context(account_id: AccountId, phase: &str, height: u64) -> String {
    let account = account_text(account_id);
    let suffix = account
        .get(account.len().saturating_sub(8)..)
        .unwrap_or(&account);
    format!("account:{suffix}:{phase}:{height}")
}

fn dispute_hash_context(account_id: AccountId, phase: &str) -> String {
    let account = account_text(account_id);
    let suffix = account
        .get(account.len().saturating_sub(8)..)
        .unwrap_or(&account);
    format!("account:{suffix}:{phase}")
}

fn append_status_events(target: &mut Vec<EntityFrameEvent>, events: &[String]) {
    target.extend(
        events
            .iter()
            .cloned()
            .map(|message| EntityFrameEvent::Status { message }),
    );
}

fn append_rollback_events(
    target: &mut Vec<EntityFrameEvent>,
    accepted_height: u64,
    rolled_back: Option<xln_rscore_engine::RolledBackProposal>,
) {
    let Some(rolled_back) = rolled_back else {
        return;
    };
    target.push(EntityFrameEvent::Status {
        message: format!(
            "🔄 ROLLBACK: Discarded our frame {}, restored {}/{} txs to mempool",
            rolled_back.height, rolled_back.restored, rolled_back.proposed,
        ),
    });
    target.push(EntityFrameEvent::Status {
        message: format!(
            "📥 Accepted LEFT's frame {accepted_height} (we are RIGHT, deterministic tiebreaker)"
        ),
    });
}

/// A LEFT-WINS collision whose "pending txs" count TS reports from the
/// Account mempool as it stands when that input is applied — including HTLC
/// forwards produced by earlier inputs of the same frame. Rust learns those
/// forwards only after the inbound phase, so the count is completed once the
/// Entity transition has run.
struct CollisionFixup {
    account_id: AccountId,
    position: usize,
    queued: usize,
}

const LEFT_WINS_PREFIX: &str = "📤 LEFT-WINS: Ignored RIGHT's frame ";
const LEFT_PENDING_PREFIX: &str = "⚠️ LEFT has ";

fn apply_collision_fixups(
    events: &mut Vec<EntityFrameEvent>,
    collisions: &[CollisionFixup],
    proposal_tx_origins: &[(String, usize)],
) -> Result<(), ResidentEntityError> {
    if collisions.is_empty() {
        return Ok(());
    }
    let mut origins_by_account = BTreeMap::<AccountId, Vec<usize>>::new();
    for (account, position) in proposal_tx_origins {
        origins_by_account
            .entry(account_id(account)?)
            .or_default()
            .push(*position);
    }
    let mut next_collision = 0;
    let mut index = 0;
    while index < events.len() {
        let is_left_wins = matches!(
            &events[index],
            EntityFrameEvent::Status { message } if message.starts_with(LEFT_WINS_PREFIX)
        );
        if is_left_wins {
            let Some(fixup) = collisions.get(next_collision) else {
                return Err(ResidentEntityError::OperationPlan(
                    "COLLISION_FIXUP_EVENT_WITHOUT_RECORD".into(),
                ));
            };
            next_collision += 1;
            let earlier_forwards = origins_by_account
                .get(&fixup.account_id)
                .map_or(0, |positions| {
                    positions.iter().filter(|p| **p < fixup.position).count()
                });
            let total = fixup.queued + earlier_forwards;
            let has_warning = matches!(
                events.get(index + 1),
                Some(EntityFrameEvent::Status { message }) if message.starts_with(LEFT_PENDING_PREFIX)
            );
            if total > 0 {
                let message = format!(
                    "{LEFT_PENDING_PREFIX}{total} pending txs while waiting for RIGHT's ACK"
                );
                if has_warning {
                    events[index + 1] = EntityFrameEvent::Status { message };
                } else {
                    events.insert(index + 1, EntityFrameEvent::Status { message });
                }
                index += 1;
            }
        }
        index += 1;
    }
    if next_collision != collisions.len() {
        return Err(ResidentEntityError::OperationPlan(
            "COLLISION_FIXUP_RECORD_WITHOUT_EVENT".into(),
        ));
    }
    Ok(())
}

fn append_collision_ignored_events(target: &mut Vec<EntityFrameEvent>, height: u64, queued: usize) {
    target.push(EntityFrameEvent::Status {
        message: format!("📤 LEFT-WINS: Ignored RIGHT's frame {height} (waiting for their ACK)"),
    });
    if queued > 0 {
        target.push(EntityFrameEvent::Status {
            message: format!("⚠️ LEFT has {queued} pending txs while waiting for RIGHT's ACK"),
        });
    }
}

fn collect_verdict_certification(
    account_id: AccountId,
    verdict: &AccountInputVerdict,
    events: &mut Vec<EntityFrameEvent>,
    hashes: &mut Vec<HashToSign>,
    presigned: &mut PresignedManifest,
    collisions: &mut Vec<CollisionFixup>,
    position: usize,
) -> Result<(), ResidentEntityError> {
    match verdict {
        AccountInputVerdict::FrameCollisionIgnored { height, queued } => {
            append_collision_ignored_events(events, *height, *queued);
            collisions.push(CollisionFixup {
                account_id,
                position,
                queued: *queued,
            });
        }
        AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            ack_signature,
            ack_hanko,
            ack_dispute_signature,
            ack_dispute_hanko,
            events: committed_events,
            rolled_back,
            ack_dispute,
            ..
        } => {
            append_rollback_events(events, *height, *rolled_back);
            append_status_events(events, committed_events);
            let counterparty = account_text(account_id);
            let suffix = counterparty
                .get(counterparty.len().saturating_sub(4)..)
                .unwrap_or(&counterparty);
            events.push(EntityFrameEvent::Status {
                message: format!("🤝 Accepted frame {height} from Entity {suffix}"),
            });
            let hash = hex_prefixed(state_hash);
            hashes.push(HashToSign {
                hash: hash.clone(),
                kind: HashType::AccountFrame,
                context: account_hash_context(account_id, "ack", *height),
            });
            if presigned
                .insert(
                    hash.clone(),
                    PresignedManifestEntry::account(*ack_signature, ack_hanko.clone()),
                )
                .is_some()
            {
                return Err(ResidentEntityError::ManifestWitnessDuplicate(hash));
            }
            if let Some(dispute) = ack_dispute.as_ref().filter(|draft| draft.hanko.is_none()) {
                let signature =
                    ack_dispute_signature.ok_or_else(|| ResidentEntityError::FrameHash {
                        detail: "ACCOUNT_ACK_DISPUTE_SIGNATURE_MISSING".into(),
                    })?;
                let hanko =
                    ack_dispute_hanko
                        .clone()
                        .ok_or_else(|| ResidentEntityError::FrameHash {
                            detail: "ACCOUNT_ACK_DISPUTE_HANKO_MISSING".into(),
                        })?;
                let hash = hex_prefixed(&dispute.hash);
                hashes.push(HashToSign {
                    hash: hash.clone(),
                    kind: HashType::Dispute,
                    context: dispute_hash_context(account_id, "ack-dispute"),
                });
                if presigned
                    .insert(
                        hash.clone(),
                        PresignedManifestEntry::dispute(signature, hanko),
                    )
                    .is_some()
                {
                    return Err(ResidentEntityError::ManifestWitnessDuplicate(hash));
                }
            } else if ack_dispute_signature.is_some() || ack_dispute_hanko.is_some() {
                return Err(ResidentEntityError::FrameHash {
                    detail: "ACCOUNT_ACK_DISPUTE_WITNESS_UNEXPECTED".into(),
                });
            }
        }
        AccountInputVerdict::AckCommitted {
            events: committed_events,
            ..
        } => append_status_events(events, committed_events),
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            collect_verdict_certification(
                account_id, ack, events, hashes, presigned, collisions, position,
            )?;
            collect_verdict_certification(
                account_id, frame, events, hashes, presigned, collisions, position,
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn collect_round_certification(
    inbound: &EntityRoundResult,
    outbound: &EntityRoundResult,
    local_events: Vec<EntityFrameEvent>,
    collisions: &mut Vec<CollisionFixup>,
) -> Result<(Vec<EntityFrameEvent>, Vec<HashToSign>, PresignedManifest), ResidentEntityError> {
    let mut events = Vec::new();
    let mut hashes = Vec::new();
    let mut presigned = PresignedManifest::new();
    for row in &inbound.applied {
        let position = usize::try_from(row.operation_index).map_err(|_| {
            ResidentEntityError::OperationPlan(format!(
                "INBOUND_POSITION_OVERFLOW:{}",
                row.operation_index
            ))
        })?;
        collect_verdict_certification(
            row.account_id,
            &row.verdict,
            &mut events,
            &mut hashes,
            &mut presigned,
            collisions,
            position,
        )?;
    }
    events.extend(local_events);
    for row in &outbound.proposals {
        let Some(proposed) = &row.proposed else {
            continue;
        };
        append_status_events(&mut events, &proposed.events);
        let hash = hex_prefixed(&proposed.state_hash);
        hashes.push(HashToSign {
            hash: hash.clone(),
            kind: HashType::AccountFrame,
            context: account_hash_context(row.account_id, "frame", proposed.frame_height),
        });
        if presigned
            .insert(
                hash.clone(),
                PresignedManifestEntry::account(proposed.signature, proposed.hanko.clone()),
            )
            .is_some()
        {
            return Err(ResidentEntityError::ManifestWitnessDuplicate(hash));
        }
        if let Some(dispute) = proposed
            .dispute
            .as_ref()
            .filter(|draft| draft.hanko.is_none())
        {
            let signature =
                proposed
                    .dispute_signature
                    .ok_or_else(|| ResidentEntityError::FrameHash {
                        detail: "ACCOUNT_DISPUTE_SIGNATURE_MISSING".into(),
                    })?;
            let hanko =
                proposed
                    .dispute_hanko
                    .clone()
                    .ok_or_else(|| ResidentEntityError::FrameHash {
                        detail: "ACCOUNT_DISPUTE_HANKO_MISSING".into(),
                    })?;
            let hash = hex_prefixed(&dispute.hash);
            hashes.push(HashToSign {
                hash: hash.clone(),
                kind: HashType::Dispute,
                context: dispute_hash_context(row.account_id, "dispute"),
            });
            if presigned
                .insert(
                    hash.clone(),
                    PresignedManifestEntry::dispute(signature, hanko),
                )
                .is_some()
            {
                return Err(ResidentEntityError::ManifestWitnessDuplicate(hash));
            }
        } else if proposed.dispute_signature.is_some() || proposed.dispute_hanko.is_some() {
            return Err(ResidentEntityError::FrameHash {
                detail: "ACCOUNT_DISPUTE_WITNESS_UNEXPECTED".into(),
            });
        }
    }
    Ok((events, hashes, presigned))
}

fn ordered_commits(
    inbound: &mut EntityRoundResult,
) -> Result<Vec<OrderedAccountCommit>, ResidentEntityError> {
    let mut commits = Vec::new();
    for row in &mut inbound.applied {
        let inbound_position = usize::try_from(row.operation_index).map_err(|_| {
            ResidentEntityError::OperationPlan(format!(
                "INBOUND_POSITION_OVERFLOW:{}",
                row.operation_index
            ))
        })?;
        collect_verdict_commits(
            row.account_id,
            &mut row.verdict,
            &mut commits,
            inbound_position,
        )?;
    }
    Ok(commits)
}

#[derive(Default)]
struct EntityTransitionAccumulator {
    account_creates: Vec<xln_rscore_batch::AccountSeed>,
    proposal_work: Vec<AccountProposalWork>,
    proposal_origins: Vec<(String, usize)>,
    proposal_tx_origins: Vec<(String, usize)>,
    outputs: Vec<EntityKernelOutput>,
    local_events: Vec<crate::EntityFrameEvent>,
    non_mutating_wake_targets: Vec<String>,
    routed_entity_outputs: Vec<crate::LocalEntityOutput>,
    j_outputs: Vec<crate::EntityJOutput>,
    local_hashes_to_sign: Vec<crate::HashToSign>,
    account_envelope_mutations: Vec<(String, crate::AccountEnvelopeMutation)>,
    paybook_changes: PaybookChanges,
    orderbook_deltas: Vec<crate::orderbook::SameJOutputDelta>,
}

impl EntityTransitionAccumulator {
    fn merge(&mut self, next: crate::kernel::EntityTransitionResult) -> EntityStateSlice {
        let crate::kernel::EntityTransitionResult {
            state,
            mut account_creates,
            proposal_work,
            mut proposal_origins,
            mut proposal_tx_origins,
            mut outputs,
            mut local_events,
            mut non_mutating_wake_targets,
            mut routed_entity_outputs,
            mut j_outputs,
            mut local_hashes_to_sign,
            mut account_envelope_mutations,
            paybook_changes,
            mut orderbook_deltas,
        } = next;
        self.account_creates.append(&mut account_creates);
        merge_proposal_work(&mut self.proposal_work, proposal_work);
        self.proposal_origins.append(&mut proposal_origins);
        self.proposal_tx_origins.append(&mut proposal_tx_origins);
        self.outputs.append(&mut outputs);
        self.local_events.append(&mut local_events);
        self.non_mutating_wake_targets
            .append(&mut non_mutating_wake_targets);
        self.routed_entity_outputs
            .append(&mut routed_entity_outputs);
        self.j_outputs.append(&mut j_outputs);
        self.local_hashes_to_sign.append(&mut local_hashes_to_sign);
        self.account_envelope_mutations
            .append(&mut account_envelope_mutations);
        self.paybook_changes = paybook_changes;
        self.orderbook_deltas.append(&mut orderbook_deltas);
        state
    }
}

fn local_account_views(
    accounts: &mut ResidentConsensusEngine,
    state: &EntityStateSlice,
    local_txs: &[crate::AdmittedLocalEntityTx],
    commits: &[OrderedAccountCommit],
    unsafe_frames: &[UnsafeAccountFrame],
    context: &DeterministicContext,
) -> Result<BTreeMap<String, LocalAccountFinancialView>, ResidentEntityError> {
    let mut financial = Vec::new();
    let mut cross_jurisdiction = Vec::new();
    for admitted in local_txs {
        collect_account_view_txs(
            state,
            &admitted.tx,
            true,
            &mut financial,
            &mut cross_jurisdiction,
        )?;
    }
    let mut requests = local_financial_view_requests(state, &financial, commits, context)?;
    let mut positions = requests
        .iter()
        .enumerate()
        .map(|(index, (account, _))| (*account, index))
        .collect::<BTreeMap<_, _>>();
    for (account, requested) in unsafe_account_view_requests(unsafe_frames) {
        let view = if let Some(index) = positions.get(&account).copied() {
            &mut requests[index].1
        } else {
            positions.insert(account, requests.len());
            requests.push((account, Default::default()));
            &mut requests.last_mut().expect("inserted unsafe request").1
        };
        view.htlc_lock_ids.extend(requested.htlc_lock_ids);
        view.htlc_lock_ids.sort();
        view.htlc_lock_ids.dedup();
        view.dispute = true;
    }
    for request in
        crate::cross_j::cross_jurisdiction_account_view_requests(state, &cross_jurisdiction)?
    {
        let account = account_id(&request.account_id)?;
        let view = if let Some(index) = positions.get(&account).copied() {
            &mut requests[index].1
        } else {
            positions.insert(account, requests.len());
            requests.push((account, Default::default()));
            &mut requests.last_mut().expect("inserted request").1
        };
        view.pull_ids.extend(request.pull_ids);
        view.swap_offer_ids.extend(request.swap_offer_ids);
        view.dispute |= request.dispute;
    }
    Ok(accounts
        .local_financial_views(requests)?
        .into_iter()
        .map(|(account_id, view)| {
            (
                account_text(account_id),
                LocalAccountFinancialView::from(view),
            )
        })
        .collect())
}

fn project_dispute_lifecycle_mutations(
    views: &mut BTreeMap<String, LocalAccountFinancialView>,
    mutations: &[(String, crate::AccountEnvelopeMutation)],
) -> Result<(), EntityKernelError> {
    for (account, mutation) in mutations {
        let crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status,
            dispute_prepare,
            active_dispute,
        } = mutation
        else {
            continue;
        };
        let dispute = views
            .get_mut(account)
            .and_then(|view| view.dispute.as_mut())
            .ok_or_else(|| EntityKernelError::htlc("UNSAFE_ACCOUNT_VIEW_MISSING"))?;
        dispute.status = status.clone();
        dispute.dispute_prepare = dispute_prepare.clone();
        dispute.active_dispute = active_dispute.clone();
    }
    Ok(())
}

/// Collect only the point-read plans needed by financial transactions that
/// may execute in this Entity transition. `Propose`/`Vote` remain the sole
/// authority decision in `apply_local_entity_control_tx`; looking through
/// their action here neither approves nor mutates anything. It only prevents
/// an approved transaction from reaching financial apply with an empty
/// Account view set.
fn collect_account_view_txs(
    state: &EntityStateSlice,
    tx: &crate::LocalEntityTx,
    strict: bool,
    financial: &mut Vec<LocalEntityFinancialTx>,
    cross_jurisdiction: &mut Vec<crate::CanonicalEntityTx>,
) -> Result<(), ResidentEntityError> {
    match tx {
        crate::LocalEntityTx::Financial(tx) => financial.push(tx.clone()),
        crate::LocalEntityTx::CrossJurisdiction(tx) => cross_jurisdiction.push(tx.clone()),
        crate::LocalEntityTx::RuntimeOutput(output) => {
            for nested in &output.entity_txs {
                match crate::decode_local_entity_tx(nested) {
                    Ok(Some(nested)) => collect_account_view_txs(
                        state,
                        &nested,
                        strict,
                        financial,
                        cross_jurisdiction,
                    )?,
                    Ok(None) => {}
                    Err(error) if strict => return Err(error.into()),
                    // A proposal that has not reached threshold is allowed to
                    // retain an action that will fail only if later executed.
                    // View planning must not make that speculative action fail
                    // earlier than the canonical control transition.
                    Err(_) => {}
                }
            }
        }
        crate::LocalEntityTx::Control(control) => {
            let action = match control {
                crate::LocalEntityControlTx::Propose(proposal) => Some(&proposal.action),
                crate::LocalEntityControlTx::Vote(vote)
                    if vote.choice == crate::EntityVoteChoice::Yes =>
                {
                    state
                        .proposals
                        .get(&vote.proposal_id)
                        .map(|proposal| &proposal.action)
                }
                _ => None,
            };
            if let Some(action) = action
                && let Ok(approved) = crate::proposal::decode_approved_entity_txs(action)
            {
                for approved in &approved {
                    collect_account_view_txs(
                        state,
                        approved,
                        false,
                        financial,
                        cross_jurisdiction,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn materialize_deferred_settlement_approvals(
    accounts: &mut ResidentConsensusEngine,
    state: &mut EntityStateSlice,
    proposal_work: &[crate::AccountProposalWork],
    events: &mut Vec<EntityFrameEvent>,
    hashes: &mut Vec<HashToSign>,
) -> Result<Vec<xln_rscore_batch::PendingSettlementHankoDraft>, ResidentEntityError> {
    let Some(deferred) = state.deferred_account_proposals.as_ref() else {
        return Ok(Vec::new());
    };
    let busy = proposal_work
        .iter()
        .map(|work| work.account_id.as_str())
        .collect::<BTreeSet<_>>();
    let requests = deferred
        .text_entries()?
        .into_iter()
        .filter(|(account, _)| !busy.contains(account.as_str()))
        .map(|(account, value)| {
            let CanonicalValue::String(workspace_hash) = value else {
                return Err(EntityKernelError::local(
                    "settle_approve",
                    "SETTLEMENT_DEFERRED_HASH_INVALID",
                )
                .into());
            };
            Ok((account_id(&account)?, workspace_hash))
        })
        .collect::<Result<Vec<_>, ResidentEntityError>>()?;
    let dispositions = accounts.deferred_settlement_approvals(requests)?;
    let mut ready = Vec::new();
    for disposition in dispositions {
        match disposition {
            xln_rscore_batch::DeferredSettlementApproval::Wait { .. } => {}
            xln_rscore_batch::DeferredSettlementApproval::Invalid { account_id } => {
                let account = account_text(account_id);
                state
                    .deferred_account_proposals
                    .as_mut()
                    .expect("deferred collection exists")
                    .remove(&account)?;
                events.push(EntityFrameEvent::Status {
                    message: "⚠️ Settlement approval expired because the workspace changed".into(),
                });
            }
            xln_rscore_batch::DeferredSettlementApproval::Ready(pending) => {
                let account = account_text(pending.account_id);
                let suffix = account
                    .get(account.len().saturating_sub(8)..)
                    .unwrap_or(&account);
                if let Some(hash) = pending.draft.settlement_hash {
                    hashes.push(HashToSign {
                        hash: hex_prefixed(&hash),
                        kind: HashType::Settlement,
                        context: format!(
                            "settlement:{suffix}:nonce:{}",
                            pending.draft.settlement_nonce
                        ),
                    });
                }
                hashes.push(HashToSign {
                    hash: hex_prefixed(&pending.draft.dispute_hash),
                    kind: HashType::Dispute,
                    context: format!(
                        "settlement:{suffix}:post-dispute:nonce:{}",
                        pending.draft.proof_nonce
                    ),
                });
                state
                    .deferred_account_proposals
                    .as_mut()
                    .expect("deferred collection exists")
                    .remove(&account)?;
                ready.push(*pending);
            }
        }
    }
    Ok(ready)
}

type ScheduledWakeResult = (
    Vec<SchedulerCommand>,
    Vec<(String, crate::AccountEnvelopeMutation)>,
);

fn apply_scheduled_wake(
    accounts: &mut ResidentConsensusEngine,
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    wake: Option<&ScheduledWake>,
    expected_proposer_signer_id: &str,
) -> Result<ScheduledWakeResult, ResidentEntityError> {
    let Some(wake) = wake else {
        return Ok((Vec::new(), Vec::new()));
    };
    let now = state.timestamp;
    // Expired HTLC locks are derived from committed Account state, in
    // (timelock, lockId) order — the key the hook map used to drain by.
    let expired_locks = accounts
        .expired_htlc_locks(now)?
        .into_iter()
        .map(|(account, lock_id, _)| (account_text(account), lock_id))
        .filter(|(account, _)| state.known_accounts.contains(account))
        .collect::<Vec<_>>();

    let dispute_account_ids = state
        .crontab
        .as_ref()
        .ok_or(ResidentEntityError::CrontabMissing)?
        .hooks
        .due(now)
        .filter_map(|hook| match &hook.kind {
            ScheduledHookKind::DisputeDeadline { account_id } => Some(account_id.clone()),
            _ => None,
        })
        .filter(|account| state.known_accounts.contains(account))
        .collect::<BTreeSet<_>>();
    let dispute_views = accounts
        .local_financial_views(
            dispute_account_ids
                .iter()
                .map(|account| {
                    Ok((
                        account_id(account)?,
                        xln_rscore_batch::ResidentAccountFinancialViewRequest {
                            dispute: true,
                            ..Default::default()
                        },
                    ))
                })
                .collect::<Result<Vec<_>, ResidentEntityError>>()?,
        )?
        .into_iter()
        .filter_map(|(account, view)| view.dispute.map(|view| (account_text(account), view)))
        .collect::<BTreeMap<_, _>>();

    // Secret-ack deadlines are derived from paybook entries (frame-local
    // writes included). A deadline whose lock is still active needs a
    // dispute; one whose lock is gone just terminates the route.
    let due_secret_acks = paybook.due_secret_acks(state, now)?;
    let mut requested_locks = BTreeMap::<AccountId, Vec<String>>::new();
    for (hashlock, counterparty) in &due_secret_acks {
        if state.known_accounts.contains(counterparty) {
            requested_locks
                .entry(account_id(counterparty)?)
                .or_default()
                .push(hashlock.clone());
        }
    }
    for lock_ids in requested_locks.values_mut() {
        lock_ids.sort();
        lock_ids.dedup();
    }
    let active = accounts.active_htlc_locks(requested_locks.into_iter().collect())?;
    let active_text = active
        .iter()
        .map(|(account, lock_id)| (account_text(*account), lock_id.clone()))
        .collect::<BTreeSet<_>>();
    let mut secret_acks_requiring_dispute = BTreeSet::new();
    for (hashlock, counterparty) in due_secret_acks {
        if active_text.contains(&(counterparty, hashlock.clone())) {
            secret_acks_requiring_dispute.insert(hashlock);
        } else {
            terminate_route_in_frame(state, paybook, &hashlock)?;
        }
    }

    let execution = execute_crontab(
        state
            .crontab
            .as_ref()
            .ok_or(ResidentEntityError::CrontabMissing)?,
        wake,
        CrontabExecutionContext {
            expected_proposer_signer_id,
            now: state.timestamp,
            expired_htlc_locks: &expired_locks,
            secret_acks_requiring_dispute: &secret_acks_requiring_dispute,
            dispute_views: &dispute_views,
            j_batch_state: state.j_batch_state.as_ref(),
            dispute_auto_finalize: state
                .hub_rebalance_config
                .as_ref()
                .and_then(|config| match config {
                    CanonicalValue::Object(fields) => fields.iter().find_map(|(name, value)| {
                        (name == "disputeAutoFinalizeMode").then_some(value)
                    }),
                    _ => None,
                })
                .is_none_or(|value| value != &CanonicalValue::String("ignore".into())),
        },
    )?;
    state.crontab = Some(execution.crontab);
    Ok((execution.commands, execution.account_envelope_mutations))
}

/// Resolve only hashlocks that an Account worker actually removed. Forwarded
/// failures become one later batched Account wave; originated failures end at
/// Entity. No Paybook route is enumerated and no route closure is copied.
fn failed_proposal_followups(
    state: &mut EntityStateSlice,
    outbound: &PreparedEntityOutbound,
    outputs: &mut Vec<EntityKernelOutput>,
) -> Result<Vec<FailedHtlcFollowup>, ResidentEntityError> {
    let mut followups = Vec::new();
    for proposal in outbound.proposals() {
        for failed in &proposal.failed_htlc_locks {
            let hashlock = hex_prefixed(&failed.hashlock);
            if failed.lock_id != hashlock {
                return Err(ResidentEntityError::Entity(EntityKernelError::htlc(
                    "PAYBOOK_FAILED_LOCK_ID_MISMATCH",
                )));
            }
            let Some(route) = paybook_entry(state, &hashlock)?.cloned() else {
                continue;
            };
            let outbound_account = account_text(proposal.account_id);
            if route.outbound_entity.as_deref() != Some(outbound_account.as_str()) {
                return Err(ResidentEntityError::Entity(EntityKernelError::htlc(
                    "PAYBOOK_FAILED_OUTBOUND_ACCOUNT_MISMATCH",
                )));
            }
            if let Some(inbound_entity) = route.inbound_entity.as_ref() {
                let reason = format!("forward_failed:{}", failed.reason);
                followups.push(FailedHtlcFollowup {
                    failed_account_id: proposal.account_id,
                    hashlock: failed.hashlock,
                    upstream_account_id: account_id(inbound_entity)?,
                    tx: AccountTx::HtlcResolve(HtlcResolveTx {
                        lock_id: hashlock.clone(),
                        outcome: HtlcResolveOutcome::Error {
                            reason: Some(reason.clone()),
                        },
                    }),
                    reason,
                });
                terminate_route(state, &hashlock)?;
                continue;
            }
            terminate_route(state, &hashlock)?;
            outputs.push(EntityKernelOutput::HtlcFailed {
                entity_id: state.entity_id.clone(),
                hashlock: hashlock.clone(),
                lock_id: Some(hashlock),
                reason: failed.reason.clone(),
                description: route.description,
            });
        }
    }
    Ok(followups)
}

/// Apply one Entity transition over resident Account shards.
pub fn apply_resident_entity_round(
    accounts: &mut ResidentConsensusEngine,
    state: EntityStateSlice,
    request: ResidentEntityRequest,
    context: &DeterministicContext,
) -> Result<ResidentEntityResult, ResidentEntityError> {
    let result = apply_resident_entity_round_core_attempt(accounts, state, request, context)
        .and_then(ResidentEntityCoreResult::with_canonical_commitments);
    match result {
        Ok(result) => {
            accounts.complete_entity_round();
            Ok(result)
        }
        Err(error) => {
            accounts.abort_entity_round()?;
            Err(error)
        }
    }
}

/// Apply the production Entity transition without computing the additional
/// shadow paybook/orderbook/outbox digests. Runtime consensus commits the
/// canonical Entity sections instead.
pub fn apply_resident_entity_round_core(
    accounts: &mut ResidentConsensusEngine,
    state: EntityStateSlice,
    request: ResidentEntityRequest,
    context: &DeterministicContext,
) -> Result<ResidentEntityCoreResult, ResidentEntityError> {
    let result = apply_resident_entity_round_core_attempt(accounts, state, request, context);
    match result {
        Ok(result) => {
            accounts.complete_entity_round();
            Ok(result)
        }
        Err(error) => {
            accounts.abort_entity_round()?;
            Err(error)
        }
    }
}

fn apply_resident_entity_round_core_attempt(
    accounts: &mut ResidentConsensusEngine,
    mut state: EntityStateSlice,
    mut request: ResidentEntityRequest,
    context: &DeterministicContext,
) -> Result<ResidentEntityCoreResult, ResidentEntityError> {
    let total_started = Instant::now();
    let owner_entity_id = request.inbound.owner_entity_id;
    let request_owner = hex_prefixed(&owner_entity_id);
    if state.entity_id != request_owner {
        return Err(ResidentEntityError::OwnerMismatch {
            state: state.entity_id,
            request: request_owner,
        });
    }
    let owning_entity_is_hub = state.hub_rebalance_config.is_some();
    if request.inbound.owning_entity_is_hub != owning_entity_is_hub {
        return Err(ResidentEntityError::OperationPlan(format!(
            "OWNER_HUB_ROLE_MISMATCH:{}:{}",
            request.inbound.owning_entity_is_hub, owning_entity_is_hub
        )));
    }
    state.height = request.entity_height;
    state.timestamp = request.outbound_timestamp;
    validate_operation_plan(&request.operations, request.inbound.rows.len())?;
    if let Some(wake) = request.scheduled_wake.as_ref() {
        validate_scheduled_wake(wake, &request.expected_proposer_signer_id, state.timestamp)?;
    }
    let mut touch_candidates = request
        .inbound
        .rows
        .iter()
        .map(|row| row.account_id)
        .collect::<Vec<_>>();
    let inbound_touch_count = touch_candidates.len();
    let owner_entity_id = request.inbound.owner_entity_id;
    let clock = request.inbound.clock;
    let expected_root = request.inbound.expected_accounts_root;
    let mut rows = std::mem::take(&mut request.inbound.rows);
    let mut first_row_by_account = BTreeMap::new();
    for (index, row) in rows.iter_mut().enumerate() {
        row.operation_index = u64::try_from(index)
            .map_err(|_| ResidentEntityError::OperationPlan("ACCOUNT_INDEX_OVERFLOW".into()))?;
        first_row_by_account.entry(row.account_id).or_insert(index);
    }
    let operations = std::mem::take(&mut request.operations);
    let cross_j_setup_in_frame = frame_contains_cross_j_setup(&operations);
    let manual_broadcast_in_input = operations.iter().any(|operation| {
        matches!(
            operation,
            ResidentEntityOperation::Local(txs)
                if txs.iter().any(|tx| matches!(
                    tx.tx,
                    crate::LocalEntityTx::Control(
                        crate::LocalEntityControlTx::JBroadcast { .. }
                    )
                ))
        )
    });
    let account_ranges = operations
        .iter()
        .filter(|operation| matches!(operation, ResidentEntityOperation::AccountRange { .. }))
        .count();
    let local_operations = operations.len().saturating_sub(account_ranges);
    // Stage 1 is one global Account ingress wave. The positional operation
    // plan controls only the later Entity fold: local/book work intentionally
    // observes the final Stage-1 Account candidates.
    let phase_started = Instant::now();
    let mut inbound = accounts.entity_inbound_unsealed(
        EntityInboundRequest {
            owner_entity_id,
            expected_accounts_root: expected_root,
            clock,
            owning_entity_is_hub,
            rows,
            post_accounts: false,
        },
        false,
    )?;
    // TS `finishRejectedAccountInput` fail-stops an authenticated peer frame
    // rejection. Treating the typed Account verdict as telemetry here would
    // silently consume its Runtime WAL position and diverge at the Entity
    // boundary. The enclosing resident round abort restores every staged
    // Account mutation, including an ACK paired with a rejected frame.
    reject_failed_inbound_frames(&inbound.applied)?;
    // TS primes the frame-local Account worklist after the inbound Account
    // stage (prepare → primeEntityFrameAccountWork): an ACK admitted this
    // frame already made its Account proposable, and that sorted post-inbound
    // set is the publication prefix. Preserve it separately: the active
    // proposable set is a membership index and cannot recover first-touch
    // order after all three Entity stages have completed.
    let initially_proposable =
        accounts.selected_proposable_account_ids(request.inbound.expected_accounts_root)?;
    let inbound_micros = phase_started.elapsed().as_micros();
    let created_position_by_account = inbound
        .created_accounts
        .iter()
        .map(|created| {
            first_row_by_account
                .get(&created.account_id)
                .copied()
                .map(|position| (created.account_id, position))
                .ok_or_else(|| {
                    ResidentEntityError::OperationPlan(format!(
                        "CREATED_ACCOUNT_WITHOUT_INPUT:{}",
                        account_text(created.account_id)
                    ))
                })
        })
        .collect::<Result<BTreeMap<_, _>, ResidentEntityError>>()?;
    let mut applied_slots = std::mem::take(&mut inbound.applied)
        .into_iter()
        .map(Some)
        .collect::<Vec<_>>();
    let mut ordered_applied = Vec::with_capacity(applied_slots.len());
    let mut commits_micros = 0_u128;
    let mut entity_apply_micros = 0_u128;
    let mut book_stage_micros = 0_u128;
    let mut accumulated = EntityTransitionAccumulator::default();
    let mut ordered_events = Vec::new();
    let mut ordered_hashes = Vec::new();
    let mut ordered_presigned = PresignedManifest::new();
    let mut collisions = Vec::<CollisionFixup>::new();

    for operation in operations {
        match operation {
            ResidentEntityOperation::AccountRange { start, len } => {
                let segment_applied = applied_slots[start..start + len]
                    .iter_mut()
                    .enumerate()
                    .map(|(index, applied)| {
                        applied.take().ok_or_else(|| {
                            ResidentEntityError::OperationPlan(format!(
                                "ACCOUNT_ROW_REUSED:{}",
                                start + index
                            ))
                        })
                    })
                    .collect::<Result<Vec<_>, ResidentEntityError>>()?;
                let mut segment = EntityRoundResult {
                    applied: segment_applied,
                    ..EntityRoundResult::default()
                };
                let (mut events, mut hashes, presigned) = collect_round_certification(
                    &segment,
                    &EntityRoundResult::default(),
                    Vec::new(),
                    &mut collisions,
                )?;
                ordered_events.append(&mut events);
                ordered_hashes.append(&mut hashes);
                for (hash, witness) in presigned {
                    if ordered_presigned.insert(hash.clone(), witness).is_some() {
                        return Err(ResidentEntityError::ManifestWitnessDuplicate(hash));
                    }
                }
                let phase_started = Instant::now();
                let created_accounts = created_position_by_account
                    .iter()
                    .filter(|(_, position)| **position >= start && **position < start + len)
                    .map(|(account_id, _)| account_text(*account_id))
                    .collect::<BTreeSet<_>>();
                let unsafe_dispositions = collect_unsafe_account_frames(
                    &segment.applied,
                    &created_accounts,
                    account_text,
                );
                let unsafe_frames = unsafe_dispositions
                    .iter()
                    .filter_map(|disposition| match disposition {
                        UnsafeAccountFrameDisposition::CreatedAccountRejected { .. } => None,
                        UnsafeAccountFrameDisposition::Process(frame) => Some(frame.clone()),
                    })
                    .collect::<Vec<_>>();
                let mut commits = ordered_commits(&mut segment)?;
                for account in &created_accounts {
                    state.known_accounts.insert(account.clone());
                }
                let mut views =
                    local_account_views(accounts, &state, &[], &commits, &unsafe_frames, context)?;
                commits_micros = commits_micros.saturating_add(phase_started.elapsed().as_micros());
                let empty_created_accounts = BTreeSet::new();
                let mut base_transition_pending = true;
                for disposition in unsafe_dispositions {
                    let frame = match disposition {
                        UnsafeAccountFrameDisposition::CreatedAccountRejected { message } => {
                            ordered_events.push(EntityFrameEvent::Status { message });
                            continue;
                        }
                        UnsafeAccountFrameDisposition::Process(frame) => frame,
                    };
                    let starts_before = state
                        .j_batch_state
                        .as_ref()
                        .map_or(0, |j| j.batch.dispute_starts.len());
                    let unsafe_effects = consume_unsafe_account_frames(
                        &mut state,
                        &mut accumulated.paybook_changes,
                        std::slice::from_ref(&frame),
                        &views,
                        &request.expected_proposer_signer_id,
                    )?;
                    let phase_started = Instant::now();
                    let mut next = apply_entity_transitions(
                        state,
                        std::mem::take(&mut accumulated.paybook_changes),
                        std::mem::take(&mut commits),
                        if base_transition_pending {
                            &created_accounts
                        } else {
                            &empty_created_accounts
                        },
                        unsafe_effects.local_txs,
                        &views,
                        request.local_account_genesis_policy.as_ref(),
                        request.entity_authority.as_ref(),
                        request.runtime_seed.as_deref(),
                        context,
                    )?;
                    base_transition_pending = false;
                    // Account envelopes are written once by the outbound owner below. This
                    // frame-local projection gives the next unsafe input TS-style read-your-
                    // writes semantics without creating a second durable state path.
                    project_dispute_lifecycle_mutations(
                        &mut views,
                        &next.account_envelope_mutations,
                    )?;
                    let mut evidence_mutations = unsafe_effects.envelope_mutations;
                    evidence_mutations.append(&mut next.account_envelope_mutations);
                    next.account_envelope_mutations = evidence_mutations;
                    let mut evidence_work = unsafe_effects.proposal_work;
                    merge_proposal_work(&mut evidence_work, next.proposal_work);
                    next.proposal_work = evidence_work;
                    let starts_after = next
                        .state
                        .j_batch_state
                        .as_ref()
                        .map_or(0, |j| j.batch.dispute_starts.len());
                    let dispute_started = starts_after > starts_before;
                    next.local_events.push(EntityFrameEvent::Status {
                        message: if dispute_started {
                            "⚠️ Unsafe account frame rejected; dispute start queued".into()
                        } else {
                            "⚠️ Unsafe account frame rejected; dispute preparation awaits Hanko"
                                .into()
                        },
                    });
                    if dispute_started && let Some(j_state) = next.state.j_batch_state.as_mut() {
                        j_state.auto_broadcast_draft = true;
                        if j_state.sent_batch.is_none() {
                            next.routed_entity_outputs.push(crate::LocalEntityOutput {
                                entity_id: next.state.entity_id.clone(),
                                target_signer_id: None,
                                entity_txs: vec![crate::LocalEntityOutputTx::Projected(
                                    crate::CanonicalEntityTx::from_frame_projection(
                                        crate::EntityTxKind::JBroadcast,
                                        CanonicalValue::Object(Vec::new()),
                                    )
                                    .map_err(|error| {
                                        EntityKernelError::local("accountInput", error.to_string())
                                    })?,
                                )],
                            });
                        }
                    }
                    ordered_events.append(&mut next.local_events);
                    ordered_hashes.append(&mut next.local_hashes_to_sign);
                    entity_apply_micros =
                        entity_apply_micros.saturating_add(phase_started.elapsed().as_micros());
                    state = accumulated.merge(next);
                }
                if base_transition_pending {
                    let phase_started = Instant::now();
                    let mut next = apply_entity_transitions(
                        state,
                        std::mem::take(&mut accumulated.paybook_changes),
                        commits,
                        &created_accounts,
                        Vec::new(),
                        &views,
                        request.local_account_genesis_policy.as_ref(),
                        request.entity_authority.as_ref(),
                        request.runtime_seed.as_deref(),
                        context,
                    )?;
                    ordered_events.append(&mut next.local_events);
                    ordered_hashes.append(&mut next.local_hashes_to_sign);
                    entity_apply_micros =
                        entity_apply_micros.saturating_add(phase_started.elapsed().as_micros());
                    state = accumulated.merge(next);
                }
                ordered_applied.append(&mut segment.applied);
            }
            ResidentEntityOperation::Local(local_txs) => {
                let views = local_account_views(accounts, &state, &local_txs, &[], &[], context)?;
                let phase_started = Instant::now();
                let mut next = apply_entity_transitions(
                    state,
                    std::mem::take(&mut accumulated.paybook_changes),
                    Vec::new(),
                    &BTreeSet::new(),
                    local_txs,
                    &views,
                    request.local_account_genesis_policy.as_ref(),
                    request.entity_authority.as_ref(),
                    request.runtime_seed.as_deref(),
                    context,
                )?;
                ordered_events.append(&mut next.local_events);
                ordered_hashes.append(&mut next.local_hashes_to_sign);
                entity_apply_micros =
                    entity_apply_micros.saturating_add(phase_started.elapsed().as_micros());
                state = accumulated.merge(next);
            }
        }
    }
    if applied_slots.iter().any(Option::is_some) {
        return Err(ResidentEntityError::OperationPlan(
            "ACCOUNT_ROWS_UNCONSUMED".into(),
        ));
    }
    inbound.applied = ordered_applied;
    let forced_acks = forced_ack_accounts(&inbound.applied);
    let (scheduled_commands, scheduled_account_envelope_mutations) = apply_scheduled_wake(
        accounts,
        &mut state,
        &mut accumulated.paybook_changes,
        request.scheduled_wake.as_ref(),
        &request.expected_proposer_signer_id,
    )?;
    accumulated
        .account_envelope_mutations
        .extend(scheduled_account_envelope_mutations);
    if scheduled_commands
        .iter()
        .any(|command| matches!(command, SchedulerCommand::HubRebalance))
    {
        let account_ids = accounts.rebalance_account_ids()?;
        let views = accounts
            .hub_rebalance_views(account_ids)?
            .into_iter()
            .map(|(account_id, view)| {
                Ok(crate::hub_rebalance::HubRebalanceAccountView {
                    account_id: account_text(account_id),
                    owner_side: view.owner_side,
                    pending_frame: view.pending_frame,
                    settlement_transition_pending: view.settlement_transition_pending,
                    settlement_workspace: view.settlement_workspace,
                    requested_rebalance: view.requested_rebalance.into_iter().collect(),
                    fee_state: view
                        .requested_fee_state
                        .into_iter()
                        .map(|(token_id, fee)| {
                            (
                                token_id,
                                crate::hub_rebalance::HubRebalanceFeeState {
                                    request_id: fee.request_id,
                                    fee_paid_upfront: fee.fee_paid_upfront,
                                    policy_version: fee.policy_version,
                                    requested_at: fee.requested_at,
                                    refund: fee.refund,
                                    refunded_amount: fee.refunded_amount,
                                },
                            )
                        })
                        .collect(),
                    submitted_at_by_token: view
                        .submitted_at_by_token
                        .into_iter()
                        .map(|(token_id, submitted_at)| {
                            Ok((
                                xln_rscore_engine::TokenId::new(token_id).map_err(|error| {
                                    EntityKernelError::local("hubRebalance", error.to_string())
                                })?,
                                submitted_at,
                            ))
                        })
                        .collect::<Result<_, EntityKernelError>>()?,
                    deltas: view
                        .deltas
                        .into_iter()
                        .map(|delta| (delta.token_id(), delta))
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, EntityKernelError>>()?;
        let mut rebalance = crate::hub_rebalance::apply_hub_rebalance(
            &mut state,
            &views,
            manual_broadcast_in_input,
        )?;
        accumulated
            .routed_entity_outputs
            .append(&mut rebalance.outputs);
        accumulated
            .account_envelope_mutations
            .append(&mut rebalance.envelope_mutations);
        accumulated.outputs.append(&mut rebalance.effects);
    }
    let phase_started = Instant::now();
    let final_transition = apply_entity_transitions(
        state,
        std::mem::take(&mut accumulated.paybook_changes),
        Vec::new(),
        &BTreeSet::new(),
        Vec::new(),
        &BTreeMap::new(),
        request.local_account_genesis_policy.as_ref(),
        request.entity_authority.as_ref(),
        request.runtime_seed.as_deref(),
        context,
    )?;
    entity_apply_micros = entity_apply_micros.saturating_add(phase_started.elapsed().as_micros());
    let state = accumulated.merge(final_transition);
    let mut kernel = crate::kernel::EntityTransitionResult {
        state,
        account_creates: accumulated.account_creates,
        proposal_work: accumulated.proposal_work,
        proposal_origins: accumulated.proposal_origins,
        proposal_tx_origins: accumulated.proposal_tx_origins,
        outputs: accumulated.outputs,
        local_events: accumulated.local_events,
        non_mutating_wake_targets: accumulated.non_mutating_wake_targets,
        routed_entity_outputs: accumulated.routed_entity_outputs,
        j_outputs: accumulated.j_outputs,
        local_hashes_to_sign: accumulated.local_hashes_to_sign,
        account_envelope_mutations: accumulated.account_envelope_mutations,
        paybook_changes: std::mem::take(&mut accumulated.paybook_changes),
        orderbook_deltas: std::mem::take(&mut accumulated.orderbook_deltas),
    };
    // Prepare the coordinator-owned Orderbook candidate before J ingress, as
    // before, but defer every independent pair job to the one mixed Book
    // worker dispatch shared with active Paybook radix slots.
    let prepared_book_stage = prepare_orderbook_stage(&mut kernel, context)?;
    let j_ingress_started = Instant::now();
    let mut deferred_j_ingress = None;
    if let Some(j_events) = request.finalized_j_events.as_ref() {
        if j_events.scanned_through != request.outbound_j_height {
            return Err(EntityKernelError::JEventInvalid {
                detail: format!(
                    "RUNTIME_J_HEIGHT_BINDING:{}:{}",
                    j_events.scanned_through, request.outbound_j_height
                ),
            }
            .into());
        }
        let claim_account_ids = j_events
            .batches
            .iter()
            .flat_map(|batch| batch.account_claims.iter())
            .filter(|claim| {
                kernel
                    .state
                    .known_accounts
                    .contains(&claim.account_id.as_hex())
            })
            .map(|claim| AccountId::from_bytes(*claim.account_id.as_bytes()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let active_account_ids = accounts
            .active_account_ids(claim_account_ids)?
            .into_iter()
            .map(account_text)
            .collect();
        let owner = kernel.state.entity_id.to_ascii_lowercase();
        let mut dispute_account_ids = j_events
            .batches
            .iter()
            .flat_map(|batch| batch.events.iter())
            .filter_map(|event| match event {
                xln_rscore_engine::JurisdictionEvent::DisputeStarted(value) => {
                    Some((&value.sender, &value.counterentity))
                }
                xln_rscore_engine::JurisdictionEvent::DisputeFinalized(value) => {
                    Some((&value.sender, &value.counterentity))
                }
                xln_rscore_engine::JurisdictionEvent::CounterDisputeRegistered(value) => {
                    Some((&value.sender, &value.counterentity))
                }
                _ => None,
            })
            .map(|(sender, counter)| {
                if sender.eq_ignore_ascii_case(&owner) {
                    counter.to_ascii_lowercase()
                } else {
                    sender.to_ascii_lowercase()
                }
            })
            .filter(|account| kernel.state.known_accounts.contains(account))
            .collect::<BTreeSet<_>>();
        if j_events.batches.iter().any(|batch| {
            batch.events.iter().any(|event| {
                matches!(
                    event,
                    xln_rscore_engine::JurisdictionEvent::HankoBatchProcessed(_)
                )
            })
        }) {
            dispute_account_ids.extend(
                crate::cross_j::pending_registry_reveal_account_ids(&kernel.state)?
                    .into_iter()
                    .filter(|account| kernel.state.known_accounts.contains(account)),
            );
        }
        let dispute_views = accounts
            .local_financial_views(
                dispute_account_ids
                    .iter()
                    .map(|account| {
                        Ok((
                            account_id(account)?,
                            xln_rscore_batch::ResidentAccountFinancialViewRequest {
                                dispute: true,
                                ..Default::default()
                            },
                        ))
                    })
                    .collect::<Result<Vec<_>, ResidentEntityError>>()?,
            )?
            .into_iter()
            .filter_map(|(account, view)| view.dispute.map(|view| (account_text(account), view)))
            .collect::<BTreeMap<_, _>>();
        let ingress = apply_finalized_j_event_batches_in_frame(
            &mut kernel.state,
            j_events.scanned_through,
            &j_events.batches,
            &j_events.runtime_seed,
            request.entity_authority.as_ref(),
            &active_account_ids,
            &dispute_views,
            &mut kernel.paybook_changes,
        )?;
        commit_j_range_finality(
            &mut kernel.state,
            request.entity_authority.as_ref(),
            request.entity_height,
            j_events,
        )?;
        deferred_j_ingress = Some(ingress);
    }
    let j_ingress_micros = j_ingress_started.elapsed().as_micros();
    let book_stage_started = Instant::now();
    let paybook_changes = std::mem::take(&mut kernel.paybook_changes);
    commit_book_stage(
        accounts,
        &mut kernel,
        paybook_changes,
        prepared_book_stage,
        context,
        &scheduled_commands,
    )?;
    book_stage_micros = book_stage_micros.saturating_add(book_stage_started.elapsed().as_micros());
    if let Some(ingress) = deferred_j_ingress {
        // TS returns J-event `dirtyAccounts` as `accountChanges`, so these
        // envelope writes are part of Runtime Account history. Ordinary local
        // Entity envelope writes deliberately do not have that contract.
        let ingress_account_changes = ingress
            .account_envelope_mutations
            .iter()
            .map(|(account, _)| account_id(account))
            .collect::<Result<Vec<_>, ResidentEntityError>>()?;
        touch_candidates.extend(canonical_entity_tx_account_changes(ingress_account_changes));
        merge_proposal_work(&mut kernel.proposal_work, ingress.proposal_work);
        kernel
            .account_envelope_mutations
            .extend(ingress.account_envelope_mutations);
        kernel
            .routed_entity_outputs
            .extend(ingress.routed_entity_outputs);
        kernel.local_events.extend(ingress.frame_events);
    }

    let pending_settlement_hankos = materialize_deferred_settlement_approvals(
        accounts,
        &mut kernel.state,
        &kernel.proposal_work,
        &mut kernel.local_events,
        &mut kernel.local_hashes_to_sign,
    )?;
    // TS records an unsigned settlement admission immediately, before the
    // later Entity certification attaches its Hanko. It may intentionally
    // produce no ProposalRow in this round, so keep this explicit touch.
    touch_candidates.extend(
        pending_settlement_hankos
            .iter()
            .map(|pending| pending.account_id),
    );
    let deferred_accounts = pending_settlement_hankos
        .iter()
        .map(|pending| pending.account_id)
        .collect::<BTreeSet<_>>();
    let unsigned_settlement_txs = pending_settlement_hankos
        .iter()
        .map(|pending| (pending.account_id, pending.draft.tx.clone()))
        .collect();

    let phase_started = Instant::now();
    let envelope_updates = std::mem::take(&mut kernel.account_envelope_mutations)
        .into_iter()
        .map(|(account, update)| {
            let update = match update {
                crate::AccountEnvelopeMutation::ClearRebalanceActiveQuote => {
                    xln_rscore_batch::AccountEnvelopeUpdate::ClearRebalanceActiveQuote
                }
                crate::AccountEnvelopeMutation::SetRejectedFrameEvidence {
                    reason,
                    frame_hash,
                    frame_hanko,
                } => xln_rscore_batch::AccountEnvelopeUpdate::SetRejectedFrameEvidence {
                    reason,
                    frame_hash,
                    frame_hanko,
                },
                crate::AccountEnvelopeMutation::SetRebalancePolicy { token_id, policy } => {
                    xln_rscore_batch::AccountEnvelopeUpdate::SetRebalancePolicy { token_id, policy }
                }
                crate::AccountEnvelopeMutation::SetRebalanceSubmittedAt {
                    token_id,
                    submitted_at,
                } => xln_rscore_batch::AccountEnvelopeUpdate::SetRebalanceSubmittedAt {
                    token_id,
                    submitted_at,
                },
                crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                    status,
                    dispute_prepare,
                    active_dispute,
                } => xln_rscore_batch::AccountEnvelopeUpdate::ReplaceDisputeLifecycle {
                    status,
                    dispute_prepare,
                    active_dispute,
                },
                crate::AccountEnvelopeMutation::ApplyDisputeStarted(finality) => {
                    xln_rscore_batch::AccountEnvelopeUpdate::ApplyDisputeStarted(finality)
                }
                crate::AccountEnvelopeMutation::ApplyDisputeFinality(finality) => {
                    xln_rscore_batch::AccountEnvelopeUpdate::ApplyDisputeFinality(finality)
                }
                crate::AccountEnvelopeMutation::ConfirmDisputeBookRemoval { order_id } => {
                    xln_rscore_batch::AccountEnvelopeUpdate::ConfirmDisputeBookRemoval { order_id }
                }
            };
            Ok((account_id(&account)?, vec![update]))
        })
        .collect::<Result<Vec<_>, ResidentEntityError>>()?;
    let proposable_started = Instant::now();
    let mut propose = accounts.proposable_account_ids()?;
    propose.retain(|account_id| !deferred_accounts.contains(account_id));
    let proposable_micros = proposable_started.elapsed().as_micros();
    let prepare_outbound_started = Instant::now();
    // One final Account-stage set. Keep the existing canonical proposal order,
    // merge Entity AccountTxs into it, then append inbound-only Accounts that
    // need their final leaf sealed. Only the transient force bit crosses the
    // coordinator; exact ACK/Hanko bytes stay worker-resident until emission.
    let mut proposal_positions = HashMap::<AccountId, usize>::new();
    let mut proposal_work = Vec::<AccountProposalRow>::new();
    for target in propose.drain(..) {
        proposal_positions.insert(target, proposal_work.len());
        proposal_work.push((target, Vec::new(), false));
    }
    for work in &kernel.proposal_work {
        let target = account_id(&work.account_id)?;
        touch_candidates.push(target);
        if let Some(position) = proposal_positions.get(&target).copied() {
            proposal_work[position].1.extend(work.txs.iter().cloned());
        } else {
            proposal_positions.insert(target, proposal_work.len());
            proposal_work.push((target, work.txs.clone(), false));
        }
    }
    // TS `openAccount` returns the created Account in `accountChanges` even
    // before its first proposal. Keep creation explicit instead of relying on
    // the usual genesis AccountTxs to happen to name the same leaf.
    touch_candidates.extend(kernel.account_creates.iter().map(|seed| seed.account_id));
    for target in forced_acks {
        if let Some(position) = proposal_positions.get(&target).copied() {
            proposal_work[position].2 = true;
        } else {
            proposal_positions.insert(target, proposal_work.len());
            proposal_work.push((target, Vec::new(), true));
        }
    }
    for (target, _) in &inbound.touched {
        // The unsigned settlement admission already names and seals this
        // Account in the same final Account stage. Adding the generic
        // inbound-only seal row as well would dispatch one logical shard row
        // twice and either propose before certification or fail as duplicate.
        if !deferred_accounts.contains(target) && !proposal_positions.contains_key(target) {
            proposal_positions.insert(*target, proposal_work.len());
            proposal_work.push((*target, Vec::new(), false));
        }
    }
    // The workers return values to fixed positions, but `propose` above is a
    // post-stage membership set. Reapply the canonical TS queue: work already
    // pending at frame start, then each Account's first accepted input/local
    // touch. A BTree/radix key order must never become flat-outbox order.
    let mut touch_candidates = interleave_first_touch(
        touch_candidates,
        inbound_touch_count,
        &kernel.proposal_origins,
    )?;
    let proposal_work = order_proposal_work_by_first_touch(
        proposal_work,
        &initially_proposable,
        &touch_candidates,
    )?;
    let proposal_work = select_cross_j_proposal_work(
        accounts,
        &kernel.state.entity_id,
        proposal_work,
        &kernel
            .account_creates
            .iter()
            .map(|seed| seed.account_id)
            .collect(),
        &request.cross_j_opening_sibling_views,
        cross_j_setup_in_frame,
    )?;
    let prepare_outbound_micros = prepare_outbound_started.elapsed().as_micros();
    let worklist_micros = phase_started.elapsed().as_micros();
    let phase_started = Instant::now();
    let prepared = accounts.prepare_entity_outbound(EntityOutboundRequest {
        owner_entity_id,
        local_certified_board_authority: request.local_certified_board_authority,
        timestamp: request.outbound_timestamp,
        j_height: kernel.state.last_finalized_j_height,
        creates: std::mem::take(&mut kernel.account_creates),
        envelope_updates,
        unsigned_settlement_txs,
        proposal_work,
        checkpoint_due: request.checkpoint_due,
        post_accounts: request.post_accounts,
    })?;
    let failed_routes_started = Instant::now();
    let followups = failed_proposal_followups(&mut kernel.state, &prepared, &mut kernel.outputs)?;
    let failed_followups = followups.len();
    let failed_routes_micros = failed_routes_started.elapsed().as_micros();
    let outbound = accounts.finish_entity_outbound(prepared, followups)?;
    let outbound_micros = phase_started.elapsed().as_micros();
    let phase_started = Instant::now();
    let (mut final_events, mut final_hashes, final_presigned) = collect_round_certification(
        &EntityRoundResult::default(),
        &outbound,
        std::mem::take(&mut kernel.local_events),
        &mut collisions,
    )?;
    final_hashes.extend(std::mem::take(&mut kernel.local_hashes_to_sign));
    ordered_events.append(&mut final_events);
    ordered_hashes.append(&mut final_hashes);
    for (hash, witness) in final_presigned {
        if ordered_presigned.insert(hash.clone(), witness).is_some() {
            return Err(ResidentEntityError::ManifestWitnessDuplicate(hash));
        }
    }
    let mut entity_frame_events = ordered_events;
    apply_collision_fixups(
        &mut entity_frame_events,
        &collisions,
        &kernel.proposal_tx_origins,
    )?;
    let secondary_hashes = ordered_hashes;
    let presigned_manifest = ordered_presigned;
    // Worklist membership alone is not a TS history touch: an Entity envelope
    // update can freeze an initially-proposable Account before the proposal
    // phase. Local admissions (including same-round HTLC followups) are always
    // explicit storage changes. Proposal attempts count only when TS returns
    // `accountChanged`: Proposed, or Idle after removing rejected txs. A fully
    // deferred/pending/forced-ACK Idle row leaves Account storage unchanged.
    touch_candidates.extend(outbound.admissions.iter().map(|row| row.account_id));
    touch_candidates.extend(
        outbound
            .proposals
            .iter()
            .filter(|row| proposal_records_account_change(row))
            .map(|row| row.account_id),
    );
    let actual_touches = inbound
        .touched
        .iter()
        .chain(outbound.touched.iter())
        .map(|(account_id, _)| *account_id)
        .collect::<BTreeSet<_>>();
    // A moved Account leaf is broader than a TS Runtime storage touch:
    // Entity-owned envelope writes (for example `prepareDispute`) are already
    // committed by the Entity root but do not create Account-history rows.
    // Only transitions that TS exposes through `accountChanges` or an actual
    // Account proposal are candidates; the intersection rejects no-op work.
    let account_touch_order = canonical_account_touch_order(touch_candidates, &actual_touches);
    let finalize_micros = phase_started.elapsed().as_micros();
    report_resident_round_profile(
        [
            inbound_micros,
            commits_micros,
            entity_apply_micros,
            book_stage_micros,
            j_ingress_micros,
            worklist_micros,
            proposable_micros,
            prepare_outbound_micros,
            failed_routes_micros,
            outbound_micros,
            finalize_micros,
        ],
        total_started.elapsed().as_micros(),
        account_ranges,
        local_operations,
        failed_followups,
        pending_settlement_hankos.len(),
    );
    let current_entity_id = kernel.state.entity_id.clone();
    let routed_entity_outputs = std::mem::take(&mut kernel.routed_entity_outputs)
        .into_iter()
        .map(|output| {
            output.bind_projected_target_signer(
                &current_entity_id,
                &request.expected_proposer_signer_id,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ResidentEntityCoreResult {
        state: kernel.state,
        outputs: kernel.outputs,
        entity_frame_events,
        secondary_hashes,
        presigned_manifest,
        inbound,
        outbound,
        non_mutating_wake_targets: kernel.non_mutating_wake_targets,
        routed_entity_outputs,
        j_outputs: kernel.j_outputs,
        account_touch_order,
        pending_settlement_hankos,
        proposal_work: kernel.proposal_work,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use num_bigint::BigInt;
    use xln_rscore_batch::{
        AccountAdmissionVerdict, AccountSeed, DroppedRow, EngineGeneration, EntityRoundResult,
        ProposalRow, ProposedRow,
    };
    use xln_rscore_engine::{
        AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica,
        AccountState, BoardDelays, DepositoryAddress, DisputeDraft, OutboundAck, ReceiverClock,
        SigningIdentity, SwapMarketPolicy, TokenId, WatchSeed, derive_signer_key,
    };

    use super::*;

    fn admitted_cross_j(kind: crate::EntityTxKind) -> crate::AdmittedLocalEntityTx {
        crate::AdmittedLocalEntityTx {
            signer_id: "signer".into(),
            board_epoch: 1,
            tx: crate::LocalEntityTx::CrossJurisdiction(
                crate::CanonicalEntityTx::from_frame_projection(
                    kind,
                    CanonicalValue::Object(Vec::new()),
                )
                .expect("canonical setup marker"),
            ),
        }
    }

    fn admitted_cross_j_runtime_output(kind: crate::EntityTxKind) -> crate::AdmittedLocalEntityTx {
        crate::AdmittedLocalEntityTx {
            signer_id: "target-signer".into(),
            board_epoch: 1,
            tx: crate::LocalEntityTx::RuntimeOutput(crate::CrossJurisdictionRuntimeOutput {
                source_entity_id: "source-entity".into(),
                source_signer_id: "source-signer".into(),
                target_entity_id: "target-entity".into(),
                entity_txs: vec![
                    crate::CanonicalEntityTx::from_frame_projection(
                        kind,
                        CanonicalValue::Object(Vec::new()),
                    )
                    .expect("canonical nested setup marker"),
                ],
            }),
        }
    }

    #[test]
    fn cross_j_setup_predicate_matches_typescript_setup_kinds() {
        for kind in [
            crate::EntityTxKind::MaterializeCrossJurisdictionSwap,
            crate::EntityTxKind::MaterializeCrossJurisdictionClear,
            crate::EntityTxKind::RegisterCrossJurisdictionSwap,
        ] {
            assert!(frame_contains_cross_j_setup(&[
                ResidentEntityOperation::Local(vec![admitted_cross_j(kind)])
            ]));
            assert!(frame_contains_cross_j_setup(&[
                ResidentEntityOperation::Local(vec![admitted_cross_j_runtime_output(kind)])
            ]));
        }
        assert!(!frame_contains_cross_j_setup(&[
            ResidentEntityOperation::Local(vec![admitted_cross_j(
                crate::EntityTxKind::CrossJurisdictionFillNotice
            )])
        ]));
    }

    fn setup_barrier_test_accounts() -> (ResidentConsensusEngine, EntityId, AccountId) {
        const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
        const SIGNER: &str = "setup-barrier-owner";
        let signer = SigningIdentity::lazy_from_seed(SEED, SIGNER, 1, 1, BoardDelays::default())
            .expect("signer");
        let owner =
            EntityId::parse(&format!("0x{}", hex::encode(signer.entity_id()))).expect("owner");
        let peer = EntityId::parse(&format!("0x{}", "22".repeat(32))).expect("peer");
        let account_id = AccountId::from_bytes(*peer.as_bytes());
        let (left, right) = if owner < peer {
            (owner.clone(), peer)
        } else {
            (peer, owner.clone())
        };
        let identity = AccountIdentity::new(
            AccountDomain::new(
                31_337,
                DepositoryAddress::parse("0x8888888888888888888888888888888888888888")
                    .expect("depository"),
            )
            .expect("domain"),
            left,
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("identity");
        let replica = AccountReplica::new(
            owner.clone(),
            AccountState::new(
                identity,
                AccountDisputeConfig::new(10, 10).expect("dispute config"),
                Vec::new(),
            )
            .expect("state"),
        )
        .expect("replica");
        let consensus = AccountConsensus::new(replica);
        let seed = AccountSeed {
            account_id,
            replica: consensus.replica().clone(),
            consensus: Some(consensus.consensus_snapshot()),
        };
        let accounts = ResidentConsensusEngine::restore(
            EngineGeneration::from_bytes([0x53; 8]),
            1,
            0,
            derive_signer_key(SEED, SIGNER).expect("signer key"),
            SIGNER.into(),
            Arc::new(SwapMarketPolicy::default()),
            vec![seed],
        )
        .expect("resident accounts");
        (accounts, owner, account_id)
    }

    fn enter_setup_barrier_test_round(
        accounts: &mut ResidentConsensusEngine,
        owner: &EntityId,
        expected_accounts_root: [u8; 32],
    ) {
        accounts
            .entity_inbound(EntityInboundRequest {
                owner_entity_id: *owner.as_bytes(),
                expected_accounts_root,
                clock: ReceiverClock {
                    entity_timestamp: 1_700_000_000_000,
                    finalized_j_height: 100,
                },
                owning_entity_is_hub: false,
                rows: Vec::new(),
                post_accounts: false,
            })
            .expect("enter Account round");
    }

    fn setup_barrier_test_outbound(
        owner: &EntityId,
        proposal_work: Vec<SelectedAccountProposalRow>,
    ) -> EntityOutboundRequest {
        EntityOutboundRequest {
            owner_entity_id: *owner.as_bytes(),
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            timestamp: 1_700_000_000_000,
            j_height: 100,
            creates: Vec::new(),
            envelope_updates: Vec::new(),
            unsigned_settlement_txs: Vec::new(),
            proposal_work,
            checkpoint_due: false,
            post_accounts: false,
        }
    }

    #[test]
    fn setup_barrier_keeps_admissions_and_releases_the_next_account_work_frame() {
        let (mut accounts, owner, account) = setup_barrier_test_accounts();
        let admitted = AccountTx::AddDelta {
            token_id: TokenId::new(7).expect("token"),
        };
        let base_root = accounts.accounts_root();
        enter_setup_barrier_test_round(&mut accounts, &owner, base_root);
        let held = select_cross_j_proposal_work(
            &mut accounts,
            &owner.to_string(),
            vec![(account, vec![admitted.clone()], false)],
            &BTreeSet::new(),
            &[],
            true,
        )
        .expect("setup barrier selection");
        assert_eq!(held[0].1, vec![admitted]);
        assert_eq!(held[0].2, BatchAccountSelection::WaitForSibling);
        let setup_result = accounts
            .entity_outbound(setup_barrier_test_outbound(&owner, held))
            .expect("setup-frame outbound");
        assert!(matches!(
            setup_result.admissions[0].verdict,
            AccountAdmissionVerdict::Admitted { count: 1 }
        ));
        assert!(setup_result.proposals.is_empty());
        accounts.complete_entity_round();

        enter_setup_barrier_test_round(&mut accounts, &owner, setup_result.accounts_root);
        let released = select_cross_j_proposal_work(
            &mut accounts,
            &owner.to_string(),
            vec![(account, Vec::new(), false)],
            &BTreeSet::new(),
            &[],
            false,
        )
        .expect("next-frame selection");
        assert_eq!(released[0].2, BatchAccountSelection::WholeMempool);
        let next_result = accounts
            .entity_outbound(setup_barrier_test_outbound(&owner, released))
            .expect("next-frame outbound");
        assert_eq!(next_result.proposals.len(), 1);
        assert!(next_result.proposals[0].proposed.is_some());
    }

    #[test]
    fn local_opening_view_is_required_except_for_same_round_creation() {
        let existing = account_id(&format!("0x{}", "11".repeat(32))).expect("existing");
        let created = account_id(&format!("0x{}", "22".repeat(32))).expect("created");
        let missing = account_id(&format!("0x{}", "33".repeat(32))).expect("missing");
        let mut mempools = HashMap::from([(
            existing,
            vec![AccountTx::SwapCancelRequest {
                offer_id: "ordinary".into(),
            }],
        )]);
        let created_accounts = BTreeSet::from([created]);

        assert_eq!(
            take_local_opening_mempool(&mut mempools, existing, &created_accounts)
                .expect("existing view")
                .len(),
            1
        );
        assert!(
            take_local_opening_mempool(&mut mempools, created, &created_accounts)
                .expect("same-round create")
                .is_empty()
        );
        assert!(matches!(
            take_local_opening_mempool(&mut mempools, missing, &created_accounts),
            Err(ResidentEntityError::CrossJLocalAccountViewMissing { .. })
        ));
    }

    #[test]
    fn rollback_status_events_match_typescript_order_and_text() {
        let mut events = Vec::new();
        append_rollback_events(
            &mut events,
            4,
            Some(xln_rscore_engine::RolledBackProposal {
                height: 4,
                restored: 1,
                proposed: 1,
            }),
        );
        assert_eq!(
            events,
            vec![
                EntityFrameEvent::Status {
                    message: "🔄 ROLLBACK: Discarded our frame 4, restored 1/1 txs to mempool"
                        .into(),
                },
                EntityFrameEvent::Status {
                    message: "📥 Accepted LEFT's frame 4 (we are RIGHT, deterministic tiebreaker)"
                        .into(),
                },
            ],
        );
    }

    #[test]
    fn collision_winner_status_events_match_typescript_order_and_text() {
        let mut events = Vec::new();
        append_collision_ignored_events(&mut events, 4, 2);
        assert_eq!(
            events,
            vec![
                EntityFrameEvent::Status {
                    message: "📤 LEFT-WINS: Ignored RIGHT's frame 4 (waiting for their ACK)".into(),
                },
                EntityFrameEvent::Status {
                    message: "⚠️ LEFT has 2 pending txs while waiting for RIGHT's ACK".into(),
                },
            ],
        );
    }

    #[test]
    fn proposal_work_preserves_h324_first_touch_output_order() {
        let first =
            account_id("0x08286d512d51f32c654f7fba4570fe654d1042bf327218e8811040bdae81ec74")
                .expect("first H324 target");
        let second =
            account_id("0xb08ede7cef128e8ea974eb0cafb00b35127a2563f4f08bab4c1b7ef0b26fdb12")
                .expect("second H324 target");
        let post_stage_membership_order =
            vec![(second, Vec::new(), false), (first, Vec::new(), true)];

        let ordered =
            order_proposal_work_by_first_touch(post_stage_membership_order, &[], &[first, second])
                .expect("positional proposal order");

        assert_eq!(
            ordered
                .iter()
                .map(|(account_id, _, _)| account_text(*account_id))
                .collect::<Vec<_>>(),
            vec![account_text(first), account_text(second)],
        );
        assert!(ordered[0].2, "the first-touch forced ACK keeps its slot");
    }

    #[test]
    fn envelope_only_leaf_change_is_not_a_runtime_account_history_touch() {
        let envelope_only = AccountId::from_bytes([0x11; 32]);
        let inbound_account = AccountId::from_bytes([0x22; 32]);
        let proposed_account = AccountId::from_bytes([0x33; 32]);
        // `changed` is the Account-forest evidence: all three leaves moved and
        // therefore all three contribute to the committed Entity root.
        let changed = BTreeSet::from([envelope_only, inbound_account, proposed_account]);

        // TS storageChanges names the genuine Account input and proposal, but
        // not an Entity-owned ReplaceDisputeLifecycle envelope mutation.
        let touches = canonical_account_touch_order(
            [inbound_account, proposed_account, inbound_account],
            &changed,
        );

        assert_eq!(touches, vec![inbound_account, proposed_account]);
        assert!(!touches.contains(&envelope_only));
    }

    #[test]
    fn runtime_account_history_touch_requires_an_actual_leaf_change() {
        let changed_input = AccountId::from_bytes([0x44; 32]);
        let no_op_proposal = AccountId::from_bytes([0x55; 32]);
        let changed = BTreeSet::from([changed_input]);

        assert_eq!(
            canonical_account_touch_order([changed_input, no_op_proposal], &changed),
            vec![changed_input],
        );
    }

    #[test]
    fn one_entity_tx_account_changes_match_typescript_sorted_unique_order() {
        let lower = AccountId::from_bytes([0x11; 32]);
        let higher = AccountId::from_bytes([0xee; 32]);
        assert_eq!(
            canonical_entity_tx_account_changes([higher, lower, higher]),
            vec![lower, higher],
        );
    }

    #[test]
    fn idle_proposal_records_only_removed_transactions_as_account_changes() {
        let row = |disposition| ProposalRow {
            account_id: AccountId::from_bytes([0x66; 32]),
            outbound_input: None,
            proposed: None,
            dropped: vec![DroppedRow {
                index: 0,
                tx_digest: [0x77; 32],
                code: "TEST",
                message: "test".into(),
                disposition,
            }],
            failed_htlc_locks: Vec::new(),
        };

        assert!(!proposal_records_account_change(&row(
            Disposition::Deferred
        )));
        assert!(proposal_records_account_change(&row(Disposition::Removed)));
    }

    fn pending_route(hash_byte: u8) -> crate::PaybookEntry {
        crate::PaybookEntry {
            hashlock: format!("0x{}", format!("{hash_byte:02x}").repeat(32)),
            description: None,
            token_id: Some(1),
            amount: Some(BigInt::from(1)),
            started_at_ms: Some(1),
            originated: true,
            inbound_entity: None,
            outbound_entity: None,
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: None,
            created_timestamp: 1,
        }
    }

    #[test]
    fn paybook_hashlocks_create_independent_stage_two_jobs() {
        let mut changes = PaybookChanges::default();
        for hash_byte in [0x00, 0x7f, 0xff] {
            changes.put(pending_route(hash_byte)).expect("route");
        }
        let slots = partition_paybook_pending(changes.into_pending()).expect("slots");
        let active = slots
            .iter()
            .enumerate()
            .filter_map(|(slot, rows)| (!rows.is_empty()).then_some(slot))
            .collect::<Vec<_>>();

        assert_eq!(active, vec![0x00, 0x7f, 0xff]);
    }

    #[test]
    fn transition_accumulator_preserves_uncommitted_paybook_writes() {
        let hashlock = format!("0x{}", "ab".repeat(32));
        let state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 1_000);
        let mut paybook_changes = PaybookChanges::default();
        paybook_changes
            .put(crate::PaybookEntry {
                hashlock: hashlock.clone(),
                description: None,
                token_id: Some(1),
                amount: Some(BigInt::from(10)),
                started_at_ms: Some(1_000),
                originated: true,
                inbound_entity: None,
                outbound_entity: Some(format!("0x{}", "22".repeat(32))),
                inbound_settled: false,
                outbound_settled: false,
                secret: None,
                secret_ack_pending: false,
                secret_ack_started_at: None,
                secret_ack_deadline_at: None,
                pending_fee: None,
                created_timestamp: 1_000,
            })
            .expect("pending route");
        let transition = crate::kernel::EntityTransitionResult {
            state,
            account_creates: Vec::new(),
            proposal_work: Vec::new(),
            proposal_origins: Vec::new(),
            proposal_tx_origins: Vec::new(),
            outputs: Vec::new(),
            local_events: Vec::new(),
            non_mutating_wake_targets: Vec::new(),
            routed_entity_outputs: Vec::new(),
            j_outputs: Vec::new(),
            local_hashes_to_sign: Vec::new(),
            account_envelope_mutations: Vec::new(),
            paybook_changes,
            orderbook_deltas: Vec::new(),
        };
        let mut accumulated = EntityTransitionAccumulator::default();
        let state = accumulated.merge(transition);

        assert!(
            state
                .paybook
                .entry(&hashlock)
                .expect("state read")
                .is_none()
        );
        assert!(
            accumulated
                .paybook_changes
                .entry(&state, &hashlock)
                .expect("overlay read")
                .is_some()
        );
    }

    #[test]
    fn committed_settlement_transition_requests_the_post_commit_account_view() {
        let peer = format!("0x{}", "22".repeat(32));
        let commit = OrderedAccountCommit {
            account_id: peer,
            domain: AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "33".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            scope: JurisdictionScope::Same,
            committed_via_new_frame: true,
            frame_state_hash: format!("0x{}", "44".repeat(32)),
            frame_height: 2,
            frame_timestamp: 2,
            inbound_position: 0,
            transitions: vec![CommittedAccountTransition {
                tx: AccountTx::SettleTransition {
                    data: CanonicalValue::Object(vec![]),
                },
                outputs: Vec::new(),
            }],
        };
        let requests = local_financial_view_requests(
            &EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 2),
            &[],
            &[commit],
            &DeterministicContext::hlt_default(),
        )
        .expect("view request");
        assert_eq!(requests.len(), 1);
    }

    #[test]
    fn certified_bundled_ack_dispute_does_not_reenter_the_entity_hanko_manifest() {
        let account_id = AccountId::from_bytes([0xaa; 32]);
        let dispute = DisputeDraft {
            hanko: Some(vec![0x24]),
            hash: [0x22; 32],
            proof_body_hash: [0x23; 32],
            nonce: 4,
            proposer_is_left: true,
        };
        let proposed = ProposedRow {
            frame_height: 2,
            state_hash: [0x11; 32],
            signature: [0x41; 65],
            hanko: vec![0x42],
            dispute_signature: None,
            dispute_hanko: None,
            dispute: None,
            events: Vec::new(),
            outputs_by_tx: std::sync::Arc::new(Vec::new()),
            bundled_ack: Some(OutboundAck {
                height: 1,
                frame_hash: [0x51; 32],
                frame_hanko: vec![0x52],
                dispute: Some(dispute.clone()),
            }),
        };
        let outbound = EntityRoundResult {
            proposals: vec![ProposalRow {
                account_id,
                outbound_input: None,
                proposed: Some(proposed),
                failed_htlc_locks: Vec::new(),
                dropped: Vec::new(),
            }],
            ..EntityRoundResult::default()
        };
        let (_, hashes, _) = collect_round_certification(
            &EntityRoundResult::default(),
            &outbound,
            Vec::new(),
            &mut Vec::new(),
        )
        .expect("manifest");
        assert!(!hashes.iter().any(|entry| {
            entry.hash == hex_prefixed(&dispute.hash)
                && entry.kind == HashType::Dispute
                && entry.context.ends_with(":ack-dispute")
        }));
    }
}
