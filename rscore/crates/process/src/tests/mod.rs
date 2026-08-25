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
        "0720c839d3874f4a70e358f5f7e2b7f78cf2a3cb2132906ae05cdd7365f8b3a7"
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
fn exact_restore_accepts_the_canonical_thirteen_field_resting_offer() {
    use crate::test_fixture::{
        authority_account, authority_entity, hello_authority, restore_authority_accounts,
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

    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                SEED,
                "1",
                vec![tuple_of(account)],
            ))
            .envelope,
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

#[test]
fn nonempty_prepare_is_rejected_without_candidate_root_or_revision_mutation() {
    use crate::test_fixture::{
        authority_account, authority_entity, candidate_command, hello_authority,
        prepare_empty_wave, prepare_wave, restore_authority_accounts, wave_payment,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    let loaded = session
        .handle(restore_authority_accounts(
            1,
            SEED,
            "1",
            vec![authority_account(owner, peer)],
        ))
        .envelope;
    assert_ok(loaded.clone());
    let restored = exact_tuple(&body_fields(&loaded)[0], 5, "restore token");
    let base_revision = restored[1].clone();
    let base_root = restored[2].clone();

    assert_error(
        session
            .handle(prepare_wave(
                2,
                owner,
                1_700_000_000_000,
                vec![wave_payment(peer, owner, peer, 25)],
                Vec::new(),
                true,
            ))
            .envelope,
        "RSCORE_PROCESS_PREPARE_WAVE_NONEMPTY",
    );

    let prepared = session.handle(prepare_empty_wave(3)).envelope;
    assert_ok(prepared.clone());
    assert_eq!(body_fields(&prepared)[0], base_revision);
    assert_eq!(body_fields(&prepared)[1], base_root);
    let token = candidate_token(&prepared);
    assert_ok(
        session
            .handle(candidate_command(4, OpTag::AbortRuntime, token))
            .envelope,
    );
}

/// The authoritative session end to end over the wire: it derives its own
/// keys from the seed, queues a payment, signs a frame for it, and the wave is
/// only kept when the runtime says its own record is durable.
#[test]
fn an_authority_session_proposes_a_signed_frame_in_one_wave() {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, finalize_entity,
        hello_authority, prepare_empty_wave, propose_wave, restore_authority_accounts, seal_wave,
        wave_payment,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");

    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                SEED,
                "1",
                vec![authority_account(owner, peer)],
            ))
            .envelope,
    );

    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    assert!(
        tuple_fields(&body_fields(&prepared)[4]).is_empty(),
        "Prepare applies without proposing"
    );
    let stage_key = [0x31; 32];
    assert_ok(
        session
            .handle(begin_entity(
                3,
                token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                true,
            ))
            .envelope,
    );
    let admission = exact_tuple(&wave_payment(peer, owner, peer, 25), 2, "local admission");
    let applied = session
        .handle(apply_wave(
            4,
            token,
            stage_key,
            owner,
            vec![tuple_of(vec![
                AbiValue::Integer(0),
                AbiValue::Integer(0),
                admission[0].clone(),
                admission[1].clone(),
            ])],
        ))
        .envelope;
    assert_ok(applied.clone());
    assert_eq!(tuple_fields(&body_fields(&applied)[3]).len(), 1);
    let proposed = session
        .handle(propose_wave(5, token, stage_key, owner, vec![peer]))
        .envelope;
    assert_ok(proposed.clone());
    assert_ok(
        session
            .handle(finalize_entity(6, token, stage_key, 0))
            .envelope,
    );
    let sealed = session.handle(seal_wave(7, token)).envelope;
    assert_ok(sealed.clone());
    let fields = body_fields(&sealed);
    let proposals = tuple_fields(&fields[4]);
    assert_eq!(
        proposals.len(),
        1,
        "one account had something to propose: {fields:?}"
    );
    let proposal = exact_tuple(&proposals[0], 5, "proposal");
    let frame = exact_tuple(&proposal[1], 10, "frame");
    assert_eq!(frame[0], AbiValue::Integer(1), "height 1");
    assert_eq!(tuple_fields(&frame[3]).len(), 1, "one transaction");
    assert_eq!(
        frame[4],
        AbiValue::Text("genesis".into()),
        "the first frame chains to genesis",
    );
    assert_eq!(
        tuple_fields(&frame[7]).len(),
        1,
        "one delta the hash commits"
    );
    let AbiValue::Bytes(state_hash) = &frame[8] else {
        panic!("expected a state hash: {:?}", frame[8]);
    };
    assert_eq!(state_hash.len(), 32);
    let AbiValue::Bytes(hanko) = &frame[9] else {
        panic!("expected a hanko: {:?}", frame[9]);
    };
    assert!(!hanko.is_empty(), "the frame is signed");
    assert_eq!(tuple_fields(&proposal[2]).len(), 0, "nothing was dropped");
    // Touched leaves and full post-account rows travel with every wave.
    let touched = tuple_fields(&fields[5]);
    assert_eq!(touched.len(), 1, "one account moved");
    let touched_row = exact_tuple(&touched[0], 2, "touched account");
    let post_accounts = tuple_fields(&fields[6]);
    assert_eq!(post_accounts.len(), 1, "one account materialized");
    let post_account = exact_tuple(&post_accounts[0], 10, "post account");
    assert_eq!(post_account[0], touched_row[0], "same account id");
    assert_eq!(post_account[1], touched_row[1], "same post-wave leaf");
    assert_eq!(
        exact_tuple(&post_account[3], 5, "post account sections").len(),
        5,
        "all Rust-owned Account trees are described"
    );
    let delta_changes = exact_tuple(&post_account[4], 2, "post account delta changes");
    assert!(
        !tuple_fields(&delta_changes[0]).is_empty(),
        "the full delta tree is materialized"
    );
    let consensus = exact_tuple(&post_account[9], 11, "post account consensus");
    assert!(
        matches!(&consensus[2], AbiValue::Tuple(_)),
        "the post-proposal consensus envelope is materialized"
    );
    let AbiValue::Bytes(digest) = &fields[7] else {
        panic!("expected a parity digest: {:?}", fields[7]);
    };
    assert_eq!(digest.len(), 32);

    // A wave the runtime has not committed blocks the next one.
    assert_error(
        session.handle(prepare_empty_wave(8)).envelope,
        "RSCORE_PROCESS_PREPARE_PENDING",
    );
    // Only the exact server-issued candidate capability may commit it.
    assert_error(
        session
            .handle(candidate_command(9, OpTag::CommitRuntime, [0x66; 32]))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_ok(
        session
            .handle(candidate_command(10, OpTag::CommitRuntime, token))
            .envelope,
    );
}

#[test]
fn entity_stage_wire_is_strict_idempotent_and_abortable() {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, candidate_command,
        discard_entity, finalize_entity, hello_authority, prepare_empty_wave,
        restore_authority_accounts, seal_wave,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let stage_a = [0x41; 32];
    let stage_b = [0x42; 32];
    let stage_c = [0x43; 32];
    let timestamp = 1_700_000_000_000;
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                SEED,
                "1",
                vec![authority_account(owner, peer)],
            ))
            .envelope,
    );
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);

    let opened = session
        .handle(begin_entity(3, token, stage_a, 0, owner, timestamp, true))
        .envelope;
    assert_ok(opened.clone());
    let opened_fields = exact_tuple(&opened.body.fields()[0], 5, "entity stage receipt");
    assert_eq!(opened_fields[0], AbiValue::Bytes(stage_a.to_vec()));
    assert_eq!(opened_fields[1], AbiValue::Integer(0));
    assert_eq!(opened_fields[2], AbiValue::Integer(0));

    let duplicate_open = session
        .handle(begin_entity(4, token, stage_a, 0, owner, timestamp, true))
        .envelope;
    assert_ok(duplicate_open.clone());
    assert_eq!(duplicate_open.body, opened.body);

    assert_error(
        session
            .handle(begin_entity(
                5, [0x99; 32], stage_a, 0, owner, timestamp, true,
            ))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_error(
        session
            .handle(apply_wave(6, token, stage_b, owner, Vec::new()))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_KEY",
    );
    assert_error(
        session
            .handle(finalize_entity(7, token, stage_b, 0))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_KEY",
    );
    assert_error(
        session
            .handle(finalize_entity(8, token, stage_a, 1))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_ORDINAL",
    );
    assert_error(
        session.handle(seal_wave(9, token)).envelope,
        "RSCORE_BATCH_ENTITY_STAGE_OPEN",
    );

    let accepted = session
        .handle(finalize_entity(10, token, stage_a, 0))
        .envelope;
    assert_ok(accepted.clone());
    let accepted_fields = exact_tuple(&accepted.body.fields()[0], 5, "accepted stage receipt");
    assert_eq!(accepted_fields[0], AbiValue::Bytes(stage_a.to_vec()));
    assert_eq!(accepted_fields[1], AbiValue::Integer(1));
    assert_eq!(accepted_fields[2], AbiValue::Integer(1));
    let duplicate_accept = session
        .handle(finalize_entity(11, token, stage_a, 0))
        .envelope;
    assert_ok(duplicate_accept.clone());
    assert_eq!(duplicate_accept.body, accepted.body);
    assert_error(
        session
            .handle(discard_entity(12, token, stage_a, 0))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_DECISION",
    );
    let replayed_begin = session
        .handle(begin_entity(13, token, stage_a, 0, owner, timestamp, true))
        .envelope;
    assert_ok(replayed_begin.clone());
    assert_eq!(replayed_begin.body, accepted.body);
    assert_error(
        session
            .handle(begin_entity(
                14,
                token,
                stage_a,
                0,
                owner,
                timestamp + 1,
                true,
            ))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_REPLAY",
    );
    assert_error(
        session
            .handle(begin_entity(15, token, stage_b, 0, owner, timestamp, true))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_ORDINAL",
    );
    assert_ok(
        session
            .handle(begin_entity(16, token, stage_b, 1, owner, timestamp, true))
            .envelope,
    );
    let discarded = session
        .handle(discard_entity(17, token, stage_b, 1))
        .envelope;
    assert_ok(discarded.clone());
    let discarded_fields = exact_tuple(&discarded.body.fields()[0], 5, "discarded stage receipt");
    assert_eq!(discarded_fields[1], AbiValue::Integer(2));
    assert_eq!(discarded_fields[2], AbiValue::Integer(1));
    let duplicate_discard = session
        .handle(discard_entity(18, token, stage_b, 1))
        .envelope;
    assert_ok(duplicate_discard.clone());
    assert_eq!(duplicate_discard.body, discarded.body);
    assert_error(
        session
            .handle(finalize_entity(19, token, stage_b, 1))
            .envelope,
        "RSCORE_BATCH_ENTITY_STAGE_DECISION",
    );

    assert_ok(
        session
            .handle(begin_entity(20, token, stage_c, 1, owner, timestamp, true))
            .envelope,
    );
    assert_ok(
        session
            .handle(candidate_command(21, OpTag::AbortRuntime, token))
            .envelope,
    );
    assert_ok(session.handle(prepare_empty_wave(22)).envelope);
}

#[test]
fn entity_stage_propose_rejects_integer_aliases_before_candidate_mutation() {
    use crate::test_fixture::{
        authority_account, authority_entity, begin_entity, candidate_command, hello_authority,
        prepare_empty_wave, restore_authority_accounts,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let stage_key = [0x4a; 32];
    let timestamp = 1_700_000_000_000;
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                SEED,
                "1",
                vec![authority_account(owner, peer)],
            ))
            .envelope,
    );
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let base = body_fields(&prepared);

    let aliased = |id: u64, alias: i128| {
        let mut request = begin_entity(id, token, stage_key, 0, owner, timestamp, false);
        let mut payload = tuple_fields(&request.body.fields()[0]);
        let mut context = exact_tuple(&payload[3], 6, "entity stage context");
        context[5] = AbiValue::Integer(alias);
        payload[3] = tuple_of(context);
        request.body = xln_rscore_abi::BodyTuple::from_array([tuple_of(payload)]);
        request
    };

    for (id, alias) in [(3, 0), (4, 1)] {
        assert_error(
            session.handle(aliased(id, alias)).envelope,
            "RSCORE_PROCESS_EXPECTED:propose",
        );
    }

    let opened = session
        .handle(begin_entity(
            5, token, stage_key, 0, owner, timestamp, false,
        ))
        .envelope;
    assert_ok(opened.clone());
    let receipt = exact_tuple(&opened.body.fields()[0], 5, "entity stage receipt");
    assert_eq!(receipt[3], base[0], "aliases did not consume a revision");
    assert_eq!(receipt[4], base[1], "aliases did not mutate the root");
    assert_ok(
        session
            .handle(candidate_command(6, OpTag::AbortRuntime, token))
            .envelope,
    );
}

#[test]
fn discarded_entity_stage_restores_root_revision_and_operation_index() {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, candidate_command,
        discard_entity, finalize_entity, hello_authority, prepare_empty_wave,
        restore_authority_accounts, seal_wave, wave_payment,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let timestamp = 1_700_000_000_000;
    let stage_a = [0x51; 32];
    let stage_b = [0x52; 32];
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                SEED,
                "1",
                vec![authority_account(owner, peer)],
            ))
            .envelope,
    );
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let base_revision = body_fields(&prepared)[0].clone();
    let base_root = body_fields(&prepared)[1].clone();
    let operation = {
        let admission = exact_tuple(&wave_payment(peer, owner, peer, 25), 2, "local admission");
        tuple_of(vec![
            AbiValue::Integer(0),
            AbiValue::Integer(0),
            admission[0].clone(),
            admission[1].clone(),
        ])
    };

    assert_ok(
        session
            .handle(begin_entity(3, token, stage_a, 0, owner, timestamp, true))
            .envelope,
    );
    let first_apply = session
        .handle(apply_wave(
            4,
            token,
            stage_a,
            owner,
            vec![operation.clone()],
        ))
        .envelope;
    assert_ok(first_apply.clone());
    assert_ne!(body_fields(&first_apply)[1], base_root);
    let discarded = session
        .handle(discard_entity(5, token, stage_a, 0))
        .envelope;
    assert_ok(discarded.clone());
    let discarded_fields = exact_tuple(&discarded.body.fields()[0], 5, "discarded stage receipt");
    assert_eq!(discarded_fields[3], base_revision);
    assert_eq!(discarded_fields[4], base_root);

    assert_ok(
        session
            .handle(begin_entity(6, token, stage_b, 0, owner, timestamp, true))
            .envelope,
    );
    let second_apply = session
        .handle(apply_wave(7, token, stage_b, owner, vec![operation]))
        .envelope;
    assert_ok(second_apply.clone());
    assert_eq!(
        body_fields(&second_apply)[0],
        body_fields(&first_apply)[0],
        "rollback must restore the revision consumed by operation zero",
    );
    assert_eq!(
        body_fields(&second_apply)[1],
        body_fields(&first_apply)[1],
        "reusing operation zero after rollback must reproduce the same root",
    );
    let accepted = session
        .handle(finalize_entity(8, token, stage_b, 0))
        .envelope;
    assert_ok(accepted.clone());
    let accepted_fields = exact_tuple(&accepted.body.fields()[0], 5, "accepted stage receipt");
    assert_eq!(accepted_fields[3], body_fields(&second_apply)[0]);
    assert_eq!(accepted_fields[4], body_fields(&second_apply)[1]);

    let sealed = session.handle(seal_wave(9, token)).envelope;
    assert_ok(sealed.clone());
    assert_eq!(body_fields(&sealed)[0], body_fields(&second_apply)[0]);
    assert_eq!(body_fields(&sealed)[1], body_fields(&second_apply)[1]);
    assert_ok(
        session
            .handle(candidate_command(10, OpTag::AbortRuntime, token))
            .envelope,
    );
}

#[test]
fn post_mutation_wave_encoding_failure_stops_the_authority_session() {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, hello_authority,
        prepare_empty_wave, propose_wave, restore_authority_accounts,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                SEED,
                "1",
                vec![authority_account(owner, peer)],
            ))
            .envelope,
    );

    // The request text itself is wire-valid at exactly 4 KiB. Proposing it
    // against a missing lock removes it from the candidate mempool, then the
    // rejection prefix expands the reply beyond the wire's text limit.
    let admission = tuple_of(vec![
        AbiValue::Bytes(peer.to_vec()),
        tuple_of(vec![tuple_of(vec![
            AbiValue::Integer(2),
            AbiValue::Text("x".repeat(4 * 1024)),
            AbiValue::Integer(1),
            AbiValue::Nil,
        ])]),
    ]);
    let admission = exact_tuple(&admission, 2, "local admission");
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let stage_key = [0x32; 32];
    assert_ok(
        session
            .handle(begin_entity(
                3,
                token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                true,
            ))
            .envelope,
    );

    assert_ok(
        session
            .handle(apply_wave(
                4,
                token,
                stage_key,
                owner,
                vec![tuple_of(vec![
                    AbiValue::Integer(0),
                    AbiValue::Integer(0),
                    admission[0].clone(),
                    admission[1].clone(),
                ])],
            ))
            .envelope,
    );

    let failed = session.handle(propose_wave(5, token, stage_key, owner, vec![peer]));
    assert_error(failed.envelope, "RSCORE_ABI_TEXT_TOO_LARGE");
    assert!(
        failed.shutdown,
        "a mutated candidate with no encodable reply must terminate the process"
    );

    let stopped = session.handle(apply_wave(6, token, stage_key, owner, Vec::new()));
    assert_error(stopped.envelope, "RSCORE_PROCESS_STOPPED");
    assert!(stopped.shutdown);
}

/// A wave the runtime takes back leaves the engine exactly where it was, and
/// the same wave can be prepared again.
#[test]
fn an_aborted_wave_puts_the_authority_engine_back() {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, candidate_command,
        finalize_entity, hello_authority, prepare_empty_wave, restore_authority_accounts,
        staged_wave_ops, wave_payment,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");

    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    let loaded = session
        .handle(restore_authority_accounts(
            1,
            SEED,
            "1",
            vec![authority_account(owner, peer)],
        ))
        .envelope;
    assert_ok(loaded.clone());
    let root_before = exact_tuple(&body_fields(&loaded)[0], 5, "restore token")[2].clone();

    let stage_key = [0x35; 32];
    let first = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(first.clone());
    let first_token = candidate_token(&first);
    assert_ok(
        session
            .handle(begin_entity(
                3,
                first_token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                true,
            ))
            .envelope,
    );
    let first_applied = session
        .handle(apply_wave(
            4,
            first_token,
            stage_key,
            owner,
            staged_wave_ops(vec![wave_payment(peer, owner, peer, 25)], Vec::new()),
        ))
        .envelope;
    assert_ok(first_applied.clone());
    assert_ok(
        session
            .handle(finalize_entity(5, first_token, stage_key, 0))
            .envelope,
    );
    let aborted = session
        .handle(candidate_command(6, OpTag::AbortRuntime, first_token))
        .envelope;
    assert_ok(aborted.clone());
    assert_eq!(
        body_fields(&aborted)[1],
        root_before,
        "the abort restores the accounts root",
    );

    let second = session.handle(prepare_empty_wave(7)).envelope;
    assert_ok(second.clone());
    let second_token = candidate_token(&second);
    assert_ok(
        session
            .handle(begin_entity(
                8,
                second_token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                true,
            ))
            .envelope,
    );
    let second_applied = session
        .handle(apply_wave(
            9,
            second_token,
            stage_key,
            owner,
            staged_wave_ops(vec![wave_payment(peer, owner, peer, 25)], Vec::new()),
        ))
        .envelope;
    assert_ok(second_applied.clone());
    assert_ok(
        session
            .handle(finalize_entity(10, second_token, stage_key, 0))
            .envelope,
    );
    assert_ne!(
        first_token, second_token,
        "an aborted candidate token is never reissued"
    );
    assert_error(
        session
            .handle(candidate_command(11, OpTag::AbortRuntime, first_token))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_ok(
        session
            .handle(candidate_command(12, OpTag::AbortRuntime, second_token))
            .envelope,
    );
    assert_eq!(
        body_fields(&second_applied)[3],
        body_fields(&first_applied)[3],
        "the same wave reaches the same proposal",
    );
}

/// The process boundary preserves an in-flight proposal, replays its held
/// effects on restore, and reaches the same ACK result as the uninterrupted
/// engine. This is the crash point that seed-only restore could never cover.
#[test]
fn exact_checkpoint_restores_pending_frame_and_held_outputs() {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, candidate_command,
        commit_checkpoint, finalize_entity, get_checkpoint_changes, hello_authority,
        prepare_empty_wave, propose_wave, restore_authority_accounts_with_rows, restore_exact,
        seal_wave, staged_wave_ops, wave_ack, wave_swap_offer,
    };
    use xln_rscore_engine::{BoardDelays, SigningIdentity};

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut uninterrupted = ProcessSession::new();
    assert_ok(uninterrupted.handle(hello_authority(0, SEED, "1")).envelope);
    let (initial_restore, initial_rows) =
        restore_authority_accounts_with_rows(1, SEED, "1", vec![authority_account(owner, peer)]);
    assert_ok(uninterrupted.handle(initial_restore).envelope);
    let prepared = uninterrupted.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let uninterrupted_token = candidate_token(&prepared);
    let stage_key = [0x33; 32];
    assert_ok(
        uninterrupted
            .handle(begin_entity(
                3,
                uninterrupted_token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                true,
            ))
            .envelope,
    );
    assert_ok(
        uninterrupted
            .handle(apply_wave(
                4,
                uninterrupted_token,
                stage_key,
                owner,
                staged_wave_ops(vec![wave_swap_offer(peer)], Vec::new()),
            ))
            .envelope,
    );
    let proposed = uninterrupted
        .handle(propose_wave(
            5,
            uninterrupted_token,
            stage_key,
            owner,
            vec![peer],
        ))
        .envelope;
    assert_ok(proposed.clone());
    assert_ok(
        uninterrupted
            .handle(finalize_entity(6, uninterrupted_token, stage_key, 0))
            .envelope,
    );
    let proposal = exact_tuple(&tuple_fields(&body_fields(&proposed)[4])[0], 5, "proposal");
    assert!(
        !matches!(proposal[1], AbiValue::Nil),
        "swap proposal rejected: {:?}",
        proposal[2],
    );
    let frame = exact_tuple(&proposal[1], 10, "frame");
    let state_hash: [u8; 32] = match &frame[8] {
        AbiValue::Bytes(bytes) => bytes.as_slice().try_into().expect("state hash"),
        value => panic!("state hash expected: {value:?}"),
    };
    assert_error(
        uninterrupted
            .handle(get_checkpoint_changes(7, [0x11; 32]))
            .envelope,
        "RSCORE_PROCESS_CANDIDATE_TOKEN_MISMATCH",
    );
    assert_ok(
        uninterrupted
            .handle(seal_wave(8, uninterrupted_token))
            .envelope,
    );
    let checkpoint = uninterrupted
        .handle(get_checkpoint_changes(9, uninterrupted_token))
        .envelope;
    assert_ok(checkpoint.clone());
    let checkpoint_fields = exact_tuple(&body_fields(&checkpoint)[0], 4, "checkpoint");
    let commit_token = checkpoint_fields[0].clone();
    let durable_token = checkpoint_fields[1].clone();
    let changed = tuple_fields(&checkpoint_fields[2]);
    assert_eq!(changed.len(), 1);
    let restore_row = materialize_shell_checkpoint_over(&initial_rows[0], &changed[0]);
    assert_ok(
        uninterrupted
            .handle(candidate_command(
                10,
                OpTag::CommitRuntime,
                uninterrupted_token,
            ))
            .envelope,
    );
    let committed = uninterrupted
        .handle(commit_checkpoint(11, commit_token))
        .envelope;
    assert_ok(committed.clone());
    assert_eq!(body_fields(&committed)[0], durable_token);

    let peer_identity = SigningIdentity::lazy_from_seed(SEED, "2", 1, 1, BoardDelays::default())
        .expect("peer identity");
    assert_eq!(peer_identity.entity_id(), &peer);
    let ack_hanko = peer_identity.sign_frame(&state_hash).expect("peer ack");

    let mut restarted = ProcessSession::new();
    assert_ok(restarted.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        restarted
            .handle(restore_exact(1, durable_token, vec![restore_row]))
            .envelope,
    );
    let restarted_empty = restarted.handle(prepare_empty_wave(2)).envelope;
    assert_ok(restarted_empty.clone());
    let restarted_token = candidate_token(&restarted_empty);
    assert_ok(restarted.handle(seal_wave(3, restarted_token)).envelope);
    let empty = restarted
        .handle(get_checkpoint_changes(4, restarted_token))
        .envelope;
    assert_ok(empty.clone());
    let empty_fields = exact_tuple(&body_fields(&empty)[0], 4, "checkpoint");
    assert!(
        tuple_fields(&empty_fields[2]).is_empty() && tuple_fields(&empty_fields[3]).is_empty(),
        "a restored checkpoint is its own durable base",
    );
    assert_ok(
        restarted
            .handle(candidate_command(5, OpTag::AbortRuntime, restarted_token))
            .envelope,
    );

    let ack_input = wave_ack(0, peer, peer, owner, 1, state_hash, ack_hanko);
    let restarted_ack_stage = [0x36; 32];
    let resumed_prepare = restarted.handle(prepare_empty_wave(6)).envelope;
    assert_ok(resumed_prepare.clone());
    let resumed_token = candidate_token(&resumed_prepare);
    assert_ok(
        restarted
            .handle(begin_entity(
                7,
                resumed_token,
                restarted_ack_stage,
                0,
                owner,
                1_700_000_000_001,
                false,
            ))
            .envelope,
    );
    let resumed_ack = restarted
        .handle(apply_wave(
            8,
            resumed_token,
            restarted_ack_stage,
            owner,
            staged_wave_ops(Vec::new(), vec![ack_input.clone()]),
        ))
        .envelope;
    assert_ok(resumed_ack.clone());
    assert_ok(
        restarted
            .handle(finalize_entity(9, resumed_token, restarted_ack_stage, 0))
            .envelope,
    );

    let live_prepare = uninterrupted.handle(prepare_empty_wave(12)).envelope;
    assert_ok(live_prepare.clone());
    let live_token = candidate_token(&live_prepare);
    assert_ok(
        uninterrupted
            .handle(begin_entity(
                13,
                live_token,
                restarted_ack_stage,
                0,
                owner,
                1_700_000_000_001,
                false,
            ))
            .envelope,
    );
    let live_ack = uninterrupted
        .handle(apply_wave(
            14,
            live_token,
            restarted_ack_stage,
            owner,
            staged_wave_ops(Vec::new(), vec![ack_input]),
        ))
        .envelope;
    assert_ok(live_ack.clone());
    assert_ok(
        uninterrupted
            .handle(finalize_entity(15, live_token, restarted_ack_stage, 0))
            .envelope,
    );
    assert_eq!(
        without_engine_micros(&resumed_ack.body),
        without_engine_micros(&live_ack.body),
        "restart must reproduce root, verdict and held output bytes",
    );
    let applied = tuple_fields(&body_fields(&resumed_ack)[2]);
    let verdict = exact_tuple(&exact_tuple(&applied[0], 3, "applied")[2], 6, "ack verdict");
    assert_eq!(verdict[0], AbiValue::Integer(5));
    assert_eq!(
        tuple_fields(&verdict[3]).len(),
        1,
        "held forward released once"
    );
    let committed = exact_tuple(&verdict[4], 2, "committed frame evidence");
    let committed_frame = exact_tuple(&committed[0], 9, "committed frame");
    assert_eq!(committed_frame[0], AbiValue::Integer(1));
    assert_eq!(committed_frame[8], AbiValue::Bytes(state_hash.to_vec()));
    assert_eq!(
        committed[1],
        AbiValue::Bool(false),
        "ACK certifies our pending frame"
    );
}

/// A checkpoint read is a ticket for one exact pending wave, not a free-form
/// snapshot token. If the Runtime WAL fails and the wave is aborted, that
/// ticket must die with it — especially for an idle wave whose root/revision
/// are identical to committed state, where token equality alone cannot expose
/// the stale acknowledgement.
#[test]
fn checkpoint_ticket_is_bound_to_the_wave_lifecycle() {
    use crate::test_fixture::{
        authority_account, authority_entity, candidate_command, commit_checkpoint,
        get_checkpoint_changes, hello_authority, prepare_empty_wave, restore_authority_accounts,
        seal_wave,
    };

    let owner = authority_entity(EXACT_RESTORE_SEED, "1");
    let peer = authority_entity(EXACT_RESTORE_SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(
        session
            .handle(hello_authority(0, EXACT_RESTORE_SEED, "1"))
            .envelope,
    );
    assert_ok(
        session
            .handle(restore_authority_accounts(
                1,
                EXACT_RESTORE_SEED,
                "1",
                vec![authority_account(owner, peer)],
            ))
            .envelope,
    );

    let first = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(first.clone());
    let first_token = candidate_token(&first);
    assert_ok(session.handle(seal_wave(3, first_token)).envelope);
    let abandoned = session
        .handle(get_checkpoint_changes(4, first_token))
        .envelope;
    assert_ok(abandoned.clone());
    let abandoned = exact_tuple(&body_fields(&abandoned)[0], 4, "checkpoint");
    assert!(tuple_fields(&abandoned[2]).is_empty());
    assert_ok(
        session
            .handle(candidate_command(5, OpTag::AbortRuntime, first_token))
            .envelope,
    );
    assert_error(
        session
            .handle(commit_checkpoint(6, abandoned[0].clone()))
            .envelope,
        "RSCORE_PROCESS_CHECKPOINT_NOT_PENDING",
    );

    // RestoreExact made the imported account the durable baseline, so an idle
    // candidate has no row debt before or after abort. Its checkpoint ticket
    // is still candidate-scoped and must die with that candidate.
    let second = session.handle(prepare_empty_wave(7)).envelope;
    assert_ok(second.clone());
    let second_token = candidate_token(&second);
    assert_ok(session.handle(seal_wave(8, second_token)).envelope);
    let checkpoint = session
        .handle(get_checkpoint_changes(9, second_token))
        .envelope;
    assert_ok(checkpoint.clone());
    let checkpoint = exact_tuple(&body_fields(&checkpoint)[0], 4, "checkpoint");
    assert!(tuple_fields(&checkpoint[2]).is_empty());
    assert_ok(
        session
            .handle(candidate_command(10, OpTag::CommitRuntime, second_token))
            .envelope,
    );
    assert_error(
        session.handle(prepare_empty_wave(11)).envelope,
        "RSCORE_PROCESS_CHECKPOINT_PENDING",
    );
    let wrong_token = replace_tuple_field(
        &checkpoint[0],
        0,
        AbiValue::Integer(1),
        5,
        "checkpoint token",
    );
    assert_error(
        session.handle(commit_checkpoint(12, wrong_token)).envelope,
        "RSCORE_BATCH_CHECKPOINT_TOKEN",
    );
    let committed = session
        .handle(commit_checkpoint(13, checkpoint[0].clone()))
        .envelope;
    assert_ok(committed.clone());
    assert_eq!(body_fields(&committed)[0], checkpoint[1]);
}

/// Every durable checkpoint claim is adversarial input at the process
/// boundary. A rejected restore must not install a partial engine: the same
/// session must still accept the unmodified durable rows on its next request.
#[test]
fn malformed_exact_restore_is_loud_and_does_not_poison_the_session() {
    use crate::test_fixture::restore_exact;

    let (token, row) = durable_pending_checkpoint();

    let uncommitted_base =
        replace_tuple_field(&token, 0, AbiValue::Integer(0), 5, "checkpoint token");
    assert_restore_failure_is_retryable(
        restore_exact(1, uncommitted_base, vec![row.clone()]),
        "RSCORE_BATCH_CHECKPOINT_TOKEN",
        &token,
        &row,
    );

    let wrong_root = replace_bytes_field(&token, 2, "checkpoint token");
    assert_restore_failure_is_retryable(
        restore_exact(1, wrong_root, vec![row.clone()]),
        "RSCORE_BATCH_CHECKPOINT_ROOT",
        &token,
        &row,
    );

    let wrong_signer_digest = replace_bytes_field(&token, 3, "checkpoint token");
    assert_restore_failure_is_retryable(
        restore_exact(1, wrong_signer_digest, vec![row.clone()]),
        "RSCORE_BATCH_CHECKPOINT_SIGNER_DIGEST",
        &token,
        &row,
    );

    let wrong_account_leaf = replace_bytes_field(&row, 1, "account restore");
    assert_restore_failure_is_retryable(
        restore_exact(1, token.clone(), vec![wrong_account_leaf]),
        "RSCORE_BATCH_CHECKPOINT_ACCOUNT_LEAF",
        &token,
        &row,
    );

    let wrong_account_id = replace_bytes_field(&row, 0, "account restore");
    assert_restore_failure_is_retryable(
        restore_exact(1, token.clone(), vec![wrong_account_id]),
        "RSCORE_PROCESS_EXPECTED",
        &token,
        &row,
    );

    let duplicate_count =
        replace_tuple_field(&token, 4, AbiValue::Integer(2), 5, "checkpoint token");
    assert_restore_failure_is_retryable(
        restore_exact(1, duplicate_count, vec![row.clone(), row.clone()]),
        "RSCORE_BATCH_ACCOUNT_DUPLICATE",
        &token,
        &row,
    );

    assert_restore_failure_is_retryable(
        restore_exact(1, token.clone(), vec![corrupt_pending_hanko(&row)]),
        "RSCORE_BATCH_ACCOUNTS_TREE",
        &token,
        &row,
    );

    assert_restore_failure_is_retryable(
        request(1, OpTag::RestoreExact, vec![token.clone()]),
        "RSCORE_PROCESS_ARITY",
        &token,
        &row,
    );

    let (committed_token, committed_row) = durable_committed_checkpoint();
    assert_restore_failure_is_retryable(
        restore_exact(
            1,
            committed_token.clone(),
            vec![tamper_current_frame_body(&committed_row)],
        ),
        "RSCORE_BATCH_ACCOUNTS_TREE",
        &committed_token,
        &committed_row,
    );
    assert_restore_failure_is_retryable(
        restore_exact(
            1,
            committed_token.clone(),
            vec![remove_current_frame_certificate(&committed_row)],
        ),
        "RSCORE_BATCH_ACCOUNTS_TREE",
        &committed_token,
        &committed_row,
    );
    assert_restore_failure_is_retryable(
        restore_exact(
            1,
            committed_token.clone(),
            vec![corrupt_local_committed_hanko(&committed_row)],
        ),
        "RSCORE_BATCH_ACCOUNTS_TREE",
        &committed_token,
        &committed_row,
    );
}

/// J-claim accumulators are uint64 protocol counters, not JavaScript numbers.
/// Exact recovery must accept the same full range that BootstrapAccounts and
/// the checkpoint encoder already put on the wire.
#[test]
fn exact_restore_decodes_full_u64_j_claim_counts() {
    let (token, row) = durable_pending_checkpoint();
    let count = (1_u64 << 53) + 1;
    let row = replace_left_claim_count(&row, count);
    let request = vec![token, tuple_of(vec![row])];
    let (_, accounts) = crate::checkpoint_wire::restore_request(&request).expect("decode restore");
    assert_eq!(
        accounts[0]
            .replica
            .state()
            .carried()
            .left_pending_j_claims
            .count,
        count,
    );
}

const EXACT_RESTORE_SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

fn durable_pending_checkpoint() -> (AbiValue, AbiValue) {
    use crate::test_fixture::{
        apply_wave, authority_account, authority_entity, begin_entity, candidate_command,
        commit_checkpoint, finalize_entity, get_checkpoint_changes, hello_authority,
        prepare_empty_wave, propose_wave, restore_authority_accounts_with_rows, seal_wave,
        staged_wave_ops, wave_swap_offer,
    };

    let owner = authority_entity(EXACT_RESTORE_SEED, "1");
    let peer = authority_entity(EXACT_RESTORE_SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(
        session
            .handle(hello_authority(0, EXACT_RESTORE_SEED, "1"))
            .envelope,
    );
    let (initial_restore, initial_rows) = restore_authority_accounts_with_rows(
        1,
        EXACT_RESTORE_SEED,
        "1",
        vec![authority_account(owner, peer)],
    );
    assert_ok(session.handle(initial_restore).envelope);
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let stage_key = [0x34; 32];
    assert_ok(
        session
            .handle(begin_entity(
                3,
                token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                true,
            ))
            .envelope,
    );
    assert_ok(
        session
            .handle(apply_wave(
                4,
                token,
                stage_key,
                owner,
                staged_wave_ops(vec![wave_swap_offer(peer)], Vec::new()),
            ))
            .envelope,
    );
    assert_ok(
        session
            .handle(propose_wave(5, token, stage_key, owner, vec![peer]))
            .envelope,
    );
    assert_ok(
        session
            .handle(finalize_entity(6, token, stage_key, 0))
            .envelope,
    );
    assert_ok(session.handle(seal_wave(7, token)).envelope);
    let checkpoint = session.handle(get_checkpoint_changes(8, token)).envelope;
    assert_ok(checkpoint.clone());
    let checkpoint_fields = exact_tuple(&body_fields(&checkpoint)[0], 4, "checkpoint");
    let changed = tuple_fields(&checkpoint_fields[2]);
    assert_eq!(changed.len(), 1);
    let restore_row = materialize_shell_checkpoint_over(&initial_rows[0], &changed[0]);
    assert_ok(
        session
            .handle(candidate_command(9, OpTag::CommitRuntime, token))
            .envelope,
    );
    let committed = session
        .handle(commit_checkpoint(10, checkpoint_fields[0].clone()))
        .envelope;
    assert_ok(committed.clone());
    assert_eq!(body_fields(&committed)[0], checkpoint_fields[1]);
    (checkpoint_fields[1].clone(), restore_row)
}

fn durable_committed_checkpoint() -> (AbiValue, AbiValue) {
    use crate::test_fixture::{
        apply_wave, authority_entity, begin_entity, candidate_command, commit_checkpoint,
        finalize_entity, get_checkpoint_changes, hello_authority, prepare_empty_wave,
        restore_exact, seal_wave, staged_wave_ops, wave_ack,
    };
    use xln_rscore_engine::{BoardDelays, SigningIdentity};

    let (pending_token, pending_row) = durable_pending_checkpoint();
    let owner = authority_entity(EXACT_RESTORE_SEED, "1");
    let peer = authority_entity(EXACT_RESTORE_SEED, "2");
    let pending_consensus = exact_tuple(
        &exact_tuple(&pending_row, 9, "account restore")[8],
        11,
        "consensus snapshot",
    );
    let pending = exact_tuple(&pending_consensus[2], 5, "pending frame");
    let state_hash: [u8; 32] = match &pending[1] {
        AbiValue::Bytes(bytes) => bytes.as_slice().try_into().expect("pending state hash"),
        value => panic!("pending state hash expected: {value:?}"),
    };
    let peer_identity =
        SigningIdentity::lazy_from_seed(EXACT_RESTORE_SEED, "2", 1, 1, BoardDelays::default())
            .expect("peer identity");
    assert_eq!(peer_identity.entity_id(), &peer);
    let ack_hanko = peer_identity.sign_frame(&state_hash).expect("peer ack");

    let mut session = ProcessSession::new();
    assert_ok(
        session
            .handle(hello_authority(0, EXACT_RESTORE_SEED, "1"))
            .envelope,
    );
    assert_ok(
        session
            .handle(restore_exact(1, pending_token, vec![pending_row]))
            .envelope,
    );
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let stage_key = [0x37; 32];
    assert_ok(
        session
            .handle(begin_entity(
                3,
                token,
                stage_key,
                0,
                owner,
                1_700_000_000_001,
                false,
            ))
            .envelope,
    );
    assert_ok(
        session
            .handle(apply_wave(
                4,
                token,
                stage_key,
                owner,
                staged_wave_ops(
                    Vec::new(),
                    vec![wave_ack(0, peer, peer, owner, 1, state_hash, ack_hanko)],
                ),
            ))
            .envelope,
    );
    assert_ok(
        session
            .handle(finalize_entity(5, token, stage_key, 0))
            .envelope,
    );
    assert_ok(session.handle(seal_wave(6, token)).envelope);
    let checkpoint = session.handle(get_checkpoint_changes(7, token)).envelope;
    assert_ok(checkpoint.clone());
    let checkpoint_fields = exact_tuple(&body_fields(&checkpoint)[0], 4, "checkpoint");
    let changed = tuple_fields(&checkpoint_fields[2]);
    assert_eq!(changed.len(), 1);
    let restore_row = materialize_restore_row(&changed[0]);
    assert_ok(
        session
            .handle(candidate_command(8, OpTag::CommitRuntime, token))
            .envelope,
    );
    let committed = session
        .handle(commit_checkpoint(9, checkpoint_fields[0].clone()))
        .envelope;
    assert_ok(committed.clone());
    assert_eq!(body_fields(&committed)[0], checkpoint_fields[1]);
    (checkpoint_fields[1].clone(), restore_row)
}

fn assert_restore_failure_is_retryable(
    invalid: Envelope,
    expected_error: &str,
    token: &AbiValue,
    row: &AbiValue,
) {
    use crate::test_fixture::{
        candidate_command, get_checkpoint_changes, hello_authority, prepare_empty_wave,
        restore_exact, seal_wave,
    };

    let mut session = ProcessSession::new();
    assert_ok(
        session
            .handle(hello_authority(0, EXACT_RESTORE_SEED, "1"))
            .envelope,
    );
    assert_error(session.handle(invalid).envelope, expected_error);

    let restored = session
        .handle(restore_exact(2, token.clone(), vec![row.clone()]))
        .envelope;
    assert_ok(restored.clone());
    assert_eq!(
        body_fields(&restored)[0],
        *token,
        "valid retry must install exactly the durable checkpoint",
    );

    let prepared = session.handle(prepare_empty_wave(3)).envelope;
    assert_ok(prepared.clone());
    let candidate_token = candidate_token(&prepared);
    assert_ok(session.handle(seal_wave(4, candidate_token)).envelope);
    let changes = session
        .handle(get_checkpoint_changes(5, candidate_token))
        .envelope;
    assert_ok(changes.clone());
    let checkpoint = exact_tuple(&body_fields(&changes)[0], 4, "checkpoint");
    assert!(
        tuple_fields(&checkpoint[2]).is_empty() && tuple_fields(&checkpoint[3]).is_empty(),
        "valid retry must establish the durable checkpoint as the diff base",
    );
    assert_ok(
        session
            .handle(candidate_command(6, OpTag::AbortRuntime, candidate_token))
            .envelope,
    );
}

fn replace_bytes_field(value: &AbiValue, index: usize, what: &str) -> AbiValue {
    let mut fields = tuple_fields(value);
    let AbiValue::Bytes(mut bytes) = fields[index].clone() else {
        panic!("{what}[{index}] must be bytes")
    };
    assert!(!bytes.is_empty(), "{what}[{index}] must not be empty");
    bytes[0] ^= 1;
    fields[index] = AbiValue::Bytes(bytes);
    tuple_of(fields)
}

fn replace_tuple_field(
    value: &AbiValue,
    index: usize,
    replacement: AbiValue,
    arity: usize,
    what: &str,
) -> AbiValue {
    let mut fields = exact_tuple(value, arity, what);
    fields[index] = replacement;
    tuple_of(fields)
}

fn corrupt_pending_hanko(row: &AbiValue) -> AbiValue {
    let mut row_fields = exact_tuple(row, 9, "account restore");
    let mut consensus = exact_tuple(&row_fields[8], 11, "consensus snapshot");
    let mut pending = exact_tuple(&consensus[2], 5, "pending frame");
    let AbiValue::Bytes(mut hanko) = pending[2].clone() else {
        panic!("pending Hanko must be bytes")
    };
    assert!(!hanko.is_empty(), "pending Hanko must not be empty");
    hanko[0] ^= 1;
    pending[2] = AbiValue::Bytes(hanko);
    consensus[2] = tuple_of(pending);
    row_fields[8] = tuple_of(consensus);
    tuple_of(row_fields)
}

fn tamper_current_frame_body(row: &AbiValue) -> AbiValue {
    let mut row_fields = exact_tuple(row, 9, "account restore");
    let mut consensus = exact_tuple(&row_fields[8], 11, "consensus snapshot");
    let mut current = exact_tuple(&consensus[1], 2, "committed frame");
    let mut frame = exact_tuple(&current[0], 8, "checkpoint frame");
    let AbiValue::Integer(timestamp) = frame[1] else {
        panic!("checkpoint timestamp must be integer")
    };
    frame[1] = AbiValue::Integer(timestamp + 1);
    current[0] = tuple_of(frame);
    consensus[1] = tuple_of(current);
    row_fields[8] = tuple_of(consensus);
    tuple_of(row_fields)
}

fn remove_current_frame_certificate(row: &AbiValue) -> AbiValue {
    let mut row_fields = exact_tuple(row, 9, "account restore");
    let mut consensus = exact_tuple(&row_fields[8], 11, "consensus snapshot");
    assert!(
        !matches!(consensus[1], AbiValue::Nil),
        "fixture must contain a committed frame",
    );
    assert!(
        !matches!(consensus[5], AbiValue::Nil),
        "fixture must contain the counterparty certificate",
    );
    consensus[5] = AbiValue::Nil;
    row_fields[8] = tuple_of(consensus);
    tuple_of(row_fields)
}

fn corrupt_local_committed_hanko(row: &AbiValue) -> AbiValue {
    let mut row_fields = exact_tuple(row, 9, "account restore");
    let mut consensus = exact_tuple(&row_fields[8], 11, "consensus snapshot");
    let AbiValue::Bytes(mut hanko) = consensus[6].clone() else {
        panic!("local committed Hanko must be bytes")
    };
    assert!(!hanko.is_empty(), "local committed Hanko must not be empty");
    hanko[0] ^= 1;
    consensus[6] = AbiValue::Bytes(hanko);
    row_fields[8] = tuple_of(consensus);
    tuple_of(row_fields)
}

fn replace_left_claim_count(row: &AbiValue, count: u64) -> AbiValue {
    let mut row_fields = exact_tuple(row, 9, "account restore");
    let mut header = exact_tuple(&row_fields[2], 9, "checkpoint header");
    let mut carried = exact_tuple(&header[6], 6, "checkpoint carried");
    let mut left_claims = exact_tuple(&carried[4], 2, "left claims");
    left_claims[1] = AbiValue::Integer(i128::from(count));
    carried[4] = tuple_of(left_claims);
    header[6] = tuple_of(carried);
    row_fields[2] = tuple_of(header);
    tuple_of(row_fields)
}

/// Convert a full first checkpoint row into the materialized values
/// `RestoreExact` reads. Production does the same from canonical LevelDB;
/// this helper deliberately understands node records rather than reaching
/// into the engine that produced them.
pub(crate) fn materialize_restore_row(value: &AbiValue) -> AbiValue {
    let fields = exact_tuple(value, 10, "checkpoint account");
    tuple_of(vec![
        fields[0].clone(),
        fields[1].clone(),
        fields[2].clone(),
        tuple_of(leaf_values(&fields[4])),
        tuple_of(leaf_values(&fields[5])),
        tuple_of(lending_values(&fields[6])),
        tuple_of(leaf_values(&fields[7])),
        tuple_of(policy_values(&fields[8])),
        fields[9].clone(),
    ])
}

/// A pending proposal changes only the Account consensus envelope: its
/// financial candidate is held behind the ACK. Apply that incremental shell
/// row over the already materialized durable financial collections.
fn materialize_shell_checkpoint_over(base: &AbiValue, value: &AbiValue) -> AbiValue {
    let base = exact_tuple(base, 9, "base account restore");
    let fields = exact_tuple(value, 10, "checkpoint account");
    for changes in &fields[4..=8] {
        assert!(
            leaf_rows(changes).is_empty(),
            "a pending proposal must not checkpoint its unacked financial candidate"
        );
    }
    tuple_of(vec![
        fields[0].clone(),
        fields[1].clone(),
        fields[2].clone(),
        base[3].clone(),
        base[4].clone(),
        base[5].clone(),
        base[6].clone(),
        base[7].clone(),
        fields[9].clone(),
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
fn wave_create_decodes_a_genesis_seed_and_materializes_the_new_account() {
    use crate::test_fixture::{
        apply_wave, authority_entity, authority_genesis_account, begin_entity, candidate_command,
        finalize_entity, hello_authority, load_accounts, prepare_empty_wave, seal_wave,
        wave_add_delta, wave_create,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(session.handle(load_accounts(1, 0, Vec::new())).envelope);

    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let stage_key = [0x38; 32];
    assert_ok(
        session
            .handle(begin_entity(
                3,
                token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                false,
            ))
            .envelope,
    );
    let applied = session
        .handle(apply_wave(
            4,
            token,
            stage_key,
            owner,
            vec![
                wave_create(0, authority_genesis_account(owner, peer)),
                wave_add_delta(1, peer, 1),
            ],
        ))
        .envelope;
    assert_ok(applied.clone());
    assert_ok(
        session
            .handle(finalize_entity(5, token, stage_key, 0))
            .envelope,
    );
    let fields = body_fields(&applied);
    assert_eq!(tuple_fields(&fields[5]).len(), 1, "created leaf is touched");
    assert_eq!(
        tuple_fields(&fields[6]).len(),
        1,
        "created account has exact checkpoint rows"
    );
    assert_ok(session.handle(seal_wave(6, token)).envelope);
    assert_ok(
        session
            .handle(candidate_command(7, OpTag::CommitRuntime, token))
            .envelope,
    );
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

#[test]
fn authority_cannot_seal_a_create_without_a_real_account_operation() {
    use crate::test_fixture::{
        apply_wave, authority_entity, authority_genesis_account, begin_entity, candidate_command,
        finalize_entity, hello_authority, load_accounts, prepare_empty_wave, seal_wave,
        wave_create,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(session.handle(load_accounts(1, 0, Vec::new())).envelope);
    let prepared = session.handle(prepare_empty_wave(2)).envelope;
    assert_ok(prepared.clone());
    let token = candidate_token(&prepared);
    let stage_key = [0x39; 32];
    assert_ok(
        session
            .handle(begin_entity(
                3,
                token,
                stage_key,
                0,
                owner,
                1_700_000_000_000,
                false,
            ))
            .envelope,
    );
    assert_ok(
        session
            .handle(apply_wave(
                4,
                token,
                stage_key,
                owner,
                vec![wave_create(0, authority_genesis_account(owner, peer))],
            ))
            .envelope,
    );
    assert_ok(
        session
            .handle(finalize_entity(5, token, stage_key, 0))
            .envelope,
    );
    assert_error(
        session.handle(seal_wave(6, token)).envelope,
        "RSCORE_BATCH_WAVE_CREATE_UNUSED",
    );
    assert_ok(
        session
            .handle(candidate_command(7, OpTag::AbortRuntime, token))
            .envelope,
    );
}

#[test]
fn malformed_wave_create_arity_is_rejected_before_opening_a_candidate() {
    use crate::test_fixture::{authority_entity, hello_authority, load_accounts, prepare_wave_ops};

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(session.handle(load_accounts(1, 0, Vec::new())).envelope);
    let malformed = tuple_of(vec![AbiValue::Integer(2), AbiValue::Integer(0)]);
    assert_error(
        session
            .handle(prepare_wave_ops(
                2,
                owner,
                1_700_000_000_000,
                vec![malformed],
                false,
            ))
            .envelope,
        "RSCORE_PROCESS_ARITY:waveCreate:2:3",
    );
}
