//! Deterministic fresh native Runtime construction.
//!
//! Genesis is operator configuration, not an imported TypeScript snapshot and
//! not a synthetic Runtime frame. The first accepted Runtime input writes the
//! first native checkpoint through the ordinary production commit path.

use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use num_bigint::BigInt;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use xln_rscore_batch::{EngineGeneration, ResidentConsensusEngine};
use xln_rscore_engine::{BoardDelays, SigningIdentity, derive_signer_address, derive_signer_key};
use xln_rscore_entity_kernel::{
    ConsensusMode, EntityConsensusConfig, EntityConsensusState, EntityFrameAuthority,
    EntityLeaderState, EntityProfile, EntitySingleSigner, EntityStateSlice,
    ResidentEntityConsensusReplica,
};
use xln_rscore_protocol::CanonicalValue;
use xln_rscore_runtime::processor::{EntityRouteTable, RuntimeDurableEnvelope};
use xln_rscore_runtime::storage::native::{NativeRuntimeStore, NativeStorageConfig};
use xln_rscore_runtime::{
    DurableRuntimeProcessor, RuntimeEntityKey, RuntimeLimits, RuntimeReplica, RuntimeSignerLabel,
    RuntimeState, canonical_swap_market_policy, canonical_value_from_tagged_json,
};

use crate::PAYMENT_PROFILE_BINDING;
use crate::native_runtime::{NativeEntityRuntimeReady, NativeRuntimeReady};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeGenesisConfig {
    pub timestamp: u64,
    pub machine: Value,
    pub entities: Vec<NativeGenesisEntityConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeGenesisEntityConfig {
    pub signer_label: String,
    pub primary: bool,
    pub authority_jurisdiction: Option<CanonicalValue>,
    pub context_policy: Value,
    pub profile: EntityProfile,
    pub encryption_public_key: [u8; 32],
    pub htlc_routing_fee_ppm: u32,
    pub htlc_routing_base_fee: BigInt,
}

impl NativeGenesisConfig {
    pub fn read(path: impl AsRef<Path>) -> Result<Self, String> {
        let bytes = std::fs::read(path.as_ref())
            .map_err(|error| format!("RRS_NATIVE_GENESIS_READ:{error}"))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_JSON:{error}"))?;
        Self::decode(&value)
    }

    pub fn decode(value: &Value) -> Result<Self, String> {
        let root = object(value, "ROOT")?;
        exact_fields(root, &["timestamp", "machine", "entities"], "ROOT")?;
        let timestamp = safe_u64(required(root, "timestamp", "ROOT")?, "TIMESTAMP")?;
        let machine = required(root, "machine", "ROOT")?.clone();
        let rows = required(root, "entities", "ROOT")?
            .as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or_else(|| "RRS_NATIVE_GENESIS_ENTITIES".to_string())?;
        let mut entities = Vec::with_capacity(rows.len());
        let mut signer_labels = std::collections::BTreeSet::new();
        for (index, value) in rows.iter().enumerate() {
            let entity = decode_entity_config(value, index)?;
            if !signer_labels.insert(entity.signer_label.clone()) {
                return Err(format!(
                    "RRS_NATIVE_GENESIS_ENTITY_SIGNER_DUPLICATE:{}",
                    entity.signer_label
                ));
            }
            entities.push(entity);
        }
        if entities.iter().filter(|entity| entity.primary).count() != 1 {
            return Err("RRS_NATIVE_GENESIS_PRIMARY_ENTITY_COUNT".into());
        }
        Ok(Self {
            timestamp,
            machine,
            entities,
        })
    }
}

fn decode_entity_config(value: &Value, index: usize) -> Result<NativeGenesisEntityConfig, String> {
    let path = format!("ENTITY_{index}");
    let entity = object(value, &path)?;
    exact_fields(
        entity,
        &[
            "signerLabel",
            "primary",
            "authorityJurisdiction",
            "contextPolicy",
            "profile",
            "encryptionPublicKey",
            "htlcRoutingFeePpm",
            "htlcRoutingBaseFee",
        ],
        &path,
    )?;
    let signer_label = required(entity, "signerLabel", &path)?
        .as_str()
        .filter(|value| !value.is_empty() && value.trim() == *value && value.len() <= 256)
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{path}_SIGNER_LABEL"))?
        .to_owned();
    let primary = required(entity, "primary", &path)?
        .as_bool()
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{path}_PRIMARY"))?;
    let authority_jurisdiction = match required(entity, "authorityJurisdiction", &path)? {
        Value::Null => None,
        value => Some(
            canonical_value_from_tagged_json(value)
                .map_err(|error| format!("RRS_NATIVE_GENESIS_{path}_JURISDICTION:{error}"))?,
        ),
    };
    let context_policy = required(entity, "contextPolicy", &path)?.clone();
    let profile = decode_entity_profile(required(entity, "profile", &path)?)?;
    let encryption_public_key = decode_hex32(
        required(entity, "encryptionPublicKey", &path)?,
        &format!("{path}_ENCRYPTION_PUBLIC_KEY"),
    )?;
    let htlc_routing_fee_ppm = u32::try_from(safe_u64(
        required(entity, "htlcRoutingFeePpm", &path)?,
        &format!("{path}_HTLC_ROUTING_FEE_PPM"),
    )?)
    .map_err(|_| format!("RRS_NATIVE_GENESIS_{path}_HTLC_ROUTING_FEE_PPM"))?;
    let htlc_routing_base_fee = required(entity, "htlcRoutingBaseFee", &path)?
        .as_str()
        .and_then(|value| BigInt::from_str(value).ok())
        .filter(|value| value.sign() != num_bigint::Sign::Minus)
        .ok_or_else(|| format!("RRS_NATIVE_GENESIS_{path}_HTLC_ROUTING_BASE_FEE"))?;
    Ok(NativeGenesisEntityConfig {
        signer_label,
        primary,
        authority_jurisdiction,
        context_policy,
        profile,
        encryption_public_key,
        htlc_routing_fee_ppm,
        htlc_routing_base_fee,
    })
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

fn generation(entity_id: &[u8; 32]) -> EngineGeneration {
    let mut digest = Sha256::new();
    digest.update(b"xln.rscore.runtime.restore.generation.v1");
    digest.update(entity_id);
    digest.update(0_u64.to_be_bytes());
    digest.update(0_u64.to_be_bytes());
    let digest = digest.finalize();
    let mut generation = [0_u8; 8];
    generation.copy_from_slice(&digest[..8]);
    EngineGeneration::from_bytes(generation)
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
    let started = Instant::now();
    if runtime_seed.is_empty() || entity_signer_label.trim().is_empty() || workers == 0 {
        return Err("RRS_NATIVE_GENESIS_ARGUMENTS".into());
    }
    let NativeGenesisConfig {
        timestamp,
        machine,
        entities,
    } = genesis;
    let primary_signer_label = entities
        .iter()
        .find(|entity| entity.primary)
        .map(|entity| entity.signer_label.as_str())
        .ok_or_else(|| "RRS_NATIVE_GENESIS_PRIMARY_ENTITY_COUNT".to_string())?;
    if primary_signer_label != entity_signer_label {
        return Err(format!(
            "RRS_NATIVE_GENESIS_PRIMARY_SIGNER_MISMATCH:expected={entity_signer_label}:actual={primary_signer_label}"
        ));
    }
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

    let durable = RuntimeDurableEnvelope::decode(&machine, [0; 32])
        .map_err(|error| format!("RRS_NATIVE_GENESIS_MACHINE:{error}"))?;
    let runtime_id = expected_runtime_id(runtime_seed, runtime_signer_label)?;
    if durable.runtime_id() != runtime_id {
        return Err(format!(
            "RRS_NATIVE_GENESIS_RUNTIME_ID_MISMATCH:expected={runtime_id}:actual={}",
            durable.runtime_id()
        ));
    }
    let mut e_replicas = BTreeMap::new();
    let mut entity_inits = Vec::with_capacity(entities.len());
    let mut runtime_entities = Vec::with_capacity(entities.len());
    for config in entities {
        let private_key = derive_signer_key(runtime_seed, &config.signer_label)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_KEY:{error}"))?;
        let signer_id = hex(&derive_signer_address(runtime_seed, &config.signer_label)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_SIGNER:{error}"))?);
        let identity =
            SigningIdentity::lazy_from_key(private_key, &signer_id, 1, 1, BoardDelays::default())
                .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_ID:{error}"))?;
        let entity_id = *identity.entity_id();
        let entity_id_text = hex(&entity_id);
        let accounts = ResidentConsensusEngine::restore(
            generation(&entity_id),
            workers,
            0,
            private_key,
            signer_id.clone(),
            Arc::new(canonical_swap_market_policy()),
            Vec::new(),
        )
        .map_err(|error| format!("RRS_NATIVE_GENESIS_ACCOUNTS:{error}"))?;
        let accounts_root = accounts.accounts_root();
        let authority = EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec![signer_id.clone()],
                shares: BTreeMap::from([(signer_id.clone(), 1)]),
                jurisdiction: config.authority_jurisdiction,
            },
            leader_state: EntityLeaderState {
                active_validator_id: signer_id.clone(),
                view: 0,
                changed_at_height: 0,
            },
        }
        .validate_and_normalize()
        .map_err(|error| format!("RRS_NATIVE_GENESIS_AUTHORITY:{error}"))?;
        let entity_consensus = ResidentEntityConsensusReplica {
            state: EntityConsensusState {
                sections: Vec::new(),
                authority,
            },
            certified_frame_head: None,
        };
        let entity_signer = EntitySingleSigner::from_key(
            private_key,
            &signer_id,
            &entity_id_text,
            1,
            1,
            BoardDelays::default(),
        )
        .map_err(|error| format!("RRS_NATIVE_GENESIS_ENTITY_SIGNER:{error}"))?;
        let mut entity = EntityStateSlice::empty(entity_id_text.clone(), timestamp);
        entity.profile = config.profile;
        entity.entity_encryption_public_key = config.encryption_public_key;
        let key = RuntimeEntityKey::new(entity_id, &signer_id)
            .map_err(|error| format!("RRS_NATIVE_GENESIS_REPLICA_KEY:{error}"))?;
        if e_replicas
            .insert(
                key,
                xln_rscore_runtime::RuntimeEntityState {
                    accounts_root,
                    entity,
                },
            )
            .is_some()
        {
            return Err(format!(
                "RRS_NATIVE_GENESIS_REPLICA_DUPLICATE:{entity_id_text}"
            ));
        }
        entity_inits.push(xln_rscore_runtime::RuntimeEntityInit {
            entity_id,
            signer_id,
            accounts,
            entity_consensus,
            entity_signer,
            protocol_fingerprint: PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        });
        runtime_entities.push(NativeEntityRuntimeReady {
            entity_id,
            entity_context_policy: config.context_policy,
            htlc_routing_fee_ppm: config.htlc_routing_fee_ppm,
            htlc_routing_base_fee: config.htlc_routing_base_fee,
        });
    }
    let replica = RuntimeReplica::new(
        RuntimeState {
            height: 0,
            timestamp,
            finalized_j_height: 0,
            e_replicas,
        },
        durable,
        entity_inits,
        runtime_seed.to_owned(),
        limits,
    )
    .map_err(|error| format!("RRS_NATIVE_GENESIS_REPLICA:{error}"))?;
    let signer = RuntimeSignerLabel::new(runtime_signer_label)
        .map_err(|error| format!("RRS_NATIVE_GENESIS_RUNTIME_SIGNER:{error}"))?;
    let processor = DurableRuntimeProcessor::new(replica, store, routes, runtime_seed, signer)
        .map_err(|error| format!("RRS_NATIVE_GENESIS_PROCESSOR:{error}"))?;
    Ok(NativeRuntimeReady {
        processor,
        restore_elapsed: started.elapsed(),
        restored_wal_frames: 0,
        entities: runtime_entities,
    })
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

    fn entity(signer_label: &str, primary: bool, key_byte: &str) -> serde_json::Value {
        json!({
            "signerLabel": signer_label,
            "primary": primary,
            "authorityJurisdiction": null,
            "contextPolicy": {},
            "profile": {
                "name": "H1",
                "isHub": true,
                "entityKind": "protocol",
                "sectors": ["finance", "infrastructure"],
                "avatar": "",
                "bio": "",
                "website": ""
            },
            "encryptionPublicKey": format!("0x{}", key_byte.repeat(32)),
            "htlcRoutingFeePpm": 1,
            "htlcRoutingBaseFee": "0"
        })
    }

    #[test]
    fn genesis_config_rejects_unknown_and_negative_financial_fields() {
        let mut value = json!({
            "timestamp": 0,
            "machine": {},
            "entities": [entity("hub-1", true, "11")]
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
            "RRS_NATIVE_GENESIS_ENTITY_0_HTLC_ROUTING_BASE_FEE"
        );
    }

    #[test]
    fn genesis_config_requires_unique_signers_and_one_primary_entity() {
        let valid = json!({
            "timestamp": 0,
            "machine": {},
            "entities": [
                entity("hub-1", true, "11"),
                entity("hub-1:Sibling", false, "22")
            ]
        });
        let decoded = NativeGenesisConfig::decode(&valid).expect("multi-Entity genesis");
        assert_eq!(decoded.entities.len(), 2);

        let duplicate = json!({
            "timestamp": 0,
            "machine": {},
            "entities": [
                entity("hub-1", true, "11"),
                entity("hub-1", false, "22")
            ]
        });
        assert_eq!(
            NativeGenesisConfig::decode(&duplicate).unwrap_err(),
            "RRS_NATIVE_GENESIS_ENTITY_SIGNER_DUPLICATE:hub-1"
        );

        let no_primary = json!({
            "timestamp": 0,
            "machine": {},
            "entities": [entity("hub-1", false, "11")]
        });
        assert_eq!(
            NativeGenesisConfig::decode(&no_primary).unwrap_err(),
            "RRS_NATIVE_GENESIS_PRIMARY_ENTITY_COUNT"
        );
    }
}
