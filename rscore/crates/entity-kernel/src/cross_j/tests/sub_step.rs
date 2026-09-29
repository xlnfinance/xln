use super::*;
use crate::orderbook::{
    apply_cross_jurisdiction_fill_deltas, install_orderbook_outputs, prepare_orderbook_outputs,
    validate_orderbook_outputs,
};

fn match_routes(
    owner: &mut EntityStateSlice,
    routes: Vec<CanonicalValue>,
) -> Vec<CrossJurisdictionBookFill> {
    let mut deltas = Vec::new();
    for route in routes {
        deltas.extend(
            apply_admit(
                owner,
                &tx(EntityTxKind::AdmitCrossJurisdictionBookOrder, route),
            )
            .expect("admit authenticated route")
            .orderbook_deltas,
        );
    }
    let context = crate::DeterministicContext::hlt_default();
    let entity_id = owner.entity_id.clone();
    let book = owner.orderbook.as_mut().unwrap();
    let mut prepared = prepare_orderbook_outputs(book, &deltas, &context, &entity_id, None)
        .expect("prepare production matcher");
    let results = prepared
        .take_jobs()
        .into_iter()
        .map(|job| job.apply(&context))
        .collect();
    let validated = validate_orderbook_outputs(prepared, results).expect("validate matches");
    install_orderbook_outputs(book, validated).cross_jurisdiction_fills
}

fn reciprocal(ask: &CanonicalValue, id: &str, divisor: u64) -> CanonicalValue {
    let mut bid = ask.clone();
    let mut source = field(ask, "target").unwrap().clone();
    let mut target = field(ask, "source").unwrap().clone();
    for (leg, entity, counterparty) in [
        (&mut source, "target-user", "target-hub"),
        (&mut target, "source-hub", "source-user"),
    ] {
        let amount = bigint(leg, "amount").unwrap() / BigInt::from(divisor);
        set(leg, "entityId", string(entity)).unwrap();
        set(leg, "counterpartyEntityId", string(counterparty)).unwrap();
        set(leg, "amount", CanonicalValue::BigInt(amount)).unwrap();
    }
    for (name, value) in [
        ("orderId", string(id)),
        ("makerEntityId", string("target-user")),
        ("source", source),
        ("target", target),
        ("sourceSignerId", string("target-user-signer")),
        ("sourceHubSignerId", string("target-hub-signer")),
        ("targetHubSignerId", string("source-hub-signer")),
        ("targetSignerId", string("source-user-signer")),
    ] {
        set(&mut bid, name, value).unwrap();
    }
    bid
}

fn commit_fills(owner: &mut EntityStateSlice, effects: Vec<CrossJurisdictionBookFill>) {
    for fill in effects {
        let committed = commit_cross_jurisdiction_book_fill(owner, fill).expect("commit progress");
        apply_cross_jurisdiction_fill_deltas(
            owner.orderbook.as_mut().unwrap(),
            &committed.orderbook_deltas,
        )
        .expect("project committed progress");
    }
}

fn partial_route() -> (CanonicalValue, CanonicalValue) {
    let mut ask = route("partially_filled", true);
    let mut source = field(&ask, "source").unwrap().clone();
    let mut target = field(&ask, "target").unwrap().clone();
    set(
        &mut source,
        "tokenId",
        number(1, EntityTxKind::AdmitCrossJurisdictionBookOrder, "TOKEN").unwrap(),
    )
    .unwrap();
    set(
        &mut source,
        "amount",
        CanonicalValue::BigInt(300_000_u64.into()),
    )
    .unwrap();
    set(
        &mut target,
        "tokenId",
        number(1, EntityTxKind::AdmitCrossJurisdictionBookOrder, "TOKEN").unwrap(),
    )
    .unwrap();
    set(
        &mut target,
        "amount",
        CanonicalValue::BigInt(600_000_u64.into()),
    )
    .unwrap();
    set(&mut ask, "source", source.clone()).unwrap();
    set(&mut ask, "target", target.clone()).unwrap();
    let mut remaining = ask.clone();
    set(
        &mut source,
        "amount",
        CanonicalValue::BigInt(200_000_u64.into()),
    )
    .unwrap();
    set(
        &mut target,
        "amount",
        CanonicalValue::BigInt(400_000_u64.into()),
    )
    .unwrap();
    set(&mut remaining, "source", source).unwrap();
    set(&mut remaining, "target", target).unwrap();
    set(&mut remaining, "status", string("resting")).unwrap();
    for (name, value) in [
        ("fillNumerator", CanonicalValue::BigInt(21_845_u64.into())),
        ("fillDenominator", CanonicalValue::BigInt(65_535_u64.into())),
        (
            "cumulativeFillRatio",
            number(
                21_845,
                EntityTxKind::AdmitCrossJurisdictionBookOrder,
                "RATIO",
            )
            .unwrap(),
        ),
        (
            "fillSeq",
            number(1, EntityTxKind::AdmitCrossJurisdictionBookOrder, "SEQ").unwrap(),
        ),
    ] {
        set(&mut ask, name, value).unwrap();
    }
    (ask, remaining)
}

#[test]
fn cross_j_sub_step_maker_remains_matchable_after_second_fill() {
    let (ask, remaining) = partial_route();
    let tiny = reciprocal(&remaining, "tiny", 100_000);
    let next = reciprocal(&remaining, "next", 1);
    let mut owner = EntityStateSlice::empty("source-hub", 2_000);
    owner.orderbook = Some(crate::OrderbookState::empty(10_000));
    assert!(match_routes(&mut owner, vec![ask]).is_empty());
    let tiny_effects = match_routes(&mut owner, vec![tiny]);
    assert_eq!(
        tiny_effects.len(),
        2,
        "the exact maker price advances both ladder routes"
    );
    commit_fills(&mut owner, tiny_effects);
    let key = ("source-user".to_string(), "order-1".to_string());
    assert!(
        !owner
            .orderbook
            .as_ref()
            .unwrap()
            .resolving_offers
            .contains(&key),
        "no progress instruction exists to release an absorbed maker's resolving lock"
    );
    let next_effects = match_routes(&mut owner, vec![next]);
    assert_eq!(
        next_effects.len(),
        2,
        "both matched routes record exact progress"
    );
    let maker_fill = next_effects
        .iter()
        .find(|fill| text(&fill.data, "orderId") == Some("order-1"))
        .expect("maker progress");
    assert_eq!(
        field(&maker_fill.data, "cancelRemainder"),
        Some(&CanonicalValue::Bool(true)),
        "unmatchable one-unit quote dust closes the maker without spending Hub funds"
    );
    commit_fills(&mut owner, next_effects);
    let book = owner.orderbook.as_ref().unwrap();
    assert!(!book.offers.contains_key(&key));
    assert!(book.resolving_offers.is_empty());
    assert!(book.books.values().any(|book| !book.orders.is_empty()));
}

#[test]
fn cross_j_sub_step_does_not_reuse_stale_remainder_inside_pair_job() {
    let (ask, remaining) = partial_route();
    let mut owner = EntityStateSlice::empty("source-hub", 2_000);
    owner.orderbook = Some(crate::OrderbookState::empty(10_000));
    assert!(match_routes(&mut owner, vec![ask]).is_empty());
    let fills = match_routes(
        &mut owner,
        vec![
            reciprocal(&remaining, "tiny-1", 100_000),
            reciprocal(&remaining, "tiny-2", 100_000),
        ],
    );
    assert_eq!(
        fills.len(),
        2,
        "second taker must not reuse the first match's stale remainder"
    );
    assert_eq!(text(&fills[0].data, "orderId"), Some("order-1"));
    assert_eq!(text(&fills[1].data, "orderId"), Some("tiny-1"));
    assert_eq!(
        unsigned(&fills[1].data, "cumulativeFillRatio"),
        Some(65_535)
    );
    commit_fills(&mut owner, fills);
    assert!(
        owner
            .orderbook
            .as_ref()
            .unwrap()
            .resolving_offers
            .is_empty()
    );
}

#[test]
fn cross_j_sub_step_cancel_preserves_prior_claims_and_retires_the_book() {
    let (ask, remaining) = partial_route();
    let mut owner = EntityStateSlice::empty("source-hub", 2_000);
    owner.orderbook = Some(crate::OrderbookState::empty(10_000));
    assert!(match_routes(&mut owner, vec![ask]).is_empty());
    let fills = match_routes(&mut owner, vec![reciprocal(&remaining, "tiny", 100_000)]);
    commit_fills(&mut owner, fills);
    let current = owner
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap()
        .clone();
    let cancel = build_cross_jurisdiction_cancel_fill("order-1", current).unwrap();
    assert_eq!(unsigned(&cancel.data, "cumulativeFillRatio"), Some(21_846));
    assert_eq!(unsigned(&cancel.data, "fillSeq"), Some(2));
    commit_fills(&mut owner, vec![cancel]);
    let book = owner.orderbook.as_ref().unwrap();
    assert!(book.resolving_offers.is_empty());
    assert!(book.books.values().all(|book| book.orders.is_empty()));
    let terminal = owner
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap();
    assert_eq!(
        committed_fill(terminal, EntityTxKind::CrossJurisdictionFillNotice).unwrap(),
        (21_846, BigInt::from(100_004), BigInt::from(200_009))
    );
}

#[test]
fn cross_j_live_usdt_usdc_partial_fill_keeps_the_committed_remainder() {
    // Live wallet counterexample: take 50 USDC from a 10,200-USDC maker at 9999 ticks.
    let mut maker = route("resting", true);
    let mut source = field(&maker, "source").unwrap().clone();
    let mut target = field(&maker, "target").unwrap().clone();
    let source_j = field(&source, "jurisdiction").unwrap().clone();
    let target_j = field(&target, "jurisdiction").unwrap().clone();
    set(&mut source, "jurisdiction", target_j).unwrap();
    set(&mut target, "jurisdiction", source_j).unwrap();
    set(
        &mut source,
        "tokenId",
        number(3, EntityTxKind::AdmitCrossJurisdictionBookOrder, "TOKEN").unwrap(),
    )
    .unwrap();
    set(
        &mut source,
        "amount",
        CanonicalValue::BigInt(10_198_980_000_u64.into()),
    )
    .unwrap();
    set(
        &mut target,
        "amount",
        CanonicalValue::BigInt(10_200_000_000_u64.into()),
    )
    .unwrap();
    set(&mut maker, "source", source).unwrap();
    set(&mut maker, "target", target).unwrap();
    let taker = reciprocal(&maker, "take-50", 204);
    let second_taker = reciprocal(&maker, "take-another-50", 204);
    let mut owner = EntityStateSlice::empty("target-hub", 2_000);
    owner.orderbook = Some(crate::OrderbookState::empty(10_000));
    assert!(match_routes(&mut owner, vec![maker]).is_empty());
    let fills = match_routes(&mut owner, vec![taker]);
    assert_eq!(fills.len(), 2);
    commit_fills(&mut owner, fills);
    let book = owner.orderbook.as_ref().unwrap();
    assert!(book.resolving_offers.is_empty());
    assert_eq!(
        book.books
            .values()
            .map(|book| book.orders.len())
            .sum::<usize>(),
        1
    );
    // A restored price is authenticated by the committed page root, not the
    // rounded remaining quote/base ratio. The review counterexample must fail.
    let mut tampered = owner.orderbook.as_ref().unwrap().snapshot().unwrap();
    let cached = tampered.books.values_mut().next().unwrap();
    let page = cached
        .bid_pages
        .iter_mut()
        .chain(cached.ask_pages.iter_mut())
        .next()
        .unwrap();
    page.price_ticks = BigInt::from(8_888);
    let error = crate::OrderbookState::restore(tampered).unwrap_err();
    assert!(error.to_string().contains("PAGES_ROOT_MISMATCH"), "{error}");
    let snapshot = owner.orderbook.as_ref().unwrap().snapshot().unwrap();
    owner.orderbook =
        Some(crate::OrderbookState::restore(snapshot).expect("restore partial maker"));
    let second_fills = match_routes(&mut owner, vec![second_taker]);
    assert_eq!(second_fills.len(), 2);
    commit_fills(&mut owner, second_fills);
}
