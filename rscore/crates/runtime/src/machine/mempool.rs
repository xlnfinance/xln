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
    if let Some(tx) = input.runtime_txs.first() {
        let RuntimeTx::Unsupported { kind } = tx;
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
    mut frame: RuntimeFrameContext,
) -> Result<Option<SelectedRuntimeFrame>, RuntimeMachineError> {
    if mempool.is_empty() {
        return Ok(None);
    }
    frame.timestamp = mempool.queued_at.unwrap_or(frame.timestamp);
    let runtime_txs = mempool.runtime_txs.drain(..).collect::<Vec<_>>();
    prioritize_protocol_inputs(&mut mempool.entity_inputs);
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

    if mempool.is_empty() {
        mempool.queued_at = None;
    }
    Ok(Some(SelectedRuntimeFrame {
        runtime_txs,
        receipt: AppliedRuntimeInput {
            entity_inputs: selected.len(),
            account_inputs,
            canonical_wire_bytes: wire_bytes,
            wake: None,
        },
        entity_inputs: selected,
        frame,
    }))
}

/// TypeScript drains one flat queue, then stably moves Account/J protocol
/// inputs ahead of ordinary self-wakes before applying frame caps.
fn prioritize_protocol_inputs(inputs: &mut std::collections::VecDeque<RuntimeEntityInput>) {
    if !inputs.iter().any(RuntimeEntityInput::is_protocol)
        || inputs.iter().all(RuntimeEntityInput::is_protocol)
    {
        return;
    }
    let mut protocol = std::collections::VecDeque::new();
    let mut ordinary = std::collections::VecDeque::new();
    while let Some(input) = inputs.pop_front() {
        if input.is_protocol() {
            protocol.push_back(input);
        } else {
            ordinary.push_back(input);
        }
    }
    protocol.append(&mut ordinary);
    *inputs = protocol;
}
