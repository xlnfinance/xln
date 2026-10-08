use super::*;
use crate::native_runtime::restore_native_runtime_processor;
use xln_rscore_runtime::{
    CanonicalEntityInfraMaterializer, RuntimeEntityInput, RuntimeLiveInput, RuntimeTx,
    custody_owner_import, decode_storage_payload, install_custody_key,
};

// Published test-only key material. No production owner file or secret fixture.
#[test]
fn custody_owner_import_replays_from_wal_then_checkpoint_and_signs_after_restart() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/native-cross-genesis-v1.json"
    ))
    .unwrap();
    let genesis = NativeGenesisConfig::decode(&fixture["genesis"]).unwrap();
    let seed = fixture["seed"].as_str().unwrap();
    let runtime_label = fixture["runtimeSignerLabel"].as_str().unwrap();
    let entity_label = fixture["entitySignerLabel"].as_str().unwrap();
    let directory = std::env::temp_dir().join(format!("xln-native-custody-{}", std::process::id()));
    let mut ready = create_native_genesis_runtime_processor(
        &directory,
        genesis.clone(),
        seed,
        runtime_label,
        entity_label,
        1,
        EntityRouteTable::new([]).unwrap(),
    )
    .unwrap();
    let private_key = [7u8; 32];
    let signer = format!(
        "0x{}",
        hex::encode(xln_rscore_crypto::address_of_private_key(&private_key).unwrap())
    );
    let entity_seed = format!("0x{}", "11".repeat(64));
    let j = &genesis.machine["jReplicas"][0][1];
    let jurisdiction = serde_json::json!({"name":j["name"],"chainId":j["chainId"],
        "address":j["rpcs"][0],"blockTimeMs":j["blockTimeMs"],
        "depositoryAddress":j["contracts"]["depository"],
        "entityProviderAddress":j["contracts"]["entityProvider"],
        "entityProviderDeploymentBlock":j["entityProviderDeploymentBlock"]});
    let (entity_id, import) = custody_owner_import(
        &signer,
        private_key,
        &entity_seed,
        jurisdiction,
        "Custody test",
    )
    .unwrap();
    let owner = RuntimeEntityKey::new(entity_id, &signer).unwrap();
    let initial = ready
        .processor
        .replica()
        .unwrap()
        .state
        .e_replicas
        .keys()
        .next()
        .unwrap()
        .clone();
    let chat = |owner: &RuntimeEntityKey, n: u64| {
        RuntimeEntityInput::decode(serde_json::json!({
        "entityId":format!("0x{}",hex::encode(owner.entity_id)),"signerId":owner.signer_id,
        "entityTxs":[{"type":"chat","data":{"from":owner.signer_id,"message":format!("custody-{n}")}}]})).unwrap()
    };
    ready
        .processor
        .process_live(
            RuntimeLiveInput {
                runtime_txs: vec![],
                entity_inputs: vec![chat(&initial, 1)],
                timestamp: 1,
                finalized_j_height: 0,
            },
            &mut CanonicalEntityInfraMaterializer::new(),
        )
        .unwrap();
    ready.processor.sync_committed().unwrap();
    // Simulate persisted custody present before its import: inventory remains exact,
    // the authenticated startup writer is allowed to finish this missing owner.
    validate_native_owner_inventory(
        &genesis,
        ready.processor.replica().unwrap(),
        seed,
        Some(&owner),
    )
    .unwrap();
    ready
        .processor
        .install_custody_key(&signer, private_key)
        .unwrap();
    ready
        .processor
        .process_live(
            RuntimeLiveInput {
                runtime_txs: vec![RuntimeTx::ImportReplica(import)],
                entity_inputs: vec![],
                timestamp: 2,
                finalized_j_height: 0,
            },
            &mut CanonicalEntityInfraMaterializer::new(),
        )
        .unwrap();
    ready.processor.sync_committed().unwrap();
    let durable = ready.processor.read_durable_frame(2).unwrap();
    let decoded = decode_storage_payload(&durable.frame_bytes).unwrap();
    assert_eq!(
        decoded["runtimeInput"]["runtimeTxs"][0]["data"]["entitySeed"], entity_seed,
        "Canonical private WAL deliberately preserves the exact entity seed"
    );
    assert!(
        !decoded.to_string().contains(&hex::encode(private_key)),
        "Signing key is never WAL data"
    );
    validate_native_owner_inventory(
        &genesis,
        ready.processor.replica().unwrap(),
        seed,
        Some(&owner),
    )
    .unwrap();
    assert!(
        validate_native_owner_inventory(&genesis, ready.processor.replica().unwrap(), seed, None)
            .is_err()
    );
    let expected_root = decoded["postStateHash"].clone();
    drop(ready);
    let mut keys = BTreeMap::new();
    install_custody_key(&mut keys, &signer, private_key).unwrap();
    let mut restored = restore_native_runtime_processor(
        &directory,
        seed,
        runtime_label,
        entity_label,
        1,
        EntityRouteTable::new([]).unwrap(),
        None,
        keys.clone(),
    )
    .unwrap();
    assert_eq!(restored.restored_wal_frames, 1);
    assert_eq!(
        decode_storage_payload(
            &restored
                .processor
                .read_durable_frame(2)
                .unwrap()
                .frame_bytes
        )
        .unwrap()["postStateHash"],
        expected_root
    );
    for height in 3..=102 {
        restored
            .processor
            .process_live(
                RuntimeLiveInput {
                    runtime_txs: vec![],
                    entity_inputs: vec![chat(&owner, height)],
                    timestamp: height,
                    finalized_j_height: 0,
                },
                &mut CanonicalEntityInfraMaterializer::new(),
            )
            .unwrap();
        restored.processor.sync_committed().unwrap();
    }
    let before = restored.processor.replica().unwrap().state.e_replicas[&owner]
        .entity
        .height;
    assert_eq!(before, 100);
    drop(restored);
    assert!(
        restore_native_runtime_processor(
            &directory,
            seed,
            runtime_label,
            entity_label,
            1,
            EntityRouteTable::new([]).unwrap(),
            None,
            BTreeMap::new()
        )
        .is_err(),
        "Missing external custody key fails closed"
    );
    let mut restored = restore_native_runtime_processor(
        &directory,
        seed,
        runtime_label,
        entity_label,
        1,
        EntityRouteTable::new([]).unwrap(),
        None,
        keys,
    )
    .unwrap();
    assert_eq!(restored.restored_wal_frames, 1, "Checkpoint101 plus WAL102");
    validate_native_owner_inventory(
        &genesis,
        restored.processor.replica().unwrap(),
        seed,
        Some(&owner),
    )
    .unwrap();
    restored
        .processor
        .process_live(
            RuntimeLiveInput {
                runtime_txs: vec![],
                entity_inputs: vec![chat(&owner, 103)],
                timestamp: 103,
                finalized_j_height: 0,
            },
            &mut CanonicalEntityInfraMaterializer::new(),
        )
        .unwrap();
    restored.processor.sync_committed().unwrap();
    assert_eq!(
        restored.processor.replica().unwrap().state.e_replicas[&owner]
            .entity
            .height,
        before + 1
    );
    drop(restored);
    std::fs::remove_dir_all(directory).unwrap();
}
