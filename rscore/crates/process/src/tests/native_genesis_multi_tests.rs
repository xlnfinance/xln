use super::*;
use crate::native_runtime::restore_native_runtime_processor;
use xln_rscore_runtime::{
    CanonicalEntityInfraMaterializer, RuntimeEntityInput, RuntimeLiveInput, decode_storage_payload,
    tagged_json_from_canonical_value,
};

#[test]
fn native_two_jurisdiction_owners_match_ts_identity_and_survive_exact_checkpoint_wal_restart() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/native-cross-genesis-v1.json"
    ))
    .unwrap();
    let genesis = NativeGenesisConfig::decode(&fixture["genesis"]).unwrap();
    let seed = fixture["seed"].as_str().unwrap();
    let runtime_label = fixture["runtimeSignerLabel"].as_str().unwrap();
    let entity_label = fixture["entitySignerLabel"].as_str().unwrap();
    let directory =
        std::env::temp_dir().join(format!("xln-native-two-owner-{}", std::process::id()));
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
    assert_eq!(ready.processor.replica().unwrap().state.e_replicas.len(), 2);
    validate_native_owner_inventory(&genesis, ready.processor.replica().unwrap(), seed, None)
        .unwrap();
    let mut single_owner_config = genesis.clone();
    single_owner_config.entities.pop();
    assert_eq!(
        single_owner_config
            .validate_owner_labels(entity_label)
            .unwrap_err(),
        "RRS_NATIVE_GENESIS_J_OWNER_INVENTORY_MISMATCH"
    );
    assert!(
        validate_native_owner_inventory(
            &single_owner_config,
            ready.processor.replica().unwrap(),
            seed,
            None
        )
        .unwrap_err()
        .starts_with("RRS_NATIVE_GENESIS_OWNER_INVENTORY_MISMATCH")
    );
    let expected = fixture["expectedOwners"].as_array().unwrap();
    for (index, owner) in expected.iter().enumerate() {
        let entity_id = decode_hex32(&owner["entityId"], "TEST_ENTITY").unwrap();
        let signer = owner["signerId"].as_str().unwrap();
        let (state, live) = ready
            .processor
            .replica()
            .unwrap()
            .entity_slot(&entity_id, signer)
            .expect("TS-derived native owner");
        assert!(state.entity.profile.is_hub);
        let owned = xln_rscore_entity_kernel::compute_entity_owned_sections(
            &state.entity,
            state.accounts_root,
            live.accounts.account_count(),
        )
        .unwrap();
        let projected = xln_rscore_entity_kernel::project_entity_consensus_sections(
            &live.entity_consensus.state.sections,
            owned,
            &live.entity_consensus.state.authority,
            state.entity.height,
        )
        .unwrap();
        assert_eq!(
            live.entity_consensus.state.sections, projected,
            "genesis WAL replay must verify the complete owner root before its first Entity frame"
        );

        assert_eq!(
            tagged_json_from_canonical_value(
                live.entity_consensus
                    .state
                    .authority
                    .config
                    .jurisdiction
                    .as_ref()
                    .unwrap()
            )
            .unwrap()["chainId"],
            owner["chainId"]
        );
        let input=RuntimeEntityInput::decode(serde_json::json!({"entityId":owner["entityId"],"signerId":signer,"entityTxs":[{"type":"chat","data":{"from":signer,"message":format!("owner-{index}")}}]})).unwrap();
        ready
            .processor
            .process_live(
                RuntimeLiveInput {
                    runtime_txs: vec![],
                    entity_inputs: vec![input],
                    timestamp: (index + 1) as u64,
                    finalized_j_height: 0,
                },
                &mut CanonicalEntityInfraMaterializer::new(),
            )
            .unwrap();
        ready.processor.sync_committed().unwrap();
    }
    let before = ready.processor.read_durable_frame(2).unwrap();
    let before_frame = decode_storage_payload(&before.frame_bytes).unwrap();
    drop(ready);
    let mut restored = restore_native_runtime_processor(
        &directory,
        seed,
        runtime_label,
        entity_label,
        1,
        EntityRouteTable::new([]).unwrap(),
        None,
        BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(
        restored.restored_wal_frames, 1,
        "checkpoint1 with untouched sibling, then exact WAL2"
    );
    validate_native_owner_inventory(&genesis, restored.processor.replica().unwrap(), seed, None)
        .unwrap();
    assert_eq!(
        hex(&restored
            .processor
            .replica()
            .unwrap()
            .durable
            .prev_frame_hash()),
        before_frame["frameHash"]
    );
    assert_eq!(
        restored.processor.replica().unwrap().state.e_replicas.len(),
        2
    );
    assert_eq!(restored.processor.replica().unwrap().state.height, 2);
    assert_eq!(
        restored
            .processor
            .read_durable_frame(2)
            .unwrap()
            .frame_bytes,
        before.frame_bytes
    );
    let owners = restored
        .processor
        .replica()
        .unwrap()
        .state
        .e_replicas
        .values()
        .map(|state| state.entity.entity_id.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        owners,
        expected
            .iter()
            .map(|owner| owner["entityId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    );
    assert_eq!(before_frame["height"], 2);
    drop(restored);
    std::fs::remove_dir_all(directory).unwrap();
}
