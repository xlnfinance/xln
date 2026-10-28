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
    let output = &result.outputs[0];
    assert_eq!(output.entity_id, state.entity_id);
    assert_eq!(output.target_signer_id, None);
    assert_eq!(output.entity_txs.len(), 1);
    let LocalEntityOutputTx::Projected(command) = &output.entity_txs[0] else {
        panic!("expected complete j_broadcast payload");
    };
    assert_eq!(command.kind, EntityTxKind::JBroadcast);
    assert_eq!(command.frame_data(), Some(&obj(vec![])));
    assert!(result.proposal_work.is_empty());
    assert_eq!(
        result.events,
        vec![EntityFrameEvent::Status {
            message:
                "⏳ Cross-j reveal port order-1: deferred until the pending jBatch is acknowledged"
                    .into(),
        }]
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
    let result = result.expect("binding refusal is a committed status, not tx rejection");
    assert!(result.proposal_work.is_empty());
    assert!(result.outputs.is_empty());
    assert!(
        matches!(&result.events[..], [EntityFrameEvent::Status { message }]
        if message == "❌ Cross-j register order-1 rejected before Account queue: Cross-j pull ladders do not match")
    );
    assert!(state.cross_jurisdiction_swaps.is_none());
}

#[test]
fn review_2_reamend_missing_opening_pull_is_typed_reject_for_every_participant() {
    for local in ["source-hub", "target-hub", "source-user", "target-user"] {
        let mut state = EntityStateSlice::empty(local, 1_000);
        let mut next = prepared_route(&route("intent", false), "runtime-seed", 1_000).unwrap();
        set(&mut next, "status", string("resting")).unwrap();
        remove(&mut next, "targetPull").unwrap();
        let before = state.clone();
        let error = apply_register(
            &mut state,
            &tx(EntityTxKind::RegisterCrossJurisdictionSwap, next),
        )
        .expect_err("a missing opening pull is a typed peer rejection");
        assert!(
            matches!(error, EntityKernelError::RejectedEntityTx { detail, .. }
            if detail == "CROSS_J_REGISTER_OPENING_PULLS_MISSING:order-1")
        );
        assert_eq!(state, before);
    }
}

#[test]
fn review_2_reamend_users_store_mismatched_ladders_without_hub_admission() {
    for local in ["source-user", "target-user"] {
        let mut state = EntityStateSlice::empty(local, 1_000);
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
            &tx(EntityTxKind::RegisterCrossJurisdictionSwap, next.clone()),
        )
        .unwrap();
        assert_eq!(
            state
                .cross_jurisdiction_swaps
                .as_ref()
                .unwrap()
                .get("order-1"),
            Some(&next)
        );
        assert!(result.outputs.is_empty());
        assert!(result.proposal_work.is_empty());
        assert_eq!(
            result.events,
            vec![EntityFrameEvent::Status {
                message: "🌉 Cross-j swap order-1 registered".into(),
            }]
        );
    }
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

fn target_registration(
    state: &EntityStateSlice,
    ratio: u16,
) -> crate::j_batch::HashLadderRegistration {
    let route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap();
    let pull = field(route, "targetPull").unwrap();
    let kind = EntityTxKind::CrossJurisdictionSalvage;
    crate::j_batch::HashLadderRegistration {
        counterparty_entity: word(
            nested_text(route, "target", "entityId").unwrap(),
            kind,
            "PEER",
        )
        .unwrap(),
        target_role: true,
        full_hash: word(text(pull, "fullHash").unwrap(), kind, "HASH").unwrap(),
        partial_root: word(text(pull, "partialRoot").unwrap(), kind, "ROOT").unwrap(),
        witness: crate::j_batch::HashLadderWitness {
            fill_ratio: ratio,
            full_secret: [0; 32],
            reveals: [[0; 32]; 4],
        },
    }
}

#[test]
fn review_3_amend_membership_precedes_maximum_conflict() {
    for existing in ["confirmed", "queued", "pending"] {
        let (mut state, _, command) = salvage_setup();
        let retry = target_registration(&state, 100);
        let newer = target_registration(&state, 200);
        let mut prior = state
            .cross_jurisdiction_swaps
            .as_ref()
            .unwrap()
            .get("order-1")
            .unwrap()
            .clone();
        if existing == "confirmed" {
            set(
                &mut prior,
                "targetRegistryFillRatio",
                number(100, command.kind, "RATIO").unwrap(),
            )
            .unwrap();
        } else if existing == "pending" {
            set(
                &mut prior,
                "pendingTargetRegistryReveal",
                pending_witness_value(&retry.witness, command.kind).unwrap(),
            )
            .unwrap();
        }
        stored(&mut state, prior);
        let batch = state.j_batch_state.get_or_insert_with(Default::default);
        batch.batch.hash_ladder_registrations.push(newer);
        if existing == "queued" {
            let mut recovered = crate::j_batch::JBatch::default();
            recovered.hash_ladder_registrations.push(retry.clone());
            batch.recovery_batches.push(recovered);
        }
        let before = state.clone();
        assert!(
            matches!(
                queue_hash_ladder_registration(&mut state, retry, command.kind),
                Ok(RegistrationQueueResult::AlreadyQueued)
            ),
            "{existing} 100 must survive queued 200"
        );
        assert_eq!(state, before);
        let stale = target_registration(&state, 150);
        assert!(queue_hash_ladder_registration(&mut state, stale, command.kind).is_err());
        assert_eq!(state, before);
    }
}

#[test]
fn review_3_amend_pending_ratio_prevents_stale_admission() {
    let (mut state, _, command) = salvage_setup();
    let pending = target_registration(&state, 200);
    let mut prior = state
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap()
        .clone();
    set(
        &mut prior,
        "pendingTargetRegistryReveal",
        pending_witness_value(&pending.witness, command.kind).unwrap(),
    )
    .unwrap();
    stored(&mut state, prior);
    state.j_batch_state = Some(Default::default());
    let before = state.clone();
    let stale = target_registration(&state, 150);
    assert!(queue_hash_ladder_registration(&mut state, stale, command.kind).is_err());
    assert_eq!(state, before);
}

#[test]
fn q48_salvage_uppercase_prefix_full_evidence_waits_for_target_dispute_clock() {
    let (mut state, _, command) = salvage_setup();
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap()
        .clone();
    set(&mut route, "status", string("resting")).unwrap();
    stored(&mut state, route.clone());
    let mut data = command.frame_data().unwrap().clone();
    let binary = text(&data, "binary").unwrap().to_string();
    set(&mut data, "binary", string(&binary.to_uppercase())).unwrap();
    let command = projected(command.kind, data).unwrap();
    let before = state.clone();
    let result = apply_salvage(&mut state, &BTreeMap::new(), &command).unwrap();
    assert!(result.outputs.is_empty());
    assert!(result.proposal_work.is_empty());
    assert_eq!(
        result.events,
        vec![EntityFrameEvent::Status {
            message: "⏳ Cross-j reveal port order-1: waiting for the target dispute clock".into(),
        }]
    );
    let pending = obj(vec![
        ("fillRatio", number(65535, command.kind, "RATIO").unwrap()),
        ("fullSecret", string(&binary)),
        (
            "reveals",
            CanonicalValue::Array(vec![string(&format!("0x{}", "00".repeat(32))); 4]),
        ),
    ]);
    set(&mut route, "pendingTargetRegistryReveal", pending).unwrap();
    set(
        &mut route,
        "updatedAt",
        number(state.timestamp, command.kind, "TIMESTAMP").unwrap(),
    )
    .unwrap();
    let mut expected = before;
    stored(&mut expected, route);
    assert_eq!(state, expected);
}

#[test]
fn q48_salvage_raw_uppercase_empty_prefix_is_zero_fill_without_state_mutation() {
    let (mut state, _, command) = salvage_setup();
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .unwrap()
        .get("order-1")
        .unwrap()
        .clone();
    set(&mut route, "status", string("resting")).unwrap();
    stored(&mut state, route);
    let mut data = command.frame_data().unwrap().clone();
    set(&mut data, "binary", string("0X")).unwrap();
    let command = projected(command.kind, data).unwrap();
    let before = state.clone();
    let result = apply_salvage(&mut state, &BTreeMap::new(), &command).unwrap();
    assert_eq!(state, before);
    assert!(result.outputs.is_empty());
    assert!(result.proposal_work.is_empty());
    assert_eq!(
        result.events,
        vec![EntityFrameEvent::Status {
            message: "🌉 Cross-j reveal port ignored for order-1: zero fill".into(),
        }]
    );
}

#[test]
fn q46_salvage_empty_binary_preserves_owned_route_validation_and_finality() {
    for status in ["resting", "settled"] {
        for missing_pull in [false, true] {
            let (mut state, views, command) = salvage_setup();
            let mut route = state
                .cross_jurisdiction_swaps
                .as_ref()
                .unwrap()
                .get("order-1")
                .unwrap()
                .clone();
            set(&mut route, "status", string(status)).unwrap();
            if missing_pull {
                remove(&mut route, "targetPull").unwrap();
            }
            stored(&mut state, route);
            let mut data = command.frame_data().unwrap().clone();
            set(&mut data, "binary", string("0x")).unwrap();
            set(
                &mut data,
                "fillRatio",
                number(1, command.kind, "RATIO").unwrap(),
            )
            .unwrap();
            let command = projected(command.kind, data).unwrap();
            let before = state.clone();
            let result = apply_salvage(&mut state, &views, &command);
            assert_eq!(state, before);
            if missing_pull {
                assert!(
                    matches!(result.unwrap_err(), EntityKernelError::InvalidLocalEntityTx { detail, .. }
                    if detail.contains("TARGET_PULL_MISSING"))
                );
            } else {
                let result = result.unwrap();
                assert!(result.outputs.is_empty());
                assert!(result.proposal_work.is_empty());
                let events = if status == "settled" {
                    vec![]
                } else {
                    vec![EntityFrameEvent::Status {
                        message: "🌉 Cross-j reveal port ignored for order-1: empty result".into(),
                    }]
                };
                assert_eq!(result.events, events);
            }
        }
    }
}

#[test]
fn q46_salvage_unowned_positive_claim_is_status_only() {
    for ownership in ["missing collection", "unknown route", "non-owner"] {
        let (mut state, views, command) = salvage_setup();
        match ownership {
            "missing collection" => state.cross_jurisdiction_swaps = None,
            "unknown route" => {
                state
                    .cross_jurisdiction_swaps
                    .as_mut()
                    .unwrap()
                    .remove("order-1")
                    .unwrap();
            }
            "non-owner" => {
                state.entity_id = format!("0x{}", "33".repeat(32));
                let mut route = state
                    .cross_jurisdiction_swaps
                    .as_ref()
                    .unwrap()
                    .get("order-1")
                    .unwrap()
                    .clone();
                // Unowned corruption must not enter owned-route validation.
                remove(&mut route, "targetPull").unwrap();
                stored(&mut state, route);
            }
            _ => unreachable!(),
        }
        let mut data = command.frame_data().unwrap().clone();
        set(
            &mut data,
            "fillRatio",
            number(1, command.kind, "RATIO").unwrap(),
        )
        .unwrap();
        let command = projected(command.kind, data).unwrap();
        let before = state.clone();
        let result =
            apply_salvage(&mut state, &views, &command).expect("unowned evidence cannot halt");
        assert_eq!(state, before);
        assert!(result.outputs.is_empty());
        assert!(result.proposal_work.is_empty());
        assert_eq!(
            result.events,
            vec![EntityFrameEvent::Status {
                message: "🌉 Cross-j reveal port order-1 skipped: route not owned here".into(),
            }]
        );
    }
}

#[test]
fn review_12_amend_out_of_range_claim_is_status_not_fatal() {
    for (ratio, normalized_claim) in [
        ("-1", None),
        ("-0.25", None),
        ("-1e-7", None),
        ("0", None),
        ("0.75", None),
        ("65536", Some("65536")),
        ("65536.75", Some("65536")),
        ("1e+21", Some("1e+21")),
    ] {
        let (mut state, views, command) = salvage_setup();
        let mut data = command.frame_data().unwrap().clone();
        set(
            &mut data,
            "fillRatio",
            CanonicalValue::Number(CanonicalNumber::parse_js_canonical(ratio).unwrap()),
        )
        .unwrap();
        let command = projected(command.kind, data).unwrap();
        let before = state.clone();
        let result =
            apply_salvage(&mut state, &views, &command).expect("untrusted ratio cannot halt");
        assert!(result.outputs.is_empty());
        assert!(result.proposal_work.is_empty());
        assert_eq!(state, before);
        let expected = match normalized_claim {
            None => "🌉 Cross-j reveal port ignored for order-1: invalid result".to_string(),
            Some(claim) => format!(
                "❌ Cross-j reveal port order-1 fill mismatch: claimed {claim}, verified 65535"
            ),
        };
        assert_eq!(
            result.events,
            vec![EntityFrameEvent::Status {
                message: expected.into()
            }]
        );
    }
}

#[test]
fn review_12_amend_missing_target_pull_stays_fatal() {
    for status in ["resting", "settled"] {
        let (mut state, views, command) = salvage_setup();
        let mut prior = state
            .cross_jurisdiction_swaps
            .as_ref()
            .unwrap()
            .get("order-1")
            .unwrap()
            .clone();
        remove(&mut prior, "targetPull").unwrap();
        set(&mut prior, "status", string(status)).unwrap();
        stored(&mut state, prior);
        let mut data = command.frame_data().unwrap().clone();
        set(
            &mut data,
            "fillRatio",
            number(65536, command.kind, "RATIO").unwrap(),
        )
        .unwrap();
        let command = projected(command.kind, data).unwrap();
        let before = state.clone();
        let error = apply_salvage(&mut state, &views, &command).unwrap_err();
        assert!(
            matches!(error, EntityKernelError::InvalidLocalEntityTx { detail, .. } if detail.contains("TARGET_PULL_MISSING"))
        );
        assert_eq!(state, before);
    }
}

#[test]
fn review_3_reamend_salvage_retry_preserves_deferred_witness_until_flush() {
    for free_slot in [false, true] {
        let (mut state, views, command) = salvage_setup();
        let mut data = command.frame_data().unwrap().clone();
        let route = state
            .cross_jurisdiction_swaps
            .as_ref()
            .unwrap()
            .get("order-1")
            .unwrap();
        let proof = hash_ladder_proof("runtime-seed", text(route, "routeHash").unwrap());
        let binary = reveal_binary(&proof, 100);
        let mut registration = target_registration(&state, 100);
        registration.witness = salvage_witness(&binary, 100, command.kind).unwrap();
        let mut route = route.clone();
        set(
            &mut route,
            "pendingTargetRegistryReveal",
            pending_witness_value(&registration.witness, command.kind).unwrap(),
        )
        .unwrap();
        stored(&mut state, route);
        set(&mut data, "binary", string(&binary)).unwrap();
        set(
            &mut data,
            "fillRatio",
            number(100, command.kind, "RATIO").unwrap(),
        )
        .unwrap();
        let command = projected(command.kind, data).unwrap();
        let batch = state.j_batch_state.get_or_insert_with(Default::default);
        for i in 0..32 {
            let mut unrelated = registration.clone();
            unrelated.full_hash = [i; 32];
            batch.batch.hash_ladder_registrations.push(unrelated);
        }
        let peer = prefixed_hex(&registration.counterparty_entity);
        let mut outputs = Vec::new();
        assert_eq!(
            flush_pending_target_reveal_for_route(&mut state, "order-1", &peer, &mut outputs)
                .unwrap(),
            0
        );
        assert!(outputs.is_empty());
        assert_eq!(
            field(
                state
                    .cross_jurisdiction_swaps
                    .as_ref()
                    .unwrap()
                    .get("order-1")
                    .unwrap(),
                "pendingTargetRegistryReveal"
            ),
            Some(&pending_witness_value(&registration.witness, command.kind).unwrap())
        );
        if free_slot {
            state
                .j_batch_state
                .as_mut()
                .unwrap()
                .batch
                .hash_ladder_registrations
                .pop();
        }
        let before = state.clone();
        let result = apply_salvage(&mut state, &views, &command).unwrap();
        assert_eq!(state, before, "salvage must leave a pending retry intact");
        assert!(result.outputs.is_empty());
        assert!(result.proposal_work.is_empty());
        assert!(result.events.is_empty());
        if !free_slot {
            state
                .j_batch_state
                .as_mut()
                .unwrap()
                .batch
                .hash_ladder_registrations
                .pop();
        }
        assert_eq!(
            flush_pending_target_reveal_for_route(&mut state, "order-1", &peer, &mut outputs)
                .unwrap(),
            1
        );
        let mut expected = before
            .j_batch_state
            .unwrap()
            .batch
            .hash_ladder_registrations;
        expected.truncate(31);
        expected.push(registration);
        assert_eq!(
            state
                .j_batch_state
                .as_ref()
                .unwrap()
                .batch
                .hash_ladder_registrations,
            expected
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
            .is_none()
        );
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].entity_id, state.entity_id);
        assert_eq!(outputs[0].target_signer_id, None);
        assert_eq!(outputs[0].entity_txs.len(), 1);
        let LocalEntityOutputTx::Projected(command) = &outputs[0].entity_txs[0] else {
            panic!("expected complete j_broadcast payload");
        };
        assert_eq!(command.kind, EntityTxKind::JBroadcast);
        assert_eq!(command.frame_data(), Some(&obj(vec![])));
    }
}

#[test]
fn review_5_amend_source_user_clock_failure_remains_fatal() {
    for missing in [false, true] {
        let mut state = EntityStateSlice::empty("source-user", 1_000);
        state.known_accounts.insert("source-hub".into());
        let views = if missing {
            BTreeMap::new()
        } else {
            BTreeMap::from([("source-hub".into(), source_clock_view(10, 10))])
        };
        let before = state.clone();
        let result = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &views,
            &[tx(
                EntityTxKind::PrepareCrossJurisdictionSwap,
                route("intent", false),
            )],
            None,
            &authority(
                "source-user-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        );
        let error =
            result.expect_err("source-user authority corruption must not become a hub status");
        let expected = if missing {
            "CROSS_J_PREPARED_SOURCE_ACCOUNT_MISSING"
        } else {
            "CROSS_J_PREPARED_SOURCE_ACCOUNT_CLOCK_MISMATCH"
        };
        assert!(
            matches!(error, EntityKernelError::InvalidLocalEntityTx { detail, .. } if detail.starts_with(expected))
        );
        assert_eq!(state, before);
    }
}

#[test]
fn review_13_amend_ecmascript_trim_not_rust_whitespace() {
    let plain = hash_ladder_proof("runtime-seed", "0x1234");
    let bom = hash_ladder_proof("\u{feff}runtime-seed\u{feff}", "0x1234");
    assert_eq!(plain.full_hash, bom.full_hash);
    assert_eq!(plain.partial_root, bom.partial_root);
    let nel = hash_ladder_proof("\u{0085}runtime-seed\u{0085}", "0x1234");
    assert_ne!(plain.full_hash, nel.full_hash);
    assert_ne!(plain.partial_root, nel.partial_root);
}

#[test]
fn review_13_amend_exact_trim_set_and_seed_presence() {
    let codepoints = [
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
        0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
        0xfeff,
    ];
    let state = EntityStateSlice::empty("source-hub", 1000);
    let auth = authority(
        "source-hub-signer",
        1,
        "0x1111111111111111111111111111111111111111",
    );
    for codepoint in codepoints {
        let char = char::from_u32(codepoint).unwrap();
        assert_eq!(
            trim_runtime_seed(&format!("{char}runtime-seed{char}")),
            "runtime-seed"
        );
        let result = build_proposer_materializations(
            &state,
            &char.to_string(),
            1000,
            "source-hub-signer",
            &auth,
            &BTreeMap::new(),
            &BTreeSet::new(),
            false,
        );
        assert!(
            matches!(result, Err(EntityKernelError::InvalidLocalEntityTx { detail, .. }) if detail == "RUNTIME_SEED_MISSING")
        );
    }
    for codepoint in [0x85, 0x180e, 0x200b] {
        let char = char::from_u32(codepoint).unwrap();
        assert_eq!(trim_runtime_seed(&char.to_string()), char.to_string());
        assert!(
            build_proposer_materializations(
                &state,
                &char.to_string(),
                1000,
                "source-hub-signer",
                &auth,
                &BTreeMap::new(),
                &BTreeSet::new(),
                false
            )
            .unwrap()
            .is_empty()
        );
    }
}
