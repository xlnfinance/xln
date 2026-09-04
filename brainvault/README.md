# BrainVault

> **Your wallet, mined from memory.**<br>
> You wait once per recovery. An attacker pays for every guess.<br>
> No physical seed required. No account. No server to trust.

BrainVault deterministically recreates two wallets from an exact Username,
Password, Shard count, and Multiplier. It runs locally and intentionally writes
no seed, receipt, account, or cloud record.

This is a different recovery trade, not magic. A random mnemonic has excellent
entropy but becomes a physical bearer secret that can be lost, copied, or found.
BrainVault can remove that artifact; the remembered inputs then become the
recovery boundary. Argon2id makes every guess expensive. It cannot rescue a weak,
reused, forgotten, or mistyped password.

**Recipe:** Argon2id, 256 MiB per shard, followed by an ordered BLAKE3 fold<br>
**Standard work:** 10,000 shards, multiplier 1<br>
**Rule:** engine and worker count change speed only—never the wallet

## Start here

```bash
bunx brainvault
```

BrainVault asks for the exact Username, Password, and how much recovery work you
want. Secrets are never accepted in command-line arguments.
Default output contains only a short fingerprint and the first public address.
Mnemonics appear only after exact password confirmation, on a temporary terminal
screen that is erased on Enter, Ctrl+C, SIGTERM, or SIGHUP.

For serious value, do not make `bunx` your first trusted run. It downloads and
runs in one step. Use the [audit-first path](#audit-first-use) below.

## What must survive

- Your exact Username and Password.
- The exact Shard count and Multiplier. Standard is 10,000 and 1.
- The public BrainVault recipe—not a private seed. Engine and workers do not matter.

The intended model is memory-first. You may write down or back up the password,
but then that copy inherits the same discovery and theft risks as any secret
backup. Forgetting any recovery input permanently loses the wallet.

Before funding, close BrainVault, start a fresh process, enter everything again,
and compare the **complete first receiving address**. Same-process confirmation
only authorizes disclosure; it is not a recovery test.

## Auditor entrance: five files, 603 lines

Do not read the repository alphabetically. Read the ownership chain:

```text
docs/spec-v1.md
        ↓
src/core/primitives/spec.ts     frozen bytes, normalization, salts
src/core/primitives/kdf.ts      one explicit Argon2id shard
        ↓
src/core/canonical.ts           indexed validation + ordered BLAKE3 fold
        ↓
src/core/index.ts               mnemonics, keys, addresses
```

The executable root in `spec.ts + kdf.ts + canonical.ts` is **294 physical
lines**. Adding strict encoding and all wallet projection code makes the complete
portable wallet meaning **603 physical lines**. Neither number includes tests,
blank-line discounts, or generated code.

| What you want to trust | Additional review | Physical lines | Useful skills |
| --- | --- | ---: | --- |
| Same 32-byte root | `src/core/primitives/spec.ts`, `kdf.ts`, `src/core/canonical.ts` | 294 | TypeScript, UTF-8/NFKD, Argon2id, BLAKE3 |
| Same wallets and addresses | add `encoding.ts`, `src/core/index.ts` | 603 total | BIP-39, BIP-32, Ethereum derivation |
| Terminal never reveals by accident | `src/cli/` | 2,296 | Bun, TTY/readline, Unix signals |
| Scheduling cannot change the root | `src/native/` except `source/` and `prebuilds/` | 1,010 | workers, subprocesses, fail-closed validation |
| npm and binary integrity | `src/packaging/` | 137 | tar, SHA-256, Mach-O reproducibility |
| M3 Ultra Metal work | `src/native/source/metal/` host + kernel | 1,358 | Objective-C, Metal, GPU memory model |
| Apple C/NEON work | first-party C bridge | 192 | C11, process I/O, memory wiping |

The C build also compiles **13,274 physical lines of pinned upstream
Argon2/SSE2NEON code**. It is kept in original vendor directories so an auditor
can compare it with upstream; splitting or prettifying it would make provenance
harder to verify. Counts are a navigation aid, not evidence of correctness.

The detailed file-by-file routes, trust boundaries, and commands are in
[`docs/audit.md`](docs/audit.md). Ten-year recovery planning is in
[`docs/recovery.md`](docs/recovery.md).

<details>
<summary><strong>Why does the npm artifact still contain many files?</strong></summary>

The protocol is small; reproducible acceleration is not. Most shipped files are
pinned upstream native source, licenses, frozen vectors, tests, and build inputs.
The repository keeps no more than ten visible first-party entries in each
first-party directory. Upstream vendor trees are the deliberate exception: they
remain intact and mechanically comparable to their original projects.

</details>

## Run options

```bash
# One-off registry run
bunx brainvault

# Install globally
bun add --global brainvault
brainvault

# Exact source checkout
git clone https://github.com/xlnfinance/xln.git
cd xln/brainvault
bun install --frozen-lockfile --ignore-scripts
bun ./brainvault

# Advanced engine/work settings
bun ./brainvault --ask

# Two-shard cross-engine parity smoke
bun ./brainvault --smoke

# Sequential 1,000-shard engine comparison
bun ./brainvault --bench
```

Work levels select exact shard counts: 1, 100, 1,000, 10,000, 100,000, or
1,000,000. Levels 1–2 are test/legacy modes and must not be funded. Work is a
guess-cost setting, not a password-security rating. Exact legacy settings remain
recoverable with `--shards` or `--factor`.

```bash
# Explicit recovery inputs other than secrets are allowed
bunx brainvault --ask --shards 10000 --multiplier 1 --workers 32

# Optional 10-character OS-CSPRNG suggestion (59.54 bits while undisclosed)
bunx brainvault --suggest-password

# Explicitly unsafe convenience: visible typing may survive in recordings/logs
bunx brainvault --show-password

# Site-specific password projection on the same temporary sensitive screen
bunx brainvault --password
```

`--reveal` requests an early sensitive-terminal capability check; it remains a
compatibility alias and never bypasses the final password confirmation.

CLI creation and recovery accept Unicode using the frozen V1 NFKD/UTF-8 rule.
Capitalization and every space remain exact; canonically or compatibility-
equivalent Unicode spellings intentionally normalize to the same bytes.
`--unicode-recovery` is a legacy no-op retained for old recovery instructions.
The CLI requires eight password characters as input hygiene; it is not a safety
claim. Existing short-password wallets remain recoverable with
`--allow-short-password`.

Programmatic use from this directory:

```ts
import { createShardSalt, deriveShard, combineShards } from './src/core/index.ts';
```

## Wallet import

BrainVault produces two **separate wallets**:

- PRIMARY: 24-word BIP-39 mnemonic, standard Ethereum path.
- SECONDARY: 12-word BIP-39 mnemonic, Ledger Live path.

Import either as an existing BIP-39 wallet and leave the optional **BIP-39
passphrase empty**. Never type the BrainVault Password into that wallet field.
Verify the corresponding complete first receiving address before funding.

## Apple Silicon acceleration

All bundled executables are regular, non-world-writable files whose SHA-256 is
checked before execution. There is no install/build lifecycle script. A runtime
engine failure is fatal; BrainVault does not silently switch engines after
derivation starts.

- Apple Silicon uses the verified C/NEON prebuild when eligible. An M1-compatible
  baseline and a separately compiled M3-family binary are shipped.
- The measured 32-core, 80-GPU-core, 512-GiB M3 Ultra profile automatically uses
  Metal + C/NEON for multiplier 1 and at least 1,000 shards.
- Other machines use verified portable paths until that hardware profile has
  repeatable evidence. Custom multipliers remain on CPU engines.

On the measured M3 Ultra, the production 1,000-shard Metal/C hybrid completed in
**2.478 s / 403.62 shards/s**. The standard 10,000-shard profile completed the
production CLI in **14.379 s** after an alternating 3+3 tuning comparison reduced
the scheduling median from 20.169 s to 14.064 s. The 10,000-shard plan uses
8,000 Metal and 2,000 C shards, eight Metal processes, 40 GPU workers per
process, 32 CPU workers, and about 88 GiB of live arenas.

Every benchmarked engine produced the frozen 1,000-shard root:

```text
dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485
```

Timings are specific to one warmed machine and OS. They are not estimates for a
MacBook. The exact benchmark table and raw source-only evidence live under
`docs/evidence/`; root parity proves compatibility, not equal failure handling or
memory hygiene.

## Audit-first use

Install one exact artifact without executing package lifecycle scripts:

```bash
mkdir brainvault-audit && cd brainvault-audit
bun init -y
bun add --exact --ignore-scripts brainvault@2.2.0
```

Nothing in BrainVault has run. Read `node_modules/brainvault/README.md`, then:

1. Authenticate the exact source commit or signed release through another channel.
2. Audit `docs/spec-v1.md`, `tests/data/vectors-v1.json`, and the 603-line path.
3. Audit exact dependencies in `docs/dependency-lock.audit` and `package.json`.
4. Run `bun run verify:source` in the package. On Apple Silicon it builds every
   native artifact twice from vendored source and requires byte equality with
   the bundled prebuilds.
5. Run known answers, package isolation, and the full recovery matrix.
6. Disconnect networking, recover twice, and compare the complete first address.

```bash
cd node_modules/brainvault
bun run verify:source
bun run check
bun run test:matrix
bun ./brainvault --smoke --workers 32
```

There is intentionally no generic `bun run build`. TypeScript runs directly in
Bun, and “it compiled” does not connect reviewed source to the shipped binary.
`verify:source` does: two clean reproducible builds, normalized Mach-O signatures,
build-to-build equality, and equality with every packaged prebuild.

For a source checkout, the maximum-assurance sequence is:

```bash
bun install --offline --frozen-lockfile --ignore-scripts
bun test tests/historical.test.ts
bun run verify:source
bun run check
bun run test:matrix
bun ./brainvault --smoke --workers 32
```

On macOS, the actual recovery can additionally deny network access:

```bash
bv_bun="$(command -v bun)"
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' "$bv_bun" ./brainvault
```

These checks do not prove the compiler, OS, firmware, terminal, camera, swap, or
crash-dump environment trustworthy. Use a clean private device with no recording
or tmux capture. `TERM=dumb` and unreliable terminal geometry are deliberately
refused for secret disclosure. SIGKILL cannot be cleaned up by any process.

## Package map

```text
brainvault/               independently packable boundary
├── brainvault            extensionless bunx/npm launcher
├── src/
│   ├── core/             frozen meaning of roots, wallets, addresses
│   ├── cli/              interaction and disclosure policy
│   ├── native/           scheduling, prebuilds, complete native source
│   └── packaging/        manifest and binary verification
├── tests/                vectors, failures, package and release matrices
├── docs/                 spec, audit/recovery guides, evidence
└── site/                 static brainvault.sh landing page
```

Nothing above this directory is needed after installation. `docs/manifest.sha256`
covers every shipped file except itself. `docs/dependency-lock.audit` is the
manifest-covered copy of `bun.lock`, because npm omits lockfiles. Historical
archives and raw benchmark/audit evidence are source-only and never nested in the
npm tarball.

## Release evidence

The default suite covers frozen vectors, Unicode/NFKD/NUL cases, domain
separation, ordered completion, malformed/duplicate/foreign worker output,
native crashes, secret-output policy, TTY signals, RAM admission, network-denied
derivation, manifest coverage, inert offline installation, and packed launcher
smoke.

```bash
bun test tests/core.test.ts
bun run manifest
bun run check
bun run test:matrix
bun run test:native-release
bun ./brainvault --bench --shards 1000 --workers 32
```

The release matrix freezes all 12 combinations of workers `1/2/8/32` and
multiplier `1/2/10`. Native release verification is a separate reproducibility
gate. See [`docs/release.md`](docs/release.md).

Independent AI reviews are advisory, not certification. Their completed reports
are collapsed into [`docs/perfection-quorum.md`](docs/perfection-quorum.md); only
source, vectors, reproducible artifacts, and executable failure tests carry the
release claim.

## Frozen protocol

BrainVault V1 is permanent. Package versions may improve UX, packaging, failure
handling, and speed, but must preserve every V1 output byte. Never change
normalization, encoding, salt/domain strings, Argon2 parameters, factor math,
shard order, final BLAKE3 fold, multiplier separation, mnemonic projection, or
wallet paths in place. The normative definition is [`docs/spec-v1.md`](docs/spec-v1.md).

The core and CLI are MIT. The optional OpenCL experiment is conservatively
distributed as GPL-2.0-or-later with retained notices, so aggregate package
metadata declares `MIT AND GPL-2.0-or-later`.
