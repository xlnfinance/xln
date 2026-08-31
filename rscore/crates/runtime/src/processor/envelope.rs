//! Durable Runtime authority that cannot be derived from R/E/A state.
//!
//! The envelope deliberately excludes Runtime mempool contents, selected
//! Entity context, Entity/Account state and every digest derived from them.
//! Those values remain owned by their machines and are projected exactly once
//! when a Runtime frame is made durable.

use num_bigint::BigInt;
use serde_json::{Map, Number, Value, json};
use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use crate::{TaggedJsonError, canonical_value_from_tagged_json, restore::MigrationOrigin};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const INFRASTRUCTURE_MAP_FIELDS: [&str; 6] = [
    "accountJClaimNodes",
    "certifiedBoardNodes",
    "certifiedRegistrationEvidence",
    "entityEncryptionSeeds",
    "runtimeAdapterCommandFrontiers",
    "pendingJurisdictionImports",
];
const INFRASTRUCTURE_FIELDS: [&str; 7] = [
    "accountJClaimNodes",
    "certifiedBoardNodes",
    "certifiedRegistrationEvidence",
    "entityEncryptionSeeds",
    "runtimeAdapterCommandFrontiers",
    "pendingCommittedJOutbox",
    "pendingJurisdictionImports",
];
const J_REPLICA_REQUIRED_FIELDS: [&str; 7] = [
    "blockDelayMs",
    "blockNumber",
    "lastBlockTimestamp",
    "mempool",
    "name",
    "position",
    "stateRoot",
];
const J_REPLICA_OPTIONAL_FIELDS: [&str; 8] = [
    "blockTimeMs",
    "blockReady",
    "watcherConfirmationDepth",
    "rpcs",
    "chainId",
    "entityProviderDeploymentBlock",
    "contracts",
    "tokenRegistry",
];
const STORAGE_CONFIG_FIELDS: [&str; 7] = [
    "enabled",
    "snapshotPeriodFrames",
    "retainSnapshots",
    "epochMaxBytes",
    "materializePeriodFrames",
    "canonicalHashPeriodFrames",
    "accountMerkleRadix",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeOperatorConfig {
    pub loop_interval_ms: Option<u64>,
    pub min_frame_delay_ms: u64,
    /// Import-only compatibility with checkpoints written before the dead
    /// knob was removed. New native Runtimes leave this absent.
    pub snapshot_interval_frames: Option<u64>,
    pub(crate) entity_consensus_state_warning_bytes: Option<u64>,
    pub(crate) advertise_profile_mirrors: Option<bool>,
    pub(crate) performance: Option<RuntimePerformanceConfig>,
    pub(crate) storage: Option<RuntimeStorageConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimePerformanceConfig {
    max_clone_bytes: Option<serde_json::Number>,
    max_clone_ms: Option<serde_json::Number>,
    max_reducer_ms: Option<serde_json::Number>,
    max_wal_ms: Option<serde_json::Number>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeStorageConfig {
    enabled: Option<bool>,
    snapshot_period_frames: Option<u64>,
    retain_snapshots: Option<u64>,
    epoch_max_bytes: Option<u64>,
    materialize_period_frames: Option<u64>,
    canonical_hash_period_frames: Option<u64>,
    account_merkle_radix: Option<u64>,
}

impl RuntimePerformanceConfig {
    fn value(&self) -> Value {
        let mut output = Map::new();
        for (field, value) in [
            ("maxCloneBytes", &self.max_clone_bytes),
            ("maxCloneMs", &self.max_clone_ms),
            ("maxReducerMs", &self.max_reducer_ms),
            ("maxWalMs", &self.max_wal_ms),
        ] {
            if let Some(value) = value {
                output.insert(field.into(), Value::Number(value.clone()));
            }
        }
        Value::Object(output)
    }
}

impl RuntimeStorageConfig {
    fn value(&self) -> Value {
        let mut output = Map::new();
        if let Some(value) = self.enabled {
            output.insert("enabled".into(), Value::Bool(value));
        }
        for (field, value) in self.numeric_fields() {
            if let Some(value) = value {
                output.insert(field.into(), Value::Number(Number::from(value)));
            }
        }
        Value::Object(output)
    }

    fn numeric_fields(&self) -> [(&'static str, Option<u64>); 6] {
        [
            ("snapshotPeriodFrames", self.snapshot_period_frames),
            ("retainSnapshots", self.retain_snapshots),
            ("epochMaxBytes", self.epoch_max_bytes),
            ("materializePeriodFrames", self.materialize_period_frames),
            (
                "canonicalHashPeriodFrames",
                self.canonical_hash_period_frames,
            ),
            ("accountMerkleRadix", self.account_merkle_radix),
        ]
    }
}

impl RuntimeOperatorConfig {
    /// Canonical Runtime materialization cadence persisted by TypeScript.
    /// Restore uses this value instead of an operator-side replay default, so
    /// either engine checkpoints the same Runtime frames after a crash.
    pub fn materialize_period_frames(&self) -> Option<u64> {
        self.storage
            .as_ref()
            .and_then(|storage| storage.materialize_period_frames)
    }

    pub fn canonical_hash_period_frames(&self) -> Option<u64> {
        self.storage
            .as_ref()
            .and_then(|storage| storage.canonical_hash_period_frames)
    }

    pub(crate) fn value(&self) -> Value {
        let mut output = Map::from_iter([(
            "minFrameDelayMs".into(),
            Value::Number(Number::from(self.min_frame_delay_ms)),
        )]);
        if let Some(value) = self.loop_interval_ms {
            output.insert("loopIntervalMs".into(), Value::Number(Number::from(value)));
        }
        self.insert_optionals(&mut output);
        Value::Object(output)
    }

    fn insert_optionals(&self, output: &mut Map<String, Value>) {
        for (field, value) in [
            ("snapshotIntervalFrames", self.snapshot_interval_frames),
            (
                "entityConsensusStateWarningBytes",
                self.entity_consensus_state_warning_bytes,
            ),
        ] {
            if let Some(value) = value {
                output.insert(field.into(), Value::Number(Number::from(value)));
            }
        }
        if let Some(value) = self.advertise_profile_mirrors {
            output.insert("advertiseProfileMirrors".into(), Value::Bool(value));
        }
        if let Some(value) = &self.performance {
            output.insert("performance".into(), value.value());
        }
        if let Some(value) = &self.storage {
            output.insert("storage".into(), value.value());
        }
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeDurableEnvelope {
    runtime_id: String,
    prev_frame_hash: [u8; 32],
    active_jurisdiction: String,
    runtime_config: RuntimeOperatorConfig,
    infrastructure: Value,
    j_replicas: Value,
    /// Derived-only memo of the per-frame component digests. Never part of
    /// identity or persistence; invalidated by the one mutation that can
    /// change a committed component (`advance_j_watcher_cursor`).
    component_digests: ComponentDigestCache,
}

/// `runtime_id` and `infrastructure` cannot change after decode; `j_replicas`
/// changes only through `advance_j_watcher_cursor`, which clears its cell.
#[derive(Clone, Debug, Default)]
pub(crate) struct ComponentDigestCache {
    pub(crate) runtime_id: std::cell::RefCell<Option<String>>,
    pub(crate) infrastructure: std::cell::RefCell<Option<String>>,
    pub(crate) j_replicas: std::cell::RefCell<Option<String>>,
}

impl RuntimeDurableEnvelope {
    /// Decode the exact narrow HLT Runtime-machine authority. The caller owns
    /// RuntimeInput separately; BrowserVM and transport queues are prohibited
    /// instead of being silently ignored.
    pub fn decode(
        machine: &Value,
        prev_frame_hash: [u8; 32],
    ) -> Result<Self, RuntimeDurableEnvelopeError> {
        let machine_object = object(machine, "machine")?;
        exact_fields(
            machine_object,
            &[
                "activeJurisdiction",
                "infrastructure",
                "jReplicas",
                "runtimeConfig",
                "runtimeId",
            ],
            &["networkInbox", "pendingNetworkOutputs", "pendingOutputs"],
            "machine",
        )?;
        for field in ["networkInbox", "pendingNetworkOutputs", "pendingOutputs"] {
            if let Some(value) = machine_object.get(field) {
                let rows = value
                    .as_array()
                    .ok_or_else(|| RuntimeDurableEnvelopeError::Array(field.into()))?;
                if !rows.is_empty() {
                    return Err(RuntimeDurableEnvelopeError::TransportState(field.into()));
                }
            }
        }
        let runtime_id = string(machine_object, "runtimeId")?.to_string();
        if !canonical_hex(&runtime_id, 20) {
            return Err(RuntimeDurableEnvelopeError::RuntimeId(runtime_id));
        }
        let active_jurisdiction = string(machine_object, "activeJurisdiction")?.to_string();
        if active_jurisdiction.is_empty() {
            return Err(RuntimeDurableEnvelopeError::ActiveJurisdiction);
        }
        let runtime_config = decode_runtime_config(required(machine_object, "runtimeConfig")?)?;
        let infrastructure = required(machine_object, "infrastructure")?.clone();
        validate_infrastructure(&infrastructure)?;
        let j_replicas = required(machine_object, "jReplicas")?.clone();
        validate_j_replicas(&j_replicas)?;
        Ok(Self {
            runtime_id,
            prev_frame_hash,
            active_jurisdiction,
            runtime_config,
            infrastructure,
            j_replicas,
            component_digests: ComponentDigestCache::default(),
        })
    }

    pub(crate) fn component_digest_cache(&self) -> &ComponentDigestCache {
        &self.component_digests
    }

    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub fn prev_frame_hash(&self) -> [u8; 32] {
        self.prev_frame_hash
    }

    pub fn active_jurisdiction(&self) -> &str {
        &self.active_jurisdiction
    }

    pub fn runtime_config(&self) -> &RuntimeOperatorConfig {
        &self.runtime_config
    }

    pub fn infrastructure(&self) -> &Value {
        &self.infrastructure
    }

    pub(crate) fn infrastructure_mut(&mut self) -> &mut Value {
        &mut self.infrastructure
    }

    pub(crate) fn j_replicas_mut(&mut self) -> &mut Value {
        &mut self.j_replicas
    }

    pub(crate) fn set_active_jurisdiction(&mut self, value: String) {
        self.active_jurisdiction = value;
    }

    pub(crate) fn invalidate_j_replicas_digest(&mut self) {
        *self.component_digests.j_replicas.borrow_mut() = None;
    }

    pub(crate) fn invalidate_infrastructure_digest(&mut self) {
        *self.component_digests.infrastructure.borrow_mut() = None;
    }

    pub fn j_replicas(&self) -> &Value {
        &self.j_replicas
    }

    /// Bind a one-time offline TS snapshot to the last original Runtime frame.
    /// The materialization frame is an import container, not a new protocol
    /// frame; the first native WAL row must extend the existing signed chain.
    pub fn adopt_offline_import_lineage(
        &mut self,
        _origin: MigrationOrigin,
        source_frame_hash: [u8; 32],
    ) {
        self.prev_frame_hash = source_frame_hash;
    }

    /// Apply the same durable watcher cursor transition as TypeScript. The
    /// previous Runtime root is intentionally not supplied: this envelope is
    /// the owned in-memory authority and the next Runtime frame commits it.
    pub fn advance_j_watcher_cursor(
        &mut self,
        depository_address: &str,
        chain_id: u64,
        block_number: u64,
    ) -> Result<(), RuntimeDurableEnvelopeError> {
        let rows = self
            .j_replicas
            .as_array_mut()
            .ok_or_else(|| RuntimeDurableEnvelopeError::Array("jReplicas".into()))?;
        let matches = matching_j_replica_indexes(rows, depository_address, chain_id)?;
        let [index] = matches.as_slice() else {
            return Err(if matches.is_empty() {
                RuntimeDurableEnvelopeError::WatcherNotFound
            } else {
                RuntimeDurableEnvelopeError::WatcherAmbiguous
            });
        };
        let replica = rows[*index][1]
            .as_object_mut()
            .ok_or(RuntimeDurableEnvelopeError::JReplicaRow(*index))?;
        let current = canonical_value_from_tagged_json(required(replica, "blockNumber")?)?;
        let CanonicalValue::BigInt(current) = current else {
            return Err(RuntimeDurableEnvelopeError::JReplicaBlock(*index));
        };
        if current < BigInt::from(block_number) {
            replica.insert(
                "blockNumber".into(),
                json!({"__xlnType":"BigInt","value":block_number.to_string()}),
            );
        }
        *self.component_digests.j_replicas.borrow_mut() = None;
        Ok(())
    }

    /// Advance lineage only after the frame and outbox have crossed the real
    /// fsync boundary. A mismatch means the caller attempted to continue a
    /// stale in-memory Runtime.
    pub(crate) fn advance_frame_hash(
        &mut self,
        expected_previous: [u8; 32],
        next: [u8; 32],
    ) -> Result<(), RuntimeDurableEnvelopeError> {
        if self.prev_frame_hash != expected_previous {
            return Err(RuntimeDurableEnvelopeError::Lineage);
        }
        self.prev_frame_hash = next;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self::decode(&tests::fixture(), [0; 32]).expect("durable envelope fixture")
    }
}

/// Equality is over the committed authority only; the derived digest memo is
/// deliberately invisible to it.
impl PartialEq for RuntimeDurableEnvelope {
    fn eq(&self, other: &Self) -> bool {
        self.runtime_id == other.runtime_id
            && self.prev_frame_hash == other.prev_frame_hash
            && self.active_jurisdiction == other.active_jurisdiction
            && self.runtime_config == other.runtime_config
            && self.infrastructure == other.infrastructure
            && self.j_replicas == other.j_replicas
    }
}

impl Eq for RuntimeDurableEnvelope {}

#[cfg(test)]
impl RuntimeDurableEnvelope {
    #[cfg(test)]
    pub(crate) fn fixture_for_runtime(runtime_id: &str, prev_frame_hash: [u8; 32]) -> Self {
        let mut machine = tests::fixture();
        machine["runtimeId"] = Value::String(runtime_id.to_string());
        Self::decode(&machine, prev_frame_hash).expect("durable envelope fixture")
    }
}

fn decode_runtime_config(
    value: &Value,
) -> Result<RuntimeOperatorConfig, RuntimeDurableEnvelopeError> {
    let object = object(value, "runtimeConfig")?;
    exact_fields(
        object,
        &["minFrameDelayMs"],
        &[
            "loopIntervalMs",
            "snapshotIntervalFrames",
            "entityConsensusStateWarningBytes",
            "advertiseProfileMirrors",
            "performance",
            "storage",
        ],
        "runtimeConfig",
    )?;
    Ok(RuntimeOperatorConfig {
        loop_interval_ms: optional_safe_u64(object, "loopIntervalMs")?,
        min_frame_delay_ms: safe_u64(object, "minFrameDelayMs")?,
        snapshot_interval_frames: optional_safe_u64(object, "snapshotIntervalFrames")?,
        entity_consensus_state_warning_bytes: optional_safe_u64(
            object,
            "entityConsensusStateWarningBytes",
        )?,
        advertise_profile_mirrors: optional_boolean(object, "advertiseProfileMirrors")?,
        performance: object
            .get("performance")
            .map(decode_performance_config)
            .transpose()?,
        storage: object
            .get("storage")
            .map(decode_storage_config)
            .transpose()?,
    })
}

fn decode_performance_config(
    value: &Value,
) -> Result<RuntimePerformanceConfig, RuntimeDurableEnvelopeError> {
    let object = object(value, "runtimeConfig.performance")?;
    exact_fields(
        object,
        &[],
        &["maxCloneBytes", "maxCloneMs", "maxReducerMs", "maxWalMs"],
        "runtimeConfig.performance",
    )?;
    Ok(RuntimePerformanceConfig {
        max_clone_bytes: optional_finite_number(object, "maxCloneBytes")?,
        max_clone_ms: optional_finite_number(object, "maxCloneMs")?,
        max_reducer_ms: optional_finite_number(object, "maxReducerMs")?,
        max_wal_ms: optional_finite_number(object, "maxWalMs")?,
    })
}

fn decode_storage_config(
    value: &Value,
) -> Result<RuntimeStorageConfig, RuntimeDurableEnvelopeError> {
    let object = object(value, "runtimeConfig.storage")?;
    exact_fields(object, &[], &STORAGE_CONFIG_FIELDS, "runtimeConfig.storage")?;
    let account_merkle_radix = optional_safe_u64(object, "accountMerkleRadix")?;
    if account_merkle_radix.is_some_and(|value| value != 16 && value != 256) {
        return Err(RuntimeDurableEnvelopeError::Number("accountMerkleRadix"));
    }
    Ok(RuntimeStorageConfig {
        enabled: optional_boolean(object, "enabled")?,
        snapshot_period_frames: optional_safe_u64(object, "snapshotPeriodFrames")?,
        retain_snapshots: optional_safe_u64(object, "retainSnapshots")?,
        epoch_max_bytes: optional_safe_u64(object, "epochMaxBytes")?,
        materialize_period_frames: optional_safe_u64(object, "materializePeriodFrames")?,
        canonical_hash_period_frames: optional_safe_u64(object, "canonicalHashPeriodFrames")?,
        account_merkle_radix,
    })
}

fn validate_infrastructure(value: &Value) -> Result<(), RuntimeDurableEnvelopeError> {
    let object = object(value, "infrastructure")?;
    exact_fields(object, &[], &INFRASTRUCTURE_FIELDS, "infrastructure")?;
    for field in INFRASTRUCTURE_MAP_FIELDS {
        let Some(value) = object.get(field) else {
            continue;
        };
        let tagged = value
            .as_object()
            .and_then(|value| value.get("__xlnType"))
            .and_then(Value::as_str);
        if tagged != Some("Map") {
            return Err(RuntimeDurableEnvelopeError::InfrastructureMap(field));
        }
        canonical_value_from_tagged_json(value)?;
    }
    crate::j_submit::decode_pending_j_submit_attempts(value)
        .map_err(|error| RuntimeDurableEnvelopeError::JSubmit(error.to_string()))?;
    if let Some(frontiers) = object.get("runtimeAdapterCommandFrontiers") {
        validate_runtime_adapter_command_frontiers(frontiers)?;
    }
    Ok(())
}

fn validate_runtime_adapter_command_frontiers(
    value: &Value,
) -> Result<(), RuntimeDurableEnvelopeError> {
    let tagged = value
        .as_object()
        .ok_or_else(|| RuntimeDurableEnvelopeError::RuntimeAdapterCommand("MAP_OBJECT".into()))?;
    if tagged.len() != 2 || tagged.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
            "MAP_TAG".into(),
        ));
    }
    let rows = tagged
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimeDurableEnvelopeError::RuntimeAdapterCommand("MAP_ROWS".into()))?;
    if rows.len() > 1_024 {
        return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
            "CAPACITY".into(),
        ));
    }
    let mut prior = None::<&str>;
    for row in rows {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| RuntimeDurableEnvelopeError::RuntimeAdapterCommand("ROW".into()))?;
        let lane = pair[0]
            .as_str()
            .filter(|lane| canonical_hex(lane, 32))
            .ok_or_else(|| RuntimeDurableEnvelopeError::RuntimeAdapterCommand("LANE".into()))?;
        if prior.is_some_and(|prior| prior >= lane) {
            return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
                "LANE_ORDER".into(),
            ));
        }
        prior = Some(lane);
        let frontier = pair[1]
            .as_object()
            .ok_or_else(|| RuntimeDurableEnvelopeError::RuntimeAdapterCommand("FRONTIER".into()))?;
        let fields = [
            "lastContiguousSequence",
            "lastInputHash",
            "lastCommandId",
            "observedHeight",
            "expiresAtMs",
        ];
        if frontier.len() != fields.len()
            || !fields.iter().all(|field| frontier.contains_key(*field))
        {
            return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
                "FRONTIER_FIELDS".into(),
            ));
        }
        for field in ["lastContiguousSequence", "observedHeight"] {
            let number = frontier[field]
                .as_u64()
                .filter(|number| *number <= MAX_SAFE_INTEGER)
                .ok_or_else(|| {
                    RuntimeDurableEnvelopeError::RuntimeAdapterCommand(format!("FRONTIER_{field}"))
                })?;
            if field == "lastContiguousSequence" && number == 0 {
                return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
                    "FRONTIER_SEQUENCE".into(),
                ));
            }
        }
        for field in ["lastInputHash"] {
            if !frontier[field]
                .as_str()
                .is_some_and(|value| canonical_hex(value, 32))
            {
                return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(format!(
                    "FRONTIER_{field}"
                )));
            }
        }
        let command_id_valid = frontier["lastCommandId"].as_str().is_some_and(|value| {
            (16..=128).contains(&value.len())
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                })
        });
        if !command_id_valid {
            return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
                "FRONTIER_COMMAND_ID".into(),
            ));
        }
        if !frontier["expiresAtMs"].is_null()
            && !frontier["expiresAtMs"]
                .as_u64()
                .is_some_and(|value| value > 0 && value <= MAX_SAFE_INTEGER)
        {
            return Err(RuntimeDurableEnvelopeError::RuntimeAdapterCommand(
                "FRONTIER_EXPIRY".into(),
            ));
        }
    }
    Ok(())
}

fn validate_j_replicas(value: &Value) -> Result<(), RuntimeDurableEnvelopeError> {
    let rows = value
        .as_array()
        .ok_or_else(|| RuntimeDurableEnvelopeError::Array("jReplicas".into()))?;
    for (index, row) in rows.iter().enumerate() {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or(RuntimeDurableEnvelopeError::JReplicaRow(index))?;
        let key = pair[0]
            .as_str()
            .filter(|key| !key.is_empty())
            .ok_or(RuntimeDurableEnvelopeError::JReplicaRow(index))?;
        let replica = object(&pair[1], "jReplica")?;
        exact_fields(
            replica,
            &J_REPLICA_REQUIRED_FIELDS,
            &J_REPLICA_OPTIONAL_FIELDS,
            "jReplica",
        )?;
        if string(replica, "name")? != key {
            return Err(RuntimeDurableEnvelopeError::JReplicaName(index));
        }
        finite_number(replica, "blockDelayMs", true)?;
        if replica.contains_key("blockTimeMs") {
            finite_number(replica, "blockTimeMs", true)?;
        }
        safe_u64(replica, "lastBlockTimestamp")?;
        for field in [
            "chainId",
            "entityProviderDeploymentBlock",
            "watcherConfirmationDepth",
        ] {
            optional_safe_u64(replica, field)?;
        }
        optional_boolean(replica, "blockReady")?;
        if let Some(rpcs) = replica.get("rpcs")
            && !rpcs
                .as_array()
                .is_some_and(|rows| rows.iter().all(Value::is_string))
        {
            return Err(RuntimeDurableEnvelopeError::JReplicaRow(index));
        }
        if let Some(contracts) = replica.get("contracts") {
            let contracts = object(contracts, "jReplica.contracts")?;
            exact_fields(
                contracts,
                &[],
                &[
                    "depository",
                    "entityProvider",
                    "account",
                    "deltaTransformer",
                ],
                "jReplica.contracts",
            )?;
            if !contracts.values().all(Value::is_string) {
                return Err(RuntimeDurableEnvelopeError::JReplicaRow(index));
            }
        }
        if let Some(tokens) = replica.get("tokenRegistry") {
            crate::j_import::decode_token_registry(tokens)
                .map_err(|_| RuntimeDurableEnvelopeError::JReplicaRow(index))?;
        }
        let block_number = required(replica, "blockNumber")?;
        match canonical_value_from_tagged_json(block_number)? {
            xln_rscore_protocol::CanonicalValue::BigInt(value)
                if value.sign() != num_bigint::Sign::Minus => {}
            _ => return Err(RuntimeDurableEnvelopeError::JReplicaBlock(index)),
        }
        if !required(replica, "mempool")?.is_array() {
            return Err(RuntimeDurableEnvelopeError::JReplicaRow(index));
        }
        let position = object(required(replica, "position")?, "jReplica.position")?;
        exact_fields(position, &["x", "y", "z"], &[], "jReplica.position")?;
        for axis in ["x", "y", "z"] {
            finite_number(position, axis, false)?;
        }
        if let Some(root) = replica.get("stateRoot").and_then(Value::as_str)
            && !canonical_hex(root, 32)
        {
            return Err(RuntimeDurableEnvelopeError::JReplicaStateRoot(index));
        }
        if !replica["stateRoot"].is_null() && !replica["stateRoot"].is_string() {
            return Err(RuntimeDurableEnvelopeError::JReplicaStateRoot(index));
        }
        canonical_value_from_tagged_json(&pair[1])?;
    }
    Ok(())
}

fn matching_j_replica_indexes(
    rows: &[Value],
    depository_address: &str,
    chain_id: u64,
) -> Result<Vec<usize>, RuntimeDurableEnvelopeError> {
    let mut matches = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or(RuntimeDurableEnvelopeError::JReplicaRow(index))?;
        let replica = object(&pair[1], "jReplica")?;
        let candidate_chain = optional_safe_u64(replica, "chainId")?;
        let candidate_address = replica
            .get("contracts")
            .and_then(Value::as_object)
            .and_then(|contracts| contracts.get("depository"))
            .and_then(Value::as_str)
            .map(str::trim);
        if candidate_chain == Some(chain_id)
            && candidate_address
                .is_some_and(|address| address.eq_ignore_ascii_case(depository_address))
        {
            matches.push(index);
        }
    }
    Ok(matches)
}

fn exact_fields(
    object: &Map<String, Value>,
    required_fields: &[&str],
    optional_fields: &[&str],
    path: &'static str,
) -> Result<(), RuntimeDurableEnvelopeError> {
    for field in required_fields {
        if !object.contains_key(*field) {
            return Err(RuntimeDurableEnvelopeError::Missing {
                path,
                field: (*field).into(),
            });
        }
    }
    if let Some(field) = object.keys().find(|field| {
        !required_fields.contains(&field.as_str()) && !optional_fields.contains(&field.as_str())
    }) {
        return Err(RuntimeDurableEnvelopeError::Unsupported {
            path,
            field: field.clone(),
        });
    }
    Ok(())
}

fn required<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a Value, RuntimeDurableEnvelopeError> {
    object
        .get(field)
        .ok_or_else(|| RuntimeDurableEnvelopeError::Missing {
            path: "machine",
            field: field.into(),
        })
}

fn string<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, RuntimeDurableEnvelopeError> {
    required(object, field)?
        .as_str()
        .ok_or_else(|| RuntimeDurableEnvelopeError::String(field.into()))
}

fn safe_u64(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<u64, RuntimeDurableEnvelopeError> {
    let value = required(object, field)?
        .as_u64()
        .ok_or(RuntimeDurableEnvelopeError::Number(field))?;
    if value > MAX_SAFE_INTEGER {
        return Err(RuntimeDurableEnvelopeError::Number(field));
    }
    Ok(value)
}

fn optional_safe_u64(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<u64>, RuntimeDurableEnvelopeError> {
    object
        .get(field)
        .map(|value| {
            value
                .as_u64()
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or(RuntimeDurableEnvelopeError::Number(field))
        })
        .transpose()
}

fn optional_boolean(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<bool>, RuntimeDurableEnvelopeError> {
    object
        .get(field)
        .map(|value| {
            value
                .as_bool()
                .ok_or(RuntimeDurableEnvelopeError::Boolean(field))
        })
        .transpose()
}

fn optional_finite_number(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<Number>, RuntimeDurableEnvelopeError> {
    object
        .get(field)
        .map(|value| {
            let number = value
                .as_number()
                .filter(|number| number.as_f64().is_some_and(|value| value >= 0.0))
                .ok_or(RuntimeDurableEnvelopeError::Number(field))?;
            Ok(number.clone())
        })
        .transpose()
}

fn finite_number(
    object: &Map<String, Value>,
    field: &'static str,
    nonnegative: bool,
) -> Result<Number, RuntimeDurableEnvelopeError> {
    let number = required(object, field)?
        .as_number()
        .filter(|number| {
            number
                .as_f64()
                .is_some_and(|value| !nonnegative || value >= 0.0)
        })
        .ok_or(RuntimeDurableEnvelopeError::Number(field))?;
    Ok(number.clone())
}

fn object<'a>(
    value: &'a Value,
    path: &'static str,
) -> Result<&'a Map<String, Value>, RuntimeDurableEnvelopeError> {
    value
        .as_object()
        .ok_or(RuntimeDurableEnvelopeError::Object(path))
}

fn canonical_hex(value: &str, bytes: usize) -> bool {
    value.len() == 2 + bytes * 2
        && value.starts_with("0x")
        && value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Error)]
pub enum RuntimeDurableEnvelopeError {
    #[error("RRS_RUNTIME_ENVELOPE_OBJECT:{0}")]
    Object(&'static str),
    #[error("RRS_RUNTIME_ENVELOPE_ARRAY:{0}")]
    Array(String),
    #[error("RRS_RUNTIME_ENVELOPE_STRING:{0}")]
    String(String),
    #[error("RRS_RUNTIME_ENVELOPE_MISSING:{path}:{field}")]
    Missing { path: &'static str, field: String },
    #[error("RRS_RUNTIME_ENVELOPE_UNSUPPORTED:{path}:{field}")]
    Unsupported { path: &'static str, field: String },
    #[error("RRS_RUNTIME_ENVELOPE_TRANSPORT_STATE:{0}")]
    TransportState(String),
    #[error("RRS_RUNTIME_ENVELOPE_RUNTIME_ID:{0}")]
    RuntimeId(String),
    #[error("RRS_RUNTIME_ENVELOPE_ACTIVE_JURISDICTION")]
    ActiveJurisdiction,
    #[error("RRS_RUNTIME_ENVELOPE_NUMBER:{0}")]
    Number(&'static str),
    #[error("RRS_RUNTIME_ENVELOPE_BOOLEAN:{0}")]
    Boolean(&'static str),
    #[error("RRS_RUNTIME_ENVELOPE_INFRASTRUCTURE_MAP:{0}")]
    InfrastructureMap(&'static str),
    #[error("RRS_RUNTIME_ENVELOPE_RADAPTER_COMMAND:{0}")]
    RuntimeAdapterCommand(String),
    #[error("RRS_RUNTIME_ENVELOPE_J_REPLICA_ROW:{0}")]
    JReplicaRow(usize),
    #[error("RRS_RUNTIME_ENVELOPE_J_REPLICA_NAME:{0}")]
    JReplicaName(usize),
    #[error("RRS_RUNTIME_ENVELOPE_J_REPLICA_BLOCK:{0}")]
    JReplicaBlock(usize),
    #[error("RRS_RUNTIME_ENVELOPE_J_REPLICA_STATE_ROOT:{0}")]
    JReplicaStateRoot(usize),
    #[error("J_WATCHER_JURISDICTION_NOT_FOUND:cursor-apply")]
    WatcherNotFound,
    #[error("J_WATCHER_JURISDICTION_AMBIGUOUS:cursor-apply")]
    WatcherAmbiguous,
    #[error("RRS_RUNTIME_ENVELOPE_LINEAGE")]
    Lineage,
    #[error(transparent)]
    Tagged(#[from] TaggedJsonError),
    #[error("RRS_RUNTIME_ENVELOPE_J_SUBMIT:{0}")]
    JSubmit(String),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map() -> Value {
        json!({"__xlnType":"Map","value":[]})
    }

    fn j(name: &str, block: &str) -> Value {
        json!({
            "blockDelayMs":300,"blockNumber":{"__xlnType":"BigInt","value":block},
            "blockTimeMs":10000,"chainId":31337,"contracts":{},
            "entityProviderDeploymentBlock":3,"lastBlockTimestamp":100,
            "mempool":[],"name":name,"position":{"x":0,"y":0,"z":0},
            "rpcs":[],"stateRoot":null,"watcherConfirmationDepth":0
        })
    }

    pub(super) fn fixture() -> Value {
        json!({
            "runtimeId": format!("0x{}", "11".repeat(20)),
            "activeJurisdiction":"Testnet",
            "runtimeConfig":{"loopIntervalMs":0,"minFrameDelayMs":5},
            "infrastructure":{
                "accountJClaimNodes":map(),"certifiedBoardNodes":map(),
                "certifiedRegistrationEvidence":map(),
                "entityEncryptionSeeds":map(),"runtimeAdapterCommandFrontiers":map()
            },
            "jReplicas":[["Testnet",j("Testnet","1")],["Tron",j("Tron","2")]]
        })
    }

    #[test]
    fn exact_machine_envelope_decodes_and_advances_only_from_expected_lineage() {
        let mut envelope = RuntimeDurableEnvelope::decode(&fixture(), [1; 32]).expect("envelope");
        assert_eq!(envelope.runtime_config().min_frame_delay_ms, 5);
        assert_eq!(
            envelope.runtime_config().value(),
            json!({"loopIntervalMs":0,"minFrameDelayMs":5}),
        );
        assert!(envelope.advance_frame_hash([2; 32], [3; 32]).is_err());
        envelope
            .advance_frame_hash([1; 32], [3; 32])
            .expect("lineage");
        assert_eq!(envelope.prev_frame_hash(), [3; 32]);
    }

    #[test]
    fn full_runtime_config_round_trips_only_through_typed_fields() {
        let mut machine = fixture();
        machine["runtimeConfig"] = json!({
            "loopIntervalMs": 1,
            "minFrameDelayMs": 2,
            "snapshotIntervalFrames": 3,
            "entityConsensusStateWarningBytes": 4,
            "advertiseProfileMirrors": false,
            "performance": {
                "maxCloneBytes": 5,
                "maxCloneMs": 1.25,
                "maxReducerMs": 2.5,
                "maxWalMs": 3.75,
            },
            "storage": {
                "enabled": true,
                "snapshotPeriodFrames": 6,
                "retainSnapshots": 7,
                "epochMaxBytes": 8,
                "materializePeriodFrames": 9,
                "canonicalHashPeriodFrames": 10,
                "accountMerkleRadix": 256,
            },
        });
        let decoded = RuntimeDurableEnvelope::decode(&machine, [0; 32]).expect("full config");
        assert_eq!(decoded.runtime_config().value(), machine["runtimeConfig"]);
    }

    #[test]
    fn runtime_config_without_frame_delay_is_rejected() {
        let mut machine = fixture();
        machine["runtimeConfig"] = json!({});
        assert!(matches!(
            RuntimeDurableEnvelope::decode(&machine, [0; 32]),
            Err(RuntimeDurableEnvelopeError::Missing { field, .. })
                if field == "minFrameDelayMs"
        ));
    }

    #[test]
    fn optional_infrastructure_maps_preserve_exact_absence() {
        let mut machine = fixture();
        machine["infrastructure"] = json!({
            "accountJClaimNodes": map(),
            "certifiedBoardNodes": map(),
            "entityEncryptionSeeds": map(),
        });
        let decoded = RuntimeDurableEnvelope::decode(&machine, [0; 32])
            .expect("optional infrastructure maps");
        assert_eq!(decoded.infrastructure(), &machine["infrastructure"]);
    }

    #[test]
    fn one_jurisdiction_with_optional_fields_absent_is_canonical() {
        let mut machine = fixture();
        machine["jReplicas"] = json!([["Testnet", {
            "blockDelayMs": 0.5,
            "blockNumber": {"__xlnType":"BigInt","value":"1"},
            "lastBlockTimestamp": 100,
            "mempool": [],
            "name": "Testnet",
            "position": {"x":-1.5,"y":0,"z":2.25},
            "stateRoot": null,
        }]]);
        let decoded =
            RuntimeDurableEnvelope::decode(&machine, [0; 32]).expect("single jurisdiction");
        assert_eq!(decoded.j_replicas(), &machine["jReplicas"]);
    }

    #[test]
    fn browser_and_nonempty_transport_state_are_rejected() {
        let mut browser = fixture();
        browser["browserVMState"] = json!({});
        assert!(matches!(
            RuntimeDurableEnvelope::decode(&browser, [0; 32]),
            Err(RuntimeDurableEnvelopeError::Unsupported { .. })
        ));
        let mut transport = fixture();
        transport["pendingOutputs"] = json!([{}]);
        assert!(matches!(
            RuntimeDurableEnvelope::decode(&transport, [0; 32]),
            Err(RuntimeDurableEnvelopeError::TransportState(_))
        ));
    }
}
