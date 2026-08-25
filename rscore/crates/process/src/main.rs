// Account candidates are allocated on Rayon workers and released after the
// upper-tree fold. A thread-local allocator avoids serializing that hot path;
// keep it process-local (never embed this binary allocator in a NAPI module).
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    if let Err(error) = xln_rscore_process::serve(&mut stdin.lock(), &mut stdout.lock()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
