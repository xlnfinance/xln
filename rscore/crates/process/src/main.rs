#![forbid(unsafe_code)]

#[path = "commands/checkpoint_import.rs"]
mod checkpoint_import;
#[path = "commands/commitment_check.rs"]
mod commitment_check;
#[path = "commands/entity_replay.rs"]
mod entity_replay;
#[path = "commands/live.rs"]
mod live;
#[path = "commands/native_replay.rs"]
mod native_replay;
#[path = "commands/orderbook_bench.rs"]
mod orderbook_bench;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn usage() -> String {
    "XLNRS_MODE_REQUIRED:live|native-replay|entity-replay|import|check|orderbook-bench|stdio".into()
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_else(|| "stdio".into());
    let args = args.collect::<Vec<_>>();
    match mode.as_str() {
        "live" => live::run(args),
        "native-replay" => native_replay::run(args),
        "entity-replay" => entity_replay::run(args),
        "import" => checkpoint_import::run(args),
        "check" => commitment_check::run(args),
        "orderbook-bench" => orderbook_bench::run(args),
        "stdio" if args.is_empty() => {
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            xln_rscore_process::serve(&mut stdin.lock(), &mut stdout.lock())
                .map_err(|error| error.to_string())
        }
        _ => Err(usage()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
