#![forbid(unsafe_code)]

//! Import one verified materialized TypeScript Runtime checkpoint into the
//! canonical native path-keyed store. This is an offline ownership handoff,
//! not replay and not a second state representation.

use std::path::PathBuf;

use xln_rscore_runtime::RuntimeWalReader;
use xln_rscore_runtime::storage::native::{NativeRuntimeStore, NativeStorageConfig};

fn argument(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("RUNTIME_CHECKPOINT_IMPORT_ARG_MISSING:{name}"))?;
    args.get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("RUNTIME_CHECKPOINT_IMPORT_ARG_MISSING:{name}"))
}

fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let wal_path = PathBuf::from(argument(&args, "--wal")?);
    let state_path = PathBuf::from(argument(&args, "--state-db")?);
    let native_path = PathBuf::from(argument(&args, "--native-db")?);
    if wal_path == state_path || wal_path == native_path || state_path == native_path {
        return Err("RUNTIME_CHECKPOINT_IMPORT_DATABASES_MUST_BE_DISTINCT".into());
    }
    let height = argument(&args, "--height")?
        .parse::<u64>()
        .ok()
        .filter(|height| *height > 0)
        .ok_or_else(|| "RUNTIME_CHECKPOINT_IMPORT_HEIGHT_INVALID".to_string())?;

    let mut wal = RuntimeWalReader::open_owned(wal_path)
        .map_err(|error| format!("RUNTIME_CHECKPOINT_IMPORT_WAL_OPEN:{error}"))?;
    let mut state = RuntimeWalReader::open_owned(state_path)
        .map_err(|error| format!("RUNTIME_CHECKPOINT_IMPORT_STATE_OPEN:{error}"))?;
    let frame = wal
        .native_checkpoint_import_frame(&mut state, height)
        .map_err(|error| format!("RUNTIME_CHECKPOINT_IMPORT_SOURCE:{error}"))?;
    let mut native = NativeRuntimeStore::open(native_path, NativeStorageConfig::default())
        .map_err(|error| format!("RUNTIME_CHECKPOINT_IMPORT_NATIVE_OPEN:{error}"))?;
    let durable = native
        .import_checkpoint(frame)
        .map_err(|error| format!("RUNTIME_CHECKPOINT_IMPORT_NATIVE_WRITE:{error}"))?;
    println!(
        "{{\"status\":\"imported\",\"height\":{},\"outputs\":{}}}",
        durable.height(),
        durable.output_count(),
    );
    Ok(())
}
