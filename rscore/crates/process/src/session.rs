use xln_rscore_abi::{EngineIdentity, Envelope, MessageKind, ProtocolBinding};
use xln_rscore_batch::{
    EngineGeneration, PreparedBatch, StatefulBatchEngine, StatefulConsensusEngine,
};

use crate::wire_decode::{AuthorityConfig, Command, decode_command};
use crate::{ProcessError, wire_encode};

pub struct ProcessReply {
    pub envelope: Envelope,
    pub shutdown: bool,
}

pub struct ProcessSession {
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
    stopped: bool,
}

/// The wave the engine is holding, and the request that produced it.
struct PendingWave {
    prepare_request_id: [u8; 8],
    revision: u64,
}

struct SessionBinding {
    protocol: ProtocolBinding,
    engine_generation: [u8; 8],
    runtime_id: [u8; 20],
    session_id: [u8; 16],
}

struct PendingBatch {
    prepare_request_id: [u8; 8],
    candidate: PreparedBatch,
}

impl ProcessSession {
    pub fn new() -> Self {
        Self {
            binding: None,
            worker_count: 0,
            swap_market: std::sync::Arc::default(),
            last_request_id: None,
            engine: None,
            authority: None,
            authority_config: None,
            pending: None,
            pending_wave: None,
            stopped: false,
        }
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
        self.binding = Some(SessionBinding::from_request(request));
        self.worker_count = worker_count;
        self.last_request_id = Some(0);
        let digest = swap_market.digest();
        self.swap_market = std::sync::Arc::new(swap_market);
        let identity = authority.as_ref().map(authority_identity).transpose()?;
        self.authority_config = authority;
        Ok((wire_encode::hello(worker_count, digest, identity), false))
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
            Command::Restore { revision, accounts } => self.load(revision, accounts),
            Command::PrepareAccountWave { request } => self.prepare_wave(request_id, *request),
            Command::Prepare { jobs } => self.prepare(request_id, &jobs),
            Command::Commit { prepare_request_id } => {
                if self.authority.is_some() {
                    self.commit_wave(prepare_request_id)
                } else {
                    self.commit(prepare_request_id)
                }
            }
            Command::Abort { prepare_request_id } => {
                if self.authority.is_some() {
                    self.abort_wave(prepare_request_id)
                } else {
                    self.abort(prepare_request_id)
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

    /// One runtime frame, against a candidate this process keeps until the
    /// runtime has made its own record of it durable.
    fn prepare_wave(
        &mut self,
        request_id: [u8; 8],
        request: xln_rscore_batch::WaveRequest,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending_wave.is_some() {
            return Err(ProcessError::PreparePending);
        }
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let started = std::time::Instant::now();
        let result = engine.prepare_wave(request)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        let response = wire_encode::wave(&result, engine_micros)?;
        self.pending_wave = Some(PendingWave {
            prepare_request_id: request_id,
            revision: result.revision,
        });
        Ok((response, false))
    }

    fn commit_wave(
        &mut self,
        prepare_request_id: [u8; 8],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let pending = self.take_pending_wave(prepare_request_id)?;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        match engine.commit_wave(pending.revision) {
            Ok(accounts_root) => Ok((
                wire_encode::wave_committed(engine.revision(), accounts_root),
                false,
            )),
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
        prepare_request_id: [u8; 8],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        let pending = self.take_pending_wave(prepare_request_id)?;
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        let revision = engine.abort_wave(pending.revision)?;
        Ok((
            wire_encode::wave_aborted(revision, engine.accounts_root()),
            false,
        ))
    }

    fn take_pending_wave(&mut self, actual: [u8; 8]) -> Result<PendingWave, ProcessError> {
        let pending = self
            .pending_wave
            .as_ref()
            .ok_or(ProcessError::PrepareNotPending)?;
        if pending.prepare_request_id != actual {
            return Err(ProcessError::PrepareIdMismatch);
        }
        self.pending_wave
            .take()
            .ok_or(ProcessError::PrepareNotPending)
    }

    fn load(
        &mut self,
        revision: u64,
        accounts: Vec<xln_rscore_batch::AccountSeed>,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.engine.is_some() || self.authority.is_some() {
            return Err(ProcessError::EngineAlreadyLoaded);
        }
        let binding = self.binding.as_ref().ok_or(ProcessError::HelloRequired)?;
        if let Some(config) = self.authority_config.as_ref() {
            let engine = StatefulConsensusEngine::restore(
                EngineGeneration::from_bytes(binding.engine_generation),
                self.worker_count,
                revision,
                config.seed.clone(),
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

    fn upsert_accounts(
        &mut self,
        accounts: Vec<xln_rscore_batch::AccountSeed>,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.pending.is_some() || self.pending_wave.is_some() {
            return Err(ProcessError::PreparePending);
        }
        if let Some(engine) = self.authority.as_mut() {
            let accounts_root = engine.upsert_accounts(accounts)?;
            return Ok((
                wire_encode::upserted(engine.revision(), accounts_root),
                false,
            ));
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
        let engine = self.engine.as_ref().ok_or(ProcessError::EngineNotLoaded)?;
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
        let started = std::time::Instant::now();
        let candidate = engine.prepare(&jobs)?;
        let engine_micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        let response = wire_encode::prepared(&candidate, engine_micros)?;
        self.pending = Some(PendingBatch {
            prepare_request_id: request_id,
            candidate,
        });
        Ok((response, false))
    }

    fn commit(
        &mut self,
        prepare_request_id: [u8; 8],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        self.validate_pending_id(prepare_request_id)?;
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
        prepare_request_id: [u8; 8],
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        self.validate_pending_id(prepare_request_id)?;
        self.pending = None;
        let revision = self
            .engine
            .as_ref()
            .ok_or(ProcessError::EngineNotLoaded)?
            .revision();
        Ok((wire_encode::aborted(revision), false))
    }

    fn validate_pending_id(&self, actual: [u8; 8]) -> Result<(), ProcessError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(ProcessError::PrepareNotPending)?;
        if pending.prepare_request_id != actual {
            return Err(ProcessError::PrepareIdMismatch);
        }
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
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
    let identity = xln_rscore_engine::SigningIdentity::lazy_from_seed(
        &config.seed,
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
