//! Fail-stop Runtime reducer → WAL fsync → WebSocket publication.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::storage::native::RecoveredWalFrame;
use crate::storage::native::{DurableRuntimeFrame, NativeRuntimeStore, NativeStorageError};
use crate::transport::{
    DirectOutboxPublisher, DirectOutboxPublisherConfig, InboundSessionTable, PublicationReport,
    RuntimeTransportError, derive_local_runtime_id,
};
use crate::{
    EntityInfraMaterializer, RuntimeApplyResult, RuntimeInput, RuntimeLiveInput,
    RuntimeMachineError, RuntimeReplica, apply_runtime, apply_runtime_live,
};

use super::projection::{DurableProjection, project_durable_frame};
use super::{EntityRouteTable, RuntimeDurableEnvelopeError};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeProcessReport {
    pub durable_height: Option<u64>,
    pub outputs_published: usize,
    pub envelopes_published: usize,
    pub durable_bytes_published: usize,
    /// Present only for the frame applied by this call, after its WAL fsync.
    /// Retry-only publication reports do not invent or reconstruct it.
    pub commitments: Option<RuntimeDurableCommitments>,
    /// Ordered Account commit evidence from this exact Runtime transition.
    /// It is exposed only after WAL fsync for replay diagnostics and is not a
    /// stored or consensus-authoritative history surface.
    pub account_commits: Vec<crate::AccountCommitEvidence>,
    /// Non-consensus diagnostics for locating production Runtime cost. These
    /// durations never enter a frame, checkpoint or replay decision.
    pub timings: RuntimeProcessTimings,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RuntimeProcessTimings {
    pub apply: Duration,
    pub projection: Duration,
    pub storage: Duration,
    pub publication: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeDurableCommitments {
    pub height: u64,
    pub runtime_frame_hash: [u8; 32],
    pub post_state_hash: [u8; 32],
    pub certified_entity_frame_hash: [u8; 32],
    pub entity_state_root: [u8; 32],
    pub entity_authority_root: [u8; 32],
    pub accounts_root: [u8; 32],
    pub entity_event_count: u64,
    /// Replay-only diagnostic. It is not persisted and has no consensus role;
    /// the certified Entity frame hash is the authoritative event commitment.
    pub events_parity_digest: [u8; 32],
    pub entity_effect_count: u64,
    /// Ordered economic Entity effects. This diagnostic is intentionally
    /// separate from signed Entity-frame events and the routed Runtime outbox.
    pub entity_effects_parity_digest: [u8; 32],
    pub runtime_output_count: u64,
    pub runtime_outputs_digest: [u8; 32],
}

/// Operator keyring label used to derive the Runtime signing key.
///
/// This is intentionally not a signer address: persisted signer ids only
/// verify the derived identity and must never be fed back into HMAC derivation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeSignerLabel(String);

impl RuntimeSignerLabel {
    pub fn new(value: impl Into<String>) -> Result<Self, RuntimeTransportError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(RuntimeTransportError::Config("signer-label"));
        }
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    fn into_inner(self) -> String {
        self.0
    }
}

/// The only production mutation seam. `replica` is absent after any
/// pre-fsync failure because `apply_runtime` consumes it; continuing would
/// guess an inverse transition. A post-fsync publication failure retains the
/// exact durable token and blocks the next input until best-effort resend.
pub struct DurableRuntimeProcessor {
    replica: Option<RuntimeReplica>,
    store: NativeRuntimeStore,
    routes: EntityRouteTable,
    publisher: DirectOutboxPublisher,
    publication_target: PublicationTarget,
    pending_publications: VecDeque<DurableRuntimeFrame>,
    poisoned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicationTarget {
    WebSocket,
    ReplayValidateOnly,
}

impl DurableRuntimeProcessor {
    pub fn new(
        replica: RuntimeReplica,
        store: NativeRuntimeStore,
        routes: EntityRouteTable,
        source_seed: impl Into<String>,
        source_signer_label: RuntimeSignerLabel,
    ) -> Result<Self, DurableRuntimeProcessorError> {
        Self::with_publication_target(
            replica,
            store,
            routes,
            source_seed.into(),
            source_signer_label,
            PublicationTarget::WebSocket,
        )
    }

    /// Native replay entry point. It is deliberately a separate constructor:
    /// production callers cannot toggle socket publication with a runtime
    /// flag. The reducer, projector, route validation, WAL write and fsync are
    /// identical; only the final network write is suppressed.
    pub fn new_replay_validate_only(
        replica: RuntimeReplica,
        store: NativeRuntimeStore,
        routes: EntityRouteTable,
        source_seed: impl Into<String>,
        source_signer_label: RuntimeSignerLabel,
    ) -> Result<Self, DurableRuntimeProcessorError> {
        let mut processor = Self::with_publication_target(
            replica,
            store,
            routes,
            source_seed.into(),
            source_signer_label,
            PublicationTarget::ReplayValidateOnly,
        )?;
        // The imported checkpoint is the already-published floor of the
        // canonical replay range, not a tail frame to inject again. Validate
        // its exact durable outbox through the normal projector/route decoder,
        // then start replay after that boundary. This stores no delivery ACK.
        processor.retry_publication()?;
        Ok(processor)
    }

    fn with_publication_target(
        replica: RuntimeReplica,
        mut store: NativeRuntimeStore,
        routes: EntityRouteTable,
        source_seed: String,
        source_signer_label: RuntimeSignerLabel,
        publication_target: PublicationTarget,
    ) -> Result<Self, DurableRuntimeProcessorError> {
        if replica.state.height != store.latest_height() {
            return Err(DurableRuntimeProcessorError::StorageHeight {
                replica: replica.state.height,
                durable: store.latest_height(),
            });
        }
        let derived_runtime_id =
            derive_local_runtime_id(&source_seed, source_signer_label.as_str())?;
        if derived_runtime_id != replica.durable.runtime_id() {
            return Err(DurableRuntimeProcessorError::RuntimeId {
                envelope: replica.durable.runtime_id().to_string(),
                derived: derived_runtime_id,
            });
        }
        let pending_publications = VecDeque::from(store.durable_frames_for_resend()?);
        let publisher_config = DirectOutboxPublisherConfig::production(
            source_seed,
            source_signer_label.into_inner(),
            routes.direct_routes(),
        )
        .with_local_entity(&replica.state.entity.entity_id, &replica.signer_id)?;
        let publisher = DirectOutboxPublisher::new(publisher_config)?;
        Ok(Self {
            replica: Some(replica),
            store,
            routes,
            publisher,
            publication_target,
            pending_publications,
            poisoned: false,
        })
    }

    pub fn replica(&self) -> Result<&RuntimeReplica, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        self.replica
            .as_ref()
            .ok_or(DurableRuntimeProcessorError::Poisoned)
    }

    /// Prefer authenticated inbound sessions for committed outbox publication.
    /// Hub-to-hub peers that never dialed us still use DirectOutboxPublisher.
    pub fn attach_inbound_sessions(&mut self, sessions: InboundSessionTable) {
        self.publisher.attach_inbound_sessions(sessions);
    }

    /// Exact-replay seam: replace locally generated RAM continuations with
    /// their byte-identical recorded occurrences without changing recorded
    /// input order. Production live processing never calls this method.
    pub fn reconcile_exact_replay_input(
        &mut self,
        input: &RuntimeInput,
    ) -> Result<usize, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        let replica = self
            .replica
            .as_mut()
            .ok_or(DurableRuntimeProcessorError::Poisoned)?;
        Ok(crate::restore::reconcile_runtime_input_with_resident_queue(
            input,
            &mut replica.mempool,
        ))
    }

    /// Exact bytes persisted for one frame, loaded only after a parity failure.
    /// Successful replay and production publication pay no clone or decode cost.
    pub fn read_durable_frame(
        &mut self,
        height: u64,
    ) -> Result<RecoveredWalFrame, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        self.store.read_durable_frame(height).map_err(Into::into)
    }

    pub fn process(
        &mut self,
        input: RuntimeInput,
    ) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        self.process_with(|replica| apply_runtime(replica, input))
    }

    /// Canonical production entry point: select the exact FIFO prefix, build
    /// its Entity infrastructure context, execute R/E/A, fsync and only then
    /// publish the flat outbox. No candidate/commit/abort API escapes.
    pub fn process_live(
        &mut self,
        input: RuntimeLiveInput,
        materializer: &mut dyn EntityInfraMaterializer,
    ) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        self.process_with(|replica| apply_runtime_live(replica, input, materializer))
    }

    fn process_with(
        &mut self,
        apply: impl FnOnce(RuntimeReplica) -> Result<RuntimeApplyResult, RuntimeMachineError>,
    ) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        if let Some(pending) = self.pending_publications.front() {
            return Err(DurableRuntimeProcessorError::PublicationPending(
                pending.height(),
            ));
        }
        let replica = self
            .replica
            .take()
            .ok_or(DurableRuntimeProcessorError::Poisoned)?;
        let apply_started = Instant::now();
        let applied = match apply(replica) {
            Ok(applied) => applied,
            Err(error) => return self.fail_stop(DurableRuntimeProcessorError::Machine(error)),
        };
        let apply_elapsed = apply_started.elapsed();
        let projection_started = Instant::now();
        let prior_checkpoint_rows = if applied.outputs.checkpoint.is_some() {
            match self.store.current_checkpoint_path_nodes() {
                Ok(rows) => Some(rows),
                Err(error) => return self.fail_stop(DurableRuntimeProcessorError::Storage(error)),
            }
        } else {
            None
        };
        let projected =
            match project_durable_frame(applied, &self.routes, prior_checkpoint_rows.as_ref()) {
                Ok(projected) => projected,
                Err(error) => {
                    return self
                        .fail_stop(DurableRuntimeProcessorError::Projection(error.to_string()));
                }
            };
        let projected = match projected {
            DurableProjection::Idle(replica) => {
                self.replica = Some(*replica);
                return Ok(RuntimeProcessReport {
                    timings: RuntimeProcessTimings {
                        apply: apply_elapsed,
                        projection: projection_started.elapsed(),
                        ..RuntimeProcessTimings::default()
                    },
                    ..RuntimeProcessReport::default()
                });
            }
            DurableProjection::Frame(projected) => *projected,
        };
        let projection_elapsed = projection_started.elapsed();
        let storage_started = Instant::now();
        let projected_frame_hash = projected.encoded.frame_hash;
        let durable = match self.store.append_encoded_frame(projected.encoded) {
            Ok(durable) => durable,
            Err(error) => return self.fail_stop(DurableRuntimeProcessorError::Storage(error)),
        };
        let storage_elapsed = storage_started.elapsed();
        let mut replica = projected.replica;
        if let Err(error) = replica
            .durable
            .advance_frame_hash(projected.expected_previous_hash, projected_frame_hash)
        {
            // WAL is already durable. The only safe recovery is reopening it;
            // never expose a replica whose lineage failed to advance.
            return self.fail_stop(DurableRuntimeProcessorError::Envelope(error));
        }
        self.replica = Some(replica);
        self.pending_publications.push_back(durable);
        let publication_started = Instant::now();
        let mut report = self.publish_pending()?;
        let publication_elapsed = publication_started.elapsed();
        report.commitments = Some(projected.commitments);
        report.account_commits = projected.account_commits;
        report.timings = RuntimeProcessTimings {
            apply: apply_elapsed,
            projection: projection_elapsed,
            storage: storage_elapsed,
            publication: publication_elapsed,
        };
        Ok(report)
    }

    /// Resume every durable flat-outbox frame in height order after a socket
    /// failure or process restart. There is deliberately no delivery ACK or
    /// persisted delivered bit: a crash may resend, and bilateral Account
    /// consensus de-duplicates. A row whose targets are not yet publishable
    /// stays pending until an inbound session or explicit direct URL exists.
    pub fn retry_publication(
        &mut self,
    ) -> Result<Option<RuntimeProcessReport>, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        if self.pending_publications.is_empty() {
            return Ok(None);
        }
        let mut aggregate = RuntimeProcessReport::default();
        while !self.pending_publications.is_empty() {
            if !self.front_is_publishable()? {
                break;
            }
            let report = self.publish_pending()?;
            aggregate.durable_height = report.durable_height;
            aggregate.outputs_published = aggregate
                .outputs_published
                .checked_add(report.outputs_published)
                .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
            aggregate.envelopes_published = aggregate
                .envelopes_published
                .checked_add(report.envelopes_published)
                .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
            aggregate.durable_bytes_published = aggregate
                .durable_bytes_published
                .checked_add(report.durable_bytes_published)
                .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        }
        if aggregate.durable_height.is_none() {
            return Ok(None);
        }
        Ok(Some(aggregate))
    }

    pub fn has_pending_publication(&self) -> bool {
        !self.pending_publications.is_empty()
    }

    fn front_is_publishable(&mut self) -> Result<bool, DurableRuntimeProcessorError> {
        let Some(durable) = self.pending_publications.front() else {
            return Ok(true);
        };
        Ok(self.publisher.can_publish(&mut self.store, durable)?)
    }

    fn publish_pending(&mut self) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        let durable = self
            .pending_publications
            .front()
            .ok_or(DurableRuntimeProcessorError::PublicationState)?;
        let report = match self.publication_target {
            PublicationTarget::WebSocket => {
                self.publisher.publish_durable(&mut self.store, durable)?
            }
            PublicationTarget::ReplayValidateOnly => {
                self.publisher.validate_durable(&mut self.store, durable)?
            }
        };
        self.pending_publications.pop_front();
        Ok(process_report(report))
    }

    fn ensure_healthy(&self) -> Result<(), DurableRuntimeProcessorError> {
        if self.poisoned || self.replica.is_none() {
            Err(DurableRuntimeProcessorError::Poisoned)
        } else {
            Ok(())
        }
    }

    fn fail_stop<T>(
        &mut self,
        error: DurableRuntimeProcessorError,
    ) -> Result<T, DurableRuntimeProcessorError> {
        self.poisoned = true;
        self.replica = None;
        Err(error)
    }
}

fn process_report(report: PublicationReport) -> RuntimeProcessReport {
    RuntimeProcessReport {
        durable_height: Some(report.durable_height),
        outputs_published: report.rows_published,
        envelopes_published: report.envelopes_published,
        durable_bytes_published: report.durable_bytes,
        commitments: None,
        account_commits: Vec::new(),
        timings: RuntimeProcessTimings::default(),
    }
}

#[derive(Debug, Error)]
pub enum DurableRuntimeProcessorError {
    #[error("RRS_PROCESSOR_POISONED")]
    Poisoned,
    #[error("RRS_PROCESSOR_STORAGE_HEIGHT:replica={replica}:durable={durable}")]
    StorageHeight { replica: u64, durable: u64 },
    #[error("RRS_PROCESSOR_RUNTIME_ID:envelope={envelope}:derived={derived}")]
    RuntimeId { envelope: String, derived: String },
    #[error("RRS_PROCESSOR_PUBLICATION_PENDING:{0}")]
    PublicationPending(u64),
    #[error("RRS_PROCESSOR_PUBLICATION_STATE")]
    PublicationState,
    #[error("RRS_PROCESSOR_REPORT_OVERFLOW")]
    ReportOverflow,
    #[error("RRS_PROCESSOR_ROUTE:{0}")]
    Route(String),
    #[error(transparent)]
    Machine(#[from] RuntimeMachineError),
    #[error("RRS_PROCESSOR_PROJECTION:{0}")]
    Projection(String),
    #[error(transparent)]
    Storage(#[from] NativeStorageError),
    #[error(transparent)]
    Transport(#[from] RuntimeTransportError),
    #[error(transparent)]
    Envelope(#[from] RuntimeDurableEnvelopeError),
}
