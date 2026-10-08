use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use xln_rscore_crypto::{address_of_private_key, derive_signer_key};

use super::{
    ConcreteCheckpointConfiguration, ConcreteCheckpointDecodeError, RuntimeDurableEnvelope, digest,
    entity_text, exact_fields, hex_bytes, invalid, object,
};

type EntityRoots = BTreeMap<[u8; 32], [u8; 32]>;
type StateRows = BTreeMap<Vec<u8>, Vec<u8>>;

pub(super) fn expected_entity_roots(
    frame: &Map<String, Value>,
) -> Result<EntityRoots, ConcreteCheckpointDecodeError> {
    let rows = frame
        .get("canonicalEntityHashes")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("CANONICAL_ENTITY_HASHES"))?;
    let mut roots = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let path = format!("canonicalEntityHashes[{index}]");
        let row = object(row, &path)?;
        exact_fields(row, &["entityId", "hash", "cellCount"], &path)?;
        if row["cellCount"]
            .as_u64()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .is_none()
        {
            return Err(invalid("CANONICAL_ENTITY_CELL_COUNT"));
        }
        let owner = digest(&row["entityId"], "canonicalEntityHashes.entityId")?;
        let root = digest(&row["hash"], "canonicalEntityHashes.hash")?;
        if roots.insert(owner, root).is_some() {
            return Err(invalid(format!(
                "CANONICAL_ENTITY_DUPLICATE:{}",
                entity_text(&owner)
            )));
        }
    }
    Ok(roots)
}

/// The complete signed owner set is checked before any per-owner reader sees
/// a slice. Every row is assigned exactly once; existing readers still enforce
/// their full namespace reachability and foreign-row checks on that slice.
pub(super) fn partition_state_rows(
    rows: StateRows,
    roots: &EntityRoots,
) -> Result<BTreeMap<[u8; 32], StateRows>, ConcreteCheckpointDecodeError> {
    let mut owners = BTreeMap::<[u8; 32], StateRows>::new();
    let mut manifests = BTreeSet::new();
    for (key, value) in rows {
        let owner: [u8; 32] = key
            .get(1..33)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| invalid("STATE_ROW_OWNER_KEY"))?;
        if !crate::storage::native::valid_path_key(&key) {
            return Err(invalid("STATE_ROW_PATH_KEY"));
        }
        if !roots.contains_key(&owner) {
            return Err(invalid(format!(
                "STATE_OWNER_UNDECLARED:{}",
                entity_text(&owner)
            )));
        }
        if key[0] == 0x21 {
            manifests.insert(owner);
        }
        owners.entry(owner).or_default().insert(key, value);
    }
    let expected = roots.keys().copied().collect::<BTreeSet<_>>();
    if manifests != expected || owners.keys().copied().collect::<BTreeSet<_>>() != expected {
        return Err(invalid("STATE_OWNER_SET_OR_MANIFEST_MISSING"));
    }
    Ok(owners)
}

fn derive_operator_signers(
    seed: &str,
    labels: &[String],
) -> Result<BTreeMap<String, [u8; 32]>, ConcreteCheckpointDecodeError> {
    if labels.is_empty() || labels.iter().any(|label| label.trim().is_empty()) {
        return Err(invalid("SIGNER_DERIVATION_LABEL_EMPTY"));
    }
    if labels.iter().collect::<BTreeSet<_>>().len() != labels.len() {
        return Err(invalid("SIGNER_DERIVATION_LABEL_DUPLICATE"));
    }
    labels
        .iter()
        .map(|label| {
            let private_key = derive_signer_key(seed, label)
                .map_err(|error| invalid(format!("SIGNER_KEY_DERIVATION:{error}")))?;
            let address = address_of_private_key(&private_key)
                .ok_or_else(|| invalid("SIGNER_KEY_ADDRESS"))?;
            Ok((format!("0x{}", hex_bytes(&address)), private_key))
        })
        .collect()
}

/// Same operator keyring as TS prewarmRecordedHubSigners: base label plus
/// exact recorded J names. Persisted signer addresses only select a proven
/// derived key; they are never reused as derivation labels.
pub(super) fn signer_keyring(
    configuration: &ConcreteCheckpointConfiguration,
    envelope: &RuntimeDurableEnvelope,
) -> Result<BTreeMap<String, [u8; 32]>, ConcreteCheckpointDecodeError> {
    let mut labels = configuration.signer_derivation_labels.clone();
    for base in &configuration.signer_derivation_labels {
        for row in envelope
            .j_replicas()
            .as_array()
            .expect("validated J replica array")
        {
            labels.push(format!(
                "{base}:{}",
                row[0].as_str().expect("validated J name")
            ));
        }
    }
    let mut keys = derive_operator_signers(&configuration.runtime_seed, &labels)?;
    for (signer, key) in &configuration.custody_import_keys {
        crate::install_custody_key(&mut keys, signer, *key).map_err(invalid)?;
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    #[test]
    fn empty_checkpoint_owner_set_is_explicit_and_has_no_rows() {
        let frame = serde_json::json!({"canonicalEntityHashes":[]});
        let roots = super::expected_entity_roots(frame.as_object().unwrap()).unwrap();
        assert!(roots.is_empty());
        assert!(
            super::partition_state_rows(std::collections::BTreeMap::new(), &roots)
                .unwrap()
                .is_empty()
        );
        assert!(super::expected_entity_roots(&serde_json::Map::new()).is_err());
    }

    use super::*;

    #[test]
    fn scenario_keyring_restores_all_explicit_validator_labels() {
        let labels = (1..=13).map(|index| index.to_string()).collect::<Vec<_>>();
        let configuration = ConcreteCheckpointConfiguration {
            runtime_seed: "0x0123456789abcdef".into(),
            signer_derivation_labels: labels.clone(),
            custody_import_keys: Default::default(),
            worker_count: 1,
            limits: crate::RuntimeLimits::hlt(),
            swap_market: std::sync::Arc::new(crate::canonical_swap_market_policy()),
            expected_protocol_fingerprint: [0; 32],
            board_delays: xln_rscore_engine::BoardDelays::default(),
        };
        let envelope = RuntimeDurableEnvelope::fixture();
        let keys = signer_keyring(&configuration, &envelope).expect("all scenario validators");
        let jurisdictions = envelope.j_replicas().as_array().unwrap().len();
        assert_eq!(keys.len(), 13 * (1 + jurisdictions));
        for label in labels {
            let key = derive_signer_key(&configuration.runtime_seed, &label).unwrap();
            let address = format!("0x{}", hex_bytes(&address_of_private_key(&key).unwrap()));
            assert_eq!(keys.get(&address), Some(&key));
        }
    }

    #[test]
    fn operator_keyring_rejects_empty_or_duplicate_label_configuration() {
        for labels in [vec![], vec!["".into()], vec!["1".into(), "1".into()]] {
            assert!(derive_operator_signers("0x0123456789abcdef", &labels).is_err());
        }
    }

    #[test]
    fn owner_partition_retains_every_row_and_rejects_foreign_or_missing_manifests() {
        let roots = BTreeMap::from([([0x11; 32], [1; 32]), ([0x22; 32], [2; 32])]);
        let key = |tag, owner: u8| [vec![tag], vec![owner; 32]].concat();
        let rows = BTreeMap::from([
            (key(0x21, 0x11), vec![1]),
            (key(0x17, 0x11), vec![2]),
            (key(0x21, 0x22), vec![3]),
            (key(0x17, 0x22), vec![4]),
        ]);
        let partition = partition_state_rows(rows.clone(), &roots).expect("both owners");
        assert_eq!(partition.len(), 2);
        assert_eq!(
            partition.values().map(BTreeMap::len).sum::<usize>(),
            rows.len()
        );
        let mut foreign = rows.clone();
        foreign.insert(key(0x17, 0x33), vec![5]);
        assert!(
            partition_state_rows(foreign, &roots)
                .unwrap_err()
                .to_string()
                .contains("STATE_OWNER_UNDECLARED")
        );
        let mut missing = rows;
        missing.remove(&key(0x21, 0x22));
        assert!(
            partition_state_rows(missing, &roots)
                .unwrap_err()
                .to_string()
                .contains("STATE_OWNER_SET_OR_MANIFEST_MISSING")
        );
    }

    #[test]
    fn short_path_is_rejected_before_namespace_parser_indexes_owner_bytes() {
        let rows = BTreeMap::from([(vec![0x23], vec![])]);
        assert!(
            partition_state_rows(rows, &BTreeMap::new())
                .unwrap_err()
                .to_string()
                .contains("STATE_ROW_OWNER_KEY")
        );
    }

    #[test]
    fn operator_keyring_binds_each_jurisdiction_label_without_using_signer_address_as_label() {
        let seed = "0x0123456789abcdef";
        let labels = [
            "h1-hub".into(),
            "h1-hub:Testnet".into(),
            "h1-hub:Tron".into(),
        ];
        let keys = derive_operator_signers(seed, &labels).expect("operator labels");
        assert_eq!(keys.len(), 3);
        for label in labels {
            let expected = derive_signer_key(seed, &label).unwrap();
            let address = format!(
                "0x{}",
                hex_bytes(&address_of_private_key(&expected).unwrap())
            );
            assert_eq!(keys[&address], expected);
            assert_ne!(derive_signer_key(seed, &address).unwrap(), expected);
        }
    }
}
