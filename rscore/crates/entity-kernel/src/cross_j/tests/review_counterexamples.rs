use super::*;

fn stored(state: &mut EntityStateSlice, route: CanonicalValue) {
    collection(&mut state.cross_jurisdiction_swaps)
        .insert("order-1".into(), route)
        .unwrap();
}

pub(super) fn account_view() -> crate::local_financial::LocalAccountFinancialView {
    crate::local_financial::LocalAccountFinancialView {
        dispute_config: xln_rscore_engine::AccountDisputeConfig::new(10, 10).unwrap(),
        active: true,
        owner_side: xln_rscore_engine::Side::Left,
        owner_out_capacity: BTreeMap::new(),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: None,
        settlement_transition_pending: false,
        settlement_execution: Err("no settlement".into()),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: BTreeSet::new(),
        dispute: None,
    }
}

fn salvage_setup() -> (
    EntityStateSlice,
    BTreeMap<String, crate::local_financial::LocalAccountFinancialView>,
    CanonicalEntityTx,
) {
    let hub = format!("0x{}", "33".repeat(32));
    let user = format!("0x{}", "44".repeat(32));
    let mut raw = route("intent", false);
    let mut target = field(&raw, "target").unwrap().clone();
    set(&mut target, "entityId", string(&hub)).unwrap();
    set(&mut target, "counterpartyEntityId", string(&user)).unwrap();
    set(&mut raw, "target", target).unwrap();
    let next = prepared_route(&raw, "runtime-seed", 1_000).unwrap();
    let proof = hash_ladder_proof("runtime-seed", text(&next, "routeHash").unwrap());
    let mut state = EntityStateSlice::empty(user, 1_000);
    stored(&mut state, next);
    let mut view = account_view();
    view.dispute = Some(xln_rscore_batch::ResidentAccountDisputeView {
        status: "disputed".into(),
        dispute_prepare: None,
        active_dispute: Some(obj(vec![])),
        local_dispute: None,
        counterparty_dispute: None,
        proof_body: Err("not used by salvage".into()),
        j_nonce: 0,
        owner_is_left: false,
        delta_transformer: None,
        payment_hashlocks: vec![],
        pull_ids: vec![],
        pull_count: 1,
        swap_offers: vec![],
        pending_swap_fill_ratios: BTreeMap::new(),
    });
    let command = projected(
        EntityTxKind::CrossJurisdictionSalvage,
        obj(vec![
            ("routeId", string("order-1")),
            ("binary", string(&reveal_binary(&proof, 65535))),
            (
                "fillRatio",
                number(65535, EntityTxKind::CrossJurisdictionSalvage, "RATIO").unwrap(),
            ),
        ]),
    )
    .unwrap();
    (state, BTreeMap::from([(hub, view)]), command)
}

#[test]
fn review_3_confirmed_equal_target_ratio_is_not_requeued() {
    let (mut state, views, command) = salvage_setup();
    let mut prior = state
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap()
        .clone();
    set(
        &mut prior,
        "targetRegistryFillRatio",
        number(65535, command.kind, "RATIO").unwrap(),
    )
    .unwrap();
    stored(&mut state, prior);
    let result = apply_salvage(&mut state, &views, &command).unwrap();
    assert!(result.outputs.is_empty());
    assert!(
        state
            .j_batch_state
            .as_ref()
            .is_none_or(|batch| batch.batch.hash_ladder_registrations.is_empty())
    );
}

#[test]
fn review_7_full_draft_salvage_emits_broadcast_to_make_room() {
    let (mut state, views, command) = salvage_setup();
    let batch = state.j_batch_state.get_or_insert_with(Default::default);
    for i in 0..32 {
        batch
            .batch
            .hash_ladder_registrations
            .push(crate::j_batch::HashLadderRegistration {
                counterparty_entity: [i; 32],
                target_role: true,
                full_hash: [i; 32],
                partial_root: [i; 32],
                witness: crate::j_batch::HashLadderWitness {
                    fill_ratio: 65535,
                    full_secret: [i; 32],
                    reveals: [[0; 32]; 4],
                },
            });
    }
    let result = apply_salvage(&mut state, &views, &command).unwrap();
    assert_eq!(
        result.outputs.len(),
        1,
        "deferred witness must drain the full draft"
    );
    assert!(
        field(
            state
                .cross_jurisdiction_swaps
                .as_ref()
                .unwrap()
                .get("order-1")
                .unwrap(),
            "pendingTargetRegistryReveal"
        )
        .is_some()
    );
}

#[test]
fn review_2_target_hub_rejects_different_ladders() {
    let mut state = EntityStateSlice::empty("target-hub", 1_000);
    state.known_accounts.insert("target-user".into());
    let mut next = prepared_route(&route("intent", false), "runtime-seed", 1_000).unwrap();
    set(&mut next, "status", string("resting")).unwrap();
    let mut target = field(&next, "targetPull").unwrap().clone();
    set(
        &mut target,
        "partialRoot",
        string(&format!("0x{}", "ab".repeat(32))),
    )
    .unwrap();
    set(&mut next, "targetPull", target).unwrap();
    let result = apply_register(
        &mut state,
        &tx(EntityTxKind::RegisterCrossJurisdictionSwap, next),
    );
    assert!(matches!(
        result,
        Err(EntityKernelError::RejectedEntityTx { .. })
    ));
    assert!(state.cross_jurisdiction_swaps.is_none());
}

#[test]
fn review_4_terminal_register_cannot_resurrect() {
    let mut state = EntityStateSlice::empty("target-hub", 1_000);
    state.known_accounts.insert("target-user".into());
    let mut next = prepared_route(&route("intent", false), "runtime-seed", 1_000).unwrap();
    set(&mut next, "status", string("resting")).unwrap();
    let mut prior = next.clone();
    set(&mut prior, "status", string("cancelled")).unwrap();
    stored(&mut state, prior.clone());
    let result = apply_register(
        &mut state,
        &tx(EntityTxKind::RegisterCrossJurisdictionSwap, next),
    )
    .unwrap();
    assert!(result.proposal_work.is_empty());
    assert_eq!(
        state
            .cross_jurisdiction_swaps
            .as_ref()
            .unwrap()
            .get("order-1"),
        Some(&prior)
    );
}

#[test]
fn review_4_duplicate_register_emits_no_opening_work() {
    let mut state = EntityStateSlice::empty("target-hub", 1_000);
    state.known_accounts.insert("target-user".into());
    let mut next = prepared_route(&route("intent", false), "runtime-seed", 1_000).unwrap();
    set(&mut next, "status", string("resting")).unwrap();
    stored(&mut state, next.clone());
    let result = apply_register(
        &mut state,
        &tx(EntityTxKind::RegisterCrossJurisdictionSwap, next),
    )
    .unwrap();
    assert!(result.proposal_work.is_empty());
}

#[test]
fn review_5_expired_prepare_cannot_become_durable() {
    let mut state = EntityStateSlice::empty("source-hub", 61_000);
    let result = apply_prepare(
        &mut state,
        &tx(
            EntityTxKind::PrepareCrossJurisdictionSwap,
            route("intent", false),
        ),
    )
    .unwrap();
    assert!(result.outputs.is_empty());
    assert!(
        state
            .cross_jurisdiction_swaps
            .as_ref()
            .is_none_or(|routes| routes.get("order-1").is_none())
    );
}

#[test]
fn review_5_response_window_mismatch_does_not_become_durable() {
    let mut state = EntityStateSlice::empty("source-hub", 1_000);
    state.known_accounts.insert("source-user".into());
    let result = apply_cross_jurisdiction_entity_txs(
        &mut state,
        &BTreeMap::from([("source-user".into(), source_clock_view(10, 10))]),
        &[tx(
            EntityTxKind::PrepareCrossJurisdictionSwap,
            route("intent", false),
        )],
        None,
        &authority(
            "source-hub-signer",
            1,
            "0x1111111111111111111111111111111111111111",
        ),
    )
    .unwrap();
    assert!(result.outputs.is_empty());
    assert!(state.cross_jurisdiction_swaps.is_none());
}

#[test]
fn review_5_expiry_between_prepare_and_wake_does_not_halt() {
    let mut state = EntityStateSlice::empty("source-hub", 1_000);
    stored(&mut state, route("intent", false));
    let result = build_proposer_materializations(
        &state,
        "runtime-seed",
        61_000,
        "source-hub-signer",
        &authority(
            "source-hub-signer",
            1,
            "0x1111111111111111111111111111111111111111",
        ),
        &BTreeMap::new(),
        &BTreeSet::new(),
        false,
    )
    .unwrap();
    assert!(result.is_empty());
}

#[test]
fn review_8_same_stack_prepare_is_typed_reject() {
    let mut state = EntityStateSlice::empty("source-hub", 1_000);
    let mut next = route("intent", false);
    let source_j = nested_text(&next, "source", "jurisdiction")
        .unwrap()
        .to_string();
    let mut target = field(&next, "target").unwrap().clone();
    set(&mut target, "jurisdiction", string(&source_j)).unwrap();
    set(&mut next, "target", target).unwrap();
    set(&mut next, "bookOwnerEntityId", string("source-hub")).unwrap();
    set(&mut next, "venueId", string("explicit-same-stack")).unwrap();
    let error = apply_prepare(
        &mut state,
        &tx(EntityTxKind::PrepareCrossJurisdictionSwap, next),
    )
    .unwrap_err();
    assert!(matches!(error, EntityKernelError::RejectedEntityTx { .. }));
}

#[test]
fn review_9_clear_intent_is_typed_reject() {
    let mut state = EntityStateSlice::empty("source-hub", 1_000);
    stored(&mut state, route("intent", false));
    let command = projected(
        EntityTxKind::RequestCrossJurisdictionClear,
        obj(vec![
            ("orderId", string("order-1")),
            ("cancelRemainder", CanonicalValue::Bool(true)),
        ]),
    )
    .unwrap();
    let error = apply_clear_request(
        &mut state,
        &BTreeMap::from([("source-user".into(), account_view())]),
        &command,
    )
    .unwrap_err();
    assert!(matches!(error, EntityKernelError::RejectedEntityTx { .. }));
}

#[test]
fn review_10_materialization_of_just_cancelled_exact_intent_is_absorbed() {
    let mut state = EntityStateSlice::empty("source-hub", 1_000);
    let next = prepared_route(&route("intent", false), "runtime-seed", 1_000).unwrap();
    let mut prior = next.clone();
    remove(&mut prior, "sourcePull").unwrap();
    remove(&mut prior, "targetPull").unwrap();
    set(&mut prior, "status", string("cancelled")).unwrap();
    stored(&mut state, prior.clone());
    let result = apply_materialize_swap(
        &mut state,
        &tx(EntityTxKind::MaterializeCrossJurisdictionSwap, next),
    )
    .unwrap();
    assert!(result.outputs.is_empty());
    assert_eq!(
        state
            .cross_jurisdiction_swaps
            .as_ref()
            .unwrap()
            .get("order-1"),
        Some(&prior)
    );
}

#[test]
fn review_11_same_sequence_different_execution_amounts_is_typed_reject() {
    let mut state = EntityStateSlice::empty("source-hub", 1_000);
    let mut next = canonical_route(
        &route("resting", false),
        EntityTxKind::CrossJurisdictionFillNotice,
    )
    .unwrap();
    for (key, value) in [
        (
            "fillSeq",
            number(1, EntityTxKind::CrossJurisdictionFillNotice, "SEQ").unwrap(),
        ),
        (
            "cumulativeFillRatio",
            number(100, EntityTxKind::CrossJurisdictionFillNotice, "RATIO").unwrap(),
        ),
        ("fillNumerator", CanonicalValue::BigInt(100.into())),
        ("fillDenominator", CanonicalValue::BigInt(65535.into())),
        ("executionSourceAmount", CanonicalValue::BigInt(1.into())),
        ("executionTargetAmount", CanonicalValue::BigInt(1.into())),
    ] {
        set(&mut next, key, value).unwrap();
    }
    let data = obj(vec![
        ("orderId", string("order-1")),
        ("routeHash", field(&next, "routeHash").unwrap().clone()),
        ("fillSeq", field(&next, "fillSeq").unwrap().clone()),
        (
            "cumulativeFillRatio",
            field(&next, "cumulativeFillRatio").unwrap().clone(),
        ),
        (
            "cumulativeExecutionSourceAmount",
            CanonicalValue::BigInt(2.into()),
        ),
        (
            "cumulativeExecutionTargetAmount",
            CanonicalValue::BigInt(1.into()),
        ),
    ]);
    stored(&mut state, next);
    let error = committed::apply_source_hub_fill_progress(
        &mut state,
        &data,
        EntityTxKind::CrossJurisdictionFillNotice,
    )
    .unwrap_err();
    assert!(matches!(error, EntityKernelError::RejectedEntityTx { .. }));
}

#[test]
fn review_12_forged_salvage_ratio_is_absorbed() {
    let mut state = EntityStateSlice::empty("target-user", 1_000);
    let next = prepared_route(&route("intent", false), "runtime-seed", 1_000).unwrap();
    let proof = hash_ladder_proof("runtime-seed", text(&next, "routeHash").unwrap());
    stored(&mut state, next);
    let command = projected(
        EntityTxKind::CrossJurisdictionSalvage,
        obj(vec![
            ("routeId", string("order-1")),
            ("binary", string(&reveal_binary(&proof, 65535))),
            (
                "fillRatio",
                number(1, EntityTxKind::CrossJurisdictionSalvage, "RATIO").unwrap(),
            ),
        ]),
    )
    .unwrap();
    let before = state.clone();
    let result = apply_salvage(&mut state, &BTreeMap::new(), &command).unwrap();
    assert!(result.outputs.is_empty());
    assert_eq!(state, before);
}

#[test]
fn review_13_runtime_seed_whitespace_is_canonical() {
    let plain = hash_ladder_proof("runtime-seed", "0x1234");
    let spaced = hash_ladder_proof(" runtime-seed\n", "0x1234");
    assert_eq!(plain.full_hash, spaced.full_hash);
    assert_eq!(plain.partial_root, spaced.partial_root);
}
