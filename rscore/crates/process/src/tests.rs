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
        "4167098443193249c0830aaf379042961a1a8a0f84fef48afdaefa1e297e40c0"
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
    // The prepared reply carries the engine's own execution microseconds, which
    // are wall-clock by nature: compare everything else byte for byte.
    assert_eq!(
        without_engine_micros(&first.body),
        without_engine_micros(&second.body)
    );
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

/// The prepared body minus its trailing timing field.
fn without_engine_micros(body: &xln_rscore_abi::BodyTuple) -> Vec<AbiValue> {
    let AbiValue::Tuple(fields) = &body.fields()[0] else {
        panic!("prepared body must be a tuple")
    };
    let fields = fields.fields();
    fields[..fields.len() - 1].to_vec()
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

fn tuple_fields(value: &AbiValue) -> Vec<AbiValue> {
    let AbiValue::Tuple(payload) = value else {
        panic!("tuple expected: {value:?}");
    };
    payload.fields().to_vec()
}

/// The authoritative session end to end over the wire: it derives its own
/// keys from the seed, queues a payment, signs a frame for it, and the wave is
/// only kept when the runtime says its own record is durable.
#[test]
fn an_authority_session_proposes_a_signed_frame_in_one_wave() {
    use crate::test_fixture::{
        authority_account, authority_entity, hello_authority, load_accounts, prepare_wave,
        wave_payment,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");

    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    assert_ok(
        session
            .handle(load_accounts(1, 0, vec![authority_account(owner, peer)]))
            .envelope,
    );

    let prepared = session
        .handle(prepare_wave(
            2,
            owner,
            1_700_000_000_000,
            vec![wave_payment(peer, owner, peer, 25)],
            Vec::new(),
            true,
        ))
        .envelope;
    assert_ok(prepared.clone());
    let fields = body_fields(&prepared);
    let proposals = tuple_fields(&fields[3]);
    assert_eq!(
        proposals.len(),
        1,
        "one account had something to propose: {fields:?}"
    );
    let proposal = exact_tuple(&proposals[0], 3, "proposal");
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
    // Touched leaves and the parity digest travel with every wave.
    assert_eq!(tuple_fields(&fields[4]).len(), 1, "one account moved");
    let AbiValue::Bytes(digest) = &fields[5] else {
        panic!("expected a parity digest: {:?}", fields[5]);
    };
    assert_eq!(digest.len(), 32);

    // A wave the runtime has not committed blocks the next one.
    assert_error(
        session
            .handle(prepare_wave(
                3,
                owner,
                1_700_000_000_001,
                Vec::new(),
                Vec::new(),
                true,
            ))
            .envelope,
        "RSCORE_PROCESS_PREPARE_PENDING",
    );
    // Only the request that prepared it may commit it.
    assert_error(
        session
            .handle(candidate_command(4, OpTag::CommitRuntime, 3))
            .envelope,
        "RSCORE_PROCESS_PREPARE_ID_MISMATCH",
    );
    assert_ok(
        session
            .handle(candidate_command(5, OpTag::CommitRuntime, 2))
            .envelope,
    );
}

/// A wave the runtime takes back leaves the engine exactly where it was, and
/// the same wave can be prepared again.
#[test]
fn an_aborted_wave_puts_the_authority_engine_back() {
    use crate::test_fixture::{
        authority_account, authority_entity, hello_authority, load_accounts, prepare_wave,
        wave_payment,
    };

    const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    let owner = authority_entity(SEED, "1");
    let peer = authority_entity(SEED, "2");

    let mut session = ProcessSession::new();
    assert_ok(session.handle(hello_authority(0, SEED, "1")).envelope);
    let loaded = session
        .handle(load_accounts(1, 0, vec![authority_account(owner, peer)]))
        .envelope;
    assert_ok(loaded.clone());
    let root_before = body_fields(&loaded)[1].clone();

    let first = session
        .handle(prepare_wave(
            2,
            owner,
            1_700_000_000_000,
            vec![wave_payment(peer, owner, peer, 25)],
            Vec::new(),
            true,
        ))
        .envelope;
    assert_ok(first.clone());
    let aborted = session
        .handle(candidate_command(3, OpTag::AbortRuntime, 2))
        .envelope;
    assert_ok(aborted.clone());
    assert_eq!(
        body_fields(&aborted)[1],
        root_before,
        "the abort restores the accounts root",
    );

    let second = session
        .handle(prepare_wave(
            4,
            owner,
            1_700_000_000_000,
            vec![wave_payment(peer, owner, peer, 25)],
            Vec::new(),
            true,
        ))
        .envelope;
    assert_ok(second.clone());
    assert_eq!(
        body_fields(&second)[3],
        body_fields(&first)[3],
        "the same wave reaches the same proposal",
    );
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
            fee_token_id: Some(2),
            fee_amount: Some(BigInt::from(7)),
            execution_give_amount: Some(BigInt::from(1_000_000)),
            execution_want_amount: Some(BigInt::from(2_000_000)),
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
            fee_token_id: None,
            fee_amount: None,
            execution_give_amount: None,
            execution_want_amount: None,
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
