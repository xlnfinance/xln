//! Exact native checkpoint + WAL restart into the production processor.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use num_bigint::BigInt;
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
    DurableRuntimeProcessor, RuntimeEntityKey, RuntimeLimits, RuntimeSignerLabel,
    canonical_swap_market_policy,
};

use crate::PAYMENT_PROFILE_BINDING;

pub struct NativeRuntimeReady {
    pub processor: DurableRuntimeProcessor,
    /// Restore-only diagnostics. They never enter Runtime state or storage.
    pub restore_elapsed: Duration,
    pub restored_wal_frames: usize,
    pub htlc_routing_fees: BTreeMap<RuntimeEntityKey, (u32, BigInt)>,
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
    entity_signer_label: &str,
    workers: usize,
    routes: EntityRouteTable,
    migration_origin: Option<MigrationOrigin>,
    custody_import_keys: BTreeMap<String, [u8; 32]>,
) -> Result<NativeRuntimeReady, String> {
    restore_native_runtime(
        native_database,
        runtime_seed,
        runtime_signer_label,
        &[entity_signer_label.to_owned()],
        workers,
        routes,
        migration_origin,
        RestartPublication::WebSocket,
        custody_import_keys,
    )
}

#[allow(clippy::too_many_arguments)]
#[cfg(feature = "bench")]
pub(crate) fn restore_native_replay_processor(
    native_database: impl AsRef<Path>,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_labels: &[String],
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
        BTreeMap::new(),
    )
}

#[allow(clippy::too_many_arguments)]
fn restore_native_runtime(
    native_database: impl AsRef<Path>,
    runtime_seed: &str,
    runtime_signer_label: &str,
    entity_signer_labels: &[String],
    workers: usize,
    routes: EntityRouteTable,
    migration_origin: Option<MigrationOrigin>,
    publication: RestartPublication,
    custody_import_keys: BTreeMap<String, [u8; 32]>,
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
        signer_derivation_labels: entity_signer_labels.to_vec(),
        custody_import_keys,
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
    let htlc_routing_fees = decoded
        .entities
        .iter()
        .map(|entity| {
            RuntimeEntityKey::new(entity.stored_accounts.owner_entity_id, &entity.signer_id)
                .map(|key| {
                    (
                        key,
                        (
                            entity.htlc_routing_fee_ppm,
                            entity.htlc_routing_base_fee.clone(),
                        ),
                    )
                })
                .map_err(|error| format!("RRS_NATIVE_RESTART_FEE_OWNER:{error}"))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
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
        let frame = decode_concrete_runtime_wal_frame(&source, finalized_j_height)
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
        htlc_routing_fees,
    })
}
