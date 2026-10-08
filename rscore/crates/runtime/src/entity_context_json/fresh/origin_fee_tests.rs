use super::*;

#[test]
fn captured_multihop_prepare_rejects_fee_above_sender_limit() {
    let profiles: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../../core/__tests__/fixtures/pathfinding/three-hub-live-profiles.json"
    ))
    .unwrap();
    let ids = profiles
        .iter()
        .map(|p| p["entityId"].as_str().unwrap())
        .collect::<Vec<_>>();
    let mut runtime = crate::machine::tests::replica(crate::RuntimeLimits::hlt()).unwrap();
    let key = runtime.state.e_replicas.keys().next().unwrap().clone();
    let state = &runtime.state.e_replicas[&key];
    let source = state.entity.entity_id.clone();
    let mut tx = HtlcPaymentEntityTx {
        target_entity_id: ids[1].into(),
        token_id: xln_rscore_engine::TokenId::new(1).unwrap(),
        amount: 25_000_000.into(),
        max_sender_debit: 25_000_074.into(),
        route: vec![
            source.clone(),
            ids[2].into(),
            ids[3].into(),
            ids[4].into(),
            ids[1].into(),
        ],
        description: None,
        delivery_mode: OriginatedHtlcDeliveryMode::Instant,
        started_at_ms: None,
        hashlock: None,
        tx_hash: "captured-fee-limit".into(),
    };
    let mut quoted = tx.amount.clone();
    for pair in tx.route[1..].windows(2).rev() {
        quoted = required_inbound(&profiles, &pair[0], &pair[1], 1, &quoted).unwrap();
    }
    assert_eq!(quoted, BigInt::from(25_000_075));
    assert!(tx.amount <= tx.max_sender_debit);
    let mut request = EntityInfraMaterializeRequest {
        entity_encryption_seed: None,
        state,
        replica: runtime.e_replicas.get_mut(&key).unwrap(),
        account_inputs: &[],
        local_financial_txs: &[],
        originated_j_heights: &BTreeMap::new(),
        timestamp: 101,
        finalized_j_height: 7,
    };
    let error = prepare(&tx, &mut request, &profiles).expect_err("over-limit quote rejected");
    assert!(
        matches!(
            error,
            FreshEntityContextError::OriginRejected("MAX_SENDER_DEBIT_EXCEEDED")
        ),
        "{error}"
    );
    // Exact-limit input passes the fee gate. This fixture deliberately lacks
    // the source routing profile: that infrastructure error must remain fatal,
    // rather than being mislabeled as a sender rejection. No full-route success
    // is claimed by this focused captured-quote boundary.
    tx.max_sender_debit = quoted;
    assert!(matches!(
        prepare(&tx, &mut request, &profiles),
        Err(FreshEntityContextError::HtlcInfrastructureInvalid(reason))
            if reason == format!("ORIGIN:PROFILE_MISSING:{source}")
    ));
}
