//! Generate the committed seed corpora for the C7 fuzz targets.
//!
//! Sources (rule 3 of proofs/readme.md: vectors are never written by hand —
//! they are extracted from the repository's own committed test vectors or
//! produced by the production encoders):
//! - core/__tests__/rscore/tx-wire-vectors.json  (TypeScript-written tx wire)
//! - rscore/fixtures/entity-kernel/parity-v1.json (committed orderbook parity)
//! - production encoders: encode_hanko_envelope, encode_envelope,
//!   encode_value, encode_account_tx, BookState::empty().snapshot()

use std::fs;
use std::path::{Path, PathBuf};

use num_bigint::BigInt;
use xln_parser_fuzz_harness::{
    abi_value_seed, book_snapshot_from_cursor, book_snapshot_seed,
};
use xln_rscore_abi::{
    AbiValue, BodyTuple, EngineIdentity, Envelope, MessageKind, OpTag, ProtocolBinding,
    encode_envelope, encode_value,
};
use xln_rscore_entity_kernel::{
    BookPricePageEntrySnapshot, BookPricePageSnapshot, BookState, BookStateSnapshot,
};
use xln_rscore_hanko::abi::{AbiClaim, AbiEnvelope};
use xln_rscore_hanko::{HankoEnvelope, encode_hanko_envelope};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../")
}

fn seeds_dir(target: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeds").join(target);
    fs::create_dir_all(&dir).expect("create seed dir");
    dir
}

fn write_seed(target: &str, name: &str, bytes: &[u8]) {
    fs::write(seeds_dir(target).join(name), bytes).expect("write seed");
}

fn word(value: u64) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

/// Minimal hex decode (no external deps).
fn from_hex(text: &str) -> Vec<u8> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    (0..digits.len() / 2)
        .map(|index| {
            u8::from_str_radix(&digits[index * 2..index * 2 + 2], 16).expect("seed hex")
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Target 1: hanko envelopes from the production encoder.
// ---------------------------------------------------------------------------

fn hanko_seeds() {
    let empty = encode_hanko_envelope(&HankoEnvelope {
        placeholders: Vec::new(),
        packed_signatures: Vec::new(),
        claims: Vec::new(),
    })
    .expect("empty hanko envelope");
    write_seed("hanko_envelope", "empty", &empty);

    let placeholder = encode_hanko_envelope(&HankoEnvelope {
        placeholders: vec![word(7)],
        packed_signatures: Vec::new(),
        claims: Vec::new(),
    })
    .expect("placeholder hanko envelope");
    write_seed("hanko_envelope", "placeholder", &placeholder);

    // One canonical low-s signature: r nonzero, s below the half-order,
    // recovery bit 0 (v=27) — packed as 64 bytes + one zero recovery byte.
    let mut packed = vec![0x11_u8; 65];
    packed[64] = 0;
    let signature_envelope = encode_hanko_envelope(&HankoEnvelope {
        placeholders: Vec::new(),
        packed_signatures: packed,
        claims: Vec::new(),
    })
    .expect("signature hanko envelope");
    write_seed("hanko_envelope", "one-signature", &signature_envelope);

    let claim = AbiClaim {
        entity_id: word(9),
        entity_indexes: vec![word(1), word(2)],
        weights: vec![word(1), word(1)],
        threshold: word(1),
        board_change_delay: 3600,
        control_change_delay: 3600,
        dividend_change_delay: 3600,
    };
    let claimed = encode_hanko_abi_envelope(&AbiEnvelope {
        placeholders: vec![word(1), word(2)],
        packed_signatures: Vec::new(),
        claims: vec![claim],
    });
    write_seed("hanko_envelope", "claim", &claimed);

    // Truncations of the claim envelope (boundary probing).
    for end in [claimed.len() - 1, claimed.len() / 2, 40] {
        write_seed("hanko_envelope", &format!("claim-truncated-{end}"), &claimed[..end]);
    }
}

fn encode_hanko_abi_envelope(envelope: &AbiEnvelope) -> Vec<u8> {
    encode_hanko_envelope(&HankoEnvelope {
        placeholders: envelope.placeholders.clone(),
        packed_signatures: envelope.packed_signatures.clone(),
        claims: envelope.claims.clone(),
    })
    .expect("hanko envelope encode")
}

// ---------------------------------------------------------------------------
// Target 2: ABI envelopes from the production encoder (golden from
// crates/abi/src/tests.rs sample shapes plus boundary bodies).
// ---------------------------------------------------------------------------

fn sample_body() -> BodyTuple {
    BodyTuple::from_array([
        AbiValue::Nil,
        AbiValue::Bool(true),
        AbiValue::Integer(-33),
        AbiValue::Text("phase".into()),
        AbiValue::Bytes(vec![0x03, 0x91, 0xc0]),
        AbiValue::Tuple(BodyTuple::from_array([AbiValue::Integer(7), AbiValue::Nil])),
    ])
}

fn envelope(op_tag: OpTag, body: BodyTuple) -> Envelope {
    Envelope {
        binding: ProtocolBinding {
            protocol_version: 4,
            storage_schema_version: 9,
            protocol_fingerprint: std::array::from_fn(|index| index as u8),
        },
        identity: EngineIdentity {
            engine_generation: std::array::from_fn(|index| 0xa0 + index as u8),
            runtime_id: std::array::from_fn(|index| 0x10 + index as u8),
            session_id: std::array::from_fn(|index| 0x20 + index as u8),
            request_id: std::array::from_fn(|index| 0x30 + index as u8),
        },
        op_tag,
        message_kind: MessageKind::Request,
        body,
    }
}

fn abi_envelope_seeds() {
    // Golden vector from crates/abi/src/tests.rs (arity 6 → control byte 6).
    let golden = encode_envelope(&envelope(OpTag::ExecuteWave, sample_body())).expect("encode");
    let mut seed = vec![6_u8];
    seed.extend_from_slice(&golden);
    write_seed("abi_envelope", "golden-arity6", &seed);

    let boundary_values = [
        ("zero", AbiValue::Integer(0)),
        ("neg-one", AbiValue::Integer(-1)),
        ("i8-min", AbiValue::Integer(i128::from(i8::MIN))),
        ("u16-max", AbiValue::Integer(i128::from(u16::MAX))),
        ("u32-max", AbiValue::Integer(i128::from(u32::MAX))),
        ("u64-max", AbiValue::Integer(i128::from(u64::MAX))),
        ("i64-min", AbiValue::Integer(i128::from(i64::MIN))),
        ("i64-max", AbiValue::Integer(i128::from(i64::MAX))),
        ("empty-text", AbiValue::Text(String::new())),
        ("text-31", AbiValue::Text("a".repeat(31))),
        ("text-32", AbiValue::Text("a".repeat(32))),
        ("text-55", AbiValue::Text("a".repeat(55))),
        ("text-56", AbiValue::Text("a".repeat(56))),
        ("empty-bytes", AbiValue::Bytes(Vec::new())),
        ("bytes-255", AbiValue::Bytes(vec![0xaa; 255])),
        ("bytes-256", AbiValue::Bytes(vec![0xaa; 256])),
        (
            "nested-depth3",
            AbiValue::Tuple(BodyTuple::from_vec(vec![
                AbiValue::Tuple(BodyTuple::from_vec(vec![
                    AbiValue::Tuple(BodyTuple::from_vec(vec![AbiValue::Nil])),
                ])),
            ])),
        ),
    ];
    for (name, value) in boundary_values {
        let body = BodyTuple::from_vec(vec![value]);
        let encoded = encode_envelope(&envelope(OpTag::Hello, body)).expect("encode boundary");
        let mut seed = vec![1_u8];
        seed.extend_from_slice(&encoded);
        write_seed("abi_envelope", &format!("boundary-{name}"), &seed);
    }

    // Non-canonical probe: golden with one flipped body byte (digest mismatch).
    let mut mutated = golden.clone();
    let last = mutated.len() - 1;
    mutated[last] ^= 0x01;
    let mut seed = vec![6_u8];
    seed.extend_from_slice(&mutated);
    write_seed("abi_envelope", "golden-body-flip", &seed);
}

// ---------------------------------------------------------------------------
// Target 3: process wire — TypeScript tx vectors + accepted command scaffolds.
// ---------------------------------------------------------------------------

fn tx_wire_seeds() {
    let path = root().join("core/__tests__/rscore/tx-wire-vectors.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let mut count = 0;
    for chunk in text.split("\"name\":").skip(1) {
        let name = chunk.split('"').nth(1).expect("vector name");
        let hex = chunk
            .split("\"bytes\":")
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .expect("vector bytes");
        let bytes = from_hex(hex);
        let mut seed = vec![0_u8]; // mode 0: raw wire bytes
        seed.extend_from_slice(&bytes);
        let safe = name.replace('/', "_");
        write_seed("process_wire", &format!("tx-{safe}"), &seed);
        count += 1;
    }
    println!("tx wire vectors: {count}");

    command_seeds("process_wire", true);
}

fn value_bytes(value: &AbiValue) -> Vec<u8> {
    let mut out = Vec::new();
    abi_value_seed(value, &mut out);
    out
}

/// Accepted-decode command bodies (session rejects them post-decode with
/// HelloRequired, exercising the deepest decoder paths from a green prefix).
fn command_seeds(target: &str, with_mode_byte: bool) {
    let fprint = |suffix: u8| {
        let mut fingerprint = [0xd7_u8; 32];
        fingerprint[31] = suffix;
        fingerprint
    };

    let shutdown = value_bytes(&AbiValue::Tuple(BodyTuple::from_vec(vec![])));
    let read_envelope = value_bytes(&AbiValue::Tuple(BodyTuple::from_vec(vec![
        AbiValue::Bytes(vec![0x55; 32]),
    ])));
    let token = AbiValue::Tuple(BodyTuple::from_vec(vec![
        AbiValue::Integer(0),
        AbiValue::Integer(1),
        AbiValue::Bytes(vec![0x11; 32]),
        AbiValue::Bytes(vec![0x22; 32]),
        AbiValue::Integer(0),
    ]));
    let restore = value_bytes(&AbiValue::Tuple(BodyTuple::from_vec(vec![
        token.clone(),
        AbiValue::Tuple(BodyTuple::from_vec(vec![])),
    ])));
    let inbound = value_bytes(&AbiValue::Tuple(BodyTuple::from_vec(vec![
        AbiValue::Bytes(vec![0x01; 32]),            // ownerEntityId
        AbiValue::Bytes(vec![0x02; 32]),            // expectedAccountsRoot
        AbiValue::Tuple(BodyTuple::from_vec(vec![   // receiverClock
            AbiValue::Integer(1),
            AbiValue::Integer(2),
        ])),
        AbiValue::Tuple(BodyTuple::from_vec(vec![])), // rows
        AbiValue::Bool(true),                        // postAccounts
    ])));
    let outbound = value_bytes(&AbiValue::Tuple(BodyTuple::from_vec(vec![
        AbiValue::Bytes(vec![0x01; 32]),             // ownerEntityId
        AbiValue::Integer(1000),                     // timestamp
        AbiValue::Integer(3),                        // jHeight
        AbiValue::Tuple(BodyTuple::from_vec(vec![])), // creates
        AbiValue::Tuple(BodyTuple::from_vec(vec![])), // admits
        AbiValue::Tuple(BodyTuple::from_vec(vec![])), // propose
        AbiValue::Tuple(BodyTuple::from_vec(vec![])), // materialize
        AbiValue::Tuple(BodyTuple::from_vec(vec![])), // failedHtlcRoutes
        AbiValue::Bytes(vec![0x03; 32]),             // accountsRoot (unused extra)
        AbiValue::Bool(true),                        // postAccounts (8)
        AbiValue::Bool(false),                       // checkpointDue (9)
    ])));

    // [mode?] [op byte] [value seed] [fingerprint 32] [identity 52] [version 2]
    let mut build = |name: &str, op: u8, value: &[u8], fingerprint_suffix: u8| {
        let mut seed = Vec::new();
        if with_mode_byte {
            seed.push(1);
        }
        seed.push(op);
        seed.extend_from_slice(value);
        seed.extend_from_slice(&fprint(fingerprint_suffix));
        seed.extend_from_slice(&[0_u8; 52]);
        seed.extend_from_slice(&[0, 1]); // protocol_version bytes
        write_seed(target, name, &seed);
    };

    if with_mode_byte {
        build("cmd-shutdown", 13, &shutdown, 0);
        build("cmd-read-envelope", 18, &read_envelope, 0);
        build("cmd-inbound-empty", 25, &inbound, 0);
        build("cmd-outbound-empty", 26, &outbound, 0);
        build("cmd-hello-shape", 0, &value_bytes(&AbiValue::Tuple(BodyTuple::from_vec(vec![
            AbiValue::Integer(33),
            AbiValue::Integer(4),
            AbiValue::Tuple(BodyTuple::from_vec(vec![])), // swap tokens
            AbiValue::Tuple(BodyTuple::from_vec(vec![])), // swap steps
        ]))), 0);
    }
    // checkpoint_wire target: [choice][value]; choice 0 = RestoreExact,
    // 1 = BootstrapAccounts, 2 = BootstrapEntity, 3 = AccountInbound,
    // 4 = AccountOutbound.
    let mut restore_seed = vec![0_u8];
    restore_seed.extend_from_slice(&restore);
    write_seed(target, "restore-empty", &restore_seed);

    let mut inbound_seed = vec![3_u8];
    inbound_seed.extend_from_slice(&inbound);
    write_seed(target, "inbound-empty", &inbound_seed);

    let mut outbound_seed = vec![4_u8];
    outbound_seed.extend_from_slice(&outbound);
    write_seed(target, "outbound-empty", &outbound_seed);

    let mut shutdown_seed = vec![0_u8];
    shutdown_seed.extend_from_slice(&shutdown);
    write_seed(target, "shutdown-empty", &shutdown_seed);
}

// ---------------------------------------------------------------------------
// Target 5: orderbook page snapshots — empty accepted book + committed parity
// fixture + deliberately non-canonical probes.
// ---------------------------------------------------------------------------

fn orderbook_seeds() {
    // (a) A book the reader accepts: empty pages, roots and commitment
    // computed by the production snapshot() itself.
    let empty = BookState::empty(10, 1);
    let snapshot = empty.snapshot().expect("empty book snapshot");
    let seed = book_snapshot_seed(&snapshot);
    // Self-check: the seed must parse back to an acceptable snapshot.
    let mut cursor = xln_parser_fuzz_harness::Cursor::new(&seed);
    let parsed = book_snapshot_from_cursor(&mut cursor);
    let restored = BookState::restore(parsed.clone()).expect("seed parses to accepted book");
    assert_eq!(
        restored.snapshot().expect("resnapshot"),
        parsed,
        "seed round trip must be idempotent"
    );
    write_seed("orderbook_page", "empty-accepted", &seed);

    // (b) The committed TypeScript parity fixture (pages with holes).
    let path = root().join("rscore/fixtures/entity-kernel/parity-v1.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let oracle: serde_json::Value = serde_json::from_str(&text).expect("parity fixture json");
    let source = &oracle["bookHydration"];
    if !source.is_null() {
        let fixture = fixture_book(source);
        let seed = book_snapshot_seed(&fixture);
        let mut cursor = xln_parser_fuzz_harness::Cursor::new(&seed);
        let parsed = book_snapshot_from_cursor(&mut cursor);
        let restored = BookState::restore(parsed.clone()).expect("fixture book restores");
        assert_eq!(
            restored.snapshot().expect("resnapshot"),
            parsed,
            "fixture seed round trip must be idempotent"
        );
        write_seed("orderbook_page", "parity-fixture", &seed);
    }

    // (c) Rejection probes in the exact grammar, sharing the empty book's
    // scalar tail (roots cannot match a book with pages, so these probe the
    // page-key encode path `page_key` and its length guards).
    let scalars_tail = |out: &mut Vec<u8>| {
        out.push(1); // bucket width 1
        out.push(1); // stp policy 1
        out.extend_from_slice(&9_u16.to_be_bytes()); // max_orders - 1 → 10
        out.extend_from_slice(&1_u64.to_be_bytes()); // next_seq
        out.extend_from_slice(&0_u64.to_be_bytes()); // trade_count
        out.extend_from_slice(&[0, 1, b'0']); // trade_qty_sum "0"
        out.extend_from_slice(&[0, 1, b'0']); // last_trade_price "0"
        out.extend_from_slice(&[0, 1, b'0']); // last_ask "0"
        out.extend_from_slice(&[0, 1, b'0']); // event_hash "0"
        out.extend_from_slice(&[0_u8; 32]); // expected bid root
        out.extend_from_slice(&[0_u8; 32]); // expected ask root
        out.extend_from_slice(&[0_u8; 16]); // expected commitment (16-byte checksum)
    };

    // Probe 1: price 0 (sign 0, zero-length magnitude) — page_key must reject.
    let mut zero_price = vec![1_u8]; // one bid page
    zero_price.extend_from_slice(&[0, 0]); // sign, length 0 → price 0
    zero_price.extend_from_slice(&[0, 0]); // sequence
    zero_price.extend_from_slice(&[0, 1, 0]); // head, next, live
    zero_price.extend_from_slice(&[0, 1, b'0']); // total qty "0"
    zero_price.extend_from_slice(&vec![0; 16 * 10]); // all slots absent
    zero_price.push(0); // no ask pages
    scalars_tail(&mut zero_price);
    write_seed("orderbook_page", "zero-price-page", &zero_price);

    // Probe 2: negative price (sign 1) — page_key must reject.
    let mut negative_price = vec![1_u8];
    negative_price.extend_from_slice(&[1, 2, 0x01, 0x00]); // sign, length 2, magnitude
    negative_price.extend_from_slice(&zero_price[6..]);
    write_seed("orderbook_page", "negative-price-page", &negative_price);

    // Probe 3: 255-byte price magnitude (the maximum accepted key width) with
    // a live slot — exercises the widest page_key encoding.
    let mut wide_price = vec![1_u8];
    wide_price.extend_from_slice(&[0, 255]);
    wide_price.extend_from_slice(&vec![0x7f; 255]);
    wide_price.extend_from_slice(&[0, 0]); // sequence
    wide_price.extend_from_slice(&[0, 1, 1]); // head 0, next 1, live 1
    wide_price.extend_from_slice(&[0, 1, b'1']); // total qty "1"
    // slot 0: present, order id "a", owner "b", qty "1", seq 1
    wide_price.extend_from_slice(&[1, 1, b'a', 1, b'b', 0, 1, b'1']);
    wide_price.extend_from_slice(&1_u64.to_be_bytes());
    wide_price.extend_from_slice(&vec![0; 15 * 10]); // remaining slots absent
    wide_price.push(0);
    scalars_tail(&mut wide_price);
    write_seed("orderbook_page", "wide-price-page", &wide_price);
}

fn fixture_bigint(value: &serde_json::Value, field: &str) -> BigInt {
    value[field].as_str().expect("fixture bigint").parse().expect("fixture bigint")
}

fn fixture_pages(value: &serde_json::Value, field: &str) -> Vec<BookPricePageSnapshot> {
    value[field]
        .as_array()
        .expect("fixture pages")
        .iter()
        .map(|page| BookPricePageSnapshot {
            price_ticks: fixture_bigint(page, "priceTicks"),
            page_sequence: u16::try_from(page["pageSequence"].as_u64().expect("pageSequence"))
                .expect("pageSequence u16"),
            head_slot: usize::try_from(page["headSlot"].as_u64().expect("headSlot")).expect("u"),
            next_slot: usize::try_from(page["nextSlot"].as_u64().expect("nextSlot")).expect("u"),
            live_count: usize::try_from(page["liveCount"].as_u64().expect("liveCount")).expect("u"),
            total_qty_lots: fixture_bigint(page, "totalQtyLots"),
            slots: page["slots"]
                .as_array()
                .expect("slots")
                .iter()
                .map(|entry| {
                    if entry.is_null() {
                        return None;
                    }
                    Some(BookPricePageEntrySnapshot {
                        order_id: entry["orderId"].as_str().expect("orderId").to_string(),
                        owner_id: entry["ownerId"].as_str().expect("ownerId").to_string(),
                        qty_lots: fixture_bigint(entry, "qtyLots"),
                        seq: entry["seq"].as_u64().expect("seq"),
                    })
                })
                .collect(),
        })
        .collect()
}

fn fixture_book(value: &serde_json::Value) -> BookStateSnapshot {
    BookStateSnapshot {
        bucket_width_ticks: fixture_bigint(value, "bucketWidthTicks"),
        stp_policy: u8::try_from(value["stpPolicy"].as_u64().expect("stpPolicy")).expect("u8"),
        max_orders: usize::try_from(value["maxOrders"].as_u64().expect("maxOrders")).expect("u"),
        next_seq: value["nextSeq"].as_u64().expect("nextSeq"),
        trade_count: value["tradeCount"].as_u64().expect("tradeCount"),
        trade_qty_sum: fixture_bigint(value, "tradeQtySum"),
        last_trade_price_ticks: fixture_bigint(value, "lastTradePriceTicks"),
        last_accepted_usd_ask_price_ticks: fixture_bigint(
            value,
            "lastAcceptedUsdAskPriceTicks",
        ),
        event_hash: fixture_bigint(value, "eventHash"),
        bid_pages: fixture_pages(value, "bidPages"),
        ask_pages: fixture_pages(value, "askPages"),
        expected_bid_pages_root: value["expectedBidPagesRoot"].as_str().expect("root").into(),
        expected_ask_pages_root: value["expectedAskPagesRoot"].as_str().expect("root").into(),
        expected_commitment_hash: value["expectedCommitmentHash"]
            .as_str()
            .expect("commitment")
            .into(),
    }
}

// ---------------------------------------------------------------------------
// Target 6: msgpack values from the production encoder + goldens.
// ---------------------------------------------------------------------------

fn msgpack_seeds() {
    let values = [
        ("nil", AbiValue::Nil),
        ("false", AbiValue::Bool(false)),
        ("true", AbiValue::Bool(true)),
        ("zero", AbiValue::Integer(0)),
        ("neg-one", AbiValue::Integer(-1)),
        ("i8-min", AbiValue::Integer(i128::from(i8::MIN))),
        ("u8-max", AbiValue::Integer(i128::from(u8::MAX))),
        ("u16-max", AbiValue::Integer(i128::from(u16::MAX))),
        ("u32-max", AbiValue::Integer(i128::from(u32::MAX))),
        ("u64-max", AbiValue::Integer(i128::from(u64::MAX))),
        ("i64-min", AbiValue::Integer(i128::from(i64::MIN))),
        ("i64-max", AbiValue::Integer(i128::from(i64::MAX))),
        ("empty-text", AbiValue::Text(String::new())),
        ("text-31", AbiValue::Text("t".repeat(31))),
        ("text-32", AbiValue::Text("t".repeat(32))),
        ("text-255", AbiValue::Text("t".repeat(255))),
        ("text-256", AbiValue::Text("t".repeat(256))),
        ("empty-bytes", AbiValue::Bytes(Vec::new())),
        ("bytes-255", AbiValue::Bytes(vec![0xbb; 255])),
        ("bytes-256", AbiValue::Bytes(vec![0xbb; 256])),
        ("bytes-65535", AbiValue::Bytes(vec![0xbb; 65535])),
        (
            "tuple-empty",
            AbiValue::Tuple(BodyTuple::from_vec(vec![])),
        ),
        (
            "tuple-15",
            AbiValue::Tuple(BodyTuple::from_vec(
                (0..15).map(AbiValue::Integer).collect(),
            )),
        ),
        (
            "tuple-16",
            AbiValue::Tuple(BodyTuple::from_vec(
                (0..16).map(AbiValue::Integer).collect(),
            )),
        ),
        (
            "nested-depth3",
            AbiValue::Tuple(BodyTuple::from_vec(vec![
                AbiValue::Tuple(BodyTuple::from_vec(vec![
                    AbiValue::Tuple(BodyTuple::from_vec(vec![AbiValue::Nil])),
                ])),
            ])),
        ),
    ];
    for (name, value) in values {
        let bytes = encode_value(&value).expect("encode seed value");
        write_seed("msgpack_value", &format!("value-{name}"), &bytes);
    }

    // Golden body from crates/abi/src/tests.rs and non-minimal integer probe.
    write_seed(
        "msgpack_value",
        "golden-body",
        &from_hex("96c0c3d0dfa57068617365c4030391c09207c0"),
    );
    write_seed("msgpack_value", "nonminimal-u16", &[0xcd, 0x00, 0x05]);
    write_seed("msgpack_value", "nonminimal-u32", &[0xce, 0, 0, 0, 5]);
    write_seed("msgpack_value", "array-claim-huge", &[0xdd, 0xff, 0xff, 0xff, 0xff]);
    write_seed("msgpack_value", "text-claim-huge", &[0xdb, 0xff, 0xff, 0xff, 0xff]);
    write_seed("msgpack_value", "bin-claim-huge", &[0xc6, 0xff, 0xff, 0xff, 0xff]);
    write_seed("msgpack_value", "depth-probe", &vec![0x91; 40]);
}

// ---------------------------------------------------------------------------
// Target 7: ryu-canonical number text + generated canonical values.
// ---------------------------------------------------------------------------

fn protocol_seeds() {
    let numbers = [
        "0", "1", "-1", "0.5", "-0.5", "9007199254740991", "-9007199254740991", "1e+21",
        "1e-7", "1.5e-9", "5e-324", "1.7976931348623157e+308", "100", "1e6", "123456789",
    ];
    for (index, text) in numbers.iter().enumerate() {
        // Format: [text length][text bytes][value grammar bytes]
        let mut seed = vec![u8::try_from(text.len()).expect("seed text length")];
        seed.extend_from_slice(text.as_bytes());
        // Grammar tail: tag 0 → Null value, then zeros for namespace/path.
        seed.extend_from_slice(&[0, 0, 0]);
        write_seed("protocol_value", &format!("number-{index}-{text}"), &seed);
    }
    // Non-canonical probes: valid f64 text that ryu renders differently.
    for (index, text) in ["01", "+1", "1.0", "1E2", " 1", "1 ", ".5", "0x10", "Infinity", "NaN"]
        .iter()
        .enumerate()
    {
        let mut seed = vec![u8::try_from(text.len()).expect("probe length")];
        seed.extend_from_slice(text.as_bytes());
        seed.extend_from_slice(&[0, 0, 0]);
        write_seed("protocol_value", &format!("probe-{index}"), &seed);
    }
    // Rich canonical values: array of number/bigint/string/object.
    let mut seed = vec![4_u8]; // text length 4 ("1e+7"-style text read first)
    seed.extend_from_slice(b"1000");
    // value grammar: tag % 10 == 7 → Array, length byte, elements
    seed.extend_from_slice(&[7, 3]);
    // element 1: tag 2 → Number from be_u64(8)
    seed.extend_from_slice(&[2]);
    seed.extend_from_slice(&42_u64.to_be_bytes());
    // element 2: tag 5 → BigInt from be_i128(16)
    seed.extend_from_slice(&[5]);
    seed.extend_from_slice(&(-12_345_678_901_234_567_890_i128).to_be_bytes());
    // element 3: tag 6 → String from length byte
    seed.extend_from_slice(&[6, 3]);
    seed.extend_from_slice(b"abc");
    write_seed("protocol_value", "array-mixed", &seed);
}

fn main() {
    hanko_seeds();
    abi_envelope_seeds();
    tx_wire_seeds();
    command_seeds("checkpoint_wire", false);
    orderbook_seeds();
    msgpack_seeds();
    protocol_seeds();
    let targets = [
        "hanko_envelope",
        "abi_envelope",
        "process_wire",
        "checkpoint_wire",
        "orderbook_page",
        "msgpack_value",
        "protocol_value",
    ];
    for target in targets {
        let count = fs::read_dir(seeds_dir(target))
            .expect("seed dir")
            .count();
        println!("{target}: {count} seeds");
    }
}
