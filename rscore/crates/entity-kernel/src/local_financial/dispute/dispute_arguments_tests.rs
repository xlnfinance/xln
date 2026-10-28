use super::*;
use ethabi::ethereum_types::U256;
use num_bigint::BigInt;
use sha3::{Digest, Keccak256};

fn hex(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn entry(secret: [u8; 32]) -> crate::PaybookEntry {
    crate::PaybookEntry {
        hashlock: hex(&Keccak256::digest(secret)),
        secret: Some(hex(&secret)),
        inbound_entity: Some(hex(&[0x22; 32])),
        outbound_entity: None,
        description: None,
        token_id: Some(1),
        amount: Some(BigInt::from(10)),
        started_at_ms: Some(1),
        originated: false,
        inbound_settled: false,
        outbound_settled: false,
        secret_ack_pending: false,
        secret_ack_started_at: None,
        secret_ack_deadline_at: None,
        pending_fee: None,
        created_timestamp: 1,
    }
}

#[test]
fn exact_body_secrets_match_typescript_and_refresh_from_frame_overlay() {
    let mut state = EntityStateSlice::empty(hex(&[0x11; 32]), 130_000);
    let mut paybook = PaybookChanges::default();
    // The secrets arrive after the retained draft, in this same Entity frame.
    for byte in [0x61, 0x62, 0x63] {
        paybook.put(entry([byte; 32])).unwrap();
    }
    let body = ProofBody {
        watch_seed: [0x33; 32],
        left_response_seconds: 10,
        right_response_seconds: 20,
        offdeltas: vec![BigInt::from(7)],
        token_ids: vec![U256::from(1)],
        transformers: [None, Some([0x62; 32]), Some([0x61; 32])]
            .into_iter()
            .map(|secret| crate::j_batch::TransformerClause {
                transformer_address: [0x44; 20],
                allowances: Vec::new(),
                encoded_batch: ethabi::encode(&[Token::Tuple(vec![
                    Token::Array(
                        secret
                            .into_iter()
                            .map(|secret| {
                                Token::Tuple(vec![
                                    Token::Uint(U256::zero()),
                                    Token::Tuple(vec![
                                        Token::Bool(false),
                                        Token::Uint(U256::from(10)),
                                    ]),
                                    Token::Uint(U256::from(1000)),
                                    Token::FixedBytes(Keccak256::digest(secret).to_vec()),
                                ])
                            })
                            .collect(),
                    ),
                    Token::Array(Vec::new()),
                    Token::Array(Vec::new()),
                    Token::Array(Vec::new()),
                ])]),
            })
            .collect(),
    };
    let existing = ethabi::encode(&[Token::Array(vec![
        Token::Bytes(argument_tuple(vec![123], Vec::new())),
        Token::Bytes(Vec::new()),
        Token::Bytes(Vec::new()),
    ])]);
    let peer = hex(&[0x22; 32]);
    let refreshed =
        refresh_dispute_secret_arguments(&body, &existing, &state, &paybook, &peer, [0x44; 20])
            .unwrap();
    assert_eq!(
        hex(&Keccak256::digest(&refreshed)),
        "0x157f569c5db44516a7aef6bfd416997ee3799dc9dd469eb11d2ff7950e987997"
    );
    assert_eq!(
        refresh_dispute_secret_arguments(&body, &refreshed, &state, &paybook, &peer, [0x44; 20])
            .unwrap(),
        refreshed
    );
    assert_eq!(
        refresh_dispute_secret_arguments(
            &body,
            &existing,
            &state,
            &paybook,
            &hex(&[0x55; 32]),
            [0x44; 20]
        )
        .unwrap(),
        existing
    );
    assert_eq!(
        refresh_dispute_secret_arguments(&body, &existing, &state, &paybook, &peer, [0x55; 20])
            .unwrap(),
        existing
    );

    let view = LocalAccountFinancialView {
        active: false,
        owner_side: xln_rscore_engine::Side::Left,
        owner_out_capacity: BTreeMap::new(),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: None,
        settlement_transition_pending: false,
        settlement_execution: Err("unused".into()),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pending_htlc_lock_ids: Default::default(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: Default::default(),
        dispute: Some(xln_rscore_batch::ResidentAccountDisputeView {
            status: "disputed".into(),
            dispute_prepare: None,
            active_dispute: None,
            local_dispute: None,
            pending_dispute: None,
            counterparty_dispute: None,
            proof_body: Err("N7 must never be consulted".into()),
            j_nonce: 0,
            owner_is_left: true,
            delta_transformer: Some([0x44; 20]),
            payment_hashlocks: Vec::new(),
            pull_ids: Vec::new(),
            pull_count: 0,
            swap_offers: Vec::new(),
            pending_swap_fill_ratios: BTreeMap::new(),
        }),
    };
    let views = BTreeMap::from([(peer, view)]);
    let proof = crate::j_batch::FinalDisputeProof {
        counterentity: [0x22; 32],
        initial_nonce: U256::from(8),
        final_nonce: U256::from(8),
        proposer_is_left: true,
        initial_proofbody_hash: crate::proof_body_hash(&body).unwrap(),
        final_proofbody: body,
        starter_arguments: Vec::new(),
        other_arguments: existing,
        sig: Vec::new(),
        started_by_left: false,
        cooperative: false,
        submit_not_before_timestamp: Some(130),
    };
    state.j_batch_state = Some(crate::JBatchState::default());
    state
        .j_batch_state
        .as_mut()
        .unwrap()
        .batch
        .dispute_finalizations
        .push(proof.clone());
    state.timestamp = 129_000;
    refresh_broadcast_dispute_arguments(&mut state, &paybook, &views).unwrap();
    assert_eq!(
        state
            .j_batch_state
            .as_ref()
            .unwrap()
            .batch
            .dispute_finalizations[0],
        proof
    );
    state.timestamp = 130_000;
    refresh_broadcast_dispute_arguments(&mut state, &paybook, &views).unwrap();
    assert_eq!(
        state
            .j_batch_state
            .as_ref()
            .unwrap()
            .batch
            .dispute_finalizations[0]
            .other_arguments,
        refreshed
    );
    let batch = state.j_batch_state.as_mut().unwrap();
    batch.batch.dispute_finalizations[0] = proof;
    batch
        .recovery_batches
        .push(std::mem::take(&mut batch.batch));
    refresh_broadcast_dispute_arguments(&mut state, &paybook, &views).unwrap();
    let batch = state.j_batch_state.as_ref().unwrap();
    assert_eq!(
        batch.recovery_batches[0].dispute_finalizations[0].other_arguments,
        refreshed
    );
    assert!(
        batch.recovery_batches[0].dispute_finalizations[0]
            .starter_arguments
            .is_empty()
    );
}
