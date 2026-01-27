# BrainVault v1.0

Memory-hard brain wallet. Derive wallet from memorable name + passphrase.

**Algorithm:** Argon2id (256MB shards) + BLAKE3
**Security:** Forces attackers to use RAM, not just CPU
**Compatibility:** Same inputs = same wallet on any device

## Usage

```bash
# CLI
bun brainvault/cli.ts
./xln-cli.ts brainvault

# Programmatic
import { hashName, deriveShard, combineShards } from '@xln/brainvault/core';
```

## Files

- `core.ts` - crypto logic (664 lines)
- `cli.ts` - CLI tool (312 lines)
- `worker-native.ts` - Bun worker (@node-rs/argon2)
- `worker-wasm.ts` - Browser worker (hash-wasm)
- `core.test.ts` - test vectors

## Frozen Spec

All parameters locked for 20+ year compatibility. DO NOT CHANGE.
