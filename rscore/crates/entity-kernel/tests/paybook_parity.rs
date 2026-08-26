mod support;

use std::collections::BTreeSet;

use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use support::{
    HUB, MAKER, NEXT, account, apply_account, assert_owned_sections, commit, digest_bytes, fixture,
    fixture_text, fixture_u64, hex, token, tx_digest,
};
use xln_rscore_engine::{
    AccountOutput, AccountTx, DeliveryMode, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome,
    HtlcResolveTx, OpaqueHtlcCiphertext, Side,
};
use xln_rscore_entity_kernel::{
    DeterministicContext, EntityKernelOutput, EntityStateSlice, HtlcPreparedBinding,
    HtlcPreparedOutcome, HtlcRoute, PreparedHtlcEntry, apply_entity_kernel,
    compute_entity_owned_sections,
};

#[test]
fn canonical_account_outputs_fuse_direct_and_htlc_forward_work() {
    let base = account(MAKER, &[1]);
    let direct = AccountTx::DirectPayment {
        token_id: token(1),
        amount: BigInt::from(100),
        route: vec![HUB.to_string(), NEXT.to_string()],
        description: None,
        from_entity_id: MAKER.to_string(),
        to_entity_id: HUB.to_string(),
        delivery_mode: DeliveryMode::Trusted,
        trusted_gateway_entity_id: Some(HUB.to_string()),
    };
    let (after_direct, direct_outputs) = apply_account(&base, Side::Right, &direct, 0, 1);

    let envelope = OpaqueHtlcCiphertext::from_packed(vec![0x51; 48]).expect("outer envelope");
    let inner = OpaqueHtlcCiphertext::from_packed(vec![0x61; 48]).expect("inner envelope");
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: format!("0x{}", "aa".repeat(32)),
        hashlock: HtlcHashlock::parse(&format!("0x{}", "bb".repeat(32))).expect("hashlock"),
        timelock: BigInt::from(200_000),
        reveal_before_height: 1_000,
        amount: BigInt::from(90),
        token_id: token(1),
        delivery_mode: None,
        envelope: Some(envelope.clone()),
    });
    let (_, lock_outputs) = apply_account(&after_direct, Side::Right, &lock, 1, 2);
    assert!(lock_outputs.is_empty());

    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string(), NEXT.to_string()]);
    let mut context = DeterministicContext::hlt_default();
    let frame_state_hash = format!("0x{}", "31".repeat(32));
    let AccountTx::HtlcLock(lock_data) = &lock else {
        unreachable!()
    };
    context.prepared_htlcs.insert(
        (frame_state_hash.clone(), lock_data.lock_id.clone()),
        PreparedHtlcEntry {
            binding: HtlcPreparedBinding {
                from_entity_id: MAKER.to_string(),
                to_entity_id: HUB.to_string(),
                domain: support::domain(),
                account_frame_hash: frame_state_hash.clone(),
                account_height: 1,
                lock_id: lock_data.lock_id.clone(),
                envelope_hash: hex(&envelope.integrity_hash()),
                hashlock: lock_data.hashlock.as_str().to_string(),
                token_id: 1,
                amount: BigInt::from(90),
                timelock: BigInt::from(200_000),
                reveal_before_height: 1_000,
            },
            outcome: HtlcPreparedOutcome::Forward {
                next_hop_entity_id: NEXT.to_string(),
                forward_amount: BigInt::from(87),
                inner_envelope: inner.clone(),
            },
        },
    );
    let mut inbound = commit(MAKER, 0x31, 1, direct, direct_outputs);
    inbound
        .transitions
        .push(xln_rscore_entity_kernel::CommittedAccountTransition {
            tx: lock,
            outputs: lock_outputs,
        });

    let result = apply_entity_kernel(state, &[inbound], &context).expect("entity kernel");
    let oracle = fixture();
    assert_eq!(result.proposal_work.len(), 1);
    assert_eq!(result.proposal_work[0].account_id, NEXT);
    assert_eq!(result.proposal_work[0].txs.len(), 2);
    let AccountTx::HtlcLock(forwarded) = &result.proposal_work[0].txs[0] else {
        panic!("canonical frame-owned HTLC follow-up must precede parent direct follow-ups")
    };
    assert_eq!(
        forwarded.lock_id,
        fixture_text(&oracle, &["paybookForward", "forwardLockId"])
    );
    assert_eq!(forwarded.amount, BigInt::from(87));
    assert_eq!(forwarded.timelock, BigInt::from(190_000));
    assert_eq!(forwarded.reveal_before_height, 997);
    assert_eq!(forwarded.envelope.as_ref(), Some(&inner));
    let AccountTx::DirectPayment {
        route, description, ..
    } = &result.proposal_work[0].txs[1]
    else {
        panic!("routed direct payment must follow frame-owned HTLC work")
    };
    assert_eq!(route, &[NEXT.to_string()]);
    assert_eq!(description.as_deref(), Some("Forwarded payment"));
    assert_eq!(
        result.outputs,
        vec![EntityKernelOutput::HtlcForwardAccepted {
            entity_id: HUB.to_string(),
            hashlock: format!("0x{}", "bb".repeat(32)),
        }]
    );
    let route = result
        .state
        .htlc_routes
        .get(&format!("0x{}", "bb".repeat(32)))
        .expect("forward route");
    assert_eq!(route.pending_fee, Some(BigInt::from(3)));
    assert_eq!(
        hex(&envelope.integrity_hash()),
        fixture_text(&oracle, &["paybookForward", "outerEnvelopeHash"])
    );
    assert_eq!(
        result.commitments.paybook_root,
        fixture_text(&oracle, &["paybookForward", "paybookRoot"])
    );
    assert_eq!(
        result.commitments.orderbook_root,
        fixture_text(&oracle, &["paybookForward", "orderbookRoot"])
    );
    assert_eq!(
        result.commitments.ordered_outbox_digest,
        fixture_text(&oracle, &["paybookForward", "orderedOutboxDigest"])
    );
    let account_count = usize::try_from(fixture_u64(
        &oracle,
        &["paybookForward", "canonicalEntity", "accountCount"],
    ))
    .expect("fixture account count");
    let owned = compute_entity_owned_sections(
        &result.state,
        digest_bytes(fixture_text(
            &oracle,
            &["paybookForward", "canonicalEntity", "accountsRoot"],
        )),
        account_count,
    )
    .expect("canonical Entity owned sections");
    assert_owned_sections(&owned, &oracle, "paybookForward");
    let expected_tx_digests = oracle["paybookForward"]["txDigests"]
        .as_array()
        .expect("tx digests");
    assert_eq!(
        tx_digest(&result.proposal_work[0].txs[0]),
        expected_tx_digests[0]
    );
    assert_eq!(
        tx_digest(&result.proposal_work[0].txs[1]),
        expected_tx_digests[1]
    );
}

#[test]
fn canonical_account_secret_resolve_completes_final_htlc_in_two_fused_passes() {
    let secret = format!("0x{}", "77".repeat(32));
    let secret_bytes = [0x77_u8; 32];
    let hashlock_bytes: [u8; 32] = Keccak256::digest(secret_bytes).into();
    let hashlock = hex(&hashlock_bytes);
    let envelope = OpaqueHtlcCiphertext::from_packed(vec![0x71; 48]).expect("final envelope");
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: format!("0x{}", "cc".repeat(32)),
        hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
        timelock: BigInt::from(200_000),
        reveal_before_height: 1_000,
        amount: BigInt::from(90),
        token_id: token(1),
        delivery_mode: None,
        envelope: Some(envelope.clone()),
    });
    let (locked_account, lock_outputs) =
        apply_account(&account(MAKER, &[1]), Side::Right, &lock, 0, 1);
    assert!(lock_outputs.is_empty());

    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string()]);
    let mut context = DeterministicContext::hlt_default();
    context.jurisdiction_id = Some("fixture".to_string());
    let frame_state_hash = format!("0x{}", "71".repeat(32));
    let AccountTx::HtlcLock(lock_data) = &lock else {
        unreachable!()
    };
    let inbound_lock_id = lock_data.lock_id.clone();
    context.prepared_htlcs.insert(
        (frame_state_hash.clone(), lock_data.lock_id.clone()),
        PreparedHtlcEntry {
            binding: HtlcPreparedBinding {
                from_entity_id: MAKER.to_string(),
                to_entity_id: HUB.to_string(),
                domain: support::domain(),
                account_frame_hash: frame_state_hash,
                account_height: 1,
                lock_id: lock_data.lock_id.clone(),
                envelope_hash: hex(&envelope.integrity_hash()),
                hashlock: hashlock.clone(),
                token_id: 1,
                amount: BigInt::from(90),
                timelock: BigInt::from(200_000),
                reveal_before_height: 1_000,
            },
            outcome: HtlcPreparedOutcome::Final {
                secret: secret.clone(),
                started_at_ms: Some(1_500),
            },
        },
    );
    let first = apply_entity_kernel(
        state,
        &[commit(MAKER, 0x71, 1, lock, lock_outputs)],
        &context,
    )
    .expect("prepared final pass");
    assert!(first.outputs.is_empty());
    assert_eq!(first.proposal_work.len(), 1);
    assert_eq!(first.proposal_work[0].account_id, MAKER);
    assert_eq!(first.proposal_work[0].txs.len(), 1);
    let resolve = first.proposal_work[0].txs[0].clone();
    let oracle = fixture();
    assert_eq!(
        tx_digest(&resolve),
        fixture_text(&oracle, &["paybookFinalResolve", "resolveDigest"])
    );
    let AccountTx::HtlcResolve(resolve_data) = &resolve else {
        panic!("final recipient must resolve the inbound lock")
    };
    assert_eq!(resolve_data.lock_id, inbound_lock_id);
    assert!(matches!(
        &resolve_data.outcome,
        xln_rscore_engine::HtlcResolveOutcome::Secret { secret: value } if value == &secret
    ));
    let route = first.state.htlc_routes.get(&hashlock).expect("final route");
    assert_eq!(route.inbound_entity.as_deref(), Some(MAKER));
    assert_eq!(route.started_at_ms, Some(1_500));

    let (_, resolve_outputs) = apply_account(&locked_account, Side::Left, &resolve, 1, 2);
    let mut settle_context = DeterministicContext::hlt_default();
    settle_context.jurisdiction_id = Some("fixture".to_string());
    let settled = apply_entity_kernel(
        first.state,
        &[commit(MAKER, 0x72, 2, resolve, resolve_outputs)],
        &settle_context,
    )
    .expect("committed secret pass");
    assert!(settled.proposal_work.is_empty());
    assert_eq!(
        settled.outputs,
        vec![EntityKernelOutput::HtlcReceived {
            entity_id: HUB.to_string(),
            from_entity: MAKER.to_string(),
            to_entity: HUB.to_string(),
            hashlock: hashlock.clone(),
            lock_id: format!("0x{}", "cc".repeat(32)),
            token_id: Some(1),
            amount: Some(BigInt::from(90)),
            started_at_ms: Some(1_500),
            jurisdiction_id: Some("fixture".to_string()),
            received_at_ms: 2_000,
        }]
    );
    assert!(!settled.state.htlc_routes.contains_key(&hashlock));
    assert_eq!(
        settled.commitments.paybook_root,
        fixture_text(&oracle, &["paybookFinalResolve", "paybookRoot"])
    );
    assert_eq!(
        settled.commitments.ordered_outbox_digest,
        fixture_text(&oracle, &["paybookFinalResolve", "orderedOutboxDigest"])
    );
}

#[test]
fn zero_forwarding_fee_remains_present_after_secret_reveal() {
    let secret = format!("0x{}", "44".repeat(32));
    let hashlock_bytes: [u8; 32] = Keccak256::digest([0x44_u8; 32]).into();
    let hashlock = hex(&hashlock_bytes);
    let inbound_lock_id = format!("0x{}", "55".repeat(32));
    let outbound_lock_id = format!("0x{}", "66".repeat(32));
    let mut state = EntityStateSlice::empty(HUB, 2_000);
    state.known_accounts = BTreeSet::from([MAKER.to_string(), NEXT.to_string()]);
    state.htlc_routes.insert(
        hashlock.clone(),
        HtlcRoute {
            hashlock: hashlock.clone(),
            token_id: Some(1),
            amount: Some(BigInt::from(1_000)),
            started_at_ms: None,
            originated: false,
            inbound_entity: Some(MAKER.to_string()),
            inbound_lock_id: Some(inbound_lock_id.clone()),
            outbound_entity: Some(NEXT.to_string()),
            outbound_lock_id: Some(outbound_lock_id.clone()),
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: Some(BigInt::from(0)),
            created_timestamp: 1_000,
        },
    );
    let resolve = AccountTx::HtlcResolve(HtlcResolveTx {
        lock_id: outbound_lock_id.clone(),
        outcome: HtlcResolveOutcome::Secret {
            secret: secret.clone(),
        },
    });
    let output = AccountOutput::HtlcSecret {
        lock_id: outbound_lock_id,
        hashlock: hashlock.clone(),
        secret: secret.clone(),
        token_id: token(1),
        amount: BigInt::from(1_000),
    };
    let result = apply_entity_kernel(
        state,
        &[commit(NEXT, 0x81, 2, resolve, vec![output])],
        &DeterministicContext::hlt_default(),
    )
    .expect("forward secret");
    let route = result
        .state
        .htlc_routes
        .get(&hashlock)
        .expect("forward route remains");
    assert_eq!(route.secret.as_deref(), Some(secret.as_str()));
    assert_eq!(route.pending_fee, Some(BigInt::from(0)));
    assert!(route.secret_ack_pending);
    assert_eq!(result.proposal_work.len(), 1);
    assert_eq!(result.proposal_work[0].account_id, MAKER);
}
