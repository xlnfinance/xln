//! Fail-stop Runtime reducer → WAL fsync → WebSocket publication.
//!
//! Storage append and publication for frame N run on a dedicated committer
//! thread that overlaps the reducer work of frame N+1. The pipeline is exactly
//! one frame deep: the processor blocks on frame N's commit outcome right
//! after frame N+1's reducer finishes, so a storage failure still fail-stops
//! before a second uncommitted frame can exist, and publication order is the
//! same FIFO the serial path had.

use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TryRecvError};
use std::time::{Duration, Instant};

use thiserror::Error;
use xln_rscore_batch::{AccountId, ResidentAccountStatusView};
use xln_rscore_engine::TokenId;

use crate::storage::native::RecoveredWalFrame;
use crate::storage::native::{
    DurableRuntimeFrame, NativeRuntimeStore, NativeStorageError, NativeStorageTimings,
};
use crate::transport::{
    DirectOutboxPublisher, DirectOutboxPublisherConfig, InboundSessionTable, PublicationBacklog,
    PublicationReport, RuntimeTransportError, derive_local_runtime_id,
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
    /// Validator-local J writes whose exact attempts crossed WAL fsync in the
    /// `durable_height` reported here. Replay exposes but never executes them.
    pub post_commit_j_attempts: Vec<crate::j_submit::DurableJAttempt>,
    /// Committed economic events from this exact frame. These mirror the TS
    /// post-WAL `HtlcForwardAccepted`/`HtlcReceived` counters and never count
    /// ingress, rejected work or proposals.
    pub accepted_payments: usize,
    pub completed_payments: usize,
    pub matched_swaps: usize,
    pub zero_fill_swap_cancels: usize,
    /// Post-frame Entity lock-book size. `Some(0)` is required together with
    /// completed-payment cardinality before HLT may call a payment delivered.
    pub paybook_open: Option<usize>,
    /// Exact selected production work in this Runtime frame. These counters
    /// prove batching and worker feed without decoding the WAL a second time.
    pub runtime_entity_inputs: usize,
    pub account_inputs: usize,
    pub canonical_input_bytes: usize,
    pub entity_txs_selected: usize,
    pub entity_txs_pending: usize,
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
    pub projection_input: Duration,
    pub projection_machine: Duration,
    pub projection_meta: Duration,
    pub projection_context: Duration,
    pub projection_checkpoint: Duration,
    pub projection_encode: Duration,
    pub storage_prepare_validate: Duration,
    pub storage_batch_build: Duration,
    pub storage_db_write_sync: Duration,
    pub storage_directory_sync: Duration,
    pub storage_post_commit: Duration,
    pub barrier_wait_for_previous_commit: Duration,
    pub committer_busy: Duration,
    pub committer_idle: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeDurableCommitments {
    pub height: u64,
    pub runtime_frame_hash: [u8; 32],
    pub post_state_hash: [u8; 32],
    pub entities: Vec<RuntimeDurableEntityCommitment>,
    pub entity_event_count: u64,
    /// Replay-only diagnostic. It is not persisted and has no consensus role;
    /// replay computes it for comparison while live reports zero. The
    /// certified Entity frame hash is the authoritative event commitment.
    pub events_parity_digest: [u8; 32],
    pub entity_effect_count: u64,
    /// Ordered economic Entity effects. This diagnostic is intentionally
    /// separate from signed Entity-frame events and the routed Runtime outbox;
    /// replay computes it for comparison while live reports zero.
    pub entity_effects_parity_digest: [u8; 32],
    pub runtime_output_count: u64,
    pub runtime_outputs_digest: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeDurableEntityCommitment {
    pub entity_id: [u8; 32],
    pub certified_frame_hash: [u8; 32],
    pub state_root: [u8; 32],
    pub authority_root: [u8; 32],
    pub accounts_root: [u8; 32],
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
/// guess an inverse transition. Post-fsync publication is staged once into
/// bounded per-target RAM FIFOs; only aggregate capacity exhaustion blocks a
/// later input.
pub struct DurableRuntimeProcessor {
    replica: Option<RuntimeReplica>,
    routes: EntityRouteTable,
    committer: CommitterHandle,
    /// Height of the one commit the committer may still be executing. The
    /// pipeline is never deeper: `process_with` blocks on this outcome before
    /// it projects the next frame.
    in_flight: Option<u64>,
    /// Fine-grained timers are diagnostic-only and disabled on the live hot
    /// path unless the existing Runtime profiling gate is explicitly enabled.
    profile: bool,
    poisoned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicationTarget {
    WebSocket,
    ReplayValidateOnly,
}

fn profiled_elapsed(started: Option<Instant>) -> Duration {
    started.map_or(Duration::ZERO, |started| started.elapsed())
}

/// Storage append + publication outcome for one committed frame, produced on
/// the committer thread strictly in height order.
struct CommitOutcome {
    height: u64,
    publication: RuntimeProcessReport,
    storage_elapsed: Duration,
    publication_elapsed: Duration,
    storage_timings: NativeStorageTimings,
    committer_busy_elapsed: Duration,
    committer_idle_elapsed: Duration,
    post_commit_j_attempts: Vec<crate::j_submit::DurableJAttempt>,
}

type CheckpointRowsResult = Result<BTreeMap<Vec<u8>, Vec<u8>>, DurableRuntimeProcessorError>;

enum CommitterCommand {
    Commit(
        Box<(
            crate::storage::native::EncodedRuntimeFrame,
            Vec<crate::j_submit::DurableJAttempt>,
        )>,
    ),
    RetryPublication(Sender<Result<Option<RuntimeProcessReport>, DurableRuntimeProcessorError>>),
    HasPendingPublication(Sender<bool>),
    Backlog(Sender<(PublicationBacklog, u64)>),
    AttachInboundSessions(InboundSessionTable),
    CheckpointRows(Sender<CheckpointRowsResult>),
    ReadDurableFrame(
        u64,
        Sender<Result<RecoveredWalFrame, DurableRuntimeProcessorError>>,
    ),
}

struct CommitterHandle {
    commands: SyncSender<CommitterCommand>,
    results: Receiver<Result<CommitOutcome, DurableRuntimeProcessorError>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for CommitterHandle {
    fn drop(&mut self) {
        // Closing the command channel ends the committer loop after it drains
        // every queued commit; joining guarantees all durable writes finished
        // before the store's directory can be reopened by a successor.
        let (dead, _) = std::sync::mpsc::sync_channel(0);
        self.commands = dead;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Owns the store, the publisher and the unpublished-frame FIFO. Every
/// durable byte and every socket write happens on this thread; the reducer
/// thread only exchanges owned values with it.
struct Committer {
    store: NativeRuntimeStore,
    publisher: DirectOutboxPublisher,
    publication_target: PublicationTarget,
    pending_publications: VecDeque<DurableRuntimeFrame>,
    profile: bool,
    /// A storage failure is terminal: after it, every command answers
    /// `Poisoned` and no further byte is written.
    failed: bool,
}

impl Committer {
    fn run(
        mut self,
        commands: Receiver<CommitterCommand>,
        results: Sender<Result<CommitOutcome, DurableRuntimeProcessorError>>,
    ) {
        // Committer utilization is measured between commit jobs. Cold-path
        // reader commands may run inside that interval, but must not reset it
        // and make the next commit look artificially well fed.
        let mut previous_commit_finished: Option<Instant> = None;
        for command in commands {
            match command {
                CommitterCommand::Commit(encoded) => {
                    let committer_idle_elapsed = if self.profile {
                        previous_commit_finished
                            .map_or(Duration::ZERO, |finished| finished.elapsed())
                    } else {
                        Duration::ZERO
                    };
                    let busy_started = self.profile.then(Instant::now);
                    let mut outcome = if self.failed {
                        Err(DurableRuntimeProcessorError::Poisoned)
                    } else {
                        let (encoded, attempts) = *encoded;
                        self.commit_one(encoded, attempts)
                    };
                    if let Ok(outcome) = &mut outcome {
                        outcome.committer_busy_elapsed = profiled_elapsed(busy_started);
                        outcome.committer_idle_elapsed = committer_idle_elapsed;
                    }
                    if matches!(
                        outcome,
                        Err(DurableRuntimeProcessorError::Storage(_)
                            | DurableRuntimeProcessorError::PublicationState)
                    ) {
                        self.failed = true;
                    }
                    if results.send(outcome).is_err() {
                        return;
                    }
                    previous_commit_finished = self.profile.then(Instant::now);
                }
                CommitterCommand::RetryPublication(reply) => {
                    let result = if self.failed {
                        Err(DurableRuntimeProcessorError::Poisoned)
                    } else {
                        self.retry_publication()
                    };
                    let _ = reply.send(result);
                }
                CommitterCommand::HasPendingPublication(reply) => {
                    let _ = reply.send(!self.pending_publications.is_empty());
                }
                CommitterCommand::Backlog(reply) => {
                    let _ = reply.send((self.publisher.backlog(), self.store.retained_wal_bytes()));
                }
                CommitterCommand::AttachInboundSessions(sessions) => {
                    self.publisher.attach_inbound_sessions(sessions);
                }
                CommitterCommand::CheckpointRows(reply) => {
                    let result = if self.failed {
                        Err(DurableRuntimeProcessorError::Poisoned)
                    } else {
                        self.store
                            .current_checkpoint_path_nodes()
                            .cloned()
                            .map_err(Into::into)
                    };
                    let _ = reply.send(result);
                }
                CommitterCommand::ReadDurableFrame(height, reply) => {
                    let result = if self.failed {
                        Err(DurableRuntimeProcessorError::Poisoned)
                    } else {
                        self.store.read_durable_frame(height).map_err(Into::into)
                    };
                    let _ = reply.send(result);
                }
            }
        }
    }

    fn commit_one(
        &mut self,
        encoded: crate::storage::native::EncodedRuntimeFrame,
        post_commit_j_attempts: Vec<crate::j_submit::DurableJAttempt>,
    ) -> Result<CommitOutcome, DurableRuntimeProcessorError> {
        let storage_started = Instant::now();
        let (durable, storage_timings) = self.store.append_encoded_frame(encoded, self.profile)?;
        let storage_elapsed = storage_started.elapsed();
        debug_assert!(!self.profile || storage_timings.accounted() <= storage_elapsed);
        let height = durable.height();
        self.pending_publications.push_back(durable);
        let publication_started = Instant::now();
        let mut publication = RuntimeProcessReport::default();
        while !self.pending_publications.is_empty() {
            let report = self.publish_pending()?;
            merge_publication_report(&mut publication, report)?;
        }
        Ok(CommitOutcome {
            height,
            publication,
            storage_elapsed,
            publication_elapsed: publication_started.elapsed(),
            storage_timings,
            committer_busy_elapsed: Duration::ZERO,
            committer_idle_elapsed: Duration::ZERO,
            post_commit_j_attempts,
        })
    }

    fn retry_publication(
        &mut self,
    ) -> Result<Option<RuntimeProcessReport>, DurableRuntimeProcessorError> {
        let mut aggregate = RuntimeProcessReport::default();
        let retried = self.publisher.retry_pending()?;
        if retried.rows_published > 0 {
            merge_publication_report(&mut aggregate, process_report(retried))?;
        }
        while !self.pending_publications.is_empty() {
            if !self.front_is_stageable()? {
                break;
            }
            let report = self.publish_pending()?;
            merge_publication_report(&mut aggregate, report)?;
        }
        if aggregate.durable_height.is_none() {
            return Ok(None);
        }
        Ok(Some(aggregate))
    }

    fn front_is_stageable(&mut self) -> Result<bool, DurableRuntimeProcessorError> {
        let Some(durable) = self.pending_publications.front() else {
            return Ok(true);
        };
        Ok(self.publisher.can_stage(&mut self.store, durable)?)
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
        let mut publisher_config = DirectOutboxPublisherConfig::production(
            source_seed,
            source_signer_label.into_inner(),
            routes.direct_routes(),
        );
        for (entity_id, state) in &replica.state.e_replicas {
            let live =
                replica
                    .e_replicas
                    .get(entity_id)
                    .ok_or(DurableRuntimeProcessorError::Machine(
                        crate::RuntimeMachineError::EntityOwnerMismatch,
                    ))?;
            publisher_config =
                publisher_config.with_local_entity(&state.entity.entity_id, &live.signer_id)?;
        }
        let publisher = DirectOutboxPublisher::new(publisher_config)?;
        let profile = matches!(publication_target, PublicationTarget::ReplayValidateOnly)
            || super::projection::runtime_profile_enabled();
        let committer = Committer {
            store,
            publisher,
            publication_target,
            pending_publications,
            profile,
            failed: false,
        };
        // Depth 1 plus the in-flight guard keeps at most one commit queued;
        // the extra slot only lets rare cold-path commands enqueue without
        // blocking behind a commit send.
        let (commands, command_rx) = std::sync::mpsc::sync_channel(2);
        let (result_tx, results) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("rscore-committer".into())
            .spawn(move || committer.run(command_rx, result_tx))
            .map_err(|_| DurableRuntimeProcessorError::CommitterUnavailable)?;
        Ok(Self {
            replica: Some(replica),
            routes,
            committer: CommitterHandle {
                commands,
                results,
                thread: Some(thread),
            },
            in_flight: None,
            profile,
            poisoned: false,
        })
    }

    /// One committer round-trip. Every cold-path accessor funnels here so a
    /// dead committer thread surfaces as one error kind instead of a hang.
    fn committer_call<T>(
        &self,
        build: impl FnOnce(Sender<T>) -> CommitterCommand,
    ) -> Result<T, DurableRuntimeProcessorError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.committer
            .commands
            .send(build(reply_tx))
            .map_err(|_| DurableRuntimeProcessorError::CommitterUnavailable)?;
        reply_rx
            .recv()
            .map_err(|_| DurableRuntimeProcessorError::CommitterUnavailable)
    }

    /// Collect the outcome of the one possibly-outstanding commit. Blocking
    /// mode is the pipeline barrier; non-blocking mode only surfaces an
    /// already-finished outcome early.
    fn drain_in_flight(
        &mut self,
        block: bool,
    ) -> Result<Option<CommitOutcome>, DurableRuntimeProcessorError> {
        let Some(height) = self.in_flight else {
            return Ok(None);
        };
        let outcome = if block {
            match self.committer.results.recv() {
                Ok(outcome) => outcome,
                Err(_) => return Err(DurableRuntimeProcessorError::CommitterUnavailable),
            }
        } else {
            match self.committer.results.try_recv() {
                Ok(outcome) => outcome,
                Err(TryRecvError::Empty) => return Ok(None),
                Err(TryRecvError::Disconnected) => {
                    return Err(DurableRuntimeProcessorError::CommitterUnavailable);
                }
            }
        };
        self.in_flight = None;
        let outcome = outcome?;
        if outcome.height != height {
            return Err(DurableRuntimeProcessorError::PublicationState);
        }
        Ok(Some(outcome))
    }

    /// Block until no commit is outstanding. The terminal replay barrier and
    /// every cold-path reader that must observe frame N durable use this. The
    /// returned report carries the drained commit's height and publication
    /// counters so callers can finish their accounting.
    pub fn sync_committed(
        &mut self,
    ) -> Result<Option<RuntimeProcessReport>, DurableRuntimeProcessorError> {
        let wait_started = self.profile.then(Instant::now);
        match self.drain_in_flight(true) {
            Ok(None) => Ok(None),
            Ok(outcome) => {
                let mut report = RuntimeProcessReport::default();
                merge_commit_outcome(&mut report, outcome)?;
                report.timings.barrier_wait_for_previous_commit = profiled_elapsed(wait_started);
                Ok(Some(report))
            }
            Err(DurableRuntimeProcessorError::Storage(error)) => {
                self.fail_stop(DurableRuntimeProcessorError::Storage(error))
            }
            Err(error) => Err(error),
        }
    }

    pub fn replica(&self) -> Result<&RuntimeReplica, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        self.replica
            .as_ref()
            .ok_or(DurableRuntimeProcessorError::Poisoned)
    }

    pub fn account_status(
        &mut self,
        entity_key: &crate::RuntimeEntityKey,
        account_id: AccountId,
        token_ids: Vec<TokenId>,
    ) -> Result<Option<ResidentAccountStatusView>, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        let replica = self
            .replica
            .as_mut()
            .ok_or(DurableRuntimeProcessorError::Poisoned)?;
        let Some(entity) = replica.e_replicas.get_mut(entity_key) else {
            return Ok(None);
        };
        entity
            .accounts
            .account_status(account_id, token_ids)
            .map_err(RuntimeMachineError::Account)
            .map_err(Into::into)
    }

    /// Prefer authenticated inbound sessions for committed outbox publication.
    /// Hub-to-hub peers that never dialed us still use DirectOutboxPublisher.
    pub fn attach_inbound_sessions(&mut self, sessions: InboundSessionTable) {
        // Best-effort by design, exactly like the direct call was: a dead
        // committer surfaces on the next processing call.
        let _ = self
            .committer
            .commands
            .send(CommitterCommand::AttachInboundSessions(sessions));
    }

    /// Admit one route only from an authenticated Runtime session and the
    /// existing signed Entity Profile. This is RAM transport state: replay
    /// derives no route from it and no checkpoint/WAL field is created.
    pub(crate) fn admit_authenticated_profile(
        &mut self,
        peer_runtime_id: &str,
        profile: &serde_json::Value,
    ) -> Result<(), DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        let entity_id = super::profile_route::profile_entity_id(profile)
            .map_err(|error| DurableRuntimeProcessorError::Projection(error.to_string()))?;
        let replica = self
            .replica
            .as_ref()
            .ok_or(DurableRuntimeProcessorError::Poisoned)?;
        let mut authority = None;
        for entity in replica.e_replicas.values() {
            let Some(candidate) = entity
                .certified_board_registry
                .current_authority(&entity_id)
            else {
                continue;
            };
            if authority.is_some_and(|current| current != candidate) {
                return Err(DurableRuntimeProcessorError::Projection(format!(
                    "RRS_PROFILE_ROUTE_AUTHORITY_CONFLICT:{}",
                    hex::encode(entity_id)
                )));
            }
            authority = Some(candidate);
        }
        let verified = super::profile_route::verify_profile_route(
            profile,
            peer_runtime_id,
            authority.as_ref(),
        )
        .map_err(|error| DurableRuntimeProcessorError::Projection(error.to_string()))?;
        self.routes = self
            .routes
            .with_verified_profile(verified)
            .map_err(|error| DurableRuntimeProcessorError::Projection(error.to_string()))?;
        Ok(())
    }

    pub(crate) fn entity_routes(&self) -> EntityRouteTable {
        self.routes.clone()
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
        // The requested frame may still be the in-flight commit.
        self.sync_committed()?;
        self.committer_call(|reply| CommitterCommand::ReadDurableFrame(height, reply))?
    }

    pub fn process(
        &mut self,
        input: RuntimeInput,
    ) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        self.process_with(true, |replica| apply_runtime(replica, input))
    }

    /// Canonical production entry point: select the exact FIFO prefix, build
    /// its Entity infrastructure context, execute R/E/A, fsync and only then
    /// publish the flat outbox. No candidate/commit/abort API escapes.
    pub fn process_live(
        &mut self,
        input: RuntimeLiveInput,
        materializer: &mut dyn EntityInfraMaterializer,
    ) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        self.process_with(false, |replica| {
            apply_runtime_live(replica, input, materializer)
        })
    }

    fn process_with(
        &mut self,
        capture_replay_diagnostics: bool,
        apply: impl FnOnce(RuntimeReplica) -> Result<RuntimeApplyResult, RuntimeMachineError>,
    ) -> Result<RuntimeProcessReport, DurableRuntimeProcessorError> {
        self.ensure_healthy()?;
        // Surface an already-finished commit outcome before consuming the
        // replica: a failure here stops this call with the replica intact.
        let mut drained = match self.drain_in_flight(false) {
            Ok(drained) => drained,
            Err(DurableRuntimeProcessorError::Storage(error)) => {
                return self.fail_stop(DurableRuntimeProcessorError::Storage(error));
            }
            Err(error) => return Err(error),
        };
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
        // Pipeline barrier: the previous frame must be durable before this
        // one reads checkpoint storage state or enqueues its own commit. A
        // publication (socket) failure surfaces after this frame is staged,
        // exactly like the serial path returned it after its own fsync; a
        // storage failure poisons because the reducer already consumed the
        // replica for a frame that can no longer follow its predecessor.
        let mut deferred_publication: Option<DurableRuntimeProcessorError> = None;
        let mut barrier_wait_for_previous_commit = Duration::ZERO;
        if drained.is_none() && self.in_flight.is_some() {
            let wait_started = self.profile.then(Instant::now);
            match self.drain_in_flight(true) {
                Ok(outcome) => {
                    barrier_wait_for_previous_commit = profiled_elapsed(wait_started);
                    drained = outcome;
                }
                Err(DurableRuntimeProcessorError::Transport(error)) => {
                    deferred_publication = Some(DurableRuntimeProcessorError::Transport(error));
                }
                Err(error) => return self.fail_stop(error),
            }
        }
        let projection_started = Instant::now();
        let prior_checkpoint_rows = if applied
            .outputs
            .entities
            .iter()
            .any(|output| output.checkpoint.is_some())
        {
            match self.committer_call(CommitterCommand::CheckpointRows) {
                Ok(Ok(rows)) => Some(rows),
                Ok(Err(error)) | Err(error) => return self.fail_stop(error),
            }
        } else {
            None
        };
        let projected = match project_durable_frame(
            applied,
            &self.routes,
            prior_checkpoint_rows.as_ref(),
            capture_replay_diagnostics,
        ) {
            Ok(projected) => projected,
            Err(error) => {
                return self.fail_stop(DurableRuntimeProcessorError::Projection(error.to_string()));
            }
        };
        let projected = match projected {
            DurableProjection::Idle(replica) => {
                self.replica = Some(*replica);
                let mut report = RuntimeProcessReport {
                    timings: RuntimeProcessTimings {
                        apply: apply_elapsed,
                        projection: projection_started.elapsed(),
                        ..RuntimeProcessTimings::default()
                    },
                    ..RuntimeProcessReport::default()
                };
                merge_commit_outcome(&mut report, drained)?;
                report.timings.barrier_wait_for_previous_commit = barrier_wait_for_previous_commit;
                if let Some(error) = deferred_publication {
                    return Err(error);
                }
                return Ok(report);
            }
            DurableProjection::Frame(projected) => *projected,
        };
        let projection_elapsed = projection_started.elapsed();
        let commit_height = projected.replica.state.height;
        let projected_frame_hash = projected.encoded.frame_hash;
        let mut replica = projected.replica;
        if let Err(error) = replica
            .durable
            .advance_frame_hash(projected.expected_previous_hash, projected_frame_hash)
        {
            // Nothing about this frame is durable yet; never expose a replica
            // whose lineage failed to advance.
            return self.fail_stop(DurableRuntimeProcessorError::Envelope(error));
        }
        self.replica = Some(replica);
        if self
            .committer
            .commands
            .send(CommitterCommand::Commit(Box::new((
                projected.encoded,
                projected.post_commit_j_attempts,
            ))))
            .is_err()
        {
            return self.fail_stop(DurableRuntimeProcessorError::CommitterUnavailable);
        }
        self.in_flight = Some(commit_height);
        let mut report = RuntimeProcessReport::default();
        merge_commit_outcome(&mut report, drained)?;
        report.timings.barrier_wait_for_previous_commit = barrier_wait_for_previous_commit;
        report.commitments = Some(projected.commitments);
        report.account_commits = projected.account_commits;
        report.accepted_payments = projected.accepted_payments;
        report.completed_payments = projected.completed_payments;
        report.matched_swaps = projected.matched_swaps;
        report.zero_fill_swap_cancels = projected.zero_fill_swap_cancels;
        report.paybook_open = Some(projected.paybook_open);
        report.runtime_entity_inputs = projected.runtime_entity_inputs;
        report.account_inputs = projected.account_inputs;
        report.canonical_input_bytes = projected.canonical_input_bytes;
        report.entity_txs_selected = projected.entity_txs_selected;
        report.entity_txs_pending = projected.entity_txs_pending;
        report.timings.apply = apply_elapsed;
        report.timings.projection = projection_elapsed;
        report.timings.projection_input = projected.projection_input;
        report.timings.projection_machine = projected.projection_machine;
        report.timings.projection_meta = projected.projection_meta;
        report.timings.projection_context = projected.projection_context;
        report.timings.projection_checkpoint = projected.projection_checkpoint;
        report.timings.projection_encode = projected.projection_encode;
        if let Some(error) = deferred_publication {
            return Err(error);
        }
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
        self.committer_call(CommitterCommand::RetryPublication)?
    }

    pub fn has_pending_publication(&self) -> bool {
        // A dead committer reports pending so callers gate instead of racing
        // toward the error the next process call will surface.
        self.committer_call(CommitterCommand::HasPendingPublication)
            .unwrap_or(true)
    }

    pub fn publication_backlog(&self) -> PublicationBacklog {
        self.committer_call(CommitterCommand::Backlog)
            .map(|(backlog, _)| backlog)
            .unwrap_or_default()
    }

    /// One cold telemetry round-trip returns transport backlog and the
    /// authoritative storage HEAD together. Metrics must not add a second
    /// committer barrier merely to prove WAL growth.
    pub fn publication_backlog_and_retained_wal_bytes(
        &self,
    ) -> Result<(PublicationBacklog, u64), DurableRuntimeProcessorError> {
        self.committer_call(CommitterCommand::Backlog)
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
        post_commit_j_attempts: Vec::new(),
        accepted_payments: 0,
        completed_payments: 0,
        matched_swaps: 0,
        zero_fill_swap_cancels: 0,
        paybook_open: None,
        runtime_entity_inputs: 0,
        account_inputs: 0,
        canonical_input_bytes: 0,
        entity_txs_selected: 0,
        entity_txs_pending: 0,
        timings: RuntimeProcessTimings::default(),
    }
}

/// Fold the pipelined previous-frame commit outcome into the report of the
/// call that observed it. Height and commit-side timings overwrite; counters
/// accumulate.
fn merge_commit_outcome(
    report: &mut RuntimeProcessReport,
    outcome: Option<CommitOutcome>,
) -> Result<(), DurableRuntimeProcessorError> {
    let Some(outcome) = outcome else {
        return Ok(());
    };
    let height = outcome.height;
    let storage_elapsed = outcome.storage_elapsed;
    let publication_elapsed = outcome.publication_elapsed;
    report
        .post_commit_j_attempts
        .extend(outcome.post_commit_j_attempts);
    merge_publication_report(report, outcome.publication)?;
    report.durable_height = Some(height);
    report.timings.storage = storage_elapsed;
    report.timings.publication = publication_elapsed;
    report.timings.storage_prepare_validate = outcome.storage_timings.prepare_validate;
    report.timings.storage_batch_build = outcome.storage_timings.batch_build;
    report.timings.storage_db_write_sync = outcome.storage_timings.db_write_sync;
    report.timings.storage_directory_sync = outcome.storage_timings.directory_sync;
    report.timings.storage_post_commit = outcome.storage_timings.post_commit;
    report.timings.committer_busy = outcome.committer_busy_elapsed;
    report.timings.committer_idle = outcome.committer_idle_elapsed;
    Ok(())
}

fn merge_publication_report(
    aggregate: &mut RuntimeProcessReport,
    report: RuntimeProcessReport,
) -> Result<(), DurableRuntimeProcessorError> {
    aggregate.durable_height = report.durable_height.or(aggregate.durable_height);
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
    Ok(())
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
    #[error("RRS_PROCESSOR_COMMITTER_UNAVAILABLE")]
    CommitterUnavailable,
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

#[cfg(test)]
mod timing_tests {
    use super::*;

    #[test]
    fn commit_wall_decomposition_is_copied_without_changing_report_authority() {
        let storage_timings = NativeStorageTimings {
            prepare_validate: Duration::from_micros(1),
            batch_build: Duration::from_micros(2),
            db_write_sync: Duration::from_micros(3),
            directory_sync: Duration::from_micros(4),
            post_commit: Duration::from_micros(5),
        };
        let mut report = RuntimeProcessReport::default();
        merge_commit_outcome(
            &mut report,
            Some(CommitOutcome {
                height: 7,
                publication: RuntimeProcessReport::default(),
                storage_elapsed: Duration::from_micros(20),
                publication_elapsed: Duration::from_micros(6),
                storage_timings,
                committer_busy_elapsed: Duration::from_micros(30),
                committer_idle_elapsed: Duration::from_micros(40),
                post_commit_j_attempts: Vec::new(),
            }),
        )
        .expect("merge");

        assert_eq!(report.durable_height, Some(7));
        assert_eq!(report.timings.storage, Duration::from_micros(20));
        assert_eq!(report.timings.publication, Duration::from_micros(6));
        assert_eq!(
            report.timings.storage_prepare_validate,
            storage_timings.prepare_validate
        );
        assert_eq!(
            report.timings.storage_batch_build,
            storage_timings.batch_build
        );
        assert_eq!(
            report.timings.storage_db_write_sync,
            storage_timings.db_write_sync
        );
        assert_eq!(
            report.timings.storage_directory_sync,
            storage_timings.directory_sync
        );
        assert_eq!(
            report.timings.storage_post_commit,
            storage_timings.post_commit
        );
        assert_eq!(report.timings.committer_busy, Duration::from_micros(30));
        assert_eq!(report.timings.committer_idle, Duration::from_micros(40));
    }
}
