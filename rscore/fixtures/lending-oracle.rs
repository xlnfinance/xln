// Generate the oracle with the canonical TS handlers, as storage_schema tests do.
// Each test binary runs each generator once; no generated files or shared writes.
pub fn lending_oracle(name: &str) -> &'static serde_json::Value {
    use std::sync::OnceLock;
    static EDGES: OnceLock<serde_json::Value> = OnceLock::new();
    static BOOK: OnceLock<serde_json::Value> = OnceLock::new();
    static SERVICING: OnceLock<serde_json::Value> = OnceLock::new();
    let cache = match name {
        "account-semantics/lending-edges" => &EDGES,
        "entity-kernel/lending" => &BOOK,
        "entity-kernel/lending-servicing" => &SERVICING,
        _ => panic!("unknown lending oracle: {name}"),
    };
    cache.get_or_init(|| {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let output = std::process::Command::new("bun")
            .current_dir(root)
            .arg(format!("rscore/fixtures/{name}.ts"))
            .output()
            .expect("run canonical TypeScript lending generator");
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("TS lending oracle JSON")
    })
}
