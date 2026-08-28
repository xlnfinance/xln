use std::collections::VecDeque;

use serde_json::Value;
use xln_rscore_protocol::CanonicalValue;

use super::{
    AppliedRuntimeInput, RuntimeEntityInput, RuntimeFrameContext, RuntimeInput, RuntimeLimits,
    RuntimeMachineError, RuntimeMempool, RuntimeTx,
};

pub struct SelectedRuntimeFrame {
    pub runtime_txs: Vec<RuntimeTx>,
    pub entity_inputs: Vec<RuntimeEntityInput>,
    pub frame: RuntimeFrameContext,
    pub receipt: AppliedRuntimeInput,
}

fn checked_next(current: usize, added: usize) -> Result<usize, RuntimeMachineError> {
    current
        .checked_add(added)
        .ok_or(RuntimeMachineError::InputCountOverflow)
}

fn require_capacity(
    lane: &'static str,
    actual: usize,
    limit: usize,
) -> Result<(), RuntimeMachineError> {
    if actual > limit {
        return Err(RuntimeMachineError::MempoolCapacity {
            lane,
            actual,
            limit,
        });
    }
    Ok(())
}

/// Validate the whole ingress before appending any of it. A rejected batch
/// cannot leave a valid prefix in the Runtime FIFO.
pub fn enqueue_runtime_input(
    mempool: &mut RuntimeMempool,
    input: &mut RuntimeInput,
    limits: RuntimeLimits,
) -> Result<(), RuntimeMachineError> {
    if let Some(RuntimeTx::Unsupported { kind }) = input
        .runtime_txs
        .iter()
        .find(|tx| matches!(tx, RuntimeTx::Unsupported { .. }))
    {
        return Err(RuntimeMachineError::UnsupportedRuntimeTx { kind: kind.clone() });
    }
    for entity_input in &input.entity_inputs {
        if entity_input.canonical_wire_bytes() == 0 {
            return Err(RuntimeMachineError::EmptyCanonicalWire);
        }
    }
    let runtime_txs = checked_next(mempool.runtime_txs.len(), input.runtime_txs.len())?;
    let entity_inputs = checked_next(mempool.entity_inputs.len(), input.entity_inputs.len())?;
    let total = checked_next(runtime_txs, entity_inputs)?;
    require_capacity("runtimeTxs", runtime_txs, limits.max_mempool_runtime_txs)?;
    require_capacity(
        "entityInputs",
        entity_inputs,
        limits.max_mempool_entity_inputs,
    )?;
    require_capacity("total", total, limits.max_mempool_total_items)?;

    mempool.runtime_txs.extend(input.runtime_txs.drain(..));
    mempool.entity_inputs.extend(input.entity_inputs.drain(..));
    if !mempool.is_empty() {
        mempool.queued_at = Some(match mempool.queued_at {
            Some(queued_at) => queued_at.max(input.frame.timestamp),
            None => input.frame.timestamp,
        });
    }
    Ok(())
}

fn cap_reached(current: usize, added: usize, cap: usize) -> Result<bool, RuntimeMachineError> {
    if cap == 0 {
        return Ok(false);
    }
    Ok(checked_next(current, added)? > cap)
}

/// Drain one whole-input FIFO prefix. An Entity input is atomic: no Account
/// row is split away from the envelope that authenticated and ordered it.
pub fn select_runtime_frame(
    mempool: &mut RuntimeMempool,
    limits: RuntimeLimits,
    entity_height: u64,
    mut frame: RuntimeFrameContext,
) -> Result<Option<SelectedRuntimeFrame>, RuntimeMachineError> {
    if mempool.is_empty() {
        return Ok(None);
    }
    frame.timestamp = mempool.queued_at.unwrap_or(frame.timestamp);
    let runtime_txs = mempool.runtime_txs.drain(..).collect::<Vec<_>>();
    let height_deferred =
        apply_entity_height_durability_barrier(&mut mempool.entity_inputs, entity_height);
    let mut selected = Vec::new();
    let mut account_inputs = 0_usize;
    let mut wire_bytes = 0_usize;

    while let Some(front) = mempool.entity_inputs.front() {
        let next_input_count = checked_next(selected.len(), 1)?;
        let next_account_inputs = checked_next(account_inputs, front.account_input_count())?;
        let next_wire_bytes = wire_bytes
            .checked_add(front.canonical_wire_bytes())
            .ok_or(RuntimeMachineError::WireBytesOverflow)?;
        let exceeds = cap_reached(selected.len(), 1, limits.max_entity_inputs_per_frame)?
            || cap_reached(
                account_inputs,
                front.account_input_count(),
                limits.max_account_inputs_per_frame,
            )?
            || cap_reached(
                wire_bytes,
                front.canonical_wire_bytes(),
                limits.max_entity_wire_bytes_per_frame,
            )?;
        if exceeds {
            if selected.is_empty() {
                if limits.max_entity_wire_bytes_per_frame > 0
                    && next_wire_bytes > limits.max_entity_wire_bytes_per_frame
                {
                    return Err(RuntimeMachineError::HeadWireUnfittable {
                        actual: next_wire_bytes,
                        limit: limits.max_entity_wire_bytes_per_frame,
                    });
                }
                return Err(RuntimeMachineError::HeadAccountInputsUnfittable {
                    actual: next_account_inputs,
                    limit: limits.max_account_inputs_per_frame,
                });
            }
            break;
        }
        let Some(input) = mempool.entity_inputs.pop_front() else {
            break;
        };
        selected.push(input);
        account_inputs = next_account_inputs;
        wire_bytes = next_wire_bytes;
        if limits.max_entity_inputs_per_frame > 0
            && next_input_count == limits.max_entity_inputs_per_frame
        {
            break;
        }
    }

    // TypeScript prepends each cap overflow ahead of the already-deferred
    // barrier tail, so the height tail keeps its position behind whatever the
    // frame caps sent back. The single Runtime FIFO stays the only store.
    mempool.entity_inputs.extend(height_deferred);
    if mempool.is_empty() {
        mempool.queued_at = None;
    }
    Ok(Some(SelectedRuntimeFrame {
        runtime_txs,
        receipt: AppliedRuntimeInput {
            entity_inputs: selected.len(),
            account_inputs,
            canonical_wire_bytes: wire_bytes,
            entity_txs_selected: 0,
            entity_txs_pending: 0,
            wake: None,
        },
        entity_inputs: selected,
        frame,
    }))
}

/// TS `entityInputMergeKey` over the resident input domain. Entity id and
/// signer id are fixed for this replica and normalized at decode, and a
/// resident input carries no atomic cross-j pair, J-prefix attestation,
/// precommit bundle or leader vote, so only the transaction-origin suffix
/// varies: an input without `entityTxs` shares the bare lane key, otherwise
/// the authenticated `from` provenance separates it.
fn merge_group(input: &RuntimeEntityInput) -> Option<String> {
    if !input.has_entity_txs() {
        return None;
    }
    Some(
        input
            .canonical()
            .get("from")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_lowercase(),
    )
}

/// A `scheduledWake` is computed from Entity-frame-start state. Its kind fixes
/// the transaction shape, so the retained wire data is the whole identity TS
/// compares.
fn scheduled_wake(input: &RuntimeEntityInput) -> Option<&CanonicalValue> {
    input.scheduled_wake()
}

/// Port of `core/runtime/mempool/entity-height-barrier.ts` for the single
/// resident entity+signer lane: one Runtime frame may make at most one new
/// certified Entity height durable. H and H+1 in one WAL frame would make
/// certified lineage unreplayable, so the tail stays in the Runtime FIFO and
/// is applied only after H is durably saved.
///
/// Resident admission rejects `proposedFrame` and `hashPrecommits` by field
/// name, so no input names an exact height: every one of them is a candidate
/// for exactly `entity_height + 1`, and the TS certificate-lane and
/// future-height branches cannot be reached here. What does occur is a second
/// wake: two different `scheduledWake` bodies inside one merge group were
/// computed from two different Entity frame starts, which closes the lane and
/// defers the whole remaining tail in arrival order.
fn apply_entity_height_durability_barrier(
    inputs: &mut VecDeque<RuntimeEntityInput>,
    entity_height: u64,
) -> VecDeque<RuntimeEntityInput> {
    let mut deferred = VecDeque::new();
    if entity_height.checked_add(1).is_none() {
        return deferred;
    }
    let mut selected = VecDeque::with_capacity(inputs.len());
    let mut accepted_group: Option<Option<String>> = None;
    let mut accepted_wake: Option<CanonicalValue> = None;
    let mut closed = false;
    while let Some(input) = inputs.pop_front() {
        if closed {
            deferred.push_back(input);
            continue;
        }
        let group = merge_group(&input);
        let wake = scheduled_wake(&input);
        match accepted_group.as_ref() {
            None => {
                accepted_wake = wake.cloned();
                accepted_group = Some(group);
            }
            // A distinct merge group on a lane that carries no height
            // certificate still collapses into this Entity frame.
            Some(accepted) if *accepted != group => {}
            Some(_) => match (wake, accepted_wake.as_ref()) {
                (Some(wake), Some(accepted)) if wake != accepted => {
                    closed = true;
                    deferred.push_back(input);
                    continue;
                }
                (Some(wake), None) => accepted_wake = Some(wake.clone()),
                _ => {}
            },
        }
        selected.push_back(input);
    }
    *inputs = selected;
    deferred
}
