use xln_rscore_abi::{EngineIdentity, Envelope, MessageKind, ProtocolBinding};
use xln_rscore_batch::{
    CandidateId, EngineGeneration, PreparedBatch, StatefulBatchEngine, StatefulConsensusEngine,
};

use crate::candidate::{CandidateToken, ProcessIncarnation};
use crate::wire_decode::{AuthorityConfig, Command, decode_command};
use crate::{ProcessError, wire_encode};

pub struct ProcessReply {
    pub envelope: Envelope,
    pub shutdown: bool,
}

pub struct ProcessSession {
    incarnation: ProcessIncarnation,
    binding: Option<SessionBinding>,
    worker_count: usize,
    swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
    last_request_id: Option<u64>,
    engine: Option<StatefulBatchEngine>,
    /// The authoritative engine, when the runtime asked for one at Hello. A
    /// session is one or the other for its whole life: mirroring and owning
    /// the accounts are different jobs, and a process that could switch would
    /// have two answers to "what is the account".
    authority: Option<Box<StatefulConsensusEngine>>,
    authority_config: Option<AuthorityConfig>,
    pending: Option<PendingBatch>,
    pending_wave: Option<PendingWave>,
    /// A candidate checkpoint whose Runtime frame is durable and whose wave
    /// was committed, but whose incremental debt has not yet been
    /// acknowledged. While this exists, CommitCheckpoint is the only legal
    /// next operation.
    pending_checkpoint: Option<PendingCheckpoint>,
    stopped: bool,
}

/// The wave the engine is holding, and the request that produced it.
struct PendingWave {
    token: CandidateToken,
    candidate_id: CandidateId,
    revision: u64,
    sealed: bool,
    checkpoint: Option<PendingCheckpoint>,
}

#[derive(Clone, Copy)]
struct PendingCheckpoint {
    commit_token: xln_rscore_batch::CheckpointToken,
    restore_token: xln_rscore_batch::CheckpointToken,
}

struct SessionBinding {
    protocol: ProtocolBinding,
    engine_generation: [u8; 8],
    runtime_id: [u8; 20],
    session_id: [u8; 16],
}

struct PendingBatch {
    token: CandidateToken,
    candidate: PreparedBatch,
}

type SavepointAction =
    fn(&mut StatefulConsensusEngine) -> Result<(u64, [u8; 32]), xln_rscore_batch::BatchError>;

impl ProcessSession {
    pub fn new() -> Self {
        Self::try_new().expect("operating-system entropy is required for rscore candidate tokens")
    }

    pub fn try_new() -> Result<Self, ProcessError> {
        Ok(Self::with_incarnation(ProcessIncarnation::fresh()?))
    }

    fn with_incarnation(incarnation: ProcessIncarnation) -> Self {
        Self {
            incarnation,
            binding: None,
            worker_count: 0,
            swap_market: std::sync::Arc::default(),
            last_request_id: None,
            engine: None,
            authority: None,
            authority_config: None,
            pending: None,
            pending_wave: None,
            pending_checkpoint: None,
            stopped: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_incarnation(bytes: [u8; 32]) -> Self {
        Self::with_incarnation(ProcessIncarnation::from_bytes(bytes))
    }

    pub fn handle(&mut self, request: Envelope) -> ProcessReply {
        let handled = self.dispatch_envelope(&request);
        let (message_kind, body, shutdown) = match handled {
            Ok((body, shutdown)) => (MessageKind::Ok, body, shutdown),
            Err(error) => (MessageKind::Error, wire_encode::error(&error), self.stopped),
        };
        ProcessReply {
            envelope: Envelope {
                binding: request.binding,
                identity: request.identity,
                op_tag: request.op_tag,
                message_kind,
                body,
            },
            shutdown,
        }
    }

    fn dispatch_envelope(
        &mut self,
        request: &Envelope,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.stopped {
            return Err(ProcessError::Stopped);
        }
        if request.message_kind != MessageKind::Request {
            return Err(ProcessError::RequestKind);
        }
        if self.binding.is_none() {
            return self.start(request, decode_command(request)?);
        }
        self.validate_bound_request(request)?;
        self.last_request_id = Some(request_id(&request.identity));
        self.dispatch(request.identity.request_id, decode_command(request)?)
    }

    fn start(
        &mut self,
        request: &Envelope,
        command: Command,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let Command::Hello {
            worker_count,
            swap_market,
            authority,
        } = command
        else {
            return Err(ProcessError::HelloRequired);
        };
        validate_payment_profile_binding(&request.binding)?;
        let actual = request_id(&request.identity);
        if actual != 0 {
            return Err(ProcessError::RequestId {
                actual,
                expected: 0,
            });
        }
        if !(1..=xln_rscore_batch::MAX_BATCH_WORKERS).contains(&worker_count) {
            return Err(xln_rscore_batch::BatchError::InvalidWorkerCount(worker_count).into());
        }
        // Hello defines the role of this process for its whole lifetime. Build
        // every fallible value beside the live session first: if authority key
        // validation failed after installing the binding, the same session
        // could continue at request 1 with `authority_config = None` and load a
        // mirror engine even though request 0 explicitly asked for authority.
        let binding = SessionBinding::from_request(request);
        let digest = swap_market.digest();
        let swap_market = std::sync::Arc::new(swap_market);
        let identity = authority.as_ref().map(authority_identity).transpose()?;
        let response = wire_encode::hello(worker_count, digest, identity);

        self.binding = Some(binding);
        self.worker_count = worker_count;
        self.last_request_id = Some(0);
        self.swap_market = swap_market;
        self.authority_config = authority;
        Ok((response, false))
    }

    fn validate_bound_request(&self, request: &Envelope) -> Result<(), ProcessError> {
        let binding = self.binding.as_ref().ok_or(ProcessError::HelloRequired)?;
        binding.validate(request)?;
        let expected = self
            .last_request_id
            .ok_or(ProcessError::HelloRequired)?
            .checked_add(1)
            .ok_or(ProcessError::RequestIdOverflow)?;
        let actual = request_id(&request.identity);
        if actual != expected {
            return Err(ProcessError::RequestId { actual, expected });
        }
        Ok(())
    }

    fn dispatch(
        &mut self,
        request_id: [u8; 8],
        command: Command,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending_checkpoint.is_some()
            && !matches!(&command, Command::CommitCheckpoint { .. })
        {
            return Err(ProcessError::CheckpointPending);
        }
        if self.pending_wave.is_some()
            && !matches!(
                &command,
                Command::BeginEntity { .. }
                    | Command::ApplyAccountWave { .. }
                    | Command::ProposeAccountWave { .. }
                    | Command::FinalizeEntity { .. }
                    | Command::DiscardEntity { .. }
                    | Command::SealAccountWave { .. }
                    | Command::GetCheckpointChanges { .. }
                    | Command::Commit { .. }
                    | Command::Abort { .. }
            )
        {
            return Err(ProcessError::PreparePending);
        }
        match command {
            Command::Hello { .. } => Err(ProcessError::HelloDuplicate),
            Command::BootstrapAccounts {
                revision,
                accounts,
                import_existing,
            } => self.load(revision, accounts, import_existing),
            Command::GetCheckpointChanges { candidate_token } => {
                self.get_checkpoint_changes(candidate_token)
            }
            Command::CommitCheckpoint { token } => self.commit_checkpoint(&token),
            Command::RestoreExact { expected, accounts } => self.restore_exact(expected, accounts),
            Command::PrepareAccountWave { request } => self.prepare_wave(request_id, *request),
            Command::BeginEntity {
                candidate_token,
                stage_key,
                expected_accepted_ordinal,
                context,
            } => self.begin_entity_stage(
                candidate_token,
                stage_key,
                expected_accepted_ordinal,
                context,
            ),
            Command::Checkpoint => self.checkpoint(),
            Command::PushSavepoint => self.savepoint(StatefulConsensusEngine::push_savepoint),
            Command::KeepSavepoint => self.savepoint(StatefulConsensusEngine::keep_savepoint),
            Command::UndoSavepoint => self.savepoint(StatefulConsensusEngine::undo_savepoint),
            Command::AccountInbound { request } => self.account_inbound(*request),
            Command::AccountOutbound { request } => self.account_outbound(*request),
            Command::ApplyAccountWave {
                candidate_token,
                stage_key,
                request,
            } => self.apply_wave(candidate_token, stage_key, *request),
            Command::ProposeAccountWave {
                candidate_token,
                stage_key,
                request,
            } => self.propose_wave(candidate_token, stage_key, *request),
            Command::FinalizeEntity {
                candidate_token,
                stage_key,
                expected_accepted_ordinal,
            } => self.finish_entity_stage(
                candidate_token,
                stage_key,
                expected_accepted_ordinal,
                true,
            ),
            Command::DiscardEntity {
                candidate_token,
                stage_key,
                expected_accepted_ordinal,
            } => self.finish_entity_stage(
                candidate_token,
                stage_key,
                expected_accepted_ordinal,
                false,
            ),
            Command::SealAccountWave { candidate_token } => self.seal_wave(candidate_token),
            Command::Prepare { jobs } => self.prepare(request_id, &jobs),
            Command::Commit { candidate_token } => {
                if self.authority.is_some() {
                    self.commit_wave(candidate_token)
                } else {
                    self.commit(candidate_token)
                }
            }
            Command::Abort { candidate_token } => {
                if self.authority.is_some() {
                    self.abort_wave(candidate_token)
                } else {
                    self.abort(candidate_token)
                }
            }
            Command::Shutdown => self.shutdown(),
            Command::UpsertAccounts { accounts } => self.upsert_accounts(accounts),
            Command::UpdateAccountShells { shells } => self.update_account_shells(shells),
            Command::RemoveAccounts { account_ids } => self.remove_accounts(&account_ids),
            Command::ReadCapacityBatch { requests } => self.capacity_batch(&requests),
            Command::ReadAccountSummaryPage {
                cursor,
                limit,
                token_ids,
            } => self.summary_page(cursor, limit, &token_ids),
            Command::ReadAccountEnvelope { account_id } => self.account_envelope(account_id),
        }
    }

    /// Read-only: serves the committed map even while a Prepare is pending.
    fn capacity_batch(
        &self,
        requests: &[xln_rscore_batch::CapacityRequest],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self.engine.as_ref().ok_or(ProcessError::EngineNotLoaded)?;
        Ok((
            wire_encode::capacity_rows(engine.revision(), &engine.capacity_batch(requests)),
            false,
        ))
    }

    /// Read-only page plus whole-engine reducers computed inside the engine.
    fn summary_page(
        &self,
        cursor: Option<xln_rscore_batch::AccountId>,
        limit: usize,
        token_ids: &[xln_rscore_engine::TokenId],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self.engine.as_ref().ok_or(ProcessError::EngineNotLoaded)?;
        let (rows, next_cursor) = engine.summary_page(cursor, limit)?;
        let totals = engine.totals(token_ids);
        Ok((
            wire_encode::summary_page(engine.revision(), &rows, next_cursor, &totals),
            false,
        ))
    }

    /// Read-only: the committed leaf projection of one account, so a runtime
    /// whose leaf disagrees can name the field instead of the hash.
    fn account_envelope(
        &self,
        account_id: xln_rscore_batch::AccountId,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self
            .authority
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let account = engine
            .account(&account_id)
            .ok_or(ProcessError::EngineNotLoaded)?;
        let fields = account
            .projected_leaf_fields()
            .map_err(|error| ProcessError::Envelope(error.to_string()))?;
        Ok((
            wire_encode::account_envelope(engine.revision(), &fields),
            false,
        ))
    }

    /// One runtime frame, against a candidate this process keeps until the
    /// runtime has made its own record of it durable.
    fn issue_candidate_token(
        &self,
        prepare_request_id: [u8; 8],
        candidate_id: CandidateId,
    ) -> Result<CandidateToken, ProcessError> {
        let binding = self.binding.as_ref().ok_or(ProcessError::HelloRequired)?;
        Ok(CandidateToken::issue(
            self.incarnation,
            binding.protocol.protocol_fingerprint,
            binding.engine_generation,
            binding.runtime_id,
            binding.session_id,
            prepare_request_id,
            candidate_id,
        ))
    }

    fn prepare_wave(
        &mut self,
        request_id: [u8; 8],
        request: xln_rscore_batch::WaveRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        // Prepare owns only the Runtime candidate capability. Accepting even
        // one Entity here would apply its Account work before BeginEntity had
        // established the stage key and rollback savepoint that authorize it.
        if !request.entities.is_empty() {
            return Err(ProcessError::PrepareWaveNonempty {
                entities: request.entities.len(),
            });
        }
        if self.pending_wave.is_some() {
            return Err(ProcessError::PreparePending);
        }
        let (result, engine_micros) = {
            let engine = self
                .authority
                .as_mut()
                .ok_or(ProcessError::EngineNotLoaded)?;
            let started = std::time::Instant::now();
            let result = engine.prepare_wave(request)?;
            let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            (result, engine_micros)
        };
        let token = self.issue_candidate_token(request_id, result.candidate_id)?;
        let response = self.encode_wave_after_mutation(&result, engine_micros, Some(token))?;
        self.pending_wave = Some(PendingWave {
            token,
            candidate_id: result.candidate_id,
            revision: result.revision,
            sealed: false,
            checkpoint: None,
        });
        Ok((response, false))
    }

    /// The rows that moved since the last durable checkpoint.
    ///
    /// Taken from the committed tree at a Runtime frame boundary: the runtime
    /// writes them, fsyncs, and only then acknowledges the token.
    fn checkpoint(&mut self) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self
            .authority
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let checkpoint = engine.checkpoint_changes()?;
        let response = crate::checkpoint_wire::changes(&checkpoint)?;
        self.pending_checkpoint = Some(PendingCheckpoint {
            commit_token: checkpoint.token,
            restore_token: checkpoint.restore_token(),
        });
        Ok((response, false))
    }

    /// Where the accounts stand after marking, keeping or undoing a savepoint.
    fn savepoint(
        &mut self,
        act: SavepointAction,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let (revision, root) = act(engine)?;
        Ok((crate::wire_encode::savepoint(revision, root), false))
    }

    /// One Entity input's inbound half. Nothing is staged: the accounts move
    /// when the Entity says they move, and the reply is what happened.
    fn account_inbound(
        &mut self,
        request: xln_rscore_batch::EntityInboundRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = engine.entity_inbound(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        Ok((crate::wire_encode::round(&result, engine_micros)?, false))
    }

    /// One Entity input's outbound half.
    fn account_outbound(
        &mut self,
        request: xln_rscore_batch::EntityOutboundRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = engine.entity_outbound(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        Ok((crate::wire_encode::round(&result, engine_micros)?, false))
    }

    fn apply_wave(
        &mut self,
        candidate_token: [u8; 32],
        stage_key: xln_rscore_batch::StageKey,
        request: xln_rscore_batch::WaveOpsRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let candidate_id = self.pending_wave_for(candidate_token)?.candidate_id;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        engine.require_entity_stage(stage_key)?;
        let started = std::time::Instant::now();
        let result = engine.apply_wave_ops(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        if result.candidate_id != candidate_id {
            self.stopped = true;
            return Err(ProcessError::CandidateTokenMismatch);
        }
        let response = self.encode_wave_after_mutation(&result, engine_micros, None)?;
        self.pending_wave
            .as_mut()
            .ok_or(ProcessError::PrepareNotPending)?
            .revision = result.revision;
        Ok((response, false))
    }

    fn propose_wave(
        &mut self,
        candidate_token: [u8; 32],
        stage_key: xln_rscore_batch::StageKey,
        request: xln_rscore_batch::WaveProposalRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let candidate_id = self.pending_wave_for(candidate_token)?.candidate_id;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        engine.require_entity_stage(stage_key)?;
        let started = std::time::Instant::now();
        let result = engine.propose_wave(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        if result.candidate_id != candidate_id {
            self.stopped = true;
            return Err(ProcessError::CandidateTokenMismatch);
        }
        let response = self.encode_wave_after_mutation(&result, engine_micros, None)?;
        self.pending_wave
            .as_mut()
            .ok_or(ProcessError::PrepareNotPending)?
            .revision = result.revision;
        Ok((response, false))
    }

    fn begin_entity_stage(
        &mut self,
        candidate_token: [u8; 32],
        stage_key: xln_rscore_batch::StageKey,
        expected_accepted_ordinal: u64,
        context: xln_rscore_batch::EntityStageContext,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        self.pending_wave_for(candidate_token)?;
        let (receipt, revision, accounts_root) = {
            let engine = self
                .authority
                .as_mut()
                .ok_or(ProcessError::EngineNotLoaded)?;
            let receipt =
                engine.begin_entity_stage(stage_key, expected_accepted_ordinal, context)?;
            (receipt, engine.revision(), engine.accounts_root())
        };
        let response =
            self.encode_entity_stage_after_mutation(&receipt, revision, accounts_root)?;
        self.pending_wave
            .as_mut()
            .ok_or(ProcessError::PrepareNotPending)?
            .revision = revision;
        Ok((response, false))
    }

    fn finish_entity_stage(
        &mut self,
        candidate_token: [u8; 32],
        stage_key: xln_rscore_batch::StageKey,
        expected_accepted_ordinal: u64,
        accept: bool,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        self.pending_wave_for(candidate_token)?;
        let (receipt, revision, accounts_root) = {
            let engine = self
                .authority
                .as_mut()
                .ok_or(ProcessError::EngineNotLoaded)?;
            let receipt = if accept {
                engine.accept_entity_stage(stage_key, expected_accepted_ordinal)?
            } else {
                engine.rollback_entity_stage(stage_key, expected_accepted_ordinal)?
            };
            (receipt, engine.revision(), engine.accounts_root())
        };
        let response =
            self.encode_entity_stage_after_mutation(&receipt, revision, accounts_root)?;
        self.pending_wave
            .as_mut()
            .ok_or(ProcessError::PrepareNotPending)?
            .revision = revision;
        Ok((response, false))
    }

    /// Entity-stage calls mutate the held candidate before their reply exists.
    /// If reply construction ever becomes fallible, the process must not
    /// continue with candidate state the runtime never observed.
    fn encode_entity_stage_after_mutation(
        &mut self,
        receipt: &xln_rscore_batch::EntityStageReceipt,
        revision: u64,
        accounts_root: [u8; 32],
    ) -> Result<xln_rscore_abi::BodyTuple, ProcessError> {
        match wire_encode::entity_stage(receipt, revision, accounts_root) {
            Ok(response) => Ok(response),
            Err(error) => {
                self.stopped = true;
                Err(error)
            }
        }
    }

    fn seal_wave(
        &mut self,
        candidate_token: [u8; 32],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let candidate_id = self.pending_wave_for(candidate_token)?.candidate_id;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = engine.seal_wave()?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        if result.candidate_id != candidate_id {
            self.stopped = true;
            return Err(ProcessError::CandidateTokenMismatch);
        }
        let response = self.encode_wave_after_mutation(&result, engine_micros, None)?;
        let pending = self
            .pending_wave
            .as_mut()
            .ok_or(ProcessError::PrepareNotPending)?;
        pending.revision = result.revision;
        pending.sealed = true;
        Ok((response, false))
    }

    /// A successful staged call has already mutated the authority candidate.
    /// Returning a recoverable encoding error would expose that mutation while
    /// session metadata can still name the preceding revision. In particular,
    /// a later Abort could miss the engine revision and leave the candidate
    /// usable without any reply that described it. Make the error reply this
    /// process's last reply; restart restores the last durable checkpoint.
    fn encode_wave_after_mutation(
        &mut self,
        result: &xln_rscore_batch::WaveResult,
        engine_micros: u64,
        token: Option<CandidateToken>,
    ) -> Result<xln_rscore_abi::BodyTuple, ProcessError> {
        let encoded = match token {
            Some(token) => wire_encode::prepared_wave(result, engine_micros, token.as_bytes()),
            None => wire_encode::wave(result, engine_micros),
        };
        match encoded {
            Ok(response) => Ok(response),
            Err(error) => {
                self.stopped = true;
                Err(error)
            }
        }
    }

    fn commit_wave(
        &mut self,
        candidate_token: [u8; 32],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let candidate_id = self.sealed_wave_for(candidate_token)?.candidate_id;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        match engine.commit_wave(candidate_id) {
            Ok(accounts_root) => {
                let pending = self
                    .pending_wave
                    .take()
                    .ok_or(ProcessError::PrepareNotPending)?;
                self.pending_checkpoint = pending.checkpoint;
                Ok((
                    wire_encode::wave_committed(engine.revision(), accounts_root),
                    false,
                ))
            }
            Err(error) => {
                // A commit that cannot be honoured leaves this process and the
                // runtime disagreeing about what happened; there is nothing
                // safe to serve after that.
                self.stopped = true;
                Err(error.into())
            }
        }
    }

    fn abort_wave(
        &mut self,
        candidate_token: [u8; 32],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let candidate_id = self.pending_wave_for(candidate_token)?.candidate_id;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let revision = engine.abort_wave(candidate_id)?;
        self.pending_wave = None;
        Ok((
            wire_encode::wave_aborted(revision, engine.accounts_root()),
            false,
        ))
    }

    fn pending_wave_for(&self, actual: [u8; 32]) -> Result<&PendingWave, ProcessError> {
        let pending = self
            .pending_wave
            .as_ref()
            .ok_or(ProcessError::PrepareNotPending)?;
        if pending.token != CandidateToken::from_bytes(actual) {
            return Err(ProcessError::CandidateTokenMismatch);
        }
        Ok(pending)
    }

    fn sealed_wave_for(&self, actual: [u8; 32]) -> Result<&PendingWave, ProcessError> {
        let pending = self.pending_wave_for(actual)?;
        if !pending.sealed {
            return Err(xln_rscore_batch::BatchError::WaveOpen.into());
        }
        Ok(pending)
    }

    fn load(
        &mut self,
        revision: u64,
        accounts: Vec<xln_rscore_batch::AccountSeed>,
        import_existing: bool,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.engine.is_some() || self.authority.is_some() {
            return Err(ProcessError::EngineAlreadyLoaded);
        }
        let binding = self.binding.as_ref().ok_or(ProcessError::HelloRequired)?;
        if let Some(config) = self.authority_config.as_ref() {
            // Bootstrap creates only a brand-new empty authority. Any account
            // or nonzero revision is durable history and must arrive through
            // RestoreExact, whose token binds every leaf, signer and revision.
            // A declared import is the caller taking responsibility for the
            // starting state: a read-only replay of a recording made before
            // the authority existed has no checkpoint to restore from. It
            // still may not invent history — the revision must be zero.
            if revision != 0 || (!accounts.is_empty() && !import_existing) {
                return Err(ProcessError::AuthorityBootstrapInvalid {
                    revision,
                    accounts: accounts.len(),
                });
            }
            let engine = StatefulConsensusEngine::restore(
                EngineGeneration::from_bytes(binding.engine_generation),
                self.worker_count,
                revision,
                config.private_key,
                config.signer_id.clone(),
                std::sync::Arc::clone(&self.swap_market),
                accounts,
            )?;
            let accounts_root = engine.accounts_root();
            self.authority = Some(Box::new(engine));
            return Ok((wire_encode::loaded(revision, accounts_root), false));
        }
        let engine = StatefulBatchEngine::restore(
            EngineGeneration::from_bytes(binding.engine_generation),
            self.worker_count,
            revision,
            accounts,
        )?;
        let accounts_root = engine.accounts_root();
        self.engine = Some(engine);
        Ok((wire_encode::loaded(revision, accounts_root), false))
    }

    fn get_checkpoint_changes(
        &mut self,
        candidate_token: [u8; 32],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let candidate_id = self.sealed_wave_for(candidate_token)?.candidate_id;
        let engine = self
            .authority
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let checkpoint = engine.checkpoint_changes_for_wave(candidate_id)?;
        let response = crate::checkpoint_wire::changes(&checkpoint)?;
        let ticket = PendingCheckpoint {
            commit_token: checkpoint.token,
            restore_token: checkpoint.restore_token(),
        };
        let pending = self
            .pending_wave
            .as_mut()
            .ok_or(ProcessError::PrepareNotPending)?;
        if pending.token != CandidateToken::from_bytes(candidate_token) {
            return Err(ProcessError::CandidateTokenMismatch);
        }
        pending.checkpoint = Some(ticket);
        Ok((response, false))
    }

    fn commit_checkpoint(
        &mut self,
        token: &xln_rscore_batch::CheckpointToken,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let ticket = self
            .pending_checkpoint
            .ok_or(ProcessError::CheckpointNotPending)?;
        if *token != ticket.commit_token {
            return Err(xln_rscore_batch::BatchError::CheckpointToken {
                actual: format!("{token:?}"),
                expected: format!("{:?}", ticket.commit_token),
            }
            .into());
        }
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        engine.commit_checkpoint(token)?;
        let normalized = engine.checkpoint_token()?;
        if normalized != ticket.restore_token {
            self.stopped = true;
            return Err(xln_rscore_batch::BatchError::CheckpointToken {
                actual: format!("{normalized:?}"),
                expected: format!("{:?}", ticket.restore_token),
            }
            .into());
        }
        self.pending_checkpoint = None;
        Ok((
            crate::checkpoint_wire::checkpoint_committed(&normalized),
            false,
        ))
    }

    /// Replace an authority session from exact durable rows. The candidate
    /// engine is built beside the session and installed only after every leaf,
    /// the forest root and signer digest have been verified.
    fn restore_exact(
        &mut self,
        expected: xln_rscore_batch::CheckpointToken,
        accounts: Vec<xln_rscore_batch::AccountRestore>,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.engine.is_some() || self.authority.is_some() {
            return Err(ProcessError::EngineAlreadyLoaded);
        }
        let binding = self.binding.as_ref().ok_or(ProcessError::HelloRequired)?;
        let config = self
            .authority_config
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let mut restored = StatefulConsensusEngine::restore(
            EngineGeneration::from_bytes(binding.engine_generation),
            self.worker_count,
            expected.revision,
            config.private_key,
            config.signer_id.clone(),
            std::sync::Arc::clone(&self.swap_market),
            Vec::new(),
        )?;
        restored.restore_accounts(accounts, &expected)?;
        let normalized = restored.checkpoint_token()?;
        if normalized != expected {
            return Err(xln_rscore_batch::BatchError::CheckpointToken {
                actual: format!("{normalized:?}"),
                expected: format!("{expected:?}"),
            }
            .into());
        }
        self.authority = Some(Box::new(restored));
        Ok((crate::checkpoint_wire::exact_restored(&normalized), false))
    }

    fn upsert_accounts(
        &mut self,
        accounts: Vec<xln_rscore_batch::AccountSeed>,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        // Authority membership is created only by a staged WaveOp::Create or
        // exact recovery. Upsert is a mirror import primitive: allowing it
        // here would mutate the authoritative tree outside the Runtime-frame
        // candidate and leave WAL/abort unable to account for the new leaf.
        if self.authority.is_some() {
            return Err(ProcessError::AuthorityUpsertForbidden);
        }
        if self.pending.is_some() || self.pending_wave.is_some() {
            return Err(ProcessError::PreparePending);
        }
        let engine = self.engine.as_mut().ok_or(ProcessError::EngineNotLoaded)?;
        let accounts_root = engine.upsert_accounts(accounts)?;
        Ok((
            wire_encode::upserted(engine.revision(), accounts_root),
            false,
        ))
    }

    /// Shell-only refresh: the Entity commits mempool, frame bindings, hankos
    /// and acks around a state no account transaction touches, and they move
    /// between account frames. Without this the engine's leaf would be the
    /// Entity's leaf only at the instant a frame committed.
    fn update_account_shells(
        &mut self,
        shells: Vec<(
            xln_rscore_batch::AccountId,
            xln_rscore_engine::AccountEnvelope,
        )>,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending.is_some() {
            return Err(ProcessError::PreparePending);
        }
        let engine = self.engine.as_mut().ok_or(ProcessError::EngineNotLoaded)?;
        let accounts_root = engine.update_shells(shells)?;
        Ok((
            wire_encode::upserted(engine.revision(), accounts_root),
            false,
        ))
    }

    fn remove_accounts(
        &mut self,
        account_ids: &[xln_rscore_batch::AccountId],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending.is_some() {
            return Err(ProcessError::PreparePending);
        }
        let engine = self.engine.as_mut().ok_or(ProcessError::EngineNotLoaded)?;
        let accounts_root = engine.remove_accounts(account_ids)?;
        Ok((
            wire_encode::upserted(engine.revision(), accounts_root),
            false,
        ))
    }

    fn prepare(
        &mut self,
        request_id: [u8; 8],
        jobs: &[xln_rscore_batch::BatchJob],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending.is_some() {
            return Err(ProcessError::PreparePending);
        }
        // The session owns the market tables; every job executes against the
        // exact policy installed at Hello.
        let jobs: Vec<xln_rscore_batch::BatchJob> = jobs
            .iter()
            .map(|job| {
                let mut job = job.clone();
                job.context.swap_market = std::sync::Arc::clone(&self.swap_market);
                job
            })
            .collect();
        // Engine-side execution time, excluding transport and encoding: the
        // caller compares it against its own reducer to see which side is
        // actually faster, not how fast the pipe is.
        let (candidate, engine_micros) = {
            let engine = self.engine.as_mut().ok_or(ProcessError::EngineNotLoaded)?;
            let started = std::time::Instant::now();
            let candidate = engine.prepare(&jobs)?;
            let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            (candidate, engine_micros)
        };
        let token = self.issue_candidate_token(request_id, candidate.candidate_id())?;
        let response = wire_encode::prepared(&candidate, engine_micros, token.as_bytes())?;
        self.pending = Some(PendingBatch { token, candidate });
        Ok((response, false))
    }

    fn commit(
        &mut self,
        candidate_token: [u8; 32],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        self.validate_pending_token(candidate_token)?;
        let pending = self.pending.take().ok_or(ProcessError::PrepareNotPending)?;
        let engine = self.engine.as_mut().ok_or(ProcessError::EngineNotLoaded)?;
        match engine.commit(pending.candidate) {
            Ok(response) => Ok((wire_encode::committed(&response), false)),
            Err(error) => {
                self.stopped = true;
                Err(error.into())
            }
        }
    }

    fn abort(
        &mut self,
        candidate_token: [u8; 32],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        self.validate_pending_token(candidate_token)?;
        self.pending = None;
        let revision = self
            .engine
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?
            .revision();
        Ok((wire_encode::aborted(revision), false))
    }

    fn validate_pending_token(&self, actual: [u8; 32]) -> Result<(), ProcessError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(ProcessError::PrepareNotPending)?;
        if pending.token != CandidateToken::from_bytes(actual) {
            return Err(ProcessError::CandidateTokenMismatch);
        }
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending_checkpoint.is_some() {
            return Err(ProcessError::CheckpointPending);
        }
        if self.pending_wave.is_some() {
            return Err(ProcessError::PreparePending);
        }
        if self.pending.is_some() {
            return Err(ProcessError::PreparePending);
        }
        self.stopped = true;
        Ok((wire_encode::shutdown(), true))
    }
}

impl Default for ProcessSession {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionBinding {
    fn from_request(request: &Envelope) -> Self {
        Self {
            protocol: request.binding.clone(),
            engine_generation: request.identity.engine_generation,
            runtime_id: request.identity.runtime_id,
            session_id: request.identity.session_id,
        }
    }

    fn validate(&self, request: &Envelope) -> Result<(), ProcessError> {
        if self.protocol != request.binding {
            return Err(ProcessError::BindingMismatch);
        }
        if self.engine_generation != request.identity.engine_generation
            || self.runtime_id != request.identity.runtime_id
            || self.session_id != request.identity.session_id
        {
            return Err(ProcessError::IdentityMismatch);
        }
        Ok(())
    }
}

fn request_id(identity: &EngineIdentity) -> u64 {
    u64::from_be_bytes(identity.request_id)
}

fn validate_payment_profile_binding(binding: &ProtocolBinding) -> Result<(), ProcessError> {
    let expected = &crate::PAYMENT_PROFILE_BINDING;
    if binding.protocol_version != expected.protocol_version {
        return Err(ProcessError::ProtocolVersion {
            actual: binding.protocol_version,
            expected: expected.protocol_version,
        });
    }
    if binding.storage_schema_version != expected.storage_schema_version {
        return Err(ProcessError::StorageSchemaVersion {
            actual: binding.storage_schema_version,
            expected: expected.storage_schema_version,
        });
    }
    if binding.protocol_fingerprint != expected.protocol_fingerprint {
        return Err(ProcessError::ProtocolFingerprint {
            actual: binding.protocol_fingerprint,
            expected: expected.protocol_fingerprint,
        });
    }
    Ok(())
}

/// The identity an authoritative session will sign with, derived at Hello so
/// the runtime can check it before handing over any account. Same derivation
/// the engine uses per account (weight and threshold one, default delays):
/// the key alone defines the lazy entity, and the entity id is that board's
/// own hash.
fn authority_identity(config: &AuthorityConfig) -> Result<([u8; 20], [u8; 32]), ProcessError> {
    let identity = xln_rscore_engine::SigningIdentity::lazy_from_key(
        config.private_key,
        &config.signer_id,
        1,
        1,
        xln_rscore_engine::BoardDelays::default(),
    )
    .map_err(|error| {
        ProcessError::Batch(xln_rscore_batch::BatchError::Signing(error.to_string()))
    })?;
    let address = identity.signer_address().map_err(|error| {
        ProcessError::Batch(xln_rscore_batch::BatchError::Signing(error.to_string()))
    })?;
    Ok((address, *identity.entity_id()))
}
