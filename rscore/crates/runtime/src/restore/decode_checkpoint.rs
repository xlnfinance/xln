//! One exact canonical checkpoint source -> live Runtime restore description.

use std::collections::BTreeSet;
use std::sync::Arc;

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_crypto::{address_of_private_key, derive_signer_key};
use xln_rscore_engine::{BoardDelays, SwapMarketPolicy};

use crate::{
    RuntimeDurableEnvelope, RuntimeDurableEnvelopeError, RuntimeLimits,
    entity_context_json::entity_context_policy_from_core,
};

use super::concrete_source::{verified_checkpoint_frame, verify_checkpoint_source};
use super::{
    AccountWireRestoreError, CertifiedBoardRegistryRestoreError, ConcreteCheckpointSource,
    ConcreteRestoreSourceError, DecodedRuntimeCheckpoint, EntityConsensusRestoreError,
    EntityGraphRestoreError, EntitySnapshotRestoreError, OrderbookGraphRestoreError,
    PathCheckpointRestoreError, decode_account_rows, entity_snapshot_from_graph,
    hydrate_certified_board_state, hydrate_entity_consensus, hydrate_entity_graph,
    hydrate_orderbook_graph, restore_orderbook_accounts, restore_path_checkpoint,
};

pub struct ConcreteCheckpointConfiguration {
    pub runtime_seed: String,
    /// Operator keyring label.  The persisted signer id is an address, not a
    /// derivation label; deriving from that address silently selects a
    /// different key.  Restore proves this label against canonical 0x26 before
    /// either Entity or Account receives the key.
    pub signer_derivation_label: String,
    pub worker_count: usize,
    pub limits: RuntimeLimits,
    pub swap_market: Arc<SwapMarketPolicy>,
    pub expected_protocol_fingerprint: [u8; 32],
    pub board_delays: BoardDelays,
}

/// Explicit authorization for the one-time, offline TypeScript-state import.
///
/// This is deliberately not a field on [`ConcreteCheckpointConfiguration`]:
/// ordinary restore must never silently accept a checkpoint that was not
/// committed by its signed Runtime frame.  The migration command constructs
/// this marker only after atomically projecting and verifying the canonical
/// 0x22/0x24/0x2f/0x30 graph into 0x17/0x18/0x19 rows.
#[derive(Clone, Copy, Debug)]
pub enum MigrationOrigin {
    OfflineTsImport,
}

#[derive(Debug, Error)]
pub enum ConcreteCheckpointDecodeError {
    #[error("RRS_RESTORE_CHECKPOINT_DECODE:{0}")]
    Invalid(String),
    #[error(transparent)]
    Source(#[from] ConcreteRestoreSourceError),
    #[error(transparent)]
    Path(#[from] PathCheckpointRestoreError),
    #[error(transparent)]
    Account(#[from] AccountWireRestoreError),
    #[error(transparent)]
    EntityGraph(#[from] EntityGraphRestoreError),
    #[error(transparent)]
    CertifiedBoard(#[from] CertifiedBoardRegistryRestoreError),
    #[error(transparent)]
    Orderbook(#[from] OrderbookGraphRestoreError),
    #[error(transparent)]
    EntitySnapshot(#[from] EntitySnapshotRestoreError),
    #[error(transparent)]
    EntityConsensus(#[from] EntityConsensusRestoreError),
    #[error(transparent)]
    Envelope(#[from] RuntimeDurableEnvelopeError),
    #[error(transparent)]
    EntityContext(#[from] crate::EntityContextJsonError),
    #[error(transparent)]
    EntityKernel(#[from] xln_rscore_entity_kernel::EntityKernelError),
}

fn invalid(detail: impl Into<String>) -> ConcreteCheckpointDecodeError {
    ConcreteCheckpointDecodeError::Invalid(detail.into())
}

fn hex_bytes(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    bytes.iter().fold(String::new(), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

fn derive_bound_signer_key(
    runtime_seed: &str,
    derivation_label: &str,
    expected_signer_id: &str,
) -> Result<[u8; 32], ConcreteCheckpointDecodeError> {
    if derivation_label.trim().is_empty() {
        return Err(invalid("SIGNER_DERIVATION_LABEL_EMPTY"));
    }
    let private_key = derive_signer_key(runtime_seed, derivation_label)
        .map_err(|error| invalid(format!("SIGNER_KEY_DERIVATION:{error}")))?;
    let address =
        address_of_private_key(&private_key).ok_or_else(|| invalid("SIGNER_KEY_ADDRESS"))?;
    let actual = format!("0x{}", hex_bytes(&address));
    if actual != expected_signer_id.trim().to_lowercase() {
        return Err(invalid(format!(
            "SIGNER_DERIVATION_ADDRESS:expected={}:actual={actual}",
            expected_signer_id.trim().to_lowercase(),
        )));
    }
    Ok(private_key)
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, ConcreteCheckpointDecodeError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn digest(value: &Value, path: &str) -> Result<[u8; 32], ConcreteCheckpointDecodeError> {
    let payload = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or_else(|| invalid(format!("DIGEST:{path}")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("DIGEST:{path}")))?;
    }
    Ok(output)
}

fn entity_text(owner: &[u8; 32]) -> String {
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in owner {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn exact_fields(
    object: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), ConcreteCheckpointDecodeError> {
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("FIELDS:{path}:{}", actual.join(","))))
    }
}

fn expected_entity_root(
    frame: &Map<String, Value>,
    owner: &[u8; 32],
) -> Result<[u8; 32], ConcreteCheckpointDecodeError> {
    let rows = frame
        .get("canonicalEntityHashes")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("CANONICAL_ENTITY_HASHES"))?;
    if rows.len() != 1 {
        return Err(invalid(format!("CANONICAL_ENTITY_COUNT:{}", rows.len())));
    }
    let row = object(&rows[0], "canonicalEntityHashes[0]")?;
    exact_fields(
        row,
        &["entityId", "hash", "cellCount"],
        "canonicalEntityHashes[0]",
    )?;
    if row.get("entityId").and_then(Value::as_str) != Some(entity_text(owner).as_str())
        || row.get("cellCount").and_then(Value::as_u64).is_none()
    {
        return Err(invalid("CANONICAL_ENTITY_OWNER"));
    }
    digest(
        row.get("hash")
            .ok_or_else(|| invalid("CANONICAL_ENTITY_HASH"))?,
        "canonicalEntityHashes.hash",
    )
}

fn tagged_bigint(value: &Value, path: &str) -> Result<BigInt, ConcreteCheckpointDecodeError> {
    let value = object(value, path)?;
    exact_fields(value, &["__xlnType", "value"], path)?;
    if value.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(invalid(format!("BIGINT:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("BIGINT:{path}")))?
        .parse::<BigInt>()
        .map_err(|_| invalid(format!("BIGINT:{path}")))
}

fn htlc_infrastructure_state(
    core: &Map<String, Value>,
) -> Result<(u32, BigInt), ConcreteCheckpointDecodeError> {
    let Some(config) = core.get("hubRebalanceConfig") else {
        return Ok((1, BigInt::from(0)));
    };
    let config = object(config, "hubRebalanceConfig")?;
    let routing_fee_ppm = config
        .get("routingFeePPM")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= 999_999)
        .ok_or_else(|| invalid("HUB_ROUTING_FEE_PPM"))?;
    let routing_base_fee = tagged_bigint(
        config
            .get("baseFee")
            .ok_or_else(|| invalid("HUB_ROUTING_BASE_FEE"))?,
        "hubRebalanceConfig.baseFee",
    )?;
    if routing_base_fee < BigInt::from(0) {
        return Err(invalid("HUB_ROUTING_BASE_FEE_NEGATIVE"));
    }
    Ok((routing_fee_ppm, routing_base_fee))
}

fn verify_native_checkpoint_frame(
    frame: &Map<String, Value>,
) -> Result<(), ConcreteCheckpointDecodeError> {
    // Account checkpoint rows are part of the one path-keyed checkpoint graph.
    // Their reconstructed accounts root is checked again through the Entity
    // consensus root below. A frame-level descriptor would be a second copy of
    // the same authority and is not emitted by the canonical production path.
    if frame.contains_key("accountAuthorityCheckpoints") {
        Err(invalid("NATIVE_ACCOUNT_CHECKPOINT_REF_FORBIDDEN"))
    } else {
        Ok(())
    }
}

fn verify_offline_import_rows(
    frame: &Map<String, Value>,
    rows: &std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
    stored: &crate::StoredRscoreCheckpoint,
) -> Result<(), ConcreteCheckpointDecodeError> {
    if frame.contains_key("accountAuthorityCheckpoints") {
        return Err(invalid("OFFLINE_IMPORT_FRAME_REF_PRESENT"));
    }
    let owner = stored.owner_entity_id;
    let rust_accounts = rows
        .keys()
        .filter(|key| key.first() == Some(&0x18) && key.get(1..33) == Some(owner.as_slice()))
        .map(|key| {
            key.get(33..65)
                .and_then(|value| <[u8; 32]>::try_from(value).ok())
                .ok_or_else(|| invalid("OFFLINE_IMPORT_RSCORE_ACCOUNT_KEY"))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let ts_accounts = rows
        .keys()
        .filter(|key| key.first() == Some(&0x22) && key.get(1..33) == Some(owner.as_slice()))
        .map(|key| {
            key.get(33..65)
                .and_then(|value| <[u8; 32]>::try_from(value).ok())
                .ok_or_else(|| invalid("OFFLINE_IMPORT_TS_ACCOUNT_KEY"))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if rust_accounts != ts_accounts || rust_accounts.len() != stored.account_count {
        return Err(invalid(format!(
            "OFFLINE_IMPORT_ACCOUNT_SET:rust={}:ts={}:stored={}",
            rust_accounts.len(),
            ts_accounts.len(),
            stored.account_count,
        )));
    }
    for key in rows
        .keys()
        .filter(|key| matches!(key.first(), Some(0x24 | 0x2f | 0x30)))
    {
        if key.get(1..33) != Some(owner.as_slice()) {
            return Err(invalid("OFFLINE_IMPORT_FOREIGN_TS_ACCOUNT_OWNER"));
        }
        let account = key
            .get(33..65)
            .and_then(|value| <[u8; 32]>::try_from(value).ok())
            .ok_or_else(|| invalid("OFFLINE_IMPORT_TS_ACCOUNT_PATH_KEY"))?;
        if !ts_accounts.contains(&account) {
            return Err(invalid("OFFLINE_IMPORT_TS_ACCOUNT_PATH_ORPHAN"));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum AccountCheckpointBinding {
    SignedRuntimeFrame,
    OfflineTsImport,
}

/// Decode every canonical checkpoint graph beside the live process. The
/// returned value is still inert; `restore_decoded_runtime_checkpoint` is the
/// single point that installs Account shards and the Entity/Runtime replica.
fn decode_checkpoint(
    source: ConcreteCheckpointSource,
    configuration: ConcreteCheckpointConfiguration,
    binding: AccountCheckpointBinding,
) -> Result<DecodedRuntimeCheckpoint, ConcreteCheckpointDecodeError> {
    let machine = verify_checkpoint_source(&source)?;
    let (frame_value, validated_frame) = verified_checkpoint_frame(&source)?;
    let frame = object(&frame_value, "frame")?;
    let graph = hydrate_entity_graph(&source.state_rows)?;
    let hydrated_certified_board = hydrate_certified_board_state(&source.state_rows, &graph)?;
    let owner = graph.entity_id;
    let (stored_accounts, metadata) = restore_path_checkpoint(&source.state_rows, owner)?;
    match binding {
        AccountCheckpointBinding::SignedRuntimeFrame => {
            verify_native_checkpoint_frame(frame)?;
        }
        AccountCheckpointBinding::OfflineTsImport => {
            verify_offline_import_rows(frame, &source.state_rows, &stored_accounts)?;
        }
    }
    let expected_entity_root = expected_entity_root(frame, &owner)?;
    let account_rows = decode_account_rows(&stored_accounts.accounts)?;
    let known_accounts = account_rows
        .iter()
        .map(|row| format!("0x{}", row.account_id))
        .collect::<BTreeSet<_>>();
    let restored_orderbook_accounts = restore_orderbook_accounts(&account_rows);
    let core = object(&graph.core, "entity.core")?;
    let (htlc_routing_fee_ppm, htlc_routing_base_fee) = htlc_infrastructure_state(core)?;
    let active_jurisdiction = machine
        .as_object()
        .and_then(|value| value.get("activeJurisdiction"));
    let entity_context_policy = entity_context_policy_from_core(&graph.core, active_jurisdiction)?;
    let orderbook = hydrate_orderbook_graph(
        &source.state_rows,
        &owner,
        core,
        restored_orderbook_accounts,
    )?;
    let mut entity_snapshot = entity_snapshot_from_graph(
        &graph,
        known_accounts,
        stored_accounts.accounts_root,
        orderbook,
    )?;
    match entity_snapshot.certified_board_state.as_mut() {
        Some(state) => state.restore_records(hydrated_certified_board.records)?,
        None if hydrated_certified_board.records.is_empty() => {}
        None => return Err(invalid("CERTIFIED_BOARD_RECORDS_WITHOUT_STATE")),
    }
    let certified_board_registry = hydrated_certified_board.registry;
    let signer_private_key = derive_bound_signer_key(
        &configuration.runtime_seed,
        &configuration.signer_derivation_label,
        &metadata.signer_id,
    )?;
    let (entity_consensus, entity_signer) = hydrate_entity_consensus(
        &graph,
        &metadata,
        signer_private_key,
        configuration.board_delays,
    )?;
    let durable_envelope = RuntimeDurableEnvelope::decode(&machine, validated_frame.frame_hash)?;
    // A same-engine restart retains its operator persistence cadence. During
    // the explicit offline TS -> Rust ownership transfer, the supplied native
    // limits are the new operator configuration: inheriting the bootstrap's
    // period=1 would rebuild and fsync the entire checkpoint graph every live
    // frame. Cadence changes no financial state or frame ordering.
    let mut limits = configuration.limits;
    if matches!(binding, AccountCheckpointBinding::SignedRuntimeFrame) {
        if let Some(period) = durable_envelope
            .runtime_config()
            .materialize_period_frames()
        {
            limits.checkpoint_period_frames = period;
        }
        if let Some(period) = durable_envelope
            .runtime_config()
            .canonical_hash_period_frames()
        {
            limits.canonical_hash_period_frames = period;
        }
    }
    Ok(DecodedRuntimeCheckpoint {
        runtime_seed: configuration.runtime_seed,
        runtime_height: source.height,
        runtime_timestamp: validated_frame.timestamp,
        durable_envelope,
        expected_protocol_fingerprint: configuration.expected_protocol_fingerprint,
        stored_accounts,
        entity_snapshot,
        entity_consensus,
        entity_signer,
        certified_board_registry,
        entity_context_policy,
        htlc_routing_fee_ppm,
        htlc_routing_base_fee,
        replica_metadata: metadata.value,
        expected_entity_root,
        signer_private_key,
        signer_id: metadata.signer_id,
        worker_count: configuration.worker_count,
        limits,
        swap_market: configuration.swap_market,
    })
}

/// Decode the canonical production checkpoint path.  A signed Runtime-frame
/// Account checkpoint reference is mandatory here.
pub fn decode_concrete_runtime_checkpoint(
    source: ConcreteCheckpointSource,
    configuration: ConcreteCheckpointConfiguration,
) -> Result<DecodedRuntimeCheckpoint, ConcreteCheckpointDecodeError> {
    decode_checkpoint(
        source,
        configuration,
        AccountCheckpointBinding::SignedRuntimeFrame,
    )
}

/// Decode one explicitly migrated TypeScript checkpoint.  The migration
/// command already projected the legacy path-keyed Account graph atomically;
/// this entry point proves that the old and new account key sets are exact and
/// leaves the cryptographic leaf/forest/signer checks to `restore_exact` plus
/// the enclosing certified Entity-root assertion.
pub fn decode_offline_ts_import_checkpoint(
    source: ConcreteCheckpointSource,
    configuration: ConcreteCheckpointConfiguration,
    origin: MigrationOrigin,
) -> Result<DecodedRuntimeCheckpoint, ConcreteCheckpointDecodeError> {
    match origin {
        MigrationOrigin::OfflineTsImport => decode_checkpoint(
            source,
            configuration,
            AccountCheckpointBinding::OfflineTsImport,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signer_derivation_label_must_recover_persisted_signer_id() {
        let seed = "0x0123456789abcdef";
        let owner_key = derive_signer_key(seed, "owner").expect("owner key");
        let owner_address = address_of_private_key(&owner_key).expect("owner address");
        let signer_id = format!("0x{}", hex_bytes(&owner_address));
        assert_eq!(
            derive_bound_signer_key(seed, "owner", &signer_id).expect("bound owner"),
            owner_key,
        );
        let error = derive_bound_signer_key(seed, "wrong-label", &signer_id)
            .expect_err("wrong label must not bind persisted signer");
        assert!(error.to_string().contains("SIGNER_DERIVATION_ADDRESS"));
    }

    fn imported(owner: [u8; 32]) -> crate::StoredRscoreCheckpoint {
        crate::StoredRscoreCheckpoint {
            owner_entity_id: owner,
            protocol_fingerprint: [1; 32],
            base_revision: 0,
            revision: 0,
            accounts_root: [2; 32],
            signer_digest: [3; 32],
            account_count: 1,
            accounts: Vec::new(),
        }
    }

    fn key(tag: u8, owner: [u8; 32], account: [u8; 32], suffix: &[u8]) -> Vec<u8> {
        [vec![tag], owner.to_vec(), account.to_vec(), suffix.to_vec()].concat()
    }

    #[test]
    fn offline_import_requires_exact_ts_and_rust_account_sets() {
        let owner = [0x11; 32];
        let account = [0x22; 32];
        let stored = imported(owner);
        let mut rows = std::collections::BTreeMap::from([
            (key(0x18, owner, account, &[]), vec![]),
            (key(0x22, owner, account, &[]), vec![]),
            (key(0x24, owner, account, &[1]), vec![]),
            (key(0x2f, owner, account, &[1, 0]), vec![]),
            (key(0x30, owner, account, &[1, 1]), vec![]),
        ]);
        verify_offline_import_rows(&Map::new(), &rows, &stored)
            .expect("one exact TS/Rust account set");

        rows.insert(key(0x30, owner, [0x33; 32], &[1, 1]), vec![]);
        let error = verify_offline_import_rows(&Map::new(), &rows, &stored)
            .expect_err("orphan TS Account path must fail");
        assert!(
            error
                .to_string()
                .contains("OFFLINE_IMPORT_TS_ACCOUNT_PATH_ORPHAN")
        );
    }

    #[test]
    fn offline_import_never_accepts_a_signed_native_checkpoint_as_migration() {
        let owner = [0x11; 32];
        let account = [0x22; 32];
        let rows = std::collections::BTreeMap::from([
            (key(0x18, owner, account, &[]), vec![]),
            (key(0x22, owner, account, &[]), vec![]),
        ]);
        let frame = Map::from_iter([("accountAuthorityCheckpoints".into(), Value::Array(vec![]))]);
        let error = verify_offline_import_rows(&frame, &rows, &imported(owner))
            .expect_err("signed native frame belongs to normal restore");
        assert!(
            error
                .to_string()
                .contains("OFFLINE_IMPORT_FRAME_REF_PRESENT")
        );
    }

    #[test]
    fn native_checkpoint_uses_only_the_path_keyed_account_graph() {
        verify_native_checkpoint_frame(&Map::new()).expect("canonical native frame has no sidecar");
        let frame = Map::from_iter([("accountAuthorityCheckpoints".into(), Value::Array(vec![]))]);
        let error = verify_native_checkpoint_frame(&frame)
            .expect_err("a second Account checkpoint descriptor is forbidden");
        assert!(
            error
                .to_string()
                .contains("NATIVE_ACCOUNT_CHECKPOINT_REF_FORBIDDEN")
        );
    }
}
