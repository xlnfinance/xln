# BrainVault v1

Memory-hard brainwallet construction. Derive the same wallet from the exact same name, passphrase, and work settings.

**Algorithm:** Argon2id (256MB shards) + BLAKE3
**Security:** Forces attackers to use RAM, not just CPU
**Compatibility:** Same inputs = same wallet on any device

## Usage

```bash
# Run immediately without installing. The bundled C/NEON engine is the default
# on Apple Silicon; other platforms fall back to portable native Argon2.
bunx brainvault

# Or install the command globally.
bun add --global brainvault
brainvault

# Recommended interactive path: asks only username + password, then uses
# factor 4 (1,000 shards), multiplier 1, and all CPU cores allowed by RAM.
bun run bv

# Advanced path: also asks factor/shards, multiplier, and workers.
bun run bv --ask

# Programmatic
import { createShardSalt, deriveShard, combineShards } from './brainvault/core.ts';

# Compatibility vectors
bun test brainvault/core.test.ts
```

The public npm name `brainvault` currently points at the existing 1.x package.
This source is packaged as the intentionally breaking 2.0 release because its
CLI and frozen derivation format replace the old `generate`/`verify` binaries.
Publishing requires an npm login for the existing package maintainer.

```bash
npm login
npm publish
```

## Self-contained package

This directory is the complete npm package boundary. Nothing above
`brainvault/` is required after installation:

- bundled Apple Silicon executables under `prebuilds/darwin-arm64/` are the
  fastest default for the frozen multiplier-1 mode at 100+ shards; smaller jobs
  use the lower-overhead portable native path;
- `@node-rs/argon2` is the portable native fallback and handles custom multipliers;
- `hash-wasm` is the cross-platform compatibility engine;
- `experimental/argon2-c/` contains the complete C/NEON source and vendored
  Argon2/SSE2NEON dependencies;
- `experimental/argon2-rust/` contains the complete Rust source, locked Cargo
  dependencies, and secure/final-wipe build variants;
- `experimental/benchmark.ts` performs the canonical 1,000-shard sequential
  backend comparison; `brainvault --smoke` uses the same harness with 2 shards.

```bash
# Portable engines work immediately after npm/Bun installation.
bunx brainvault --bench

# Quick 2-shard cross-engine root-parity check.
bunx brainvault --smoke

# Optional: build every local experimental native backend, then benchmark all.
bun run build:experimental
bun run bench
```

## Files

- `primitives/spec.ts` - frozen V1 constants and shard salt
- `primitives/kdf.ts` - Argon2id shard derivation
- `core.ts` - shard combination and wallet derivation API
- `bip39-english.ts` - embedded canonical wordlist
- `primitives/encoding.ts` - strict hex boundaries
- `cli.ts` - CLI tool
- `native.ts` - bounded native orchestration used by Bun nodes
- `worker-browser.ts` - browser worker source
- `worker-native.ts` - Bun worker (@node-rs/argon2)
- `worker-wasm.ts` - Bun compatibility worker (hash-wasm)
- `core.test.ts` - test vectors
- `experimental/` - reproducible 1,000-shard cross-backend benchmarks

## Frozen Spec

All parameters locked for 20+ year compatibility. DO NOT CHANGE.

Name and passphrase must each contain at least one character. They remain exact inputs: leading/trailing whitespace is significant, then V1 applies NFKD normalization. There is no trimming or compatibility path.

A node-owned recovery mnemonic is stored as plaintext JSON in the configured operator file with mode `0600`. Mode `0600` limits operating-system access; it is not encryption. Disk snapshots and backups can copy the mnemonic, so encrypt and restrict those backups. Export is available only through the explicit authenticated admin reveal action.

The repository exposes one CLI route: `bun run bv`. The implementation and every cryptographic source remain inside this directory; do not add root-level wrapper files.
