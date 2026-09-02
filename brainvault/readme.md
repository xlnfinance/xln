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
# level 3 (exactly 1,000 shards), multiplier 1, and all CPUs allowed by RAM.
bun run bv

# Optional: generate ten random a-z/A-Z/0-9 characters (59.54 bits) with
# unbiased OS-CSPRNG choices, display once, and require hidden re-entry.
bunx brainvault --suggest-password

# Default success output is only the root fingerprint and first address.
# Reveal mnemonics only after an exact hidden password rehearsal.
bunx brainvault --reveal

# Advanced path: also asks level, multiplier, workers, and any available engine.
bun run bv --ask

# Every advanced value can be supplied inline; --ask prompts only missing values.
bunx brainvault --ask --level 3 --multiplier 1 --workers 32 --engine c-neon
bunx brainvault --bench --level 3 --multiplier 10 --workers 32

# Levels select exact shards: 1 / 100 / 1,000 / 10,000 / 100,000 / 1,000,000.
# Ten shards is no longer a creation preset, but exact legacy recovery remains:
bunx brainvault --ask --shards 10

# Programmatic
import { createShardSalt, deriveShard, combineShards } from './brainvault/core.ts';

# Compatibility vectors
bun test brainvault/core.test.ts
```

BrainVault has one frozen protocol: V1. The npm package version is only the
immutable build/release number required by the registry; it is not a protocol
version. Future fixes must preserve every V1 root and frozen test vector.

## Hardware defaults

The portable default targets the entry 14-inch MacBook Pro with M5: 16GB
unified memory, 10 CPU cores, and 153GB/s memory bandwidth. Level 3,
multiplier 1, and all 10 cores need 2.5GB of Argon2 arenas, so the same default
remains practical on the least-expensive current MacBook Pro. BrainVault still
calculates the worker ceiling from the actual CPU and RAM at runtime.

`--ask` keeps multiplier 1 as the recommendation on every machine. On machines
with abundant memory it also prints a memorable power-of-two `ultra`
memory-hard option sized to about 25% of RAM across all CPU workers. For
example, 32 workers yield multiplier 8 on 256GB (64GB arenas) and multiplier 16
on 512GB (128GB arenas). This option is stronger but proportionally slower,
changes the root, must be remembered for recovery, and currently uses the CPU
engines; it is never selected automatically. Multiplier 1 is both the portable
choice and the fastest path, including the experimental CPU/GPU hybrid.

## No recovery receipt by design

BrainVault does not create a recovery file, QR code, seed receipt, or cloud
record. Such an artifact would become a bearer backup with the same loss,
theft, photography, and copying risks BrainVault is designed to avoid. Recovery
means remembering the exact username and passphrase plus the level and
multiplier. The default is deliberately memorable: level 3, multiplier 1.

`--suggest-password` is opt-in. It makes ten independent unbiased choices from
`a-zA-Z0-9` using the operating-system CSPRNG: 62^10 possibilities, or 59.54
bits. It displays the result once and requires exact hidden re-entry. Terminal
scrollback may retain that display, so use it only on a trusted device.

After derivation BrainVault prints only an eight-hex root fingerprint and the
first public address. Enter exits. Typing `reveal`, or starting with
`--reveal`, requires the exact password again before any mnemonic or address
matrix is printed. `--show-private-key` additionally requires `--reveal`.
Passwords are forbidden in argv; automation must import the library API.

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
  dependencies, and secure-wipe/no-wipe comparison variants;
- `experimental/argon2-metal/` contains the source-only Apple GPU research
  engine, raw parity harness, and retained upstream MIT notice. It is slower
  than C/NEON on M3 Ultra and is not used for wallet creation;
- `experimental/benchmark.ts` performs the canonical 1,000-shard sequential
  backend comparison; each timing includes the first four root bytes, and
  `brainvault --smoke` uses the same harness with 2 shards;
- `--ask` exposes every available C/NEON, direct native, isolated native, Rust,
  and WASM engine while showing the latest 1,000-shard / 32-worker Mac speed.
  Research variants remain fully selectable and are prefixed `(experimental)`;
- `--level`, `--shards`, `--factor`, `--multiplier`, `--workers`, and `--engine`
  accept both `--flag value` and `--flag=value`. `--shards` is always exact;
  `--factor` exists only for legacy recovery. C/NEON and Rust accept exact
  custom memory. WASM remains available through multiplier 7; multiplier 10
  exceeds its wasm32 address space and is rejected before allocation;
- the Rust no-wipe engine remains selectable for parity/performance research,
  but prints an explicit memory-hygiene warning and is never the default;
- the CLI requires at least 8 password characters by default. Existing wallets
  with shorter passwords remain recoverable via `--allow-short-password`.
- new CLI creation accepts printable ASCII only. `--unicode-recovery` retains
  exact V1 NFKD/UTF-8 recovery for Unicode, controls, and legacy edge cases.

```bash
# Portable engines work immediately after npm/Bun installation.
bunx brainvault --bench

# Quick 2-shard cross-engine root-parity check.
bunx brainvault --smoke

# Optional: build every local experimental native backend, then benchmark all.
bun run build:experimental
bun run bench
```

## Audit-first install (no package execution)

`bunx brainvault` downloads and immediately runs the CLI. For an audit, install
the exact immutable npm artifact into a new directory first. Dependency install
scripts are disabled, and BrainVault itself has no `preinstall`, `install`, or
`postinstall` script:

```bash
mkdir brainvault-audit
cd brainvault-audit
bun init -y
bun add --exact --ignore-scripts brainvault@2.0.2
```

The readable package is now in `./node_modules/brainvault/`; nothing has run.
The shared download cache location can be printed with `bun pm cache`. After
the source passes review, run the frozen vectors and the two-shard parity smoke
test directly from that audited copy:

```bash
bun test node_modules/brainvault/core.test.ts
bun node_modules/brainvault/cli.ts --smoke --workers 32
bun node_modules/brainvault/cli.ts
```

Pin both the package version and the registry integrity hash in any serious
deployment. A newer npm build must be audited again even though the protocol is
still BrainVault V1.

## Invariant-style AI audit

Start with exactly these two files:

- `primitives/spec.ts` owns the frozen constants, normalization, and shard salt;
- `canonical.ts` owns the entire ordered root fold and has no CLI, workers,
  ethers, filesystem, or network imports.

Then follow only their direct derivation imports, especially
`primitives/kdf.ts`, and ask a local AI to check this plain-English contract:

```text
Audit this installed BrainVault package. Begin with primitives/spec.ts and
canonical.ts, then follow only their direct derivation imports. Do not assume that
comments, README claims, native binaries, or benchmark output are correct.

First assess and explain the security model honestly: human-memorable inputs
have limited and highly variable entropy, and Argon2id cannot create missing
entropy. BrainVault instead lets a person choose a tolerable recovery wait via
the shard count; every candidate guess must pay that memory-hard work. Evaluate
how much resistance that delay buys for the stated password strength, hardware,
parallelism, and attacker budget. Never describe waiting time alone as proof
that a weak or reused password is safe.

Approve only if source and frozen tests prove every invariant below:

1. The exact same username, password, shard count/factor, and multiplier always
   produce the exact same 32-byte root.
2. Engine, worker count, completion order, timing, and platform cannot change
   that root; shard results are combined strictly by numeric shard index.
3. Username and password use explicit NFKD then UTF-8. Whitespace and case are
   significant. The shard salt binds the algorithm ID, shard count, and index.
4. Canonical shards use Argon2id v0x13, 256 MiB, time cost 1, parallelism 1,
   and 32 output bytes. No library default supplies a protocol parameter.
5. Multiplier 1 uses the canonical frozen algorithm ID. A custom multiplier
   changes both memory and domain separation and can never alias multiplier 1.
6. Final combination uses BLAKE3 with every KDF parameter, shard count, and
   frozen factor in its domain. Randomness, clock, network, and machine state
   never enter derivation.
7. Every shipped engine matches the frozen vectors and cross-engine root tests.
   A faster engine may change timing only, never semantics.
8. The npm package has no preinstall/install/postinstall script, derivation is
   self-contained, and no required source or binary lives above the package.
9. The CLI's eight-character minimum is UX policy only. Protocol V1 accepts
   every non-empty legacy password, recoverable with --allow-short-password.
10. User levels map only to exact shard counts: 1/100/1,000/10,000/100,000/
    1,000,000. They never renumber the frozen factor: level 3 uses 1,000 shards
    and internal factor 4. Exact 10-shard legacy recovery remains reproducible.
11. No recovery receipt, seed file, QR, or network record is created. Suggested
    passwords are ten independent unbiased OS-CSPRNG selections from the exact
    62-character a-z/A-Z/0-9 alphabet and are never written by BrainVault.
12. Default CLI output contains only the root fingerprint and first public
    address. Mnemonics require explicit reveal plus exact hidden rehearsal;
    password argv and un-rehearsed private-key output are rejected.

Reject the package if any invariant is false, is not tested, or cannot be
traced to executable source. Report exact file and line evidence for each item.
```

## Canonical artifacts

- `SPEC-V1.md` defines every normative byte without relying on a particular
  implementation or library API;
- `vectors-v1.json` freezes normalized input bytes, salts, shard outputs, roots,
  mnemonic projections, and first Ethereum addresses;
- `MANIFEST.sha256` detects drift between the co-shipped canonical source,
  native source, and binaries. It intentionally does not hash itself. Release
  provenance must come separately from the signed tag/tarball and registry
  integrity; a manifest shipped beside its files is not an independent signature.
- `bun.lock` freezes exact dependency versions and registry tarball integrity;
- `historical-v1.json` pins retained historical release tarballs by SHA-256;
- `release.md` defines signed, multi-archive release procedure.

There is deliberately no recovery-receipt artifact. A receipt would recreate a
physical bearer backup and undermine the memory-only recovery model.

## Files

- `primitives/spec.ts` - frozen V1 constants and shard salt
- `SPEC-V1.md` - normative byte-level V1 specification
- `vectors-v1.json` - external frozen compatibility vectors
- `MANIFEST.sha256` - canonical source and binary hashes
- `primitives/kdf.ts` - Argon2id shard derivation
- `canonical.ts` - minimal ordered root fold with no wallet/I/O dependencies
- `core.ts` - wallet projection and public derivation API
- `bip39-english.ts` - embedded canonical wordlist
- `primitives/encoding.ts` - strict hex boundaries
- `presets.ts` - user-facing levels mapped to exact V1 shard counts
- `suggestion.ts` - optional ten-character alphanumeric CSPRNG suggestion
- `brainvault` - extensionless Bun launcher used by npm/bunx
- `cli.ts` - CLI tool
- `native.ts` - bounded native orchestration used by Bun nodes
- `worker-browser.ts` - browser worker source
- `worker-native.ts` - Bun worker (@node-rs/argon2)
- `worker-wasm.ts` - Bun compatibility worker (hash-wasm)
- `core.test.ts` - test vectors
- `experimental/` - reproducible 1,000-shard cross-backend benchmarks

## Canonical test ladder

Every commit runs 1–2-shard frozen vectors, default-secret-output tests,
Unicode/NFKD corpus checks, domain separation, ordered scheduling, malformed
worker results, native worker crash, Ctrl+C, RAM admission, manifest integrity,
network-denied derivation, historical tarball hashes, and inert package install.

Release candidates additionally run `release-matrix.test.ts` against frozen
roots in `matrix-v1.json` once for every pair in workers `1/2/8/32` and
multiplier `1/2/10`. Each case uses at least as
many shards as workers and runs engines sequentially. WASM is expected only up
to multiplier 7; multiplier 10 tests all seven engines physically representable
inside their address space. Periodic 1,000-shard/32-worker runs remain thermal
and OOM evidence rather than a per-commit gate.

`historical.test.ts` hashes each archived tarball and extracts pinned source and
vector artifacts strictly as inert data; historical package code is never
executed. `package.test.ts` packs a real `.tgz`, installs it into an
empty directory with `--offline --ignore-scripts`, checks the allowlist and
lifecycle-script absence, then runs its launcher and two-shard smoke test.

## Frozen Spec

All parameters locked for 20+ year compatibility. DO NOT CHANGE.

Name and passphrase must each contain at least one character. They remain exact inputs: leading/trailing whitespace is significant, then V1 applies NFKD normalization. There is no trimming or compatibility path.

The standalone BrainVault package never persists a mnemonic, root, password,
receipt, or recovery file. Sensitive output exists only after reveal rehearsal.

The repository exposes one CLI route: `bun run bv`. The implementation and every cryptographic source remain inside this directory; do not add root-level wrapper files.
