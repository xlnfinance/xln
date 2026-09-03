//! Build script: one custom cfg, nothing else.
//!
//! `wasi_threadless` marks the wasm targets with no thread support. The
//! ecosystem's usual discriminator, `cfg!(target_feature = "atomics")`, does
//! not work: `atomics` is an *unstable* wasm target feature, so stable rustc
//! never reports it in `cfg!` even where it is enabled. The triple name is
//! the only stable signal.
//!
//! This runs on the host at build time and has no effect on the compiled
//! crate's `no_std` story.

fn main() {
    println!("cargo:rustc-check-cfg=cfg(wasi_threadless)");
    let target = std::env::var("TARGET").expect("TARGET is always set for a build script");
    // wasm32-wasip1 (no threads) and wasm32-unknown-unknown (no std, so no
    // threads either). wasm32-wasip1-threads is deliberately NOT matched:
    // std::thread works there.
    if target == "wasm32-wasip1" || target == "wasm32-unknown-unknown" {
        println!("cargo:rustc-cfg=wasi_threadless");
    }
}
