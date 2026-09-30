# xln — Cross-Local Network

**Make existing financial accounts provable.**

xln starts with the structure of existing finance: Jurisdictions, Entities and
bilateral Accounts (J/E/A). It makes their state replicable and verifiable, and
their account obligations signed and disputable on programmable J-machines.
The Reserve-Credit Provable Account Network (RCPAN) combines chosen credit,
collateral and programmable conditions in one account model.

**MML: by 2050, make the accounts supporting 51% of world GDP provable.**
Ordinary payments and swaps update accounts locally; the underlying jurisdiction
enforces registration, collateral, settlement and disputes. GDP coverage,
economic turnover and technical throughput are separate measurements.

## Start here

1. [xln in five minutes](docs/intro.md) — existing finance, J/E/A, MML and the
   three protections: proof, collateral and Delta Transformers.
2. [Unified Financial Theory](docs/core/10_UFT.md) — the financial model and
   its implementation through xln.
3. [RCPAN invariant](docs/core/12_invariant.md) — the bilateral financial bound.
4. [Runtime → Entity → Account → Jurisdiction](docs/core/rjea-architecture.md) —
   the canonical implementation model.
5. [Documentation index](docs/readme.md) — theory, specs, runtime, security,
   operations, and release evidence.

For comparisons, read [the architecture argument](docs/competitors.md).
Implementation and release claims require evidence about the actual candidate.

## Repository map

```text
xln/
├── core/             deterministic Runtime, Entity, Account, and boundaries
├── rscore/           Rust implementation of the canonical financial machines
├── brainvault/       standalone deterministic wallet-derivation package
├── jurisdictions/    Solidity settlement and dispute contracts
├── ui/               React wallet; presentation and user input
├── frontend/         existing Svelte client; presentation and user input
├── tests/            browser and full-stack E2E evidence
├── docs/             canonical documentation and immutable release evidence
├── scripts/          build, release, and operator tools
├── tools/            repository checks and evidence tooling
├── ops/              deployment and operating configuration
└── .archive/         historical source implementations; never live authority
```

`core/runtime.ts` is the narrow public facade. Core behavior belongs to its
owning Runtime, Entity, or Account module; physical I/O remains outside the
deterministic state-machine transitions.

## BrainVault: standalone module used by XLN

[BrainVault V1](brainvault/readme.md) is an independently packable, installable,
and auditable memory-hard wallet-derivation module. It has its own package,
frozen [byte specification](brainvault/SPEC-V1.md), vectors, native sources,
binaries, manifest, CLI, and tests entirely inside `brainvault/`; it does not
import XLN runtime, storage, network, frontend, or consensus code.

XLN is one consumer. Its terminal onboarding, browser wallet creation, remote
runtime adapter, and recovery tests call BrainVault's public derivation and
worker interfaces. Engine choice and XLN state never enter the frozen root.

Run and audit only BrainVault without starting XLN:

```bash
cd brainvault
bun install --frozen-lockfile --ignore-scripts
bun ./brainvault --smoke
bun ./brainvault
```

The exact minimal and expanded reading paths are in BrainVault's
[audit surface](brainvault/readme.md#exact-audit-surface). Coding agents must
also load its package-local [contract](brainvault/AGENTS.md).

## Quick start

```bash
bun install
bun run dev
open https://localhost:8080
```

The canonical release identity is [VERSION](VERSION), mirrored by
`package.json`. Do not infer the current version from prose or historical
changelog entries.

## Architecture

```text
RuntimeInput
  ├─ RuntimeTx[]
  └─ routed EntityInput[]
      └─ EntityTx[]
          ├─ accountInput → exact child AccountInput
          └─ financial intent → local AccountTx[] admission
```

Each live replica follows one deterministic transition law:

```text
(previous replica, input) → { next replica, outputs }
```

- Runtime is the single writer and owns WAL commitment before external effects.
- Entity certifies organization-level state and routes exact child inputs.
- Account owns bilateral financial mutation, proposals, ACKs, and dispute proof.
- Jurisdiction enforces registration, collateral, settlement and disputes;
  J adapters bring verified jurisdiction observations into Runtime inputs.
- Outputs move upward as deterministic data; network and chain I/O begin only
  after the enclosing Runtime frame is durable.

The complete vocabulary and ownership rules are in
[the canonical cascade guide](docs/core/rjea-architecture.md).

## Key commands

```bash
bun run dev                 # full local stack
bun run check               # repository verification gate
bun run build               # browser runtime bundle
bun run test:e2e:fast       # focused browser/full-stack bar
bun run test:e2e:full       # complete E2E suite
bun run test:contracts      # Solidity tests
```

Use Bun throughout the repository. Solidity and frozen-core changes have
separate owner-controlled integrity gates.

## Auditor reading path

1. [Architecture comparison](docs/competitors.md)
2. [Canonical cascade](docs/core/rjea-architecture.md)
3. [Payment and HTLC flow](docs/implementation/payment-spec.md)
4. `core/runtime/frame/process.ts` — Runtime transition and WAL ordering
5. `core/entity/consensus/input/consensus.ts` — Entity transition entry
6. `core/account/consensus/index.ts` — bilateral Account consensus
7. `core/account/tx/apply.ts` — financial validation and mutation dispatch
8. `core/storage/commit/commit.ts` — durable Runtime commit boundary

Audit reports and release artifacts are evidence about particular bytes and
dates. They are not live architecture documents and are not a substitute for
reading the current canonical path.

## Release and operational status

- [Active work and blockers](todo.md)
- [Minimum remaining work and accepted timing policy](docs/launch-design.md#minimum-remaining-work--owner-alignment-2026-09-30)
- [Current status](docs/status.md)
- [Mainnet release bar](docs/mainnet.md)
- [Mainnet acceptance gate](docs/mainnet-acceptance-gate.md)
- [Signed release manifest](docs/releases/manifest.json)
- [Security evidence](docs/security/)

These sources intentionally remain separate from the architecture verdict.

## License

AGPL-3.0 · [xln.finance](https://xln.finance)
