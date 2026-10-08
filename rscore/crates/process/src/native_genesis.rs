//! Deterministic fresh native Runtime construction.
//!
//! Genesis is operator configuration, not an imported TypeScript snapshot and
//! not a synthetic Runtime frame. The first accepted Runtime input writes the
//! first native checkpoint through the ordinary production commit path.

use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::time::Instant;

use num_bigint::BigInt;
use serde_json::{Map, Value};
use xln_rscore_engine::{BoardDelays, SigningIdentity, derive_signer_address, derive_signer_key};
use xln_rscore_entity_kernel::{
    ConsensusMode, EntityConsensusConfig, EntityFrameAuthority, EntityLeaderState, EntityProfile,
    EntityStateSlice,
};
use xln_rscore_protocol::CanonicalValue;
use xln_rscore_runtime::processor::{EntityRouteTable, RuntimeDurableEnvelope};
use xln_rscore_runtime::storage::native::{NativeRuntimeStore, NativeStorageConfig};
use xln_rscore_runtime::{
    DurableRuntimeProcessor, RuntimeEntityKey, RuntimeLimits, RuntimeReplica, RuntimeSignerLabel,
    RuntimeState, canonical_value_from_tagged_json,
};

use crate::PAYMENT_PROFILE_BINDING;
use crate::native_runtime::NativeRuntimeReady;

#[derive(Clone, Copy)]
enum GenesisPublication {
    WebSocket,
    #[cfg(feature = "bench")]
    ValidateOnly,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeGenesisEntity {
    pub signer_label: String,
    pub entity_authority_jurisdiction: Option<CanonicalValue>,
    pub entity_profile: EntityProfile,
    pub entity_encryption_public_key: [u8; 32],
    pub htlc_routing_fee_ppm: u32,
    pub htlc_routing_base_fee: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeGenesisConfig {
    pub timestamp: u64,
    pub machine: Value,
    pub entities: Vec<NativeGenesisEntity>,
}

impl NativeGenesisConfig {
    pub fn read(path: impl AsRef<Path>) -> Result<Self, String> {
        let bytes = std::fs::read(path.as_ref())
            .map_err(|error| format!("RRS_NATIVE_GENESIS_READ:{error}"))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_JSON:{error}"))?;
        Self::decode(&value)
    }
    pub fn validate_owner_labels(&self, primary_label: &str) -> Result<(), String> {
        let durable = RuntimeDurableEnvelope::decode(&self.machine, [0; 32])
            .map_err(|error| format!("RRS_NATIVE_GENESIS_MACHINE:{error}"))?;
        let mut expected = std::collections::BTreeSet::from([primary_label.to_owned()]);
        for row in durable
            .j_replicas()
            .as_array()
            .expect("validated J inventory")
        {
            let name = row[0].as_str().expect("validated J name");
            if Some(name) != durable.active_jurisdiction() {
                expected.insert(format!("{primary_label}:{name}"));
            }
        }
        let actual = self
            .entities
            .iter()
            .map(|owner| owner.signer_label.clone())
            .collect::<std::collections::BTreeSet<_>>();
        if actual != expected
            || self
                .entities
                .first()
                .map(|owner| owner.signer_label.as_str())
                != Some(primary_label)
        {
            return Err("RRS_NATIVE_GENESIS_J_OWNER_INVENTORY_MISMATCH".into());
        }
        Ok(())
    }
    pub fn decode(value: &Value) -> Result<Self, String> {
        let root = object(value, "ROOT")?;
        exact_fields(root, &["timestamp", "machine", "entities"], "ROOT")?;
        let entities = required(root, "entities", "ROOT")?
            .as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or("RRS_NATIVE_GENESIS_ENTITIES")?
            .iter()
            .map(NativeGenesisEntity::decode)
            .collect::<Result<Vec<_>, _>>()?;
        let mut labels = std::collections::BTreeSet::new();
        if entities
            .iter()
            .any(|entity| !labels.insert(entity.signer_label.clone()))
        {
            return Err("RRS_NATIVE_GENESIS_DUPLICATE_SIGNER_LABEL".into());
        }
        Ok(Self {
            timestamp: safe_u64(required(root, "timestamp", "ROOT")?, "TIMESTAMP")?,
            machine: required(root, "machine", "ROOT")?.clone(),
            entities,
        })
    }
}

impl NativeGenesisEntity {
    fn decode(value: &Value) -> Result<Self, String> {
        let root = object(value, "ENTITY")?;
        exact_fields(
            root,
            &[
                "signerLabel",
                "entityAuthorityJurisdiction",
                "entityProfile",
                "entityEncryptionPublicKey",
                "htlcRoutingFeePpm",
                "htlcRoutingBaseFee",
            ],
            "ENTITY",
        )?;
        let signer_label = required(root, "signerLabel", "ENTITY")?
            .as_str()
            .filter(|label| !label.trim().is_empty() && label.trim() == *label)
            .ok_or("RRS_NATIVE_GENESIS_SIGNER_LABEL")?
            .to_owned();
        let entity_authority_jurisdiction =
            match required(root, "entityAuthorityJurisdiction", "ROOT")? {
                Value::Null => None,
                value => Some(
                    canonical_value_from_tagged_json(value)
                        .map_err(|error| format!("RRS_NATIVE_GENESIS_JURISDICTION:{error}"))?,
                ),
            };
        let entity_profile = decode_entity_profile(required(root, "entityProfile", "ROOT")?)?;
        let entity_encryption_public_key = decode_hex32(
            required(root, "entityEncryptionPublicKey", "ROOT")?,
            "ENTITY_ENCRYPTION_PUBLIC_KEY",
        )?;
        let htlc_routing_fee_ppm = u32::try_from(safe_u64(
            required(root, "htlcRoutingFeePpm", "ROOT")?,
            "HTLC_ROUTING_FEE_PPM",
        )?)
        .map_err(|_| "RRS_NATIVE_GENESIS_HTLC_ROUTING_FEE_PPM".to_string())?;
        let htlc_routing_base_fee = required(root, "htlcRoutingBaseFee", "ROOT")?
            .as_str()
            .and_then(|value| BigInt::from_str(value).ok())
            .filter(|value| value.sign() != num_bigint::Sign::Minus)
            .ok_or_else(|| "RRS_NATIVE_GENESIS_HTLC_ROUTING_BASE_FEE".to_string())?;
        Ok(Self {
            signer_label,
            entity_authority_jurisdiction,
            entity_profile,
            entity_encryption_public_key,
            htlc_routing_fee_ppm,
            htlc_routing_base_fee,
        })
    }
}

fn decode_entity_profile(value: &Value) -> Result<EntityProfile, String> {
    let profile = object(value, "ENTITY_PROFILE")?;
    exact_fields(
        profile,
        &[
            "name",
            "isHub",
            "entityKind",
            "sectors",
            "avatar",
            "bio",
            "website",
        ],
        "ENTITY_PROFILE",
    )?;
    let string = |field: &str| {
        required(profile, field, "ENTITY_PROFILE")?
            .as_str()
            .filter(|value| value.len() <= 2_048)
            .map(str::to_owned)
            .ok_or_else(|| format!("RRS_NATIVE_GENESIS_ENTITY_PROFILE_{field}"))
    };
    let name = string("name")?;
    if name.trim() != name || name.is_empty() || name.len() > 256 {
        return Err("RRS_NATIVE_GENESIS_ENTITY_PROFILE_NAME".into());
    }
    let entity_kind = match required(profile, "entityKind", "ENTITY_PROFILE")? {
        Value::Null => None,
        Value::String(value)
            if [
                "company",
                "foundation",
                "government",
                "nonprofit",
                "person",
                "protocol",
            ]
            .contains(&value.as_str()) =>
        {
            Some(value.clone())
        }
        _ => return Err("RRS_NATIVE_GENESIS_ENTITY_PROFILE_KIND".into()),
    };
    let sectors = required(profile, "sectors", "ENTITY_PROFILE")?
        .as_array()
        .filter(|values| values.len() <= 4)
        .ok_or_else(|| "RRS_NATIVE_GENESIS_ENTITY_PROFILE_SECTORS".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| value.len() <= 32)
                .map(str::to_owned)
                .ok_or_else(|| "RRS_NATIVE_GENESIS_ENTITY_PROFILE_SECTOR".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if sectors.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err("RRS_NATIVE_GENESIS_ENTITY_PROFILE_SECTORS_ORDER".into());
    }
    Ok(EntityProfile {
        name,
        is_hub: required(profile, "isHub", "ENTITY_PROFILE")?
            .as_bool()
            .ok_or_else(|| "RRS_NATIVE_GENESIS_ENTITY_PROFILE_IS_HUB".to_string())?,
        entity_kind,
        sectors,
        avatar: string("avatar")?,
        bio: string("bio")?,
        website: string("website")?,
    })
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{path}_OBJECT"))
}

fn required<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<&'a Value, String> {
    object
        .get(field)
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{path}_MISSING:{field}"))
}

fn exact_fields(object: &Map<String, Value>, fields: &[&str], path: &str) -> Result<(), String> {
    if object.len() != fields.len() || !fields.iter().all(|field| object.contains_key(*field)) {
        return Err(format!("RRS_NATIVE_GENESIS_{path}_FIELDS"));
    }
    Ok(())
}

fn safe_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{field}"))
}

fn decode_hex32(value: &Value, field: &str) -> Result<[u8; 32], String> {
    let value = value
        .as_str()
        .filter(|value| value.starts_with("0x") && value.len() == 66)
        .filter(|value| *value == value.to_ascii_lowercase())
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{field}"))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2 + 2..index * 2 + 4], 16)
            .map_err(|_| format!("RRS_NATIVE_GENESIS_{field}"))?;
    }
    Ok(output)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::from("0x"), |mut value, byte| {
        let _ = write!(value, "{byte:02x}");
        value
    })
}

fn expected_runtime_id(runtime_seed: &str, runtime_signer_label: &str) -> Result<String, String> {
    derive_signer_address(runtime_seed, runtime_signer_label)
        .map(|address| hex(&address))
        .map_err(|error| format!("RRS_NATIVE_GENESIS_RUNTIME_ID:{error}"))
}

#[allow(clippy::too_many_arguments)]
pub fn create_native_genesis_runtime_processor(
    native_database: impl AsRef<Path>,
    genesis: NativeGenesisConfig,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_label: &str,
    workers: usize,
    routes: EntityRouteTable,
) -> Result<NativeRuntimeReady, String> {
    create_native_genesis_processor(
        native_database,
        genesis,
        runtime_seed,
        runtime_signer_label,
        entity_signer_label,
        workers,
        routes,
        GenesisPublication::WebSocket,
    )
}

#[cfg(feature = "bench")]
#[allow(clippy::too_many_arguments)]
pub fn create_native_genesis_replay_processor(
    native_database: impl AsRef<Path>,
    genesis: NativeGenesisConfig,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_label: &str,
    workers: usize,
    routes: EntityRouteTable,
) -> Result<NativeRuntimeReady, String> {
    create_native_genesis_processor(
        native_database,
        genesis,
        runtime_seed,
        runtime_signer_label,
        entity_signer_label,
        workers,
        routes,
        GenesisPublication::ValidateOnly,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_native_genesis_processor(
    native_database: impl AsRef<Path>,
    genesis: NativeGenesisConfig,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_label: &str,
    workers: usize,
    routes: EntityRouteTable,
    publication: GenesisPublication,
) -> Result<NativeRuntimeReady, String> {
    let started = Instant::now();
    if runtime_seed.is_empty() || entity_signer_label.trim().is_empty() || workers == 0 {
        return Err("RRS_NATIVE_GENESIS_ARGUMENTS".into());
    }
    genesis.validate_owner_labels(entity_signer_label)?;
    let limits = RuntimeLimits::hlt();
    let mut store = NativeRuntimeStore::open(
        native_database,
        NativeStorageConfig {
            checkpoint_period_frames: limits.checkpoint_period_frames,
            ..NativeStorageConfig::default()
        },
    )
    .map_err(|error| format!("RRS_NATIVE_GENESIS_OPEN:{error}"))?;
    if !store
        .is_pristine()
        .map_err(|error| format!("RRS_NATIVE_GENESIS_STORE:{error}"))?
    {
        return Err("RRS_NATIVE_GENESIS_STORE_NOT_PRISTINE".into());
    }

    let durable = RuntimeDurableEnvelope::decode(&genesis.machine, [0; 32])
        .map_err(|error| format!("RRS_NATIVE_GENESIS_MACHINE:{error}"))?;
    let runtime_id = expected_runtime_id(runtime_seed, runtime_signer_label)?;
    if durable.runtime_id() != runtime_id {
        return Err(format!(
            "RRS_NATIVE_GENESIS_RUNTIME_ID_MISMATCH:expected={runtime_id}:actual={}",
            durable.runtime_id()
        ));
    }
    if genesis
        .entities
        .first()
        .map(|owner| owner.signer_label.as_str())
        != Some(entity_signer_label)
    {
        return Err("RRS_NATIVE_GENESIS_PRIMARY_SIGNER_LABEL".into());
    }
    let mut states = BTreeMap::new();
    let mut replicas = BTreeMap::new();
    let mut htlc_routing_fees = BTreeMap::new();
    for owner in &genesis.entities {
        let (key, state, replica) =
            create_genesis_entity(owner, runtime_seed, genesis.timestamp, workers)?;
        if states.insert(key.clone(), state).is_some() {
            return Err("RRS_NATIVE_GENESIS_DUPLICATE_ENTITY".into());
        }
        replicas.insert(key.clone(), replica);
        htlc_routing_fees.insert(
            key,
            (
                owner.htlc_routing_fee_ppm,
                owner.htlc_routing_base_fee.clone(),
            ),
        );
    }
    let replica = RuntimeReplica::from_entity_slots(
        RuntimeState {
            height: 0,
            timestamp: genesis.timestamp,
            finalized_j_height: 0,
            e_replicas: states,
        },
        durable,
        replicas,
        runtime_seed.to_owned(),
        limits,
    )
    .map_err(|error| format!("RRS_NATIVE_GENESIS_REPLICA:{error}"))?;
    let signer = RuntimeSignerLabel::new(runtime_signer_label)
        .map_err(|error| format!("RRS_NATIVE_GENESIS_RUNTIME_SIGNER:{error}"))?;
    let mut processor = match publication {
        GenesisPublication::WebSocket => {
            DurableRuntimeProcessor::new(replica, store, routes, runtime_seed, signer)
        }
        #[cfg(feature = "bench")]
        GenesisPublication::ValidateOnly => DurableRuntimeProcessor::new_replay_validate_only(
            replica,
            store,
            routes,
            runtime_seed,
            signer,
        ),
    }
    .map_err(|error| format!("RRS_NATIVE_GENESIS_PROCESSOR:{error}"))?;
    // Genesis and checkpoint restore must expose the same existing operator custody.
    // Only configured local owners enter this live keyring; no key is persisted or projected.
    for owner in &genesis.entities {
        let key = derive_signer_key(runtime_seed, &owner.signer_label)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_KEY:{error}"))?;
        let signer = hex(&derive_signer_address(runtime_seed, &owner.signer_label)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_SIGNER:{error}"))?);
        processor.install_custody_key(&signer, key)?;
    }

    Ok(NativeRuntimeReady {
        processor,
        restore_elapsed: started.elapsed(),
        restored_wal_frames: 0,
        htlc_routing_fees,
    })
}

/// A restarted database must already contain exactly the configured sovereign
/// owners. Never append a newly configured owner behind the accepted WAL.
pub fn validate_native_owner_inventory(
    genesis: &NativeGenesisConfig,
    replica: &RuntimeReplica,
    runtime_seed: &str,
    custody_owner: Option<&RuntimeEntityKey>,
) -> Result<(), String> {
    let mut expected = BTreeMap::new();
    for owner in &genesis.entities {
        let signer = hex(&derive_signer_address(runtime_seed, &owner.signer_label)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_SIGNER:{error}"))?);
        let key = derive_signer_key(runtime_seed, &owner.signer_label)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_KEY:{error}"))?;
        let identity = SigningIdentity::lazy_from_key(key, &signer, 1, 1, BoardDelays::default())
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_ID:{error}"))?;
        let key = RuntimeEntityKey::new(*identity.entity_id(), &signer)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_OWNER_KEY:{error}"))?;
        if expected.insert(key, owner).is_some() {
            return Err("RRS_NATIVE_GENESIS_DUPLICATE_ENTITY".into());
        }
    }
    let mut expected_keys = expected
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if let Some(owner) = custody_owner {
        // Caller derives this exact lazy Entity/signer from verified private custody.
        // A persisted file without its import is the supported crash-gap case.
        if replica.state.e_replicas.contains_key(owner) {
            expected_keys.insert(owner.clone());
        }
    }
    if expected_keys.iter().ne(replica.state.e_replicas.keys())
        || expected_keys.iter().ne(replica.e_replicas.keys())
    {
        return Err(format!(
            "RRS_NATIVE_GENESIS_OWNER_INVENTORY_MISMATCH:expected={}:actual={}",
            expected.len(),
            replica.state.e_replicas.len()
        ));
    }
    for (key, owner) in expected {
        if replica.e_replicas[&key]
            .entity_consensus
            .state
            .authority
            .config
            .jurisdiction
            != owner.entity_authority_jurisdiction
            || replica.state.e_replicas[&key]
                .entity
                .entity_encryption_public_key
                != owner.entity_encryption_public_key
        {
            return Err(format!(
                "RRS_NATIVE_GENESIS_OWNER_AUTHORITY_MISMATCH:{}",
                key.replica_id()
            ));
        }
    }
    Ok(())
}

fn create_genesis_entity(
    owner: &NativeGenesisEntity,
    runtime_seed: &str,
    timestamp: u64,
    workers: usize,
) -> Result<
    (
        RuntimeEntityKey,
        xln_rscore_runtime::RuntimeEntityState,
        xln_rscore_runtime::RuntimeEntityReplica,
    ),
    String,
> {
    let private_key = derive_signer_key(runtime_seed, &owner.signer_label)
        .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_KEY:{error}"))?;
    let signer_id = hex(&derive_signer_address(runtime_seed, &owner.signer_label)
        .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_SIGNER:{error}"))?);
    let identity =
        SigningIdentity::lazy_from_key(private_key, &signer_id, 1, 1, BoardDelays::default())
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_ID:{error}"))?;
    let entity_id = *identity.entity_id();
    let entity_id_text = hex(&entity_id);
    let authority = EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![signer_id.clone()],
            shares: BTreeMap::from([(signer_id.clone(), 1)]),
            jurisdiction: owner.entity_authority_jurisdiction.clone(),
        },
        leader_state: EntityLeaderState {
            active_validator_id: signer_id.clone(),
            view: 0,
            changed_at_height: 0,
        },
    }
    .validate_and_normalize()
    .map_err(|error| format!("RRS_NATIVE_GENESIS_AUTHORITY:{error}"))?;
    let mut entity = EntityStateSlice::empty(entity_id_text, timestamp);
    entity.profile = owner.entity_profile.clone();
    entity.entity_encryption_public_key = owner.entity_encryption_public_key;
    xln_rscore_runtime::create_entity_genesis_slot(
        entity,
        authority,
        private_key,
        signer_id,
        workers,
        PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        0,
    )
}

pub fn native_store_is_pristine(path: impl AsRef<Path>) -> Result<bool, String> {
    let mut store = NativeRuntimeStore::open(path, NativeStorageConfig::default())
        .map_err(|error| format!("RRS_NATIVE_GENESIS_PROBE_OPEN:{error}"))?;
    store
        .is_pristine()
        .map_err(|error| format!("RRS_NATIVE_GENESIS_PROBE:{error}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::NativeGenesisConfig;

    #[test]
    fn genesis_config_rejects_unknown_and_negative_financial_fields() {
        let mut value = json!({
            "timestamp": 0,
            "machine": {},
            "entities":[{ "signerLabel":"entity",
            "entityAuthorityJurisdiction": null,
            "entityProfile": {
                "name": "H1",
                "isHub": true,
                "entityKind": "protocol",
                "sectors": ["finance", "infrastructure"],
                "avatar": "",
                "bio": "",
                "website": ""
            },
            "entityEncryptionPublicKey": format!("0x{}", "11".repeat(32)),
            "htlcRoutingFeePpm": 1,
            "htlcRoutingBaseFee": "0" }]
        });
        assert!(NativeGenesisConfig::decode(&value).is_ok());
        value["unknown"] = json!(true);
        assert_eq!(
            NativeGenesisConfig::decode(&value).unwrap_err(),
            "RRS_NATIVE_GENESIS_ROOT_FIELDS"
        );
        value.as_object_mut().expect("object").remove("unknown");
        value["entities"][0]["htlcRoutingBaseFee"] = json!("-1");
        assert_eq!(
            NativeGenesisConfig::decode(&value).unwrap_err(),
            "RRS_NATIVE_GENESIS_HTLC_ROUTING_BASE_FEE"
        );
    }
}

#[cfg(test)]
#[path = "tests/native_genesis_multi_tests.rs"]
mod multi_tests;

#[cfg(test)]
#[path = "tests/native_custody_tests.rs"]
mod custody_tests;
