use std::collections::{BTreeMap, VecDeque};

use serde_json::Value;
use thiserror::Error;
use xln_rscore_batch::{AccountId, AccountInputRow, AccountsCheckpoint, ResidentConsensusEngine};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, DeterministicContext, EntityFrame, EntityKernelError, EntityKernelOutput,
    EntitySingleSigner, EntityStateSlice, EntityTransitionError, EntityTxKind, LocalEntityOutput,
    LocalEntityTx, ResidentEntityConsensusReplica, ResidentEntityError, ScheduledWake,
    SchedulerError, SignedEntityCommandV1, decode_local_entity_tx, decode_signed_entity_command,
};
use xln_rscore_protocol::CanonicalValue;

/// Runtime work that is accepted by this deliberately narrow RRS milestone.
///
/// HLT payment/same-j swap traffic enters through `EntityInput`; excluded
/// Runtime administration, cross-j and Jurisdiction execution are rejected by
/// name before any owned state is touched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeTx {
    CheckpointBarrier,
    RecordRuntimeAdapterCommand(RuntimeAdapterCommandMarker),
    ImportJ(crate::JurisdictionImportRequest),
    CompleteImportJ(crate::JurisdictionImportResult),
    ObserveJRange(crate::j_watcher::ObserveJRange),
    AdvanceJWatcherCursor {
        depository_address: String,
        chain_id: u64,
        block_number: u64,
    },
    RewindJHistory(RewindJHistory),
    RetryJSubmit(crate::j_submit::RetryJSubmitData),
    RecordJSubmitResult(crate::j_submit::JSubmitResultData),
    RetryEntityProviderAction(crate::j_submit::RetryEntityProviderActionData),
    RecordEntityProviderActionSubmitResult(crate::j_submit::EntityProviderActionResultData),
    RecordGovernanceJSubmitResult(crate::j_submit::GovernanceResultData),
    Unsupported {
        kind: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAdapterCommandMarker {
    pub lane_id: String,
    pub sequence: u64,
    pub command_id: String,
    pub input_hash: String,
    pub expires_at_ms: Option<u64>,
}

/// Exact Runtime-local replica identity. One Entity may have several local
/// validator replicas; the signer is therefore part of every live/state slot
/// key and can never be inferred from the Entity id alone.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RuntimeEntityKey {
    pub entity_id: [u8; 32],
    pub signer_id: String,
}

impl RuntimeEntityKey {
    pub fn new(entity_id: [u8; 32], signer_id: &str) -> Result<Self, RuntimeMachineError> {
        let signer_id = signer_id.trim().to_ascii_lowercase();
        if signer_id.is_empty() {
            return Err(RuntimeMachineError::SignerIdEmpty);
        }
        Ok(Self {
            entity_id,
            signer_id,
        })
    }

    pub fn replica_id(&self) -> String {
        format!("{}:{}", render_hex(&self.entity_id), self.signer_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewindJHistory {
    pub entity_id: [u8; 32],
    pub signer_id: String,
    pub jurisdiction_ref: String,
    pub conflicting_height: u64,
    pub conflicting_block_hash: [u8; 32],
}

/// RAM-only Entity mempool unit. Every variant becomes exactly one canonical
/// Entity-frame transaction once selected; the Runtime WAL separately keeps
/// the complete authenticated EntityInput that admitted it.
#[derive(Clone, Debug)]
pub(crate) enum EntityPendingWork {
    Account {
        projected: CanonicalEntityTx,
        row: Box<AccountInputRow>,
    },
    LocalBatch {
        projected: Vec<CanonicalEntityTx>,
        native: Vec<LocalEntityTx>,
    },
    Command {
        projected: CanonicalEntityTx,
        command: Box<SignedEntityCommandV1>,
    },
    ProposerMaterialized {
        projected: CanonicalEntityTx,
        native: Box<LocalEntityTx>,
    },
    Projected(CanonicalEntityTx),
}

impl EntityPendingWork {
    pub(super) fn scheduled_wake(&self) -> Option<&CanonicalValue> {
        match self {
            Self::Projected(tx) if tx.kind == EntityTxKind::ScheduledWake => Some(&tx.wire_data),
            _ => None,
        }
    }

    pub(super) fn is_board_handover(&self) -> bool {
        matches!(
            self,
            Self::Projected(tx) if tx.kind == EntityTxKind::BoardHandover
        )
    }
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
    pending_work: Vec<EntityPendingWork>,
    atomic_cross_jurisdiction_pair: Option<RuntimeAtomicCrossJurisdictionPair>,
    /// One already-signed validator J-prefix vote carried by the canonical
    /// EntityInput. The current production board is single-signer, so one
    /// input has exactly one vote; the complete wire value is retained for an
    /// exact comparison with the certificate Rust derives before commit.
    j_prefix_attestation: Option<RuntimeJPrefixAttestation>,
    /// Exact width measured once by the strict tagged-storage admission codec.
    canonical_wire_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAtomicCrossJurisdictionPair {
    pub phase: String,
    pub pair_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RuntimeJPrefixAttestation {
    pub observation: crate::j_watcher::ObserveJRange,
    pub wire: Value,
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
                "entityId"
                    | "signerId"
                    | "entityTxs"
                    | "jPrefixAttestations"
                    | "from"
                    | "runtimeId"
                    | "sourceRuntimeFrame"
                    | "atomicCrossJurisdictionPair"
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
        let atomic_cross_jurisdiction_pair = object
            .get("atomicCrossJurisdictionPair")
            .map(|value| {
                let pair = value.as_object().ok_or_else(|| {
                    RuntimeMachineError::EntityInputTransportInvalid("ATOMIC_PAIR_OBJECT".into())
                })?;
                if pair.len() != 2
                    || pair
                        .keys()
                        .any(|key| !matches!(key.as_str(), "phase" | "pairKey"))
                {
                    return Err(RuntimeMachineError::EntityInputTransportInvalid(
                        "ATOMIC_PAIR_FIELDS".into(),
                    ));
                }
                let phase = pair
                    .get("phase")
                    .and_then(Value::as_str)
                    .filter(|phase| matches!(*phase, "proposal" | "ack"))
                    .ok_or_else(|| {
                        RuntimeMachineError::EntityInputTransportInvalid("ATOMIC_PAIR_PHASE".into())
                    })?;
                let pair_key = pair
                    .get("pairKey")
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                    .ok_or_else(|| {
                        RuntimeMachineError::EntityInputTransportInvalid("ATOMIC_PAIR_KEY".into())
                    })?;
                Ok(RuntimeAtomicCrossJurisdictionPair {
                    phase: phase.to_string(),
                    pair_key: pair_key.to_string(),
                })
            })
            .transpose()?;
        let j_prefix_attestation = decode_j_prefix_attestation(
            object.get("jPrefixAttestations"),
            entity_id_text,
            &signer_id,
        )?;
        let txs: &[Value] = match object.get("entityTxs") {
            Some(value) => value
                .as_array()
                .map(Vec::as_slice)
                .ok_or(RuntimeMachineError::EntityInputTxsArrayRequired)?,
            None => &[],
        };
        let is_remote_output = object.contains_key("sourceRuntimeFrame");
        let mut pending_work = Vec::with_capacity(txs.len());
        let mut local_projected = Vec::new();
        let mut local_native = Vec::new();
        let mut local_individual = None;
        for (index, tx) in txs.iter().enumerate() {
            let projection = crate::entity_frame::project_entity_tx(tx)?;
            if is_remote_output
                && xln_rscore_entity_kernel::is_cross_jurisdiction_entity_tx_kind(projection.kind)
            {
                return Err(RuntimeMachineError::RawRemoteCrossJurisdictionForbidden(
                    projection.kind.as_str(),
                ));
            }
            if projection.kind == xln_rscore_entity_kernel::EntityTxKind::AccountInput {
                if !local_projected.is_empty() {
                    pending_work.push(EntityPendingWork::LocalBatch {
                        projected: std::mem::take(&mut local_projected),
                        native: std::mem::take(&mut local_native),
                    });
                }
                let operation_index =
                    u64::try_from(index).map_err(|_| RuntimeMachineError::InputCountOverflow)?;
                pending_work.push(EntityPendingWork::Account {
                    row: Box::new(crate::decode_entity_account_input_row(
                        entity_id_text,
                        operation_index,
                        tx,
                    )?),
                    projected: projection,
                });
            } else {
                if matches!(
                    projection.kind,
                    xln_rscore_entity_kernel::EntityTxKind::ScheduledWake
                        | xln_rscore_entity_kernel::EntityTxKind::BoardHandover
                ) {
                    if !local_projected.is_empty() {
                        pending_work.push(EntityPendingWork::LocalBatch {
                            projected: std::mem::take(&mut local_projected),
                            native: std::mem::take(&mut local_native),
                        });
                    }
                    // Runtime-generated wake inputs and the exact board
                    // handover preimage are already protocol transactions.
                    // Wrapping either in an EntityCommand would change the
                    // certified bytes and authority. Handover is admitted only
                    // into the atomic `[j_event, boardHandover]` frame below.
                    pending_work.push(EntityPendingWork::Projected(projection));
                    continue;
                }
                if projection.kind == xln_rscore_entity_kernel::EntityTxKind::EntityCommand {
                    if !local_projected.is_empty() {
                        pending_work.push(EntityPendingWork::LocalBatch {
                            projected: std::mem::take(&mut local_projected),
                            native: std::mem::take(&mut local_native),
                        });
                    }
                    pending_work.push(EntityPendingWork::Command {
                        command: Box::new(
                            decode_signed_entity_command(projection.frame_data().ok_or_else(
                                || {
                                    RuntimeMachineError::EntityTxExecutionUnsupported(
                                        projection.kind.as_str(),
                                    )
                                },
                            )?)
                            .map_err(RuntimeMachineError::EntityCommand)?,
                        ),
                        projected: projection,
                    });
                } else {
                    let individual = xln_rscore_entity_kernel::is_individual_entity_command_tx_kind(
                        projection.kind,
                    );
                    if !local_projected.is_empty() && local_individual != Some(individual) {
                        pending_work.push(EntityPendingWork::LocalBatch {
                            projected: std::mem::take(&mut local_projected),
                            native: std::mem::take(&mut local_native),
                        });
                    }
                    let Some(local) = decode_local_entity_tx(&projection)
                        .map_err(RuntimeMachineError::EntityFinancial)?
                    else {
                        return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                            projection.kind.as_str(),
                        ));
                    };
                    local_individual = Some(individual);
                    local_projected.push(projection);
                    local_native.push(local);
                }
            }
        }
        if !local_projected.is_empty() {
            pending_work.push(EntityPendingWork::LocalBatch {
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
            pending_work,
            atomic_cross_jurisdiction_pair,
            j_prefix_attestation,
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

    pub(super) fn atomic_pair(&self) -> Option<&RuntimeAtomicCrossJurisdictionPair> {
        self.atomic_cross_jurisdiction_pair.as_ref()
    }

    pub(super) fn j_prefix_attestation(&self) -> Option<&RuntimeJPrefixAttestation> {
        self.j_prefix_attestation.as_ref()
    }

    pub fn account_input_count(&self) -> usize {
        self.pending_work
            .iter()
            .filter(|work| matches!(work, EntityPendingWork::Account { .. }))
            .count()
    }

    /// Exact already-validated Entity-frame tx projections, in wire order.
    /// Used by the entity-height durability barrier to detect a
    /// `scheduledWake` tx.
    pub fn has_entity_txs(&self) -> bool {
        !self.pending_work.is_empty()
    }

    pub(super) fn scheduled_wake(&self) -> Option<&CanonicalValue> {
        self.pending_work
            .iter()
            .find_map(EntityPendingWork::scheduled_wake)
    }

    pub(super) fn is_board_handover_only(&self) -> bool {
        self.pending_work.len() == 1 && self.pending_work[0].is_board_handover()
    }

    pub(super) fn into_parts(
        self,
    ) -> (
        Value,
        Vec<EntityPendingWork>,
        Option<RuntimeAtomicCrossJurisdictionPair>,
    ) {
        (
            self.canonical,
            self.pending_work,
            self.atomic_cross_jurisdiction_pair,
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
            signer_id: super::tests::entity_signer_id(),
            canonical,
            pending_work: canonical_entity_txs
                .into_iter()
                .map(EntityPendingWork::Projected)
                .collect(),
            atomic_cross_jurisdiction_pair: None,
            j_prefix_attestation: None,
            canonical_wire_bytes: 1,
        }
    }

    #[cfg(test)]
    pub(super) fn fixture(canonical: Value, canonical_wire_bytes: usize) -> Self {
        Self {
            entity_id: super::tests::owner_bytes(),
            signer_id: super::tests::entity_signer_id(),
            canonical,
            pending_work: Vec::new(),
            atomic_cross_jurisdiction_pair: None,
            j_prefix_attestation: None,
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
            signer_id: super::tests::entity_signer_id(),
            canonical,
            pending_work: vec![EntityPendingWork::Account {
                projected: CanonicalEntityTx::from_frame_projection(
                    EntityTxKind::AccountInput,
                    CanonicalValue::Null,
                )
                .expect("fixture Account projection"),
                row: Box::new(account_input),
            }],
            atomic_cross_jurisdiction_pair: None,
            j_prefix_attestation: None,
            canonical_wire_bytes: 1,
        }
    }
}

fn decode_j_prefix_attestation(
    value: Option<&Value>,
    entity_id: &str,
    signer_id: &str,
) -> Result<Option<RuntimeJPrefixAttestation>, RuntimeMachineError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let tagged = value.as_object().ok_or_else(|| {
        RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_MAP_OBJECT".into())
    })?;
    if tagged.len() != 2 || tagged.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "J_PREFIX_MAP_TAG".into(),
        ));
    }
    let rows = tagged
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_MAP_ROWS".into())
        })?;
    if rows.len() != 1 {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "J_PREFIX_SINGLE_SIGNER_REQUIRED".into(),
        ));
    }
    let row = rows[0]
        .as_array()
        .filter(|row| row.len() == 2)
        .ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_MAP_ROW".into())
        })?;
    let map_signer = row[0].as_str().ok_or_else(|| {
        RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_MAP_SIGNER".into())
    })?;
    let attestation = row[1].as_object().ok_or_else(|| {
        RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_ATTESTATION_OBJECT".into())
    })?;
    const FIELDS: [&str; 14] = [
        "version",
        "entityId",
        "targetEntityHeight",
        "parentFrameHash",
        "validatorId",
        "jurisdictionRef",
        "baseHeight",
        "scannedThroughHeight",
        "tipBlockHash",
        "eventHistoryRoot",
        "rangeHash",
        "headers",
        "blocks",
        "signature",
    ];
    if attestation.len() != FIELDS.len()
        || FIELDS.iter().any(|field| !attestation.contains_key(*field))
    {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "J_PREFIX_ATTESTATION_FIELDS".into(),
        ));
    }
    let validator = attestation
        .get("validatorId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_VALIDATOR".into())
        })?;
    let attested_entity = attestation
        .get("entityId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_ENTITY".into())
        })?;
    if map_signer != signer_id || validator != signer_id || attested_entity != entity_id {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "J_PREFIX_IDENTITY_MISMATCH".into(),
        ));
    }
    if attestation.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(RuntimeMachineError::EntityInputTransportInvalid(
            "J_PREFIX_VERSION".into(),
        ));
    }
    let jurisdiction_ref = attestation
        .get("jurisdictionRef")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_JURISDICTION".into())
        })?;
    let blocks = attestation
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_BLOCKS".into()))?
        .iter()
        .map(|value| {
            let source = value.as_object().ok_or_else(|| {
                RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_BLOCK".into())
            })?;
            let mut block = source.clone();
            let height = block.remove("blockNumber").ok_or_else(|| {
                RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_BLOCK_HEIGHT".into())
            })?;
            let hash = block.remove("blockHash").ok_or_else(|| {
                RuntimeMachineError::EntityInputTransportInvalid("J_PREFIX_BLOCK_HASH".into())
            })?;
            block.insert(
                "jurisdictionRef".into(),
                Value::String(jurisdiction_ref.into()),
            );
            block.insert("jHeight".into(), height);
            block.insert("jBlockHash".into(), hash);
            Ok(Value::Object(block))
        })
        .collect::<Result<Vec<_>, RuntimeMachineError>>()?;
    let observation = crate::j_watcher::decode_observe_j_range(&serde_json::json!({
        "entityId": entity_id,
        "signerId": signer_id,
        "jurisdictionRef": jurisdiction_ref,
        "scannedThroughHeight": attestation.get("scannedThroughHeight").cloned().unwrap_or(Value::Null),
        "tipBlockHash": attestation.get("tipBlockHash").cloned().unwrap_or(Value::Null),
        "headers": attestation.get("headers").cloned().unwrap_or(Value::Null),
        "blocks": blocks,
    }))
    .map_err(|error| {
        RuntimeMachineError::EntityInputTransportInvalid(format!(
            "J_PREFIX_OBSERVATION:{}",
            error
        ))
    })?;
    Ok(Some(RuntimeJPrefixAttestation {
        observation,
        wire: row[1].clone(),
    }))
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
pub struct RuntimeEntityFrameContext {
    pub execution: DeterministicContext,
    /// Exact canonical EntityInfraContext committed by this Entity frame.
    pub canonical: CanonicalValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFrameContext {
    pub timestamp: u64,
    pub finalized_j_height: u64,
    /// Exact Entity-frame contexts in certified height order for each replica.
    /// One Runtime frame may advance the same Entity more than once; collapsing
    /// this to one map value loses the earlier replay input.
    pub entity_contexts: BTreeMap<RuntimeEntityKey, VecDeque<RuntimeEntityFrameContext>>,
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
                entity_contexts: BTreeMap::new(),
            },
        }
    }
}

impl RuntimeInput {
    pub fn empty_frame(
        timestamp: u64,
        finalized_j_height: u64,
        entity_id: [u8; 32],
        signer_id: &str,
        entity_context: DeterministicContext,
        canonical_entity_context: CanonicalValue,
    ) -> Self {
        Self {
            runtime_txs: Vec::new(),
            entity_inputs: Vec::new(),
            frame: RuntimeFrameContext {
                timestamp,
                finalized_j_height,
                entity_contexts: BTreeMap::from([(
                    RuntimeEntityKey::new(entity_id, signer_id)
                        .expect("RuntimeInput signer must be non-empty"),
                    VecDeque::from([RuntimeEntityFrameContext {
                        execution: entity_context,
                        canonical: canonical_entity_context,
                    }]),
                )]),
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
            checkpoint_period_frames: 1_000,
            canonical_hash_period_frames: 0,
        }
    }
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self::hlt()
    }
}

/// Deterministic state owned by one local Entity replica.
///
/// The Account forest itself is live machinery. Only its root is committed
/// beside the canonical Entity state, exactly like TypeScript's keyed
/// `RuntimeState.eReplicas` projection.
#[derive(Clone)]
pub struct RuntimeEntityState {
    pub accounts_root: [u8; 32],
    pub entity: EntityStateSlice,
}

/// Deterministic data fixed by one committed Runtime frame.
pub struct RuntimeState {
    pub height: u64,
    pub timestamp: u64,
    pub finalized_j_height: u64,
    pub e_replicas: BTreeMap<RuntimeEntityKey, RuntimeEntityState>,
}

/// Live machinery for one Entity key. No field in this envelope is a second
/// committed state: Entity state and the Account root live only in
/// `RuntimeState.e_replicas`.
pub struct RuntimeEntityReplica {
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
    /// Admitted Entity work deferred only by the canonical Entity-frame byte
    /// budget. The admitting RuntimeInputs live in WAL; replay rebuilds this
    /// RAM-only FIFO, so it is never rooted or checkpointed.
    pub(crate) entity_mempool: VecDeque<EntityPendingWork>,
}

/// One live Runtime owning a path-keyed cohort of Entity replicas.
pub struct RuntimeReplica {
    pub state: RuntimeState,
    pub durable: crate::processor::RuntimeDurableEnvelope,
    pub e_replicas: BTreeMap<RuntimeEntityKey, RuntimeEntityReplica>,
    pub mempool: RuntimeMempool,
    pub limits: RuntimeLimits,
    /// Operator secret used only to derive proposer-owned public commitments.
    /// It is never projected into Runtime/Entity state or persisted beside it.
    pub(crate) proposer_runtime_seed: String,
}

impl RuntimeEntityReplica {
    /// Exact live Entity-replica envelope committed by `replicaMetaDigest`.
    /// Read-only exposure keeps replay diagnostics on the canonical value;
    /// callers cannot maintain a second metadata model.
    pub fn replica_metadata(&self) -> &Value {
        &self.replica_metadata
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        state: &RuntimeEntityState,
        entity_id: [u8; 32],
        signer_id: String,
        accounts: ResidentConsensusEngine,
        entity_consensus: ResidentEntityConsensusReplica,
        entity_signer: EntitySingleSigner,
        protocol_fingerprint: [u8; 32],
        runtime_height: u64,
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
        let replica_metadata = serde_json::json!({
            "entityId": state.entity.entity_id,
            "signerId": entity_signer.signer_id(),
            "isProposer": true,
        });
        Ok(Self {
            entity_id,
            signer_id: entity_signer.signer_id().to_string(),
            accounts,
            entity_consensus,
            entity_signer,
            protocol_fingerprint,
            replica_metadata,
            certified_board_registry: crate::CertifiedBoardRegistry::empty(),
            last_materialized_height: runtime_height,
            entity_mempool: VecDeque::new(),
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
            == Some(render_hex(&self.entity_id).as_str())
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

impl RuntimeReplica {
    #[allow(clippy::too_many_arguments)] // Genesis/restore supplies one exact initial Entity slot.
    pub fn new(
        state: RuntimeState,
        durable: crate::processor::RuntimeDurableEnvelope,
        entity_id: [u8; 32],
        signer_id: String,
        accounts: ResidentConsensusEngine,
        entity_consensus: ResidentEntityConsensusReplica,
        entity_signer: EntitySingleSigner,
        protocol_fingerprint: [u8; 32],
        proposer_runtime_seed: String,
        limits: RuntimeLimits,
    ) -> Result<Self, RuntimeMachineError> {
        if proposer_runtime_seed.trim().is_empty() {
            return Err(RuntimeMachineError::RuntimeSeedEmpty);
        }
        let key = RuntimeEntityKey::new(entity_id, &signer_id)?;
        let entity_state = state
            .e_replicas
            .get(&key)
            .ok_or(RuntimeMachineError::EntityOwnerMismatch)?;
        let entity = RuntimeEntityReplica::new(
            entity_state,
            entity_id,
            signer_id,
            accounts,
            entity_consensus,
            entity_signer,
            protocol_fingerprint,
            state.height,
        )?;
        let mut e_replicas = BTreeMap::new();
        e_replicas.insert(key, entity);
        Ok(Self {
            state,
            durable,
            e_replicas,
            mempool: RuntimeMempool::empty(),
            limits,
            proposer_runtime_seed,
        })
    }

    pub fn entity_slot(
        &self,
        entity_id: &[u8; 32],
        signer_id: &str,
    ) -> Option<(&RuntimeEntityState, &RuntimeEntityReplica)> {
        let key = RuntimeEntityKey::new(*entity_id, signer_id).ok()?;
        Some((self.state.e_replicas.get(&key)?, self.e_replicas.get(&key)?))
    }

    pub(crate) fn contains_entity_id(&self, entity_id: &[u8; 32]) -> bool {
        let start = RuntimeEntityKey {
            entity_id: *entity_id,
            signer_id: String::new(),
        };
        self.state
            .e_replicas
            .range(start..)
            .next()
            .is_some_and(|(key, _)| &key.entity_id == entity_id)
    }

    pub(crate) fn take_entity_slot(
        &mut self,
        entity_id: &[u8; 32],
        signer_id: &str,
    ) -> Option<(RuntimeEntityState, RuntimeEntityReplica)> {
        let key = RuntimeEntityKey::new(*entity_id, signer_id).ok()?;
        self.state.e_replicas.get(&key)?;
        self.e_replicas.get(&key)?;
        Some({
            let state = self
                .state
                .e_replicas
                .remove(&key)
                .expect("checked Entity state slot");
            let replica = self.e_replicas.remove(&key).expect("checked Entity slot");
            (state, replica)
        })
    }

    pub(crate) fn install_entity_slot(
        &mut self,
        key: RuntimeEntityKey,
        state: RuntimeEntityState,
        replica: RuntimeEntityReplica,
    ) -> Result<(), RuntimeMachineError> {
        if replica.entity_id != key.entity_id || replica.signer_id != key.signer_id {
            return Err(RuntimeMachineError::EntityStateMap(
                "SLOT_IDENTITY_MISMATCH".into(),
            ));
        }
        if self.state.e_replicas.insert(key.clone(), state).is_some() {
            return Err(RuntimeMachineError::EntityStateMap(
                "STATE_SLOT_ALREADY_PRESENT".into(),
            ));
        }
        if self.e_replicas.insert(key, replica).is_some() {
            return Err(RuntimeMachineError::EntityStateMap(
                "LIVE_SLOT_ALREADY_PRESENT".into(),
            ));
        }
        Ok(())
    }

    pub fn entity_slot_mut(
        &mut self,
        entity_id: &[u8; 32],
        signer_id: &str,
    ) -> Option<(&mut RuntimeEntityState, &mut RuntimeEntityReplica)> {
        let key = RuntimeEntityKey::new(*entity_id, signer_id).ok()?;
        Some((
            self.state.e_replicas.get_mut(&key)?,
            self.e_replicas.get_mut(&key)?,
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedRuntimeInput {
    pub entity_inputs: usize,
    pub account_inputs: usize,
    pub canonical_wire_bytes: usize,
    /// RAM-only fitter diagnostics. They are never encoded into Runtime state
    /// or WAL metadata; the complete accepted Runtime input remains the WAL
    /// authority while the tail is reconstructed by replay.
    pub entity_txs_selected: usize,
    pub entity_txs_pending: usize,
    pub wakes: Vec<RuntimeEntityWake>,
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
    pub entity_frame_count: usize,
}

/// Runtime-generated Entity work. This is an internal EntityInput reason, not
/// an external effect and never a RuntimeTx.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeWake {
    pub entity_mempool: bool,
    pub account_mempool: bool,
    pub scheduled: Option<ScheduledWake>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeEntityWake {
    pub entity_id: [u8; 32],
    pub signer_id: String,
    pub wake: RuntimeWake,
}

/// One Entity transition certified inside this Runtime frame. Vector order is
/// first-seen input order; it is never reconstructed by iterating the keyed
/// replica map.
pub struct RuntimeEntityOutputs {
    pub entity_id: [u8; 32],
    pub signer_id: String,
    /// Exact certified Entity frame identity produced by this transition.
    /// A Runtime frame may advance one Entity more than once, so an earlier
    /// transition cannot be reconstructed from the final replica head.
    pub entity_frame_height: u64,
    pub entity_frame_timestamp: u64,
    pub entity_frame_hash: String,
    pub entity_frame_events: Vec<xln_rscore_entity_kernel::EntityFrameEvent>,
    /// Exact canonical context consumed by this certified Entity frame. It is
    /// moved to Runtime projection; projection must never reconstruct it from
    /// the final replica head when one Runtime frame contains multiple heights.
    pub entity_context: CanonicalValue,
    pub accounts_root: [u8; 32],
    pub entity_events: Vec<EntityKernelOutput>,
    /// Exact Entity-local outputs. Runtime routing may add transport metadata,
    /// but must not reconstruct Account or consensus-authorized payloads.
    pub local_entity_outputs: Vec<LocalEntityOutput>,
    /// Atomic Account-pair envelope for ACK outputs produced by this Entity
    /// transition. This RAM-only marker is bound into the flat Runtime outbox;
    /// it is not Entity/Account state and never changes their roots.
    pub atomic_cross_jurisdiction_pair: Option<RuntimeAtomicCrossJurisdictionPair>,
    pub entity_state_root: String,
    pub entity_authority_root: String,
    pub checkpoint: Option<AccountsCheckpoint>,
}

/// Outputs remain internal until the Runtime WAL writer fsyncs the frame.
pub struct RuntimeOutputs {
    pub entities: Vec<RuntimeEntityOutputs>,
    /// Exact logical rows dirtied by this certified frame. Storage uses these
    /// only for history/materialization indexes; no root is reconstructed from
    /// them. Account ids preserve canonical first-touch order and are
    /// de-duplicated at the reducer boundary.
    pub touches: RuntimeFrameTouches,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeFrameTouches {
    pub entity_ids: Vec<String>,
    pub accounts: Vec<RuntimeTouchedAccount>,
    pub book_entity_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeTouchedAccount {
    pub entity_id: String,
    pub counterparty_id: String,
}

/// Provenance of one Account frame committed while applying a Runtime frame.
///
/// This is ordered replay evidence only. It is not committed into Runtime
/// state and is never persisted as a second history source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountCommitSource {
    AckCommit,
    CounterpartyCommit,
}

/// Exact compact evidence for one Account frame that became committed.
///
/// A combined `ack_frame` contributes two rows in canonical TS order: the ACK
/// commit first, then the accepted peer frame. Retaining both rows is required
/// because the final Account leaf alone cannot prove that intermediate order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountCommitEvidence {
    pub entity_id: [u8; 32],
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
    /// Validator-local external writes released only after this frame's WAL
    /// fsync. The same attempts are committed in Runtime infrastructure, so a
    /// crash reconstructs them without a second queue.
    pub post_commit_j_attempts: Vec<crate::j_submit::DurableJAttempt>,
    /// Transient diagnostics for the exact Runtime apply call. This is never
    /// encoded, rooted or persisted; replay and live execution expose the same
    /// observation only when `XLN_RUNTIME_APPLY_PROFILE=1`.
    pub apply_profile: Option<RuntimeApplyPhaseProfile>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeApplyPhaseProfile {
    pub fit: std::time::Duration,
    pub resident_core: std::time::Duration,
    pub post_core_prepare: std::time::Duration,
    pub certification: std::time::Duration,
    pub settlement_attach: std::time::Duration,
    pub post_cert_j: std::time::Duration,
    pub total: std::time::Duration,
    pub residual: std::time::Duration,
    pub entity_groups: usize,
    pub entity_txs_selected: usize,
    pub account_inputs: usize,
    pub settlement_hankos: usize,
    pub post_cert_j_actions: usize,
}

impl RuntimeApplyPhaseProfile {
    pub fn accounted(&self) -> std::time::Duration {
        self.fit
            + self.resident_core
            + self.post_core_prepare
            + self.certification
            + self.settlement_attach
            + self.post_cert_j
    }
}

impl RuntimeApplyResult {
    /// Borrow exact certified frames in the same first-seen order as the
    /// per-Entity transition outputs. The keyed maps are lookup-only here;
    /// their sorted implementation order is never protocol output order.
    pub fn certified_entity_frames(&self) -> impl Iterator<Item = ([u8; 32], &EntityFrame)> {
        self.outputs.entities.iter().filter_map(|output| {
            let key = RuntimeEntityKey::new(output.entity_id, &output.signer_id).ok()?;
            self.replica
                .e_replicas
                .get(&key)
                .and_then(|replica| replica.entity_consensus.certified_frame_head.as_ref())
                .map(|head| (output.entity_id, &head.frame))
        })
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
    #[error("RUNTIME_SEED_EMPTY")]
    RuntimeSeedEmpty,
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
    #[error("RUNTIME_ENTITY_STATE_MAP:{0}")]
    EntityStateMap(String),
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
    #[error("RUNTIME_CROSS_J_ATOMIC_PAIR_INVALID:{0}")]
    AtomicCrossJurisdictionPairInvalid(String),
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
    #[error("RUNTIME_OUTPUT_RAW_CROSS_J_FORBIDDEN:{0}")]
    RawRemoteCrossJurisdictionForbidden(&'static str),
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
    #[error("RUNTIME_CHECKPOINT_BARRIER_NOT_ISOLATED")]
    CheckpointBarrierNotIsolated,
    #[error("RUNTIME_WIRE_BYTES_OVERFLOW")]
    WireBytesOverflow,
    #[error("RUNTIME_SYNTHETIC_ENTITY_INPUT_ENCODING:{0}")]
    SyntheticEntityInputEncoding(String),
    #[error("RUNTIME_TX_UNSUPPORTED:{kind}")]
    UnsupportedRuntimeTx { kind: String },
    #[error("RUNTIME_J_SUBMIT:{0}")]
    JSubmit(String),
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
