# Zig native Account batch microbenchmark

This is an isolated benchmark. It does not import or modify xln core and is not
wired into production.

The fixed 128-byte input record contains Account id, sequence, signed delta,
Keccak-256 digest and a 64-byte secp256k1 signature. The kernel:

1. parses bytes and reconstructs the Keccak-256 transition digest from current
   Account state;
2. optionally verifies ECDSA/secp256k1 over that digest;
3. applies the checked nonce and signed-balance transition;
4. updates a deterministic Keccak-256 Account leaf;
5. writes one event into the input's exact ordered output slot.

Inputs are grouped by Account. The all-core run shards disjoint Account ranges,
so workers share no mutable Account and do not need locks. Every run asserts the
same ordered-output checksum as the one-thread result.

The benchmark reports both `kernel_only` and `include_copy_serialize`. The latter
also copies the complete byte input and manually serializes every ordered event
to its fixed 53-byte wire form. Allocation, fixture signing and output checksum
calculation remain outside the timed region.

Zig 0.16 provides secp256k1 ECDSA verification in `std.crypto`; it does not
provide public-key recovery. No system `libsecp256k1` was installed on the test
machine, so recover is explicitly reported as unavailable rather than silently
replaced with a different primitive.

Build and run:

```sh
zig build-exe main.zig -O ReleaseFast -femit-bin=native-account-zig
./native-account-zig --items 25000 --accounts 4096
```

Optional `--threads N` overrides the detected logical CPU count.
