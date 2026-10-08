#[path = "origin_invalid_hashlock.rs"]
mod invalid;
#[path = "origin_empty_route_replay.rs"]
mod replay;
use super::*;
use crate::InboundHtlcInfrastructure;
use crate::signed_profile::{ProfileTransportIdentity, signed_entity_profile};
use replay::assert_reopened_exact_replay;
use x25519_dalek::{PublicKey, StaticSecret};

fn profile(replica: &mut RuntimeReplica, ingress: &DirectRuntimeIngress) -> Value {
    let key = entity_key(replica);
    let state = &replica.state.e_replicas[&key];
    let live = replica.e_replicas.get_mut(&key).unwrap();
    let rows = live
        .accounts
        .read_account_views(
            crate::signed_profile_accounts::account_ids(state).unwrap(),
            crate::signed_profile_accounts::project_account,
        )
        .unwrap();
    signed_entity_profile(
        state,
        live,
        100,
        &ProfileTransportIdentity {
            runtime_id: ingress.runtime_id().into(),
            runtime_encryption_public_key: ingress.encryption_public_key(),
            ws_url: format!("ws://{}/ws", ingress.local_address()),
        },
        1,
        &BigInt::from(0),
        rows,
    )
    .unwrap()
}
fn service(
    mut replica: RuntimeReplica,
    ingress: DirectRuntimeIngress,
    directory: &std::path::Path,
    seed: &str,
    peer: &Value,
    private: [u8; 32],
    route: EntityRoute,
) -> ResidentRuntimeService {
    let key = entity_key(&replica);
    let public = *PublicKey::from(&StaticSecret::from(private)).as_bytes();
    replica
        .state
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity
        .entity_encryption_public_key = public;
    // Canonical no-import keyring: this fixture's sole owner uses the configured
    // HTLC keypair; no imported custody seed is needed.
    replica.durable.infrastructure_mut()["entityEncryptionSeeds"] =
        json!({"__xlnType":"Map", "value":[]});
    replica.durable.invalidate_infrastructure_digest();
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        NativeRuntimeStore::open(directory, NativeStorageConfig::default()).unwrap(),
        EntityRouteTable::new([route]).unwrap(),
        seed,
        RuntimeSignerLabel::new(SOURCE_SIGNER).unwrap(),
    )
    .unwrap();
    processor
        .configure_local_profiles(
            ProfileTransportIdentity {
                runtime_id: ingress.runtime_id().into(),
                runtime_encryption_public_key: ingress.encryption_public_key(),
                ws_url: format!("ws://{}/ws", ingress.local_address()),
            },
            BTreeMap::from([(key, (1, BigInt::from(0)))]),
            ingress.sessions(),
        )
        .unwrap();
    processor
        .admit_authenticated_profile(peer["runtimeId"].as_str().unwrap(), peer)
        .unwrap();
    ResidentRuntimeService::new(
        processor,
        ingress,
        Box::new(
            CanonicalEntityInfraMaterializer::with_inbound_htlc(InboundHtlcInfrastructure {
                entity_encryption_public_key: public,
                entity_encryption_private_key: private,
                routing_fee_ppm: 1,
                routing_base_fee: 0.into(),
            })
            .unwrap(),
        ),
    )
    .unwrap()
}
#[test]
fn real_two_runtime_empty_route_htlc_commits_and_replays() {
    run_empty_route_payments(None);
}

fn run_empty_route_payments(reject_between: Option<&str>) {
    let directory = path();
    let peer_seed = hex(&[0x7b; 32]);
    let (a_seed, b_seed) = ("rrs-origin-a", "rrs-origin-b");
    let (a_id, b_id) = (
        signing_entity_id(ENTITY_SEED),
        signing_entity_id(&peer_seed),
    );
    let mut a_replica = processor_replica_with_pinned_peer(ENTITY_SEED, a_seed, b_id.clone(), true);
    let mut b_replica = processor_replica_with_pinned_peer(&peer_seed, b_seed, a_id.clone(), true);
    let (a_key, b_key) = (entity_key(&a_replica), entity_key(&b_replica));
    for (replica, key, private) in [
        (&mut a_replica, &a_key, [3; 32]),
        (&mut b_replica, &b_key, [4; 32]),
    ] {
        replica
            .state
            .e_replicas
            .get_mut(key)
            .unwrap()
            .entity
            .entity_encryption_public_key =
            *PublicKey::from(&StaticSecret::from(private)).as_bytes();
    }
    let bind = |seed| {
        DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            seed,
            SOURCE_SIGNER,
        ))
        .unwrap()
    };
    let (a_ingress, b_ingress) = (bind(a_seed), bind(b_seed));
    let (a_profile, b_profile) = (
        profile(&mut a_replica, &a_ingress),
        profile(&mut b_replica, &b_ingress),
    );
    let a_route = EntityRoute {
        target_entity_id: b_id.as_hex(),
        target_runtime_id: b_profile["runtimeId"].as_str().unwrap().into(),
        target_signer_id: b_key.signer_id.clone(),
        websocket_url: Some(b_profile["wsUrl"].as_str().unwrap().into()),
    };
    let b_route = EntityRoute {
        target_entity_id: a_id.as_hex(),
        target_runtime_id: a_profile["runtimeId"].as_str().unwrap().into(),
        target_signer_id: a_key.signer_id.clone(),
        websocket_url: None,
    };
    let mut a = service(
        a_replica,
        a_ingress,
        &directory.join("a"),
        a_seed,
        &b_profile,
        [3; 32],
        a_route.clone(),
    );
    let mut b = service(
        b_replica,
        b_ingress,
        &directory.join("b"),
        b_seed,
        &a_profile,
        [4; 32],
        b_route.clone(),
    );
    let payment = json!({"entityId":a_id.as_hex(),"signerId":a_key.signer_id,
        "entityTxs":[{"type":"htlcPayment","data":{"targetEntityId":b_id.as_hex(),"tokenId":1,
        "amount":{"__xlnType":"BigInt","value":"7"},"maxSenderDebit":{"__xlnType":"BigInt","value":"7"},
        "route":[],"deliveryMode":"instant"}}]});
    let tx = RuntimeEntityInput::decode(payment.clone()).unwrap();
    let mut second_origin_height = 0;
    for round in 1..=2 {
        if round == 2
            && let Some(case) = reject_between
        {
            invalid::reject_bad_origin(&mut a, &a_key, &payment, case);
        }
        let admitted = a
            .process_local_entity_inputs(vec![tx.clone()])
            .expect("real raw empty-route origin")
            .unwrap();
        second_origin_height = admitted.commitments.unwrap().height;
        a.sync_committed().unwrap();
        let token = TokenId::new(1).unwrap();
        let expected = BigInt::from(if a_id.as_bytes() < b_id.as_bytes() {
            -7 * round
        } else {
            7 * round
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            a.process_next(std::time::Duration::from_millis(2)).unwrap();
            b.process_next(std::time::Duration::from_millis(2)).unwrap();
            a.sync_committed().unwrap();
            b.sync_committed().unwrap();
            let a_state = a
                .account_status(&a_key, AccountId::from_bytes(*b_id.as_bytes()), vec![token])
                .unwrap()
                .unwrap();
            let b_state = b
                .account_status(&b_key, AccountId::from_bytes(*a_id.as_bytes()), vec![token])
                .unwrap()
                .unwrap();
            if a_state.tokens[&token].as_ref().unwrap().offdelta() == &expected
                && a_state.tokens == b_state.tokens
                && a_state.pending_frame_height.is_none()
                && b_state.pending_frame_height.is_none()
                && a_state.mempool_len == 0
                && b_state.mempool_len == 0
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "HTLC must settle on both real Runtime sockets"
            );
        }
    }
    assert!(second_origin_height > 1);
    let a_root = entity_state(a.processor().replica().unwrap()).accounts_root;
    let b_root = entity_state(b.processor().replica().unwrap()).accounts_root;
    a.shutdown().unwrap();
    b.shutdown().unwrap();
    drop(a);
    drop(b);
    eprintln!("EMPTY_ROUTE_WAL={}", directory.display());
    assert_reopened_exact_replay(
        &directory.join("a"),
        a_seed,
        ENTITY_SEED,
        EntityRouteTable::new([a_route]).unwrap(),
        a_root,
        Some(second_origin_height),
    );
    assert_reopened_exact_replay(
        &directory.join("b"),
        b_seed,
        &peer_seed,
        EntityRouteTable::new([b_route]).unwrap(),
        b_root,
        None,
    );
}
