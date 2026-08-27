//! Single-writer live Runtime service.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::transport::{DirectRuntimeIngress, InboundEntityInputs, RuntimeTransportError};
use crate::{EntityInfraMaterializer, RuntimeLiveInput};

use super::{DurableRuntimeProcessor, DurableRuntimeProcessorError, RuntimeProcessReport};

const TIMESTAMP_DRIFT_MS: u64 = 30_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Owns the authenticated socket queue, the one durable Runtime writer and
/// the Entity infrastructure materializer. Transport threads can only enqueue;
/// this object is the sole mutation path into R/E/A state.
pub struct ResidentRuntimeService {
    processor: DurableRuntimeProcessor,
    ingress: DirectRuntimeIngress,
    materializer: Box<dyn EntityInfraMaterializer>,
    finalized_j_height: u64,
    hub_rebalance_has_pending_work: bool,
}

impl ResidentRuntimeService {
    pub fn new(
        processor: DurableRuntimeProcessor,
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
        Ok(Self {
            processor,
            ingress,
            materializer,
            finalized_j_height,
            hub_rebalance_has_pending_work: false,
        })
    }

    pub fn local_address(&self) -> std::net::SocketAddr {
        self.ingress.local_address()
    }

    pub fn runtime_id(&self) -> &str {
        self.ingress.runtime_id()
    }

    pub fn processor(&self) -> &DurableRuntimeProcessor {
        &self.processor
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
    pub fn process_next(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let batch = self.ingress.recv_timeout(timeout)?;
        self.process_batch_at(batch, wall_clock_ms()?)
    }

    /// Deterministic seam used by tests and replayed live traces. `now` is an
    /// external observation; the resolved timestamp is recorded in the WAL.
    pub fn process_batch_at(
        &mut self,
        batch: Option<InboundEntityInputs>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let previous = self.processor.replica()?.state.timestamp;
        let queued_at = batch
            .as_ref()
            .and_then(|batch| batch.ingress_timestamp)
            .unwrap_or(now);
        let timestamp = resolve_live_timestamp(previous, queued_at, now)?;
        let entity_inputs = batch.map(|batch| batch.entity_inputs).unwrap_or_default();
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
