use std::io::Cursor;

use xln_rscore_abi::{AbiValue, Envelope, MessageKind, OpTag, decode_envelope, encode_envelope};

use crate::test_fixture::{
    candidate_command, committed_lock, hello, load, load_profile, prepare, prepare_htlc_lifecycle,
    request, shutdown,
};
use crate::{ProcessSession, read_frame, serve, write_frame};

#[test]
fn hello_requires_exact_build_owned_payment_profile_binding() {
    assert_eq!(
        hex::encode(crate::PAYMENT_PROFILE_BINDING.protocol_fingerprint),
        "883bd6650cbc2fdd9ff73ada850f1b876c976f53d3721b987b615e9304333d4f"
    );

    let mut session = ProcessSession::new();
    let mut wrong_protocol = hello(0);
    wrong_protocol.binding.protocol_version -= 1;
    assert_error(
        session.handle(wrong_protocol).envelope,
        "RSCORE_PROCESS_PROTOCOL_VERSION:0:1",
    );

    let mut wrong_schema = hello(0);
    wrong_schema.binding.storage_schema_version -= 1;
    assert_error(
        session.handle(wrong_schema).envelope,
        "RSCORE_PROCESS_STORAGE_SCHEMA_VERSION:0:1",
    );

    let mut wrong_fingerprint = hello(0);
    wrong_fingerprint.binding.protocol_fingerprint[31] ^= 1;
    assert_error(
        session.handle(wrong_fingerprint).envelope,
        "RSCORE_PROCESS_PROTOCOL_FINGERPRINT",
    );

    assert_ok(session.handle(hello(0)).envelope);
}

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
fn process_wire_executes_same_account_htlc_lock_and_secret_resolve() {
    let mut session = ready_session();
    let prepared = session.handle(prepare_htlc_lifecycle(2)).envelope;
    assert_ok(prepared.clone());
    let AbiValue::Tuple(payload) = &prepared.body.fields()[0] else {
        panic!("response payload must be tuple")
    };
    let AbiValue::Tuple(outputs) = &payload.fields()[3] else {
        panic!("prepared outputs must be tuple")
    };
    assert_eq!(outputs.len(), 1);
    assert_ok(
        session
            .handle(candidate_command(3, OpTag::CommitRuntime, 2))
            .envelope,
    );
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

#[test]
fn upsert_accounts_creates_between_waves_and_is_refused_while_pending() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    let loaded = session.handle(load(1, 0, Vec::new())).envelope;
    assert_ok(loaded.clone());
    let root_after_restore = body_bytes(&loaded, 1);

    // Create a fresh account between waves: the accounts root must move.
    let upserted = session
        .handle(request(
            2,
            OpTag::UpsertAccounts,
            vec![tuple_of(vec![crate::test_fixture::account_with_id(
                0x7a,
                Vec::new(),
            )])],
        ))
        .envelope;
    assert_ok(upserted.clone());
    let root_after_upsert = body_bytes(&upserted, 1);
    assert_ne!(root_after_restore, root_after_upsert);

    // While a prepare is pending the upsert is refused: a candidate must
    // never straddle a membership change.
    assert_ok(session.handle(crate::test_fixture::prepare(3, 5)).envelope);
    assert_error(
        session
            .handle(request(
                4,
                OpTag::UpsertAccounts,
                vec![tuple_of(vec![crate::test_fixture::account_with_id(
                    0x7b,
                    Vec::new(),
                )])],
            ))
            .envelope,
        "RSCORE_PROCESS_PREPARE_PENDING",
    );
}

fn body_bytes(envelope: &Envelope, index: usize) -> Vec<u8> {
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("payload tuple expected");
    };
    let AbiValue::Bytes(bytes) = &payload.fields()[index] else {
        panic!("bytes expected at {index}");
    };
    bytes.clone()
}

#[test]
fn capacity_batch_and_summary_page_read_committed_state() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_ok(session.handle(load(1, 3, vec![committed_lock()])).envelope);

    let account = crate::test_fixture::fixture_account_id();
    let capacity = session
        .handle(request(
            2,
            OpTag::ReadCapacityBatch,
            vec![tuple_of(vec![
                tuple_of(vec![
                    AbiValue::Bytes(account.to_vec()),
                    AbiValue::Integer(1),
                    AbiValue::Integer(0),
                ]),
                tuple_of(vec![
                    AbiValue::Bytes(vec![0x00; 32]),
                    AbiValue::Integer(1),
                    AbiValue::Integer(0),
                ]),
            ])],
        ))
        .envelope;
    assert_ok(capacity.clone());
    let AbiValue::Tuple(payload) = &capacity.body.fields()[0] else {
        panic!("capacity payload tuple expected");
    };
    let fields = payload.fields();
    assert_eq!(fields[0], AbiValue::Integer(3));
    let AbiValue::Tuple(rows) = &fields[1] else {
        panic!("rows tuple expected");
    };
    assert_eq!(rows.fields().len(), 2);
    // Existing account row carries four text scalars; unknown account is Nil.
    assert!(matches!(&rows.fields()[0], AbiValue::Tuple(row) if row.fields().len() == 4));
    assert_eq!(rows.fields()[1], AbiValue::Nil);

    let page = session
        .handle(request(
            3,
            OpTag::ReadAccountSummaryPage,
            vec![
                AbiValue::Nil,
                AbiValue::Integer(16),
                tuple_of(vec![AbiValue::Integer(1), AbiValue::Integer(2)]),
            ],
        ))
        .envelope;
    assert_ok(page.clone());
    let AbiValue::Tuple(payload) = &page.body.fields()[0] else {
        panic!("page payload tuple expected");
    };
    let fields = payload.fields();
    assert_eq!(fields[0], AbiValue::Integer(3));
    let AbiValue::Tuple(rows) = &fields[1] else {
        panic!("summary rows expected");
    };
    assert_eq!(rows.fields().len(), 1);
    let AbiValue::Tuple(row) = &rows.fields()[0] else {
        panic!("summary row tuple expected");
    };
    // account id, owner side, delta rows, lock count, two 32-byte roots
    assert_eq!(row.fields()[0], AbiValue::Bytes(account.to_vec()));
    assert_eq!(row.fields()[2], AbiValue::Integer(1));
    assert_eq!(row.fields()[3], AbiValue::Integer(1));
    assert_eq!(fields[2], AbiValue::Nil, "single page has no cursor");
    let AbiValue::Tuple(totals) = &fields[3] else {
        panic!("totals tuple expected");
    };
    assert_eq!(totals.fields()[0], AbiValue::Integer(1));
    assert_eq!(totals.fields()[1], AbiValue::Integer(1));
    let AbiValue::Tuple(tokens) = &totals.fields()[2] else {
        panic!("token totals expected");
    };
    let AbiValue::Tuple(token_one) = &tokens.fields()[0] else {
        panic!("token row expected");
    };
    assert_eq!(token_one.fields()[1], AbiValue::Integer(1));
    assert_eq!(token_one.fields()[2], AbiValue::Text("1000000".into()));
    let AbiValue::Tuple(token_two) = &tokens.fields()[1] else {
        panic!("token row expected");
    };
    assert_eq!(token_two.fields()[1], AbiValue::Integer(0));

    // Read-only ops must not disturb the atomic write lifecycle.
    let prepared = session.handle(prepare(4, 5)).envelope;
    assert_ok(prepared);
}

fn tuple_of(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(fields))
}
