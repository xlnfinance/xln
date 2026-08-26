use std::fs::File;
use std::io::BufReader;

use xln_rscore_runtime::verify_recording_post_state_hashes;

fn argument(args: &[String], name: &str) -> Result<Option<String>, String> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(None);
    };
    args.get(index + 1)
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("RUNTIME_COMMITMENT_ARG_MISSING:{name}"))
}

fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let recording = argument(&args, "--recording")?
        .ok_or_else(|| "RUNTIME_COMMITMENT_ARG_MISSING:--recording".to_string())?;
    let through_height = argument(&args, "--through-height")?
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "RUNTIME_COMMITMENT_HEIGHT_INVALID".to_string())
        })
        .transpose()?;
    let file = File::open(&recording)
        .map_err(|error| format!("RUNTIME_COMMITMENT_OPEN:{recording}:{error}"))?;
    let root = serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("RUNTIME_COMMITMENT_JSON:{error}"))?;
    let checks = verify_recording_post_state_hashes(&root, through_height)
        .map_err(|error| error.to_string())?;
    let mismatches = checks.iter().filter(|check| !check.matches()).count();
    let first_height = checks.first().map(|check| check.height).unwrap_or(0);
    let last_height = checks.last().map(|check| check.height).unwrap_or(0);
    println!(
        "{{\"benchmark\":\"rscore-runtime-commitment\",\"frames\":{},\"matches\":{},\"mismatches\":{},\"firstHeight\":{},\"lastHeight\":{}}}",
        checks.len(),
        checks.len().saturating_sub(mismatches),
        mismatches,
        first_height,
        last_height,
    );
    if let Some(check) = checks.iter().find(|check| !check.matches()) {
        return Err(format!(
            "RUNTIME_COMMITMENT_MISMATCH:height={}:expected={}:actual={}",
            check.height, check.expected, check.actual,
        ));
    }
    Ok(())
}
