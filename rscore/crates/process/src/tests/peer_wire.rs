use xln_rscore_abi::AbiValue;
use xln_rscore_batch::{AccountId, AccountInputKind, AccountInputResult, AccountInputVerdict};
use xln_rscore_engine::{AccountFrame, FrameAckPhase, HtlcEvidenceSecret, SignedIncomingFrame};

use crate::wire_decode::decode_input_row;
use crate::wire_encode::input_result;

#[path = "peer_wire_fixture.rs"]
mod fixture;
use fixture::*;

#[test]
fn exact_peer_variants_round_trip_without_losing_received_fields() {
    let value = frame_ack_row();
    let bytes = xln_rscore_abi::encode_value(&value).expect("encode exact peer row");
    let wire = xln_rscore_abi::decode_value(&bytes).expect("decode exact peer row");
    assert_eq!(wire, value, "the canonical tuple survives MessagePack");

    let row = decode_input_row(&wire).expect("decode frame_ack");
    assert_eq!(row.operation_index, 7);
    assert_eq!(row.account_id.as_bytes(), &[0x11; 32]);
    assert_eq!(row.input.envelope.from_entity_id, [0x11; 32]);
    assert_eq!(row.input.envelope.to_entity_id, [0x22; 32]);
    assert_eq!(row.input.envelope.domain.chain_id(), 31_337);
    assert_eq!(
        row.input.envelope.domain.depository_address().bytes(),
        &[0x33; 20]
    );
    assert_eq!(
        row.input.envelope.dispute_config.left_response_seconds(),
        17
    );
    assert_eq!(
        row.input.envelope.dispute_config.right_response_seconds(),
        29
    );
    assert_eq!(
        row.input
            .envelope
            .watch_seed
            .as_ref()
            .expect("watch seed")
            .bytes(),
        &[0x44; 32]
    );

    let AccountInputKind::FrameAck {
        ack: incoming_ack,
        frame,
    } = row.input.kind
    else {
        panic!("one canonical FrameAck expected")
    };
    assert_eq!(incoming_ack.height, 42, "ACK is the first composite phase");
    assert_eq!(incoming_ack.frame_hash, [0xbb; 32]);
    assert_eq!(incoming_ack.frame_hanko, None);
    let ack_dispute = incoming_ack.dispute.expect("ACK dispute");
    assert_eq!(ack_dispute.hanko, None);
    assert_eq!(ack_dispute.hash, [0xcc; 32]);
    assert_eq!(ack_dispute.proof_body_hash, [0xcd; 32]);
    assert_eq!(ack_dispute.nonce, 62);
    assert!(ack_dispute.proposer_is_left);

    assert_eq!(frame.frame.height, 41);
    assert_eq!(frame.frame.timestamp, 1_700_000_000_123);
    assert_eq!(frame.frame.j_height, 51);
    assert_eq!(frame.frame.prev_frame_hash, "prev-41");
    assert_eq!(frame.frame.account_state_root, [0x55; 32]);
    assert_eq!(frame.state_hash, [0x66; 32]);
    assert_eq!(frame.frame_hanko, Some(vec![0x77, 0x78]));
    let frame_dispute = frame.dispute.expect("proposal dispute");
    assert_eq!(frame_dispute.hanko, Some(vec![0x88]));
    assert_eq!(frame_dispute.hash, [0x89; 32]);
    assert_eq!(frame_dispute.proof_body_hash, [0x8a; 32]);
    assert_eq!(frame_dispute.nonce, 61);
    assert!(!frame_dispute.proposer_is_left);

    assert!(matches!(
        decode_input_row(&peer_row(tuple(vec![AbiValue::Integer(0), proposal()])))
            .expect("standalone frame")
            .input
            .kind,
        AccountInputKind::Frame(_)
    ));
    assert!(matches!(
        decode_input_row(&peer_row(tuple(vec![AbiValue::Integer(1), ack()])))
            .expect("standalone ack")
            .input
            .kind,
        AccountInputKind::Ack(_)
    ));

    let no_optional_proposal = replace_at(
        &replace_at(&proposal(), &[1], AbiValue::Nil),
        &[2],
        AbiValue::Nil,
    );
    let no_optionals = replace_at(
        &peer_row(tuple(vec![AbiValue::Integer(0), no_optional_proposal])),
        &[2, 4],
        AbiValue::Nil,
    );
    let omitted = decode_input_row(&no_optionals).expect("explicit Nil optionals");
    assert_eq!(omitted.input.envelope.watch_seed, None);
    let AccountInputKind::Frame(frame) = omitted.input.kind else {
        panic!("standalone frame expected")
    };
    assert_eq!(frame.frame_hanko, None);
    assert_eq!(frame.dispute, None);
}

#[test]
fn inbound_genesis_policy_is_typed_exact_and_not_peer_derived() {
    let policy = tuple(vec![
        tuple(vec![
            AbiValue::Integer(31_337),
            AbiValue::Bytes(vec![0x33; 20]),
        ]),
        AbiValue::Bytes(vec![0x91; 32]),
        AbiValue::Bytes(vec![0x92; 20]),
        AbiValue::Bool(false),
    ]);
    let value = replace_at(&frame_ack_row(), &[3], policy);
    let row = decode_input_row(&value).expect("decode typed genesis policy");
    let genesis = row.genesis_policy.expect("genesis policy");
    assert_eq!(genesis.expected_domain.chain_id(), 31_337);
    assert_eq!(
        genesis.expected_domain.depository_address().bytes(),
        &[0x33; 20]
    );
    assert_eq!(genesis.shadow_policy_root, [0x91; 32]);
    assert_eq!(genesis.delta_transformer, [0x92; 20]);
    assert!(!genesis.public_pinned);

    for mutation in [
        width_at(&value, &[3, 1], 31),
        width_at(&value, &[3, 2], 21),
        replace_at(&value, &[3, 3], AbiValue::Integer(0)),
    ] {
        assert!(decode_input_row(&mutation).is_err());
    }
}

#[test]
fn certified_board_authority_is_typed_local_context() {
    let authority = |current: u8, previous: u8| {
        tuple(vec![
            AbiValue::Bytes(vec![current; 32]),
            AbiValue::Bytes(vec![previous; 32]),
            AbiValue::Integer(1_700_604_800),
            AbiValue::Integer(19),
            AbiValue::Integer(2),
        ])
    };
    let value = replace_at(
        &frame_ack_row(),
        &[4],
        tuple(vec![authority(0xa3, 0xa2), authority(0xb3, 0xb2)]),
    );
    let row = decode_input_row(&value).expect("decode certified board authority");
    let xln_rscore_batch::PeerBoardAuthority::Certified(authority) = row.certified_board_authority
    else {
        panic!("certified board authority")
    };
    assert_eq!(authority.registered_board_hash, [0xa3; 32]);
    assert_eq!(authority.previous_board_hash, [0xa2; 32]);
    let xln_rscore_batch::PeerBoardAuthority::Certified(local) =
        row.local_certified_board_authority
    else {
        panic!("local certified board authority")
    };
    assert_eq!(local.entity_id, [0x22; 32]);
    assert_eq!(local.registered_board_hash, [0xb3; 32]);
    assert_eq!(local.previous_board_hash, [0xb2; 32]);
    assert_eq!(local.previous_board_valid_until, 1_700_604_800);
    assert!(decode_input_row(&width_at(&value, &[4, 0, 0], 31)).is_err());
    assert!(decode_input_row(&width_at(&value, &[4, 1, 1], 31)).is_err());
}

#[test]
fn exact_peer_decoder_rejects_mutated_shapes_widths_and_aliases() {
    let canonical = frame_ack_row();
    let cases = vec![
        ("row trailing", append_at(&canonical, &[])),
        ("row missing", remove_last_at(&canonical, &[])),
        ("envelope trailing", append_at(&canonical, &[2])),
        ("envelope missing", remove_last_at(&canonical, &[2])),
        ("domain trailing", append_at(&canonical, &[2, 2])),
        ("domain missing", remove_last_at(&canonical, &[2, 2])),
        ("config trailing", append_at(&canonical, &[2, 3])),
        ("config missing", remove_last_at(&canonical, &[2, 3])),
        ("kind trailing", append_at(&canonical, &[2, 5])),
        ("ack trailing", append_at(&canonical, &[2, 5, 1])),
        ("ack missing", remove_last_at(&canonical, &[2, 5, 1])),
        ("proposal trailing", append_at(&canonical, &[2, 5, 2])),
        ("proposal missing", remove_last_at(&canonical, &[2, 5, 2])),
        ("frame trailing", append_at(&canonical, &[2, 5, 2, 0])),
        ("frame missing", remove_last_at(&canonical, &[2, 5, 2, 0])),
        ("dispute trailing", append_at(&canonical, &[2, 5, 2, 2])),
        ("dispute missing", remove_last_at(&canonical, &[2, 5, 2, 2])),
        (
            "unknown tag",
            replace_at(&canonical, &[2, 5, 0], AbiValue::Integer(3)),
        ),
        ("account width", width_at(&canonical, &[1], 31)),
        ("from width", width_at(&canonical, &[2, 0], 31)),
        ("to width", width_at(&canonical, &[2, 1], 33)),
        ("depository width", width_at(&canonical, &[2, 2, 1], 19)),
        ("watch width", width_at(&canonical, &[2, 4], 31)),
        (
            "frame root width",
            width_at(&canonical, &[2, 5, 2, 0, 5], 31),
        ),
        (
            "state hash width",
            width_at(&canonical, &[2, 5, 2, 0, 6], 33),
        ),
        ("ack hash width", width_at(&canonical, &[2, 5, 1, 1], 31)),
        (
            "dispute hash width",
            width_at(&canonical, &[2, 5, 2, 2, 1], 31),
        ),
        (
            "proof hash width",
            width_at(&canonical, &[2, 5, 2, 2, 2], 33),
        ),
        (
            "role integer alias",
            replace_at(&canonical, &[2, 5, 2, 2, 4], AbiValue::Integer(0)),
        ),
        (
            "frame Hanko text alias",
            replace_at(&canonical, &[2, 5, 2, 1], AbiValue::Text("77".into())),
        ),
        (
            "dispute Hanko text alias",
            replace_at(&canonical, &[2, 5, 2, 2, 0], AbiValue::Text("88".into())),
        ),
        (
            "operation negative",
            replace_at(&canonical, &[0], AbiValue::Integer(-1)),
        ),
        (
            "operation unsafe",
            replace_at(&canonical, &[0], AbiValue::Integer(1_i128 << 53)),
        ),
    ];

    for (name, mutation) in cases {
        assert!(
            decode_input_row(&mutation).is_err(),
            "mutation was accepted: {name}"
        );
    }
}

#[test]
fn frame_ack_result_is_one_row_with_ack_before_frame_and_closed_child_domains() {
    let account_id = AccountId::from_bytes([0x11; 32]);
    let result = AccountInputResult {
        operation_index: 17,
        account_id,
        verdict: AccountInputVerdict::FrameAckApplied {
            ack: Box::new(AccountInputVerdict::AckStale { height: 42 }),
            frame: Box::new(AccountInputVerdict::FrameCollisionIgnored {
                height: 43,
                queued: 0,
            }),
        },
    };
    assert_eq!(
        input_result(&result).expect("encode FrameAck result"),
        tuple(vec![
            AbiValue::Integer(17),
            AbiValue::Bytes(vec![0x11; 32]),
            tuple(vec![
                AbiValue::Integer(9),
                tuple(vec![AbiValue::Integer(6), AbiValue::Integer(42)]),
                tuple(vec![
                    AbiValue::Integer(1),
                    AbiValue::Integer(43),
                    AbiValue::Integer(0),
                ]),
            ]),
        ])
    );

    let rejected = AccountInputResult {
        operation_index: 18,
        account_id,
        verdict: AccountInputVerdict::FrameAckRejected {
            phase: FrameAckPhase::Frame,
            reason: "proposal rejected".into(),
        },
    };
    let encoded = input_result(&rejected).expect("encode rejected FrameAck");
    assert_eq!(
        at(&encoded, &[2]),
        &tuple(vec![
            AbiValue::Integer(10),
            AbiValue::Integer(1),
            AbiValue::Text("proposal rejected".into()),
        ])
    );

    let wrong_domains = AccountInputResult {
        operation_index: 19,
        account_id,
        verdict: AccountInputVerdict::FrameAckApplied {
            ack: Box::new(AccountInputVerdict::FrameCollisionIgnored {
                height: 1,
                queued: 0,
            }),
            frame: Box::new(AccountInputVerdict::AckStale { height: 1 }),
        },
    };
    assert!(input_result(&wrong_domains).is_err());
}

#[test]
fn dispute_required_verdict_carries_exact_secret_and_signed_frame() {
    let result = AccountInputResult {
        operation_index: 20,
        account_id: AccountId::from_bytes([0x11; 32]),
        verdict: AccountInputVerdict::FrameDisputeRequired {
            reason: "HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT".into(),
            evidence_secrets: vec![HtlcEvidenceSecret {
                hashlock: format!("0x{}", "22".repeat(32)),
                secret: format!("0x{}", "33".repeat(32)),
            }],
            signed_frame: SignedIncomingFrame {
                frame: AccountFrame {
                    height: 3,
                    timestamp: 1_700_000_000_000,
                    j_height: 9,
                    txs: Vec::new(),
                    prev_frame_hash: format!("0x{}", "44".repeat(32)),
                    account_state_root: [0x55; 32],
                },
                state_hash: [0x66; 32],
                frame_hanko: vec![0x77, 0x78],
            },
        },
    };
    let encoded = input_result(&result).expect("encode dispute required");
    let verdict = at(&encoded, &[2]);
    assert_eq!(at(verdict, &[0]), &AbiValue::Integer(11));
    assert_eq!(
        at(verdict, &[1]),
        &AbiValue::Text("HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT".into()),
    );
    assert_eq!(
        at(verdict, &[2, 0]),
        &tuple(vec![
            AbiValue::Text(format!("0x{}", "22".repeat(32))),
            AbiValue::Text(format!("0x{}", "33".repeat(32))),
        ]),
    );
    assert_eq!(at(verdict, &[3, 0]), &AbiValue::Integer(3));
    assert_eq!(at(verdict, &[3, 6]), &AbiValue::Bytes(vec![0x66; 32]));
    assert_eq!(at(verdict, &[3, 7]), &AbiValue::Bytes(vec![0x77, 0x78]));
}
