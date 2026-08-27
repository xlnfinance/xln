#![forbid(unsafe_code)]

//! Zero-JS resident xln Runtime process.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use xln_rscore_process::native_runtime::restore_native_runtime_processor;
use xln_rscore_runtime::processor::{EntityRoute, EntityRouteTable};
use xln_rscore_runtime::restore::MigrationOrigin;
use xln_rscore_runtime::transport::{DirectRuntimeIngress, DirectRuntimeIngressConfig};
use xln_rscore_runtime::{CanonicalEntityInfraMaterializer, ResidentRuntimeService};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

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
            websocket_url: text(object, "websocketUrl")?.into(),
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
    let mut service = ResidentRuntimeService::new(ready.processor, ingress, Box::new(materializer))
        .map_err(|error| format!("RRS_RUNTIME_SERVICE:{error}"))?;
    println!(
        "{{\"status\":\"ready\",\"runtimeId\":\"{}\",\"listen\":\"{}\",\"workers\":{workers}}}",
        service.runtime_id(),
        service.local_address(),
    );
    let wait = Duration::from_millis(
        u64::try_from(frame_wait_ms).map_err(|_| "RRS_RUNTIME_WAIT_OVERFLOW".to_string())?,
    );
    loop {
        service
            .process_next(wait)
            .map_err(|error| format!("RRS_RUNTIME_FATAL:{error}"))?;
    }
}
