# Single Source Network Debugging

This document defines the canonical debugging and event-sourcing flow for XLN networking and HTLC/payment lifecycle.

If you touch runtime, networking, relay, or payment code, follow this file.

## Goal

Use one event timeline and one root-cause incident view:

- Relay timeline: `GET /api/debug/events`
- Open incidents: `GET /api/debug/incidents?state=open`

These endpoints must answer, for any incident:

- Who sent what
- To whom
- When
- Delivery result
- Why it failed

## Current Architecture

Single-source pipeline:

1. Runtime code emits structured events through `env.warn`, `env.error`, `env.emit`.
2. `runtime/machine/env-events.ts` forwards critical/high-signal events via P2P `debug_event`.
3. WS client sends `debug_event` messages to relay.
4. Relay stores all network and debug events in in-memory ring buffer.
5. Browser telemetry sends `console.error`, `window.error`, unhandled promise
   rejection and Svelte errors to `/api/debug/events/ingest`.
6. Every error updates a separate fingerprinted incident registry. Gossip
   traffic may rotate the event ring but cannot evict an active root cause.
7. HTTP API serves the raw timeline and the grouped incident view.

Core files:

- `runtime/machine/env-events.ts`
- `runtime/networking/ws-client.ts`
- `runtime/networking/p2p.ts`
- `runtime/networking/ws-protocol.ts`
- `runtime/server/index.ts`
- `runtime/relay/debug-http.ts`
- `frontend/src/lib/debug/browser-telemetry.ts`

## Event Model

Relay event shape (from `runtime/server/index.ts`):

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
- Incident registry: 1,000 grouped root causes, evicting resolved/oldest first
- Incident lifecycle: `unread -> acknowledged -> resolved`; a new occurrence
  reopens the incident as `unread`

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
curl -s "http://127.0.0.1:8082/api/debug/incidents?state=open" | jq .
```

Agent/operator shortcut:

```bash
bun run debug:incidents
bun run debug:incidents -- --state=unread --ack
bun run debug:incidents -- --resolve=<fingerprint>
```

The first command exits non-zero while any open incident exists. Run it before
reading scattered log files and again after every fix. Resolve an incident
only after its L1 and L2 regressions are green; a recurrence reopens it.

## Root Cause, Not Log Volume

- One storage failure followed by 1,000 rejected deliveries is one root
  incident plus causal fallout, not 1,001 independent bugs.
- Boot probes against children that have not reached their readiness barrier
  are bootstrap state, not incidents.
- Typed transient delivery outcomes remain timeline events but do not become
  incidents. Fatal delivery outcomes do.
- Every incident fingerprint binds source, normalized code, Runtime identity,
  message and first stack location.
- Incident API responses omit raw event payloads. Querying incidents must not
  expose seeds, capabilities, signatures, ciphertext or financial arguments.

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
- Apply in runtime consensus flow (`runtime/entity/tx/apply.ts`)
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
- HTLC lifecycle:
  - `HtlcInitiated`
  - `HtlcFinalized`
  - `HtlcFailed`

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
env.emit('HtlcFinalized', {
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

## Radapter Oversized Responses

Symptom:

- Browser shows `runtime adapter response too large`
- Login import succeeds, then `/app` never materializes `window.isolatedEnv`

Source of truth:

- Runtime log line: `[RADAPTER] RESPONSE_TOO_LARGE {...}`
- Runtime event: `RuntimeAdapterResponseTooLarge`

Useful prod commands:

```bash
ssh root@xln.finance 'grep -R "RADAPTER] RESPONSE_TOO_LARGE" -n /root/.pm2/logs /root/xln/db 2>/dev/null | tail -n 20'
curl -fsS https://xln.finance/api/runtime-import | jq '.manifest.entries[] | {label,access,wsUrl,hasToken:(.token|length>0)}'
```

Expected event fields:

- `op`, `path`, `query`
- `bytes`, `maxBytes`
- `runtimeId`, `height`
- `payloadKeys`

Root-cause rule:

- Do not only raise `XLN_RADAPTER_MAX_MESSAGE_BYTES`.
- First check whether the read path is supposed to be paged/compact. For `/view-frame`, accounts/books and heavy core maps must stay bounded.

Minimal incident query:

```bash
curl -s "https://xln.finance/api/debug/events?last=1000&event=error" | jq .
```

## Not Perfect: Recommended Improvements

Current pipeline is strong but not perfect.

Highest-value improvements:

1. Add `traceId`/`paymentId` propagated end-to-end (route build -> HTLC lock -> resolve).
2. Enforce schema validation for Runtime `debug_event` payloads (browser intake is already bounded and validated).
3. Persist incident state and a redacted rolling event stream to disk (survive process restart).
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
curl -s -X POST "https://xln.finance/api/reset" | jq .

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
2. HTLC lifecycle includes `HtlcInitiated` and `HtlcFinalized`.
3. No stuck `AWAITING CONSENSUS` accounts after scenario completion.
4. No lingering unresolved HTLC locks for the scenario entities.

### Enforcement rule

If any one of the 3 fails, treat the build as failed. Do not deploy partial fixes.

### JAdapter Boundary Guard

Prevent new direct RPC/BrowserVM calls outside adapter internals:

```bash
bun run check:jadapter-boundary
```

## Parallel Scenario Runs (Isolated Anvil Per Worker)

For faster system validation, run scenarios in parallel with one Anvil process per worker.
This avoids nonce/deploy collisions from sharing a single RPC node.

Command:

```bash
bun run test:system:parallel
```

Useful flags:

```bash
# Run only selected scenarios
bun run test:system:parallel -- --scenarios=processbatch,rebalance,settle-rebalance

# Control concurrency and port range (worker i => base-port+i)
bun run test:system:parallel -- --workers=6 --base-port=18545

# Stream prefixed logs live
bun run test:system:parallel -- --stream
```

Notes:

1. Each worker enforces `chainId=31337`.
2. Logs are written under `.logs/system-tests/<timestamp>/`.
3. A scenario timeout is enforced (`--timeout-ms`, default 15 minutes).
4. Runner exits non-zero if any scenario fails, and prints failing log tails.

---

Last updated: 2026-02-18
