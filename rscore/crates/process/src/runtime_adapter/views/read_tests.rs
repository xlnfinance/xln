use super::*;

#[test]
fn frame_projection_preserves_exact_root_and_counts_nested_entity_transactions() {
    let frame = json!({"height":7,"timestamp":91,"postStateHash":"0x11","canonicalStateHash":"0x22",
        "runtimeInput":{"runtimeTxs":[{}],"jInputs":[],"entityInputs":[{"entityTxs":[{},{}]},{"entityTxs":[{}]}]},
        "touchedEntities":["one"],"touchedAccounts":["left","right"]});
    let projected = compact_frame(&frame, 7).unwrap();
    assert_eq!(projected["stateHash"], "0x22");
    assert_eq!(
        projected["runtimeInputCounts"],
        json!({"runtimeTxs":1,"jInputs":0,"entityInputs":2,"entityTxs":3})
    );
    assert_eq!(
        projected["touchedCounts"],
        json!({"entities":1,"accounts":2,"bookEntities":0})
    );
    assert_eq!(
        compact_frame(&frame, 6).unwrap_err(),
        "E_INTERNAL:FRAME_HEIGHT_MISMATCH"
    );
}

#[test]
fn frame_projection_rejects_corrupt_counts_instead_of_reporting_no_work() {
    let frame = json!({"height":7,"timestamp":91,"postStateHash":"0x11","runtimeInput":{"entityInputs":{}}});
    assert_eq!(
        compact_frame(&frame, 7).unwrap_err(),
        "E_INTERNAL:FRAME_COLLECTION_INVALID"
    );
    for invalid in [json!(-1), json!(1.5), json!(true), json!("-1")] {
        assert!(requested_height(&json!({"atHeight":invalid})).is_err());
    }
}

#[test]
fn native_read_observes_real_fsynced_entity_and_distinct_runtime_frames_without_mutation() {
    use crate::native_genesis::{
        NativeGenesisConfig, NativeGenesisEntity, create_native_genesis_runtime_processor,
    };
    use xln_rscore_entity_kernel::EntityProfile;
    use xln_rscore_runtime::processor::EntityRouteTable;
    use xln_rscore_runtime::transport::{DirectRuntimeIngress, DirectRuntimeIngressConfig};
    use xln_rscore_runtime::{CanonicalEntityInfraMaterializer, RuntimeEntityInput};
    let seed = "native-adapter-read";
    let directory =
        std::env::temp_dir().join(format!("xln-native-adapter-read-{}", std::process::id()));
    let genesis = NativeGenesisConfig {
        timestamp: 1,
        machine: json!({"runtimeId":format!("0x{}",hex::encode(xln_rscore_engine::derive_signer_address(seed,"runtime").unwrap())),
            "activeJurisdiction":"test","runtimeConfig":{"minFrameDelayMs":0},"infrastructure":{},"jReplicas":[]}),
        entities: vec![NativeGenesisEntity {
            signer_label: "entity".into(),
            entity_authority_jurisdiction: None,
            entity_profile: EntityProfile::default_for_entity("query"),
            entity_encryption_public_key: [1; 32],
            htlc_routing_fee_ppm: 0,
            htlc_routing_base_fee: 0.into(),
        }],
    };
    let ready = create_native_genesis_runtime_processor(
        &directory,
        genesis,
        seed,
        "runtime",
        "entity",
        1,
        EntityRouteTable::new([]).unwrap(),
    )
    .unwrap();
    let key = ready
        .processor
        .replica()
        .unwrap()
        .state
        .e_replicas
        .keys()
        .next_back()
        .unwrap()
        .clone();
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        "127.0.0.1:0".parse().unwrap(),
        seed,
        "runtime",
    ))
    .unwrap();
    let mut service = ResidentRuntimeService::new(
        ready.processor,
        ingress,
        Box::new(CanonicalEntityInfraMaterializer::new()),
    )
    .unwrap();
    let mut roots = Vec::new();
    for height in 1..=102 {
        let input=RuntimeEntityInput::decode(json!({"entityId":format!("0x{}",hex::encode(key.entity_id)),"signerId":key.signer_id,
            "entityTxs": if height >= 101 {json!([{"type":"profile-update","data":{"profile":{"entityId":format!("0x{}",hex::encode(key.entity_id)),"name":format!("profile-{height}")}}}])} else {json!([{"type":"chat","data":{"from":key.signer_id,"message":format!("committed-{height}")}}])}})).unwrap();
        service
            .process_local_entity_inputs_at(vec![input], height + 1)
            .unwrap()
            .expect("real signed entity frame");
        let entities = read(&mut service, "entities", &json!({})).unwrap();
        assert_eq!(entities.as_array().unwrap().len(), 1);
        assert_eq!(entities[0]["signerId"], key.signer_id);
        let core = read(
            &mut service,
            &format!("entity/0x{}", hex::encode(key.entity_id)),
            &json!({}),
        )
        .unwrap();
        assert_eq!(core["signerId"], key.signer_id);
        assert_eq!(core["height"], height);
        assert_eq!(core["entityId"], entities[0]["entityId"]);
        if height == 1 {
            let peer = format!("0x{}", "33".repeat(32));
            let missing_owner = format!("entity/0x{}/account/{peer}", "44".repeat(32));
            assert!(
                read(&mut service, &missing_owner, &json!({}))
                    .unwrap_err()
                    .starts_with("E_NOT_FOUND:")
            );
            let missing_account = format!("entity/0x{}/account/{peer}", hex::encode(key.entity_id));
            assert!(
                read(&mut service, &missing_account, &json!({}))
                    .unwrap_err()
                    .starts_with("E_NOT_FOUND:")
            );
            let view = read(&mut service, "view-frame", &json!({})).unwrap();
            assert_eq!(view["activeEntityId"], entities[0]["entityId"]);
            let explicit = read(
                &mut service,
                "view-frame",
                &json!({"entityId":entities[0]["entityId"]}),
            )
            .unwrap();
            assert_eq!(explicit["activeEntityId"], entities[0]["entityId"]);
        }
        let projected = read(&mut service, &format!("frame/{height}"), &json!({})).unwrap();
        let durable = service.read_durable_frame(height).unwrap();
        let actual = decode_storage_payload(&durable.frame_bytes).unwrap();
        assert_eq!(projected["postStateHash"], actual["postStateHash"]);
        assert_eq!(projected["height"], height);
        assert_eq!(
            read(&mut service, &format!("frame/{height}"), &json!({})).unwrap(),
            projected
        );
        assert_eq!(service.processor().replica().unwrap().state.height, height);
        roots.push(projected["postStateHash"].clone());
    }
    let timeline = read(&mut service, "timeline-index", &json!({"limit":3})).unwrap();
    assert_eq!(timeline["latestHeight"], 102);
    assert_eq!(timeline["scannedHeights"], 3);
    assert_eq!(timeline["nextBeforeHeight"], 100);
    for (index, height) in [100, 101, 102].into_iter().enumerate() {
        let frame = read(&mut service, &format!("frame/{height}"), &json!({})).unwrap();
        assert_eq!(timeline["entries"][index]["height"], height);
        assert_eq!(timeline["entries"][index]["timestamp"], frame["timestamp"]);
        assert_eq!(timeline["entries"][index]["stateHash"], frame["stateHash"]);
    }
    let filtered = read(
        &mut service,
        "timeline-index",
        &json!({"fromTimestamp":103,"limit":3,"scanLimit":3}),
    )
    .unwrap();
    assert_eq!(filtered["entries"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["entries"][0]["height"], 102);
    assert_eq!(filtered["scannedHeights"], 3);
    assert!(
        read(&mut service, "timeline-index", &json!({"beforeHeight":1}))
            .unwrap_err()
            .starts_with("E_BAD_QUERY:")
    );
    assert_ne!(roots[0], roots[1]);
    assert_eq!(
        read(&mut service, "frame/1", &json!({})).unwrap()["postStateHash"],
        roots[0]
    );
    assert!(
        read(&mut service, "frame/103", &json!({}))
            .unwrap_err()
            .starts_with("E_NOT_FOUND:")
    );
    use xln_rscore_runtime::restore::ConcreteCheckpointConfiguration;
    use xln_rscore_runtime::{RuntimeLimits, canonical_swap_market_policy};
    for height in [101, 102] {
        let sources = service.adapter_restore_sources().unwrap();
        assert_eq!(sources.checkpoint.height, 101);
        let head = read(&mut service, "head", &json!({})).unwrap();
        assert_eq!(head["latestSnapshotHeight"], sources.checkpoint.height);
        assert_eq!(head["retainSnapshots"], 1);
        assert_eq!(head["snapshotPeriodFrames"], 100);
        let catalog = read(&mut service, "checkpoints", &json!({})).unwrap();
        assert_eq!(catalog[0]["height"], sources.checkpoint.height);
        let configuration = ConcreteCheckpointConfiguration {
            runtime_seed: seed.into(),
            signer_derivation_labels: vec!["entity".into()],
            custody_import_keys: Default::default(),
            worker_count: 1,
            limits: RuntimeLimits::hlt(),
            swap_market: std::sync::Arc::new(canonical_swap_market_policy()),
            expected_protocol_fingerprint: crate::PAYMENT_PROFILE_BINDING.protocol_fingerprint,
            board_delays: xln_rscore_engine::BoardDelays::default(),
        };
        let view = crate::runtime_adapter::history::history_read::read_with_context(
            &mut service,
            "view-frame",
            &json!({"atHeight":height}),
            &configuration,
        )
        .unwrap();
        assert_eq!(view["height"], height);
        assert_eq!(
            view["activeEntity"]["core"]["profile"]["name"],
            format!("profile-{height}")
        );
        if height == 101 {
            let receipts = crate::runtime_adapter::history::history_read::read_with_context(
                &mut service,
                "frame-receipts",
                &json!({"fromHeight":102,"toHeight":102}),
                &configuration,
            )
            .unwrap();
            assert_eq!(receipts["fromHeight"], 102);
            assert_eq!(receipts["toHeight"], 102);
            assert_eq!(receipts["returned"], 1);
            assert_eq!(receipts["receipts"][0]["height"], 102);
            assert_eq!(receipts["receipts"][0]["timestamp"], 103);
            assert_eq!(receipts["receipts"][0]["logs"], json!([])); // profile update has no economic completion event
            assert!(
                crate::runtime_adapter::history::history_read::read_with_context(
                    &mut service,
                    "frame-receipts",
                    &json!({"fromHeight":101}),
                    &configuration,
                )
                .unwrap_err()
                .starts_with(
                    "E_NOT_FOUND:frame receipt history unavailable; retained replay range 102..102"
                )
            );
            let batch = crate::runtime_adapter::history::history_read::read_with_context(
                &mut service,
                "history-frame-batch",
                &json!({"heights":[101,102,100,101]}),
                &configuration,
            )
            .unwrap();
            assert_eq!(batch["requestedHeights"], json!([101, 102, 100]));
            assert_eq!(batch["frames"].as_array().unwrap().len(), 2);
            assert_eq!(
                batch["frames"][0]["activeEntity"]["core"]["profile"]["name"],
                "profile-101"
            );
            assert_eq!(
                batch["frames"][1]["activeEntity"]["core"]["profile"]["name"],
                "profile-102"
            );
            assert_eq!(batch["unavailable"][0]["height"], 100);
            assert_eq!(batch["unavailable"][0]["code"], "E_NOT_FOUND");
            assert_eq!(service.processor().replica().unwrap().state.height, 102);
        }
        let restored = crate::runtime_adapter::history::restore::reconstruct_at_height(
            sources,
            configuration,
            height,
        )
        .unwrap();
        assert_eq!(restored.replica.state.height, height);
        let state = restored.replica.state.e_replicas.get(&key).unwrap();
        let live = restored.replica.e_replicas.get(&key).unwrap();
        let core = crate::runtime_adapter::views::projection::entity_core(
            state,
            live,
            &xln_rscore_protocol::CanonicalValue::Map(vec![]),
        )
        .unwrap();
        assert_eq!(core["profile"]["name"], format!("profile-{height}"));
    }
    service.shutdown().unwrap();
    drop(service);
    std::fs::remove_dir_all(directory).unwrap();
}
