use super::*;
use crate::processor::{
    DurableRuntimeProcessor, EntityRouteTable, ResidentRuntimeService, RuntimeDurableEnvelope,
    RuntimeSignerLabel,
};
use crate::storage::native::{NativeRuntimeStore, NativeStorageConfig};
use crate::transport::{DirectRuntimeIngress, DirectRuntimeIngressConfig, derive_local_runtime_id};

#[test]
fn deployment_minus_one_import_first_poll_recovers_and_rechecks_uncertified_anchor() {
    for changed_anchor in [false, true] {
        let server = FakeRpcServer::start(FakeChain {
            rpc_overrides: BTreeMap::new(),
            depository: hex_repeat(0x11, 20),
            chain_id: 31337,
            head: 2,
            blocks: BTreeMap::from([(
                2,
                json!({"number":"0x2", "hash":hex_repeat(2, 32),
                    "parentHash":hex_repeat(1, 32), "receiptsRoot":hex_repeat(0, 32),
                    "transactions":[]}),
            )]),
            receipts: BTreeMap::new(),
            token_registry: vec![token_count_abi(0.into())],
        });
        let seed = "deployment-import-first-poll";
        let label = "runtime";
        let runtime_id = derive_local_runtime_id(seed, label).unwrap();
        let mut replica = crate::machine::tests::replica(crate::RuntimeLimits::hlt()).unwrap();
        let key = replica.state.e_replicas.keys().next().unwrap().clone();
        let entity = &mut replica.state.e_replicas.get_mut(&key).unwrap().entity;
        entity.last_finalized_j_height = 2;
        assert!(entity.j_history_finality.is_none());
        let local = replica.e_replicas.get_mut(&key).unwrap();
        assert!(local.replica_metadata().get("jHistory").is_none());
        local.entity_consensus.state.authority.config.jurisdiction = Some(
            crate::canonical_value_from_tagged_json(&json!({
                "chainId":31337, "depositoryAddress":hex_repeat(0x11, 20),
                "entityProviderAddress":hex_repeat(0x12, 20),
            }))
            .unwrap(),
        );
        replica.durable = RuntimeDurableEnvelope::decode(
            &json!({"runtimeId":runtime_id, "runtimeConfig":{"minFrameDelayMs":5}, "infrastructure":{},
                "jReplicas":[["test", {"chainId":31337, "rpcs":[server.endpoint],
                    "name":"test", "blockDelayMs":1000, "lastBlockTimestamp":0,
                    "mempool":[], "position":{"x":0,"y":0,"z":0}, "stateRoot":null,
                    "contracts":{"depository":hex_repeat(0x11, 20),
                        "entityProvider":hex_repeat(0x12, 20)},
                    "entityProviderDeploymentBlock":3,
                    "blockNumber":{"__xlnType":"BigInt", "value":"2"},
                    "watcherConfirmationDepth":0}]]}),
            [0; 32],
        )
        .unwrap();
        let directory = std::env::temp_dir().join(format!(
            "xln-deployment-import-{}-{changed_anchor}",
            std::process::id()
        ));
        let store = NativeRuntimeStore::open(&directory, NativeStorageConfig::default()).unwrap();
        let processor = DurableRuntimeProcessor::new(
            replica,
            store,
            EntityRouteTable::new([]).unwrap(),
            seed,
            RuntimeSignerLabel::new(label).unwrap(),
        )
        .unwrap();
        let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
            "127.0.0.1:0".parse().unwrap(),
            seed,
            label,
        ))
        .unwrap();
        let mut service = ResidentRuntimeService::new(
            processor,
            ingress,
            Box::new(crate::CanonicalEntityInfraMaterializer::new()),
        )
        .expect("deployment=3 import reads the uncertified parent hash at height 2");
        if changed_anchor {
            server.mutate(|chain| {
                chain.blocks.get_mut(&2).unwrap()["hash"] = json!(hex_repeat(9, 32))
            });
        }
        // No jHistory/certificate exists at the configured scan boundary. The
        // first recovery poll must still recheck its RPC anchor with no suffix.
        let result = service.process_next(Duration::ZERO);
        if changed_anchor {
            let error = result.expect_err("changed cursor anchor must fail closed");
            assert!(
                error.to_string().contains("J_WATCHER_FINALIZED_REORG:2"),
                "{error}"
            );
        } else {
            assert!(
                result
                    .expect("first poll accepts an unchanged deployment boundary")
                    .is_none()
            );
        }
        service.shutdown().unwrap();
        drop(service);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
