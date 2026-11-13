# Domain docs

Use a single domain context. Domain documentation belongs under `docs/`, with
lowercase filenames, following [AGENTS.md](../../AGENTS.md).

## Before exploring

- Read `docs/glossary.md` if it exists, then relevant ADRs in `docs/adr/`.
- Consult [docs/core/rjea-architecture.md](../core/rjea-architecture.md) for Runtime,
  Entity and Account ownership, and [docs/fints.md](../fints.md) for the normative
  TypeScript and state-machine safety standard when working in those areas.
- If a glossary or ADR is absent, continue from current production code and the
  canonical documentation. Create domain files lazily when a term is resolved or
  a consequential decision needs recording.

## Recording and consuming decisions

Use glossary terms consistently. The glossary holds domain definitions; an ADR
holds the reason for a consequential decision. Working specs, tickets and maps
use the local tracker in [issue-tracker.md](issue-tracker.md). Surface conflicts
with an ADR for resolution under AGENTS.md. All source documentation stays in English.
