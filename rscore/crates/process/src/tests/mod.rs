use std::io::Cursor;

use xln_rscore_abi::{AbiValue, Envelope, MessageKind, OpTag};

use crate::test_fixture::{
    candidate_command, committed_lock, hello, load, load_profile, prepare, prepare_htlc_lifecycle,
    request, shutdown,
};
use crate::{ProcessSession, read_frame, serve};

mod peer_wire;

#[test]
fn hello_requires_exact_build_owned_payment_profile_binding() {
    assert_eq!(
        hex::encode(crate::PAYMENT_PROFILE_BINDING.protocol_fingerprint),
        "c53168cc9945a471eea8b6f966fb4252aaa6bd0dfb1b4867044ade62b544f8be"
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
fn account_outbound_decodes_the_exact_failed_htlc_route_closure() {
    let tuple = |fields| AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(fields));
    let hashlock = [0x5a; 32];
    let outbound_account = [0x6b; 32];
    let inbound_account = [0x7c; 32];
    let envelope = request(
        0,
        OpTag::AccountOutbound,
        vec![
            AbiValue::Bytes([0x4d; 32].to_vec()),
            AbiValue::Integer(1_700_000_000_000),
            AbiValue::Integer(100),
            tuple(Vec::new()),
            tuple(Vec::new()),
            tuple(vec![AbiValue::Bytes(outbound_account.to_vec())]),
            tuple(Vec::new()),
            tuple(vec![tuple(vec![
                AbiValue::Bytes(hashlock.to_vec()),
                AbiValue::Bytes(outbound_account.to_vec()),
                AbiValue::Text("downstream-lock".into()),
                AbiValue::Bytes(inbound_account.to_vec()),
                AbiValue::Text("upstream-lock".into()),
            ])]),
            AbiValue::Bool(true),
            AbiValue::Bool(false),
        ],
    );
    let crate::wire_decode::Command::AccountOutbound { request } =
        crate::wire_decode::decode_command(&envelope).expect("decode route closure")
    else {
        panic!("expected AccountOutbound");
    };
    assert_eq!(request.failed_htlc_routes.len(), 1);
    let route = &request.failed_htlc_routes[0];
    assert_eq!(route.hashlock, hashlock);
    assert_eq!(route.outbound_account_id.as_bytes(), &outbound_account);
    assert_eq!(route.outbound_lock_id, "downstream-lock");
    assert_eq!(route.inbound_account_id.as_bytes(), &inbound_account);
    assert_eq!(route.inbound_lock_id, "upstream-lock");
    assert!(!request.checkpoint_due);
}

#[test]
fn authority_process_uses_only_resident_inbound_outbound_and_piggybacks_checkpoint() {
    use crate::test_fixture::{authority_entity, authority_genesis_account, hello_authority};

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let tuple = |fields| AbiValue::Tuple(xln_rscore_abi::BodyTuple::from_vec(fields));
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    let loaded = session
        .handle(request(
            1,
            OpTag::BootstrapAccounts,
            vec![
                AbiValue::Text(crate::PROCESS_PROFILE.into()),
                AbiValue::Integer(0),
                tuple(Vec::new()),
                AbiValue::Bool(false),
            ],
        ))
        .envelope;
    assert_ok(loaded.clone());
    let accounts_root = body_bytes(&loaded, 1);

    let inbound = session
        .handle(request(
            2,
            OpTag::AccountInbound,
            vec![
                AbiValue::Bytes(owner.to_vec()),
                AbiValue::Bytes(accounts_root),
                tuple(vec![AbiValue::Integer(1), AbiValue::Integer(1)]),
                tuple(Vec::new()),
                AbiValue::Bool(false),
            ],
        ))
        .envelope;
    assert_ok(inbound.clone());
    assert_round_reply(&inbound, None);

    let outbound = session
        .handle(request(
            3,
            OpTag::AccountOutbound,
            vec![
                AbiValue::Bytes(owner.to_vec()),
                AbiValue::Integer(1),
                AbiValue::Integer(1),
                tuple(vec![authority_genesis_account(owner, peer)]),
                tuple(Vec::new()),
                tuple(Vec::new()),
                tuple(Vec::new()),
                tuple(Vec::new()),
                AbiValue::Bool(false),
                AbiValue::Bool(true),
            ],
        ))
        .envelope;
    assert_ok(outbound.clone());
    assert_round_reply(&outbound, Some(1));

    let outbound_fields = body_fields(&outbound);
    let manifest = exact_tuple(&outbound_fields[8], 4, "checkpoint manifest");
    let commit_token = exact_tuple(&manifest[0], 5, "checkpoint commit token");
    let restore_token = exact_tuple(&manifest[1], 5, "checkpoint restore token");
    assert_eq!(commit_token[0], AbiValue::Integer(0));
    assert_eq!(commit_token[1], restore_token[0]);
    assert_eq!(restore_token[0], restore_token[1]);
    assert_eq!(commit_token[2..], restore_token[2..]);
    let checkpoint_rows = exact_tuple(&manifest[2], 1, "checkpoint rows");
    let restore_rows = checkpoint_rows
        .iter()
        .map(materialize_restore_row)
        .collect::<Vec<_>>();

    let mut restored = ProcessSession::new();
    assert_ok(restored.handle(hello_authority(0, SEED, "1")).envelope);
    let mut wrong_token = restore_token.clone();
    let AbiValue::Bytes(mut wrong_digest) = wrong_token[3].clone() else {
        panic!("signer digest must be bytes")
    };
    wrong_digest[0] ^= 1;
    wrong_token[3] = AbiValue::Bytes(wrong_digest);
    assert_error(
        restored
            .handle(crate::test_fixture::restore_exact(
                1,
                tuple_of(wrong_token),
                restore_rows.clone(),
            ))
            .envelope,
        "RSCORE_BATCH_CHECKPOINT_SIGNER_DIGEST",
    );
    assert_ok(
        restored
            .handle(crate::test_fixture::restore_exact(
                2,
                tuple_of(restore_token),
                restore_rows,
            ))
            .envelope,
    );

    let accepted_root = body_bytes(&outbound, 1);
    let next_inbound = session
        .handle(request(
            4,
            OpTag::AccountInbound,
            vec![
                AbiValue::Bytes(owner.to_vec()),
                AbiValue::Bytes(accepted_root),
                tuple(vec![AbiValue::Integer(2), AbiValue::Integer(2)]),
                tuple(Vec::new()),
                AbiValue::Bool(false),
            ],
        ))
        .envelope;
    assert_ok(next_inbound);
    let empty_checkpoint = session
        .handle(request(
            5,
            OpTag::AccountOutbound,
            vec![
                AbiValue::Bytes(owner.to_vec()),
                AbiValue::Integer(2),
                AbiValue::Integer(2),
                tuple(Vec::new()),
                tuple(Vec::new()),
                tuple(Vec::new()),
                tuple(Vec::new()),
                tuple(Vec::new()),
                AbiValue::Bool(false),
                AbiValue::Bool(true),
            ],
        ))
        .envelope;
    assert_ok(empty_checkpoint.clone());
    assert_round_reply(&empty_checkpoint, Some(0));

    assert_error(
        session
            .handle(candidate_command(6, OpTag::CommitRuntime, [0; 32]))
            .envelope,
        "RSCORE_PROCESS_AUTHORITY_TWO_CALL_ONLY",
    );
    assert_ok(session.handle(shutdown(7)).envelope);
}

fn assert_round_reply(envelope: &Envelope, checkpoint_rows: Option<usize>) {
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("round reply must be a tuple")
    };
    assert_eq!(payload.len(), 11);
    match (checkpoint_rows, &payload.fields()[8]) {
        (None, AbiValue::Nil) => {}
        (Some(expected), AbiValue::Tuple(checkpoint)) => {
            assert_eq!(checkpoint.len(), 4);
            assert_eq!(
                exact_tuple(&checkpoint.fields()[0], 5, "commit token").len(),
                5
            );
            assert_eq!(
                exact_tuple(&checkpoint.fields()[1], 5, "restore token").len(),
                5
            );
            assert_eq!(
                exact_tuple(&checkpoint.fields()[2], expected, "checkpoint accounts").len(),
                expected
            );
            assert!(exact_tuple(&checkpoint.fields()[3], 0, "removed accounts").is_empty());
        }
        (expected, actual) => panic!("checkpoint shape mismatch: {expected:?}: {actual:?}"),
    }
}

#[test]
fn failed_authority_hello_does_not_bind_or_downgrade_the_session() {
    use crate::test_fixture::{hello_authority, hello_authority_key};

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    // Greater than the secp256k1 group order: nonzero and correctly sized, but
    // not a signing key. This reaches authority identity construction rather
    // than being rejected by the wire decoder.
    let mut session = ProcessSession::new();
    let failed = session.handle(hello_authority_key(0, [0xff; 32], "1"));
    assert!(!failed.shutdown);
    assert_error(failed.envelope, "RSCORE_BATCH_SIGNING");
    // Request zero remains available and the role is still undecided. Before
    // the fix this was HELLO_DUPLICATE and request one could bootstrap mirror.
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
}

#[test]
fn revision_zero_restore_prepare_abort_reprepare_commit_is_atomic() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_ok(session.handle(load(1, 0, Vec::new())).envelope);
    let first = session.handle(prepare(2, 7)).envelope;
    assert_ok(first.clone());
    let first_token = candidate_token(&first);
    assert_ok(
        session
            .handle(candidate_command(3, OpTag::AbortRuntime, first_token))
            .envelope,
    );
    let second = session.handle(prepare(4, 7)).envelope;
    assert_ok(second.clone());
    let second_token = candidate_token(&second);
    // The prepared reply carries the engine's own execution microseconds, which
    // are wall-clock by nature: compare everything else byte for byte.
    assert_eq!(
        without_engine_micros(&first.body),
        without_engine_micros(&second.body)
    );
    assert_ok(
        session
            .handle(candidate_command(5, OpTag::CommitRuntime, second_token))
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
    let token = candidate_token(&prepared);
    let AbiValue::Tuple(payload) = &prepared.body.fields()[0] else {
        panic!("response payload must be tuple")
    };
    let AbiValue::Tuple(outputs) = &payload.fields()[3] else {
        panic!("prepared outputs must be tuple")
    };
    assert_eq!(outputs.len(), 1);
    assert_ok(
        session
            .handle(candidate_command(3, OpTag::CommitRuntime, token))
            .envelope,
    );
}

#[test]
fn wrong_candidate_token_is_loud_and_keeps_candidate_committable() {
    let mut session = ready_session();
    let prepared = session.handle(prepare(2, 3)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    assert_error(
        session
            .handle(candidate_command(3, OpTag::CommitRuntime, [0x99; 32]))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_ok(
        session
            .handle(candidate_command(4, OpTag::CommitRuntime, token))
            .envelope,
    );
}

#[test]
fn candidate_tokens_are_bound_to_session_and_process_incarnation() {
    fn for_session(mut request: Envelope, session_byte: u8) -> Envelope {
        request.identity.session_id = [session_byte; 16];
        request
    }

    let mut first = ProcessSession::with_test_incarnation([0x01; 32]);
    assert_ok(first.handle(hello(0)).envelope);
    assert_ok(first.handle(load(1, 0, Vec::new())).envelope);
    let first_prepared = first.handle(prepare(2, 7)).envelope;
    assert_ok(first_prepared.clone());
    let first_token = candidate_token(&first_prepared);

    // Same engine inputs and process incarnation, but another bound session.
    let mut other_session = ProcessSession::with_test_incarnation([0x01; 32]);
    assert_ok(other_session.handle(for_session(hello(0), 0x33)).envelope);
    assert_ok(
        other_session
            .handle(for_session(load(1, 0, Vec::new()), 0x33))
            .envelope,
    );
    let other_prepared = other_session
        .handle(for_session(prepare(2, 7), 0x33))
        .envelope;
    assert_ok(other_prepared.clone());
    let other_token = candidate_token(&other_prepared);
    assert_ne!(first_token, other_token, "session identity binds the token");
    assert_error(
        other_session
            .handle(for_session(
                candidate_command(3, OpTag::AbortRuntime, first_token),
                0x33,
            ))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_ok(
        other_session
            .handle(for_session(
                candidate_command(4, OpTag::AbortRuntime, other_token),
                0x33,
            ))
            .envelope,
    );

    // A process restart may reuse the deterministic engine inputs and request
    // sequence, but its OS-random incarnation makes every old capability dead.
    let mut restarted = ProcessSession::with_test_incarnation([0x02; 32]);
    assert_ok(restarted.handle(hello(0)).envelope);
    assert_ok(restarted.handle(load(1, 0, Vec::new())).envelope);
    let restarted_prepared = restarted.handle(prepare(2, 7)).envelope;
    assert_ok(restarted_prepared.clone());
    let restarted_token = candidate_token(&restarted_prepared);
    assert_ne!(
        first_token, restarted_token,
        "process incarnation binds the token"
    );
    assert_error(
        restarted
            .handle(candidate_command(3, OpTag::AbortRuntime, first_token))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_ok(
        restarted
            .handle(candidate_command(4, OpTag::AbortRuntime, restarted_token))
            .envelope,
    );
}

#[test]
fn shutdown_requires_explicit_abort_and_transport_frames_every_reply() {
    let mut session = ready_session();
    let prepared = session.handle(prepare(2, 4)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    assert_error(
        session.handle(shutdown(3)).envelope,
        "RSCORE_PROCESS_PREPARE_PENDING",
    );
    assert_ok(
        session
            .handle(candidate_command(4, OpTag::AbortRuntime, token))
            .envelope,
    );
    assert_ok(session.handle(shutdown(5)).envelope);
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
fn exact_restore_is_atomic_and_enters_the_resident_two_call_path() {
    use crate::test_fixture::{
        authority_account, authority_entity, hello_authority, restore_authority_accounts_with_rows,
        restore_exact,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut account = exact_tuple(&authority_account(owner, peer), 15, "seed account");
    let mut carried = exact_tuple(&account[11], 8, "carried sections");
    carried[1] = tuple_of(vec![tuple_of(vec![
        AbiValue::Text("resting-offer".to_string()),
        AbiValue::Integer(1),
        AbiValue::Integer(6),
        AbiValue::Text("1000".to_string()),
        AbiValue::Integer(2),
        AbiValue::Integer(6),
        AbiValue::Text("2000".to_string()),
        AbiValue::Text("0".to_string()),
        AbiValue::Text("1900".to_string()),
        AbiValue::Text("2000000".to_string()),
        AbiValue::Nil,
        AbiValue::Integer(if owner <= peer { 0 } else { 1 }),
        AbiValue::Integer(7),
    ])]);
    account[11] = tuple_of(carried);

    let (restore, rows) =
        restore_authority_accounts_with_rows(1, SEED, "1", vec![tuple_of(account)]);
    let restore_fields = body_fields(&restore);
    let token = restore_fields[0].clone();
    let token_fields = exact_tuple(&token, 5, "checkpoint token");
    let mut wrong_token = token_fields.clone();
    let AbiValue::Bytes(mut wrong_root) = wrong_token[2].clone() else {
        panic!("checkpoint root must be bytes")
    };
    wrong_root[0] ^= 1;
    wrong_token[2] = AbiValue::Bytes(wrong_root);

    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_error(
        session
            .handle(restore_exact(1, tuple_of(wrong_token), rows.clone()))
            .envelope,
        "RSCORE_BATCH_CHECKPOINT_ROOT",
    );
    let restored = session
        .handle(restore_exact(2, token.clone(), rows))
        .envelope;
    assert_ok(restored.clone());
    assert_eq!(body_fields(&restored)[0], token);

    let inbound = session
        .handle(request(
            3,
            OpTag::AccountInbound,
            vec![
                AbiValue::Bytes(owner.to_vec()),
                token_fields[2].clone(),
                tuple_of(vec![AbiValue::Integer(1), AbiValue::Integer(1)]),
                tuple_of(Vec::new()),
                AbiValue::Bool(false),
            ],
        ))
        .envelope;
    assert_ok(inbound.clone());
    assert_round_reply(&inbound, None);

    let outbound = session
        .handle(request(
            4,
            OpTag::AccountOutbound,
            vec![
                AbiValue::Bytes(owner.to_vec()),
                AbiValue::Integer(1),
                AbiValue::Integer(1),
                tuple_of(Vec::new()),
                tuple_of(Vec::new()),
                tuple_of(Vec::new()),
                tuple_of(Vec::new()),
                tuple_of(Vec::new()),
                AbiValue::Bool(false),
                AbiValue::Bool(true),
            ],
        ))
        .envelope;
    assert_ok(outbound.clone());
    assert_round_reply(&outbound, Some(0));
    assert_eq!(body_fields(&outbound)[1], token_fields[2]);
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

/// The prepared body minus its trailing timing and ephemeral token fields.
fn without_engine_micros(body: &xln_rscore_abi::BodyTuple) -> Vec<AbiValue> {
    let AbiValue::Tuple(fields) = &body.fields()[0] else {
        panic!("prepared body must be a tuple")
    };
    let fields = fields.fields();
    fields[..fields.len() - 2].to_vec()
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

/// Every mutation of the tree moves the revision.
///
/// A reader paging the accounts detects a tree that moved under it by exactly
/// that number, so a membership or shell change that left the revision alone
/// let a page from before the change and a page from after it be read as one
/// consistent snapshot.
#[test]
fn membership_and_shell_changes_advance_the_revision() {
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello(0)).envelope);
    assert_ok(session.handle(load(1, 7, Vec::new())).envelope);

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
    assert_eq!(body_integer(&upserted, 0), 8);

    let mut account_id = [0_u8; 32];
    account_id[31] = 0x7a;
    let removed = session
        .handle(request(
            3,
            OpTag::RemoveAccounts,
            vec![tuple_of(vec![AbiValue::Bytes(account_id.to_vec())])],
        ))
        .envelope;
    assert_ok(removed.clone());
    assert_eq!(body_integer(&removed, 0), 9);
}

fn body_integer(envelope: &Envelope, index: usize) -> i128 {
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("payload tuple expected");
    };
    let AbiValue::Integer(value) = &payload.fields()[index] else {
        panic!("integer expected at {index}");
    };
    *value
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

fn body_fields(envelope: &Envelope) -> Vec<AbiValue> {
    let AbiValue::Tuple(payload) = &envelope.body.fields()[0] else {
        panic!("payload tuple expected: {envelope:?}");
    };
    payload.fields().to_vec()
}

fn candidate_token(envelope: &Envelope) -> [u8; 32] {
    let fields = body_fields(envelope);
    let AbiValue::Bytes(bytes) = fields.last().expect("prepared candidate token") else {
        panic!("candidate token must be bytes: {fields:?}")
    };
    bytes
        .as_slice()
        .try_into()
        .expect("candidate token is bin32")
}

fn tuple_fields(value: &AbiValue) -> Vec<AbiValue> {
    let AbiValue::Tuple(payload) = value else {
        panic!("tuple expected: {value:?}");
    };
    payload.fields().to_vec()
}

pub(crate) fn materialize_restore_row(value: &AbiValue) -> AbiValue {
    let fields = exact_tuple(value, 11, "checkpoint account");
    let j_claim_changes = exact_tuple(&fields[9], 2, "j claim node changes");
    tuple_of(vec![
        fields[0].clone(),
        fields[1].clone(),
        fields[2].clone(),
        tuple_of(leaf_values(&fields[4])),
        tuple_of(leaf_values(&fields[5])),
        tuple_of(lending_values(&fields[6])),
        tuple_of(leaf_values(&fields[7])),
        tuple_of(policy_values(&fields[8])),
        j_claim_changes[0].clone(),
        fields[10].clone(),
    ])
}

fn leaf_rows(value: &AbiValue) -> Vec<Vec<AbiValue>> {
    let changes = exact_tuple(value, 2, "node changes");
    tuple_fields(&changes[0])
        .iter()
        .map(tuple_fields)
        .filter(|row| row.first() == Some(&AbiValue::Integer(1)))
        .collect()
}

fn leaf_values(value: &AbiValue) -> Vec<AbiValue> {
    leaf_rows(value)
        .into_iter()
        .map(|row| row[3].clone())
        .collect()
}

fn lending_values(value: &AbiValue) -> Vec<AbiValue> {
    leaf_rows(value)
        .into_iter()
        .map(|row| {
            let AbiValue::Bytes(key) = &row[2] else {
                panic!("lending key")
            };
            let length = usize::from(u16::from_be_bytes([key[0], key[1]]));
            assert_eq!(key.len(), length + 2);
            tuple_of(vec![
                AbiValue::Text(String::from_utf8(key[2..].to_vec()).expect("lending key utf8")),
                row[3].clone(),
            ])
        })
        .collect()
}

fn policy_values(value: &AbiValue) -> Vec<AbiValue> {
    leaf_rows(value)
        .into_iter()
        .map(|row| {
            let AbiValue::Bytes(key) = &row[2] else {
                panic!("policy key")
            };
            assert_eq!(key.len(), 32);
            let token_id = u16::from_be_bytes([key[30], key[31]]);
            tuple_of(vec![
                AbiValue::Integer(i128::from(token_id)),
                row[3].clone(),
            ])
        })
        .collect()
}

/// A tuple of exactly this many fields, so a shape change is a test failure
/// rather than a silently shifted index.
fn exact_tuple(value: &AbiValue, arity: usize, what: &str) -> Vec<AbiValue> {
    let fields = tuple_fields(value);
    assert_eq!(fields.len(), arity, "{what} arity");
    fields
}

/// Every transaction the wire carries must decode back into the transaction it
/// came from. The frame the runtime relays to the counterparty is these bytes:
/// a field encoded one way and read another produces a frame the peer cannot
/// read, and no test of a single direction would notice.
#[test]
fn every_transaction_survives_the_wire_round_trip() {
    use num_bigint::BigInt;
    use xln_rscore_engine::{
        AccountTx, DeliveryMode, HtlcDeliveryMode, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome,
        HtlcResolveTx, TokenId,
    };

    let hashlock = format!("0x{}", "ab".repeat(32));
    let secret = format!("0x{}", "cd".repeat(32));
    let cases = vec![
        AccountTx::DirectPayment {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(25),
            route: vec![format!("0x{}", "cc".repeat(32))],
            description: Some("memo".to_string()),
            from_entity_id: format!("0x{}", "aa".repeat(32)),
            to_entity_id: format!("0x{}", "bb".repeat(32)),
            delivery_mode: DeliveryMode::Trusted,
            trusted_gateway_entity_id: Some(format!("0x{}", "dd".repeat(32))),
        },
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id: "lock-1".to_string(),
            hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
            timelock: BigInt::from(1_700_000_000_000_u64),
            reveal_before_height: 12,
            amount: BigInt::from(500),
            token_id: TokenId::new(1).expect("token"),
            delivery_mode: Some(HtlcDeliveryMode::Async),
            envelope: None,
        }),
        AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: "lock-1".to_string(),
            outcome: HtlcResolveOutcome::Secret {
                secret: secret.clone(),
            },
        }),
        AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: "lock-2".to_string(),
            outcome: HtlcResolveOutcome::Error {
                reason: Some("expired".to_string()),
            },
        }),
        AccountTx::AddDelta {
            token_id: TokenId::new(2).expect("token"),
        },
        AccountTx::SetCreditLimit {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(1_000),
        },
        AccountTx::SwapOffer {
            offer_id: "offer-1".to_string(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: BigInt::from(1_000_000),
            want_token_id: 2,
            want_token_decimals: 6,
            want_amount: BigInt::from(2_000_000),
            max_fee: BigInt::from(0),
            min_net_receive: BigInt::from(1_900_000),
            time_in_force: Some(1),
            price_ticks: Some(BigInt::from(20_000)),
        },
        AccountTx::SwapCancelRequest {
            offer_id: "offer-1".to_string(),
        },
        // Every optional present, and every optional absent: the two shapes
        // take different branches in both directions.
        AccountTx::SwapResolve {
            offer_id: "offer-1".to_string(),
            fill_ratio: 10_000,
            fill_numerator: Some(BigInt::from(1)),
            fill_denominator: Some(BigInt::from(2)),
            cancel_remainder: true,
            comment: Some("STP:book".to_string()),
            fee_token_id: Some(2),
            fee_amount: Some(BigInt::from(7)),
            execution_give_amount: Some(BigInt::from(1_000_000)),
            execution_want_amount: Some(BigInt::from(2_000_000)),
            resting_give_token_id: Some(1),
            resting_want_token_id: Some(2),
            resting_price_ticks: Some(BigInt::from(20_000)),
            resting_give_amount: Some(BigInt::from(3)),
            resting_want_amount: Some(BigInt::from(4)),
            resting_quantized_give: Some(BigInt::from(5)),
            resting_quantized_want: Some(BigInt::from(6)),
        },
        AccountTx::SwapResolve {
            offer_id: "offer-2".to_string(),
            fill_ratio: 0,
            fill_numerator: None,
            fill_denominator: None,
            cancel_remainder: false,
            comment: None,
            fee_token_id: None,
            fee_amount: None,
            execution_give_amount: None,
            execution_want_amount: None,
            resting_give_token_id: None,
            resting_want_token_id: None,
            resting_price_ticks: None,
            resting_give_amount: None,
            resting_want_amount: None,
            resting_quantized_give: None,
            resting_quantized_want: None,
        },
        AccountTx::RebalancePolicy {
            token_id: 1,
            policy_version: 3,
            base_fee: BigInt::from(11),
            liquidity_fee_bps: BigInt::from(12),
            gas_fee: BigInt::from(13),
        },
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id: "lock-3".to_string(),
            hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
            timelock: BigInt::from(1_700_000_000_000_u64),
            reveal_before_height: 0,
            amount: BigInt::from(1),
            token_id: TokenId::new(1).expect("token"),
            delivery_mode: None,
            envelope: None,
        }),
        AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: "lock-3".to_string(),
            outcome: HtlcResolveOutcome::Error { reason: None },
        }),
        AccountTx::DirectPayment {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(1),
            route: Vec::new(),
            description: None,
            from_entity_id: format!("0x{}", "aa".repeat(32)),
            to_entity_id: format!("0x{}", "bb".repeat(32)),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        },
    ];

    for tx in cases {
        let encoded = crate::wire_encode::tx(&tx).expect("encode");
        let decoded = crate::wire_decode::decode_tx(&encoded).expect("decode");
        assert_eq!(decoded, tx, "round trip: {tx:?}");
    }
}

#[test]
fn authority_rejects_unstaged_upsert_while_mirror_upsert_remains_supported() {
    use crate::test_fixture::{
        authority_account, authority_entity, hello_authority, load_accounts,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut authority = ProcessSession::new();
    assert_ok(authority.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(authority.handle(load_accounts(1, 0, Vec::new())).envelope);
    assert_error(
        authority
            .handle(request(
                2,
                OpTag::UpsertAccounts,
                vec![tuple_of(vec![authority_account(owner, peer)])],
            ))
            .envelope,
        "RSCORE_PROCESS_AUTHORITY_UPSERT_FORBIDDEN",
    );

    // The existing mirror import command is intentionally unchanged.
    let mut mirror = ProcessSession::new();
    assert_ok(mirror.handle(hello(0)).envelope);
    assert_ok(mirror.handle(load(1, 0, Vec::new())).envelope);
    assert_ok(
        mirror
            .handle(request(
                2,
                OpTag::UpsertAccounts,
                vec![tuple_of(vec![crate::test_fixture::account_with_id(
                    0x7a,
                    Vec::new(),
                )])],
            ))
            .envelope,
    );
}

#[test]
fn authority_bootstrap_is_only_empty_revision_zero() {
    use crate::test_fixture::{
        authority_account, authority_entity, hello_authority, load_accounts,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_error(
        session.handle(load_accounts(1, 7, Vec::new())).envelope,
        "RSCORE_PROCESS_AUTHORITY_BOOTSTRAP_INVALID",
    );
    assert_error(
        session
            .handle(load_accounts(2, 0, vec![authority_account(owner, peer)]))
            .envelope,
        "RSCORE_PROCESS_AUTHORITY_BOOTSTRAP_INVALID",
    );
    assert_ok(session.handle(load_accounts(3, 0, Vec::new())).envelope);
}
