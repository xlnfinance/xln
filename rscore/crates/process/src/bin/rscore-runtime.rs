#![forbid(unsafe_code)]

//! Zero-JS resident xln Runtime process.

use std::collections::BTreeSet;
use std::io::BufRead;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use xln_rscore_process::native_runtime::restore_native_runtime_processor;
use xln_rscore_runtime::processor::{EntityRoute, EntityRouteTable};
use xln_rscore_runtime::restore::MigrationOrigin;
use xln_rscore_runtime::transport::{DirectRuntimeIngress, DirectRuntimeIngressConfig};
use xln_rscore_runtime::{CanonicalEntityInfraMaterializer, ResidentRuntimeService};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Debug)]
struct LocalEntityCommand {
    command_id: String,
    entity_inputs: Vec<xln_rscore_runtime::RuntimeEntityInput>,
}

fn local_command(value: Value) -> Result<LocalEntityCommand, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "RRS_RUNTIME_LOCAL_COMMAND_OBJECT".to_string())?;
    if object.len() != 3
        || !["type", "commandId", "entityInputs"]
            .iter()
            .all(|field| object.contains_key(*field))
    {
        return Err("RRS_RUNTIME_LOCAL_COMMAND_FIELDS".into());
    }
    if object.get("type").and_then(Value::as_str) != Some("localEntityInputs") {
        return Err("RRS_RUNTIME_LOCAL_COMMAND_TYPE".into());
    }
    let command_id = object
        .get("commandId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| "RRS_RUNTIME_LOCAL_COMMAND_ID".to_string())?
        .to_owned();
    let rows = object
        .get("entityInputs")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty() && rows.len() <= 10_000)
        .ok_or_else(|| "RRS_RUNTIME_LOCAL_COMMAND_ENTITY_INPUTS".to_string())?;
    let entity_inputs = rows
        .iter()
        .cloned()
        .map(xln_rscore_runtime::RuntimeEntityInput::decode)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("RRS_RUNTIME_LOCAL_COMMAND_DECODE:{error}"))?;
    Ok(LocalEntityCommand {
        command_id,
        entity_inputs,
    })
}

fn local_command_receiver() -> Receiver<Result<LocalEntityCommand, String>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("rrs-local-command".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let decoded = line
                    .map_err(|error| format!("RRS_RUNTIME_LOCAL_COMMAND_READ:{error}"))
                    .and_then(|line| {
                        serde_json::from_str::<Value>(&line)
                            .map_err(|error| format!("RRS_RUNTIME_LOCAL_COMMAND_JSON:{error}"))
                    })
                    .and_then(local_command);
                if sender.send(decoded).is_err() {
                    return;
                }
            }
        })
        .expect("local command reader thread");
    receiver
}

fn argument(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("RRS_RUNTIME_ARG_MISSING:{name}"))?;
    args.get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("RRS_RUNTIME_ARG_MISSING:{name}"))
}

fn optional_usize(args: &[String], name: &str, default: usize) -> Result<usize, String> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(default);
    };
    args.get(index + 1)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("RRS_RUNTIME_ARG_INVALID:{name}"))
}

fn digest_hex(value: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(66);
    encoded.push_str("0x");
    for byte in value {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn wall_clock_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "RRS_RUNTIME_LOCAL_COMMAND_CLOCK".to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "RRS_RUNTIME_LOCAL_COMMAND_CLOCK".to_string())
}

fn extend_json_object(
    target: &mut Map<String, Value>,
    value: Value,
    label: &str,
) -> Result<(), String> {
    let Value::Object(fields) = value else {
        return Err(format!("RRS_RUNTIME_METRIC_OBJECT:{label}"));
    };
    target.extend(fields);
    Ok(())
}

fn optional_url(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, String> {
    match object.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(format!("RRS_RUNTIME_ROUTE_FIELD:{field}")),
    }
}

fn text<'a>(object: &'a serde_json::Map<String, Value>, field: &str) -> Result<&'a str, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("RRS_RUNTIME_ROUTE_FIELD:{field}"))
}

fn routes(path: &Path) -> Result<EntityRouteTable, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("RRS_RUNTIME_ROUTES_READ:{error}"))?;
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("RRS_RUNTIME_ROUTES_JSON:{error}"))?;
    let rows = value
        .as_array()
        .ok_or_else(|| "RRS_RUNTIME_ROUTES_ARRAY".to_string())?;
    let mut routes = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let object = row
            .as_object()
            .ok_or_else(|| format!("RRS_RUNTIME_ROUTE_OBJECT:{index}"))?;
        if object.len() != 4
            || ![
                "targetEntityId",
                "targetRuntimeId",
                "targetSignerId",
                "websocketUrl",
            ]
            .iter()
            .all(|field| object.contains_key(*field))
        {
            return Err(format!("RRS_RUNTIME_ROUTE_FIELDS:{index}"));
        }
        routes.push(EntityRoute {
            target_entity_id: text(object, "targetEntityId")?.into(),
            target_runtime_id: text(object, "targetRuntimeId")?.into(),
            target_signer_id: text(object, "targetSignerId")?.into(),
            websocket_url: optional_url(object, "websocketUrl")?,
        });
    }
    EntityRouteTable::new(routes).map_err(|error| format!("RRS_RUNTIME_ROUTES:{error}"))
}

fn secret_key(path: &Path) -> Result<[u8; 32], String> {
    let value = std::fs::read_to_string(path)
        .map_err(|error| format!("RRS_RUNTIME_HTLC_SECRET_READ:{error}"))?;
    let value = value.trim();
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .filter(|_| value == value.to_ascii_lowercase())
        .ok_or_else(|| "RRS_RUNTIME_HTLC_SECRET_FORMAT".to_string())?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| "RRS_RUNTIME_HTLC_SECRET_FORMAT".to_string())?;
    }
    Ok(output)
}

fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let native_database = PathBuf::from(argument(&args, "--native-db")?);
    let runtime_seed_file = PathBuf::from(argument(&args, "--runtime-seed-file")?);
    let entity_encryption_private_key = secret_key(&PathBuf::from(argument(
        &args,
        "--entity-encryption-private-key-file",
    )?))?;
    let runtime_signer_label = argument(&args, "--runtime-signer-label")?;
    let entity_signer_label = argument(&args, "--entity-signer-label")?;
    let bind_address = argument(&args, "--bind")?
        .parse::<SocketAddr>()
        .map_err(|error| format!("RRS_RUNTIME_BIND:{error}"))?;
    let route_table = routes(&PathBuf::from(argument(&args, "--routes")?))?;
    let profile_entity_ids = route_table
        .entity_ids()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let workers = optional_usize(&args, "--workers", 8)?;
    let frame_wait_ms = optional_usize(&args, "--frame-wait-ms", 1)?;
    let metrics_ms = optional_usize(&args, "--metrics-ms", 1_000)?;
    let runtime_seed = std::fs::read_to_string(runtime_seed_file)
        .map_err(|error| format!("RRS_RUNTIME_SEED_READ:{error}"))?;
    let runtime_seed = runtime_seed.trim();
    if runtime_seed.is_empty() {
        return Err("RRS_RUNTIME_SEED_EMPTY".into());
    }

    let ready = restore_native_runtime_processor(
        native_database,
        runtime_seed,
        &runtime_signer_label,
        &entity_signer_label,
        workers,
        route_table,
        args.iter()
            .any(|value| value == "--offline-ts-import")
            .then_some(MigrationOrigin::OfflineTsImport),
    )?;
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        bind_address,
        runtime_seed,
        &runtime_signer_label,
    ))
    .map_err(|error| format!("RRS_RUNTIME_INGRESS:{error}"))?;
    let materializer = CanonicalEntityInfraMaterializer::with_inbound_htlc(
        ready.entity_context_policy,
        xln_rscore_runtime::InboundHtlcInfrastructure {
            entity_encryption_public_key: ready.entity_encryption_public_key,
            entity_encryption_private_key,
            routing_fee_ppm: ready.htlc_routing_fee_ppm,
            routing_base_fee: ready.htlc_routing_base_fee,
            known_profile_entity_ids: profile_entity_ids.clone(),
            // The production route file is the explicit set of peers this
            // process is permitted to contact. Dynamic socket liveness is an
            // input to the next Runtime frame; until that observer changes the
            // set, installed routes are considered reachable.
            online_entity_ids: profile_entity_ids,
        },
    )
    .map_err(|error| format!("RRS_RUNTIME_HTLC_INFRA:{error}"))?;
    let restore_micros = ready.restore_elapsed.as_micros();
    let restored_frames = ready.restored_wal_frames;
    let mut service = ResidentRuntimeService::new(ready.processor, ingress, Box::new(materializer))
        .map_err(|error| format!("RRS_RUNTIME_SERVICE:{error}"))?;
    let restored = service
        .processor()
        .replica()
        .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
    println!(
        concat!(
            "{{\"status\":\"ready\",\"runtimeId\":\"{}\",\"listen\":\"{}\",",
            "\"workers\":{},\"height\":{},\"runtimeFrameHash\":\"{}\",",
            "\"accountsRoot\":\"{}\",\"restoredFrames\":{},",
            "\"restoreMicros\":{}}}"
        ),
        service.runtime_id(),
        service.local_address(),
        workers,
        restored.state.height,
        digest_hex(&restored.durable.prev_frame_hash()),
        digest_hex(&restored.state.accounts_root),
        restored_frames,
        restore_micros,
    );
    let wait = Duration::from_millis(
        u64::try_from(frame_wait_ms).map_err(|_| "RRS_RUNTIME_WAIT_OVERFLOW".to_string())?,
    );
    let mut metric_started = Instant::now();
    let mut frames = 0_u64;
    let mut outputs = 0_u64;
    let mut envelopes = 0_u64;
    let mut apply_micros = 0_u128;
    let mut projection_micros = 0_u128;
    let mut storage_micros = 0_u128;
    let mut publication_micros = 0_u128;
    let mut total_frames = 0_u64;
    let mut total_outputs = 0_u64;
    let mut total_envelopes = 0_u64;
    let mut total_apply_micros = 0_u128;
    let mut total_projection_micros = 0_u128;
    let mut total_storage_micros = 0_u128;
    let mut total_publication_micros = 0_u128;
    let mut total_runtime_entity_inputs = 0_u64;
    let mut total_account_inputs = 0_u64;
    let mut total_canonical_input_bytes = 0_u64;
    let mut total_entity_txs_selected = 0_u64;
    let mut entity_txs_pending = 0_u64;
    let mut total_projection_input_micros = 0_u128;
    let mut total_projection_machine_micros = 0_u128;
    let mut total_projection_meta_micros = 0_u128;
    let mut total_projection_context_micros = 0_u128;
    let mut total_projection_checkpoint_micros = 0_u128;
    let mut total_projection_encode_micros = 0_u128;
    let mut total_accepted_payments = 0_u64;
    let mut total_completed_payments = 0_u64;
    let mut total_matched_swaps = 0_u64;
    let mut lock_book_open = 0_u64;
    let mut last_completed_at_unix_micros = 0_u128;
    let mut last_accepted_at_unix_micros = 0_u128;
    let mut last_matched_at_unix_micros = 0_u128;
    let mut post_state_hash = format!("0x{}", "00".repeat(32));
    let local_commands = local_command_receiver();
    loop {
        let local_command = match local_commands.try_recv() {
            Ok(command) => Some(command?),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
        };
        let local_command_id = local_command
            .as_ref()
            .map(|command| command.command_id.clone());
        let report = match local_command {
            Some(command) => {
                service.process_local_entity_inputs_at(command.entity_inputs, wall_clock_ms()?)
            }
            None => service.process_next(wait),
        }
        .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
        if report.is_none()
            && let Some(command_id) = local_command_id.as_ref()
        {
            return Err(format!("RRS_RUNTIME_LOCAL_COMMAND_IDLE:{command_id}"));
        }
        if let Some(report) = report {
            if let Some(command_id) = local_command_id {
                let height = report
                    .durable_height
                    .ok_or_else(|| format!("RRS_RUNTIME_LOCAL_COMMAND_IDLE:{command_id}"))?;
                println!(
                    "{}",
                    serde_json::json!({
                        "status": "localCommandCommitted",
                        "commandId": command_id,
                        "height": height,
                    })
                );
            }
            frames = frames
                .checked_add(1)
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:frames".to_string())?;
            outputs = outputs
                .checked_add(
                    u64::try_from(report.outputs_published)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:outputs".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:outputs".to_string())?;
            envelopes = envelopes
                .checked_add(
                    u64::try_from(report.envelopes_published)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:envelopes".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:envelopes".to_string())?;
            apply_micros = apply_micros.saturating_add(report.timings.apply.as_micros());
            projection_micros =
                projection_micros.saturating_add(report.timings.projection.as_micros());
            storage_micros = storage_micros.saturating_add(report.timings.storage.as_micros());
            publication_micros =
                publication_micros.saturating_add(report.timings.publication.as_micros());
            total_frames = total_frames.saturating_add(1);
            total_outputs = total_outputs.saturating_add(
                u64::try_from(report.outputs_published)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:totalOutputs".to_string())?,
            );
            total_envelopes = total_envelopes.saturating_add(
                u64::try_from(report.envelopes_published)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:totalEnvelopes".to_string())?,
            );
            total_apply_micros =
                total_apply_micros.saturating_add(report.timings.apply.as_micros());
            total_projection_micros =
                total_projection_micros.saturating_add(report.timings.projection.as_micros());
            total_storage_micros =
                total_storage_micros.saturating_add(report.timings.storage.as_micros());
            total_publication_micros =
                total_publication_micros.saturating_add(report.timings.publication.as_micros());
            total_runtime_entity_inputs = total_runtime_entity_inputs.saturating_add(
                u64::try_from(report.runtime_entity_inputs)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:runtimeEntityInputs".to_string())?,
            );
            total_account_inputs = total_account_inputs.saturating_add(
                u64::try_from(report.account_inputs)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:accountInputs".to_string())?,
            );
            total_canonical_input_bytes = total_canonical_input_bytes.saturating_add(
                u64::try_from(report.canonical_input_bytes)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:canonicalInputBytes".to_string())?,
            );
            total_entity_txs_selected =
                total_entity_txs_selected
                    .saturating_add(u64::try_from(report.entity_txs_selected).map_err(|_| {
                        "RRS_RUNTIME_METRIC_OVERFLOW:entityTxsSelected".to_string()
                    })?);
            entity_txs_pending = u64::try_from(report.entity_txs_pending)
                .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:entityTxsPending".to_string())?;
            total_projection_input_micros = total_projection_input_micros
                .saturating_add(report.timings.projection_input.as_micros());
            total_projection_machine_micros = total_projection_machine_micros
                .saturating_add(report.timings.projection_machine.as_micros());
            total_projection_meta_micros = total_projection_meta_micros
                .saturating_add(report.timings.projection_meta.as_micros());
            total_projection_context_micros = total_projection_context_micros
                .saturating_add(report.timings.projection_context.as_micros());
            total_projection_checkpoint_micros = total_projection_checkpoint_micros
                .saturating_add(report.timings.projection_checkpoint.as_micros());
            total_projection_encode_micros = total_projection_encode_micros
                .saturating_add(report.timings.projection_encode.as_micros());
            total_accepted_payments = total_accepted_payments
                .checked_add(
                    u64::try_from(report.accepted_payments)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:acceptedPayments".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:acceptedPayments".to_string())?;
            total_completed_payments = total_completed_payments
                .checked_add(
                    u64::try_from(report.completed_payments)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:completedPayments".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:completedPayments".to_string())?;
            total_matched_swaps = total_matched_swaps
                .checked_add(
                    u64::try_from(report.matched_swaps)
                        .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:matchedSwaps".to_string())?,
                )
                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:matchedSwaps".to_string())?;
            if let Some(open) = report.lock_book_open {
                lock_book_open = u64::try_from(open)
                    .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:lockBookOpen".to_string())?;
            }
            if report.completed_payments > 0 {
                last_completed_at_unix_micros = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "RRS_RUNTIME_METRIC_CLOCK_BEFORE_EPOCH".to_string())?
                    .as_micros();
            }
            if report.accepted_payments > 0 {
                last_accepted_at_unix_micros = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "RRS_RUNTIME_METRIC_CLOCK_BEFORE_EPOCH".to_string())?
                    .as_micros();
            }
            if report.matched_swaps > 0 {
                last_matched_at_unix_micros = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "RRS_RUNTIME_METRIC_CLOCK_BEFORE_EPOCH".to_string())?
                    .as_micros();
            }
            if let Some(commitments) = report.commitments.as_ref() {
                post_state_hash = digest_hex(&commitments.post_state_hash);
            }
        }
        if metric_started.elapsed()
            >= Duration::from_millis(
                u64::try_from(metrics_ms)
                    .map_err(|_| "RRS_RUNTIME_METRICS_INTERVAL_OVERFLOW".to_string())?,
            )
        {
            let elapsed = metric_started.elapsed();
            let ingress = service.ingress_metrics();
            let backlog = service.publication_backlog();
            let height = service
                .processor()
                .replica()
                .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?
                .state
                .height;
            let htlc_fees_earned = service
                .processor()
                .replica()
                .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?
                .state
                .entity
                .htlc_fees_earned
                .to_string();
            let replica = service
                .processor()
                .replica()
                .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
            let (orderbook_trade_count, open_book_orders, open_swap_offers, resolving_swap_offers) =
                match replica.state.entity.orderbook.as_ref() {
                    Some(orderbook) => {
                        let trade_count = orderbook.books.values().try_fold(0_u64, |total, book| {
                            total.checked_add(book.trade_count)
                                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:orderbookTradeCount".to_string())
                        })?;
                        let book_orders = orderbook.books.values().try_fold(0_u64, |total, book| {
                            let count = u64::try_from(book.orders.len())
                                .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:openBookOrders".to_string())?;
                            total.checked_add(count)
                                .ok_or_else(|| "RRS_RUNTIME_METRIC_OVERFLOW:openBookOrders".to_string())
                        })?;
                        (
                            trade_count,
                            book_orders,
                            u64::try_from(orderbook.offers.len())
                                .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:openSwapOffers".to_string())?,
                            u64::try_from(orderbook.resolving_offers.len())
                                .map_err(|_| "RRS_RUNTIME_METRIC_OVERFLOW:resolvingSwapOffers".to_string())?,
                        )
                    }
                    None => (0, 0, 0, 0),
                };
            let mut worker_items = vec![0_u64; replica.accounts.worker_count()];
            let mut worker_nanos = vec![0_u64; replica.accounts.worker_count()];
            let mut active_shards = 0_u64;
            for metric in replica.accounts.account_shard_metrics() {
                let worker = usize::from(metric.worker);
                worker_items[worker] = worker_items[worker].saturating_add(metric.work_items);
                worker_nanos[worker] = worker_nanos[worker]
                    .saturating_add(metric.work_nanos)
                    .saturating_add(metric.fold_nanos);
                active_shards = active_shards
                    .saturating_add(u64::from(metric.work_items > 0 || metric.fold_leaves > 0));
            }
            let phase_metrics = replica.accounts.account_phase_metrics();
            let account_coordinator_wall_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_wall_nanos)
                .sum::<u64>();
            let account_coordinator_fold_nanos = phase_metrics
                .iter()
                .map(|metric| metric.coordinator_fold_nanos)
                .sum::<u64>();
            let account_worker_work_max_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_work_max_nanos)
                .max()
                .unwrap_or(0);
            let account_worker_work_sum_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_work_sum_nanos)
                .sum::<u64>();
            let account_worker_barrier_wait_max_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_barrier_wait_max_nanos)
                .max()
                .unwrap_or(0);
            let account_worker_barrier_wait_sum_nanos = phase_metrics
                .iter()
                .map(|metric| metric.worker_barrier_wait_sum_nanos)
                .sum::<u64>();
            let account_workers_with_work = phase_metrics
                .iter()
                .map(|metric| metric.workers_with_work)
                .max()
                .unwrap_or(0);
            let account_touched_shards = phase_metrics
                .iter()
                .map(|metric| metric.touched_shards)
                .sum::<u64>();
            // Keep the groups small. One giant json! expansion exceeds the
            // compiler recursion limit and makes telemetry affect the build.
            let mut metric_object = Map::new();
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "status": "metrics",
                    "windowMs": elapsed.as_millis(),
                    "height": height,
                    "frames": frames,
                    "acceptedBatches": ingress.accepted_batches,
                    "acceptedEntityInputs": ingress.accepted_entity_inputs,
                    "acceptedConnections": ingress.accepted_connections,
                    "authenticatedSessions": ingress.authenticated_sessions,
                    "rejectedSessions": ingress.rejected_sessions,
                    "openSessions": ingress.open_sessions,
                    "lastSessionError": service.last_session_error(),
                    "queueRejections": ingress.queue_rejections,
                    "outputsPublished": outputs,
                    "envelopesPublished": envelopes,
                    "outboxTargetsPending": backlog.targets,
                    "outboxRowsPending": backlog.rows,
                    "outboxBytesPending": backlog.bytes,
                    "outboxFailures": backlog.failures.len(),
                    "acceptedPayments": total_accepted_payments,
                    "completedPayments": total_completed_payments,
                    "matchedSwaps": total_matched_swaps,
                    "lockBookOpen": lock_book_open,
                    "orderbookTradeCount": orderbook_trade_count,
                    "openBookOrders": open_book_orders,
                    "openSwapOffers": open_swap_offers,
                    "resolvingSwapOffers": resolving_swap_offers,
                    "lastCompletedAtUnixMicros": last_completed_at_unix_micros,
                    "lastAcceptedAtUnixMicros": last_accepted_at_unix_micros,
                    "lastMatchedAtUnixMicros": last_matched_at_unix_micros,
                    "postStateHash": post_state_hash,
                    "htlcFeesEarned": htlc_fees_earned,
                }),
                "runtime",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "applyMicros": apply_micros,
                    "projectionMicros": projection_micros,
                    "storageMicros": storage_micros,
                    "publicationMicros": publication_micros,
                    "totalFrames": total_frames,
                    "totalOutputsPublished": total_outputs,
                    "totalEnvelopesPublished": total_envelopes,
                    "totalApplyMicros": total_apply_micros,
                    "totalProjectionMicros": total_projection_micros,
                    "totalStorageMicros": total_storage_micros,
                    "totalPublicationMicros": total_publication_micros,
                }),
                "phases",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "totalRuntimeEntityInputs": total_runtime_entity_inputs,
                    "totalAccountInputs": total_account_inputs,
                    "totalCanonicalInputBytes": total_canonical_input_bytes,
                    "totalEntityTxsSelected": total_entity_txs_selected,
                    "entityTxsPending": entity_txs_pending,
                    "totalProjectionInputMicros": total_projection_input_micros,
                    "totalProjectionMachineMicros": total_projection_machine_micros,
                    "totalProjectionMetaMicros": total_projection_meta_micros,
                    "totalProjectionContextMicros": total_projection_context_micros,
                    "totalProjectionCheckpointMicros": total_projection_checkpoint_micros,
                    "totalProjectionEncodeMicros": total_projection_encode_micros,
                }),
                "projectionDetail",
            )?;
            extend_json_object(
                &mut metric_object,
                serde_json::json!({
                    "accountCoordinatorWallMicros": account_coordinator_wall_nanos / 1_000,
                    "accountCoordinatorFoldMicros": account_coordinator_fold_nanos / 1_000,
                    "accountWorkerWorkSumMicros": account_worker_work_sum_nanos / 1_000,
                    "accountWorkerWorkMaxMicros": account_worker_work_max_nanos / 1_000,
                    "accountWorkerBarrierWaitSumMicros": account_worker_barrier_wait_sum_nanos / 1_000,
                    "accountWorkerBarrierWaitMaxMicros": account_worker_barrier_wait_max_nanos / 1_000,
                    "accountWorkersWithWork": account_workers_with_work,
                    "accountTouchedShards": account_touched_shards,
                    "activeShards": active_shards,
                    "workerItems": worker_items,
                    "workerNanos": worker_nanos,
                }),
                "accountWorkers",
            )?;
            println!("{}", Value::Object(metric_object));
            metric_started = Instant::now();
            frames = 0;
            outputs = 0;
            envelopes = 0;
            apply_micros = 0;
            projection_micros = 0;
            storage_micros = 0;
            publication_micros = 0;
        }
    }
}
