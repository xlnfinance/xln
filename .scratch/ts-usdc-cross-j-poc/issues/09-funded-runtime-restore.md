# 09: Start and restore funded PoC Runtimes without replacing identities or state

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 04 - Recover the interrupted financial journey without duplicate effects

## Problem

The public operator probe creates fresh attempt stores and rejects funded
identities. That is a valid preparation boundary, but cannot be the launcher
used after separate funding. A funded execution must retain the original
vaults and canonical Runtime recovery data.

## Acceptance criteria

- [x] Keep fresh/unfunded probing separate from explicit start/restore of the
      selected user, Hub and MM stores. Identify owning processes and store paths.
- [x] Preserve the exact vault, Runtime and per-jurisdiction Entity identities.
      Reject incompatible configuration, missing committed state and concurrent
      ownership loudly; never silently create a replacement identity or database.
- [x] Recover from canonical checkpoint plus ordered Runtime WAL inputs and
      committed outbox, using the existing recovery path. Do not add sidecar
      financial state, alternate checkpoint authority or historical migrations.
- [x] Prove a real local funded restart retains Account heads/Hankos, balances,
      live obligations and ordered effects, with no duplicate funding or payout.
- [x] Check authenticated transport and observable readiness after restart;
      stop every owned child on failure. Run focused recovery checks and the
      applicable verification profile for the changed behavior.

## Comments

This follow-up is independent of public funding and can be developed locally.
It does not authorize clearing existing funded stores or starting public
financial execution. Ticket 11 needs this launcher before operator funding.

Owner selected implementation on 2026-11-17. The
[session guide](../../../docs/runtime/usdc-poc-session.md) describes explicit
store selection, mandatory restore, configuration checks and process ownership.
Completed locally on the dirty shared candidate. Public Runtime startup and
financial execution remain unverified and unauthorised by this ticket.

References: [fresh guard](../../../jurisdictions/scripts/usdc-cross-j-preflight/chain.ts),
[operator probe](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/local-operators.ts),
[user startup](../../../core/scenarios/usdc-poc/user.ts).

## Verification

The [retained evidence](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#funded-runtime-restorejson)
contains source hashes, three actual session starts, per-role replay proofs,
identified chain observations and financial/recovery results.

- Related suite: 69 passed, 0 failed, 1,000 assertions across 15 files. The
  funded scenario was repeated on the final fixture layout and report codec:
  1 passed, 0 failed, 33 assertions, with the stand lock held.
- A real one-USDC approval/E2R/R2C funds the user Account. Restored Runtime and
  Entity roots, Account heads/Hankos and ordered outbox digest match its WAL.
  Operator Pulls and committed offers survive the crash. Ten identified chain
  observations retain unchanged contract/wallet nonces, token/reserve balances
  and the user's native balance across restore and supervision failures.
- Missing committed state, absent/foreign vaults, incompatible contracts and
  concurrent ownership reject. An owned child crash stops the session; a
  supervisor SIGKILL stops its orphaned children, and a subsequent session
  reclaims the same stores. Normal shutdown is checked for errors.
- Existing financial recovery matrix: 3/3 cases, eight actual restores; full
  external payouts of 899,801 and 899,900 units, plus a separately classified
  expired clear. This remains local financial evidence.
- Deployment TypeScript validation and `bun run check` passed: 3 short gates,
  38 source gates, 10 soundcheck gates; frozen core unchanged, ESLint semantic
  errors zero and the exact existing debt baseline remains 315.

The default gateway remains read-only. Restoring accepted financial effects
that require public submission still needs the authorized execution connection
and spending authority from the remaining work; no effect may be discarded.
