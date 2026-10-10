//! Rust replay of the TypeScript book-level oracle
//! `rscore/fixtures/entity-kernel/orderbook-book.ts`.
//!
//! Each step must produce the same event list, event hash, book commitment and
//! resting order set as the production TypeScript book. A fatal error on a
//! step that TypeScript handles as a per-offer outcome fails the replay.

use std::collections::BTreeSet;

use num_bigint::BigInt;
use serde::Deserialize;

use super::*;
use crate::orderbook::compute_book_commitment_hash;

const FIXTURE: &str = include_str!("../../../../../fixtures/entity-kernel/orderbook-book-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    bucket_width_ticks: u32,
    base_token_decimals: u32,
    quote_token_decimals: u32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    max_orders: usize,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    step: Operation,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Suspended {
    All(String),
    Ids(Vec<String>),
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Operation {
    #[serde(rename_all = "camelCase")]
    Add {
        order_id: String,
        owner_id: String,
        side: String,
        price_ticks: String,
        qty_lots: String,
        time_in_force: u8,
        suspended: Suspended,
    },
    Resume {
        suspended: Suspended,
    },
    #[serde(rename_all = "camelCase")]
    Sweep {
        min_price_ticks: String,
        max_price_ticks: String,
    },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Expected {
    outcome: String,
    events: Vec<String>,
    taker_order_id: Option<String>,
    swept_order_ids: Vec<String>,
    order_ids: Vec<String>,
    event_hash: String,
    book_commitment_hash: String,
}

fn bigint(value: &str) -> BigInt {
    value.parse().expect("fixture bigint")
}

fn classifier(
    suspended: &Suspended,
) -> impl FnMut(&BookOrder) -> Result<MakerDisposition, EntityKernelError> + '_ {
    move |order| {
        let is_suspended = match suspended {
            Suspended::All(value) => {
                assert_eq!(value, "all", "unknown suspension marker");
                true
            }
            Suspended::Ids(ids) => ids.contains(&order.order_id),
        };
        Ok(if is_suspended {
            MakerDisposition::Suspended
        } else {
            MakerDisposition::Eligible
        })
    }
}

fn project_event(event: &BookEvent) -> String {
    match event {
        BookEvent::Ack => "ACK".to_string(),
        BookEvent::Reduced => "REDUCED".to_string(),
        BookEvent::Reject {
            reason,
            blocking_order_id,
        } => format!(
            "REJECT:{reason}:{}",
            blocking_order_id.as_deref().unwrap_or("-")
        ),
        BookEvent::Trade {
            price,
            qty,
            maker_order_id,
            taker_order_id,
            maker_qty_before,
            taker_qty_total,
        } => format!(
            "TRADE:{price}:{qty}:{maker_order_id}:{taker_order_id}:{maker_qty_before}:{taker_qty_total}"
        ),
    }
}

fn observe(
    book: &BookState,
    outcome: &str,
    events: &[BookEvent],
    taker_order_id: Option<String>,
    swept_order_ids: Vec<String>,
) -> Expected {
    let mut resting = book.orders.values().collect::<Vec<_>>();
    resting.sort_by_key(|order| order.seq);
    Expected {
        outcome: outcome.to_string(),
        events: events.iter().map(project_event).collect(),
        taker_order_id,
        swept_order_ids,
        order_ids: resting
            .into_iter()
            .map(|order| order.order_id.clone())
            .collect(),
        event_hash: book.event_hash.to_string(),
        book_commitment_hash: compute_book_commitment_hash(book).expect("book commitment"),
    }
}

fn apply_step(
    book: &mut BookState,
    dimensions: PairDimensions,
    operation: &Operation,
) -> Result<Expected, EntityKernelError> {
    match operation {
        Operation::Add {
            order_id,
            owner_id,
            side,
            price_ticks,
            qty_lots,
            time_in_force,
            suspended,
        } => {
            let input = AddOrder {
                order_id: order_id.clone(),
                owner_id: owner_id.clone(),
                side: if side == "bid" { Side::Bid } else { Side::Ask },
                price_ticks: bigint(price_ticks),
                qty_lots: bigint(qty_lots),
                time_in_force: *time_in_force,
            };
            let events = apply_gtc(book, input, dimensions, classifier(suspended))?;
            Ok(observe(book, "applied", &events, None, Vec::new()))
        }
        Operation::Resume { suspended } => Ok(
            match resume_crossed(book, dimensions, classifier(suspended))? {
                Some((taker, events)) => observe(book, "applied", &events, Some(taker), Vec::new()),
                None => observe(book, "idle", &[], None, Vec::new()),
            },
        ),
        Operation::Sweep {
            min_price_ticks,
            max_price_ticks,
        } => {
            let swept =
                out_of_band_order_ids(book, &bigint(min_price_ticks), &bigint(max_price_ticks));
            for order_id in &swept {
                assert!(
                    cancel_order(book, order_id)?,
                    "swept order {order_id} rests"
                );
            }
            Ok(observe(book, "applied", &[], None, swept))
        }
    }
}

#[test]
fn typescript_book_operations_replay_with_identical_events_and_commitments() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("orderbook book fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript core/orderbook/core.ts"
    );
    let dimensions = PairDimensions {
        base_token_decimals: fixture.base_token_decimals,
        quote_token_decimals: fixture.quote_token_decimals,
    };
    let mut names = BTreeSet::new();
    let mut divergences = Vec::new();
    for case in &fixture.cases {
        assert!(
            names.insert(case.name.as_str()),
            "duplicate case {}",
            case.name
        );
        let mut book = BookState::empty(case.max_orders, fixture.bucket_width_ticks);
        for (index, step) in case.steps.iter().enumerate() {
            match apply_step(&mut book, dimensions, &step.step) {
                Ok(actual) if actual == step.expected => {}
                Ok(actual) => {
                    divergences.push(format!(
                        "{} step {index}: rust {actual:?} != typescript {:?}",
                        case.name, step.expected
                    ));
                    break;
                }
                Err(error) => {
                    divergences.push(format!(
                        "{} step {index}: TypeScript applied, Rust failed: {error}",
                        case.name
                    ));
                    break;
                }
            }
        }
    }
    assert!(divergences.is_empty(), "{}", divergences.join("\n"));
    assert_eq!(
        names.into_iter().collect::<Vec<_>>(),
        ["resume-stp-cancels-resting-taker"]
    );
}
