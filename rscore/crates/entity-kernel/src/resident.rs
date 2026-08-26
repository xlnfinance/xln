//! Resident Entity+Account composition with no intermediate process calls.
//!
//! One call performs the canonical two Account visits: peer inputs enter the
//! resident Account shards, committed transactions feed the Entity paybook and
//! orderbook, and the resulting Account transactions leave through the same
//! shards as signed proposals. The parent supplies its previous Account root
//! on the next call; that root implicitly accepts or discards the prior
//! candidate, so this API has no commit/abort messages.

use std::collections::BTreeSet;

use thiserror::Error;
use xln_rscore_batch::{
    AccountId, AccountInputVerdict, BatchError, EntityInboundRequest, EntityOutboundRequest,
    EntityRoundResult, FailedHtlcRoute, ResidentConsensusEngine,
};
use xln_rscore_engine::{AccountOutput, CommittedFrameEvidence, EntityId};

use crate::commitment::compute_commitments;
use crate::{
    CommittedAccountTransition, DeterministicContext, EntityKernelCommitments, EntityKernelError,
    EntityKernelOutput, EntityStateSlice, JurisdictionScope, OrderedAccountCommit,
    apply_entity_kernel,
};

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
}

/// Exact result of the fused Entity+Account transition. `inbound` and
/// `outbound` remain separate evidence so parity diagnostics can identify the
/// phase without adding another execution path.
pub struct ResidentEntityResult {
    pub state: EntityStateSlice,
    pub outputs: Vec<EntityKernelOutput>,
    pub commitments: EntityKernelCommitments,
    pub inbound: EntityRoundResult,
    pub outbound: EntityRoundResult,
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
    let mut active = proposal_accounts.iter().copied().collect::<BTreeSet<_>>();
    let mut selected = std::collections::BTreeMap::<[u8; 32], FailedHtlcRoute>::new();
    let mut changed = true;
    while changed {
        changed = false;
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
            let outbound_account_id = account_id(outbound_entity)?;
            if !active.contains(&outbound_account_id) {
                continue;
            }
            let inbound_account_id = account_id(inbound_entity)?;
            let hashlock = digest32(hashlock)?;
            selected.entry(hashlock).or_insert_with(|| FailedHtlcRoute {
                hashlock,
                outbound_account_id,
                outbound_lock_id: outbound_lock_id.clone(),
                inbound_account_id,
                inbound_lock_id: inbound_lock_id.clone(),
            });
            if active.insert(inbound_account_id) {
                changed = true;
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
    let derived_hash = evidence
        .frame
        .hash()
        .map_err(|error| ResidentEntityError::FrameHash {
            detail: error.to_string(),
        })?;
    if &derived_hash != state_hash {
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

fn ordered_commits(
    inbound: &EntityRoundResult,
) -> Result<Vec<OrderedAccountCommit>, ResidentEntityError> {
    let mut commits = Vec::new();
    for row in &inbound.applied {
        collect_verdict_commits(row.account_id, &row.verdict, &mut commits)?;
    }
    Ok(commits)
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
        let Some(route) = state.htlc_routes.remove(&hashlock) else {
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
    mut state: EntityStateSlice,
    request: ResidentEntityRequest,
    context: &DeterministicContext,
) -> Result<ResidentEntityResult, ResidentEntityError> {
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
    state.last_finalized_j_height = request.outbound_j_height;
    let inbound = accounts.entity_inbound(request.inbound)?;
    for created in &inbound.created_accounts {
        state
            .known_accounts
            .insert(account_text(created.account_id));
    }
    let commits = ordered_commits(&inbound)?;
    let mut kernel = apply_entity_kernel(state, &commits, context)?;

    let mut admits = Vec::with_capacity(kernel.proposal_work.len());
    let mut propose = accounts
        .proposable_account_ids()?
        .into_iter()
        .collect::<BTreeSet<_>>();
    for work in &kernel.proposal_work {
        let target = account_id(&work.account_id)?;
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
    let failed_htlc_routes = failed_route_closure(&kernel.state, &propose)?;
    let outbound = accounts.entity_outbound(EntityOutboundRequest {
        owner_entity_id,
        timestamp: request.outbound_timestamp,
        j_height: request.outbound_j_height,
        creates: Vec::new(),
        admits,
        propose,
        materialize: materialize.into_iter().collect(),
        failed_htlc_routes,
        checkpoint_due: request.checkpoint_due,
        post_accounts: request.post_accounts,
    })?;
    apply_failed_proposal_routes(&mut kernel.state, &outbound, &mut kernel.outputs);
    kernel.commitments =
        compute_commitments(&kernel.state, &kernel.proposal_work, &kernel.outputs)?;
    Ok(ResidentEntityResult {
        state: kernel.state,
        outputs: kernel.outputs,
        commitments: kernel.commitments,
        inbound,
        outbound,
    })
}
