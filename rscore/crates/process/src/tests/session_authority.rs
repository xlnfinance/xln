use xln_rscore_abi::{AbiValue, Envelope, MessageKind, OpTag};

use crate::ProcessSession;
use crate::test_fixture::{hello, hello_authority, load_accounts, request, shutdown};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

fn assert_ok(envelope: Envelope) {
    assert_eq!(envelope.message_kind, MessageKind::Ok, "{envelope:?}");
}

fn assert_error(envelope: Envelope, expected: &str) {
    assert_eq!(envelope.message_kind, MessageKind::Error);
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("error payload must be tuple")
    };
    let [AbiValue::Text(code), AbiValue::Text(message)] = payload.fields() else {
        panic!("error must be [code,message]")
    };
    assert!(
        code.contains(expected) || message.contains(expected),
        "actual error: code={code} message={message}"
    );
}

#[test]
fn process_rejects_the_retired_non_authority_engine_at_hello() {
    let mut session = ProcessSession::new();
    assert_error(
        session.handle(hello(0)).envelope,
        "RSCORE_PROCESS_AUTHORITY_REQUIRED",
    );
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
}

#[test]
fn authority_hello_pins_the_exact_protocol_binding() {
    let mut session = ProcessSession::new();
    let mut wrong = hello_authority(0, SEED, "1");
    wrong.binding.protocol_fingerprint[31] ^= 1;
    assert_error(
        session.handle(wrong).envelope,
        "RSCORE_PROCESS_PROTOCOL_FINGERPRINT",
    );
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
}

#[test]
fn malformed_outer_command_does_not_spend_the_request_id() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_error(
        session
            .handle(request(1, OpTag::Shutdown, vec![AbiValue::Integer(1)]))
            .envelope,
        "RSCORE_PROCESS_ARITY:shutdown:1:0",
    );
    let stopped = session.handle(shutdown(1));
    assert_ok(stopped.envelope);
    assert!(stopped.shutdown);
}

#[test]
fn authority_bootstrap_accepts_only_empty_revision_zero() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_error(
        session.handle(load_accounts(1, 7)).envelope,
        "RSCORE_PROCESS_AUTHORITY_BOOTSTRAP_INVALID",
    );
    let loaded = session.handle(load_accounts(2, 0)).envelope;
    assert_ok(loaded.clone());
    let AbiValue::Tuple(payload) = &loaded.body.fields()[0] else {
        panic!("bootstrap payload must be a tuple")
    };
    let [
        AbiValue::Integer(0),
        AbiValue::Bytes(root),
        AbiValue::Tuple(checkpoint),
    ] = payload.fields()
    else {
        panic!("bootstrap must return revision, root and exact checkpoint")
    };
    assert_eq!(root, &[0; 32]);
    assert_eq!(checkpoint.fields().len(), 4);
}

#[test]
fn checkpoint_barrier_exports_only_the_expected_accepted_root() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(session.handle(load_accounts(1, 0)).envelope);
    assert_error(
        session
            .handle(request(
                2,
                OpTag::Checkpoint,
                vec![AbiValue::Bytes(vec![1; 32])],
            ))
            .envelope,
        "RSCORE_PROCESS_CHECKPOINT_ROOT_MISMATCH",
    );
    let checkpoint = session
        .handle(request(
            3,
            OpTag::Checkpoint,
            vec![AbiValue::Bytes(vec![0; 32])],
        ))
        .envelope;
    assert_ok(checkpoint.clone());
    let AbiValue::Tuple(payload) = &checkpoint.body.fields()[0] else {
        panic!("checkpoint payload must be a tuple")
    };
    let [AbiValue::Tuple(changes)] = payload.fields() else {
        panic!("checkpoint must return exact changes")
    };
    assert_eq!(changes.fields().len(), 4);
}

#[test]
fn pre_integration_tag_seven_protocol_is_rejected_before_checkpoint_decode() {
    let mut session = ProcessSession::new();
    let mut obsolete = hello_authority(0, SEED, "1");
    obsolete.binding.protocol_version = 1;
    assert_error(
        session.handle(obsolete).envelope,
        "RSCORE_PROCESS_PROTOCOL_VERSION",
    );
    let mut obsolete = hello_authority(0, SEED, "1");
    obsolete.binding.protocol_fingerprint = [
        0x0d, 0x0e, 0x71, 0xb6, 0x1e, 0x83, 0x19, 0xa6, 0xa3, 0x51, 0x40, 0x59, 0xb0, 0x16, 0x7b,
        0x56, 0xf0, 0xb0, 0x3a, 0x22, 0x42, 0x29, 0x37, 0x73, 0x11, 0x84, 0xb4, 0xb3, 0xa9, 0xcf,
        0xac, 0xeb,
    ];
    assert_error(
        session.handle(obsolete).envelope,
        "RSCORE_PROCESS_PROTOCOL_FINGERPRINT",
    );
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
}
