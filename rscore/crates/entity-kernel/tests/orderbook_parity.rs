mod support;

use std::collections::BTreeSet;

use num_bigint::BigInt;
use support::{
    HUB, MAKER, NEXT, TAKER, account, apply_account, assert_owned_sections, commit, digest_bytes,
    fixture, fixture_text, fixture_u64, orderbook_metadata, tx_digest,
};
use xln_rscore_engine::{AccountOutput, AccountReplica, AccountTx, Side};
use xln_rscore_entity_kernel::{
    BookPricePageEntrySnapshot, BookPricePageSnapshot, BookState, BookStateSnapshot,
    DeterministicContext, EntityKernelOutput, EntityStateSlice, OrderbookState,
    apply_entity_kernel, capture_entity_state, compute_book_commitment_hash,
    compute_entity_owned_sections, restore_entity_state,
};

fn fixture_bigint(value: &serde_json::Value, field: &str) -> BigInt {
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} fixture text"))
        .parse()
        .unwrap_or_else(|_| panic!("{field} fixture bigint"))
}

fn fixture_pages(value: &serde_json::Value, field: &str) -> Vec<BookPricePageSnapshot> {
    value[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} fixture pages"))
        .iter()
        .map(|page| BookPricePageSnapshot {
            price_ticks: fixture_bigint(page, "priceTicks"),
            page_sequence: u16::try_from(page["pageSequence"].as_u64().expect("pageSequence"))
                .expect("pageSequence u16"),
            head_slot: usize::try_from(page["headSlot"].as_u64().expect("headSlot"))
                .expect("headSlot usize"),
            next_slot: usize::try_from(page["nextSlot"].as_u64().expect("nextSlot"))
                .expect("nextSlot usize"),
            live_count: usize::try_from(page["liveCount"].as_u64().expect("liveCount"))
                .expect("liveCount usize"),
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

fn hydration_snapshot(value: &serde_json::Value) -> BookStateSnapshot {
    BookStateSnapshot {
        bucket_width_ticks: fixture_bigint(value, "bucketWidthTicks"),
        stp_policy: u8::try_from(value["stpPolicy"].as_u64().expect("stpPolicy"))
            .expect("stpPolicy u8"),
        max_orders: usize::try_from(value["maxOrders"].as_u64().expect("maxOrders"))
            .expect("maxOrders usize"),
        next_seq: value["nextSeq"].as_u64().expect("nextSeq"),
        trade_count: value["tradeCount"].as_u64().expect("tradeCount"),
        trade_qty_sum: fixture_bigint(value, "tradeQtySum"),
        last_trade_price_ticks: fixture_bigint(value, "lastTradePriceTicks"),
        last_accepted_usd_ask_price_ticks: fixture_bigint(value, "lastAcceptedUsdAskPriceTicks"),
        event_hash: fixture_bigint(value, "eventHash"),
        bid_pages: fixture_pages(value, "bidPages"),
        ask_pages: fixture_pages(value, "askPages"),
        expected_bid_pages_root: value["expectedBidPagesRoot"]
            .as_str()
            .expect("expectedBidPagesRoot")
            .to_string(),
        expected_ask_pages_root: value["expectedAskPagesRoot"]
            .as_str()
            .expect("expectedAskPagesRoot")
            .to_string(),
        expected_commitment_hash: value["expectedCommitmentHash"]
            .as_str()
            .expect("expectedCommitmentHash")
            .to_string(),
    }
}

#[test]
fn exact_typescript_page_snapshot_restores_holes_without_repacking() {
    let oracle = fixture();
    let source = &oracle["bookHydration"];
    let restored = BookState::restore(hydration_snapshot(source)).expect("exact book restore");
    assert_eq!(restored.orders.len(), 2);
    assert!(!restored.orders.contains_key("hydrate-b"));
    assert_eq!(restored.orders["hydrate-a"].page_slot, 0);
    assert_eq!(restored.orders["hydrate-c"].page_slot, 2);
    assert_eq!(
        compute_book_commitment_hash(&restored).expect("restored commitment"),
        source["expectedCommitmentHash"]
            .as_str()
            .expect("commitment")
    );

    let mut corrupted = hydration_snapshot(source);
    corrupted.bid_pages[0].head_slot = 1;
    let error = BookState::restore(corrupted).expect_err("corrupt page must fail");
    assert!(error.to_string().contains("BOOK_PAGE_AGGREGATE_INVALID"));
}

fn assert_book_commitment(book: &BookState, oracle: &serde_json::Value, case: &str) {
    assert_eq!(
        book.bid_pages_root(),
        fixture_text(oracle, &[case, "bidPagesRoot"]),
        "{case} bid pages"
    );
    assert_eq!(
        book.ask_pages_root(),
        fixture_text(oracle, &[case, "askPagesRoot"]),
        "{case} ask pages"
    );
    assert_eq!(
        compute_book_commitment_hash(book).expect("book commitment"),
        fixture_text(oracle, &[case, "bookCommitmentHash"]),
        "{case} book commitment"
    );
}

fn offer_tx_at(offer_id: &str, ask: bool, units: u32, price_ticks: u64) -> AccountTx {
    let base = BigInt::from(units) * BigInt::from(10_u8).pow(18);
    let quote = BigInt::from(units) * BigInt::from(price_ticks) * BigInt::from(100_u8);
    let (give_token_id, give_decimals, give, want_token_id, want_decimals, want) = if ask {
        (2, 18, base, 1, 6, quote)
    } else {
        (1, 6, quote, 2, 18, base)
    };
    let max_fee = &want / BigInt::from(10_000_u32);
    let min_net_receive = &want - &max_fee;
    AccountTx::SwapOffer {
        offer_id: offer_id.to_string(),
        give_token_id,
        give_token_decimals: give_decimals,
        give_amount: give,
        want_token_id,
        want_token_decimals: want_decimals,
        want_amount: want.clone(),
        max_fee,
        min_net_receive,
        time_in_force: Some(0),
        price_ticks: Some(BigInt::from(price_ticks)),
    }
}

fn offer_tx_units(offer_id: &str, ask: bool, units: u32) -> AccountTx {
    offer_tx_at(offer_id, ask, units, 25_000_000)
}

fn offer_tx(offer_id: &str, ask: bool) -> AccountTx {
    offer_tx_units(offer_id, ask, 1)
}

fn offered_account(
    remote: &str,
    tx: &AccountTx,
    j_height: u64,
) -> (AccountReplica, Vec<AccountOutput>) {
    apply_account(&account(remote, &[1, 2]), Side::Right, tx, 0, j_height)
}

fn proposal<'a>(
    result: &'a xln_rscore_entity_kernel::EntityKernelResult,
    account: &str,
) -> &'a AccountTx {
    let group = result
        .proposal_work
        .iter()
        .find(|group| group.account_id == account)
        .expect("account proposal");
    assert_eq!(group.txs.len(), 1);
    &group.txs[0]
}

#[test]
fn same_j_offer_match_and_committed_resolve_lifecycle() {
    let ask = offer_tx("maker-ask", true);
    let bid = offer_tx("taker-bid", false);
    let (maker_account, maker_outputs) = offered_account(MAKER, &ask, 1);
    let (taker_account, taker_outputs) = offered_account(TAKER, &bid, 2);

    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string(), TAKER.to_string()]);
    state.orderbook = Some(OrderbookState::empty(10_000));
    state.orderbook_metadata = Some(orderbook_metadata());
    let first = apply_entity_kernel(
        state,
        &[
            commit(MAKER, 0x41, 1, ask, maker_outputs),
            commit(TAKER, 0x42, 1, bid, taker_outputs),
        ],
        &DeterministicContext::hlt_default(),
    )
    .expect("match pass");
    let oracle = fixture();

    assert_eq!(
        first.outputs,
        vec![EntityKernelOutput::SwapMatched {
            entity_id: HUB.to_string(),
            count: 1,
        }]
    );
    let maker_resolve = proposal(&first, MAKER).clone();
    let taker_resolve = proposal(&first, TAKER).clone();
    assert_eq!(
        first.commitments.paybook_root,
        fixture_text(&oracle, &["sameJFullMatch", "paybookRoot"])
    );
    assert_eq!(
        first.commitments.orderbook_root,
        fixture_text(&oracle, &["sameJFullMatch", "orderbookRoot"])
    );
    assert_eq!(
        first.commitments.ordered_outbox_digest,
        fixture_text(&oracle, &["sameJFullMatch", "orderedOutboxDigest"])
    );
    let account_count = usize::try_from(fixture_u64(
        &oracle,
        &["sameJFullMatch", "canonicalEntity", "accountCount"],
    ))
    .expect("fixture account count");
    let owned = compute_entity_owned_sections(
        &first.state,
        digest_bytes(fixture_text(
            &oracle,
            &["sameJFullMatch", "canonicalEntity", "accountsRoot"],
        )),
        account_count,
    )
    .expect("canonical Entity owned sections");
    assert_owned_sections(&owned, &oracle, "sameJFullMatch");
    let account_root = digest_bytes(fixture_text(
        &oracle,
        &["sameJFullMatch", "canonicalEntity", "accountsRoot"],
    ));
    let snapshot = capture_entity_state(&first.state, account_root, account_count)
        .expect("capture exact Entity state");
    let restored = restore_entity_state(snapshot.clone(), account_root, account_count)
        .expect("restore exact Entity state");
    assert_eq!(restored, first.state);
    let mut corrupted = snapshot;
    corrupted.expected_owned_sections[0].digest = format!("0x{}", "ff".repeat(32));
    assert!(
        restore_entity_state(corrupted, account_root, account_count)
            .expect_err("corrupt Entity snapshot must fail")
            .to_string()
            .contains("ENTITY_OWNED_SECTIONS_MISMATCH")
    );
    assert_eq!(
        tx_digest(&maker_resolve),
        fixture_text(&oracle, &["sameJFullMatch", "makerResolveDigest"])
    );
    assert_eq!(
        tx_digest(&taker_resolve),
        fixture_text(&oracle, &["sameJFullMatch", "takerResolveDigest"])
    );
    let book = &first.state.orderbook.as_ref().expect("orderbook").books["1/2"];
    assert_book_commitment(book, &oracle, "sameJFullMatch");
    assert_eq!(book.trade_count, 1);
    assert_eq!(
        book.trade_qty_sum.to_string(),
        oracle["sameJFullMatch"]["tradeQtyLots"]
    );
    assert_eq!(
        book.event_hash.to_string(),
        oracle["sameJFullMatch"]["eventHash"]
    );
    for tx in [&maker_resolve, &taker_resolve] {
        let AccountTx::SwapResolve {
            fill_ratio,
            fill_numerator,
            fill_denominator,
            cancel_remainder,
            ..
        } = tx
        else {
            panic!("match must emit swap_resolve")
        };
        assert_eq!(*fill_ratio, 65_535);
        assert_eq!(fill_numerator.as_ref(), Some(&BigInt::from(1)));
        assert_eq!(fill_denominator.as_ref(), Some(&BigInt::from(1)));
        assert!(*cancel_remainder);
    }
    let AccountTx::SwapResolve {
        fee_token_id: maker_fee_token,
        fee_amount: maker_fee,
        ..
    } = &maker_resolve
    else {
        unreachable!()
    };
    assert_eq!(*maker_fee_token, None);
    assert!(maker_fee.is_none());
    let AccountTx::SwapResolve {
        fee_token_id: taker_fee_token,
        fee_amount: taker_fee,
        ..
    } = &taker_resolve
    else {
        unreachable!()
    };
    assert_eq!(*taker_fee_token, Some(2));
    assert_eq!(taker_fee.as_ref(), Some(&BigInt::from(10_u8).pow(14)));
    let (_, maker_remove) = apply_account(&maker_account, Side::Left, &maker_resolve, 1, 3);
    let (_, taker_remove) = apply_account(&taker_account, Side::Left, &taker_resolve, 1, 3);
    assert!(matches!(
        maker_remove.as_slice(),
        [AccountOutput::SwapOfferRemove { .. }]
    ));
    assert!(matches!(
        taker_remove.as_slice(),
        [AccountOutput::SwapOfferRemove { .. }]
    ));

    let settled = apply_entity_kernel(
        first.state,
        &[
            commit(MAKER, 0x43, 2, maker_resolve, maker_remove),
            commit(TAKER, 0x44, 2, taker_resolve, taker_remove),
        ],
        &DeterministicContext::hlt_default(),
    )
    .expect("committed resolves");
    assert!(settled.proposal_work.is_empty());
    let orderbook = settled.state.orderbook.expect("orderbook");
    assert!(orderbook.offers.is_empty());
    assert!(orderbook.resolving_offers.is_empty());
    assert!(orderbook.books["1/2"].orders.is_empty());
}

#[test]
fn same_j_partial_fill_rests_exact_remainder_after_committed_resolve() {
    let ask = offer_tx_units("partial-maker", true, 2);
    let bid = offer_tx("partial-taker", false);
    let (maker_account, maker_outputs) = offered_account(MAKER, &ask, 1);
    let (taker_account, taker_outputs) = offered_account(TAKER, &bid, 2);

    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string(), TAKER.to_string()]);
    state.orderbook = Some(OrderbookState::empty(10_000));
    let matched = apply_entity_kernel(
        state,
        &[
            commit(MAKER, 0x61, 1, ask, maker_outputs),
            commit(TAKER, 0x62, 1, bid, taker_outputs),
        ],
        &DeterministicContext::hlt_default(),
    )
    .expect("partial match");
    let oracle = fixture();
    assert_eq!(
        matched.commitments.orderbook_root,
        fixture_text(&oracle, &["sameJPartialMatch", "orderbookRoot"])
    );
    assert_eq!(
        matched.commitments.ordered_outbox_digest,
        fixture_text(&oracle, &["sameJPartialMatch", "orderedOutboxDigest"])
    );
    let maker_resolve = proposal(&matched, MAKER).clone();
    let taker_resolve = proposal(&matched, TAKER).clone();
    assert_eq!(
        tx_digest(&maker_resolve),
        fixture_text(&oracle, &["sameJPartialMatch", "makerResolveDigest"])
    );
    assert_eq!(
        tx_digest(&taker_resolve),
        fixture_text(&oracle, &["sameJPartialMatch", "takerResolveDigest"])
    );
    let AccountTx::SwapResolve {
        fill_ratio,
        fill_numerator,
        fill_denominator,
        cancel_remainder,
        ..
    } = &maker_resolve
    else {
        panic!("maker match must emit swap_resolve")
    };
    assert_eq!(*fill_ratio, 32_768);
    assert_eq!(fill_numerator.as_ref(), Some(&BigInt::from(1)));
    assert_eq!(fill_denominator.as_ref(), Some(&BigInt::from(2)));
    assert!(!cancel_remainder);
    let AccountTx::SwapResolve {
        fill_ratio,
        cancel_remainder,
        ..
    } = &taker_resolve
    else {
        panic!("taker match must emit swap_resolve")
    };
    assert_eq!(*fill_ratio, 65_535);
    assert!(*cancel_remainder);
    let AccountTx::SwapResolve {
        fee_token_id,
        fee_amount,
        ..
    } = &taker_resolve
    else {
        unreachable!()
    };
    assert_eq!(*fee_token_id, Some(2));
    assert_eq!(fee_amount.as_ref(), Some(&BigInt::from(10_u8).pow(14)));
    let book = &matched.state.orderbook.as_ref().expect("orderbook").books["1/2"];
    assert_book_commitment(book, &oracle, "sameJPartialMatch");
    let maker_order = &book.orders[&format!("{MAKER}:partial-maker")];
    assert_eq!(
        maker_order.qty_lots.to_string(),
        oracle["sameJPartialMatch"]["remainingMakerQtyLots"]
    );

    let (_, maker_upsert) = apply_account(&maker_account, Side::Left, &maker_resolve, 1, 3);
    let (_, taker_remove) = apply_account(&taker_account, Side::Left, &taker_resolve, 1, 3);
    assert!(matches!(
        maker_upsert.as_slice(),
        [AccountOutput::SwapOfferUpsert { .. }]
    ));
    assert!(matches!(
        taker_remove.as_slice(),
        [AccountOutput::SwapOfferRemove { .. }]
    ));
    let settled = apply_entity_kernel(
        matched.state,
        &[
            commit(MAKER, 0x63, 2, maker_resolve, maker_upsert),
            commit(TAKER, 0x64, 2, taker_resolve, taker_remove),
        ],
        &DeterministicContext::hlt_default(),
    )
    .expect("partial resolve commits");
    assert!(settled.proposal_work.is_empty());
    let orderbook = settled.state.orderbook.expect("orderbook");
    assert!(orderbook.resolving_offers.is_empty());
    assert_eq!(orderbook.offers.len(), 1);
    let maker_offer = &orderbook.offers[&(MAKER.to_string(), "partial-maker".to_string())];
    assert_eq!(maker_offer.give_amount, BigInt::from(10_u8).pow(18));
    assert_eq!(maker_offer.want_amount, BigInt::from(2_500_000_000_u64));
    assert_eq!(
        orderbook.books["1/2"].orders[&format!("{MAKER}:partial-maker")].qty_lots,
        BigInt::from(1_000_000_u32)
    );
}

#[test]
fn same_j_hlt_sweep_matches_two_price_levels_with_weighted_taker_resolution() {
    let low_ask = offer_tx_at("sweep-low", true, 1, 24_999_000);
    let high_ask = offer_tx_at("sweep-high", true, 1, 25_001_000);
    let bid = offer_tx_at("sweep-taker", false, 2, 25_001_000);
    let (low_account, low_outputs) = offered_account(MAKER, &low_ask, 1);
    let (high_account, high_outputs) = offered_account(NEXT, &high_ask, 2);
    let (taker_account, taker_outputs) = offered_account(TAKER, &bid, 3);

    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string(), NEXT.to_string(), TAKER.to_string()]);
    state.orderbook = Some(OrderbookState::empty(10_000));
    let matched = apply_entity_kernel(
        state,
        &[
            commit(MAKER, 0x81, 1, low_ask, low_outputs),
            commit(NEXT, 0x82, 1, high_ask, high_outputs),
            commit(TAKER, 0x83, 1, bid, taker_outputs),
        ],
        &DeterministicContext::hlt_default(),
    )
    .expect("two-level HLT sweep");
    let oracle = fixture();
    assert_eq!(
        matched.commitments.orderbook_root,
        fixture_text(&oracle, &["sameJSweepMatch", "orderbookRoot"])
    );
    assert_eq!(
        matched.commitments.ordered_outbox_digest,
        fixture_text(&oracle, &["sameJSweepMatch", "orderedOutboxDigest"])
    );
    assert_eq!(
        matched.outputs,
        vec![EntityKernelOutput::SwapMatched {
            entity_id: HUB.to_string(),
            count: 2,
        }]
    );
    let low_resolve = proposal(&matched, MAKER).clone();
    let high_resolve = proposal(&matched, NEXT).clone();
    let taker_resolve = proposal(&matched, TAKER).clone();
    assert_eq!(
        tx_digest(&low_resolve),
        fixture_text(&oracle, &["sameJSweepMatch", "lowMakerResolveDigest"])
    );
    assert_eq!(
        tx_digest(&high_resolve),
        fixture_text(&oracle, &["sameJSweepMatch", "highMakerResolveDigest"])
    );
    assert_eq!(
        tx_digest(&taker_resolve),
        fixture_text(&oracle, &["sameJSweepMatch", "takerResolveDigest"])
    );
    let AccountTx::SwapResolve {
        fill_ratio,
        fill_numerator,
        fill_denominator,
        fee_token_id,
        fee_amount,
        execution_give_amount,
        execution_want_amount,
        cancel_remainder,
        ..
    } = &taker_resolve
    else {
        panic!("sweep taker must resolve")
    };
    assert_eq!(*fill_ratio, 65_533);
    assert_eq!(fill_numerator.as_ref(), Some(&BigInt::from(25_000_u32)));
    assert_eq!(fill_denominator.as_ref(), Some(&BigInt::from(25_001_u32)));
    assert_eq!(*fee_token_id, Some(2));
    let expected_fee = BigInt::from(2_u8) * BigInt::from(10_u8).pow(14);
    assert_eq!(fee_amount.as_ref(), Some(&expected_fee));
    assert_eq!(
        execution_give_amount.as_ref(),
        Some(&BigInt::from(5_000_000_000_u64))
    );
    let expected_want = BigInt::from(2_u8) * BigInt::from(10_u8).pow(18);
    assert_eq!(execution_want_amount.as_ref(), Some(&expected_want));
    assert!(*cancel_remainder);
    let book = &matched.state.orderbook.as_ref().expect("orderbook").books["1/2"];
    assert_book_commitment(book, &oracle, "sameJSweepMatch");
    assert!(book.orders.is_empty());
    assert_eq!(book.trade_count, 2);
    assert_eq!(
        book.trade_qty_sum.to_string(),
        oracle["sameJSweepMatch"]["tradeQtyLots"]
    );
    assert_eq!(
        book.event_hash.to_string(),
        oracle["sameJSweepMatch"]["eventHash"]
    );

    let (_, low_remove) = apply_account(&low_account, Side::Left, &low_resolve, 1, 4);
    let (_, high_remove) = apply_account(&high_account, Side::Left, &high_resolve, 1, 4);
    let (_, taker_remove) = apply_account(&taker_account, Side::Left, &taker_resolve, 1, 4);
    let settled = apply_entity_kernel(
        matched.state,
        &[
            commit(MAKER, 0x84, 2, low_resolve, low_remove),
            commit(NEXT, 0x85, 2, high_resolve, high_remove),
            commit(TAKER, 0x86, 2, taker_resolve, taker_remove),
        ],
        &DeterministicContext::hlt_default(),
    )
    .expect("sweep resolves commit");
    assert!(settled.proposal_work.is_empty());
    let orderbook = settled.state.orderbook.expect("orderbook");
    assert!(orderbook.offers.is_empty());
    assert!(orderbook.resolving_offers.is_empty());
}

#[test]
fn same_j_cancel_request_is_resolved_then_removed() {
    let ask = offer_tx("cancel-me", true);
    let (offered, offer_outputs) = offered_account(MAKER, &ask, 1);
    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string()]);
    state.orderbook = Some(OrderbookState::empty(10_000));
    let resting = apply_entity_kernel(
        state,
        &[commit(MAKER, 0x51, 1, ask, offer_outputs)],
        &DeterministicContext::hlt_default(),
    )
    .expect("rest offer");
    assert!(resting.proposal_work.is_empty());

    let cancel = AccountTx::SwapCancelRequest {
        offer_id: "cancel-me".to_string(),
    };
    let (cancel_requested, cancel_outputs) = apply_account(&offered, Side::Right, &cancel, 1, 2);
    let cancel_pass = apply_entity_kernel(
        resting.state,
        &[commit(MAKER, 0x52, 2, cancel, cancel_outputs)],
        &DeterministicContext::hlt_default(),
    )
    .expect("cancel pass");
    let resolve = proposal(&cancel_pass, MAKER).clone();
    let AccountTx::SwapResolve {
        fill_ratio,
        cancel_remainder,
        comment,
        ..
    } = &resolve
    else {
        panic!("cancel must emit swap_resolve")
    };
    assert_eq!(*fill_ratio, 0);
    assert!(*cancel_remainder);
    assert_eq!(comment.as_deref(), Some("cancel_request"));
    assert_eq!(
        tx_digest(&resolve),
        fixture_text(&fixture(), &["sameJCancel", "resolveDigest"])
    );
    let (_, removed) = apply_account(&cancel_requested, Side::Left, &resolve, 2, 3);
    let final_pass = apply_entity_kernel(
        cancel_pass.state,
        &[commit(MAKER, 0x53, 3, resolve, removed)],
        &DeterministicContext::hlt_default(),
    )
    .expect("cancel resolve commit");
    assert!(
        final_pass
            .state
            .orderbook
            .expect("orderbook")
            .offers
            .is_empty()
    );
}
