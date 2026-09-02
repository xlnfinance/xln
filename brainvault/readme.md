# BrainVault v1

Memory-hard brainwallet construction. Derive the same wallet from the exact same name, passphrase, and work settings.

**Algorithm:** Argon2id (256MB shards) + BLAKE3
**Security:** Forces attackers to use RAM, not just CPU
**Compatibility:** Same inputs = same wallet on any device

## Usage

```bash
# Run immediately without installing. The bundled Metal V1 + C/NEON hybrid is
# the default for 1,000+ shards on the measured M3 Ultra; safe fallbacks are automatic.
bunx brainvault

# Or install the command globally.
bun add --global brainvault
brainvault

# Recommended interactive path: asks only username + password, then uses
# level 4 (exactly 10,000 shards), multiplier 1, and all CPUs allowed by RAM.
bun run bv

# Optional: generate ten random a-z/A-Z/0-9 characters (59.54 bits) with
# unbiased OS-CSPRNG choices, display once, and require hidden re-entry.
bunx brainvault --suggest-password

# Default success output is only the root fingerprint and first address.
# At the final hidden prompt, Enter exits; the exact password reveals mnemonics.
bunx brainvault

# Advanced path: also asks level, multiplier, workers, and any available engine.
bun run bv --ask

# Every advanced value can be supplied inline; --ask prompts only missing values.
bunx brainvault --ask --level 3 --multiplier 1 --workers 32 --engine metal
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

The portable C/NEON path targets the entry 14-inch MacBook Pro with M5: 16GB
unified memory, 10 CPU cores, and 153GB/s memory bandwidth. Default level 4,
multiplier 1, and all 10 cores need 2.5GB of live Argon2 arenas; its 10,000
shards deliberately take about 10x longer than the quick 1,000-shard level.
Its GPU profile
is deliberately not automatic until it is measured on real M5 hardware.
BrainVault calculates the worker ceiling from the actual CPU and RAM at runtime.

`--ask` keeps multiplier 1 as the recommendation on every machine. On machines
with abundant memory it also prints a memorable power-of-two `ultra`
memory-hard option sized to about 25% of RAM across all CPU workers. For
example, 32 workers yield multiplier 8 on 256GB (64GB arenas) and multiplier 16
on 512GB (128GB arenas). This option is stronger but proportionally slower,
changes the root, must be remembered for recovery, and currently uses the CPU
engines; it is never selected automatically. Multiplier 1 is both the portable
choice and the fastest path, including the default native Metal CPU/GPU hybrid
on supported Macs.

## Measured M3 Ultra benchmark

Canonical 1,000-shard run on 2026-09-02: Apple M3 Ultra, 32 CPU cores
(24 performance + 8 efficiency), 80 GPU cores, 512 GiB unified memory,
macOS 26.6.2, Bun 1.4.0. Engines ran sequentially. The production Metal profile
was 640 GPU shards across eight processes with 40 workers each, plus 360 shards
across 32 CPU workers.

```bash
bun run bv --bench
```

| Engine | Time | Shards/s | vs fastest |
| --- | ---: | ---: | ---: |
| (experimental) Metal generic + C/NEON hybrid | 2.438s | 410.18 | 1.00x |
| **Metal V1 + C/NEON hybrid (default)** | **2.478s** | **403.62** | **1.02x** |
| (experimental) OpenCL + C/NEON hybrid | 3.167s | 315.80 | 1.30x |
| (experimental) C/NEON per-shard wipe | 5.448s | 183.54 | 2.23x |
| C/NEON final wipe | 5.497s | 181.92 | 2.25x |
| (experimental) Native direct async | 6.147s | 162.69 | 2.52x |
| (experimental) Native sync workers | 6.379s | 156.76 | 2.62x |
| Native isolated workers | 6.471s | 154.55 | 2.65x |
| (experimental) Rust pool no wipe | 6.484s | 154.21 | 2.66x |
| (experimental) Rust pool secure | 6.620s | 151.06 | 2.72x |
| TypeScript/WASM | 12.228s | 81.78 | 5.02x |

Every engine produced the frozen root
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.
Times are hardware- and load-dependent; root parity is not. The 40 ms gap
between the two Metal kernels is within observed run-to-run noise, so the
frozen-V1-specialized implementation remains the production default.

The actual `standard` default of 10,000 shards measured **22.329s** on Metal
versus **52.560s** on C/NEON (2.35x faster). Both independently produced the
new frozen default-work root
`5557e8b96514ba45d0f3af0450616c68d41625731a8de9fbe54046cce1de0298`.

## No recovery receipt by design

BrainVault does not create a recovery file, QR code, seed receipt, or cloud
record. Such an artifact would become a bearer backup with the same loss,
theft, photography, and copying risks BrainVault is designed to avoid. Recovery
means remembering the exact username and passphrase plus the level and
multiplier. The default is deliberately memorable: level 4, multiplier 1.

`--suggest-password` is opt-in. It makes ten independent unbiased choices from
`a-zA-Z0-9` using the operating-system CSPRNG: 62^10 possibilities, or 59.54
bits. It displays the result once and requires exact hidden re-entry. Terminal
scrollback may retain that display, so use it only on a trusted device.

After derivation BrainVault prints only an eight-hex root fingerprint and the
first public address, then shows one hidden prompt. Enter exits; entering the
exact password again reveals the mnemonic and address matrix. Any other input
fails closed. `--show-private-key` adds raw keys only after that same rehearsal.
`--reveal` remains an inert compatibility alias for older invocations.
Passwords are forbidden in argv; automation must import the library API.

## Self-contained package

This directory is the complete npm package boundary. Nothing above
`brainvault/` is required after installation:

- bundled Apple Silicon executables and Metal library under
  `prebuilds/darwin-arm64/` provide the fastest default for frozen multiplier-1
  mode at 1,000+ shards on the measured M3 Ultra; unmeasured Apple Silicon and
  smaller jobs use the lower-overhead native
  path, and accelerator failure falls back to C/NEON then portable native;
- `@node-rs/argon2` is the portable native fallback and handles custom multipliers;
- `hash-wasm` is the cross-platform compatibility engine;
- `experimental/argon2-c/` contains the complete C/NEON source and vendored
  Argon2/SSE2NEON dependencies;
- `experimental/argon2-rust/` contains the complete Rust source, locked Cargo
  dependencies, and secure-wipe/no-wipe comparison variants;
- `experimental/argon2-metal/` contains the complete native Apple GPU source,
  raw parity harness, generic kernel, frozen-V1-specialized kernel, and retained
  upstream MIT notice. On the measured 80-GPU-core, 512-GiB M3 Ultra, the
  default uses 640 Metal / 360 C shards, eight Metal processes with 40 workers
  each, 32 CPU workers, and about 88 GiB of live arenas;
- `experimental/argon2-opencl/` contains the complete deprecated OpenCL source
  and retained upstream notices. It remains selectable and benchmarked for
  parity/research, but native Metal is automatic only on the measured M3 Ultra.
  The OpenCL subtree and separate executable are conservatively distributed as
  GPL-2.0-or-later; the CLI and other BrainVault code remain MIT;
- `experimental/benchmark.ts` performs the canonical 1,000-shard sequential
  backend comparison; each timing includes the first four root bytes, and
  `brainvault --smoke` uses the same harness with 2 shards;
- `--ask` exposes every available Metal, OpenCL, C/NEON, direct native,
  isolated native, Rust, and WASM engine while showing the latest Mac speed.
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

## Repository topology

The canonical editable source is this `brainvault/` directory inside the XLN
monorepo. If `xlnfinance/brainvault` is created for discovery and independent
auditing, it should be a one-way subtree mirror, never a second source of truth.
That keeps normal monorepo development while making this self-contained package
look like a standalone repository:

```bash
git subtree split --prefix=brainvault -b brainvault-publish
git push git@github.com:xlnfinance/brainvault.git brainvault-publish:main
```

Do not convert the directory into a submodule. Changes belong in the monorepo
and flow outward to the mirror; never merge independent mirror commits back.

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
bun add --exact --ignore-scripts brainvault@2.1.0
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
    1,000,000. They never renumber the frozen factor: default level 4 uses
    10,000 shards and internal factor 5. Exact 10-shard legacy recovery remains reproducible.
11. No recovery receipt, seed file, QR, or network record is created. Suggested
    passwords are ten independent unbiased OS-CSPRNG selections from the exact
    62-character a-z/A-Z/0-9 alphabet and are never written by BrainVault.
12. Default CLI output contains only the root fingerprint and first public
    address. Mnemonics require exact hidden password rehearsal after derivation;
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
- `manifest.ts` regenerates that manifest from the exact inert npm pack allowlist,
  so every shipped file other than the manifest itself must be covered;
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
- `native-hybrid.ts` - audited CPU/GPU job splitting and ordered collection
- `worker-browser.ts` - browser worker source
- `worker-native.ts` - Bun worker (@node-rs/argon2)
- `worker-wasm.ts` - Bun compatibility worker (hash-wasm)
- `core.test.ts` - test vectors
- `experimental/` - reproducible 1,000-shard cross-backend benchmarks

## Canonical test ladder

Every commit runs 1–2-shard frozen vectors, default-secret-output tests,
Unicode/NFKD/NUL corpus checks, domain separation, ordered scheduling, malformed
worker results, native worker crash, Ctrl+C, RAM admission, manifest integrity,
network-denied derivation, historical tarball hashes, and inert package install.

Release candidates additionally run `release-matrix.test.ts` against frozen
roots in `matrix-v1.json` once for every pair in workers `1/2/8/32` and
multiplier `1/2/10`. Each case uses at least as
many shards as workers and runs engines sequentially. WASM is expected only up
to multiplier 7; multiplier 10 tests all seven engines physically representable
inside their address space. Periodic 1,000-shard/32-worker runs remain thermal
and OOM evidence rather than a per-commit gate.
The canonical 1,000-shard benchmark root is also frozen there, so even a
single-engine production timing fails rather than merely printing a changed root.

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
