//! Canonical importReplica Runtime transition. Operator keys remain live-only.
use crate::{RuntimeEntityKey, RuntimeReplica};
use serde_json::{Value, json};
use x25519_dalek::{PublicKey, StaticSecret};
use xln_rscore_engine::{BoardDelays, SigningIdentity};
use xln_rscore_entity_kernel::{EntityCanonicalCollection, EntityStateSlice, EntitySwapPair};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportReplica(Value);
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("IMPORT_REPLICA_TEXT:{key}"))
}
fn hex_bytes<const N: usize>(value: &Value, key: &str) -> Result<[u8; N], String> {
    let raw = text(value, key)?
        .strip_prefix("0x")
        .ok_or("IMPORT_REPLICA_HEX")?;
    if raw.len() != N * 2
        || !raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(format!("IMPORT_REPLICA_HEX:{key}"));
    }
    hex::decode(raw)
        .map_err(|_| "IMPORT_REPLICA_HEX")?
        .try_into()
        .map_err(|_| "IMPORT_REPLICA_HEX".into())
}
pub(crate) fn decode(value: &Value) -> Result<ImportReplica, String> {
    let row = value.as_object().ok_or("IMPORT_REPLICA_OBJECT")?;
    if row.len() != 4
        || ["type", "entityId", "signerId", "data"]
            .iter()
            .any(|k| !row.contains_key(*k))
    {
        return Err("IMPORT_REPLICA_FIELDS".into());
    }
    hex_bytes::<32>(value, "entityId")?;
    hex_bytes::<20>(value, "signerId")?;
    let data = value["data"].as_object().ok_or("IMPORT_REPLICA_DATA")?;
    if ["config", "isProposer", "entitySeed"]
        .iter()
        .any(|k| !data.contains_key(*k))
        || data.keys().any(|k| {
            !matches!(
                k.as_str(),
                "config" | "isProposer" | "entitySeed" | "profileName" | "position"
            )
        })
    {
        return Err("IMPORT_REPLICA_DATA_FIELDS".into());
    }
    if !value["data"]["isProposer"].is_boolean() {
        return Err("IMPORT_REPLICA_PROPOSER".into());
    }
    let seed = text(&value["data"], "entitySeed")?
        .strip_prefix("0x")
        .ok_or("IMPORT_REPLICA_SEED")?;
    if seed.len() != 128
        || !seed
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("IMPORT_REPLICA_SEED".into());
    }
    crate::restore::decode_entity_authority(&serde_json::Map::from_iter([(
        "config".into(),
        value["data"]["config"].clone(),
    )]))
    .map_err(|e| e.to_string())?;
    if let Some(name) = data.get("profileName")
        && !name.is_string()
    {
        return Err("IMPORT_REPLICA_PROFILE".into());
    }
    if let Some(position) = data.get("position") {
        let row = position.as_object().ok_or("IMPORT_REPLICA_POSITION")?;
        if ["x", "y", "z"]
            .iter()
            .any(|key| !row.get(*key).is_some_and(Value::is_number))
            || row
                .keys()
                .any(|key| !matches!(key.as_str(), "x" | "y" | "z" | "jurisdiction"))
            || row
                .get("jurisdiction")
                .is_some_and(|value| !value.is_string())
        {
            return Err("IMPORT_REPLICA_POSITION".into());
        }
    }
    Ok(ImportReplica(value.clone()))
}
impl ImportReplica {
    pub(crate) fn encode(&self) -> Value {
        self.0.clone()
    }
}

fn swap_pairs(jurisdiction: &Value) -> Vec<EntitySwapPair> {
    let name = jurisdiction["name"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let tron = name.contains("tron")
        || name == "rpc2"
        || (name.is_empty() && jurisdiction["chainId"] == 31338);
    let tokens: &[u32] = if tron { &[1, 2, 3, 4, 5] } else { &[1, 2, 3] };
    let mut pairs = Vec::new();
    for (i, a) in tokens.iter().enumerate() {
        for b in &tokens[i + 1..] {
            let liquid = |v: u32| matches!(v, 1 | 3);
            let (base, quote) = if liquid(*a) && !liquid(*b) {
                (*b, *a)
            } else {
                (*a, *b)
            };
            pairs.push(EntitySwapPair {
                base_token_id: base,
                quote_token_id: quote,
                pair_id: format!("{a}/{b}"),
            });
        }
    }
    pairs.sort_by_key(|pair| {
        let key = format!("{}/{}", pair.base_token_id, pair.quote_token_id);
        (key != "2/1", key)
    });
    pairs
}

pub(crate) fn apply(
    runtime: &mut RuntimeReplica,
    input: &ImportReplica,
    timestamp: u64,
) -> Result<String, String> {
    let value = &input.0;
    let data = &value["data"];
    let entity_id = hex_bytes::<32>(value, "entityId")?;
    let entity_text = text(value, "entityId")?;
    let signer = text(value, "signerId")?;
    let authority = crate::restore::decode_entity_authority(&serde_json::Map::from_iter([(
        "config".into(),
        data["config"].clone(),
    )]))
    .map_err(|e| e.to_string())?;
    if !authority.is_single_signer().map_err(|e| e.to_string())? {
        return Err("IMPORT_REPLICA_NATIVE_SINGLE_SIGNER_REQUIRED".into());
    }
    if authority.config.validators[0] != signer || data["isProposer"] != true {
        return Err("IMPORT_REPLICA_SIGNER_PROPOSER".into());
    }
    let private_key = *runtime
        .entity_import_keys
        .get(signer)
        .ok_or("IMPORT_REPLICA_OPERATOR_KEY_MISSING")?;
    let weight = *authority
        .config
        .shares
        .get(signer)
        .ok_or("IMPORT_REPLICA_SIGNER_OUTSIDE_BOARD")?;
    let identity = SigningIdentity::lazy_from_key(
        private_key,
        signer,
        u128::from(weight),
        u128::from(authority.config.threshold),
        BoardDelays::default(),
    )
    .map_err(|e| e.to_string())?;
    let j = &data["config"]["jurisdiction"];
    let local = runtime
        .durable
        .j_replicas()
        .as_array()
        .ok_or("IMPORT_REPLICA_J_ROWS")?
        .iter()
        .filter(|row| {
            row[1]["chainId"] == j["chainId"]
                && row[1]["contracts"]["depository"] == j["depositoryAddress"]
                && row[1]["contracts"]["entityProvider"] == j["entityProviderAddress"]
        })
        .collect::<Vec<_>>();
    if local.len() != 1 {
        return Err("IMPORT_REPLICA_LOCAL_JURISDICTION".into());
    }
    if entity_id != *identity.entity_id() {
        // Numbered identity can only import the exact already authenticated board.
        let numbered = entity_id[..28].iter().all(|byte| *byte == 0) && {
            let number = u32::from_be_bytes(entity_id[28..].try_into().expect("fixed id"));
            number > 0 && number < 1_000_000
        };
        if !numbered {
            return Err("IMPORT_REPLICA_LAZY_BOARD_ID_MISMATCH".into());
        }
        let stack = crate::j_authority::stack_key(&local[0][1])?;
        let key = format!("{stack}:{entity_text}");
        let records = runtime.durable.infrastructure()["certifiedRegistrationEvidence"]["value"]
            .as_array()
            .ok_or("IMPORT_REPLICA_REGISTRATION_EVIDENCE_MISSING")?;
        let evidence = records
            .iter()
            .find(|row| row[0] == key)
            .ok_or("IMPORT_REPLICA_REGISTRATION_EVIDENCE_MISSING")?;
        if evidence[1]["boardHash"] != format!("0x{}", hex::encode(identity.entity_id())) {
            return Err("IMPORT_REPLICA_REGISTRATION_BOARD_MISMATCH".into());
        }
    }
    let seed = text(data, "entitySeed")?;
    let encryption = crate::entity_encryption::derive_entity_encryption_key(seed, entity_text)?;
    let public = *PublicKey::from(&StaticSecret::from(encryption)).as_bytes();
    let key = RuntimeEntityKey::new(entity_id, signer).map_err(|e| e.to_string())?;
    if let Some(existing) = runtime.state.e_replicas.get(&key) {
        if existing.entity.entity_encryption_public_key != public
            || runtime.e_replicas[&key]
                .entity_consensus
                .state
                .authority
                .config
                != authority.config
        {
            return Err("IMPORT_REPLICA_EXISTING_CONFLICT".into());
        }
    } else {
        if runtime
            .state
            .e_replicas
            .keys()
            .any(|key| key.entity_id == entity_id)
        {
            return Err("IMPORT_REPLICA_NATIVE_SIBLING_UNSUPPORTED".into());
        }
        let mut entity = EntityStateSlice::empty(entity_text, timestamp);
        entity.entity_encryption_public_key = public;
        entity.last_finalized_j_height = j["entityProviderDeploymentBlock"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(1);
        if let Some(name) = data["profileName"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            entity.profile.name = name.into();
        }
        entity.deferred_account_proposals = Some(EntityCanonicalCollection::empty());
        entity.cross_jurisdiction_book_admissions = Some(EntityCanonicalCollection::empty());
        entity.swap_trading_pairs = Some(swap_pairs(j));
        let (key, state, mut live) = crate::create_entity_genesis_slot(
            entity,
            authority,
            private_key,
            signer.into(),
            runtime.entity_import_workers,
            runtime.entity_import_protocol,
            runtime.state.height,
        )?;
        if let Some(position) = data.get("position") {
            let mut metadata = live.replica_metadata().clone();
            let mut position = position.clone();
            if position.get("jurisdiction").is_none() {
                position["jurisdiction"] =
                    json!(runtime.durable.active_jurisdiction().unwrap_or("default"));
            }
            metadata["position"] = position;
            live.install_replica_metadata(metadata)
                .map_err(|e| e.to_string())?;
        }
        runtime.state.e_replicas.insert(key.clone(), state);
        runtime.e_replicas.insert(key, live);
    }
    let infrastructure = runtime
        .durable
        .infrastructure_mut()
        .as_object_mut()
        .ok_or("IMPORT_REPLICA_INFRASTRUCTURE")?;
    let seeds = infrastructure
        .entry("entityEncryptionSeeds")
        .or_insert_with(|| json!({"__xlnType":"Map","value":[]}));
    let entries = seeds["value"]
        .as_array_mut()
        .ok_or("IMPORT_REPLICA_SEEDS")?;
    if let Some(existing) = entries.iter().find(|row| row[0] == entity_text) {
        if existing[1] != seed {
            return Err("IMPORT_REPLICA_SEED_CONFLICT".into());
        }
    } else {
        entries.push(json!([entity_text, seed]));
    }
    runtime.durable.invalidate_infrastructure_digest();
    Ok(entity_text.into())
}
