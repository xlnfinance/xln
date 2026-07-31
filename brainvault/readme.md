# BrainVault v1

Memory-hard brainwallet construction. Derive the same wallet from the exact same name, passphrase, and work settings.

**Algorithm:** Argon2id (256MB shards) + BLAKE3
**Security:** Forces attackers to use RAM, not just CPU
**Compatibility:** Same inputs = same wallet on any device

## Usage

```bash
# CLI
bun run bv

# Programmatic
import { createShardSalt, deriveShard, combineShards } from './brainvault/core.ts';

# Compatibility vectors
bun test brainvault/core.test.ts
```

## Files

- `spec.ts` - frozen V1 constants and shard salt
- `kdf.ts` - Argon2id shard derivation
- `core.ts` - shard combination and wallet derivation API
- `bip39-english.ts` - embedded canonical wordlist
- `encoding.ts` - strict hex boundaries
- `cli.ts` - CLI tool
- `native.ts` - bounded native orchestration used by Bun nodes
- `worker-browser.ts` - browser worker source
- `worker-native.ts` - Bun worker (@node-rs/argon2)
- `worker-wasm.ts` - Bun compatibility worker (hash-wasm)
- `core.test.ts` - test vectors

## Frozen Spec

All parameters locked for 20+ year compatibility. DO NOT CHANGE.

Name and passphrase are exact inputs: leading/trailing whitespace is significant, then V1 applies NFKD normalization. Older interactive CLI releases trimmed edge whitespace; recover wallets created there by entering the trimmed values.

The repository exposes one CLI route: `bun run bv`. The implementation and every cryptographic source remain inside this directory; do not add root-level wrapper files.
