# xln — Cross-Local Network

**Provable bilateral credit with on-chain finality.**

xln is a Reserve-Credit Provable Account Network (RCPAN). Independent Account
machines exchange signed state off-chain; Entity authority governs those
Accounts; Runtime provides deterministic orchestration and durable delivery;
Jurisdictions provide collateral, settlement, disputes, and adversarial exit.

## Start here

1. [Architecture comparison](docs/competitors.md) — adoption-independent
   architecture matrix, DA analysis, scoring rubric, and falsification tests.
2. [Unavoidable constraints](docs/constraints.md) — why scalable finance needs
   bilateral unicast, credit, proofs, and enforceable settlement.
3. [RCPAN invariant](docs/core/12_invariant.md) — the bilateral financial bound.
4. [Runtime → Entity → Account → Jurisdiction](docs/core/rjea-architecture.md) —
   the canonical implementation model.
5. [Documentation index](docs/readme.md) — theory, specs, runtime, security,
   operations, and release evidence.

Architecture evaluation, audit-evidence freshness, and launch readiness are
independent. Current operational status is linked separately below and does not
change the architecture rubric.

## Repository map

```text
xln/
├── core/             deterministic Runtime, Entity, Account, and boundaries
├── jurisdictions/    Solidity settlement and dispute contracts
├── frontend/         xln.finance client; presentation and user input
├── tests/            browser and full-stack E2E evidence
├── docs/             canonical documentation and immutable release evidence
├── scripts/          build, release, and operator tools
└── .archive/         historical source implementations; never live authority
```

`core/runtime.ts` is the narrow public facade. Core behavior belongs to its
owning Runtime, Entity, or Account module; physical I/O remains outside the
deterministic state-machine transitions.

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
  └─ RuntimeTx[]
      └─ EntityInput
          └─ EntityTx[]
              └─ AccountInput
                  └─ AccountTx[]
```

Each live replica follows one deterministic transition law:

```text
(previous replica, input) → { next replica, outputs }
```

- Runtime is the single writer and owns WAL commitment before external effects.
- Entity certifies organization-level state and routes exact child inputs.
- Account owns bilateral financial mutation, proposals, ACKs, and dispute proof.
- Jurisdiction observes finalized chain facts and enforces exceptional exits.
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
- [Current status](docs/status.md)
- [Mainnet release bar](docs/mainnet.md)
- [Mainnet acceptance gate](docs/mainnet-acceptance-gate.md)
- [Signed release manifest](docs/releases/manifest.json)
- [Security evidence](docs/security/)

These sources intentionally remain separate from the architecture verdict.

## License

AGPL-3.0 · [xln.finance](https://xln.finance)
