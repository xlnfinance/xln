use num_bigint::BigInt;
use xln_rscore_batch::{decode_jurisdiction_event, encode_jurisdiction_event};
use xln_rscore_engine::{
    AccountSettledEvent, BoardActivatedEvent, CounterDisputeRegisteredEvent, DebtCreatedEvent,
    DebtEnforcedEvent, DebtForgivenEvent, DisputeFinalizationEvidence, DisputeFinalizedEvent,
    DisputeStartedEvent, EntityId, EntityProviderActionCancelledEvent,
    EntityProviderActionExecutedEvent, EntityRegisteredEvent, ExternalAllowance,
    ExternalTokenBalance, ExternalWalletDeltaEvent, ExternalWalletSnapshotEvent,
    FoundationBootstrappedEvent, HankoBatchProcessedEvent, HashLadderRevealRegisteredEvent,
    JEventMetadata, JurisdictionEvent, ProofAllowance, ProofBody, ProofTransformerClause,
    ReserveUpdatedEvent, SecretRevealedEvent, TokenId,
    canonical_dispute_finalization_evidence_hash, canonical_events_hash,
};

fn b32(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn b20(byte: u8) -> [u8; 20] {
    [byte; 20]
}

fn hex_bytes(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&hex_bytes(&b32(byte))).expect("entity")
}

fn metadata() -> JEventMetadata {
    JEventMetadata {
        block_number: Some(77),
        block_hash: Some(b32(200)),
        transaction_hash: Some(b32(201)),
        log_index: Some(4),
        event_index: Some(1),
    }
}

fn proof() -> ProofBody {
    ProofBody {
        watch_seed: hex_bytes(&b32(9)),
        left_response_seconds: 4,
        right_response_seconds: 5,
        offdeltas: vec![BigInt::from(1), BigInt::from(-2)],
        token_ids: vec![BigInt::from(3)],
        transformers: vec![ProofTransformerClause {
            transformer_address: hex_bytes(&b20(6)),
            encoded_batch: "0x1234".into(),
            allowances: vec![ProofAllowance {
                delta_index: BigInt::from(0),
                right_allowance: BigInt::from(1),
                left_allowance: BigInt::from(2),
            }],
        }],
    }
}

fn catalog() -> Vec<JurisdictionEvent> {
    let left = entity(3);
    let right = entity(4);
    let left_text = left.as_hex();
    let right_text = right.as_hex();
    vec![
        JurisdictionEvent::FoundationBootstrapped(FoundationBootstrappedEvent {
            metadata: metadata(),
            recipient: b20(1),
            board_hash: b32(2),
            control_token_id: 3.into(),
            dividend_token_id: 4.into(),
        }),
        JurisdictionEvent::EntityRegistered(EntityRegisteredEvent {
            metadata: metadata(),
            entity_id: left.clone(),
            entity_number: 5.into(),
            board_hash: b32(4),
        }),
        JurisdictionEvent::BoardActivated(BoardActivatedEvent {
            metadata: metadata(),
            entity_id: left.clone(),
            previous_board_hash: b32(4),
            new_board_hash: b32(5),
            previous_board_valid_until: 6.into(),
        }),
        JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
            metadata: metadata(),
            entity: left_text.clone(),
            token_id: 7,
            new_balance: 8.into(),
        }),
        JurisdictionEvent::ExternalWalletSnapshot(ExternalWalletSnapshotEvent {
            metadata: metadata(),
            entity_id: left_text.clone(),
            owner: b20(1),
            native_balance: Some(9.into()),
            token_balances: vec![ExternalTokenBalance {
                token_address: b20(2),
                token_id: Some(10),
                balance: 11.into(),
            }],
            allowances: vec![ExternalAllowance {
                token_address: b20(2),
                spender: b20(3),
                allowance: 12.into(),
            }],
        }),
        JurisdictionEvent::ExternalWalletDelta(ExternalWalletDeltaEvent {
            metadata: metadata(),
            entity_id: left_text.clone(),
            owner: b20(1),
            token_address: b20(2),
            token_id: Some(10),
            balance_delta: Some((-2).into()),
            spender: Some(b20(3)),
            allowance: Some(12.into()),
        }),
        JurisdictionEvent::SecretRevealed(SecretRevealedEvent {
            metadata: metadata(),
            hashlock: hex_bytes(&b32(13)),
            revealer: left_text.clone(),
            secret: hex_bytes(&b32(14)),
        }),
        JurisdictionEvent::AccountSettled(AccountSettledEvent {
            metadata: metadata(),
            left_entity: left.clone(),
            right_entity: right.clone(),
            token_id: TokenId::new(15).expect("token"),
            left_reserve: 16.into(),
            right_reserve: 17.into(),
            collateral: 18.into(),
            ondelta: (-19).into(),
            nonce: 20,
        }),
        JurisdictionEvent::HankoBatchProcessed(HankoBatchProcessedEvent {
            metadata: metadata(),
            entity_id: left.clone(),
            batch_hash: b32(21),
            nonce: 22,
        }),
        JurisdictionEvent::EntityProviderActionExecuted(EntityProviderActionExecutedEvent {
            metadata: metadata(),
            entity_id: left.clone(),
            action_nonce: 23.into(),
            action_hash: b32(24),
            action_kind: 1,
        }),
        JurisdictionEvent::EntityProviderActionCancelled(EntityProviderActionCancelledEvent {
            metadata: metadata(),
            entity_id: left.clone(),
            action_nonce: 25.into(),
            cancelled_action_hash: b32(26),
            cancelled_action_kind: 0,
            cancel_hash: b32(27),
        }),
        JurisdictionEvent::DebtCreated(DebtCreatedEvent {
            metadata: metadata(),
            debtor: left_text.clone(),
            creditor: right_text.clone(),
            token_id: 28,
            amount: 29.into(),
            debt_index: 30,
        }),
        JurisdictionEvent::DisputeStarted(DisputeStartedEvent {
            metadata: metadata(),
            sender: left_text.clone(),
            counterentity: right_text.clone(),
            nonce: 31.into(),
            proposer_is_left: true,
            proofbody_hash: hex_bytes(&b32(32)),
            watch_seed: b32(5),
            starter_initial_arguments: vec![0x12, 0x34],
            starter_counter_arguments: vec![0xab, 0xcd],
            starter_counter_proof_commitment: b32(33),
            initial_proofbody: proof(),
            dispute_timeout: 109,
            dispute_start_timestamp: 100,
            left_response_seconds: 4,
            right_response_seconds: 5,
            batch_nonce: Some(2),
        }),
        JurisdictionEvent::DisputeFinalized(DisputeFinalizedEvent {
            metadata: metadata(),
            sender: left_text.clone(),
            counterentity: right_text.clone(),
            initial_nonce: 31.into(),
            initial_proofbody_hash: hex_bytes(&b32(32)),
            final_proofbody_hash: hex_bytes(&b32(34)),
            finalization_evidence_hash: hex_bytes(&b32(35)),
            final_proofbody: proof(),
            batch_nonce: Some(2),
        }),
        JurisdictionEvent::CounterDisputeRegistered(CounterDisputeRegisteredEvent {
            metadata: metadata(),
            sender: left_text.clone(),
            counterentity: right_text.clone(),
            nonce: 36,
            proposer_is_left: false,
            proofbody_hash: b32(37),
            counter_proofbody: proof(),
        }),
        JurisdictionEvent::HashLadderRevealRegistered(HashLadderRevealRegisteredEvent {
            metadata: metadata(),
            entity: left_text.clone(),
            counterparty_entity: right_text.clone(),
            ladder_hash: b32(38),
            fill_ratio: 39,
            full_secret: b32(40),
            reveals: [b32(41), b32(42), b32(43), b32(44)],
            target_role: true,
            revealed_at: 45,
        }),
        JurisdictionEvent::DebtEnforced(DebtEnforcedEvent {
            metadata: metadata(),
            debtor: left_text.clone(),
            creditor: right_text.clone(),
            token_id: 28,
            amount_paid: 46.into(),
            remaining_amount: 47.into(),
            new_debt_index: 48,
        }),
        JurisdictionEvent::DebtForgiven(DebtForgivenEvent {
            metadata: metadata(),
            debtor: left_text,
            creditor: right_text,
            token_id: 28,
            amount_forgiven: 49.into(),
            debt_index: 50,
        }),
    ]
}

#[test]
fn all_eighteen_events_round_trip_and_match_typescript_hash() {
    let events = catalog();
    assert_eq!(events.len(), 18);
    for event in &events {
        let wire = encode_jurisdiction_event(event).expect("encode event");
        assert_eq!(
            decode_jurisdiction_event(&wire).expect("decode event"),
            *event
        );
    }
    assert_eq!(
        hex_bytes(&canonical_events_hash(&events).expect("events hash")),
        "0xf6b1ebbd287475146ee7443b5c892d762eaf94fc2c1462032d391f91f2980f8c",
    );
}

#[test]
fn dispute_finalization_evidence_matches_typescript_hash() {
    let evidence = vec![
        DisputeFinalizationEvidence {
            sender: hex_bytes(&b32(4)),
            counterentity: hex_bytes(&b32(3)),
            initial_nonce: " 2 ".into(),
            final_nonce: "3".into(),
            initial_proofbody_hash: hex_bytes(&b32(4)).to_uppercase().replacen("0X", "0x", 1),
            final_proofbody_hash: hex_bytes(&b32(5)),
            proposer_is_left: false,
            left_arguments: "0xABCD".into(),
            right_arguments: "0x12".into(),
            started_by_left: true,
            sig: "0xAB".into(),
        },
        DisputeFinalizationEvidence {
            sender: hex_bytes(&b32(3)),
            counterentity: hex_bytes(&b32(4)),
            initial_nonce: "1".into(),
            final_nonce: "2".into(),
            initial_proofbody_hash: hex_bytes(&b32(5)),
            final_proofbody_hash: hex_bytes(&b32(6)),
            proposer_is_left: true,
            left_arguments: "0x".into(),
            right_arguments: "0x34".into(),
            started_by_left: false,
            sig: "0xCD".into(),
        },
    ];
    assert_eq!(
        hex_bytes(&canonical_dispute_finalization_evidence_hash(&evidence).expect("evidence hash")),
        "0x99e4f6e3cba3e92add03d1c3d06122054a3b87e3c9bd5f34fa4b69c49522f37a",
    );
}

#[test]
fn account_settled_wire_tag_and_arity_remain_unchanged() {
    let event = catalog().remove(7);
    let wire = encode_jurisdiction_event(&event).expect("encode event");
    let xln_rscore_abi::AbiValue::Tuple(row) = wire else {
        panic!("tuple")
    };
    assert_eq!(row.len(), 10);
    assert_eq!(row.fields()[0], xln_rscore_abi::AbiValue::Integer(0));
}
