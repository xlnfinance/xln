# xln native-kernel boundary benchmark

Read-only production audit artifact. Nothing here is wired into `core`.

## Scope

- Existing xln Hanko record: `[digest:32][compact signature:64][recovery:1]`.
- Output: Ethereum address bytes, 20 bytes per input, stable input order.
- Account-leaf proxy: SHA-256 over already encoded 512-byte preimages.
- Boundary comparison: Rust C ABI through `bun:ffi`, Rust N-API batch,
  existing `secp256k1` per-record Node addon, Bun transferable Workers, and a
  separate Rust process over pipes.

The benchmark deliberately does not reimplement Account projection, canonical
encoding, Patricia structural sharing, or checkpoint node diffs. Those are the
consensus-sensitive/hot ownership boundaries that stay in TypeScript.

## Build and run

```bash
cargo build --manifest-path bench/native-kernel/Cargo.toml --release
cargo build --manifest-path bench/native-kernel/napi/Cargo.toml --release
cp bench/native-kernel/napi/target/release/libxln_native_kernel_napi.dylib \
  bench/native-kernel/napi/target/release/xln_native_kernel_napi.node
XLN_NATIVE_BENCH_COUNT=1024 XLN_NATIVE_BENCH_ROUNDS=15 \
  XLN_NATIVE_BENCH_WORKERS=0 bun bench/native-kernel/run.ts
bun bench/native-kernel/worker-ipc.ts
```

Measured on Apple M3 Ultra (32 physical cores), Bun 1.3.14, Rust 1.94.1:

| operation, 1024 records | median |
|---|---:|
| Rust FFI recover + Keccak, 1 thread | 24.799 ms |
| Rust FFI recover + Keccak, 16 threads | 1.830 ms |
| Rust FFI recover + Keccak, 32 threads | 1.673 ms |
| Rust N-API recover + Keccak, 32 threads | 1.662 ms |
| existing addon, 1024 per-record calls + Keccak | 83.530 ms |
| Rust FFI SHA-256, 512 bytes, 1 thread | 1.261 ms |
| Rust FFI SHA-256, 512 bytes, 16 threads | 0.115 ms |
| Rust N-API SHA-256, 512 bytes, 16 threads | 0.223 ms |
| Bun native SHA-256, 512 bytes, 1 thread | 0.382 ms |
| Rust child spawn + pipes + recover, 1 thread | 27.144 ms |
| Rust child spawn + pipes + recover, 16 threads | 4.214 ms |
| Bun Worker transferable round trip, 97 KiB | 0.027 ms |
| Bun Worker transferable round trip, 1.52 MiB | 0.027 ms |

At frame-sized batches, recover + Keccak scales across Rayon: 1/4/8/16/32
threads measured 24.799/6.244/3.215/1.830/1.673 ms. The last 16 cores buy
only 0.157 ms while contending with the rest of the HLT processes, so cap a
production pool at 8 or 16. SHA-256 also benefits up to 16 threads, but the
absolute saving over Bun's native hasher is only about 0.27 ms per 1024 leaves.

The separate process number includes a measured 1.016 ms median spawn. A
persistent pipe process removes spawn but not copying, allocation, wakeups, or
crash supervision. Cross-process shared memory is not directly exposed by Bun
and would require another mmap native surface. It has no advantage over N-API
or a transferable Bun Worker for these bounded pure calls.

A separate Zig 0.16 benchmark is in `../native-account/zig`. Zig's standard
library verifies secp256k1 signatures but does not recover public keys, so its
numbers are not presented as a replacement for this recover benchmark. A Zig
C ABI using the same vendored libsecp256k1 would exercise the same Bun boundary
and is unlikely to beat the measured Rust C ABI by a material amount.

## Amdahl result

The authoritative 9000-payment run in `/tmp/xln-hlt-profile.pa0Tiz` took
30.255 s (297.47 payments/s). H1 ECDSA recovery was already reduced to 4.280 ms
total by xln's memo-priming pool. Perfectly eliminating it changes throughput by
less than 0.02%. `entity.accountLeaf.valueHash` was 1.853 s total, but its final
SHA-256 is only roughly 4-6 ms at Bun's measured one-shot hash rate; projection
and canonical encoding dominate. Even deleting the entire leaf phase would
only reach 316.9 payments/s. A bytes-only native kernel cannot produce 600 TPS.

## Minimal production ABI, if retained

- One N-API function `recoverHankoBatch(records) -> { status, addresses }`.
- `records` is the current 97-byte layout; `status` is one byte per record and
  `addresses` is 20 bytes per record. Never silently zero-fill invalid records.
- A Bun Worker owns the addon and receives transferable buffers. TypeScript
  continues to parse canonical Hanko ABI, enforce claims/threshold/board state,
  compare the expected entity, and preserve proposal order.
- Optional `sha256Batch(offsets, preimages)` may hash bytes which TypeScript has
  already canonically encoded. It must not accept JS objects or own state.
- Do not add native `nodeChanges`: `nodeChangesSince` exploits JS object identity
  to skip structurally shared subtrees and runs for checkpoint storage, not the
  live frame path. Serializing both trees into native memory loses that win.
