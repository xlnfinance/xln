# BrainVault audit map

This guide turns the package into review layers. Do not start with the CLI or a
prebuilt binary. First decide which property you need to trust, then read only
the files that own it.

All line counts below are physical source lines from the 2.2.0 candidate. They
include comments and blank lines and are guarded by package tests. A smaller
number is easier to navigate; it is not proof of safety.

## 1. Root identity — 294 lines

Read in this order:

1. `spec-v1.md` for the normative byte recipe;
2. `../src/core/primitives/spec.ts` for constants, NFKD/UTF-8, salts, and request binding;
3. `../src/core/primitives/kdf.ts` for one fully parameterized Argon2id shard;
4. `../src/core/canonical.ts` for factor math, indexed validation, and ordered BLAKE3;
5. `../tests/data/vectors-v1.json` for independent expected bytes and roots.

The executable files in items 2–4 total 294 physical lines. Required skills:
TypeScript, byte encodings, Unicode normalization, Argon2id, and BLAKE3 domain
separation. They import no CLI, filesystem, network, clock, scheduler, wallet, or
native accelerator code.

## 2. Wallet projection — 603 total lines

Add:

- `../src/core/primitives/encoding.ts` for strict hex boundaries;
- `../src/core/index.ts` for PRIMARY/SECONDARY mnemonics, keys, and addresses;
- the wallet fields in `../tests/data/vectors-v1.json`.

Required skills: BIP-39 with an empty optional passphrase, BIP-32, secp256k1,
Ethereum address derivation, and the `ethers` API. The root and wallet layer
together total 603 physical lines.

## 3. Execution paths

Execution may compute shards differently, but it may never define their meaning.
Every worker response carries an index and complete request fingerprint; the
collector rejects missing, duplicate, malformed, truncated, reordered, or
foreign results before the canonical fold.

| Path | Review | Physical lines | Skills |
| --- | --- | ---: | --- |
| WASM compatibility | `../src/native/workers/wasm.ts`, collector, native orchestrator | included in 1,010 native lines | Web Workers, hash-wasm, transfer buffers |
| Portable native | `../src/native/workers/native.ts`, collector, native orchestrator | included in 1,010 native lines | Bun workers, @node-rs/argon2 |
| Apple C/NEON | native boundary + `../src/native/source/c/brainvault_argon2.c` | 192 first-party C | C11, stdin/stdout framing, memory erasure |
| M3 Ultra Metal hybrid | `hybrid.ts`, collector, children, binary integrity, Metal host/kernel, C bridge | 1,358 Metal + 192 C bridge | Objective-C, Metal, GPU buffers, subprocess isolation |

The complete first-party native orchestration layer outside `source/` and
`prebuilds/` is 1,010 physical TypeScript lines. The Metal host and kernel are
1,358 lines. The C build additionally compiles 13,274 lines of pinned upstream
Argon2/SSE2NEON code. Review vendor hashes/provenance and diff those directories
against upstream; do not treat them as authored BrainVault semantics.

The production M3 Ultra route is:

```text
CLI selects one verified plan before work
                 ↓
src/native/hybrid.ts fixes indexed CPU/GPU ranges
          ↙                         ↘
C/NEON subprocesses           Metal subprocesses
          ↘                         ↙
src/native/shard-collector.ts validates exact indexed set
                 ↓
src/core/canonical.ts performs the only root fold
```

Inspect these first for that path:

1. `../src/packaging/binary-integrity.ts`;
2. `../src/native/hybrid.ts` and `../src/native/shard-collector.ts`;
3. `../src/native/source/c/brainvault_argon2.c`;
4. `../src/native/source/metal/brainvault_argon2_metal.m`;
5. `../src/native/source/metal/argon2.metal`;
6. `../tests/native-hybrid.test.ts` and `../tests/native-build.test.ts`.

## 4. Disclosure and package boundary

For terminal secrecy, read `../src/cli/policy.ts` before the larger
`../src/cli/index.ts`. Verify pseudo-TTY tests in `../tests/core.test.ts` for
hidden input, confirmation, alternate-screen cleanup, signals, `TERM=dumb`,
non-TTY rejection, `NO_COLOR`, and error sanitization. The CLI directory is
2,296 physical lines; it owns interaction, not derivation semantics.

For supply chain, read:

1. `../package.json` and `dependency-lock.audit`;
2. `../src/packaging/manifest.ts` and `binary-integrity.ts`;
3. `../tests/package.test.ts`;
4. `../tests/native-build.test.ts`;
5. `release.md`.

The packaging implementation is 137 physical lines. Verify that npm lifecycle
hooks are absent, the tarball allowlist is exact, every shipped file other than
the manifest is covered, installs work offline with scripts disabled, binaries
are regular/non-world-writable/hash-matched, and native rebuilds are byte-equal.

## 5. Commands

Run from the package root:

```bash
bun test tests/core.test.ts
bun run check
bun run test:matrix
bun run verify:source
bun ./brainvault --smoke --workers 32
```

The source-only historical gate is:

```bash
bun test tests/historical.test.ts
```

Never regenerate `manifest.sha256` while authenticating a downloaded release;
that would replace evidence with hashes of whatever is currently on disk. In a
release build, regeneration is deliberate and followed by a clean diff review.

## 6. Approval rule

Approve a release only if the specification, implementation, frozen vectors,
all available engines, failure behavior, source/prebuild reproducibility, and
packed artifact agree. A matching root alone establishes compatibility only. It
does not establish terminal secrecy, reliable failures, memory hygiene, or
supply-chain integrity.
