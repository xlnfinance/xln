use super::auth::AdapterAuthConfig;
use serde_json::Value;
use std::io::Read;

/// The existing managed-child private stdin pipe remains the only inherited
/// secret channel. Never publish capability seeds in argv, environment or WAL.
pub fn inherited_auth(
    runtime_seed: &str,
    runtime_id: &str,
) -> Result<Option<AdapterAuthConfig>, String> {
    let Ok(fd) = std::env::var("XLN_CHILD_SECRET_FD") else {
        return Ok(None);
    };
    if fd.trim() != "0" {
        return Err("CHILD_SECRET_FD_INVALID".into());
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("CHILD_SECRET_READ:{e}"))?;
    if bytes.is_empty() || bytes.len() > 65536 {
        return Err("CHILD_SECRET_PAYLOAD_SIZE_INVALID".into());
    }
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| "CHILD_SECRET_PAYLOAD_INVALID")?;
    let inherited = payload["runtimeSeed"]
        .as_str()
        .ok_or("CHILD_SECRET_RUNTIME_SEED_MISSING")?
        .trim();
    if inherited != runtime_seed {
        return Err("CHILD_SECRET_SOURCE_CONFLICT:runtimeSeed".into());
    }
    let seed = payload["radapterAuthSeed"]
        .as_str()
        .ok_or("CHILD_SECRET_AUTH_SEED_MISSING")?
        .trim();
    if seed.is_empty() {
        return Err("RADAPTER_AUTH_SEED_REQUIRED".into());
    }
    let truthy = |name| {
        matches!(
            std::env::var(name)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "1" | "true" | "yes" | "on"
        )
    };
    let strong = std::env::var("NODE_ENV")
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("production")
        || truthy("XLN_RADAPTER_REQUIRE_STRONG_AUTH_SEED");
    let positive = |name, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n > 0.0)
            .map(|n| n.floor() as u64)
            .unwrap_or(default)
    };
    if strong && seed.len() < positive("XLN_RADAPTER_AUTH_SEED_MIN_BYTES", 32) as usize {
        return Err("RADAPTER_AUTH_SEED_TOO_WEAK".into());
    }
    let ttl = positive("XLN_RADAPTER_TOKEN_MAX_TTL_MS", 86_400_000);
    let audience = std::env::var("XLN_RADAPTER_AUDIENCE").ok();
    AdapterAuthConfig::new(
        seed.into(),
        runtime_seed,
        runtime_id,
        audience.as_deref(),
        ttl,
    )
    .map(Some)
}

/// The decoder expands each operator base over committed J names, as native restart does.
/// Passing genesis sibling labels here would expand `base:Tron` twice and must reject.
pub fn history_configuration(
    runtime_seed: &str,
    primary_label: &str,
    workers: usize,
) -> xln_rscore_runtime::restore::ConcreteCheckpointConfiguration {
    xln_rscore_runtime::restore::ConcreteCheckpointConfiguration {
        runtime_seed: runtime_seed.into(),
        custody_import_keys: std::collections::BTreeMap::new(),
        signer_derivation_labels: vec![primary_label.into()],
        worker_count: workers,
        limits: xln_rscore_runtime::RuntimeLimits::hlt(),
        swap_market: std::sync::Arc::new(xln_rscore_runtime::canonical_swap_market_policy()),
        expected_protocol_fingerprint: crate::PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        board_delays: xln_rscore_engine::BoardDelays::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_configuration_restores_real_dual_j_genesis_without_duplicate_expansion() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/native-cross-genesis-v1.json"
        ))
        .unwrap();
        let seed = fixture["seed"].as_str().unwrap();
        let label = fixture["entitySignerLabel"].as_str().unwrap();
        let path =
            std::env::temp_dir().join(format!("native-history-dual-j-{}", std::process::id()));
        let mut ready = crate::native_genesis::create_native_genesis_runtime_processor(
            &path,
            crate::native_genesis::NativeGenesisConfig::decode(&fixture["genesis"]).unwrap(),
            seed,
            fixture["runtimeSignerLabel"].as_str().unwrap(),
            label,
            1,
            xln_rscore_runtime::processor::EntityRouteTable::new([]).unwrap(),
        )
        .unwrap();
        let (signers, _) = ready.processor.operator_signer_material(None).unwrap();
        assert_eq!(
            signers.len(),
            2,
            "fresh dual-J owners retain operator signing custody"
        );
        for owner in fixture["expectedOwners"].as_array().unwrap() {
            let signer = owner["signerId"].as_str().unwrap();
            assert!(signers.contains(&signer.to_string()));
            let (_, key) = ready
                .processor
                .operator_signer_material(Some(signer))
                .unwrap();
            assert_eq!(
                format!(
                    "0x{}",
                    hex::encode(xln_rscore_crypto::address_of_private_key(&key.unwrap()).unwrap())
                ),
                signer
            );
        }
        assert!(
            ready
                .processor
                .operator_signer_material(Some(&format!("0x{}", "ff".repeat(20))))
                .is_err()
        );
        ready
            .processor
            .process_live(
                xln_rscore_runtime::RuntimeLiveInput {
                    runtime_txs: vec![],
                    entity_inputs: vec![xln_rscore_runtime::RuntimeEntityInput::decode(serde_json::json!({
                        "entityId":fixture["expectedOwners"][0]["entityId"], "signerId":fixture["expectedOwners"][0]["signerId"],
                        "entityTxs":[{"type":"chat","data":{"from":fixture["expectedOwners"][0]["signerId"],"message":"historical dual-J"}}]
                    })).unwrap()],
                    timestamp: 1,
                    finalized_j_height: 0,
                },
                &mut xln_rscore_runtime::CanonicalEntityInfraMaterializer::new(),
            )
            .unwrap();
        let sources = ready.processor.adapter_restore_sources().unwrap();
        let restored = crate::runtime_adapter::history::restore::reconstruct_at_height(
            sources,
            history_configuration(seed, label, 1),
            1,
        )
        .unwrap();
        assert_eq!(restored.replica.state.e_replicas.len(), 2);
        assert_eq!(
            restored.replica.state.e_replicas.keys().collect::<Vec<_>>(),
            ready
                .processor
                .replica()
                .unwrap()
                .state
                .e_replicas
                .keys()
                .collect::<Vec<_>>()
        );
        drop(ready);
        std::fs::remove_dir_all(path).unwrap();
    }
}
