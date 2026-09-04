# BrainVault v1

Memory-hard deterministic wallet derivation. The same V1 semantic inputs produce
the same wallet in every conforming implementation.

**Algorithm:** Argon2id (256 MiB shards) + BLAKE3
**Security:** Raises the time and memory cost of every password guess; it does not add entropy
**Compatibility:** Engine and worker count affect speed only, never the V1 wallet

## Usage

Run only BrainVault from a source checkout; no XLN service or frontend starts:

```bash
git clone https://github.com/xlnfinance/xln.git
cd xln/brainvault
bun install --frozen-lockfile --ignore-scripts
bun ./brainvault --smoke
bun ./brainvault

# Optional: sequential 1,000-shard comparison of every compatible engine.
bun ./brainvault --bench
```

```bash
# Run immediately without installing. The bundled Metal V1 + C/NEON hybrid is
# the default for 1,000+ shards on the measured M3 Ultra. Auto chooses one
# available verified engine before starting; a runtime engine failure is fatal.
# BrainVault has no install/build lifecycle script. On supported Apple Silicon it
# hash-verifies its bundled prebuild before use. bunx still registry-resolves npm
# dependencies; audit them against dependency-lock.audit or use the source flow below.
bunx brainvault

# Or install the command globally.
bun add --global brainvault
brainvault

# Recommended interactive path: asks only username + password, then uses
# level 4 (exactly 10,000 shards), multiplier 1, and all CPUs allowed by RAM.
bun ./brainvault

# Optional: generate ten random a-z/A-Z/0-9 characters (59.54 bits while
# undisclosed) with unbiased OS-CSPRNG choices in a temporary sensitive screen.
# A same-run repeat checks only transcription.
bunx brainvault --suggest-password

# Default success output is only the root fingerprint and first address.
# At the final password confirmation, Enter exits; the exact password reveals mnemonics.
bunx brainvault

# Optional convenience on a private screen: echo password/confirmation input.
# The password can remain in scrollback, recordings, logs, tmux, or photos.
bunx brainvault --show-password

# Advanced path: also asks level, multiplier, workers, and any available engine.
bun ./brainvault --ask

# Every advanced value can be supplied inline; --ask prompts only missing values.
bunx brainvault --ask --level 3 --multiplier 1 --workers 32 --engine metal
bunx brainvault --bench --level 3 --multiplier 10 --workers 32

# Levels select exact shards: 1 / 100 / 1,000 / 10,000 / 100,000 / 1,000,000.
# They are work presets, not password-security ratings. Levels 1-2 are test/
# legacy compatibility modes and must not be funded; level 4 is recommended.
# Ten shards is no longer a creation preset, but exact legacy recovery remains:
bunx brainvault --ask --shards 10

# Programmatic (from xln/brainvault)
import { createShardSalt, deriveShard, combineShards } from './core.ts';

# Compatibility vectors
bun test core.test.ts
```

BrainVault has one frozen protocol: V1. The npm package version is only the
immutable build/release number required by the registry; it is not a protocol
version. Future fixes must preserve every V1 root and frozen test vector.

## Live terminal demo

[Watch the real 19-second Ghostty recording](https://github.com/xlnfinance/xln/blob/main/brainvault/media/brainvault-terminal-demo.mp4).
It runs the actual CLI and default Metal/C/NEON engine with 1,000 real shards;
`satoshi` / `hard2guess` and every displayed seed are public demo material and
must never receive funds. The optional `--promo` flag adds only the opening and
closing `brainvault.sh` cards; it is off by default and never changes derivation.

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
engines; it is never selected automatically. Multiplier 1 is the portable
choice and avoids the proportional custom-memory cost. The Metal CPU/GPU hybrid
is automatic only for the exact measured M3 Ultra profile; other Macs default
to verified C/NEON or portable native code unless the owner explicitly selects
and benchmarks another engine.

## Measured M3 Ultra benchmark

Canonical 1,000-shard run on 2026-09-02: Apple M3 Ultra, 32 CPU cores
(24 performance + 8 efficiency), 80 GPU cores, 512 GiB unified memory,
macOS 26.6.2, Bun 1.4.0. Engines ran sequentially. The production Metal profile
was 640 GPU shards across eight processes with 40 workers each, plus 360 shards
across 32 CPU workers.

```bash
bun ./brainvault --bench
```

| Engine | Time | Shards/s | vs fastest |
| --- | ---: | ---: | ---: |
| (experimental) Metal generic + C/NEON hybrid | 2.438s | 410.18 | 1.00x |
| **Metal V1 + C/NEON hybrid (default)** | **2.478s** | **403.62** | **1.02x** |
| (experimental) OpenCL + C/NEON hybrid | 3.167s | 315.80 | 1.30x |
| (experimental) C/NEON per-shard wipe | 5.448s | 183.54 | 2.23x |
| C/NEON final wipe | 5.497s | 181.92 | 2.25x |
| (research-only) Native direct async | 6.147s | 162.69 | 2.52x |
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

The exact `standard` default of 10,000 shards now uses a separately measured
8,000 Metal / 2,000 C split while retaining eight Metal processes, 40 Metal
workers per process, 32 CPU workers, private storage, and 88 GiB of live arenas.
In a 3+3 alternating comparison it reduced the median from **20.169s** to
**14.064s** (**30.27% faster**); the production CLI then completed in 14.379s.
Every run produced the frozen default-work root
`5557e8b96514ba45d0f3af0450616c68d41625731a8de9fbe54046cce1de0298`.
This profile is exact rather than extrapolated: 1,000 shards remain 640/360,
and unmeasured custom, level-5, and level-6 counts retain their prior plan.

## Independent AI review

Two independent post-fix reviews of the same executable candidate returned
**1000/1000 PASS** with no findings. GPT-5.6 Sol at max effort reported:
“All ten remediations are present in shipped source with targeted regression
assertions.” Claude Opus 5 at max effort independently verified the same fixes,
including the hard failure: “Domain cannot contain terminal control characters.”

These reviews are advisory social proof, not formal security certification.
Only completed verdicts are counted; timed-out or unavailable models are not.
They supplement rather than replace the frozen vectors, manifest, reproducible
native builds, release matrix, and direct source review described below.

## No recovery receipt by design

BrainVault intentionally writes no recovery file, QR code, seed receipt, or
cloud record. A record containing a password or mnemonic would be a bearer
secret. A settings-only note is not itself a spending secret, but it is still an
artifact to preserve and can link public wallet metadata; this CLI deliberately
keeps recovery memory-only. Forgetting the exact Username, Password, Shard count,
or Multiplier permanently loses access. Engine and worker count may change and
are not recovery inputs. The default is deliberately simple: level 4 and
multiplier 1.

`--suggest-password` is opt-in. It makes ten independent unbiased choices from
`a-zA-Z0-9` using the operating-system CSPRNG: 62^10 possibilities, or 59.54
bits while the result remains undisclosed. It displays the result once in the
same isolated alternate screen used for recovery words, then requires exact
re-entry and erases that screen. This checks transcription only, not long-term
memory. Recordings, terminal logging, photographs, swap, and crash dumps remain
outside BrainVault's control. Use a trusted private device and perform a fresh
independent recovery before sending funds.

After derivation BrainVault prints only an eight-hex root fingerprint and the
first receiving address, then shows one password-confirmation prompt. The
fingerprint is only a quick visual check; the full first address is the
authoritative recovery check. Enter exits. Entering the exact password opens the
mnemonic and address matrix in the terminal's alternate screen. Enter, Ctrl+C,
SIGTERM, or SIGHUP erases that view and returns to ordinary scrollback, which
still contains only the privacy-sensitive public result. This cannot defeat
screen recording, tmux logging, terminal capture, photography, SIGKILL, OS swap,
or crash dumps. Any wrong password fails closed. `--show-private-key` adds raw
keys only after the same confirmation. `--reveal` requests an early
sensitive-terminal capability check; it remains a compatibility alias and never
bypasses confirmation or reveals anything by itself. Passwords are forbidden in
argv; automation must import the library API.

`--show-password` is an explicit convenience trade-off for a trusted private
screen. It echoes every password and confirmation entry, so those characters can
remain in ordinary terminal scrollback or a recorded session. It never accepts
the password through argv and does not change derivation. Hidden input remains
the default.

Site passwords from `--password` use the same temporary alternate screen and
are erased after acknowledgement. BrainVault refuses interactive password input
from pipes or redirects and refuses secret disclosure when the terminal cannot
provide the isolated screen.

## Long-term recovery practice

- Before funding, start a fresh BrainVault process, re-enter everything from
  memory, and compare the complete first receiving address.
- Repeat that independent check periodically. A same-process password
  confirmation only authorizes display; it is not a recovery test.
- Preserve authenticated public copies of `SPEC-V1.md`, `vectors-v1.json`, the
  source, and exact release artifact. They contain no wallet secret.
- Engine and worker count may change. Username, Password, exact Shard count,
  Multiplier, and V1 semantics may not.
- No tool can promise that unaudited future hardware and software will remain
  available for 100 years; the small frozen specification and vectors are the
  portability mechanism.

## Wallet import

Import either displayed mnemonic as an existing BIP-39 wallet and leave the
optional BIP-39 passphrase empty. Never enter the BrainVault Password into that
field: V1 deliberately derives both mnemonics with an empty BIP-39 passphrase.
The 24-word PRIMARY and 12-word SECONDARY are separate wallets with separate
addresses. Verify the corresponding first receiving address before sending funds.

Every interactive engine shows the same dependency-free, two-line terminal
progress display. Native workers report completed shards over an opt-in stderr
protocol, so the prominent percentage and exact completed/total count are real;
rate and ETA are live estimates. The display respects `NO_COLOR`, turns green,
and reports 100% only after every shard is validated and the root has been
derived successfully.

## Self-contained package

This directory is the complete npm package boundary. Nothing above
`brainvault/` is required after installation:

- bundled Apple Silicon executables and Metal library under
  `prebuilds/darwin-arm64/` provide the fastest default for frozen multiplier-1
  mode at 1,000+ shards only on the measured 32-CPU-core, approximately
  512-GiB M3 Ultra configuration. Other Apple Silicon selects C/NEON for jobs
  of at least 100 shards when its verified prebuild is present, otherwise the
  portable native path. Selection happens before derivation; any runtime engine
  failure is fatal and never silently switches to another engine;
- `@node-rs/argon2` is the portable native fallback and handles custom multipliers;
- `hash-wasm` is the cross-platform compatibility engine;
- `experimental/argon2-c/` contains the complete C/NEON source and vendored
  Argon2/SSE2NEON dependencies;
- `experimental/argon2-rust/` contains the complete Rust source, vendored locked
  Cargo dependencies, and secure-wipe/no-wipe comparison variants. Its offline
  build emits an Apple M1 baseline plus a separate M3-family prebuild; M3 Macs
  select the latter and other Apple Silicon Macs use the M1-compatible binary.
  Every shipped Apple executable and Metal library targets macOS 11.0;
- `experimental/argon2-metal/` contains the complete native Apple GPU source,
  raw parity harness, generic kernel, frozen-V1-specialized kernel, and retained
  upstream MIT notice. On the measured 80-GPU-core, 512-GiB M3 Ultra, the
  1,000-shard benchmark uses 640 Metal / 360 C shards and the exact 10,000-shard
  default uses 8,000 / 2,000. Both use eight Metal processes with 40 workers
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
  isolated native, Rust, and WASM engine with a reference measurement from one
  M3 Ultra; actual speed depends on hardware and load.
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
  Eight characters is input hygiene, not a security recommendation; a weak or
  reused password remains unsafe at every work level.
- new CLI creation accepts printable ASCII only. `--unicode-recovery` retains
  V1 NFKD/UTF-8 recovery for terminal-representable Unicode. Use the library API
  for control-character values a line-oriented terminal cannot represent exactly.

## Repository topology

The sole canonical source is `brainvault/` on the `main` branch of
`xlnfinance/xln`. Keeping it here shares XLN's history, review, issues, and stars
without coupling the package at runtime: the directory remains independently
packable and needs nothing above it after installation.

Do not convert it into a submodule. A submodule would replace the audited files
with a movable repository pointer, complicate fresh clones, and introduce a
second release boundary. Do not create a mirror until independent repository
discovery is worth that operational cost; if that decision is made later, name
one source of truth before copying history.

```bash
# Portable engines work immediately after npm/Bun installation.
bunx brainvault --bench

# Quick 2-shard cross-engine root-parity check.
bunx brainvault --smoke

# Explicit trust check from a source checkout: build every native artifact
# offline in clean temporary directories and compare bytes with every prebuild.
bun run verify:source

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

## Ultra-paranoid source verification

Do not use `bunx` for the first run when the native binary itself is inside the
threat model: `bunx` intentionally downloads and executes in one operation.
Start from an immutable source commit authenticated by a signed release tag
through an independent channel. Treat the npm tarball only as a delivery
artifact: compare its complete manifest with a package made from that audited
source before trusting it. Never regenerate `MANIFEST.sha256` during an audit;
doing so would replace the release evidence with hashes of the current files.

1. Audit the frozen root path first: `SPEC-V1.md`, `vectors-v1.json`,
   `primitives/spec.ts`, `primitives/kdf.ts`, `canonical.ts`, then the wallet
   projection and disclosure files listed below.
2. Audit `package.json` and `bun.lock`, including every exact version and
   registry integrity. For native code, inspect the complete C, Rust, Metal,
   and OpenCL source plus licenses and checksums under `experimental/**/vendor/`.
   BrainVault has no install lifecycle script.
3. Populate a clean Bun cache only with packages whose source and integrity
   match the audited `bun.lock`, then disconnect the network. Install from that
   cache with lifecycle scripts disabled and the lock frozen; a cache miss must
   fail instead of reaching the registry.
4. On Apple Silicon, run the source verifier. It uses locked vendored inputs,
   an empty Cargo home, and clean temporary output directories; it builds every
   M1/M3 native artifact twice and requires byte-for-byte equality with every
   bundled prebuild. A missing toolchain or any mismatch is a hard failure,
   never an automatic fallback.
5. Run the complete deterministic and release matrices, then the cross-engine
   smoke. Only after all of them pass should the audited package see a real
   Username or Password.

```bash
cd brainvault
bun install --offline --frozen-lockfile --ignore-scripts
bun test historical.test.ts
bun run verify:source
bun run check
bun run test:matrix
bun ./brainvault --smoke --workers 32

# macOS: keep the actual recovery run offline as an additional boundary.
bv_bun="$(command -v bun)"
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' "$bv_bun" ./brainvault
```

There is intentionally no generic `bun run build` trust shortcut. TypeScript is
executed directly by Bun, while a successful native compile proves only that a
compiler emitted bytes. `bun run verify:source` is the stronger gate: build
twice from the audited vendored source, normalize the Mach-O signatures, compare
the builds to each other, and compare them with the shipped prebuilds.

After `verify:source`, running the bundled executable is running the same bytes
that were just rebuilt: the verifier compared the normalized, ad-hoc-signed
Mach-O files exactly, and the CLI rechecks their release-manifest hashes before
execution. It deliberately does not copy an unverified local build into place.

This procedure proves source/artifact reproducibility on that toolchain; it
does not prove that the reviewed source is correct or that the compiler, OS,
firmware, terminal, camera environment, swap, or crash-dump policy is trusted.
For the strongest practical recovery, use a clean private machine, no tmux or
recording, an independently authenticated release, and a second fresh
derivation that compares the complete first receiving address before funding.

`AGENTS.md` is the package-local contract for coding agents. It keeps V1 frozen,
maps the ownership layers, requires a failing regression test before a bug fix,
and routes CLI, native, package, and release changes to their exact verification
gates. Agents should reload it after a long-session context compaction.

## Exact audit surface

Audit the smallest security claim first. The canonical 32-byte root is defined
by exactly these files:

1. `SPEC-V1.md` — normative byte-level protocol;
2. `primitives/spec.ts` — frozen constants, normalization, and shard salts;
3. `primitives/kdf.ts` — one explicitly parameterized Argon2id shard;
4. `canonical.ts` — factor, domain string, ordered shard fold, and fingerprint;
5. `vectors-v1.json` — external expected bytes and roots.

The executable TypeScript root implementation in items 2–4 is currently 289
lines. It has no CLI, filesystem, network, wallet UI, or native scheduler. Audit
its two cryptographic imports against the exact versions and integrity hashes in
the source checkout's `bun.lock`: `hash-wasm` for Argon2id and
`@noble/hashes` for BLAKE3. npm pack omits lockfiles by design, so the shipped
`dependency-lock.audit` is a byte-identical, manifest-covered audit copy;
`package.test.ts` fails if it differs from `bun.lock`.

Expand the audit only for the property being trusted:

| Property | Additional exact files |
| --- | --- |
| Mnemonics and Ethereum paths | `core.ts`, `bip39-english.ts`, `primitives/encoding.ts` |
| CLI input and secret disclosure | `cli-policy.ts`, `suggestion.ts`, `cli.ts`, `core.test.ts` |
| Worker ordering and failure | `shard-collector.ts`, `native.ts`, `worker-native.ts`, `worker-wasm.ts` |
| Default M3 Ultra acceleration | `binary-integrity.ts`, `native-hybrid.ts`, `native/progress.ts`, `experimental/argon2-c/brainvault_argon2.c`, `experimental/argon2-metal/brainvault_argon2_metal.m`, `experimental/argon2-metal/argon2.metal` |
| Native build inputs | the two relevant `Makefile`s plus every source/header named by their `SOURCES` and `HEADERS` variables |
| npm/release integrity | `package.json`, `manifest.ts`, `package.test.ts`, `native-build.test.ts`, `release.md`; in a source checkout only, `historical.test.ts` |

`MANIFEST.sha256` covers every shipped file, but it is not a substitute for a
signed release. `native-build.test.ts` independently rebuilds native artifacts
and requires byte equality with the bundled executables.

## Licensing

The BrainVault core and CLI are MIT-licensed. The tarball also carries a
separate optional OpenCL experiment and its corresponding source under
GPL-2.0-or-later, as documented in `experimental/argon2-opencl/NOTICE`; package
metadata therefore declares the aggregate distribution as
`MIT AND GPL-2.0-or-later`. Each bundled third-party component retains its own
license and notices.

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
11. BrainVault intentionally writes no recovery receipt, seed file, QR, or
    network record. Suggested passwords are ten independent unbiased OS-CSPRNG
    selections from the exact 62-character a-z/A-Z/0-9 alphabet and are not
    intentionally written by BrainVault.
12. Default CLI output contains only the root fingerprint and first public
    address. Mnemonics require exact interactive password confirmation after
    derivation; password argv and unconfirmed private-key output are rejected.

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
- source `bun.lock` freezes exact dependency versions and registry tarball
  integrity; shipped `dependency-lock.audit` is its byte-identical audit copy;
- source-only `historical-v1.json` pins retained historical release tarballs by
  SHA-256; historical archives are deliberately not nested inside the npm package;
- `release.md` defines signed, multi-archive release procedure.

There is deliberately no recovery-receipt artifact. A secret-bearing receipt
would become a bearer backup; even a public settings-only receipt would abandon
the CLI's deliberately memory-only recovery model.

## Files

- `AGENTS.md` - compact coding-agent boundaries and verification contract
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

The shipped default test command runs 1–2-shard frozen vectors, default-secret-output tests,
Unicode/NFKD/NUL corpus checks, domain separation, ordered scheduling, malformed
worker results, native worker crash, Ctrl+C, RAM admission, manifest integrity,
worker reuse across worker counts, network-denied derivation, and inert package
install. A source checkout additionally
runs `bun test historical.test.ts` as a release gate over retained archives.

Release candidates additionally run `release-matrix.test.ts` against frozen
roots in `matrix-v1.json` once for every pair in workers `1/2/8/32` and
multiplier `1/2/10`. Each case uses at least as
many shards as workers and runs engines sequentially. WASM is expected only up
to multiplier 7; multiplier 10 tests all seven engines physically representable
inside their address space. Periodic 1,000-shard/32-worker runs remain thermal
and OOM evidence rather than a per-commit gate.
The canonical 1,000-shard benchmark root is also frozen there, so even a
single-engine production timing fails rather than merely printing a changed root.

Source-only `historical.test.ts` hashes each archived tarball and extracts pinned
source and vector artifacts strictly as inert data; historical package code is
never executed, and nested historical archives are excluded from npm.
`package.test.ts` packs a real `.tgz`, installs it into an
empty directory with `--offline --ignore-scripts`, checks the allowlist and
lifecycle-script absence, then runs its launcher and two-shard smoke test.

## Frozen Spec

All parameters locked for 20+ year compatibility. DO NOT CHANGE.

Name and passphrase must each contain at least one character. They remain exact inputs: leading/trailing whitespace is significant, then V1 applies NFKD normalization. There is no trimming or compatibility path.

The standalone BrainVault package does not intentionally persist a mnemonic,
root, password, receipt, or recovery file. Sensitive output exists only after
interactive password confirmation. Operating-system swap, crash dumps, terminal
logging, recordings, and photographs remain outside that guarantee.

From the monorepo root the CLI route is `bun run bv`; from this package directory
it is `bun ./brainvault`. The implementation and every cryptographic source
remain inside this directory; do not add root-level wrapper files.
