use super::super::local_profiles::LocalProfilePublication;
use super::*;
use crate::signed_profile::ProfileTransportIdentity;

#[test]
fn local_profile_projection_uses_changed_owner_and_account_evidence_only() {
    let mut replica = processor_replica();
    let key = entity_key(&replica);
    replica
        .state
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity
        .profile
        .name = "Committed owner".into();
    let input = direct_payment_input(&replica);
    let mut applied = crate::apply_runtime(replica, input).unwrap();
    let mut ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SOURCE_SEED,
        SOURCE_SIGNER,
    ))
    .unwrap();
    let mut publication = LocalProfilePublication {
        identity: ProfileTransportIdentity {
            runtime_id: ingress.runtime_id().into(),
            runtime_encryption_public_key: ingress.encryption_public_key(),
            ws_url: format!("ws://{}/ws", ingress.local_address()),
        },
        fees: BTreeMap::new(),
        sessions: ingress.sessions(),
        signed: BTreeMap::new(),
    };
    let (_, rows) = publication.changed(&mut applied).unwrap();
    assert_eq!(rows.len(), 1);
    let verified =
        super::super::profile_route::verify_profile_route(&rows[0], ingress.runtime_id(), None)
            .unwrap();
    assert_eq!(verified.entity_id, hex(&key.entity_id));
    assert_eq!(verified.last_updated, applied.replica.state.timestamp);
    // Account-only dirty evidence still refreshes the owner's signed capacities.
    applied.outputs.touches.entity_ids.clear();
    applied.outputs.touches.accounts = vec![crate::RuntimeTouchedAccount {
        entity_id: hex(&key.entity_id),
        counterparty_id: format!("0x{}", "ff".repeat(32)),
    }];
    assert_eq!(publication.changed(&mut applied).unwrap().1, rows);
    // Startup/recovery derives the same public row from the latest state, without WAL history.
    assert_eq!(
        publication
            .project(&mut applied.replica, vec![key])
            .unwrap()
            .1,
        rows
    );
    applied.outputs.touches.accounts.clear();
    assert!(publication.changed(&mut applied).unwrap().1.is_empty());
    // Real Account envelope projection changes at an identical committed clock.
    let mut pinned = processor_replica_with_pinned_peer(
        ENTITY_SEED,
        SOURCE_SEED,
        EntityId::parse(&format!("0x{}", "ff".repeat(32))).unwrap(),
        true,
    );
    let key = entity_key(&pinned);
    pinned.state.timestamp = applied.replica.state.timestamp;
    pinned
        .state
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity
        .profile
        .name = "Committed owner".into();
    let (_, changed) = publication.project(&mut pinned, vec![key.clone()]).unwrap();
    assert_ne!(rows[0]["accounts"], changed[0]["accounts"]);
    let next =
        super::super::profile_route::verify_profile_route(&changed[0], ingress.runtime_id(), None)
            .unwrap();
    assert_eq!(next.last_updated, verified.last_updated + 1);
    assert_eq!(pinned.state.timestamp, applied.replica.state.timestamp);
    assert_eq!(
        publication.project(&mut pinned, vec![key]).unwrap().1,
        changed
    );
    ingress.shutdown().unwrap();
}
