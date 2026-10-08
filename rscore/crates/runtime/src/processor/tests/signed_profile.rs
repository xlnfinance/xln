use super::*;
use crate::signed_profile::{ProfileTransportIdentity, signed_entity_profile};

#[test]
fn owned_profile_projection_preserves_bytes_and_verifies_real_signatures() {
    let mut replica = processor_replica();
    let key = entity_key(&replica);
    let state = replica.state.e_replicas.get_mut(&key).unwrap();
    state.entity.profile.name = "Owned profile".into();
    let transport = ProfileTransportIdentity {
        runtime_id: derive_local_runtime_id(SOURCE_SEED, SOURCE_SIGNER).unwrap(),
        runtime_encryption_public_key: format!("0x{}", "44".repeat(32)),
        ws_url: "ws://127.0.0.1:8080/ws".into(),
    };
    let state = &replica.state.e_replicas[&key];
    let live = &replica.e_replicas[&key];
    let profile = signed_entity_profile(
        state,
        live,
        100,
        &transport,
        1000,
        &BigInt::from(7),
        Vec::new(),
    )
    .unwrap();
    let verified =
        super::super::profile_route::verify_profile_route(&profile, &transport.runtime_id, None)
            .unwrap();
    assert_eq!(verified.entity_id, state.entity.entity_id);
    assert_eq!(verified.signer_id, key.signer_id);
    assert_eq!(profile["metadata"]["baseFee"]["value"], "7");
    let bytes = serde_json::to_vec(&profile).unwrap();
    use sha3::{Digest, Keccak256};
    assert_eq!(
        hex(&Keccak256::digest(&bytes)),
        "0x4ae43c518807cd642a0b156ec0b15ab924ae66c7e3f603ae10b8d41fc71e11c3"
    );
    let repeated = signed_entity_profile(
        state,
        live,
        100,
        &transport,
        1000,
        &BigInt::from(7),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(bytes, serde_json::to_vec(&repeated).unwrap());
    for field in ["name", "wsUrl"] {
        let mut forged = profile.clone();
        forged[field] = Value::String("forged".into());
        assert!(
            super::super::profile_route::verify_profile_route(&forged, &transport.runtime_id, None)
                .is_err()
        );
    }
}

#[test]
fn pinned_account_profile_signs_domain_and_private_floored_liquidity() {
    use crate::signed_profile_accounts::project_account;
    use xln_rscore_engine::{AccountConsensus, AccountEnvelope};
    let mut replica = processor_replica();
    let key = entity_key(&replica);
    replica
        .state
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity
        .profile
        .name = "Pinned owner".into();
    let owner = EntityId::parse(&hex(&key.entity_id)).unwrap();
    let peer = EntityId::parse(&format!("0x{}", "ff".repeat(32))).unwrap();
    let identity = AccountIdentity::new(
        AccountDomain::new(
            31337,
            DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).unwrap(),
        )
        .unwrap(),
        owner.clone(),
        peer.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).unwrap(),
    )
    .unwrap();
    let deltas = (1..=18)
        .map(|token| {
            Delta::new(
                TokenId::new(token).unwrap(),
                BigInt::from(2_000_999),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(1_000_999),
                BigInt::from(1_000_999),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
            )
            .unwrap()
        })
        .collect();
    let state =
        AccountState::new(identity, AccountDisputeConfig::new(10, 10).unwrap(), deltas).unwrap();
    let mut account = AccountReplica::new(owner, state).unwrap();
    assert_eq!(
        project_account(&AccountConsensus::new(account.clone())).unwrap(),
        CanonicalValue::Null
    );
    account.set_envelope(
        AccountEnvelope::new(
            vec![("publicPinned".into(), CanonicalValue::Bool(true))],
            Vec::new(),
        )
        .unwrap(),
    );
    let row = project_account(&AccountConsensus::new(account)).unwrap();
    let transport = ProfileTransportIdentity {
        runtime_id: derive_local_runtime_id(SOURCE_SEED, SOURCE_SIGNER).unwrap(),
        runtime_encryption_public_key: format!("0x{}", "44".repeat(32)),
        ws_url: "ws://127.0.0.1:8080/ws".into(),
    };
    let profile = signed_entity_profile(
        &replica.state.e_replicas[&key],
        &replica.e_replicas[&key],
        100,
        &transport,
        1,
        &BigInt::from(0),
        vec![(AccountId::from_bytes(*peer.as_bytes()), row)],
    )
    .unwrap();
    super::super::profile_route::verify_profile_route(&profile, &transport.runtime_id, None)
        .unwrap();
    let advertised = &profile["accounts"][0];
    assert_eq!(advertised["counterpartyId"], peer.as_hex());
    assert_eq!(advertised["domain"]["chainId"], 31337);
    assert_eq!(
        advertised["domain"]["depositoryAddress"],
        format!("0x{}", "88".repeat(20))
    );
    let capacities = advertised["tokenCapacities"].as_object().unwrap();
    assert_eq!(capacities.len(), 16);
    assert_eq!(capacities["1"]["inCapacity"]["value"], "3001000");
    assert_eq!(capacities["1"]["outCapacity"]["value"], "1000000");
    assert!(!capacities.contains_key("17"));
    assert!(!capacities.contains_key("18"));
    for value in capacities.values() {
        for field in ["inCapacity", "outCapacity"] {
            let amount = value[field]["value"]
                .as_str()
                .unwrap()
                .parse::<BigInt>()
                .unwrap();
            assert_eq!(amount % 1000, BigInt::from(0));
        }
    }
    assert_eq!(profile["publicAccounts"], json!([peer.as_hex()]));
    let mut forged = profile.clone();
    forged["accounts"][0]["domain"]["chainId"] = json!(31338);
    assert!(
        super::super::profile_route::verify_profile_route(&forged, &transport.runtime_id, None)
            .is_err()
    );
}
