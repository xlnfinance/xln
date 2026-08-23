# Native Account batch kernel microbenchmark

Isolated Rust benchmark for the CPU-shaped part of an xln Account batch. It is
not production code and has no package or core integration.

For each independent input the timed kernel:

1. hashes the signed Account input preimage with SHA-256;
2. recovers the secp256k1 signer and verifies the standard ECDSA signature;
3. applies a checked signed delta and increments the nonce;
4. hashes the deterministic Account leaf with SHA-256;
5. collects the resulting event in exact input order.

`serialization_copy=excluded` passes typed fixtures directly. `included`
adds fixed-width input/output encoding, decoding, and one owned byte copy in
each direction to approximate an FFI or worker boundary. Fixture generation
and signing are deliberately outside timed regions.

## Run

```bash
cd /Users/zigota/xln/bench/native-account/rust
cargo run --release -- --n 10000 --iters 5 --warmups 1
```

The program prints median/min/max duration and inputs per second for one thread
and Rayon using every logical core. Results and exact toolchain from the latest
run are recorded below after measurement.

## Latest local result

Measured 2026-08-23 from repository commit `73d0ed47101d06488363561df651cbc1eaabde52`
with unrelated visible WIP outside this isolated directory.

- Machine: Apple M3 Ultra, 32 logical cores, 512 GiB RAM
- OS: macOS 26.6.1 (25G76), `aarch64-apple-darwin`
- Rust: `rustc 1.94.1 (e408947bf 2026-03-25)`, LLVM 21.1.8
- Cargo: `cargo 1.94.1 (29ea6fb6a 2026-03-24)`
- Crates: Rayon 1.12.0, secp256k1 0.31.1, SHA-2 0.10.9
- Build: release, `opt-level=3`, thin LTO, one codegen unit

Command:

```bash
cargo run --release -- --n 10000 --iters 9 --warmups 2
```

| execution | serialization + two boundary copies | median | min | max | inputs/s |
|---|---:|---:|---:|---:|---:|
| 1 thread | excluded | 438.839 ms | 436.222 ms | 445.928 ms | 22,787 |
| 1 thread | included | 443.525 ms | 437.594 ms | 451.951 ms | 22,547 |
| 32 Rayon threads | excluded | 18.853 ms | 18.603 ms | 19.724 ms | 530,416 |
| 32 Rayon threads | included | 18.538 ms | 18.258 ms | 18.949 ms | 539,433 |

The parallel speedup was 23.3x for the direct typed kernel. Fixed-width
serialization plus 194-byte input and 96-byte output copies cost about 1.1% on
one thread. Its parallel result was 1.7% faster, which is benchmark noise/cache
placement rather than a negative serialization cost; crypto dominates this
small boundary representation.

This is a kernel ceiling, not xln TPS. It excludes Entity routing, HTLC and
orderbook followups, Account proposal construction, persistence, sockets, and
Runtime/Entity frame commitments. It also deliberately performs both public-key
recovery and a separate standard ECDSA verify; a production path that treats
successful recovery-to-the-expected-key as verification performs less crypto.
