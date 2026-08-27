//! Resident Entity+Account composition with no intermediate process calls.
//!
//! One call performs the canonical two Account visits: peer inputs enter the
//! resident Account shards, committed transactions feed the Entity paybook and
//! orderbook, and the resulting Account transactions leave through the same
//! shards as signed proposals. The parent supplies its previous Account root
//! on the next call; that root implicitly accepts or discards the prior
//! candidate, so this API has no commit/abort messages.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use thiserror::Error;
use xln_rscore_batch::{
    AccountId, AccountInputVerdict, BatchError, EntityInboundRequest, EntityOutboundRequest,
    EntityRoundResult, FailedHtlcRoute, ResidentConsensusEngine,
};
use xln_rscore_engine::{AccountOutput, CommittedFrameEvidence, EntityId};

use crate::commitment::compute_commitments;
use crate::frame_tx_effects::{apply_admitted_account_hooks, apply_committed_frame_hooks};
use crate::kernel::apply_entity_transitions;
use crate::local_financial::LocalAccountFinancialView;
use crate::paybook::terminate_route;
use crate::scheduler_runtime::validate_scheduled_wake;
use crate::{
    AccountProposalWork, CommittedAccountTransition, DeterministicContext, EntityFrameEvent,
    EntityKernelCommitments, EntityKernelError, EntityKernelOutput, EntityStateSlice,
    FinalizedJEventBatch, HashToSign, HashType, JurisdictionScope, LocalEntityFinancialTx,
    OrderedAccountCommit, ScheduledHookKind, ScheduledWake, SchedulerCommand, SchedulerError,
    apply_finalized_j_event_batches, execute_crontab,
};

fn profile_resident_round() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

fn report_resident_round_profile(phases: [u128; 9], total: u128) {
    if !profile_resident_round() {
        return;
    }
    eprintln!(
        "RSCORE_ENTITY_PHASE inbound={} commits={} entity={} worklist={} proposable={} prepareOutbound={} failedRoutes={} outbound={} finalize={} total={}",
        phases[0],
        phases[1],
        phases[2],
        phases[3],
        phases[4],
        phases[5],
        phases[6],
        phases[7],
        phases[8],
        total,
    );
}

#[derive(Debug, Error)]
pub enum ResidentEntityError {
    #[error(transparent)]
    Account(#[from] BatchError),
    #[error(transparent)]
    Entity(#[from] EntityKernelError),
    #[error("ENTITY_RESIDENT_OWNER_MISMATCH:state={state}:request={request}")]
    OwnerMismatch { state: String, request: String },
    #[error("ENTITY_RESIDENT_ACCOUNT_ID_INVALID:{value}")]
    InvalidAccountId { value: String },
    #[error("ENTITY_RESIDENT_FRAME_HASH:{detail}")]
    FrameHash { detail: String },
    #[error("ENTITY_RESIDENT_FRAME_HASH_MISMATCH:account={account_id}:height={height}")]
    FrameHashMismatch { account_id: String, height: u64 },
    #[error(
        "ENTITY_RESIDENT_OUTPUT_BINDING:account={account_id}:height={height}:txs={txs}:rows={rows}"
    )]
    OutputBinding {
        account_id: String,
        height: u64,
        txs: usize,
        rows: usize,
    },
    #[error("ENTITY_RESIDENT_OUTPUT_FLATTEN_MISMATCH:account={account_id}:height={height}")]
    OutputFlattenMismatch { account_id: String, height: u64 },
    #[error("ENTITY_RESIDENT_CRONTAB_MISSING")]
    CrontabMissing,
    #[error(transparent)]
    Scheduler(#[from] SchedulerError),
}

/// Runtime-owned facts that surround one Entity transition. Account state is
/// deliberately absent: replicas and their Patricia nodes already reside in
/// `ResidentConsensusEngine`.
pub struct ResidentEntityRequest {
    pub inbound: EntityInboundRequest,
    pub entity_height: u64,
    pub outbound_timestamp: u64,
    pub outbound_j_height: u64,
    pub checkpoint_due: bool,
    pub post_accounts: bool,
    pub scheduled_wake: Option<ScheduledWake>,
    pub expected_proposer_signer_id: String,
    pub hub_rebalance_has_pending_work: bool,
    /// One receipt-root-authenticated J prefix selected by Runtime priority.
    /// Runtime must place it in an Entity-only frame; this layer merges the
    /// resulting Account claims into the existing single outbound visit.
    pub finalized_j_events: Option<ResidentJEventProjection>,
    /// Strictly decoded local Entity financial work. AccountInput transactions
    /// stay in `inbound`; the Runtime decoder rejects interleaving so this
    /// phase exactly follows all inbound Account effects.
    pub local_financial_txs: Vec<LocalEntityFinancialTx>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentJEventProjection {
    pub scanned_through: u64,
    pub batches: Vec<FinalizedJEventBatch>,
    pub active_account_ids: BTreeSet<String>,
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
    pub inbound: EntityRoundResult,
    pub outbound: EntityRoundResult,
    /// Exact TS empty self EntityInputs emitted by local direct/swap handlers.
    /// They are non-mutating and unsigned, but their outbox slots are real.
    pub non_mutating_wake_targets: Vec<String>,
    /// Account leaves in canonical TS `storageChanges` first-touch order.
    /// Worker completion order is deliberately excluded: execution may run in
    /// parallel, while the Runtime frame hash commits deterministic input and
    /// Entity-transition order.
    pub account_touch_order: Vec<AccountId>,
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

fn local_financial_view_requests(
    state: &EntityStateSlice,
    txs: &[LocalEntityFinancialTx],
    context: &DeterministicContext,
) -> Result<Vec<(AccountId, Vec<xln_rscore_engine::TokenId>)>, ResidentEntityError> {
    let mut requested = BTreeMap::<AccountId, BTreeSet<xln_rscore_engine::TokenId>>::new();
    for tx in txs {
        let LocalEntityFinancialTx::HtlcPayment(tx) = tx else {
            continue;
        };
        let Some(prepared) = context.originated_htlcs.get(&tx.tx_hash) else {
            continue;
        };
        if !state.known_accounts.contains(&prepared.next_hop_entity_id) {
            continue;
        }
        requested
            .entry(account_id(&prepared.next_hop_entity_id)?)
            .or_default()
            .insert(tx.token_id);
    }
    Ok(requested
        .into_iter()
        .map(|(account_id, token_ids)| (account_id, token_ids.into_iter().collect()))
        .collect())
}

fn digest32(value: &str) -> Result<[u8; 32], ResidentEntityError> {
    let Some(payload) = value.strip_prefix("0x") else {
        return Err(ResidentEntityError::FrameHash {
            detail: value.to_string(),
        });
    };
    if payload.len() != 64 {
        return Err(ResidentEntityError::FrameHash {
            detail: value.to_string(),
        });
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16).map_err(|_| {
            ResidentEntityError::FrameHash {
                detail: value.to_string(),
            }
        })?;
    }
    Ok(output)
}

fn failed_route_closure(
    state: &EntityStateSlice,
    proposal_accounts: &[AccountId],
) -> Result<Vec<FailedHtlcRoute>, ResidentEntityError> {
    let mut routes_by_outbound =
        std::collections::BTreeMap::<AccountId, Vec<(&String, &String, &String, &String)>>::new();
    for (hashlock, route) in &state.htlc_routes {
        let (
            Some(outbound_entity),
            Some(outbound_lock_id),
            Some(inbound_entity),
            Some(inbound_lock_id),
        ) = (
            route.outbound_entity.as_ref(),
            route.outbound_lock_id.as_ref(),
            route.inbound_entity.as_ref(),
            route.inbound_lock_id.as_ref(),
        )
        else {
            continue;
        };
        routes_by_outbound
            .entry(account_id(outbound_entity)?)
            .or_default()
            .push((hashlock, outbound_lock_id, inbound_entity, inbound_lock_id));
    }
    let mut active = proposal_accounts.iter().copied().collect::<BTreeSet<_>>();
    let mut frontier = active.clone();
    let mut selected = std::collections::BTreeMap::<[u8; 32], FailedHtlcRoute>::new();
    while let Some(outbound_account_id) = frontier.pop_first() {
        for (hashlock, outbound_lock_id, inbound_entity, inbound_lock_id) in routes_by_outbound
            .get(&outbound_account_id)
            .into_iter()
            .flatten()
        {
            let inbound_account_id = account_id(inbound_entity)?;
            let hashlock = digest32(hashlock)?;
            selected.entry(hashlock).or_insert_with(|| FailedHtlcRoute {
                hashlock,
                outbound_account_id,
                outbound_lock_id: (*outbound_lock_id).clone(),
                inbound_account_id,
                inbound_lock_id: (*inbound_lock_id).clone(),
            });
            if active.insert(inbound_account_id) {
                frontier.insert(inbound_account_id);
            }
        }
    }
    Ok(selected.into_values().collect())
}

fn validate_effect_binding(
    account_id: &str,
    state_hash: &[u8; 32],
    flat_outputs: &[AccountOutput],
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
    if evidence
        .outputs_by_tx
        .iter()
        .flatten()
        .ne(flat_outputs.iter())
    {
        return Err(ResidentEntityError::OutputFlattenMismatch {
            account_id: account_id.to_string(),
            height: evidence.frame.height,
        });
    }
    Ok(())
}

fn ordered_commit(
    account_id: AccountId,
    state_hash: &[u8; 32],
    flat_outputs: &[AccountOutput],
    evidence: &CommittedFrameEvidence,
) -> Result<OrderedAccountCommit, ResidentEntityError> {
    let account_id = account_text(account_id);
    validate_effect_binding(&account_id, state_hash, flat_outputs, evidence)?;
    let transitions = evidence
        .frame
        .txs
        .iter()
        .cloned()
        .zip(evidence.outputs_by_tx.iter().cloned())
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
        frame_height: evidence.frame.height,
        frame_timestamp: evidence.frame.timestamp,
        transitions,
    })
}

fn collect_verdict_commits(
    account_id: AccountId,
    verdict: &AccountInputVerdict,
    commits: &mut Vec<OrderedAccountCommit>,
) -> Result<(), ResidentEntityError> {
    match verdict {
        AccountInputVerdict::FrameCommitted {
            state_hash,
            outputs,
            committed_frame,
            ..
        }
        | AccountInputVerdict::AckCommitted {
            state_hash,
            outputs,
            committed_frame,
            ..
        } => commits.push(ordered_commit(
            account_id,
            state_hash,
            outputs,
            committed_frame,
        )?),
        AccountInputVerdict::FrameAckApplied { ack, frame } => {
            // TS applies the ACK half before the peer-frame half.
            collect_verdict_commits(account_id, ack, commits)?;
            collect_verdict_commits(account_id, frame, commits)?;
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

fn collect_verdict_certification(
    account_id: AccountId,
    verdict: &AccountInputVerdict,
    events: &mut Vec<EntityFrameEvent>,
    hashes: &mut Vec<HashToSign>,
) {
    match verdict {
        AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            events: committed_events,
            ack_dispute,
            ..
        } => {
            append_status_events(events, committed_events);
            let counterparty = account_text(account_id);
            let suffix = counterparty
                .get(counterparty.len().saturating_sub(4)..)
                .unwrap_or(&counterparty);
            events.push(EntityFrameEvent::Status {
                message: format!("🤝 Accepted frame {height} from Entity {suffix}"),
            });
            hashes.push(HashToSign {
                hash: hex_prefixed(state_hash),
                kind: HashType::AccountFrame,
                context: account_hash_context(account_id, "ack", *height),
            });
            if let Some(dispute) = ack_dispute {
                hashes.push(HashToSign {
                    hash: hex_prefixed(&dispute.hash),
                    kind: HashType::Dispute,
                    context: dispute_hash_context(account_id, "ack-dispute"),
                });
            }
        }
        AccountInputVerdict::AckCommitted {
            events: committed_events,
            ..
        } => append_status_events(events, committed_events),
        AccountInputVerdict::FrameAckApplied { ack, frame } => {
            collect_verdict_certification(account_id, ack, events, hashes);
            collect_verdict_certification(account_id, frame, events, hashes);
        }
        _ => {}
    }
}

fn collect_round_certification(
    inbound: &EntityRoundResult,
    outbound: &EntityRoundResult,
    local_events: Vec<EntityFrameEvent>,
) -> (Vec<EntityFrameEvent>, Vec<HashToSign>) {
    let mut events = Vec::new();
    let mut hashes = Vec::new();
    for row in &inbound.applied {
        collect_verdict_certification(row.account_id, &row.verdict, &mut events, &mut hashes);
    }
    events.extend(local_events);
    for row in &outbound.proposals {
        let Some(proposed) = &row.proposed else {
            continue;
        };
        append_status_events(&mut events, &proposed.events);
        hashes.push(HashToSign {
            hash: hex_prefixed(&proposed.state_hash),
            kind: HashType::AccountFrame,
            context: account_hash_context(row.account_id, "frame", proposed.frame.height),
        });
        if let Some(dispute) = &proposed.dispute {
            hashes.push(HashToSign {
                hash: hex_prefixed(&dispute.hash),
                kind: HashType::Dispute,
                context: dispute_hash_context(row.account_id, "dispute"),
            });
        }
    }
    (events, hashes)
}

fn ordered_commits(
    inbound: &EntityRoundResult,
) -> Result<Vec<OrderedAccountCommit>, ResidentEntityError> {
    let mut commits = Vec::new();
    for row in &inbound.applied {
        collect_verdict_commits(row.account_id, &row.verdict, &mut commits)?;
    }
    Ok(commits)
}

fn apply_scheduled_wake(
    accounts: &mut ResidentConsensusEngine,
    state: &mut EntityStateSlice,
    wake: Option<&ScheduledWake>,
    expected_proposer_signer_id: &str,
    hub_rebalance_has_pending_work: bool,
) -> Result<Vec<SchedulerCommand>, ResidentEntityError> {
    let Some(wake) = wake else {
        return Ok(Vec::new());
    };
    let crontab = state
        .crontab
        .as_ref()
        .ok_or(ResidentEntityError::CrontabMissing)?;
    let mut requested_locks = BTreeMap::<AccountId, Vec<String>>::new();
    for hook in crontab
        .hooks
        .values()
        .filter(|hook| hook.trigger_at <= state.timestamp)
    {
        let (account, lock_id) = match &hook.kind {
            ScheduledHookKind::HtlcTimeout {
                account_id,
                lock_id,
            } => (account_id, lock_id),
            ScheduledHookKind::HtlcSecretAckTimeout {
                counterparty_entity_id,
                inbound_lock_id,
                ..
            } => (counterparty_entity_id, inbound_lock_id),
            _ => continue,
        };
        if state.known_accounts.contains(account) {
            requested_locks
                .entry(account_id(account)?)
                .or_default()
                .push(lock_id.clone());
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
    let due_secret_hooks = state
        .crontab
        .as_ref()
        .ok_or(ResidentEntityError::CrontabMissing)?
        .hooks
        .values()
        .filter(|hook| hook.trigger_at <= state.timestamp)
        .filter_map(|hook| match &hook.kind {
            ScheduledHookKind::HtlcSecretAckTimeout {
                hashlock,
                counterparty_entity_id,
                inbound_lock_id,
            } => Some((
                hashlock.clone(),
                counterparty_entity_id.clone(),
                inbound_lock_id.clone(),
            )),
            _ => None,
        })
        .collect::<Vec<_>>();
    for (hashlock, counterparty, inbound_lock_id) in due_secret_hooks {
        let Some(route) = state.htlc_routes.get(&hashlock) else {
            continue;
        };
        if !route.secret_ack_pending {
            continue;
        }
        if active_text.contains(&(counterparty, inbound_lock_id)) {
            secret_acks_requiring_dispute.insert(hashlock);
        } else {
            terminate_route(state, &hashlock);
        }
    }

    let execution = execute_crontab(
        state
            .crontab
            .as_ref()
            .ok_or(ResidentEntityError::CrontabMissing)?,
        wake,
        expected_proposer_signer_id,
        state.timestamp,
        hub_rebalance_has_pending_work,
        &active_text,
        &secret_acks_requiring_dispute,
    )?;
    state.crontab = Some(execution.crontab);
    Ok(execution.commands)
}

/// Proposal-time HTLC failures are Entity effects even though the failed
/// Account frame never commits. Account fixed-point processing already queues
/// the upstream resolve; this closes the matching paybook route in the same
/// fused call, exactly where TypeScript consumes `failedHtlcLocks`.
fn apply_failed_proposal_routes(
    state: &mut EntityStateSlice,
    outbound: &EntityRoundResult,
    outputs: &mut Vec<EntityKernelOutput>,
) {
    for failed in outbound
        .proposals
        .iter()
        .flat_map(|proposal| proposal.failed_htlc_locks.iter())
    {
        let hashlock = hex_prefixed(&failed.hashlock);
        let Some(route) = terminate_route(state, &hashlock) else {
            continue;
        };
        if let Some(lock_id) = route.outbound_lock_id.as_ref() {
            state.lock_book.remove(lock_id);
        }
        if route.inbound_entity.is_none() {
            outputs.push(EntityKernelOutput::HtlcFailed {
                entity_id: state.entity_id.clone(),
                hashlock,
                lock_id: route.outbound_lock_id,
                reason: failed.reason.clone(),
            });
        }
    }
}

/// Apply one Entity transition over resident Account shards.
pub fn apply_resident_entity_round(
    accounts: &mut ResidentConsensusEngine,
    state: EntityStateSlice,
    request: ResidentEntityRequest,
    context: &DeterministicContext,
) -> Result<ResidentEntityResult, ResidentEntityError> {
    apply_resident_entity_round_core(accounts, state, request, context)?
        .with_canonical_commitments()
}

/// Apply the production Entity transition without computing the additional
/// shadow paybook/orderbook/outbox digests. Runtime consensus commits the
/// canonical Entity sections instead.
pub fn apply_resident_entity_round_core(
    accounts: &mut ResidentConsensusEngine,
    mut state: EntityStateSlice,
    request: ResidentEntityRequest,
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
    state.height = request.entity_height;
    state.timestamp = request.outbound_timestamp;
    if let Some(wake) = request.scheduled_wake.as_ref() {
        validate_scheduled_wake(wake, &request.expected_proposer_signer_id, state.timestamp)?;
    }
    let mut touch_candidates = request
        .inbound
        .rows
        .iter()
        .map(|row| row.account_id)
        .collect::<Vec<_>>();
    let phase_started = Instant::now();
    let inbound = accounts.entity_inbound(request.inbound)?;
    let inbound_micros = phase_started.elapsed().as_micros();
    for created in &inbound.created_accounts {
        state
            .known_accounts
            .insert(account_text(created.account_id));
    }
    let local_account_views = accounts
        .local_financial_views(local_financial_view_requests(
            &state,
            &request.local_financial_txs,
            context,
        )?)?
        .into_iter()
        .map(|(account_id, view)| {
            (
                account_text(account_id),
                LocalAccountFinancialView {
                    active: view.active,
                    owner_out_capacity: view.owner_out_capacity,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let phase_started = Instant::now();
    let commits = ordered_commits(&inbound)?;
    apply_committed_frame_hooks(&mut state, &commits);
    let scheduled_commands = apply_scheduled_wake(
        accounts,
        &mut state,
        request.scheduled_wake.as_ref(),
        &request.expected_proposer_signer_id,
        request.hub_rebalance_has_pending_work,
    )?;
    let commits_micros = phase_started.elapsed().as_micros();
    let phase_started = Instant::now();
    let mut kernel = apply_entity_transitions(
        state,
        &commits,
        request.local_financial_txs,
        &local_account_views,
        context,
        &scheduled_commands,
    )?;
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
        let ingress = apply_finalized_j_event_batches(
            &mut kernel.state,
            j_events.scanned_through,
            &j_events.batches,
            &j_events.active_account_ids,
        )?;
        merge_proposal_work(&mut kernel.proposal_work, ingress.proposal_work);
    }
    let entity_micros = phase_started.elapsed().as_micros();

    let phase_started = Instant::now();
    let mut admits = Vec::with_capacity(kernel.proposal_work.len());
    let proposable_started = Instant::now();
    let mut propose = accounts
        .proposable_account_ids()?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let proposable_micros = proposable_started.elapsed().as_micros();
    let prepare_outbound_started = Instant::now();
    for work in &kernel.proposal_work {
        let target = account_id(&work.account_id)?;
        touch_candidates.push(target);
        admits.push((target, work.txs.clone()));
        propose.insert(target);
    }
    let propose = propose.into_iter().collect::<Vec<_>>();
    let mut materialize = inbound
        .touched
        .iter()
        .map(|(account_id, _)| *account_id)
        .collect::<BTreeSet<_>>();
    materialize.extend(propose.iter().copied());
    let prepare_outbound_micros = prepare_outbound_started.elapsed().as_micros();
    let failed_routes_started = Instant::now();
    let failed_htlc_routes = failed_route_closure(&kernel.state, &propose)?;
    let failed_routes_micros = failed_routes_started.elapsed().as_micros();
    let worklist_micros = phase_started.elapsed().as_micros();
    let phase_started = Instant::now();
    let outbound = accounts.entity_outbound(EntityOutboundRequest {
        owner_entity_id,
        timestamp: request.outbound_timestamp,
        j_height: kernel.state.last_finalized_j_height,
        creates: Vec::new(),
        admits,
        propose,
        materialize: materialize.into_iter().collect(),
        failed_htlc_routes,
        checkpoint_due: request.checkpoint_due,
        post_accounts: request.post_accounts,
    })?;
    let outbound_micros = phase_started.elapsed().as_micros();
    let phase_started = Instant::now();
    apply_admitted_account_hooks(
        &mut kernel.state,
        &kernel.proposal_work,
        &outbound.admissions,
    )?;
    apply_failed_proposal_routes(&mut kernel.state, &outbound, &mut kernel.outputs);
    let (entity_frame_events, secondary_hashes) =
        collect_round_certification(&inbound, &outbound, kernel.local_events);
    let actual_touches = inbound
        .touched
        .iter()
        .chain(outbound.touched.iter())
        .map(|(account_id, _)| *account_id)
        .collect::<BTreeSet<_>>();
    let mut seen_touches = BTreeSet::new();
    let mut account_touch_order = touch_candidates
        .into_iter()
        .filter(|account_id| actual_touches.contains(account_id))
        .filter(|account_id| seen_touches.insert(*account_id))
        .collect::<Vec<_>>();
    account_touch_order.extend(
        actual_touches
            .into_iter()
            .filter(|account_id| seen_touches.insert(*account_id)),
    );
    let finalize_micros = phase_started.elapsed().as_micros();
    report_resident_round_profile(
        [
            inbound_micros,
            commits_micros,
            entity_micros,
            worklist_micros,
            proposable_micros,
            prepare_outbound_micros,
            failed_routes_micros,
            outbound_micros,
            finalize_micros,
        ],
        total_started.elapsed().as_micros(),
    );
    Ok(ResidentEntityCoreResult {
        state: kernel.state,
        outputs: kernel.outputs,
        entity_frame_events,
        secondary_hashes,
        inbound,
        outbound,
        non_mutating_wake_targets: kernel.non_mutating_wake_targets,
        account_touch_order,
        proposal_work: kernel.proposal_work,
    })
}
