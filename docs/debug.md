# Single Source Network Debugging

This document defines the canonical debugging and event-sourcing flow for XLN networking and HTLC/payment lifecycle.

If you touch runtime, networking, relay, or payment code, follow this file.

## Goal

Use one timeline as source of truth:

- Relay timeline: `GET /api/debug/events`

This endpoint must answer, for any incident:

- Who sent what
- To whom
- When
- Delivery result
- Why it failed

## Current Architecture

Single-source pipeline:

1. Runtime code emits structured events through `env.warn`, `env.error`, `env.emit`.
2. `runtime/env-events.ts` forwards critical/high-signal events via P2P `debug_event`.
3. WS client sends `debug_event` messages to relay.
4. Relay stores all network and debug events in in-memory ring buffer.
5. HTTP API serves filtered timeline at `/api/debug/events`.

Core files:

- `runtime/env-events.ts`
- `runtime/networking/ws-client.ts`
- `runtime/networking/p2p.ts`
- `runtime/networking/ws-protocol.ts`
- `runtime/server.ts`

## Event Model

Relay event shape (from `runtime/server.ts`):

- `id`, `ts`, `event`
- optional: `runtimeId`, `from`, `to`, `msgType`, `status`, `reason`, `encrypted`, `size`, `queueSize`, `details`

Key relay events:

- `ws_open`, `ws_close`
- `hello`
- `message`
- `delivery`
- `gossip_store`, `gossip_request`
- `debug_event`
- `error`

Buffer:

- Ring buffer size: `MAX_RELAY_DEBUG_EVENTS = 5000`

## HTTP Query API

Endpoint:

- `GET /api/debug/events`

Supported filters:

- `last` (1..5000, default 200)
- `event`
- `runtimeId`
- `from`
- `to`
- `msgType`
- `status`
- `since` (unix ms)

Examples:

```bash
curl -s "https://xln.finance/api/debug/events?last=200" | jq .
curl -s "https://xln.finance/api/debug/events?event=error&last=200" | jq .
curl -s "https://xln.finance/api/debug/events?runtimeId=0xabc...&since=1770470000000" | jq .
curl -s "https://xln.finance/api/debug/events?msgType=entity_input&status=delivered&last=500" | jq .
```

## Mandatory Instrumentation Contract

All critical paths MUST emit structured events through env/p2p pipeline, not ad-hoc console logs.

### MUST rules

1. Use `env.error(...)` for failures that affect payment correctness, liveness, or consensus.
2. Use `env.warn(...)` for degraded behavior that can become failure.
3. Use `env.emit(...)` for high-signal lifecycle milestones.
4. Include stable identifiers in `data` when available:
   - `runtimeId`, `entityId`, `fromEntityId`, `toEntityId`
   - `accountId`, `hashlock`, `lockId`, `height`, `route`
5. Keep `message` deterministic and grep-friendly (all caps with `_` for error codes).
6. Never throw away failure context. Always include `reason` or normalized error details.
7. Never rely on browser-only console output for critical diagnostics.
8. Entity/profile metadata changes MUST flow through REA (`entityTx`) and be event-sourced; no direct P2P-only metadata mutation.

REA metadata path:

- Build tx: `type: 'profile-update'`
- Apply in runtime consensus flow (`runtime/entity-tx/apply.ts`)
- Persist + gossip sync via name-resolution pipeline
- Observe results in relay debug timeline (`debug_event`, `message`, `gossip_store`)

### MUST instrument these cases

- WS lifecycle:
  - connect
  - close/disconnect
  - reconnect attempts/final exhaustion
- Relay routing:
  - accepted/rejected
  - delivered/queued
  - local delivery failures
- HTLC:
  - initiated
  - lock committed
  - decrypt fail
  - hashlock mismatch
  - resolve success
  - resolve error/timeout
- Consensus:
  - frame proposal failed
  - ACK timeout
  - validation failure
- Payment lifecycle:
  - `PaymentInitiated`
  - `PaymentFinalized`
  - `PaymentFailed`

## Coding Pattern

Do:

```ts
env.error('network', 'ENVELOPE_DECRYPT_FAIL', {
  lockId,
  fromEntityId,
  toEntityId,
  reason: err.message,
}, state.entityId);
```

Do:

```ts
env.emit('PaymentFinalized', {
  hashlock,
  secret,
  inboundEntity,
  outboundEntity,
  entityId: state.entityId,
});
```

Avoid:

```ts
console.log('failed'); // no structured source-of-truth signal
```

## Debug Playbook

For a failed payment:

1. Query relay timeline by recent window and `runtimeId`.
2. Filter `event=debug_event` and `event=error`.
3. Follow sequence:
   - `message` -> `delivery` -> runtime `debug_event` -> finalize/fail.
4. If missing finalize, check:
   - decrypt errors
   - missing route/account
   - ACK/consensus failures
   - WS disconnect gap

Minimal incident query:

```bash
curl -s "https://xln.finance/api/debug/events?last=1000&event=error" | jq .
```

## Not Perfect: Recommended Improvements

Current pipeline is strong but not perfect.

Highest-value improvements:

1. Add `traceId`/`paymentId` propagated end-to-end (route build -> HTLC lock -> resolve).
2. Enforce schema validation for `debug_event` payloads (reject malformed producers).
3. Persist relay debug buffer to disk (survive process restart).
4. Add retention tiers:
   - in-memory hot ring
   - compressed rolling files
5. Add auth/rate limits for `/api/debug/events` in production.
6. Add redaction policy for sensitive fields in debug payloads.
7. Add alert rules (error spikes, delivery failures, reconnect storms).
8. Add server-side derived views:
   - payment timeline by hashlock
   - stuck locks
   - unresolved deferred routes

## Definition Of Done For New Code

Any PR touching network/payment/consensus is not done unless:

1. Critical failures are visible in `/api/debug/events`.
2. Success milestones are visible for happy path.
3. E2E test can assert debug endpoint has relevant events.
4. No critical incident requires multi-console reconstruction.

## Main Testing Mantra (Mandatory Gate)

Always validate these 3 scenarios, in this order, before merge/redeploy:

1. `lock-ahb` works
2. `e2e ahb` works
3. `ah1-3b` works

### Required sequence

```bash
# 0) clean debug state (preserve hub profiles)
curl -s -X POST "https://xln.finance/api/debug/reset" | jq .

# 1) lock-ahb
bun run scenario:lock-ahb

# 2) e2e ahb
bunx playwright test tests/e2e-ahb-payment.spec.ts

# 3) ah1-3b (multi-hop via H1/H2/H3)
bun run scenario:ah1-3b
```

### Pass criteria

All three must pass in the same run window:

1. No `error` events in `/api/debug/events` attributable to the scenario window.
2. Payment lifecycle includes `PaymentInitiated` and `PaymentFinalized`.
3. No stuck `AWAITING CONSENSUS` accounts after scenario completion.
4. No lingering unresolved HTLC locks for the scenario entities.

### Enforcement rule

If any one of the 3 fails, treat the build as failed. Do not deploy partial fixes.

---

Last updated: 2026-02-07
