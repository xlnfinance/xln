//! Exact native checkpoint + WAL restart into the production processor.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use num_bigint::BigInt;
use serde_json::Value;
use xln_rscore_engine::BoardDelays;
use xln_rscore_runtime::processor::EntityRouteTable;
use xln_rscore_runtime::restore::{
    ConcreteCheckpointConfiguration, MigrationOrigin, decode_concrete_runtime_checkpoint,
    decode_concrete_runtime_wal_frame, decode_offline_ts_import_checkpoint,
    load_native_restore_sources, reconcile_runtime_input_with_resident_queue,
    replay_decoded_runtime_wal, restore_decoded_runtime_checkpoint,
};
use xln_rscore_runtime::storage::native::{NativeRuntimeStore, NativeStorageConfig};
use xln_rscore_runtime::{
    DurableRuntimeProcessor, RuntimeLimits, RuntimeSignerLabel, canonical_swap_market_policy,
};

use crate::PAYMENT_PROFILE_BINDING;

pub struct NativeRuntimeReady {
    pub processor: DurableRuntimeProcessor,
    /// Restore-only diagnostics. They never enter Runtime state or storage.
    pub restore_elapsed: Duration,
    pub restored_wal_frames: usize,
    /// Static policy derived from the authenticated Entity checkpoint. It is
    /// used only to materialize each signed Entity context; financial state
    /// itself remains inside the resident replica and path-keyed checkpoint.
    pub entities: Vec<NativeEntityRuntimeReady>,
}

#[derive(Clone, Debug)]
pub struct NativeEntityRuntimeReady {
    pub entity_id: [u8; 32],
    pub entity_context_policy: Value,
    pub htlc_routing_fee_ppm: u32,
    pub htlc_routing_base_fee: BigInt,
}

#[derive(Clone, Copy)]
enum RestartPublication {
    WebSocket,
    #[cfg(feature = "bench")]
    ValidateOnly,
}

#[allow(clippy::too_many_arguments)]
pub fn restore_native_runtime_processor(
    native_database: impl AsRef<Path>,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_labels: Vec<String>,
    workers: usize,
    routes: EntityRouteTable,
    migration_origin: Option<MigrationOrigin>,
) -> Result<NativeRuntimeReady, String> {
    restore_native_runtime(
        native_database,
        runtime_seed,
        runtime_signer_label,
        entity_signer_labels,
        workers,
        routes,
        migration_origin,
        RestartPublication::WebSocket,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "bench")]
pub(crate) fn restore_native_replay_processor(
    native_database: impl AsRef<Path>,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_labels: Vec<String>,
    workers: usize,
    routes: EntityRouteTable,
    migration_origin: Option<MigrationOrigin>,
) -> Result<NativeRuntimeReady, String> {
    restore_native_runtime(
        native_database,
        runtime_seed,
        runtime_signer_label,
        entity_signer_labels,
        workers,
        routes,
        migration_origin,
        RestartPublication::ValidateOnly,
    )
}

#[allow(clippy::too_many_arguments)]
fn restore_native_runtime(
    native_database: impl AsRef<Path>,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_labels: Vec<String>,
    workers: usize,
    routes: EntityRouteTable,
    migration_origin: Option<MigrationOrigin>,
    publication: RestartPublication,
) -> Result<NativeRuntimeReady, String> {
    let restore_started = Instant::now();
    if runtime_seed.is_empty() || workers == 0 {
        return Err("RRS_NATIVE_RESTART_ARGUMENTS".into());
    }
    let path = native_database.as_ref().to_path_buf();
    let mut source_store = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .map_err(|error| format!("RRS_NATIVE_RESTART_OPEN:{error}"))?;
    let sources = load_native_restore_sources(&mut source_store)
        .map_err(|error| format!("RRS_NATIVE_RESTART_SOURCE:{error}"))?;
    drop(source_store);
    let configuration = ConcreteCheckpointConfiguration {
        runtime_seed: runtime_seed.to_owned(),
        signer_derivation_labels: entity_signer_labels,
        worker_count: workers,
        limits: RuntimeLimits::hlt(),
        swap_market: Arc::new(canonical_swap_market_policy()),
        expected_protocol_fingerprint: PAYMENT_PROFILE_BINDING.protocol_fingerprint,
        board_delays: BoardDelays::default(),
    };
    let decoded = match migration_origin {
        Some(origin) => {
            decode_offline_ts_import_checkpoint(sources.checkpoint, configuration, origin)
        }
        None => decode_concrete_runtime_checkpoint(sources.checkpoint, configuration),
    }
    .map_err(|error| format!("RRS_NATIVE_RESTART_CHECKPOINT:{error}"))?;
    let checkpoint_period_frames = decoded.limits.checkpoint_period_frames;
    let entities = decoded
        .entities
        .iter()
        .map(|entity| {
            Ok(NativeEntityRuntimeReady {
                entity_id: parse_hex32(&entity.entity_snapshot.entity_id)?,
                entity_context_policy: entity.entity_context_policy.clone(),
                htlc_routing_fee_ppm: entity.htlc_routing_fee_ppm,
                htlc_routing_base_fee: entity.htlc_routing_base_fee.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let entity_context_policy = entities
        .first()
        .map(|entity| entity.entity_context_policy.clone())
        .ok_or_else(|| "RRS_NATIVE_RESTART_ENTITY_MISSING".to_string())?;
    let mut restored = restore_decoded_runtime_checkpoint(decoded)
        .map_err(|error| format!("RRS_NATIVE_RESTART_RESTORE:{error}"))?;
    if let (Some(origin), Some(first)) = (migration_origin, sources.wal.first()) {
        let source_lineage = first.validated().prev_frame_hash;
        restored
            .replica
            .durable
            .adopt_offline_import_lineage(origin, source_lineage);
    }
    let restored_wal_frames = sources.wal.len();
    for source in sources.wal {
        let finalized_j_height = restored.replica.state.finalized_j_height;
        let frame = decode_concrete_runtime_wal_frame(
            &source,
            &entity_context_policy,
            finalized_j_height,
            false,
        )
        .map_err(|error| format!("RRS_NATIVE_RESTART_WAL:{}:{error}", source.height()))?;
        reconcile_runtime_input_with_resident_queue(&frame.input, &mut restored.replica.mempool);
        restored = replay_decoded_runtime_wal(restored, vec![frame])
            .map_err(|error| format!("RRS_NATIVE_RESTART_APPLY:{}:{error}", source.height()))?;
    }
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames,
            ..NativeStorageConfig::default()
        },
    )
    .map_err(|error| format!("RRS_NATIVE_RESTART_REOPEN:{error}"))?;
    let signer = RuntimeSignerLabel::new(runtime_signer_label)
        .map_err(|error| format!("RRS_NATIVE_RESTART_SIGNER:{error}"))?;
    let processor = match publication {
        RestartPublication::WebSocket => {
            DurableRuntimeProcessor::new(restored.replica, store, routes, runtime_seed, signer)
        }
        #[cfg(feature = "bench")]
        RestartPublication::ValidateOnly => DurableRuntimeProcessor::new_replay_validate_only(
            restored.replica,
            store,
            routes,
            runtime_seed,
            signer,
        ),
    }
    .map_err(|error| format!("RRS_NATIVE_RESTART_PROCESSOR:{error}"))?;
    Ok(NativeRuntimeReady {
        processor,
        restore_elapsed: restore_started.elapsed(),
        restored_wal_frames,
        entities,
    })
}

fn parse_hex32(value: &str) -> Result<[u8; 32], String> {
    let payload = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 64)
        .ok_or_else(|| format!("RRS_NATIVE_RESTART_ENTITY_ID:{value}"))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("RRS_NATIVE_RESTART_ENTITY_ID:{value}"))?;
    }
    Ok(output)
}
