use std::io::Cursor;

use xln_rscore_abi::{AbiValue, Envelope, MessageKind, OpTag, decode_envelope, encode_envelope};

use crate::test_fixture::{
    candidate_command, committed_lock, hello, load, load_profile, prepare, request, shutdown,
};
use crate::{ProcessSession, read_frame, serve, write_frame};

#[test]
fn revision_zero_restore_prepare_abort_reprepare_commit_is_atomic() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_ok(session.handle(load(1, 0, Vec::new())).envelope);
    let first = session.handle(prepare(2, 7)).envelope;
    assert_ok(first.clone());
    assert_ok(
        session
            .handle(candidate_command(3, OpTag::AbortRuntime, 2))
            .envelope,
    );
    let second = session.handle(prepare(4, 7)).envelope;
    assert_ok(second.clone());
    assert_eq!(first.body, second.body);
    assert_ok(
        session
            .handle(candidate_command(5, OpTag::CommitRuntime, 4))
            .envelope,
    );
    let after_commit = session.handle(prepare(6, 7)).envelope;
    assert_ok(after_commit.clone());
    assert_eq!(prepared_revisions(&after_commit), (1, 2));
}

#[test]
fn restore_preserves_revision_and_accepts_committed_htlc_rows() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_ok(session.handle(load(1, 41, vec![committed_lock()])).envelope);
    let prepared = session.handle(prepare(2, 1)).envelope;
    assert_ok(prepared.clone());
    assert_eq!(prepared_revisions(&prepared), (41, 42));
    assert_prepared_payment_profile_root(&prepared);
}

#[test]
fn wrong_prepare_id_is_loud_and_keeps_candidate_committable() {
    let mut session = ready_session();
    assert_ok(session.handle(prepare(2, 3)).envelope);
    assert_error(
        session
            .handle(candidate_command(3, OpTag::CommitRuntime, 99))
            .envelope,
        "RSCORE_PROCESS_PREPARE_ID_MISMATCH",
    );
    assert_ok(
        session
            .handle(candidate_command(4, OpTag::CommitRuntime, 2))
            .envelope,
    );
}

#[test]
fn shutdown_requires_explicit_abort_and_transport_frames_every_reply() {
    let requests = [
        hello(0),
        load(1, 0, Vec::new()),
        prepare(2, 4),
        shutdown(3),
        candidate_command(4, OpTag::AbortRuntime, 2),
        shutdown(5),
    ];
    let mut input = Vec::new();
    for request in requests {
        write_frame(
            &mut input,
            &encode_envelope(&request).expect("encode request"),
        )
        .expect("frame request");
    }
    let mut output = Vec::new();
    serve(&mut Cursor::new(input), &mut output).expect("serve framed session");
    let mut cursor = Cursor::new(output);
    let replies = std::iter::from_fn(|| read_frame(&mut cursor).transpose())
        .collect::<Result<Vec<_>, _>>()
        .expect("read replies");
    assert_eq!(replies.len(), 6);
    let decoded = replies
        .iter()
        .map(|frame| decode_envelope(frame, 1).expect("decode reply"))
        .collect::<Vec<_>>();
    assert_eq!(decoded[3].message_kind, MessageKind::Error);
    assert_eq!(decoded[5].message_kind, MessageKind::Ok);
}

#[test]
fn binding_and_request_sequence_are_pinned_by_hello() {
    let mut session = ready_session();
    let mut foreign = prepare(2, 1);
    foreign.identity.session_id[0] ^= 1;
    assert_error(
        session.handle(foreign).envelope,
        "RSCORE_PROCESS_IDENTITY_MISMATCH",
    );
    assert_ok(session.handle(prepare(2, 1)).envelope);
    assert_error(
        session.handle(prepare(2, 1)).envelope,
        "RSCORE_PROCESS_REQUEST_ID:2:3",
    );
}

#[test]
fn restore_profile_is_explicit_and_begin_runtime_is_not_repurposed() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_error(
        session
            .handle(load_profile(1, "full-h1", 0, Vec::new()))
            .envelope,
        "RSCORE_PROCESS_PROFILE:full-h1",
    );
    assert_ok(session.handle(load(2, 0, Vec::new())).envelope);
    assert_error(
        session
            .handle(request(3, OpTag::BeginRuntime, Vec::new()))
            .envelope,
        "RSCORE_PROCESS_OP_UNSUPPORTED:2",
    );
}

#[test]
fn transport_requires_explicit_shutdown_and_distinguishes_truncation() {
    let mut output = Vec::new();
    let eof = serve(&mut Cursor::new(Vec::<u8>::new()), &mut output)
        .expect_err("EOF without shutdown must fail");
    assert!(matches!(eof, crate::ProcessError::EofBeforeShutdown));

    let truncated =
        read_frame(&mut Cursor::new(vec![0, 0])).expect_err("partial frame header must fail");
    assert!(matches!(truncated, crate::ProcessError::TruncatedFrame));
}

fn ready_session() -> ProcessSession {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_ok(session.handle(load(1, 0, Vec::new())).envelope);
    session
}

fn prepared_revisions(envelope: &Envelope) -> (i128, i128) {
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("response payload must be tuple")
    };
    let AbiValue::Integer(base) = payload.fields()[0] else {
        panic!("base revision must be integer")
    };
    let AbiValue::Integer(next) = payload.fields()[1] else {
        panic!("next revision must be integer")
    };
    (base, next)
}

fn assert_prepared_payment_profile_root(envelope: &Envelope) {
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("response payload must be tuple")
    };
    let AbiValue::Tuple(roots) = &payload.fields()[4] else {
        panic!("prepared roots must be tuple")
    };
    let [AbiValue::Tuple(root)] = roots.fields() else {
        panic!("one changed account root expected")
    };
    let [AbiValue::Bytes(account_id), AbiValue::Bytes(profile_root)] = root.fields() else {
        panic!("root row must be [accountId,paymentProfileRoot]")
    };
    assert_eq!(account_id.len(), 32);
    assert_eq!(profile_root.len(), 32);
}

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
