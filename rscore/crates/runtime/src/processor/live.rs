//! Single-writer live Runtime service.

use std::collections::VecDeque;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::transport::{
    DirectRuntimeIngress, DirectRuntimeIngressMetrics, InboundEntityInputs, PublicationBacklog,
    RuntimeTransportError,
};
use crate::{EntityInfraMaterializer, RuntimeEntityInput, RuntimeLiveInput};

use super::{DurableRuntimeProcessor, DurableRuntimeProcessorError, RuntimeProcessReport};

const TIMESTAMP_DRIFT_MS: u64 = 30_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const INBOUND_COALESCE_IDLE: Duration = Duration::from_millis(2);

/// Owns the authenticated socket queue, the one durable Runtime writer and
/// the Entity infrastructure materializer. Transport threads can only enqueue;
/// this object is the sole mutation path into R/E/A state.
pub struct ResidentRuntimeService {
    processor: DurableRuntimeProcessor,
    ingress: DirectRuntimeIngress,
    materializer: Box<dyn EntityInfraMaterializer>,
    finalized_j_height: u64,
    hub_rebalance_has_pending_work: bool,
    held_inbound: VecDeque<InboundEntityInputs>,
}

impl ResidentRuntimeService {
    pub fn new(
        mut processor: DurableRuntimeProcessor,
        ingress: DirectRuntimeIngress,
        materializer: Box<dyn EntityInfraMaterializer>,
    ) -> Result<Self, ResidentRuntimeServiceError> {
        let replica = processor.replica()?;
        let durable_runtime_id = replica.durable.runtime_id();
        let finalized_j_height = replica.state.finalized_j_height;
        if ingress.runtime_id() != durable_runtime_id {
            return Err(ResidentRuntimeServiceError::RuntimeId {
                durable: durable_runtime_id.into(),
                ingress: ingress.runtime_id().into(),
            });
        }
        processor.attach_inbound_sessions(ingress.sessions());
        // A crash can happen after fsync but before the best-effort socket
        // write. There is intentionally no transport receipt or delivered
        // marker: replay every durable outbox row from the checkpoint floor
        // before accepting new input and let bilateral Account consensus
        // de-duplicate an exact resend.
        processor.retry_publication()?;
        Ok(Self {
            processor,
            ingress,
            materializer,
            finalized_j_height,
            hub_rebalance_has_pending_work: false,
            held_inbound: VecDeque::new(),
        })
    }

    pub fn local_address(&self) -> std::net::SocketAddr {
        self.ingress.local_address()
    }

    pub fn runtime_id(&self) -> &str {
        self.ingress.runtime_id()
    }

    pub fn ingress_metrics(&self) -> DirectRuntimeIngressMetrics {
        self.ingress.metrics()
    }

    pub fn last_session_error(&self) -> Option<String> {
        self.ingress.last_session_error()
    }

    pub fn processor(&self) -> &DurableRuntimeProcessor {
        &self.processor
    }

    pub fn publication_backlog(&self) -> PublicationBacklog {
        self.processor.publication_backlog()
    }

    pub fn advance_finalized_j_height(
        &mut self,
        height: u64,
    ) -> Result<(), ResidentRuntimeServiceError> {
        if height < self.finalized_j_height {
            return Err(ResidentRuntimeServiceError::JHeightRegression {
                previous: self.finalized_j_height,
                next: height,
            });
        }
        self.finalized_j_height = height;
        Ok(())
    }

    pub fn set_hub_rebalance_pending(&mut self, pending: bool) {
        self.hub_rebalance_has_pending_work = pending;
    }

    /// Wait for one authenticated transport batch. A timeout still checks
    /// Account mempools and deterministic scheduled wakes; if neither is due,
    /// no Runtime frame or disk write is produced.
    ///
    /// Ready authenticated messages are coalesced into the largest whole-message
    /// FIFO prefix that fits one Runtime frame. Overflow remains bounded in RAM.
    pub fn process_next(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let available = self.available_frame_inputs()?;
        self.take_inbound_if_idle(timeout, available)?;
        self.processor.retry_publication()?;
        if self.processor.has_pending_publication() {
            return Ok(None);
        }
        let (entity_inputs, queued_at) = self.take_frame_inbound()?;
        self.process_entity_inputs_at(entity_inputs, queued_at, wall_clock_ms()?)
    }

    fn take_inbound_if_idle(
        &mut self,
        timeout: Duration,
        available: usize,
    ) -> Result<(), ResidentRuntimeServiceError> {
        let first_arrived = if self.held_inbound.is_empty() {
            match self.ingress.recv_timeout(timeout)? {
                Some(batch) => {
                    self.held_inbound.push_back(batch);
                    true
                }
                None => false,
            }
        } else {
            false
        };
        let mut held_inputs = self
            .held_inbound
            .iter()
            .map(|batch| batch.entity_inputs.len())
            .sum::<usize>();
        loop {
            while held_inputs < available
                && let Some(batch) = self.ingress.try_recv()?
            {
                held_inputs = held_inputs.saturating_add(batch.entity_inputs.len());
                self.held_inbound.push_back(batch);
            }
            if !first_arrived || held_inputs >= available {
                break;
            }
            // Stop after a short quiet gap, not a fixed delay from the first
            // socket. A burst spread across many reactors therefore becomes
            // one bounded Runtime frame instead of dozens of WAL fsyncs.
            let Some(batch) = self.ingress.recv_timeout(INBOUND_COALESCE_IDLE)? else {
                break;
            };
            held_inputs = held_inputs.saturating_add(batch.entity_inputs.len());
            self.held_inbound.push_back(batch);
        }
        Ok(())
    }

    fn available_frame_inputs(&self) -> Result<usize, ResidentRuntimeServiceError> {
        let replica = self.processor.replica()?;
        Ok(replica
            .limits
            .max_mempool_entity_inputs
            .saturating_sub(replica.mempool.entity_input_count()))
    }

    /// Move the largest whole-message FIFO prefix that fits the Runtime
    /// mempool. A transport envelope is never split, and overflow remains in
    /// the bounded RAM queue for the next durable frame.
    fn take_frame_inbound(
        &mut self,
    ) -> Result<(Vec<RuntimeEntityInput>, Option<u64>), ResidentRuntimeServiceError> {
        let available = self.available_frame_inputs()?;
        Ok(coalesce_inbound_prefix(&mut self.held_inbound, available))
    }

    /// Deterministic seam used by tests and replayed live traces. `now` is an
    /// external observation; the resolved timestamp is recorded in the WAL.
    pub fn process_batch_at(
        &mut self,
        batch: Option<InboundEntityInputs>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let queued_at = batch.as_ref().and_then(|batch| batch.ingress_timestamp);
        let entity_inputs = batch.map(|batch| batch.entity_inputs).unwrap_or_default();
        self.process_entity_inputs_at(entity_inputs, queued_at, now)
    }

    /// Commit locally submitted Entity inputs through the same live
    /// reducer -> WAL fsync -> publication path as authenticated socket
    /// ingress. The process-local result remains transient; command ids are
    /// never copied into Runtime state or storage.
    pub fn process_local_entity_inputs_at(
        &mut self,
        entity_inputs: Vec<RuntimeEntityInput>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        self.process_entity_inputs_at(entity_inputs, None, now)
    }

    fn process_entity_inputs_at(
        &mut self,
        entity_inputs: Vec<RuntimeEntityInput>,
        queued_at: Option<u64>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let previous = self.processor.replica()?.state.timestamp;
        let queued_at = queued_at.unwrap_or(now);
        let timestamp = resolve_live_timestamp(previous, queued_at, now)?;
        let report = self.processor.process_live(
            RuntimeLiveInput {
                runtime_txs: Vec::new(),
                entity_inputs,
                timestamp,
                finalized_j_height: self.finalized_j_height,
                hub_rebalance_has_pending_work: self.hub_rebalance_has_pending_work,
            },
            self.materializer.as_mut(),
        )?;
        Ok(report.durable_height.map(|_| report))
    }

    pub fn shutdown(&mut self) -> Result<(), ResidentRuntimeServiceError> {
        self.ingress.shutdown()?;
        Ok(())
    }
}

fn coalesce_inbound_prefix(
    held: &mut VecDeque<InboundEntityInputs>,
    available: usize,
) -> (Vec<RuntimeEntityInput>, Option<u64>) {
    let mut entity_inputs = Vec::new();
    let mut queued_at: Option<u64> = None;
    while let Some(batch) = held.front() {
        if entity_inputs
            .len()
            .checked_add(batch.entity_inputs.len())
            .is_none_or(|count| count > available)
        {
            break;
        }
        let mut batch = held.pop_front().expect("front above");
        queued_at = match (queued_at, batch.ingress_timestamp) {
            (Some(left), Some(right)) => Some(left.max(right)),
            (left @ Some(_), None) => left,
            (None, right) => right,
        };
        entity_inputs.append(&mut batch.entity_inputs);
    }
    (entity_inputs, queued_at)
}

fn wall_clock_ms() -> Result<u64, ResidentRuntimeServiceError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ResidentRuntimeServiceError::ClockBeforeEpoch)?
        .as_millis();
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(ResidentRuntimeServiceError::ClockUnsafe)
}

fn resolve_live_timestamp(
    previous: u64,
    queued_at: u64,
    now: u64,
) -> Result<u64, ResidentRuntimeServiceError> {
    if [previous, queued_at, now]
        .iter()
        .any(|value| *value > MAX_SAFE_INTEGER)
    {
        return Err(ResidentRuntimeServiceError::ClockUnsafe);
    }
    let future_limit = now
        .checked_add(TIMESTAMP_DRIFT_MS)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(ResidentRuntimeServiceError::ClockUnsafe)?;
    if previous > future_limit {
        return Err(ResidentRuntimeServiceError::ClockAhead { previous, now });
    }
    Ok(previous.max(queued_at.min(future_limit)))
}

#[derive(Debug, Error)]
pub enum ResidentRuntimeServiceError {
    #[error("RRS_LIVE_RUNTIME_ID:durable={durable}:ingress={ingress}")]
    RuntimeId { durable: String, ingress: String },
    #[error("RRS_LIVE_CLOCK_BEFORE_EPOCH")]
    ClockBeforeEpoch,
    #[error("RRS_LIVE_CLOCK_UNSAFE")]
    ClockUnsafe,
    #[error("RRS_LIVE_CLOCK_AHEAD:previous={previous}:now={now}")]
    ClockAhead { previous: u64, now: u64 },
    #[error("RRS_LIVE_J_HEIGHT_REGRESSION:previous={previous}:next={next}")]
    JHeightRegression { previous: u64, next: u64 },
    #[error("{0}")]
    Processor(Box<DurableRuntimeProcessorError>),
    #[error(transparent)]
    Transport(#[from] RuntimeTransportError),
}

impl From<DurableRuntimeProcessorError> for ResidentRuntimeServiceError {
    fn from(error: DurableRuntimeProcessorError) -> Self {
        Self::Processor(Box::new(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entity_input() -> RuntimeEntityInput {
        RuntimeEntityInput::decode(json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": format!("0x{}", "22".repeat(20)),
            "entityTxs": [],
        }))
        .expect("entity input")
    }

    fn inbound(count: usize, timestamp: Option<u64>) -> InboundEntityInputs {
        InboundEntityInputs {
            peer_runtime_id: "peer".into(),
            message_id: "message".into(),
            source_runtime_height: 1,
            source_runtime_timestamp: 1,
            ingress_timestamp: timestamp,
            entity_tx_count: 0,
            entity_inputs: (0..count).map(|_| entity_input()).collect(),
        }
    }

    #[test]
    fn ready_socket_batches_coalesce_as_one_whole_message_fifo_prefix() {
        let mut held = VecDeque::from([
            inbound(2, Some(100)),
            inbound(3, Some(120)),
            inbound(6, Some(110)),
        ]);
        let (inputs, queued_at) = coalesce_inbound_prefix(&mut held, 5);
        assert_eq!(inputs.len(), 5);
        assert_eq!(queued_at, Some(120));
        assert_eq!(held.len(), 1);
        assert_eq!(held.front().map(|batch| batch.entity_inputs.len()), Some(6));
    }

    #[test]
    fn timestamp_matches_typescript_clamp() {
        assert_eq!(resolve_live_timestamp(100, 150, 200).expect("clock"), 150);
        assert_eq!(resolve_live_timestamp(175, 150, 200).expect("clock"), 175);
        assert_eq!(
            resolve_live_timestamp(100, 50_000, 200).expect("clamped clock"),
            30_200
        );
        assert!(matches!(
            resolve_live_timestamp(30_201, 200, 200),
            Err(ResidentRuntimeServiceError::ClockAhead { .. })
        ));
    }
}
