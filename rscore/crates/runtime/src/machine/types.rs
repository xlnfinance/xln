use std::collections::VecDeque;

use serde_json::Value;
use thiserror::Error;
use xln_rscore_batch::{AccountId, AccountInputRow, AccountsCheckpoint, ResidentConsensusEngine};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, DeterministicContext, EntityFrame, EntityKernelError, EntityKernelOutput,
    EntitySingleSigner, EntityStateSlice, EntityTransitionError, LocalEntityFinancialTx,
    LocalEntityOutput, ResidentEntityConsensusReplica, ResidentEntityError, ScheduledWake,
    SchedulerError, SignedEntityCommandV1, decode_local_entity_financial_tx,
    decode_signed_entity_command,
};
use xln_rscore_protocol::CanonicalValue;

/// Runtime work that is accepted by this deliberately narrow RRS milestone.
///
/// HLT payment/same-j swap traffic enters through `EntityInput`; excluded
/// Runtime administration, cross-j and Jurisdiction execution are rejected by
/// name before any owned state is touched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeTx {
    AdvanceJWatcherCursor {
        depository_address: String,
        chain_id: u64,
        block_number: u64,
    },
    Unsupported {
        kind: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum EntityExecutionStep {
    LocalBatch {
        projected: Vec<CanonicalEntityTx>,
        native: Vec<LocalEntityFinancialTx>,
    },
    Command {
        projected: CanonicalEntityTx,
        command: Box<SignedEntityCommandV1>,
    },
}

/// One canonical Entity FIFO item.
///
/// `canonical` is the exact validated tagged-storage value. It preserves the
/// Map/Set/Uint8Array/undefined domain that a neutral CanonicalValue cannot.
/// Runtime moves it into the durable frame and encodes the complete
/// RuntimeInput once; Account rows are moved independently into Rust execution.
#[derive(Clone, Debug)]
pub struct RuntimeEntityInput {
    entity_id: [u8; 32],
    signer_id: String,
    canonical: Value,
    /// Exact already-validated Entity-frame projection. In particular an
    /// AccountInput contains `canonicalAccountInputCommitment`, never the raw
    /// nested Account frame body. Admission computes this once.
    canonical_entity_txs: Vec<CanonicalEntityTx>,
    account_inputs: Vec<AccountInputRow>,
    execution_steps: Vec<EntityExecutionStep>,
    /// Exact width measured once by the strict tagged-storage admission codec.
    canonical_wire_bytes: usize,
}

impl RuntimeEntityInput {
    /// Decode once at Runtime admission. The exact logical value, Entity-frame
    /// projection and typed Account rows are born together and cannot be
    /// supplied independently by a caller.
    pub fn decode(canonical: Value) -> Result<Self, RuntimeMachineError> {
        let object = canonical
            .as_object()
            .ok_or(RuntimeMachineError::EntityInputObjectRequired)?;
        for field in object.keys() {
            if !matches!(
                field.as_str(),
                "entityId" | "signerId" | "entityTxs" | "from" | "runtimeId" | "sourceRuntimeFrame"
            ) {
                return Err(RuntimeMachineError::EntityInputFieldUnsupported(
                    field.clone(),
                ));
            }
        }
        validate_entity_input_transport(object)?;
        let entity_id_text = object
            .get("entityId")
            .and_then(Value::as_str)
            .ok_or(RuntimeMachineError::EntityInputEntityIdMissing)?;
        let entity_id = parse_hex32(entity_id_text).ok_or_else(|| {
            RuntimeMachineError::EntityInputEntityIdInvalid(entity_id_text.into())
        })?;
        if render_hex(&entity_id) != entity_id_text {
            return Err(RuntimeMachineError::EntityInputEntityIdInvalid(
                entity_id_text.into(),
            ));
        }
        let signer_id_text = object
            .get("signerId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(RuntimeMachineError::SignerIdEmpty)?;
        let signer_id = signer_id_text.trim().to_lowercase();
        if signer_id != signer_id_text {
            return Err(RuntimeMachineError::EntityInputSignerIdInvalid(
                signer_id_text.into(),
            ));
        }
        let txs: &[Value] = match object.get("entityTxs") {
            Some(value) => value
                .as_array()
                .map(Vec::as_slice)
                .ok_or(RuntimeMachineError::EntityInputTxsArrayRequired)?,
            None => &[],
        };
        let mut canonical_entity_txs = Vec::with_capacity(txs.len());
        let mut account_inputs = Vec::new();
        let mut execution_steps = Vec::new();
        let mut local_projected = Vec::new();
        let mut local_native = Vec::new();
        let mut local_phase_started = false;
        for (index, tx) in txs.iter().enumerate() {
            let projection = crate::entity_frame::project_entity_tx(tx)?;
            if projection.kind == xln_rscore_entity_kernel::EntityTxKind::AccountInput {
                if local_phase_started {
                    return Err(RuntimeMachineError::EntityTxInterleavingUnsupported);
                }
                let operation_index =
                    u64::try_from(index).map_err(|_| RuntimeMachineError::InputCountOverflow)?;
                account_inputs.push(crate::decode_entity_account_input_row(
                    entity_id_text,
                    operation_index,
                    tx,
                )?);
                canonical_entity_txs.push(projection);
            } else {
                local_phase_started = true;
                if projection.kind == xln_rscore_entity_kernel::EntityTxKind::EntityCommand {
                    if !local_projected.is_empty() {
                        execution_steps.push(EntityExecutionStep::LocalBatch {
                            projected: std::mem::take(&mut local_projected),
                            native: std::mem::take(&mut local_native),
                        });
                    }
                    execution_steps.push(EntityExecutionStep::Command {
                        command: Box::new(
                            decode_signed_entity_command(&projection.data)
                                .map_err(RuntimeMachineError::EntityCommand)?,
                        ),
                        projected: projection,
                    });
                } else {
                    let Some(local) = decode_local_entity_financial_tx(&projection)
                        .map_err(RuntimeMachineError::EntityFinancial)?
                    else {
                        return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                            projection.kind.as_str(),
                        ));
                    };
                    local_projected.push(projection);
                    local_native.push(local);
                }
            }
        }
        if !local_projected.is_empty() {
            execution_steps.push(EntityExecutionStep::LocalBatch {
                projected: local_projected,
                native: local_native,
            });
        }
        let canonical_wire_bytes = crate::transport::msgpack::encode_transport(&canonical)
            .map_err(|error| RuntimeMachineError::EntityInputEncoding(error.to_string()))?
            .len();
        if canonical_wire_bytes == 0 {
            return Err(RuntimeMachineError::EmptyCanonicalWire);
        }
        Ok(Self {
            entity_id,
            signer_id,
            canonical,
            canonical_entity_txs,
            account_inputs,
            execution_steps,
            canonical_wire_bytes,
        })
    }

    pub fn entity_id(&self) -> &[u8; 32] {
        &self.entity_id
    }

    pub fn signer_id(&self) -> &str {
        &self.signer_id
    }

    pub fn canonical_wire_bytes(&self) -> usize {
        self.canonical_wire_bytes
    }

    pub fn canonical(&self) -> &Value {
        &self.canonical
    }

    pub fn account_input_count(&self) -> usize {
        self.account_inputs.len()
    }

    /// Exact already-validated Entity-frame tx projections, in wire order.
    /// Used by the entity-height durability barrier to detect a
    /// `scheduledWake` tx.
    pub(super) fn canonical_entity_txs(&self) -> &[CanonicalEntityTx] {
        &self.canonical_entity_txs
    }

    pub(super) fn into_parts(
        self,
    ) -> (
        Value,
        Vec<CanonicalEntityTx>,
        Vec<AccountInputRow>,
        Vec<EntityExecutionStep>,
    ) {
        (
            self.canonical,
            self.canonical_entity_txs,
            self.account_inputs,
            self.execution_steps,
        )
    }

    /// Entity-frame projections without the full decode path, for barrier
    /// selection tests that only need lane identity and tx kinds.
    #[cfg(test)]
    pub(super) fn fixture_with_entity_txs(
        canonical: Value,
        canonical_entity_txs: Vec<CanonicalEntityTx>,
    ) -> Self {
        Self {
            entity_id: super::tests::owner_bytes(),
            signer_id: super::tests::SIGNER.to_string(),
            canonical,
            canonical_entity_txs,
            account_inputs: Vec::new(),
            execution_steps: Vec::new(),
            canonical_wire_bytes: 1,
        }
    }

    #[cfg(test)]
    pub(super) fn fixture(canonical: Value, canonical_wire_bytes: usize) -> Self {
        Self {
            entity_id: super::tests::owner_bytes(),
            signer_id: super::tests::SIGNER.to_string(),
            canonical,
            canonical_entity_txs: Vec::new(),
            account_inputs: Vec::new(),
            execution_steps: Vec::new(),
            canonical_wire_bytes,
        }
    }

    #[cfg(test)]
    pub(crate) fn fixture_with_account_input(
        canonical: Value,
        account_input: AccountInputRow,
    ) -> Self {
        Self {
            entity_id: super::tests::owner_bytes(),
            signer_id: super::tests::SIGNER.to_string(),
            canonical,
            canonical_entity_txs: Vec::new(),
            account_inputs: vec![account_input],
            execution_steps: Vec::new(),
            canonical_wire_bytes: 1,
        }
    }
}

fn validate_entity_input_transport(
    object: &serde_json::Map<String, Value>,
) -> Result<(), RuntimeMachineError> {
    let routed = ["from", "runtimeId", "sourceRuntimeFrame"]
        .iter()
        .filter(|field| object.contains_key(**field))
        .count();
    if routed == 0 {
        return Ok(());
    }
    if routed != 3 {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "ROUTE_FIELDS_INCOMPLETE".into(),
        ));
    }
    for field in ["from", "runtimeId"] {
        let value = object.get(field).and_then(Value::as_str).ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid(format!("{field}:TEXT"))
        })?;
        let payload = value.strip_prefix("0x").filter(|value| value.len() == 40);
        if value != value.to_ascii_lowercase()
            || payload.is_none_or(|value| !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err(RuntimeMachineError::EntityInputTransportInvalid(format!(
                "{field}:RUNTIME_ID"
            )));
        }
    }
    let frame = object
        .get("sourceRuntimeFrame")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid("SOURCE_FRAME_OBJECT".into())
        })?;
    if frame.len() != 2 || !frame.contains_key("height") || !frame.contains_key("timestamp") {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "SOURCE_FRAME_FIELDS".into(),
        ));
    }
    for field in ["height", "timestamp"] {
        if frame
            .get(field)
            .and_then(Value::as_u64)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .is_none()
        {
            return Err(RuntimeMachineError::EntityInputTransportInvalid(format!(
                "SOURCE_FRAME_{field}"
            )));
        }
    }
    Ok(())
}

/// Deterministic facts bound to the FIFO work selected for one Runtime frame.
/// A deferred envelope retains this value; later ingress cannot accidentally
/// execute it under a newer timestamp, J height or prepared Entity context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFrameContext {
    pub timestamp: u64,
    pub finalized_j_height: u64,
    pub hub_rebalance_has_pending_work: bool,
    pub entity_context: DeterministicContext,
    /// Exact canonical EntityInfraContext committed by the Entity frame.
    /// It is decoded beside `entity_context`; the reducer never reconstructs
    /// signed bytes from the execution-only projection.
    pub canonical_entity_context: CanonicalValue,
}

/// New ingress plus the frame context assigned to that ingress.
#[derive(Clone, Debug)]
pub struct RuntimeInput {
    pub runtime_txs: Vec<RuntimeTx>,
    pub entity_inputs: Vec<RuntimeEntityInput>,
    pub frame: RuntimeFrameContext,
}

/// Uncommitted live ingress. Unlike `RuntimeInput`, it cannot carry an Entity
/// context because the exact FIFO/EntityTx prefix is not known until after
/// selection. `apply_runtime_live` materializes that context exactly once at
/// the canonical post-selection boundary.
#[derive(Clone, Debug)]
pub struct RuntimeLiveInput {
    pub runtime_txs: Vec<RuntimeTx>,
    pub entity_inputs: Vec<RuntimeEntityInput>,
    pub timestamp: u64,
    pub finalized_j_height: u64,
    pub hub_rebalance_has_pending_work: bool,
}

impl RuntimeLiveInput {
    pub(crate) fn into_selection_input(self) -> RuntimeInput {
        RuntimeInput {
            runtime_txs: self.runtime_txs,
            entity_inputs: self.entity_inputs,
            // This value exists only so the FIFO selector owns one clock
            // shape. It is overwritten before Account/Entity execution.
            frame: RuntimeFrameContext {
                timestamp: self.timestamp,
                finalized_j_height: self.finalized_j_height,
                hub_rebalance_has_pending_work: self.hub_rebalance_has_pending_work,
                entity_context: DeterministicContext::hlt_default(),
                canonical_entity_context: CanonicalValue::Object(Vec::new()),
            },
        }
    }
}

impl RuntimeInput {
    pub fn empty_frame(
        timestamp: u64,
        finalized_j_height: u64,
        entity_context: DeterministicContext,
        canonical_entity_context: CanonicalValue,
    ) -> Self {
        Self {
            runtime_txs: Vec::new(),
            entity_inputs: Vec::new(),
            frame: RuntimeFrameContext {
                timestamp,
                finalized_j_height,
                hub_rebalance_has_pending_work: false,
                entity_context,
                canonical_entity_context,
            },
        }
    }
}

/// Replica-only queue state. None of these fields is part of RuntimeState.
pub struct RuntimeMempool {
    pub(crate) runtime_txs: VecDeque<RuntimeTx>,
    pub(crate) entity_inputs: VecDeque<RuntimeEntityInput>,
    pub(crate) queued_at: Option<u64>,
}

impl RuntimeMempool {
    pub fn empty() -> Self {
        Self {
            runtime_txs: VecDeque::new(),
            entity_inputs: VecDeque::new(),
            queued_at: None,
        }
    }

    pub fn runtime_tx_count(&self) -> usize {
        self.runtime_txs.len()
    }

    pub fn entity_input_count(&self) -> usize {
        self.entity_inputs.len()
    }

    pub fn queued_at(&self) -> Option<u64> {
        self.queued_at
    }

    pub fn is_empty(&self) -> bool {
        self.runtime_txs.is_empty() && self.entity_inputs.is_empty()
    }

    /// Borrow the exact pending RuntimeTx lane in FIFO order.
    pub fn pending_runtime_txs(&self) -> impl ExactSizeIterator<Item = &RuntimeTx> {
        self.runtime_txs.iter()
    }

    /// Borrow the exact pending EntityInput lane in FIFO order. Durable
    /// encoding consumes the logical Values once; it never rebuilds them from
    /// typed Account rows or Entity-frame projections.
    pub fn pending_entity_inputs(&self) -> impl ExactSizeIterator<Item = &Value> {
        self.entity_inputs.iter().map(RuntimeEntityInput::canonical)
    }
}

impl Default for RuntimeMempool {
    fn default() -> Self {
        Self::empty()
    }
}

/// Bounds are replica configuration, not committed consensus State. A zero
/// frame cap means unlimited, matching the TypeScript Runtime configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeLimits {
    pub max_mempool_runtime_txs: usize,
    pub max_mempool_entity_inputs: usize,
    pub max_mempool_total_items: usize,
    pub max_entity_inputs_per_frame: usize,
    pub max_account_inputs_per_frame: usize,
    pub max_entity_wire_bytes_per_frame: usize,
    pub checkpoint_period_frames: u64,
    pub canonical_hash_period_frames: u64,
}

/// Match the canonical TypeScript storage cadence: the interval is measured
/// from the last materialized Runtime frame, not from genesis. A restored
/// checkpoint at height 5 therefore materializes next at 105, never at 100.
pub(crate) fn materialization_due(
    next_height: u64,
    last_materialized_height: u64,
    period: u64,
) -> bool {
    next_height == 1
        || (period > 0
            && next_height
                .checked_sub(last_materialized_height)
                .is_some_and(|elapsed| elapsed >= period))
}

impl RuntimeLimits {
    pub const fn hlt() -> Self {
        Self {
            max_mempool_runtime_txs: 10_000,
            max_mempool_entity_inputs: 10_000,
            max_mempool_total_items: 30_000,
            max_entity_inputs_per_frame: 0,
            max_account_inputs_per_frame: 0,
            max_entity_wire_bytes_per_frame: 10_000_000,
            checkpoint_period_frames: 100,
            canonical_hash_period_frames: 0,
        }
    }
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self::hlt()
    }
}

/// Deterministic data fixed by one committed Runtime frame.
pub struct RuntimeState {
    pub height: u64,
    pub timestamp: u64,
    pub finalized_j_height: u64,
    pub accounts_root: [u8; 32],
    pub entity: EntityStateSlice,
}

/// One live single-Entity Runtime. The Account forest is replica machinery;
/// its root is the only Account authority committed by RuntimeState.
pub struct RuntimeReplica {
    pub state: RuntimeState,
    pub durable: crate::processor::RuntimeDurableEnvelope,
    pub entity_id: [u8; 32],
    pub signer_id: String,
    pub accounts: ResidentConsensusEngine,
    pub entity_consensus: ResidentEntityConsensusReplica,
    pub entity_signer: EntitySingleSigner,
    /// Static Account ABI/protocol binding. Unlike checkpoint projection
    /// descriptors, this is process configuration and is required even at an
    /// empty genesis before the first path-keyed checkpoint exists.
    pub(crate) protocol_fingerprint: [u8; 32],
    /// Exact canonical EntityReplica envelope. It is part of Runtime live
    /// state, not a parallel consensus state or an implementation sidecar.
    pub(crate) replica_metadata: Value,
    pub(crate) certified_board_registry: crate::CertifiedBoardRegistry,
    /// Durable storage cadence anchor. This is replica envelope state, not a
    /// second consensus root; recovery initializes it from the exact
    /// materialized Runtime checkpoint and WAL replay advances it only when a
    /// checkpoint-bearing frame is reproduced.
    pub(crate) last_materialized_height: u64,
    pub mempool: RuntimeMempool,
    pub scheduled_wakes: super::ScheduledWakeIndex,
    pub limits: RuntimeLimits,
}

impl RuntimeReplica {
    /// Exact live Entity-replica envelope committed by `replicaMetaDigest`.
    /// Read-only exposure keeps replay diagnostics on the canonical value;
    /// callers cannot maintain a second metadata model.
    pub fn replica_metadata(&self) -> &Value {
        &self.replica_metadata
    }

    #[allow(clippy::too_many_arguments)] // Explicit trust-boundary parts beat an opaque options bag.
    pub fn new(
        state: RuntimeState,
        durable: crate::processor::RuntimeDurableEnvelope,
        entity_id: [u8; 32],
        signer_id: String,
        accounts: ResidentConsensusEngine,
        entity_consensus: ResidentEntityConsensusReplica,
        entity_signer: EntitySingleSigner,
        protocol_fingerprint: [u8; 32],
        limits: RuntimeLimits,
    ) -> Result<Self, RuntimeMachineError> {
        if signer_id.is_empty() {
            return Err(RuntimeMachineError::SignerIdEmpty);
        }
        let actual_root = accounts.accounts_root();
        if state.accounts_root != actual_root {
            return Err(RuntimeMachineError::AccountsRootMismatch {
                committed: state.accounts_root,
                resident: actual_root,
            });
        }
        let entity_id_text = render_hex(&entity_id);
        if state.entity.entity_id != entity_id_text {
            return Err(RuntimeMachineError::EntityStateOwnerMismatch {
                runtime: entity_id_text,
                entity: state.entity.entity_id.clone(),
            });
        }
        if entity_signer.signer_id() != signer_id.trim().to_lowercase() {
            return Err(RuntimeMachineError::EntityConsensusSignerMismatch {
                runtime: signer_id,
                consensus: entity_signer.signer_id().to_string(),
            });
        }
        if entity_signer.entity_id_text() != state.entity.entity_id {
            return Err(RuntimeMachineError::EntityConsensusOwnerMismatch);
        }
        let (account_signer_id, account_signer_address) = accounts.local_signer_binding()?;
        if account_signer_id != entity_signer.signer_id()
            || entity_signer.signer_address() != Some(account_signer_address)
        {
            return Err(RuntimeMachineError::AccountEntitySignerMismatch);
        }
        entity_consensus.validate_restored(&state.entity.entity_id, state.entity.height)?;
        let scheduled_wakes = super::ScheduledWakeIndex::from_entity_state(&state.entity)?;
        let replica_metadata = serde_json::json!({
            "entityId": state.entity.entity_id,
            "signerId": entity_signer.signer_id(),
            "isProposer": true,
        });
        let last_materialized_height = state.height;
        Ok(Self {
            state,
            durable,
            entity_id,
            signer_id: entity_signer.signer_id().to_string(),
            accounts,
            entity_consensus,
            entity_signer,
            protocol_fingerprint,
            replica_metadata,
            certified_board_registry: crate::CertifiedBoardRegistry::empty(),
            last_materialized_height,
            mempool: RuntimeMempool::empty(),
            scheduled_wakes,
            limits,
        })
    }

    pub(crate) fn install_certified_board_registry(
        &mut self,
        registry: crate::CertifiedBoardRegistry,
    ) {
        self.certified_board_registry = registry;
    }

    pub(crate) fn install_replica_metadata(
        &mut self,
        value: Value,
    ) -> Result<(), RuntimeMachineError> {
        let meta = value
            .as_object()
            .ok_or_else(|| RuntimeMachineError::ReplicaMetadata("OBJECT_REQUIRED".into()))?;
        let identity_matches = meta.get("entityId").and_then(Value::as_str)
            == Some(self.state.entity.entity_id.as_str())
            && meta.get("signerId").and_then(Value::as_str) == Some(self.signer_id.as_str());
        if !identity_matches || meta.get("isProposer").and_then(Value::as_bool).is_none() {
            return Err(RuntimeMachineError::ReplicaMetadata(
                "IDENTITY_OR_ENVELOPE_MISMATCH".into(),
            ));
        }
        self.replica_metadata = value;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedRuntimeInput {
    pub entity_inputs: usize,
    pub account_inputs: usize,
    pub canonical_wire_bytes: usize,
    pub wake: Option<RuntimeWake>,
}

/// Exact logical body selected for one durable Runtime frame. The deterministic
/// execution context is separate because it is not part of TS RuntimeInput.
/// Values are moved from the FIFO; no Account row or EntityInput is cloned.
pub struct AppliedRuntimeFrame {
    pub runtime_txs: Vec<RuntimeTx>,
    pub entity_inputs: Vec<Value>,
    pub frame: RuntimeFrameContext,
    /// Runtime-only frames (for example a watcher cursor advance) retain the
    /// previous certified Entity head and carry no Entity context or events.
    pub entity_frame_committed: bool,
}

/// Runtime-generated Entity work. This is an internal EntityInput reason, not
/// an external effect and never a RuntimeTx.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeWake {
    pub account_mempool: bool,
    pub scheduled: Option<ScheduledWake>,
}

/// Outputs remain internal until the Runtime WAL writer fsyncs the frame.
pub struct RuntimeOutputs {
    pub entity_events: Vec<EntityKernelOutput>,
    /// Exact Entity-local outputs. Runtime routing may add transport metadata,
    /// but must not reconstruct Account or consensus-authorized payloads.
    pub local_entity_outputs: Vec<LocalEntityOutput>,
    pub entity_state_root: Option<String>,
    pub entity_authority_root: Option<String>,
    pub checkpoint: Option<AccountsCheckpoint>,
    /// Exact logical rows dirtied by this certified frame. Storage uses these
    /// only for history/materialization indexes; no root is reconstructed from
    /// them. Account ids preserve canonical first-touch order and are
    /// de-duplicated at the reducer boundary.
    pub touches: RuntimeFrameTouches,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeFrameTouches {
    pub entity_ids: Vec<String>,
    pub account_ids: Vec<String>,
    pub book_entity_ids: Vec<String>,
}

/// Provenance of one Account frame committed while applying a Runtime frame.
///
/// This is ordered replay evidence only. It is not committed into Runtime
/// state and is never persisted as a second history source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountCommitSource {
    AckCommit,
    PeerCommit,
}

/// Exact compact evidence for one Account frame that became committed.
///
/// A combined `frame_ack` contributes two rows in canonical TS order: the ACK
/// commit first, then the accepted peer frame. Retaining both rows is required
/// because the final Account leaf alone cannot prove that intermediate order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountCommitEvidence {
    pub account_id: AccountId,
    pub source: AccountCommitSource,
    pub frame_height: u64,
    pub state_hash: [u8; 32],
    pub account_state_root: [u8; 32],
}

pub struct RuntimeApplyResult {
    pub replica: RuntimeReplica,
    pub applied_input: Option<AppliedRuntimeInput>,
    pub applied_frame: Option<AppliedRuntimeFrame>,
    pub outputs: RuntimeOutputs,
    /// Ordered Account commits observed inside this exact transition.
    /// Outbound proposals are intentionally absent: they remain pending until
    /// a later peer ACK commits them.
    pub account_commits: Vec<AccountCommitEvidence>,
}

impl RuntimeApplyResult {
    /// Borrow the exact certified frame now owned by the returned replica.
    /// Durable processing encodes this reference once; no frame-sized clone or
    /// alternate publication schema is needed.
    pub fn certified_entity_frame(&self) -> Option<&EntityFrame> {
        self.replica
            .entity_consensus
            .certified_frame_head
            .as_ref()
            .map(|head| &head.frame)
    }
}

fn render_hex(bytes: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

#[derive(Debug, Error)]
pub enum RuntimeMachineError {
    #[error("RUNTIME_SIGNER_ID_EMPTY")]
    SignerIdEmpty,
    #[error("RUNTIME_TIMESTAMP_REGRESSION:previous={previous}:next={next}")]
    TimestampRegression { previous: u64, next: u64 },
    #[error("RUNTIME_J_HEIGHT_REGRESSION:previous={previous}:next={next}")]
    FinalizedJHeightRegression { previous: u64, next: u64 },
    #[error("RUNTIME_HEIGHT_OVERFLOW")]
    HeightOverflow,
    #[error("RUNTIME_ENTITY_HEIGHT_OVERFLOW")]
    EntityHeightOverflow,
    #[error("RUNTIME_MEMPOOL_CAPACITY_EXCEEDED:{lane}:{actual}:{limit}")]
    MempoolCapacity {
        lane: &'static str,
        actual: usize,
        limit: usize,
    },
    #[error("RUNTIME_ENTITY_OWNER_MISMATCH")]
    EntityOwnerMismatch,
    #[error("RUNTIME_ENTITY_SIGNER_MISMATCH")]
    EntitySignerMismatch,
    #[error("RUNTIME_ENTITY_STATE_OWNER_MISMATCH:runtime={runtime}:entity={entity}")]
    EntityStateOwnerMismatch { runtime: String, entity: String },
    #[error("RUNTIME_ENTITY_CONSENSUS_OWNER_MISMATCH")]
    EntityConsensusOwnerMismatch,
    #[error("RUNTIME_ENTITY_CONSENSUS_SIGNER_MISMATCH:runtime={runtime}:consensus={consensus}")]
    EntityConsensusSignerMismatch { runtime: String, consensus: String },
    #[error("RUNTIME_ACCOUNT_ENTITY_SIGNER_MISMATCH")]
    AccountEntitySignerMismatch,
    #[error("RUNTIME_REPLICA_METADATA:{0}")]
    ReplicaMetadata(String),
    #[error("RUNTIME_ENTITY_INPUT_EMPTY_WIRE")]
    EmptyCanonicalWire,
    #[error("RUNTIME_ENTITY_INPUT_OBJECT_REQUIRED")]
    EntityInputObjectRequired,
    #[error("RUNTIME_ENTITY_INPUT_FIELD_UNSUPPORTED:{0}")]
    EntityInputFieldUnsupported(String),
    #[error("RUNTIME_ENTITY_INPUT_TRANSPORT_INVALID:{0}")]
    EntityInputTransportInvalid(String),
    #[error("RUNTIME_ENTITY_INPUT_ENTITY_ID_MISSING")]
    EntityInputEntityIdMissing,
    #[error("RUNTIME_ENTITY_INPUT_ENTITY_ID_INVALID:{0}")]
    EntityInputEntityIdInvalid(String),
    #[error("RUNTIME_ENTITY_INPUT_SIGNER_ID_INVALID:{0}")]
    EntityInputSignerIdInvalid(String),
    #[error("RUNTIME_ENTITY_INPUT_TXS_ARRAY_REQUIRED")]
    EntityInputTxsArrayRequired,
    #[error("RUNTIME_ENTITY_TX_EXECUTION_UNSUPPORTED:{0}")]
    EntityTxExecutionUnsupported(&'static str),
    #[error("RUNTIME_ENTITY_FINANCIAL:{0}")]
    EntityFinancial(#[source] EntityKernelError),
    #[error(transparent)]
    EntityCommand(#[from] xln_rscore_entity_kernel::EntityCommandError),
    #[error("{0}")]
    EntityCommandContext(String),
    #[error("RUNTIME_ENTITY_TX_INTERLEAVING_UNSUPPORTED")]
    EntityTxInterleavingUnsupported,
    #[error("RUNTIME_ENTITY_CONTEXT_MATERIALIZATION:{0}")]
    EntityContextMaterialization(String),
    #[error("RUNTIME_INBOUND_GENESIS_POLICY:{0}")]
    InboundGenesisPolicy(String),
    #[error("RUNTIME_ENTITY_INPUT_ENCODING:{0}")]
    EntityInputEncoding(String),
    #[error("RUNTIME_ENTITY_HEAD_WIRE_UNFITTABLE:actual={actual}:limit={limit}")]
    HeadWireUnfittable { actual: usize, limit: usize },
    #[error("RUNTIME_ENTITY_HEAD_TX_UNFITTABLE:actual={actual}:limit={limit}")]
    HeadAccountInputsUnfittable { actual: usize, limit: usize },
    #[error("RUNTIME_INPUT_COUNT_OVERFLOW")]
    InputCountOverflow,
    #[error("RUNTIME_WIRE_BYTES_OVERFLOW")]
    WireBytesOverflow,
    #[error("RUNTIME_SYNTHETIC_ENTITY_INPUT_ENCODING:{0}")]
    SyntheticEntityInputEncoding(String),
    #[error("RUNTIME_TX_UNSUPPORTED:{kind}")]
    UnsupportedRuntimeTx { kind: String },
    #[error(transparent)]
    DurableEnvelope(#[from] crate::RuntimeDurableEnvelopeError),
    #[error("RUNTIME_ACCOUNTS_ROOT_MISMATCH:committed={committed:?}:resident={resident:?}")]
    AccountsRootMismatch {
        committed: [u8; 32],
        resident: [u8; 32],
    },
    #[error(transparent)]
    Entity(#[from] ResidentEntityError),
    #[error(transparent)]
    EntityConsensus(#[from] EntityTransitionError),
    #[error("RUNTIME_SCHEDULED_WAKE_DUPLICATE:{id}")]
    ScheduledWakeDuplicate { id: String },
    #[error(transparent)]
    Scheduler(#[from] SchedulerError),
    #[error(transparent)]
    EntityFrame(#[from] crate::EntityFrameError),
    #[error(transparent)]
    AccountInputJson(#[from] crate::AccountInputJsonError),
    #[error(transparent)]
    Account(#[from] xln_rscore_batch::BatchError),
}

fn parse_hex32(value: &str) -> Option<[u8; 32]> {
    let body = value.strip_prefix("0x")?;
    if body.len() != 64 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(output)
}
