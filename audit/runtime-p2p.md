# P2P Networking Audit

## Executive Summary

The xln runtime implements a **simulation-only P2P layer** with WebSocket server/client stubs for future production use. The current architecture is designed for single-runtime testing (all entities in one process) with placeholders for multi-runtime P2P communication.

**Key Finding**: The production P2P layer is **NOT IMPLEMENTED**. Files `p2p.ts`, `gossip.ts`, `gossip-helper.ts`, `ws-client.ts`, `ws-server.ts`, and `ws-protocol.ts` are essentially empty stubs or contain minimal placeholder code. The actual bilateral consensus happens via in-memory function calls within a single runtime.

**Risk Level**: N/A for production (no code to audit) - but **HIGH RISK** if deployed without implementing the documented security mechanisms.

---

## Critical (P0)

- [ ] **P0-1: No P2P Implementation Exists** - All P2P files are empty stubs
  - `runtime/p2p.ts`: Only exports empty namespace
  - `runtime/gossip.ts`: Empty file with only imports
  - `runtime/gossip-helper.ts`: Empty placeholder
  - `runtime/ws-client.ts`: Minimal WebSocket client stub (connection only, no message handling)
  - `runtime/ws-server.ts`: Basic Bun WebSocket server with no authentication
  - `runtime/ws-protocol.ts`: Empty protocol definition
  - **Impact**: Cannot deploy to production without implementing entire P2P layer
  - **Recommendation**: Implement P2P layer before any production deployment

- [ ] **P0-2: WebSocket Server Has No Authentication** (`runtime/ws-server.ts`)
  - Server accepts any connection without verifying peer identity
  - No TLS/SSL mentioned (plain WebSocket)
  - No rate limiting on connections
  - **Impact**: Anyone can connect and potentially DoS the node
  - **Code Location**: Lines 1-50 of `ws-server.ts`

---

## High (P1)

- [ ] **P1-1: Account Consensus Counter Has Integer Overflow Risk** (`runtime/account-consensus.ts:30-31`)
  ```typescript
  const MEMPOOL_LIMIT = 1000;
  const MAX_MESSAGE_COUNTER = 1000000;
  ```
  - Counter wraps at 1M - long-running channels could hit this limit
  - No recovery mechanism defined
  - **Impact**: Channel becomes unusable after 1M messages
  - **Recommendation**: Implement counter reset protocol or use larger counter

- [ ] **P1-2: Timestamp Drift Window Too Large** (`runtime/account-consensus.ts:75`)
  ```typescript
  const MAX_FRAME_TIMESTAMP_DRIFT_MS = 300000; // 5 minutes
  ```
  - 5 minutes of drift allows significant HTLC timing manipulation
  - Attacker can manipulate timeout windows by up to 5 minutes
  - **Impact**: HTLC timeout attacks possible
  - **Recommendation**: Reduce to 30 seconds max for production

- [ ] **P1-3: Frame Size Limit May Allow Memory Exhaustion** (`runtime/account-consensus.ts:76`)
  ```typescript
  const MAX_FRAME_SIZE_BYTES = 1048576; // 1MB frame size limit
  ```
  - 1MB per frame * 1000 mempool = potential 1GB memory consumption
  - No global memory limit across all accounts
  - **Impact**: Memory exhaustion DoS
  - **Recommendation**: Add global memory budget across all accounts

- [ ] **P1-4: No Peer Authentication in P2P Scenarios** (`runtime/scenarios/p2p-node.ts`, `p2p-relay.ts`)
  - Scenario files show P2P communication without peer identity verification
  - Entities communicate but don't verify each other's signatures before processing
  - **Impact**: Man-in-the-middle attacks possible
  - **Recommendation**: Implement mutual authentication using entity signing keys

---

## Medium (P2)

- [ ] **P2-1: Depository Address Fallback to Zero Address** (`runtime/account-consensus.ts:72-73`)
  ```typescript
  console.warn('[account-consensus] No depositoryAddress found in env - using zero address');
  return '0x0000000000000000000000000000000000000000';
  ```
  - Falls back to zero address if depository not configured
  - Signatures will fail but no hard error thrown
  - **Impact**: Silent failure, potential state corruption
  - **Recommendation**: Throw hard error instead of returning zero address

- [ ] **P2-2: Counter Update Before Full Verification** (`runtime/account-consensus.ts:597-601`)
  - Comment says "DoS FIX: Update counter AFTER signature verification (moved below)"
  - But original counter validation still happens before signature check
  - **Impact**: Partial DoS protection, could still desync counters with malformed messages
  - **Recommendation**: Move ALL counter state updates after signature verification

- [ ] **P2-3: Frame History Cap at 10 May Be Insufficient** (`runtime/account-consensus.ts:730-733`)
  ```typescript
  if (accountMachine.frameHistory.length > 10) {
    accountMachine.frameHistory.shift();
  }
  ```
  - Only keeps last 10 frames in history
  - Dispute resolution may require older frames
  - **Impact**: Cannot prove state for disputes older than 10 frames
  - **Recommendation**: Keep history until dispute window closes

- [ ] **P2-4: Rollback Count Not Bounded** (`runtime/account-consensus.ts:870-873`)
  ```typescript
  if (accountMachine.rollbackCount === 0) {
    // First rollback
  } else {
    console.warn(`ROLLBACK-LIMIT: ${accountMachine.rollbackCount}x`);
    return { success: false, error: 'Multiple rollbacks detected' };
  }
  ```
  - Allows exactly 1 rollback, but attacker could trigger repeatedly
  - No time-based reset of rollback counter
  - **Impact**: Consensus stall attack by repeatedly triggering rollbacks
  - **Recommendation**: Add time-based rollback counter decay

- [ ] **P2-5: Pathfinding Has No DoS Protection** (`runtime/routing/pathfinding.ts:44`)
  ```typescript
  maxRoutes: number = 100
  ```
  - Default 100 routes without computation limits
  - Large graphs could cause CPU exhaustion
  - **Impact**: DoS via expensive pathfinding requests
  - **Recommendation**: Add timeout and iteration limits

---

## Network Security Analysis

### Message Authentication

**Implemented (in bilateral consensus layer)**:
- HANKO signatures on all AccountFrames (secp256k1 ECDSA)
- Frame hash chaining prevents signature replay across frames (`prevFrameHash`)
- Counter-based replay protection within accounts (`ackedTransitions` tracking)
- Dispute proof signatures for on-chain settlement

**NOT Implemented (P2P layer)**:
- No transport-layer authentication
- No mutual TLS
- No message encryption
- No peer identity verification

### Replay Attack Protection

**Implemented**:
- Sequential message counter (`validateMessageCounter` enforces `counter === ackedTransitions + 1`)
- Frame hash chaining (`prevFrameHash` must match previous frame's `stateHash`)
- Timestamp monotonicity checks (frames must have increasing timestamps)

**Gaps**:
- Counter resets at 1M (potential replay after wrap)
- No nonce persistence across restarts
- Timestamp drift window (5 min) allows some manipulation

### DoS Resistance

**Implemented**:
- Mempool size limit (1000 transactions)
- Frame size limit (1MB)
- Counter validation before processing
- Basic frame structure validation

**Gaps**:
- No rate limiting on incoming messages
- No CPU time limits for frame processing
- No memory budget across accounts
- No connection limits on WebSocket server
- Pathfinding has no computation limits

### State Synchronization Security

**Implemented**:
- Bilateral frame consensus (both sides must agree)
- State hash verification on received frames
- Signature verification on all frame proposals
- Deterministic tiebreaker for simultaneous proposals (left wins)

**Gaps**:
- No mechanism to recover from state divergence
- No state sync protocol for reconnecting peers
- No checkpoint/snapshot verification

### Peer Discovery

**NOT Implemented**:
- No peer discovery mechanism exists
- `p2p.ts` is empty
- `gossip.ts` is empty
- Would need: DHT, DNS seeds, or hardcoded bootstrap nodes

### Connection Handling

**Minimal Implementation** (`ws-server.ts`, `ws-client.ts`):
- Basic WebSocket connection/disconnection
- No timeouts defined
- No keepalive/heartbeat
- No connection limits
- No backpressure handling

---

## Files Reviewed

| File | Status | Lines | Notes |
|------|--------|-------|-------|
| `/Users/zigota/xln/runtime/p2p.ts` | Empty stub | ~10 | No implementation |
| `/Users/zigota/xln/runtime/gossip.ts` | Empty stub | ~5 | No implementation |
| `/Users/zigota/xln/runtime/gossip-helper.ts` | Empty stub | ~5 | No implementation |
| `/Users/zigota/xln/runtime/ws-client.ts` | Minimal | ~30 | Connection only |
| `/Users/zigota/xln/runtime/ws-server.ts` | Minimal | ~50 | Basic Bun WS server |
| `/Users/zigota/xln/runtime/ws-protocol.ts` | Empty stub | ~10 | No protocol defined |
| `/Users/zigota/xln/runtime/account-consensus.ts` | Full impl | ~1420 | Bilateral consensus logic |
| `/Users/zigota/xln/runtime/account-crypto.ts` | Full impl | ~200 | Signing/verification |
| `/Users/zigota/xln/runtime/entity-consensus.ts` | Full impl | ~600 | Entity-level consensus |
| `/Users/zigota/xln/runtime/routing/pathfinding.ts` | Full impl | ~227 | Dijkstra routing |
| `/Users/zigota/xln/runtime/types.ts` | Full impl | ~800 | Type definitions |
| `/Users/zigota/xln/runtime/scenarios/p2p-node.ts` | Scenario | ~100 | Test scenario |
| `/Users/zigota/xln/runtime/scenarios/p2p-relay.ts` | Scenario | ~150 | Test scenario |

---

## Recommendations Summary

### Before Any Production Deployment

1. **Implement P2P layer** - Currently non-existent
2. **Add mutual TLS** - For transport security
3. **Implement peer authentication** - Using entity signing keys
4. **Add rate limiting** - On all incoming messages
5. **Implement peer discovery** - DHT or bootstrap nodes

### Security Hardening

1. Reduce timestamp drift to 30 seconds
2. Add global memory budget across accounts
3. Implement counter overflow handling
4. Add computation limits to pathfinding
5. Persist nonces across restarts

### Monitoring

1. Log all rejected messages with reason
2. Track rollback frequency per account
3. Monitor memory usage per peer
4. Alert on counter approaching limit

---

*Audit completed: 2026-01-27*
*Auditor: Claude Code Security Analysis*
