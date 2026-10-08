//! Entity views reuse the same logical projection as the canonical checkpoint.
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use xln_rscore_protocol::CanonicalValue;
use xln_rscore_runtime::{
    RuntimeEntityReplica, RuntimeEntityState, tagged_json_from_canonical_value,
};

fn wire(value: &CanonicalValue) -> Result<Value, String> {
    tagged_json_from_canonical_value(value)
        .map_err(|error| format!("E_INTERNAL:ENTITY_PROJECTION:{error}"))
}
fn map(values: &BTreeMap<String, CanonicalValue>) -> Result<Value, String> {
    wire(&CanonicalValue::Map(
        values
            .iter()
            .map(|(key, value)| (CanonicalValue::String(key.clone()), value.clone()))
            .collect(),
    ))
}

/// `nonces` is the actual canonical retained scalar, not a default empty map.
/// Match its commitment before exposing it, including when derived from an empty section.
pub fn entity_core(
    state: &RuntimeEntityState,
    replica: &RuntimeEntityReplica,
    nonces: &CanonicalValue,
) -> Result<Value, String> {
    let nonce_section = replica
        .entity_consensus
        .state
        .sections
        .iter()
        .find(|section| section.field == "nonces")
        .ok_or("E_INTERNAL:ENTITY_NONCES_SECTION_MISSING")?;
    let digest = xln_rscore_entity_kernel::compute_entity_section_digest(nonces)
        .map_err(|error| error.to_string())?;
    if digest != nonce_section.digest {
        return Err("E_INTERNAL:ENTITY_NONCES_COMMITMENT_MISMATCH".into());
    }
    let p =
        xln_rscore_entity_kernel::project_entity_storage(&state.entity, &replica.entity_consensus)
            .map_err(|error| format!("E_INTERNAL:ENTITY_PROJECTION:{error}"))?;
    let mut out = Map::new();
    for (name, value) in [
        ("entityId", &p.entity_id),
        ("height", &p.height),
        ("timestamp", &p.timestamp),
        ("entityEncryptionPublicKey", &p.entity_encryption_public_key),
        ("profile", &p.profile),
        ("config", &p.config),
        ("nonces", nonces),
        ("proposals", &p.proposals),
        ("reserves", &p.reserves),
        ("lastFinalizedJHeight", &p.last_finalized_j_height),
    ] {
        out.insert(name.into(), wire(value)?);
    }
    for (name, value) in [
        ("entityCommandNonces", &p.entity_command_nonces),
        ("externalWallet", &p.external_wallet),
        ("leaderState", &p.leader_state),
        ("jBatchState", &p.j_batch_state),
        ("jHistoryFinality", &p.j_history_finality),
        ("certifiedBoardState", &p.certified_board_state),
        ("entityProviderActionState", &p.entity_provider_action_state),
        ("outDebtsByToken", &p.out_debts_by_token),
        ("inDebtsByToken", &p.in_debts_by_token),
        ("swapTradingPairs", &p.swap_trading_pairs),
        ("hubRebalanceConfig", &p.hub_rebalance_config),
        ("orderbookHubProfile", &p.orderbook_hub_profile),
        ("orderbookReferrals", &p.orderbook_referrals),
        ("orderbookPairDimensions", &p.orderbook_pair_dimensions),
    ] {
        if let Some(value) = value {
            out.insert(name.into(), wire(value)?);
        }
    }
    for (name, present, values) in [
        (
            "deferredAccountProposals",
            p.deferred_account_proposals_present,
            &p.deferred_account_proposals,
        ),
        (
            "settlementContinuations",
            p.settlement_continuations_present,
            &p.settlement_continuations,
        ),
        (
            "crossJurisdictionSwaps",
            p.cross_jurisdiction_swaps_present,
            &p.cross_jurisdiction_swaps,
        ),
        (
            "crossJurisdictionAuthorizations",
            p.cross_jurisdiction_authorizations_present,
            &p.cross_jurisdiction_authorizations,
        ),
        (
            "crossJurisdictionBookAdmissions",
            p.cross_jurisdiction_book_admissions_present,
            &p.cross_jurisdiction_book_admissions,
        ),
    ] {
        if present {
            out.insert(name.into(), map(values)?);
        }
    }
    let mut paybook = wire(&p.paybook)?;
    paybook["entries"] = map(&p.paybook_entries)?;
    out.insert("paybook".into(), paybook);
    out.insert("paybookOpen".into(), Value::from(p.paybook_entries.len()));
    if let Some(crontab) = p.crontab_state.as_ref() {
        let mut crontab = wire(crontab)?;
        crontab["hooks"] = map(&p.crontab_hooks)?;
        out.insert("crontabState".into(), crontab);
    }
    if let Some(head) = replica.entity_consensus.certified_frame_head.as_ref() {
        out.insert(
            "prevFrameHash".into(),
            Value::String(head.frame.hash.clone()),
        );
    }
    out.insert("signerId".into(), Value::String(replica.signer_id.clone()));
    if let Some(is_proposer) = replica.replica_metadata().get("isProposer") {
        out.insert("isProposer".into(), is_proposer.clone());
    }
    Ok(Value::Object(out))
}

pub fn book_view(book: &xln_rscore_entity_kernel::BookState) -> Result<Value, String> {
    use serde_json::json;
    use xln_rscore_entity_kernel::Side;
    let snapshot = book.snapshot().map_err(|error| error.to_string())?;
    let big = |value: &num_bigint::BigInt| wire(&CanonicalValue::BigInt(value.clone()));
    let pages =
        |pages: Vec<xln_rscore_entity_kernel::BookPricePageSnapshot>| -> Result<Value, String> {
            let mut rows = Vec::new();
            for page in pages {
                let (_, price) = page.price_ticks.to_bytes_be();
                let mut key = vec![u8::try_from(price.len()).map_err(|_| "BOOK_PAGE_PRICE_WIDTH")?];
                key.extend(price);
                key.extend(page.page_sequence.to_be_bytes());
                let slots=page.slots.into_iter().map(|entry|entry.map(|entry|Ok(json!({"orderId":entry.order_id,"ownerId":entry.owner_id,"qtyLots":big(&entry.qty_lots)?,"seq":entry.seq}))).transpose()).collect::<Result<Vec<_>,String>>()?;
                let value = json!({"headSlot":page.head_slot,"nextSlot":page.next_slot,"liveCount":page.live_count,"totalQtyLots":big(&page.total_qty_lots)?,"slots":slots});
                rows.push((
                    CanonicalValue::String(format!("0x{}", hex::encode(key))),
                    xln_rscore_runtime::canonical_value_from_tagged_json(&value)
                        .map_err(|error| error.to_string())?,
                ));
            }
            wire(&CanonicalValue::Map(rows))
        };
    let levels = |side| -> Result<Vec<Value>, String> {
        book.side_levels(side, 5)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|level| {
                Ok(json!({"priceTicks":big(&level.price_ticks)?,"qtyLots":big(&level.qty_lots)?}))
            })
            .collect()
    };
    Ok(
        json!({"params":{"bucketWidthTicks":big(&snapshot.bucket_width_ticks)?,"stpPolicy":snapshot.stp_policy,"maxOrders":snapshot.max_orders},
        "bidLevels":levels(Side::Bid)?,"askLevels":levels(Side::Ask)?,"bidPages":pages(snapshot.bid_pages)?,"askPages":pages(snapshot.ask_pages)?,
        "nextSeq":snapshot.next_seq,"tradeCount":snapshot.trade_count,"tradeQtySum":big(&snapshot.trade_qty_sum)?,"lastTradePriceTicks":big(&snapshot.last_trade_price_ticks)?,
        "lastAcceptedUsdAskPriceTicks":big(&snapshot.last_accepted_usd_ask_price_ticks)?,"eventHash":big(&snapshot.event_hash)?,"commitmentHash":snapshot.expected_commitment_hash}),
    )
}
