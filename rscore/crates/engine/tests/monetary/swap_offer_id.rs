//! Rust replay of `rscore/fixtures/account-semantics/swap-offer-id.ts`: the
//! peer-supplied swap `offerId` bound at Account admission.

use crate::common::{entity, replica, token};
use num_bigint::BigInt;
use serde::Deserialize;
use std::sync::Arc;
use xln_rscore_engine::{
    AccountExecutionContext, AccountTx, AccountVerdict, Delta, SequentialAccountEngine, Side,
    SwapMarketPolicy, SwapToken,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Case {
    offer_id: String,
    utf8_bytes: usize,
    verdict: String,
    code: Option<String>,
    message: Option<String>,
}

fn funded(token_id: u32) -> Delta {
    let large = BigInt::from(10_u8).pow(24);
    Delta::new(
        token(token_id),
        large.clone(),
        0.into(),
        0.into(),
        large.clone(),
        large,
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("funded delta")
}

/// Canonical registry slice for the fixture pair (core/account/utils.ts):
/// token 1 is the liquid 6-decimal quote, token 2 the 18-decimal base.
fn market() -> AccountExecutionContext {
    AccountExecutionContext::with_market(
        1_000,
        1_000,
        0,
        1,
        0,
        Arc::new(SwapMarketPolicy::new(
            vec![
                SwapToken {
                    token_id: 1,
                    decimals: 6,
                    liquid: true,
                },
                SwapToken {
                    token_id: 2,
                    decimals: 18,
                    liquid: false,
                },
            ],
            vec![((1, 2), 1), ((2, 1), 1)],
        )),
    )
}

/// The fixture's fixed same-J ask (1 token-2 for 2.5 token-1).
fn swap_offer(offer_id: &str) -> AccountTx {
    AccountTx::SwapOffer {
        offer_id: offer_id.to_string(),
        give_token_id: 2,
        give_token_decimals: 18,
        give_amount: BigInt::from(10_u8).pow(18),
        want_token_id: 1,
        want_token_decimals: 6,
        want_amount: 2_500_000.into(),
        max_fee: 25_000.into(),
        min_net_receive: 2_475_000.into(),
        time_in_force: Some(0),
        price_ticks: Some(25_000.into()),
        cross_jurisdiction: None,
    }
}

fn replay(offer_id: &str) -> Case {
    let base = replica(
        entity(0x11),
        entity(0x11),
        entity(0x22),
        vec![funded(1), funded(2)],
    );
    let transition = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &swap_offer(offer_id),
        &market(),
    )
    .expect("swap_offer transition");
    let (verdict, code, message) = match transition.verdict() {
        AccountVerdict::Applied => ("applied", None, None),
        AccountVerdict::Rejected(rejection) => {
            assert!(transition.candidate().is_none());
            (
                "rejected",
                Some(rejection.code().to_string()),
                Some(rejection.message()),
            )
        }
    };
    Case {
        offer_id: offer_id.to_string(),
        utf8_bytes: offer_id.len(),
        verdict: verdict.to_string(),
        code,
        message,
    }
}

#[test]
fn swap_offer_id_admission_matches_the_typescript_vector() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../fixtures/account-semantics/swap-offer-id-v1.json"
    ))
    .expect("swap offerId fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript Account swap_offer admission"
    );
    let divergences = fixture
        .cases
        .iter()
        .filter_map(|expected| {
            let actual = replay(&expected.offer_id);
            (actual != *expected).then(|| format!("rust {actual:?} != typescript {expected:?}"))
        })
        .collect::<Vec<_>>();
    assert!(divergences.is_empty(), "{}", divergences.join("\n"));
    assert!(fixture.cases.iter().any(|case| case.verdict == "applied"));
    assert!(fixture.cases.iter().any(|case| case.verdict == "rejected"));
}
