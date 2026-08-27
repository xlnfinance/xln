use xln_rscore_abi::{EngineIdentity, Envelope, MessageKind, ProtocolBinding};
use xln_rscore_batch::{
    CandidateId, EngineGeneration, PreparedBatch, ResidentConsensusEngine, StatefulBatchEngine,
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
    authority: Option<Box<ResidentConsensusEngine>>,
    entity_state: Option<ResidentEntityHead>,
    authority_config: Option<AuthorityConfig>,
    pending: Option<PendingBatch>,
    stopped: bool,
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

struct ResidentEntityCandidate {
    accounts_root: [u8; 32],
    state: xln_rscore_entity_kernel::EntityStateSlice,
}

struct ResidentEntityHead {
    accepted_accounts_root: [u8; 32],
    accepted: xln_rscore_entity_kernel::EntityStateSlice,
    candidate: Option<ResidentEntityCandidate>,
}

/// Benchmark/import boundary after an exact bootstrap has been decoded once.
/// Production Runtime recovery constructs the same typed values from its
/// checkpoint store; replay tools use this to avoid ABI work in every frame.
#[cfg(feature = "bench")]
pub struct ResidentAuthorityBootstrap {
    pub accounts: ResidentConsensusEngine,
    pub accounts_root: [u8; 32],
    pub entity_state: xln_rscore_entity_kernel::EntityStateSlice,
}

impl ResidentEntityHead {
    fn select_parent(
        &mut self,
        accounts_root: [u8; 32],
        next_height: u64,
    ) -> Result<xln_rscore_entity_kernel::EntityStateSlice, ProcessError> {
        let accepts_candidate = self.candidate.as_ref().is_some_and(|candidate| {
            candidate.accounts_root == accounts_root
                && candidate.state.height.checked_add(1) == Some(next_height)
        });
        if accepts_candidate {
            let candidate = self.candidate.take().ok_or(ProcessError::EntityNotLoaded)?;
            self.accepted_accounts_root = candidate.accounts_root;
            self.accepted = candidate.state;
            return Ok(self.accepted.clone());
        }
        let retries_accepted = self.accepted_accounts_root == accounts_root
            && self.accepted.height.checked_add(1) == Some(next_height);
        if retries_accepted {
            self.candidate = None;
            return Ok(self.accepted.clone());
        }
        Err(ProcessError::EntityHead(format!(
            "expected={accounts_root:?}:nextHeight={next_height}:accepted={:?}@{}:candidate={:?}@{:?}",
            self.accepted_accounts_root,
            self.accepted.height,
            self.candidate.as_ref().map(|value| value.accounts_root),
            self.candidate.as_ref().map(|value| value.state.height),
        )))
    }
}

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
            entity_state: None,
            authority_config: None,
            pending: None,
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

    /// Consume a bootstrap-only session and move the resident financial state
    /// into a native Runtime replay. A session with an open Entity candidate
    /// is rejected: transcript execution must never masquerade as recovery.
    #[cfg(feature = "bench")]
    pub fn into_resident_authority(self) -> Result<ResidentAuthorityBootstrap, ProcessError> {
        let head = self.entity_state.ok_or(ProcessError::EntityNotLoaded)?;
        if head.candidate.is_some() {
            return Err(ProcessError::EntityHead(
                "RESIDENT_BOOTSTRAP_CANDIDATE_OPEN".to_string(),
            ));
        }
        let accounts = *self.authority.ok_or(ProcessError::EngineNotLoaded)?;
        if accounts.accounts_root() != head.accepted_accounts_root {
            return Err(ProcessError::EntityHead(
                "RESIDENT_BOOTSTRAP_ROOT_MISMATCH".to_string(),
            ));
        }
        Ok(ResidentAuthorityBootstrap {
            accounts,
            accounts_root: head.accepted_accounts_root,
            entity_state: head.accepted,
        })
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
        // A malformed outer command has not entered the deterministic request
        // stream. Decode it before spending the sequence number so a client
        // can correct framing and retry the same id. Once decoding succeeds,
        // dispatch errors do consume the id: the engine may already have
        // inspected or mutated request-scoped state.
        let command = decode_command(request)?;
        self.last_request_id = Some(request_id(&request.identity));
        self.dispatch(request.identity.request_id, command)
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
        match command {
            Command::Hello { .. } => Err(ProcessError::HelloDuplicate),
            Command::BootstrapAccounts {
                revision,
                accounts,
                import_existing,
            } => self.load(revision, accounts, import_existing),
            Command::AuthorityTwoCallOnly => Err(ProcessError::AuthorityTwoCallOnly),
            Command::RestoreExact { expected, accounts } => self.restore_exact(expected, accounts),
            Command::AccountInbound { request } => self.account_inbound(*request),
            Command::AccountOutbound { request } => self.account_outbound(*request),
            Command::BootstrapEntity { snapshot } => self.bootstrap_entity(*snapshot),
            Command::EntityRound { request, context } => self.entity_round(*request, *context),
            Command::Prepare { jobs } => self.prepare(request_id, &jobs),
            Command::Commit { candidate_token } => {
                if self.authority.is_some() {
                    Err(ProcessError::AuthorityTwoCallOnly)
                } else {
                    self.commit(candidate_token)
                }
            }
            Command::Abort { candidate_token } => {
                if self.authority.is_some() {
                    Err(ProcessError::AuthorityTwoCallOnly)
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
        _account_id: xln_rscore_batch::AccountId,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        Err(ProcessError::AuthorityTwoCallOnly)
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

    /// One Entity input's inbound half. Nothing is staged: the accounts move
    /// when the Entity says they move, and the reply is what happened.
    fn account_inbound(
        &mut self,
        request: xln_rscore_batch::EntityInboundRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.entity_state.is_some() {
            return Err(ProcessError::EntityModeOnly);
        }
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = engine.entity_inbound(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        let response = self.encode_resident_round_after_mutation(&result, engine_micros)?;
        Ok((response, false))
    }

    /// One Entity input's outbound half.
    fn account_outbound(
        &mut self,
        request: xln_rscore_batch::EntityOutboundRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.entity_state.is_some() {
            return Err(ProcessError::EntityModeOnly);
        }
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = engine.entity_outbound(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        let response = self.encode_resident_round_after_mutation(&result, engine_micros)?;
        Ok((response, false))
    }

    fn bootstrap_entity(
        &mut self,
        snapshot: xln_rscore_entity_kernel::EntityStateSnapshot,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.entity_state.is_some() {
            return Err(ProcessError::EntityAlreadyLoaded);
        }
        let engine = self
            .authority
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let state = xln_rscore_entity_kernel::restore_entity_state(
            snapshot,
            engine.accounts_root(),
            engine.account_count(),
        )?;
        let sections = xln_rscore_entity_kernel::compute_entity_owned_sections(
            &state,
            engine.accounts_root(),
            engine.account_count(),
        )?;
        let response = crate::entity_wire::encode_entity_loaded(engine.accounts_root(), &sections)?;
        self.entity_state = Some(ResidentEntityHead {
            accepted_accounts_root: engine.accounts_root(),
            accepted: state,
            candidate: None,
        });
        Ok((response, false))
    }

    fn entity_round(
        &mut self,
        request: xln_rscore_entity_kernel::ResidentEntityRequest,
        context: xln_rscore_entity_kernel::DeterministicContext,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let mut head = self
            .entity_state
            .take()
            .ok_or(ProcessError::EntityNotLoaded)?;
        let state = match head.select_parent(
            request.inbound.expected_accounts_root,
            request.entity_height,
        ) {
            Ok(state) => state,
            Err(error) => {
                self.entity_state = Some(head);
                return Err(error);
            }
        };
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = match xln_rscore_entity_kernel::apply_resident_entity_round(
            engine, state, request, &context,
        ) {
            Ok(result) => result,
            Err(error) => {
                self.stopped = true;
                return Err(error.into());
            }
        };
        report_account_shard_profile(engine);
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        let sections = match xln_rscore_entity_kernel::compute_entity_owned_sections(
            &result.state,
            result.outbound.accounts_root,
            engine.account_count(),
        ) {
            Ok(sections) => sections,
            Err(error) => {
                self.stopped = true;
                return Err(error.into());
            }
        };
        let response =
            match crate::entity_wire::encode_entity_round(&result, &sections, engine_micros) {
                Ok(response) => response,
                Err(error) => {
                    self.stopped = true;
                    return Err(error);
                }
            };
        head.candidate = Some(ResidentEntityCandidate {
            accounts_root: result.outbound.accounts_root,
            state: result.state,
        });
        self.entity_state = Some(head);
        Ok((response, false))
    }

    /// Both resident visits mutate an internal base/candidate head before the
    /// reply exists. If encoding fails, the parent never observed that head;
    /// continuing would let a later root assertion reconcile state that was
    /// never durably recorded. Checkpoint export is non-acknowledging, but its
    /// pending root is likewise invisible unless this reply is encoded, so any
    /// post-mutation encoding failure remains process-fatal.
    fn encode_resident_round_after_mutation(
        &mut self,
        result: &xln_rscore_batch::EntityRoundResult,
        engine_micros: u64,
    ) -> Result<xln_rscore_abi::BodyTuple, ProcessError> {
        match wire_encode::round(result, engine_micros) {
            Ok(response) => Ok(response),
            Err(error) => {
                self.stopped = true;
                Err(error)
            }
        }
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
            let engine = if import_existing {
                ResidentConsensusEngine::import_existing(
                    EngineGeneration::from_bytes(binding.engine_generation),
                    self.worker_count,
                    config.private_key,
                    config.signer_id.clone(),
                    std::sync::Arc::clone(&self.swap_market),
                    accounts,
                )?
            } else {
                ResidentConsensusEngine::restore(
                    EngineGeneration::from_bytes(binding.engine_generation),
                    self.worker_count,
                    revision,
                    config.private_key,
                    config.signer_id.clone(),
                    std::sync::Arc::clone(&self.swap_market),
                    accounts,
                )?
            };
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
        let restored = ResidentConsensusEngine::restore_exact(
            EngineGeneration::from_bytes(binding.engine_generation),
            self.worker_count,
            config.private_key,
            config.signer_id.clone(),
            std::sync::Arc::clone(&self.swap_market),
            expected,
            accounts,
        )?;
        self.authority = Some(Box::new(restored));
        Ok((crate::checkpoint_wire::exact_restored(&expected), false))
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
        if self.pending.is_some() {
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

fn report_account_shard_profile(engine: &ResidentConsensusEngine) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_SHARDS").as_deref() == Ok("1")) {
        return;
    }
    let mut worker_items = vec![0_u64; engine.worker_count()];
    let mut worker_nanos = vec![0_u64; engine.worker_count()];
    let mut active_shards = 0_usize;
    for metric in engine.account_shard_metrics() {
        let worker = usize::from(metric.worker);
        worker_items[worker] = worker_items[worker].saturating_add(metric.work_items);
        worker_nanos[worker] = worker_nanos[worker]
            .saturating_add(metric.work_nanos)
            .saturating_add(metric.fold_nanos);
        active_shards += usize::from(metric.work_items > 0 || metric.fold_leaves > 0);
    }
    eprintln!(
        "RSCORE_SHARD_PROFILE activeShards={active_shards} workerItems={worker_items:?} workerNanos={worker_nanos:?}"
    );
}
