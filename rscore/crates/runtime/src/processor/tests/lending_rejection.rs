use super::*;

fn apply(
    replica: RuntimeReplica,
    inputs: Vec<RuntimeEntityInput>,
    timestamp: u64,
) -> crate::RuntimeApplyResult {
    crate::apply_runtime_live(
        replica,
        RuntimeLiveInput {
            runtime_txs: vec![],
            entity_inputs: inputs,
            timestamp,
            finalized_j_height: 0,
        },
        &mut CanonicalEntityInfraMaterializer::new(),
    )
    .expect("sender rejection must preserve healthy work")
}

fn deliver(
    result: &crate::RuntimeApplyResult,
    destination: &RuntimeEntityKey,
) -> Vec<RuntimeEntityInput> {
    result
        .outputs
        .entities
        .iter()
        .flat_map(|entity| {
            super::super::output::encode_local_entity_outputs(
                entity.local_entity_outputs.clone(),
                &hex(&entity.entity_id),
                &entity.signer_id,
            )
            .expect("canonical signed outputs")
        })
        .filter(|output| {
            output["entityId"] == hex(&destination.entity_id)
                && !output["entityTxs"].as_array().unwrap().is_empty()
        })
        .map(|mut output| {
            output["signerId"] = json!(destination.signer_id);
            RuntimeEntityInput::decode(output).expect("real signed Account input")
        })
        .collect()
}

#[test]
fn mixed_payment_lending_request_commits_payment_and_signed_ack() {
    let peer_seed = hex(&[0x7b; 32]);
    let a_entity = signing_entity_id(ENTITY_SEED);
    let b_entity = signing_entity_id(&peer_seed);
    let sender = || processor_replica_with_peer(ENTITY_SEED, SOURCE_SEED, b_entity.clone());
    let receiver =
        || processor_replica_with_peer(&peer_seed, "lending-reject-peer", a_entity.clone());
    let a_key = entity_key(&sender());
    let b_key = entity_key(&receiver());
    let payment = direct_payment_input(&sender())
        .entity_inputs
        .remove(0)
        .canonical()
        .clone();
    let baseline = apply(
        sender(),
        vec![RuntimeEntityInput::decode(payment.clone()).unwrap()],
        200,
    );
    for kind in [
        "lendingOffer",
        "lendingBorrow",
        "lendingRepay",
        "lendingClosePosition",
        "lendingApprove",
        "lendingSetTerms",
    ] {
        for lending_first in [false, true] {
            let lending = json!({"entityId":payment["entityId"],"signerId":payment["signerId"],
                "entityTxs":[{"type":kind,"data":{"hubEntityId":b_entity.as_hex(),"tokenId":1,"amount":{"__xlnType":"BigInt","value":"3"}}}]});
            // One adapter request, separate commands: rejection may evict only
            // lending, never the authenticated signer's neighbouring payment.
            let inputs = if lending_first {
                vec![lending, payment.clone()]
            } else {
                vec![payment.clone(), lending]
            };
            let request = json!({"input":{"runtimeTxs":[],"entityInputs":inputs,"jInputs":[]}});
            let decoded = request["input"]["entityInputs"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .map(RuntimeEntityInput::decode)
                .collect::<Result<Vec<_>, _>>()
                .expect("mixed adapter request must decode before per-command eviction");
            let proposed = apply(sender(), decoded, 200);
            assert_eq!(proposed.outputs.entities.len(), 1, "{kind}");
            assert_eq!(
                proposed.outputs.entities[0].entity_frame_hash,
                baseline.outputs.entities[0].entity_frame_hash,
                "{kind}"
            );
            assert_eq!(
                proposed.replica.state.e_replicas[&a_key].entity,
                baseline.replica.state.e_replicas[&a_key].entity,
                "rejected command consumes no nonce: {kind}"
            );
            let accepted = apply(receiver(), deliver(&proposed, &b_key), 201);
            assert_eq!(
                accepted.account_commits.len(),
                1,
                "receiver commits payment: {kind}"
            );
            let ack = deliver(&accepted, &a_key);
            assert_eq!(ack.len(), 1, "one signed ACK: {kind}");
            let mut committed = apply(proposed.replica, ack, 202);
            assert_eq!(
                committed.account_commits.len(),
                1,
                "sender commits payment: {kind}"
            );
            let status = committed
                .replica
                .e_replicas
                .get_mut(&a_key)
                .unwrap()
                .accounts
                .account_status(
                    AccountId::from_bytes(*b_entity.as_bytes()),
                    vec![TokenId::new(1).unwrap()],
                )
                .unwrap()
                .unwrap();
            assert_eq!(status.current_height, 1, "{kind}");
            assert_eq!(status.pending_frame_height, None, "{kind}");
            assert_eq!(status.mempool_len, 0, "{kind}");
            let expected = BigInt::from(if a_entity.as_bytes() < b_entity.as_bytes() {
                -7
            } else {
                7
            });
            assert_eq!(
                status.tokens[&TokenId::new(1).unwrap()]
                    .as_ref()
                    .unwrap()
                    .offdelta(),
                &expected,
                "exact payment committed: {kind}"
            );
        }
    }
}
