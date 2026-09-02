mod support;

use std::collections::BTreeMap;

use num_bigint::BigInt;
use serde_json::{Value, json};
use xln_rscore_engine::{BoardActivatedEvent, EntityId, JEventMetadata, JurisdictionEvent};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, CertifiedBoardRecord, CertifiedBoardSource, CertifiedBoardState,
    ConsensusMode, EntityCommandDisposition, EntityConsensusConfig, EntityFrameAuthority,
    EntityFrameEvent, EntityJOutput, EntityLeaderState, EntityPropose,
    EntityProviderGovernanceIntent, EntityTxKind, EntityVote, EntityVoteChoice,
    FinalizedJEventBatch, HashType, LocalEntityControlTx, LocalEntityTx,
    advance_entity_command_nonce, apply_local_entity_control_tx, assert_signed_entity_command,
    canonical_entity_provider_action_intent, certified_board_stack_key,
    compute_entity_consensus_root, compute_entity_owned_sections,
    current_entity_command_board_hash, decode_local_entity_control_tx,
    decode_signed_entity_command, project_entity_consensus_sections,
    resolve_board_handover_authority,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

fn fixture() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/entity-control-semantics/group-b-v1.json"
    )))
    .expect("TypeScript Entity control fixture")
}

fn canonical(value: &Value) -> CanonicalValue {
    match value {
        Value::Null => CanonicalValue::Null,
        Value::Bool(value) => CanonicalValue::Bool(*value),
        Value::String(value) => CanonicalValue::String(value.clone()),
        Value::Number(value) => CanonicalValue::Number(
            CanonicalNumber::try_from_u64(value.as_u64().expect("fixture unsigned integer"))
                .expect("fixture safe integer"),
        ),
        Value::Array(values) => CanonicalValue::Array(values.iter().map(canonical).collect()),
        Value::Object(fields)
            if fields.get("__xlnType") == Some(&Value::String("BigInt".into())) =>
        {
            CanonicalValue::BigInt(
                fields["value"]
                    .as_str()
                    .expect("BigInt text")
                    .parse::<BigInt>()
                    .expect("BigInt"),
            )
        }
        Value::Object(fields) => CanonicalValue::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
    }
}

fn tagged(value: &CanonicalValue) -> Value {
    match value {
        CanonicalValue::Null => Value::Null,
        CanonicalValue::Bool(value) => Value::Bool(*value),
        CanonicalValue::String(value) => Value::String(value.clone()),
        CanonicalValue::Number(value) => serde_json::from_str(value.as_str()).expect("number"),
        CanonicalValue::BigInt(value) => {
            json!({ "__xlnType": "BigInt", "value": value.to_string() })
        }
        CanonicalValue::Array(values) => Value::Array(values.iter().map(tagged).collect()),
        CanonicalValue::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), tagged(value)))
                .collect(),
        ),
        other => panic!("unsupported fixture canonical value: {other:?}"),
    }
}

fn word(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value.strip_prefix("0x").expect("0x")).expect("hex");
    bytes.try_into().expect("bytes32")
}

fn provider_registry(case: &Value, target: bool) -> CertifiedBoardState {
    let jurisdiction = canonical(&case["setup"]["config"]["jurisdiction"]);
    let stack_key = certified_board_stack_key(&jurisdiction).expect("stack key");
    let mut registry = CertifiedBoardState::empty(stack_key);
    let current_id = word(case["setup"]["entityId"].as_str().expect("entityId"));
    registry
        .put(CertifiedBoardRecord {
            stack_key,
            entity_id: current_id,
            board_hash: [0x44; 32],
            board_epoch: 0,
            previous_board_hash: [0; 32],
            previous_board_valid_until: 0,
            activated_at_j_height: 2,
            log_index: 0,
            block_hash: [0x12; 32],
            transaction_hash: [0x22; 32],
            source: CertifiedBoardSource::EntityRegistered,
        })
        .expect("current record");
    if target {
        registry
            .put(CertifiedBoardRecord {
                stack_key,
                entity_id: {
                    let mut value = [0; 32];
                    value[31] = 3;
                    value
                },
                board_hash: [0x55; 32],
                board_epoch: 1,
                previous_board_hash: [0x44; 32],
                previous_board_valid_until: 1_700_604_800,
                activated_at_j_height: 4,
                log_index: 0,
                block_hash: [0x14; 32],
                transaction_hash: [0x24; 32],
                source: CertifiedBoardSource::BoardActivated,
            })
            .expect("target record");
    }
    registry
}

fn authority(case: &Value) -> EntityFrameAuthority {
    let config = &case["setup"]["config"];
    let validators = config["validators"]
        .as_array()
        .expect("validators")
        .iter()
        .map(|value| value.as_str().expect("validator").to_string())
        .collect::<Vec<_>>();
    let shares = config["shares"]
        .as_object()
        .expect("shares")
        .iter()
        .map(|(signer, value)| {
            let power = value["value"]
                .as_str()
                .expect("share")
                .parse::<u16>()
                .expect("u16 share");
            (signer.clone(), power)
        })
        .collect::<BTreeMap<_, _>>();
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: config["threshold"]["value"]
                .as_str()
                .expect("threshold")
                .parse()
                .expect("u16 threshold"),
            validators: validators.clone(),
            shares,
            jurisdiction: config.get("jurisdiction").map(canonical),
        },
        leader_state: EntityLeaderState {
            active_validator_id: validators[0].clone(),
            view: 0,
            changed_at_height: 0,
        },
    }
}

fn event_json(event: &EntityFrameEvent) -> Value {
    match event {
        EntityFrameEvent::Text {
            validator_id,
            message,
        } => json!({ "type": "text", "validatorId": validator_id, "message": message }),
        EntityFrameEvent::Status { message } => json!({ "type": "status", "message": message }),
    }
}

fn assert_case_evidence(
    name: &str,
    case: &Value,
    state: &xln_rscore_entity_kernel::EntityStateSlice,
    events: &[EntityFrameEvent],
) {
    let actual_events = events.iter().map(event_json).collect::<Vec<_>>();
    assert_eq!(
        Value::Array(actual_events),
        case["evidence"]["events"],
        "{name}: events"
    );
    let actual = compute_entity_owned_sections(state, [0; 32], 0).expect("owned sections");
    for field in case["changedSections"]
        .as_array()
        .expect("changed sections")
    {
        let field = field.as_str().expect("field");
        let actual_digest = actual
            .iter()
            .find(|row| row.field == field)
            .expect("actual field")
            .digest
            .as_str();
        let expected_digest = case["after"]["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|row| row["field"] == field)
            .and_then(|row| row["digest"].as_str())
            .expect("expected digest");
        assert_eq!(actual_digest, expected_digest, "{name}: {field}");
    }
    let expected_sections = case["after"]["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .map(|row| xln_rscore_entity_kernel::EntityConsensusSection {
            field: row["field"].as_str().expect("field").to_string(),
            digest: row["digest"].as_str().expect("digest").to_string(),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        compute_entity_consensus_root(&expected_sections).expect("root"),
        case["after"]["root"],
        "{name}: root"
    );
}

#[test]
fn typescript_and_rust_control_reducers_match_exact_sections_events_and_effects() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    for name in [
        "chat",
        "chatMessage",
        "profile-update",
        "initOrderbookExt",
        "setHubConfig",
        "mintReserves",
    ] {
        let case = cases
            .iter()
            .find(|case| case["name"] == name)
            .expect("named case");
        let kind =
            EntityTxKind::parse(case["tx"]["type"].as_str().expect("tx type")).expect("kind");
        let tx = CanonicalEntityTx::from_frame_projection(kind, canonical(&case["tx"]["data"]))
            .expect("canonical tx");
        let decoded = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control tx");
        let mut state =
            support::entity_state(case["setup"]["timestamp"].as_u64().expect("timestamp"));
        state.entity_id = case["setup"]["entityId"]
            .as_str()
            .expect("entityId")
            .to_string();
        let mut events = Vec::new();
        let result =
            apply_local_entity_control_tx(&mut state, decoded, &mut events, &authority(case), 0)
                .expect("apply control tx");

        assert_case_evidence(name, case, &state, &events);
        assert_eq!(
            result.hashes_to_sign.len(),
            case["evidence"]["hashesToSign"].as_array().unwrap().len(),
            "{name}: hashes"
        );
        assert_eq!(
            result.approved_entity_txs.len(),
            case["evidence"]["approvedEntityTxs"]
                .as_array()
                .unwrap()
                .len(),
            "{name}: approved txs"
        );
        assert_eq!(
            result.j_outputs.len(),
            case["evidence"]["jOutputs"].as_array().unwrap().len(),
            "{name}: J outputs"
        );
        if name == "mintReserves" {
            let EntityJOutput::MintReserves {
                jurisdiction_name,
                entity_id,
                token_id,
                amount,
                timestamp,
            } = &result.j_outputs[0]
            else {
                panic!("mintReserves: exact J output")
            };
            let expected = &case["evidence"]["jOutputs"][0];
            assert_eq!(
                jurisdiction_name,
                expected["jurisdictionName"].as_str().unwrap()
            );
            assert_eq!(hex_word(entity_id), expected["jTxs"][0]["entityId"]);
            assert_eq!(
                *token_id,
                expected["jTxs"][0]["data"]["tokenId"].as_u64().unwrap()
            );
            assert_eq!(
                amount.to_string(),
                expected["jTxs"][0]["data"]["amount"]["value"]
                    .as_str()
                    .unwrap()
            );
            assert_eq!(
                *timestamp,
                expected["jTxs"][0]["timestamp"].as_u64().unwrap()
            );
        }
    }
}

#[test]
fn typescript_and_rust_governance_propose_and_vote_match() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    let proposed = cases
        .iter()
        .find(|case| case["name"] == "propose")
        .expect("propose");
    let voted = cases
        .iter()
        .find(|case| case["name"] == "vote")
        .expect("vote");
    let entity_id = proposed["setup"]["entityId"]
        .as_str()
        .expect("entityId")
        .to_string();
    let mut state = support::entity_state(2_000);
    state.entity_id = entity_id.clone();
    let mut events = Vec::new();
    let proposal_data = &proposed["tx"]["data"];
    let proposer = proposal_data["proposer"]
        .as_str()
        .expect("proposer")
        .to_string();
    let propose_result = apply_local_entity_control_tx(
        &mut state,
        LocalEntityControlTx::Propose(EntityPropose {
            proposer,
            action: canonical(&proposal_data["action"]),
            board_hash: entity_id.clone(),
            board_epoch: 0,
            command_nonce: BigInt::from(1),
        }),
        &mut events,
        &authority(proposed),
        0,
    )
    .expect("propose");
    assert!(propose_result.approved_entity_txs.is_empty());
    assert_case_evidence("propose", proposed, &state, &events);

    events.clear();
    let vote_data = &voted["tx"]["data"];
    let vote_result = apply_local_entity_control_tx(
        &mut state,
        LocalEntityControlTx::Vote(EntityVote {
            proposal_id: vote_data["proposalId"]
                .as_str()
                .expect("proposalId")
                .to_string(),
            voter: vote_data["voter"].as_str().expect("voter").to_string(),
            choice: EntityVoteChoice::Yes,
            comment: vote_data["comment"].as_str().map(str::to_string),
            board_hash: entity_id,
            board_epoch: 0,
        }),
        &mut events,
        &authority(voted),
        0,
    )
    .expect("vote");
    assert!(vote_result.approved_entity_txs.is_empty());
    assert_case_evidence("vote", voted, &state, &events);
}

#[test]
fn typescript_signed_entity_command_matches_rust_authority_nonce_and_inner_effect() {
    let fixture = fixture();
    let case = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "entityCommand")
        .expect("entityCommand");
    let command = decode_signed_entity_command(&canonical(&case["tx"]["data"]))
        .expect("decode signed command");
    let signer = command.author_signer.clone();
    let (board, disposition) = assert_signed_entity_command(
        case["setup"]["entityId"].as_str().expect("entityId"),
        &authority(case),
        &signer,
        0,
        &command.stack_key,
        None,
        &command,
    )
    .expect("authorize signed command");
    assert_eq!(disposition, EntityCommandDisposition::Next);
    let mut state = support::entity_state(2_000);
    state.entity_id = case["setup"]["entityId"]
        .as_str()
        .expect("entityId")
        .to_string();
    let mut events = Vec::new();
    for tx in command.native_txs.clone() {
        let LocalEntityTx::Control(tx) = tx else {
            panic!("control command")
        };
        apply_local_entity_control_tx(&mut state, tx, &mut events, &authority(case), 0)
            .expect("apply command tx");
    }
    assert_eq!(
        advance_entity_command_nonce(&mut state.entity_command_nonces, &board, &command)
            .expect("advance nonce"),
        EntityCommandDisposition::Next,
    );
    assert_case_evidence("entityCommand", case, &state, &events);
}

#[test]
fn typescript_and_rust_entity_provider_actions_match_state_events_hashes_and_j_intents() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    for name in [
        "entityProviderTransfer",
        "entityProviderReleaseControlShares",
        "entityProviderCancelAction",
    ] {
        let case = cases
            .iter()
            .find(|case| case["name"] == name)
            .expect("provider case");
        let mut state = support::entity_state(2_000);
        state.entity_id = case["setup"]["entityId"]
            .as_str()
            .expect("entityId")
            .to_string();
        state.certified_board_state = Some(provider_registry(case, false));
        if name == "entityProviderCancelAction" {
            let transfer = cases
                .iter()
                .find(|row| row["name"] == "entityProviderTransfer")
                .expect("transfer");
            let tx = CanonicalEntityTx::from_frame_projection(
                EntityTxKind::EntityProviderTransfer,
                canonical(&transfer["tx"]["data"]),
            )
            .expect("transfer tx");
            let decoded = decode_local_entity_control_tx(&tx)
                .expect("decode transfer")
                .expect("control");
            apply_local_entity_control_tx(
                &mut state,
                decoded,
                &mut Vec::new(),
                &authority(case),
                0,
            )
            .expect("pending transfer");
        }
        let kind = EntityTxKind::parse(case["tx"]["type"].as_str().expect("type")).expect("kind");
        let tx = CanonicalEntityTx::from_frame_projection(kind, canonical(&case["tx"]["data"]))
            .expect("provider tx");
        let decoded = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control");
        let mut events = Vec::new();
        let result =
            apply_local_entity_control_tx(&mut state, decoded, &mut events, &authority(case), 0)
                .expect("apply provider tx");
        assert_case_evidence(name, case, &state, &events);

        let expected_hash = &case["evidence"]["hashesToSign"][0];
        assert_eq!(result.hashes_to_sign.len(), 1, "{name}: one hash");
        assert_eq!(
            result.hashes_to_sign[0].kind,
            HashType::EntityProviderAction,
            "{name}: hash kind"
        );
        assert_eq!(
            result.hashes_to_sign[0].hash, expected_hash["hash"],
            "{name}: hash"
        );
        assert_eq!(
            result.hashes_to_sign[0].context, expected_hash["context"],
            "{name}: context"
        );

        let EntityJOutput::EntityProviderActionIntent {
            jurisdiction_name,
            intent,
            signer_id,
        } = &result.j_outputs[0]
        else {
            panic!("{name}: provider J output")
        };
        let expected = &case["evidence"]["jOutputs"][0];
        assert_eq!(
            jurisdiction_name,
            expected["jurisdictionName"].as_str().unwrap(),
            "{name}: jurisdiction"
        );
        assert_eq!(
            signer_id,
            expected["jTxs"][0]["data"]["signerId"].as_str().unwrap(),
            "{name}: signer"
        );
        assert_eq!(
            tagged(&canonical_entity_provider_action_intent(intent).expect("canonical intent")),
            expected["jTxs"][0]["data"]["intent"],
            "{name}: intent",
        );
    }
}

fn hex_word(value: &[u8]) -> String {
    format!("0x{}", hex::encode(value))
}

#[test]
fn typescript_and_rust_control_board_governance_match_exact_j_intents() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    for name in [
        "entityProviderProposeControlBoard",
        "entityProviderActivateBoard",
    ] {
        let case = cases
            .iter()
            .find(|case| case["name"] == name)
            .expect("governance case");
        let mut state = support::entity_state(2_000);
        state.entity_id = case["setup"]["entityId"]
            .as_str()
            .expect("entityId")
            .to_string();
        state.certified_board_state = Some(provider_registry(case, true));
        let kind = EntityTxKind::parse(case["tx"]["type"].as_str().expect("type")).expect("kind");
        let tx = CanonicalEntityTx::from_frame_projection(kind, canonical(&case["tx"]["data"]))
            .expect("governance tx");
        let decoded = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control");
        let mut events = Vec::new();
        let result =
            apply_local_entity_control_tx(&mut state, decoded, &mut events, &authority(case), 0)
                .expect("apply governance tx");
        assert_case_evidence(name, case, &state, &events);
        let expected = &case["evidence"]["jOutputs"][0];
        let EntityJOutput::GovernanceIntent {
            jurisdiction_name,
            intent,
        } = &result.j_outputs[0]
        else {
            panic!("{name}: governance output")
        };
        assert_eq!(
            jurisdiction_name,
            expected["jurisdictionName"].as_str().unwrap()
        );
        let data = &expected["jTxs"][0]["data"];
        match intent {
            EntityProviderGovernanceIntent::ProposeControlBoard {
                shareholder_entity_id,
                target_entity_id,
                new_board_hash,
                target_board_epoch,
                action_nonce,
                proposal_hash,
                supporter_votes,
                signer_id,
                timestamp,
            } => {
                assert_eq!(
                    hex_word(shareholder_entity_id),
                    expected["jTxs"][0]["entityId"]
                );
                assert_eq!(hex_word(target_entity_id), data["targetEntityId"]);
                assert_eq!(hex_word(new_board_hash), data["newBoardHash"]);
                assert_eq!(*target_board_epoch, 1);
                assert_eq!(action_nonce.to_string(), data["actionNonce"]["value"]);
                assert_eq!(hex_word(proposal_hash), data["proposalHash"]);
                assert_eq!(signer_id, data["signerId"].as_str().unwrap());
                assert_eq!(
                    *timestamp,
                    expected["jTxs"][0]["timestamp"].as_u64().unwrap()
                );
                assert_eq!(supporter_votes.len(), 1);
                assert_eq!(
                    hex_word(&supporter_votes[0].entity_id),
                    data["supporterVotes"][0]["entityId"]
                );
                assert!(supporter_votes[0].hanko_signature.is_none());
                assert_eq!(result.hashes_to_sign[0].hash, data["proposalHash"]);
                assert_eq!(
                    result.hashes_to_sign[0].context,
                    case["evidence"]["hashesToSign"][0]["context"]
                );
            }
            EntityProviderGovernanceIntent::ActivateBoard {
                entity_id,
                target_entity_id,
                signer_id,
                timestamp,
            } => {
                assert_eq!(hex_word(entity_id), expected["jTxs"][0]["entityId"]);
                assert_eq!(hex_word(target_entity_id), data["targetEntityId"]);
                assert_eq!(signer_id, data["signerId"].as_str().unwrap());
                assert_eq!(
                    *timestamp,
                    expected["jTxs"][0]["timestamp"].as_u64().unwrap()
                );
                assert!(result.hashes_to_sign.is_empty());
            }
        }
    }
}

#[test]
fn typescript_and_rust_board_handover_match_post_authority_sections() {
    let fixture = fixture();
    let case = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "boardHandover")
        .expect("boardHandover");
    let current = authority(case);
    let board = &case["tx"]["data"]["board"];
    let next_signer = board["validators"][0]
        .as_str()
        .expect("next signer")
        .to_string();
    let next = EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![next_signer.clone()],
            shares: BTreeMap::from([(next_signer.clone(), 1)]),
            jurisdiction: current.config.jurisdiction.clone(),
        },
        leader_state: EntityLeaderState {
            active_validator_id: next_signer,
            view: 0,
            changed_at_height: 1,
        },
    };
    let previous_board_hash =
        word(&current_entity_command_board_hash(&current, "").expect("old board"));
    let new_board_hash = word(&current_entity_command_board_hash(&next, "").expect("new board"));
    let entity_id =
        EntityId::parse(case["setup"]["entityId"].as_str().expect("entityId")).expect("entity");
    let txs = vec![
        CanonicalEntityTx::from_frame_projection(
            EntityTxKind::JEvent,
            CanonicalValue::Object(Vec::new()),
        )
        .expect("J event"),
        CanonicalEntityTx::from_frame_projection(
            EntityTxKind::BoardHandover,
            canonical(&case["tx"]["data"]),
        )
        .expect("handover"),
    ];
    let batch = FinalizedJEventBatch {
        j_height: 3,
        j_block_hash: [0x15; 32],
        events: vec![JurisdictionEvent::BoardActivated(BoardActivatedEvent {
            metadata: JEventMetadata {
                block_number: Some(3),
                block_hash: Some([0x15; 32]),
                transaction_hash: Some([0x25; 32]),
                log_index: Some(0),
                event_index: None,
            },
            entity_id: entity_id.clone(),
            previous_board_hash,
            new_board_hash,
            previous_board_valid_until: BigInt::from(1_700_604_800_u64),
        })],
        dispute_finalization_evidence: Vec::new(),
        reserve_updates: Vec::new(),
        account_claims: Vec::new(),
    };
    let post = resolve_board_handover_authority(&current, entity_id.as_bytes(), 1, &txs, &[batch])
        .expect("handover authority");
    let projected =
        project_entity_consensus_sections(&[], Vec::new(), &post).expect("authority sections");
    for field in ["config", "leaderState"] {
        let expected = case["after"]["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|row| row["field"] == field)
            .and_then(|row| row["digest"].as_str())
            .expect("digest");
        let actual = projected
            .iter()
            .find(|row| row.field == field)
            .expect("projected field");
        assert_eq!(actual.digest, expected, "{field}");
    }
}
