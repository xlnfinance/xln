use super::*;

fn vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/runtime-adapter-auth-v1.json"
    ))
    .unwrap()
}
fn config(fixture: &Value) -> AdapterAuthConfig {
    AdapterAuthConfig::new(
        fixture["authSeed"].as_str().unwrap().into(),
        fixture["runtimeSeed"].as_str().unwrap(),
        fixture["runtimeId"].as_str().unwrap(),
        None,
        86_400_000,
    )
    .unwrap()
}
fn request(fixture: &Value, row: &Value) -> Value {
    json!({"key":row["token"],"challenge":fixture["challenge"]})
}
#[test]
fn canonical_ts_capability_identity_and_owner_vectors_are_exact() {
    let fixture = vector();
    let config = config(&fixture);
    let now = fixture["now"].as_u64().unwrap();
    for row in fixture["vectors"].as_array().unwrap() {
        let request = request(&fixture, row);
        let session = authenticate(&config, &request, now, &BTreeSet::new()).unwrap();
        assert_eq!(
            session.level,
            row["verification"]["level"].as_str().unwrap()
        );
        assert_eq!(session.lane_id, row["laneId"].as_str().unwrap());
        assert_eq!(session.identity_proof, row["identity"]);
        assert_eq!(session.expires_at_ms, fixture["expiresAtMs"].as_u64());
        for signature in ["ownerSignature", "ownerCompactSignature"] {
            let mut owner = request.clone();
            owner["ownerSignature"] = row[signature].clone();
            let session = authenticate(&config, &owner, now, &BTreeSet::new()).unwrap();
            assert_eq!(session.lane_kind, "owner");
            assert_eq!(session.lane_id, row["ownerLaneId"].as_str().unwrap());
            assert_eq!(session.expires_at_ms, fixture["expiresAtMs"].as_u64());
        }
    }
}
#[test]
fn rejects_expiry_wrong_audience_revocation_tampering_and_retired_credentials() {
    let fixture = vector();
    let mut config = config(&fixture);
    let row = &fixture["vectors"][1];
    let request = request(&fixture, row);
    let now = fixture["now"].as_u64().unwrap();
    assert!(
        authenticate(
            &config,
            &request,
            fixture["expiresAtMs"].as_u64().unwrap(),
            &BTreeSet::new()
        )
        .is_err()
    );
    config.max_ttl_ms = 1;
    assert!(authenticate(&config, &request, now, &BTreeSet::new()).is_err());
    config.max_ttl_ms = 86_400_000;
    let revoked = BTreeSet::from([fixture["tokenId"].as_str().unwrap().to_string()]);
    assert!(authenticate(&config, &request, now, &revoked).is_err());
    // Re-authentication reads the current policy: removing a revocation restores access.
    assert!(authenticate(&config, &request, now, &BTreeSet::new()).is_ok());
    config.audience = "another-runtime".into();
    assert!(authenticate(&config, &request, now, &BTreeSet::new()).is_err());
    config.audience = fixture["runtimeId"].as_str().unwrap().into();
    for token in [
        "old-static-key".into(),
        "xlnra1.full.9999999999999.deadbeef".into(),
        format!("{}x", row["token"].as_str().unwrap()),
    ] {
        let mut bad = request.clone();
        bad["key"] = json!(token);
        assert!(authenticate(&config, &bad, now, &BTreeSet::new()).is_err());
    }
}
#[test]
fn invalid_owner_never_downgrades_and_identity_is_bound_to_local_seed() {
    let fixture = vector();
    let config = config(&fixture);
    let row = &fixture["vectors"][1];
    let mut request = request(&fixture, row);
    let now = fixture["now"].as_u64().unwrap();
    request["ownerSignature"] = row["ownerSignature"].clone();
    request["challenge"] = json!(format!("0x{}", "cd".repeat(32)));
    assert!(authenticate(&config, &request, now, &BTreeSet::new()).is_err());
    request["challenge"] = json!("bad-challenge");
    assert!(authenticate(&config, &request, now, &BTreeSet::new()).is_err());
    assert!(
        AdapterAuthConfig::new(
            fixture["authSeed"].as_str().unwrap().into(),
            "different-seed",
            fixture["runtimeId"].as_str().unwrap(),
            None,
            86_400_000,
        )
        .is_err()
    );
}

#[test]
fn http_operator_requires_live_admin_capability_bound_to_this_runtime() {
    let fixture = vector();
    let mut config = config(&fixture);
    let now = fixture["now"].as_u64().unwrap();
    for row in fixture["vectors"].as_array().unwrap() {
        let token = row["token"].as_str().unwrap();
        assert_eq!(
            authorize_http_admin(&config, token, now).is_ok(),
            row["verification"]["level"] == "admin"
        );
        assert!(
            authorize_http_admin(&config, token, fixture["expiresAtMs"].as_u64().unwrap()).is_err()
        );
    }
    let token = fixture["vectors"][1]["token"].as_str().unwrap();
    config.audience = "other-runtime".into();
    assert!(authorize_http_admin(&config, token, now).is_err());
    assert!(authorize_http_admin(&config, "", now).is_err());
}
