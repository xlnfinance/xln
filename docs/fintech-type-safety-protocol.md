# Fintech Type Safety Protocol

This codebase moves money. Type safety rules are protocol rules, not style preferences.

## Core Rules

1. Boundary data may be `unknown`. Domain data may not.
2. Normalize once at ingress. After normalization, runtime types are total and explicit.
3. No `as any`.
4. No placeholder values for required money data.
5. No silent defaults for amounts, nonces, token ids, entity ids, contract addresses, proofs, or batches.
6. No zero-address acceptance in live contract paths.
7. No optional fields in committed runtime state when the field is required for settlement, replay, matching, proofs, or persistence.
8. No UI-owned chain writes in product flow.
9. One jurisdiction ingress path for writes. One watcher path for canonical events.
10. Missing or malformed critical data must fail fast.

## Practical Rules

- Raw JSON, WS payloads, chain receipts, and decoded ABI output start as `unknown`.
- Convert raw input through typed guards or normalizers.
- Do not spread `?`, `?.`, or `??` from boundary code into runtime core.
- If a field is required after normalization, make it required in the type.
- If a config value is required in live mode, validate it once and refuse startup when missing.
- Derived views may be partial at the edge. Runtime state may not.

## Priority Surfaces

Fix these first when reducing type risk:

1. `runtime/jadapter/*`
2. `runtime/wal/*`
3. `runtime/j-batch.ts`
4. `runtime/proof-builder.ts`
5. `runtime/account-tx/*`
6. `runtime/entity-tx/*`
7. `runtime/server.ts`

## Review Bar

A change is not acceptable if it does any of the following:

- introduces `as any`
- introduces new placeholder or zero-address fallbacks
- moves raw external data deeper into runtime without normalization
- adds new UI direct calls to jurisdiction/provider internals
- hides broken invariants behind clamping or silent continue

## Short Heuristic

- `unknown` at the edge
- strict types inside
- no fake defaults
- no bypasses
- fail fast
