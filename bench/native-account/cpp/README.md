# Native Account batch kernel microbenchmark

Isolated C++ benchmark for the byte-only portion of an Account batch. It does
not import or modify production core code.

Each 181-byte input performs:

1. deterministic Keccak-256 transition-digest reconstruction;
2. libsecp256k1 recoverable-signature parse and public-key recovery;
3. Ethereum-style signer-address derivation and equality check;
4. libsecp256k1 ECDSA verification;
5. checked signed-delta balance transition;
6. deterministic Keccak-256 Account-leaf update;
7. one 57-byte event written at the input index, preserving batch order.

The boundary variants include one full input copy into the native boundary and
one full event copy back. Buffers are allocated before timing, so the reported
difference measures bytes crossing the boundary rather than allocator noise.

Build and run:

```sh
make -C bench/native-account/cpp
bench/native-account/cpp/build/native-account-bench \
  --records 32768 --threads 32 --repeats 3
```

The build uses the exact vendored `node_modules/secp256k1` C source already used
by the repository's native Bun binding. No package installation is required.
