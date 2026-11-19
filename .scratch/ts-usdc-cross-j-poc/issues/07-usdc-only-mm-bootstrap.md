# 07: Finalize USDC-only MM bootstrap through committed Cross-J quotes

Type: implementation
Category: bug
Completed: yes
Status: ready-for-agent
Blocked by: None

## Problem

The selected stacks each register only USDC. The route planner supports that
Cross-J pair, but aggregate MM health disables the maker when the expected
same-J offer count is zero. The quote driver cannot reach Cross-J bootstrap.
Funding cannot change this predicate.

## Scope

The owner accepted Q8 and the narrow first patch: derive readiness from the
selected markets, align startup, health and finalization, and prove the complete
quote lifecycle. Public CLI, funding, credit amounts and pricing are separate.

## Acceptance criteria

- [x] A USDC-only two-jurisdiction configuration opens and commits the required
      MM/Hub Accounts and reaches full committed Cross-J depth in both directions.
      No same-J pair or extra token is required for this configuration.
- [x] Preserve Account authority, mutual credit, capacity, authenticated
      transport, signatures, ACKs, post-WAL effects and quote-depth checks.
      Missing Accounts, pending quotes and incomplete Cross-J depth remain unready.
- [x] Configured same-J markets still require their complete books. A
      configuration with no trading markets never becomes trading-ready.
- [x] Startup phase, aggregate health and bootstrap finalization agree. A
      complete lifecycle regression exercises actual independent Hub/MM Runtimes,
      canonical Account admission and committed quotes, beyond route-plan counts.
- [x] Run focused owning checks and `bun run check` for the executable candidate.
      Retain the commands, actual results and local-only evidence limitations.

## Comments

Owner accepted the scope on 2026-11-17. Completed locally on the dirty shared
candidate, without public financial execution or a release-ready commit claim.
The existing public preparation report still describes the earlier candidate.

## Verification

The [retained local evidence](../../../docs/evidence/ts-usdc-cross-j-poc/usdc-only-mm-bootstrap.json)
binds source hashes, commands and actual health to the observed candidate.

- Market suite: 66 passed, 0 failed, 944 assertions across 13 files, under the
  stand lock. The actual USDC-only lifecycle reaches `offers-ready`, with zero
  same-J offers and nine committed offers in each of two Cross-J directions.
- The mixed-market production stand completes the full one-USDC journey with
  an 899,801-unit external payout. Existing pricing and credit defaults remain.
- `bun run check`: 3 short gates, 38 source gates and 10 soundcheck gates passed;
  frozen core unchanged. Focused test TypeScript validation also passed.
- Public quote/funding validation is still required in 05. Tickets 08-11 remain
  separate; local Anvil chain IDs do not establish public-network completion.

References: [aggregate health](../../../core/orchestrator/market-maker/node/mm-node-health.ts),
[quote lifecycle](../../../core/orchestrator/market-maker/node/mm-node-run.ts),
[decision map](../map.md).
