use std::{collections::BTreeMap, sync::Arc};

use num_bigint::BigInt;
use serde_json::Value;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use x25519_dalek::{PublicKey, StaticSecret};
use xln_rscore_batch::{AccountId, AccountSeed, EngineGeneration, ResidentConsensusEngine};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountEnvelope, AccountIdentity, AccountReplica,
    AccountState, BoardDelays, Delta, DepositoryAddress, EntityId, TokenId, WatchSeed,
    derive_signer_key,
};
use xln_rscore_entity_kernel::{
    ConsensusMode, EntityCanonicalCollection, EntityConsensusConfig, EntityConsensusSection,
    EntityConsensusState, EntityFrameAuthority, EntityFrameEvent, EntityLeaderState,
    EntitySingleSigner, EntityStateSlice, ResidentEntityConsensusReplica,
    compute_entity_consensus_root, compute_entity_effects_parity_digest,
    compute_entity_events_parity_digest,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, PersistentRadixMap};

use crate::processor::{EntityRoute, EntityRouteTable, encode_local_entity_outputs};
use crate::{
    CanonicalEntityInfraMaterializer, CanonicalRuntimeEntityHash, RuntimeApplyResult,
    RuntimeEntityInput, RuntimeEntityKey, RuntimeEntityState, RuntimeLimits, RuntimeLiveInput,
    RuntimeMachineError, RuntimeReplica, RuntimeState, apply_runtime_live,
    canonical_swap_market_policy, canonical_value_from_tagged_json,
    compute_canonical_runtime_state_hash, encode_storage_payload,
};

const FIXTURE: &str = include_str!("../../../../../fixtures/cross-j-opening/lifecycle-v1.json");

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("fixture {field}"))
}

fn hex<const N: usize>(value: &str) -> [u8; N] {
    let decoded = ::hex::decode(value.strip_prefix("0x").expect("0x hex")).expect("valid hex");
    decoded
        .try_into()
        .unwrap_or_else(|_| panic!("expected {N} bytes"))
}

fn entity_id(value: &str) -> EntityId {
    EntityId::parse(value).expect("fixture Entity id")
}

fn watch_seed(left: &str, right: &str) -> WatchSeed {
    let preimage = format!(
        "xln:account-watch-seed:v1|cross-j-test-helper||{}|{}",
        left.to_ascii_lowercase(),
        right.to_ascii_lowercase(),
    );
    let digest: [u8; 32] = Keccak256::digest(preimage.as_bytes()).into();
    WatchSeed::parse(&format!("0x{}", ::hex::encode(digest))).expect("fixture watch seed")
}

fn collection(rows: &Value) -> EntityCanonicalCollection {
    let mut collection = EntityCanonicalCollection::empty();
    for row in rows.as_array().expect("collection rows") {
        let pair = row.as_array().expect("collection pair");
        collection
            .insert(
                pair[0].as_str().expect("collection key").to_string(),
                canonical_value_from_tagged_json(&pair[1]).expect("canonical collection value"),
            )
            .expect("fixture collection insert");
    }
    collection
}

fn label_for_entity(setup: &Value, entity: &Value) -> &'static str {
    let route = &setup["route"];
    match text(entity, "entityId") {
        id if id == text(&route["source"], "counterpartyEntityId") => "source-hub",
        id if id == text(&route["target"], "entityId") => "target-hub",
        id if id == text(&route["source"], "entityId") => "source-user",
        id if id == text(&route["target"], "counterpartyEntityId") => "target-user",
        id => panic!("unknown fixture Entity {id}"),
    }
}

fn single_entity_runtime(
    seed: &str,
    runtime_timestamp: u64,
    setup: &Value,
    entity: &Value,
) -> Result<RuntimeReplica, RuntimeMachineError> {
    let entity_id_text = text(entity, "entityId");
    let signer_id = text(entity, "signerId").to_string();
    let label = label_for_entity(setup, entity);
    let signing_key = derive_signer_key(seed, label).expect("fixture signing key");
    let owner = entity_id(entity_id_text);
    let owner_bytes = *owner.as_bytes();
    let account = &entity["accounts"][0];
    let peer_text = text(account, "counterpartyEntityId");
    let peer = entity_id(peer_text);
    let (left_text, right_text) = if entity_id_text < peer_text {
        (entity_id_text, peer_text)
    } else {
        (peer_text, entity_id_text)
    };
    let derived_watch_seed = watch_seed(left_text, right_text);
    assert_eq!(
        derived_watch_seed.as_hex(),
        text(account, "watchSeed"),
        "initial Account watch seed",
    );
    let account_state = AccountState::new(
        AccountIdentity::new(
            AccountDomain::new(
                account["chainId"].as_u64().expect("chain id"),
                DepositoryAddress::parse(text(account, "depositoryAddress")).expect("depository"),
            )
            .expect("Account domain"),
            entity_id(left_text),
            entity_id(right_text),
            derived_watch_seed,
        )
        .expect("Account identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![
            Delta::new(
                TokenId::new(1).expect("token id"),
                0.into(),
                0.into(),
                0.into(),
                BigInt::from(10_u8).pow(30),
                BigInt::from(10_u8).pow(30),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
            )
            .expect("initial delta"),
        ],
    )
    .expect("Account state");
    assert_eq!(
        format!(
            "0x{}",
            ::hex::encode(
                account_state
                    .payment_profile_account_state_root()
                    .expect("initial Account root")
            )
        ),
        text(account, "root"),
        "initial Account root",
    );
    let account_id = AccountId::from_bytes(*peer.as_bytes());
    let empty_root = CanonicalValue::String(format!("0x{}", "00".repeat(32)));
    let mut account_replica =
        AccountReplica::new(owner.clone(), account_state).expect("Account replica");
    account_replica.set_delta_transformer(hex(text(account, "deltaTransformerAddress")));
    account_replica.set_envelope(
        AccountEnvelope::new(
            vec![
                ("status".into(), CanonicalValue::String("active".into())),
                (
                    "currentHeight".into(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(0)),
                ),
                (
                    "proofHeader".into(),
                    CanonicalValue::Object(vec![
                        (
                            "fromEntity".into(),
                            CanonicalValue::String(entity_id_text.into()),
                        ),
                        ("toEntity".into(), CanonicalValue::String(peer_text.into())),
                        (
                            "nextProofNonce".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u32(1)),
                        ),
                    ]),
                ),
                (
                    "currentFrameHash".into(),
                    CanonicalValue::String(String::new()),
                ),
                ("pendingWithdrawals".into(), empty_root.clone()),
                (
                    "shadow".into(),
                    CanonicalValue::Object(vec![(
                        "rebalance".into(),
                        CanonicalValue::Object(vec![
                            ("policyRoot".into(), empty_root.clone()),
                            ("submittedAtByTokenRoot".into(), empty_root),
                        ]),
                    )]),
                ),
            ],
            Vec::new(),
        )
        .expect("Account envelope"),
    );
    let account_leaf = account_replica
        .entity_account_leaf()
        .expect("initial Entity Account leaf");
    assert_eq!(
        prefixed(&account_leaf),
        text(account, "entityLeaf"),
        "initial Entity Account leaf",
    );
    let serial_root = PersistentRadixMap::empty()
        .updated(account_id.as_bytes().to_vec(), (), account_leaf)
        .expect("serial Account map")
        .root_hash();
    assert_eq!(
        prefixed(&serial_root),
        text(entity, "accountsRoot"),
        "initial serial Entity Account forest root",
    );
    let accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x22; 8]),
        1,
        0,
        signing_key,
        signer_id.clone(),
        Arc::new(canonical_swap_market_policy()),
        vec![AccountSeed {
            account_id,
            replica: account_replica,
            consensus: None,
        }],
    )
    .map_err(|error| {
        RuntimeMachineError::Entity(xln_rscore_entity_kernel::ResidentEntityError::Account(
            error,
        ))
    })?;
    assert_eq!(
        prefixed(&accounts.accounts_root()),
        text(entity, "accountsRoot"),
        "initial Entity Account forest root",
    );
    let mut state = EntityStateSlice::empty(
        entity_id_text,
        entity["timestamp"].as_u64().expect("timestamp"),
    );
    state.profile.name.clear();
    state.profile.is_hub = entity["isHub"].as_bool().expect("isHub");
    state.swap_trading_pairs = Some(Vec::new());
    state.entity_encryption_public_key = hex(text(entity, "entityEncryptionPublicKey"));
    state.known_accounts.insert(peer_text.to_string());
    state.cross_jurisdiction_swaps = Some(collection(&entity["crossJurisdictionSwaps"]));
    if !entity["crossJurisdictionAuthorizations"]
        .as_array()
        .expect("authorization rows")
        .is_empty()
    {
        state.cross_jurisdiction_authorizations =
            Some(collection(&entity["crossJurisdictionAuthorizations"]));
    }
    let expected_public = PublicKey::from(&StaticSecret::from(
        derive_signer_key(entity_id_text, "entity-encryption").expect("entity encryption key"),
    ));
    assert_eq!(
        state.entity_encryption_public_key,
        expected_public.to_bytes()
    );

    let authority = EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![signer_id.clone()],
            shares: BTreeMap::from([(signer_id.clone(), 1)]),
            jurisdiction: Some(
                canonical_value_from_tagged_json(&entity["jurisdiction"]).expect("jurisdiction"),
            ),
        },
        leader_state: EntityLeaderState {
            active_validator_id: signer_id.clone(),
            view: 0,
            changed_at_height: 0,
        },
    };
    let sections: Vec<EntityConsensusSection> = entity["sectionDigests"]
        .as_array()
        .expect("initial Entity sections")
        .iter()
        .map(|row| EntityConsensusSection {
            field: text(row, "field").to_string(),
            digest: text(row, "digest").to_string(),
        })
        .collect();
    assert_eq!(
        compute_entity_consensus_root(&sections).expect("initial Entity root"),
        text(entity, "entityRoot"),
        "initial Entity state root",
    );
    let consensus = ResidentEntityConsensusReplica {
        state: EntityConsensusState {
            sections,
            authority,
        },
        certified_frame_head: None,
    };
    let signer = EntitySingleSigner::from_key(
        signing_key,
        &signer_id,
        entity_id_text,
        1,
        1,
        BoardDelays::default(),
    )
    .expect("Entity signer");
    let accounts_root = accounts.accounts_root();
    RuntimeReplica::new(
        RuntimeState {
            height: 0,
            timestamp: runtime_timestamp,
            finalized_j_height: 0,
            e_replicas: BTreeMap::from([(
                RuntimeEntityKey::new(owner_bytes, &signer_id)?,
                RuntimeEntityState {
                    accounts_root,
                    entity: state,
                },
            )]),
        },
        crate::processor::RuntimeDurableEnvelope::fixture(),
        owner_bytes,
        signer_id,
        accounts,
        consensus,
        signer,
        [0; 32],
        seed.to_string(),
        RuntimeLimits::hlt(),
    )
}

fn merge_second(
    runtime: &mut RuntimeReplica,
    mut second: RuntimeReplica,
) -> Result<(), RuntimeMachineError> {
    let key = second
        .state
        .e_replicas
        .keys()
        .next()
        .expect("second slot")
        .clone();
    let (state, replica) = second
        .take_entity_slot(&key.entity_id, &key.signer_id)
        .expect("second Entity slot");
    runtime.install_entity_slot(key, state, replica)
}

fn runtime_from_initial(
    fixture: &Value,
    runtime_name: &str,
) -> Result<RuntimeReplica, RuntimeMachineError> {
    let setup = &fixture["setup"];
    let seed = text(setup, "seed");
    let timestamp = setup["timestamp"].as_u64().expect("fixture timestamp");
    let entities = setup["initial"][runtime_name]["entities"]
        .as_array()
        .expect("initial entities");
    let mut runtime = single_entity_runtime(seed, timestamp, setup, &entities[0])?;
    merge_second(
        &mut runtime,
        single_entity_runtime(seed, timestamp, setup, &entities[1])?,
    )?;
    let entity_hashes = entities
        .iter()
        .map(|entity| CanonicalRuntimeEntityHash {
            entity_id: text(entity, "entityId").to_string(),
            hash: text(entity, "entityRoot").to_string(),
            cell_count: 1,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        compute_canonical_runtime_state_hash(0, timestamp, &entity_hashes)
            .expect("initial Runtime state hash"),
        text(&setup["initial"][runtime_name], "canonicalRuntimeStateHash"),
        "initial Runtime state hash",
    );
    Ok(runtime)
}

fn decoded_inputs(frame: &Value) -> Result<Vec<RuntimeEntityInput>, RuntimeMachineError> {
    frame["canonicalEntityInputs"]
        .as_array()
        .expect("canonical Entity inputs")
        .iter()
        .cloned()
        .map(RuntimeEntityInput::decode)
        .collect()
}

fn apply_fixture_frame(
    runtime: RuntimeReplica,
    frame: &Value,
) -> Result<RuntimeApplyResult, RuntimeMachineError> {
    let mut materializer = CanonicalEntityInfraMaterializer::new();
    apply_runtime_live(
        runtime,
        RuntimeLiveInput {
            runtime_txs: Vec::new(),
            entity_inputs: decoded_inputs(frame)?,
            timestamp: 10_000,
            finalized_j_height: 0,
        },
        &mut materializer,
    )
}

fn prefixed(bytes: &[u8]) -> String {
    format!("0x{}", ::hex::encode(bytes))
}

fn event_value(event: &EntityFrameEvent) -> Value {
    match event {
        EntityFrameEvent::Status { message } => serde_json::json!({
            "type": "status",
            "message": message,
        }),
        EntityFrameEvent::Text {
            validator_id,
            message,
        } => serde_json::json!({
            "type": "text",
            "validatorId": validator_id,
            "message": message,
        }),
    }
}

fn assert_entity_frames(result: &RuntimeApplyResult, expected: &Value) {
    let expected_frames = expected["entityFrames"].as_array().expect("Entity frames");
    assert_eq!(
        result.outputs.entities.len(),
        expected_frames.len(),
        "actual Entity frames: {:?}",
        result
            .outputs
            .entities
            .iter()
            .map(|frame| (
                prefixed(&frame.entity_id),
                frame.entity_frame_height,
                &frame.entity_frame_hash,
            ))
            .collect::<Vec<_>>(),
    );
    for (index, (actual, expected)) in result
        .outputs
        .entities
        .iter()
        .zip(expected_frames)
        .enumerate()
    {
        assert_eq!(
            prefixed(&actual.entity_id),
            text(expected, "entityId"),
            "Entity frame {index} id"
        );
        assert_eq!(
            actual.signer_id,
            text(expected, "signerId"),
            "Entity frame {index} signer"
        );
        assert_eq!(
            actual.entity_frame_height,
            expected["height"].as_u64().expect("height"),
            "Entity frame {index} height",
        );
        assert_eq!(
            actual.entity_frame_timestamp, 10_000,
            "Entity frame {index} timestamp"
        );
        assert_eq!(
            prefixed(&actual.accounts_root),
            text(expected, "accountsRoot"),
            "Entity frame {index} Account forest root",
        );
        assert_eq!(
            actual.entity_state_root,
            text(expected, "stateRoot"),
            "Entity frame {index} state root"
        );
        assert_eq!(
            actual.entity_authority_root,
            text(expected, "authorityRoot"),
            "Entity frame {index} authority root",
        );
    }
    assert_eq!(
        result
            .outputs
            .entities
            .iter()
            .map(|frame| {
                frame
                    .entity_frame_events
                    .iter()
                    .map(event_value)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>(),
        expected_frames
            .iter()
            .map(|frame| frame["events"].as_array().expect("frame events").clone())
            .collect::<Vec<_>>(),
        "ordered per-Entity-frame events",
    );
    assert_eq!(
        result
            .outputs
            .entities
            .iter()
            .map(|frame| frame.entity_frame_hash.as_str())
            .collect::<Vec<_>>(),
        expected_frames
            .iter()
            .map(|frame| text(frame, "hash"))
            .collect::<Vec<_>>(),
        "ordered Entity frame hashes",
    );
}

fn assert_event_and_effect_digests(result: &RuntimeApplyResult, expected: &Value) {
    let events = result
        .outputs
        .entities
        .iter()
        .flat_map(|entity| entity.entity_frame_events.iter().cloned())
        .collect::<Vec<_>>();
    let effects = result
        .outputs
        .entities
        .iter()
        .flat_map(|entity| entity.entity_events.iter().cloned())
        .collect::<Vec<_>>();
    assert_eq!(
        events.len(),
        expected["events"]["eventCount"]
            .as_u64()
            .expect("event count") as usize
    );
    assert_eq!(
        prefixed(&compute_entity_events_parity_digest(&events).expect("event digest")),
        text(&expected["events"], "orderedEventDigest"),
    );
    assert_eq!(
        effects.len(),
        expected["effects"]["effectCount"]
            .as_u64()
            .expect("effect count") as usize
    );
    assert_eq!(
        prefixed(&compute_entity_effects_parity_digest(&effects).expect("effect digest")),
        text(&expected["effects"], "orderedEffectDigest"),
    );
}

fn route_table(fixture: &Value) -> EntityRouteTable {
    let setup = &fixture["setup"];
    let hub_runtime_id = text(setup, "hubRuntimeId");
    let user_runtime_id = text(setup, "userRuntimeId");
    let routes = [("hub", hub_runtime_id), ("user", user_runtime_id)]
        .into_iter()
        .flat_map(|(runtime, runtime_id)| {
            setup["initial"][runtime]["entities"]
                .as_array()
                .expect("initial Runtime entities")
                .iter()
                .map(move |entity| EntityRoute {
                    target_entity_id: text(entity, "entityId").to_string(),
                    target_runtime_id: runtime_id.to_string(),
                    target_signer_id: text(entity, "signerId").to_string(),
                    websocket_url: None,
                })
        });
    EntityRouteTable::new(routes).expect("fixture Entity routes")
}

fn encoded_outputs(result: &RuntimeApplyResult, routes: &EntityRouteTable) -> Vec<Value> {
    let mut outputs = Vec::new();
    for entity in &result.outputs.entities {
        let source_entity_id = prefixed(&entity.entity_id);
        let local = encode_local_entity_outputs(
            entity.local_entity_outputs.clone(),
            &source_entity_id,
            &entity.signer_id,
        )
        .expect("encode local Entity outputs");
        let mut bound = routes
            .bind_and_encode(
                local,
                result.replica.state.height,
                result.replica.state.timestamp,
                &source_entity_id,
                &entity.signer_id,
            )
            .expect("bind production Entity routes");
        if let Some(pair) = entity.atomic_cross_jurisdiction_pair.as_ref() {
            for output in &mut bound.resident_rows {
                output
                    .as_object_mut()
                    .expect("bound Entity output object")
                    .insert(
                        "atomicCrossJurisdictionPair".into(),
                        serde_json::json!({
                            "phase": pair.phase,
                            "pairKey": pair.pair_key,
                        }),
                    );
            }
        }
        outputs.extend(bound.resident_rows);
    }
    outputs
}

fn account_output_projection(outputs: &[Value]) -> Vec<Value> {
    let mut projected = Vec::new();
    for output in outputs {
        let account_input = output["entityTxs"]
            .as_array()
            .expect("Entity output txs")
            .iter()
            .find(|tx| tx["type"] == "accountInput")
            .map(|tx| tx["data"].clone());
        if let Some(account_input) = account_input {
            projected.push(serde_json::json!({
                "entityId": output["entityId"],
                "signerId": output["signerId"],
                "accountInput": account_input,
            }));
        }
    }
    projected
}

fn ordered_output_digest(outputs: &[Value]) -> String {
    let rows = outputs
        .iter()
        .map(|output| {
            let canonical =
                canonical_value_from_tagged_json(output).expect("canonical Runtime output");
            encode_storage_payload(&canonical).expect("encoded Runtime output")
        })
        .collect::<Vec<_>>();
    let mut digest = Sha256::new();
    digest.update(b"xln.runtime.outbox.v1");
    digest.update(
        u32::try_from(rows.len())
            .expect("output count")
            .to_be_bytes(),
    );
    for row in rows {
        digest.update(
            u32::try_from(row.len())
                .expect("output bytes")
                .to_be_bytes(),
        );
        digest.update(row);
    }
    prefixed(&digest.finalize())
}

fn assert_account_outputs(
    result: &RuntimeApplyResult,
    routes: &EntityRouteTable,
    expected: &Value,
) {
    let outputs = encoded_outputs(result, routes);
    let expected_outputs = expected["outbox"]["outputs"]
        .as_array()
        .expect("outbox outputs")
        .iter()
        .map(|output| {
            serde_json::json!({
                "entityId": output["entityId"],
                "signerId": output["signerId"],
                "accountInput": output["accountInput"],
            })
        })
        .collect::<Vec<_>>();
    let projected = account_output_projection(&outputs);
    assert_eq!(
        projected.len(),
        expected_outputs.len(),
        "Account output count"
    );
    for (index, (actual, expected)) in projected.iter().zip(&expected_outputs).enumerate() {
        assert_eq!(
            actual["entityId"], expected["entityId"],
            "Account output {index} destination Entity"
        );
        assert_eq!(
            actual["signerId"], expected["signerId"],
            "Account output {index} destination signer"
        );
        assert_eq!(
            actual["accountInput"], expected["accountInput"],
            "Account output {index} payload"
        );
    }
    let expected_wal_outputs = expected["outbox"]["walOutputs"]
        .as_array()
        .expect("WAL outputs");
    assert_eq!(
        outputs.len(),
        expected_wal_outputs.len(),
        "WAL output count"
    );
    for (index, (actual, expected)) in outputs.iter().zip(expected_wal_outputs).enumerate() {
        let actual_fields = actual.as_object().expect("actual WAL output object");
        let expected_fields = expected.as_object().expect("expected WAL output object");
        assert_eq!(
            actual_fields.keys().collect::<Vec<_>>(),
            expected_fields.keys().collect::<Vec<_>>(),
            "WAL output {index} fields"
        );
        for field in [
            "entityId",
            "signerId",
            "runtimeId",
            "sourceRuntimeFrame",
            "atomicCrossJurisdictionPair",
            "entityTxs",
        ] {
            assert_eq!(
                actual.get(field),
                expected.get(field),
                "WAL output {index} field {field}"
            );
        }
    }
    assert_eq!(
        outputs.len(),
        expected["outbox"]["count"].as_u64().expect("outbox count") as usize
    );
    assert_eq!(
        ordered_output_digest(&outputs),
        text(&expected["outbox"], "digest")
    );
}

fn assert_final_roots(result: &mut RuntimeApplyResult, expected: &Value) {
    let mut entity_hashes = Vec::new();
    for expected_root in expected["entityRoots"].as_array().expect("Entity roots") {
        let entity_id_bytes = hex::<32>(text(expected_root, "entityId"));
        let signer_id = text(expected_root, "signerId");
        let (state, live) = result
            .replica
            .entity_slot(&entity_id_bytes, signer_id)
            .expect("final Entity slot");
        let head = live
            .entity_consensus
            .certified_frame_head
            .as_ref()
            .expect("certified Entity head");
        assert_eq!(
            state.entity.height,
            expected_root["height"].as_u64().expect("Entity height")
        );
        assert_eq!(head.frame.state_root, text(expected_root, "root"));
        entity_hashes.push(CanonicalRuntimeEntityHash {
            entity_id: text(expected_root, "entityId").to_string(),
            hash: head.frame.state_root.clone(),
            cell_count: 1,
        });
    }
    assert_eq!(
        compute_canonical_runtime_state_hash(
            result.replica.state.height,
            result.replica.state.timestamp,
            &entity_hashes,
        )
        .expect("Runtime state hash"),
        text(expected, "canonicalRuntimeStateHash"),
    );
    for account in expected["accounts"].as_array().expect("Account states") {
        let entity_id_bytes = hex::<32>(text(account, "entityId"));
        let signer_id = expected["entityRoots"]
            .as_array()
            .expect("Entity roots")
            .iter()
            .find(|root| text(root, "entityId") == text(account, "entityId"))
            .map(|root| text(root, "signerId"))
            .expect("Account owner signer");
        let (_, live) = result
            .replica
            .entity_slot_mut(&entity_id_bytes, signer_id)
            .expect("Account owner slot");
        let status = live
            .accounts
            .account_status(
                AccountId::from_bytes(hex(text(account, "counterpartyEntityId"))),
                Vec::new(),
            )
            .expect("Account status")
            .expect("Account status row");
        assert_eq!(
            status.current_height,
            account["currentHeight"].as_u64().expect("current height")
        );
        assert_eq!(
            status.pending_frame_height,
            account["pendingHeight"].as_u64()
        );
        assert_eq!(
            status.mempool_len,
            account["mempoolTxTypes"].as_array().expect("mempool").len()
        );
    }
}

fn assert_fixture_frame(
    result: &mut RuntimeApplyResult,
    routes: &EntityRouteTable,
    expected: &Value,
) {
    assert_eq!(
        result.replica.state.height,
        expected["runtimeHeight"].as_u64().expect("Runtime height")
    );
    assert_entity_frames(result, expected);
    assert_event_and_effect_digests(result, expected);
    assert_account_outputs(result, routes, expected);
    assert_final_roots(result, expected);
}

#[test]
fn production_runtime_executes_shared_cross_j_opening_lifecycle() -> Result<(), RuntimeMachineError>
{
    let fixture: Value = serde_json::from_str(FIXTURE).expect("cross-J lifecycle fixture");
    let frames = fixture["frames"].as_array().expect("fixture frames");
    let routes = route_table(&fixture);
    let hub = runtime_from_initial(&fixture, "hub")?;
    let user = runtime_from_initial(&fixture, "user")?;

    let mut opening = apply_fixture_frame(hub, &frames[0])?;
    assert_fixture_frame(&mut opening, &routes, &frames[0]);
    let mut proposals = apply_fixture_frame(user, &frames[1])?;
    assert_fixture_frame(&mut proposals, &routes, &frames[1]);
    let mut acknowledgements = apply_fixture_frame(opening.replica, &frames[2])?;
    assert_fixture_frame(&mut acknowledgements, &routes, &frames[2]);
    Ok(())
}
