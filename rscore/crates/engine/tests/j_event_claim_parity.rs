use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountOutput, AccountReplica,
    AccountSettledEvent, AccountState, AccountTx, DepositoryAddress, EntityId, JEventClaimTx,
    JEventMetadata, JurisdictionEvent, SequentialAccountEngine, Side, TokenId, WatchSeed,
    canonical_events_hash, canonical_tx_digest, prepare_claim_tx,
};

const EMPTY_PROOF_DIGEST: &str = "d877be0b440ed7bfda96495cefa57ed81331c1ac03b19b09eb27c4083cf01512";

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("entity")
}

fn bytes(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn replica() -> AccountReplica {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "44".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        entity(0x11),
        entity(0x22),
        WatchSeed::parse(&format!("0x{}", "55".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("config"),
        Vec::new(),
    )
    .expect("state");
    AccountReplica::new(entity(0x11), state).expect("replica")
}

fn settled_event() -> JurisdictionEvent {
    JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata::default(),
        left_entity: entity(0x11),
        right_entity: entity(0x22),
        token_id: TokenId::new(1).expect("token"),
        left_reserve: 0.into(),
        right_reserve: 0.into(),
        collateral: 125.into(),
        ondelta: 7.into(),
        nonce: 3,
    })
}

fn raw_claim(height: u64, event: JurisdictionEvent) -> JEventClaimTx {
    JEventClaimTx {
        j_height: height,
        j_block_hash: bytes(0x33),
        events: vec![event],
        left_proof: None,
        right_proof: None,
    }
}

fn prepare(replica: &AccountReplica, tx: &JEventClaimTx) -> JEventClaimTx {
    let carried = replica.state().carried();
    prepare_claim_tx(
        replica.state().identity(),
        &carried.left_pending_j_claims,
        &carried.right_pending_j_claims,
        tx,
        &replica.state().j_claim_node_entries().into_iter().collect(),
    )
    .expect("prepared claim")
}

#[test]
fn event_hash_and_frame_value_match_typescript_goldens() {
    let event = settled_event();
    assert_eq!(
        hex::encode(canonical_events_hash(std::slice::from_ref(&event)).expect("event hash")),
        "630c3e4cc86a379138b0b4ecfb47e612b205f8931faf405bd09f2d2fcedc9d03"
    );
    let prepared = prepare(&replica(), &raw_claim(7, event));
    assert_eq!(
        hex::encode(canonical_tx_digest(&AccountTx::JEventClaim(prepared)).expect("tx digest")),
        EMPTY_PROOF_DIGEST
    );
}

#[test]
fn account_settled_is_pending_then_finalized_once() {
    let base = replica();
    let raw = raw_claim(7, settled_event());
    let left = SequentialAccountEngine::apply(
        &base,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&base, &raw)),
    )
    .expect("left claim")
    .committed()
    .expect("left candidate");
    assert_eq!(left.state().carried().left_pending_j_claims.count, 1);
    assert_eq!(
        hex::encode(left.state().carried().left_pending_j_claims.root),
        "ade5fc6701f2f39afe2fdcdd1ebc47ec93f8b65278f2f48919d9c09cf8053644"
    );

    let right_tx = prepare(&left, &raw);
    let transition =
        SequentialAccountEngine::apply(&left, Side::Right, &AccountTx::JEventClaim(right_tx))
            .expect("right finality");
    assert!(matches!(
        transition.outputs(),
        [AccountOutput::AccountSettledFinalized {
            token_id,
            j_height: 7,
            collateral,
            ondelta,
        }] if token_id.get() == 1 && collateral == &BigInt::from(125) && ondelta == &BigInt::from(7)
    ));
    let final_state = transition.committed().expect("final candidate");
    assert_eq!(final_state.state().carried().left_pending_j_claims.count, 0);
    assert_eq!(
        final_state.state().carried().right_pending_j_claims.count,
        0
    );
    assert_eq!(final_state.state().last_finalized_j_height(), 7);
    assert_eq!(final_state.state().j_nonce(), 3);
    let delta = final_state
        .state()
        .delta(TokenId::new(1).expect("token"))
        .expect("settled delta");
    assert_eq!(delta.collateral(), &BigInt::from(125));
    assert_eq!(delta.ondelta(), &BigInt::from(7));
    assert_eq!(
        hex::encode(
            final_state
                .state()
                .payment_profile_account_state_root()
                .expect("account root")
        ),
        "480f17969d6956dae17a4852174bf1c0cbc563bf7fed05ecd7117aa61235e883"
    );
    assert_eq!(base.state().carried().left_pending_j_claims.count, 0);
}

#[test]
fn exact_retry_is_idempotent_and_conflict_is_atomic() {
    let base = replica();
    let raw = raw_claim(7, settled_event());
    let pending = SequentialAccountEngine::apply(
        &base,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&base, &raw)),
    )
    .expect("pending")
    .committed()
    .expect("pending candidate");
    let root = pending.state().carried().left_pending_j_claims.root;
    let retry = SequentialAccountEngine::apply(
        &pending,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&pending, &raw)),
    )
    .expect("retry")
    .committed()
    .expect("retry candidate");
    assert_eq!(retry.state().carried().left_pending_j_claims.root, root);

    let mut changed = settled_event();
    let JurisdictionEvent::AccountSettled(value) = &mut changed;
    value.collateral = 126.into();
    let conflict = raw_claim(7, changed);
    let error = SequentialAccountEngine::apply(
        &pending,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&pending, &conflict)),
    )
    .err()
    .expect("same key with another event body must fail");
    assert!(error.to_string().contains("ACCOUNT_J_CLAIM_LEFT_CONFLICT"));
    assert_eq!(pending.state().carried().left_pending_j_claims.root, root);
}

#[test]
fn signed_workspace_is_rejected_before_financial_finality() {
    let base = replica();
    let raw = raw_claim(7, settled_event());
    let mut pending = SequentialAccountEngine::apply(
        &base,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&base, &raw)),
    )
    .expect("pending")
    .committed()
    .expect("pending candidate");
    pending.set_settlement_workspace_present(true);
    let root = pending.state().carried().left_pending_j_claims.root;
    let error = SequentialAccountEngine::apply(
        &pending,
        Side::Right,
        &AccountTx::JEventClaim(prepare(&pending, &raw)),
    )
    .err()
    .expect("workspace activation is intentionally unsupported");
    assert!(
        error
            .to_string()
            .contains("ACCOUNT_J_CLAIM_SETTLEMENT_WORKSPACE_UNSUPPORTED")
    );
    assert_eq!(pending.state().carried().left_pending_j_claims.root, root);
    assert!(
        pending
            .state()
            .delta(TokenId::new(1).expect("token"))
            .is_none()
    );
}

#[test]
fn process_wire_event_vectors_have_exact_events_hashes() {
    let minimal = JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: Some(43),
            block_hash: Some(bytes(0xcc)),
            transaction_hash: Some(bytes(0xdd)),
            log_index: Some(1),
            event_index: None,
        },
        left_entity: entity(0xaa),
        right_entity: entity(0xbb),
        token_id: TokenId::new(1).expect("token"),
        left_reserve: 0.into(),
        right_reserve: BigInt::from(1_999_999_000_000_i64),
        collateral: 1_000_000.into(),
        ondelta: 0.into(),
        nonce: 0,
    });
    assert_eq!(
        hex::encode(canonical_events_hash(&[minimal]).expect("minimal hash")),
        "9d3d69db1a897eb444ebffc7f811dc5f582e8c8126be33803455ec0bf2eb9f9d"
    );
    let full = JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: Some(44),
            block_hash: Some(bytes(0xdd)),
            transaction_hash: Some(bytes(0xcc)),
            log_index: Some(2),
            event_index: Some(3),
        },
        left_entity: entity(0xaa),
        right_entity: entity(0xbb),
        token_id: TokenId::new(2).expect("token"),
        left_reserve: 7.into(),
        right_reserve: 9.into(),
        collateral: 11.into(),
        ondelta: (-13).into(),
        nonce: 5,
    });
    assert_eq!(
        hex::encode(canonical_events_hash(&[full]).expect("full hash")),
        "816e10ad7e0ae81d40f6559866680f4e9a24b016c8a9f69d0f6b7ecfd6a03204"
    );
}

#[test]
fn patricia_root_is_insertion_order_independent_and_finality_prunes_history() {
    let build = |heights: &[u64]| {
        let mut current = replica();
        for height in heights {
            let raw = raw_claim(*height, settled_event());
            current = SequentialAccountEngine::apply(
                &current,
                Side::Left,
                &AccountTx::JEventClaim(prepare(&current, &raw)),
            )
            .expect("pending claim")
            .committed()
            .expect("pending candidate");
        }
        current
    };
    let ordered = build(&[2, 5, 9]);
    let shuffled = build(&[9, 2, 5]);
    assert_eq!(
        ordered.state().carried().left_pending_j_claims,
        shuffled.state().carried().left_pending_j_claims
    );
    assert_eq!(ordered.state().carried().left_pending_j_claims.count, 3);
    assert_eq!(
        hex::encode(ordered.state().carried().left_pending_j_claims.root),
        "b5165b968b78ea20b6396a7bc54af63b4b22903d33011a041af11ce6006f05c6"
    );

    let raw = raw_claim(9, settled_event());
    let finalized = SequentialAccountEngine::apply(
        &ordered,
        Side::Right,
        &AccountTx::JEventClaim(prepare(&ordered, &raw)),
    )
    .expect("peer finality")
    .committed()
    .expect("final candidate");
    assert_eq!(finalized.state().carried().left_pending_j_claims.count, 0);
    assert_eq!(finalized.state().j_claim_node_entries().len(), 0);
}

#[test]
fn nonempty_root_never_accepts_a_missing_witness() {
    let base = replica();
    let raw = raw_claim(7, settled_event());
    let pending = SequentialAccountEngine::apply(
        &base,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&base, &raw)),
    )
    .expect("pending")
    .committed()
    .expect("candidate");
    let mut malformed = prepare(&pending, &raw);
    malformed.left_proof = None;
    let error =
        SequentialAccountEngine::apply(&pending, Side::Right, &AccountTx::JEventClaim(malformed))
            .err()
            .expect("missing member witness must fail");
    assert!(
        error
            .to_string()
            .contains("ACCOUNT_J_CLAIM_PROOF_REQUIRED:left")
    );
    assert_eq!(pending.state().carried().left_pending_j_claims.count, 1);
}

#[test]
fn failed_node_store_restore_is_atomic() {
    let base = replica();
    let raw = raw_claim(7, settled_event());
    let pending = SequentialAccountEngine::apply(
        &base,
        Side::Left,
        &AccountTx::JEventClaim(prepare(&base, &raw)),
    )
    .expect("pending")
    .committed()
    .expect("candidate");
    let original = pending.state().j_claim_node_entries();
    let mut corrupt = original.clone();
    corrupt[0].0[0] ^= 0xff;
    let mut restored = pending.clone();
    let error = restored
        .restore_j_claim_nodes(corrupt)
        .expect_err("corrupt node hash must fail");
    assert!(
        error
            .to_string()
            .contains("ACCOUNT_J_CLAIM_STORE_ENTRY_INVALID")
    );
    assert_eq!(restored.state().j_claim_node_entries(), original);
}
