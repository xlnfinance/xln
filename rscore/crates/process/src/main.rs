fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    if let Err(error) = xln_rscore_process::serve(&mut stdin.lock(), &mut stdout.lock()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
