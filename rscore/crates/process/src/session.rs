use xln_rscore_abi::{EngineIdentity, Envelope, MessageKind, ProtocolBinding};
use xln_rscore_batch::{EngineGeneration, ResidentConsensusEngine};

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
    /// The sole production Account engine. The retired mirror engine was a
    /// cutover oracle and is deliberately not retained beside authority.
    authority: Option<Box<ResidentConsensusEngine>>,
    entity_state: Option<ResidentEntityHead>,
    authority_config: Option<AuthorityConfig>,
    stopped: bool,
}

struct SessionBinding {
    protocol: ProtocolBinding,
    engine_generation: [u8; 8],
    runtime_id: [u8; 20],
    session_id: [u8; 16],
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
        Self::try_new().expect("rscore process session construction is infallible")
    }

    pub fn try_new() -> Result<Self, ProcessError> {
        Ok(Self {
            binding: None,
            worker_count: 0,
            swap_market: std::sync::Arc::default(),
            last_request_id: None,
            authority: None,
            entity_state: None,
            authority_config: None,
            stopped: false,
        })
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
        self.dispatch(command)
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
        // an authority-less role even though request 0 asked for authority.
        let binding = SessionBinding::from_request(request);
        let digest = swap_market.digest();
        let swap_market = std::sync::Arc::new(swap_market);
        let authority = authority.ok_or(ProcessError::AuthorityRequired)?;
        let identity = authority_identity(&authority)?;
        let response = wire_encode::hello(worker_count, digest, Some(identity));

        self.binding = Some(binding);
        self.worker_count = worker_count;
        self.last_request_id = Some(0);
        self.swap_market = swap_market;
        self.authority_config = Some(authority);
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
            Command::Shutdown => self.shutdown(),
        }
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
        mut snapshot: xln_rscore_entity_kernel::EntityStateSnapshot,
    ) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
        if self.entity_state.is_some() {
            return Err(ProcessError::EntityAlreadyLoaded);
        }
        let engine = self
            .authority
            .as_mut()
            .ok_or(ProcessError::EngineNotLoaded)?;
        snapshot.hydrate_orderbook_accounts(engine.orderbook_account_snapshots()?)?;
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
        if self.authority.is_some() {
            return Err(ProcessError::EngineAlreadyLoaded);
        }
        let binding = self.binding.as_ref().ok_or(ProcessError::HelloRequired)?;
        let config = self
            .authority_config
            .as_ref()
            .ok_or(ProcessError::AuthorityRequired)?;
        // Bootstrap creates only a brand-new empty authority. Any account or
        // nonzero revision is durable history and must use RestoreExact.
        if revision != 0 || (!accounts.is_empty() && !import_existing) {
            return Err(ProcessError::AuthorityBootstrapInvalid {
                revision,
                accounts: accounts.len(),
            });
        }
        let mut engine = if import_existing {
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
        // A fresh empty authority is already a complete canonical Account
        // checkpoint. Return it with bootstrap so an idle Runtime can durably
        // record the zero-Account base without inventing it in TypeScript or
        // forcing a fake Entity round solely to trigger checkpoint export.
        let checkpoint = if import_existing {
            None
        } else {
            Some(engine.export_checkpoint()?)
        };
        self.authority = Some(Box::new(engine));
        Ok((
            wire_encode::loaded(revision, accounts_root, checkpoint.as_ref())?,
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
        if self.authority.is_some() {
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

    fn shutdown(&mut self) -> Result<(xln_rscore_abi::BodyTuple, bool), ProcessError> {
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
