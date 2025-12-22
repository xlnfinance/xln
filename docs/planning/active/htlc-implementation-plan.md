# HTLC Implementation Plan - Production Ready

**Date:** 2025-12-21
**Priority:** P0 - Core differentiator vs Lightning
**Estimated Time:** 8 hours (4 phases)
**Status:** APPROVED - Ready for implementation

---

## 🎯 Executive Summary

Implementing Hash Time-Locked Contracts (HTLCs) as delta transformers at the A-layer (AccountMachine) to enable:
- Multi-hop payment routing with proof-of-payment
- Atomic swaps across tokens/chains
- Lightning-style payments with <100% collateral
- Privacy via onion routing

**Key Architecture Decision:** HTLCs are NOT a separate layer - they are conditional payment transformers that hold capacity until secret reveal or timeout.

---

## 📚 2024 Archive Analysis

### Critical Discovery: `hashlockMap` Pattern

```typescript
// 2024 User.ts:72-80
hashlockMap: Map<hashlock, {
  inAddress?: string,      // Who sent us this HTLC
  outAddress?: string,     // Who we forwarded to
  inTransitionId?: number, // Inbound lock ID
  outTransitionId?: number,// Outbound lock ID
  secret?: string,         // Revealed preimage
  resolve?: Function,      // Original sender's promise
  reject?: Function
}>
```

**Automatic Secret Propagation:**
1. Alice creates HTLC → `hashlockMap.set(hash, { outAddress: 'hub' })`
2. Hub receives → Decrypts onion, sees `nextHop = 'bob'`
3. Hub forwards → Updates `hashlockMap[hash] = { inAddress: 'alice', outAddress: 'bob' }`
4. Bob reveals → Hub's `processSettlePayment()` reads `hashlockMap[hash].inAddress = 'alice'`
5. Hub auto-sends reveal to Alice

**No graph search needed** - the routing table is the path!

### 2024 vs 2025 Adaptations

| 2024 Pattern | 2025 Equivalent | Notes |
|--------------|------------------|-------|
| `User.hashlockMap` | `EntityState.htlcRoutes` | Per-entity routing table |
| `ChannelState.subcontracts[]` | `AccountMachine.locks` Map | O(1) lookup by lockId |
| `processAddPayment()` side effect | Entity handler processes lock | Pure function returns events |
| `processSettlePayment()` propagation | Return `{secret, hashlock}` | Entity layer handles propagation |
| **Missing: capacity holds** | Extend `Delta` with `leftHtlcHold`/`rightHtlcHold` | **Use existing allowance pattern** |
| Async `User` methods | Async handlers (still pure) | Same input → same output |
| `User.signingKey` | Derive from `hmac(runtime.seed, entityId)` | Phase 3 only |
| Fee tracking | `EntityState.htlcFeesEarned` counter | Running total |
| J-block height | Read from entity's synced J-state | NOT directly from j-replica |

---

## 🔧 Implementation Phases

### Phase 0: Constants & Fee Structure (30 min)

**File:** `/Users/egor/xln/runtime/constants.ts`

```typescript
// === HTLC CONFIGURATION ===

// Timelock settings (simnet-optimized)
export const HTLC_MIN_TIMELOCK_DELTA_MS = 10000;  // 10s per hop (fast for simnet)
export const HTLC_MAX_HOPS = 20;                   // Prevent routing loops
export const HTLC_DEFAULT_EXPIRY_MS = 30000;       // 30s default (3 hops × 10s)

// Fee structure (Coasian - micro basis points)
// 1 μbp = 0.0001 bp = 0.00001% = 1/10,000,000
export const HTLC_BASE_FEE_USD = 0n;               // No base fee
export const HTLC_FEE_RATE_UBP = 100n;             // 100 μbp = 0.01 bp = 0.001% (1 bp for hubs)

// Example: $10,000 payment
// Fee = 0 + (10000 × 100 / 10,000,000) = $0.10

// Griefing protection
// Alice → Hub → Bob:
// - Alice's lock: revealBeforeHeight = current + 3 (most time, prevents griefing)
// - Hub's lock:   revealBeforeHeight = current + 2
// - Bob's lock:   revealBeforeHeight = current + 1
// Each hop has T blocks to reveal before next hop can timeout
```

**File:** `/Users/egor/xln/runtime/types.ts`

```typescript
// === HTLC STRUCTURES ===

/**
 * HTLC Lock - Conditional payment held until secret reveal or timeout
 * Reference: 2024 StoredSubcontract + 2019 AddPayment pattern
 */
export interface HtlcLock {
  lockId: string;              // keccak256(hash + height + nonce)
  hashlock: string;            // keccak256(secret) - 32 bytes hex
  timelock: bigint;            // Expiry timestamp (unix-ms)
  revealBeforeHeight: number;  // J-block height deadline (enforced on-chain)
  amount: bigint;              // Locked amount
  tokenId: number;             // Token being locked
  senderIsLeft: boolean;       // Who initiated (canonical direction)
  createdHeight: number;       // AccountFrame height when created
  createdTimestamp: number;    // When lock was added (for logging)

  // Onion routing (optional - cleartext for Phase 2, encrypted for Phase 3)
  encryptedPackage?: string;   // Encrypted next-hop data
}

/**
 * HTLC Routing Context (replaces 2024 hashlockMap)
 * Tracks inbound/outbound hops for automatic secret propagation
 */
export interface HtlcRoute {
  hashlock: string;

  // Inbound hop (who sent us this HTLC)
  inboundEntity?: string;
  inboundLockId?: string;

  // Outbound hop (who we forwarded to)
  outboundEntity?: string;
  outboundLockId?: string;

  // Resolution
  secret?: string;
  createdTimestamp: number;
}

// === ACCOUNTTX ADDITIONS ===

export type AccountTx =
  | { type: 'direct_payment'; data: { amount: bigint; tokenId: number } }
  | { type: 'set_credit_limit'; data: { tokenId: number; limit: bigint } }
  | { type: 'request_rebalance'; data: { tokenId: number; amount: bigint } }

  // === NEW: HTLC TRANSACTIONS ===
  | {
      type: 'htlc_lock';
      data: {
        lockId: string;
        hashlock: string;
        timelock: bigint;            // Unix-ms expiry
        revealBeforeHeight: number;  // J-block deadline
        amount: bigint;
        tokenId: number;
        encryptedPackage?: string;   // Onion routing data
      };
    }
  | {
      type: 'htlc_reveal';
      data: {
        lockId: string;
        secret: string;              // Preimage that hashes to hashlock
      };
    }
  | {
      type: 'htlc_timeout';
      data: {
        lockId: string;
      };
    };

// === DELTA EXTENSIONS (Use existing allowance pattern) ===

export interface Delta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowance: bigint;   // Fixed typo: was "allowence"
  rightAllowance: bigint;

  // NEW: HTLC holds (similar to allowance)
  leftHtlcHold?: bigint;   // Left's outgoing HTLC holds
  rightHtlcHold?: bigint;  // Right's outgoing HTLC holds
}

// === ACCOUNTMACHINE ADDITIONS ===

export interface AccountMachine {
  // ... existing fields (proofHeader, deltas, etc.) ...

  // === HTLC STATE ===
  locks: Map<string, HtlcLock>;  // lockId → lock details
  // NOTE: Holds are tracked in Delta.leftHtlcHold/rightHtlcHold
}

// === ENTITYSTATE ADDITIONS ===

export interface EntityState {
  // ... existing fields ...

  // === HTLC ROUTING TABLE ===
  // Entity-level routing (like 2024 hashlockMap)
  htlcRoutes: Map<string, HtlcRoute>; // hashlock → routing context

  // === FEE TRACKING ===
  htlcFeesEarned: bigint;  // Running total of HTLC routing fees earned

  // === SYNCED J-STATE ===
  // Use entity's consensus view of J-machine (NOT j-replica directly)
  // Read currentHeight/timestamp from here (j-watcher maintains this)
  // Example: acceptedJHeight or jState.height (find actual field name)
}
```

---

### Phase 1: Core Bilateral HTLCs (2 hours)

**File:** `/Users/egor/xln/runtime/account-tx/handlers/htlc-lock.ts`

```typescript
/**
 * HTLC Lock Handler
 * Creates conditional payment, holds capacity until reveal/timeout
 *
 * Reference:
 * - 2024 AddPayment.apply() (Transition.ts:45-78)
 * - 2024 processAddPayment() (User.ts:641-724)
 *
 * Security:
 * - Validates capacity INCLUDING existing holds (prevents double-spend)
 * - Enforces revealBeforeHeight for griefing protection
 */

import { AccountMachine, AccountTx, HtlcLock } from '../../types';
import { deriveDelta, isLeft } from '../../account-utils';
import { HTLC_MIN_TIMELOCK_DELTA_MS } from '../../constants';

export async function handleHtlcLock(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_lock' }>,
  isOurFrame: boolean,
  currentTimestamp: number,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId, encryptedPackage } = accountTx.data;
  const events: string[] = [];

  // 1. Validate lockId uniqueness
  if (accountMachine.locks.has(lockId)) {
    return { success: false, error: `Lock ${lockId} already exists`, events };
  }

  // 2. Validate expiry is in future
  if (timelock <= BigInt(currentTimestamp)) {
    return { success: false, error: `Timelock ${timelock} already expired`, events };
  }

  // 3. Get delta
  const delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    return { success: false, error: `No delta for token ${tokenId}`, events };
  }

  // 4. Determine sender perspective (canonical)
  const senderIsLeft = isOurFrame
    ? isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity)
    : !isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // 5. Check available capacity (CRITICAL: deducts existing holds)
  const existingHold = (senderIsLeft
    ? accountMachine.outboundHold
    : accountMachine.inboundHold
  ).get(tokenId) || 0n;

  const derived = deriveDelta(delta, senderIsLeft);
  const availableCapacity = derived.outCapacity - existingHold;

  if (amount > availableCapacity) {
    return {
      success: false,
      error: `Insufficient capacity: need ${amount}, available ${availableCapacity} (${existingHold} already held)`,
      events
    };
  }

  // 6. Validate amount > 0
  if (amount <= 0n) {
    return { success: false, error: `Invalid amount: ${amount}`, events };
  }

  // 7. Create lock
  const lock: HtlcLock = {
    lockId,
    hashlock,
    timelock,
    revealBeforeHeight,
    amount,
    tokenId,
    senderIsLeft,
    createdHeight: accountMachine.currentHeight,
    createdTimestamp: currentTimestamp,
    encryptedPackage
  };

  accountMachine.locks.set(lockId, lock);

  // 8. Update capacity hold (prevents double-spend)
  const holdMap = senderIsLeft ? accountMachine.outboundHold : accountMachine.inboundHold;
  const current = holdMap.get(tokenId) || 0n;
  holdMap.set(tokenId, current + amount);

  events.push(`🔒 HTLC locked: ${amount} token ${tokenId}, expires block ${revealBeforeHeight}`);

  return { success: true, events };
}
```

**File:** `/Users/egor/xln/runtime/account-tx/handlers/htlc-reveal.ts`

```typescript
/**
 * HTLC Reveal Handler
 * Verifies secret matches hashlock, commits delta, releases hold
 *
 * Reference:
 * - 2024 SettlePayment.apply() (Transition.ts:90-143)
 * - 2024 processSettlePayment() (User.ts:726-760)
 *
 * Returns:
 * - secret + hashlock for entity layer to propagate backward
 */

import { ethers } from 'ethers';
import { AccountMachine, AccountTx } from '../../types';

export async function handleHtlcReveal(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_reveal' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  secret?: string;     // For backward propagation
  hashlock?: string;   // To identify route
}> {
  const { lockId, secret } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Verify not expired (can't reveal after deadline)
  if (currentHeight > lock.revealBeforeHeight) {
    return {
      success: false,
      error: `Lock expired: current height ${currentHeight} > deadline ${lock.revealBeforeHeight}`,
      events
    };
  }

  // 3. Verify secret hashes to hashlock (CRITICAL)
  const computedHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
  if (computedHash !== lock.hashlock) {
    return {
      success: false,
      error: `Hash mismatch: expected ${lock.hashlock.slice(0,8)}..., got ${computedHash.slice(0,8)}...`,
      events
    };
  }

  // 4. Get delta
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  // 5. Apply canonical delta (2024 pattern from SettlePayment:127-128)
  // If left locked → right receives → delta increases
  // If right locked → left receives → delta decreases
  const canonicalDelta = lock.senderIsLeft ? lock.amount : -lock.amount;
  delta.offdelta += canonicalDelta;

  // 6. Release hold
  const holdMap = lock.senderIsLeft ? accountMachine.outboundHold : accountMachine.inboundHold;
  const current = holdMap.get(lock.tokenId) || 0n;
  holdMap.set(lock.tokenId, current - lock.amount);

  // 7. Remove lock
  accountMachine.locks.delete(lockId);

  events.push(`🔓 HTLC revealed: ${lock.amount} token ${lock.tokenId}, secret ${secret.slice(0,8)}...`);

  // 8. Return secret for routing layer (2024 pattern from processSettlePayment:738-749)
  return {
    success: true,
    events,
    secret,           // Entity layer will propagate backward
    hashlock: lock.hashlock
  };
}
```

**File:** `/Users/egor/xln/runtime/account-tx/handlers/htlc-timeout.ts`

```typescript
/**
 * HTLC Timeout Handler
 * Expires lock after revealBeforeHeight deadline, returns funds to sender
 *
 * Reference:
 * - 2024 CancelPayment.apply() (Transition.ts:146-163)
 *
 * Note: NO delta change - funds stay with sender
 */

import { AccountMachine, AccountTx } from '../../types';

export async function handleHtlcTimeout(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_timeout' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { lockId } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Verify deadline passed (enforced at J-block height)
  if (currentHeight <= lock.revealBeforeHeight) {
    const remaining = lock.revealBeforeHeight - currentHeight;
    return {
      success: false,
      error: `Lock not expired: ${remaining} blocks remaining (current ${currentHeight}, deadline ${lock.revealBeforeHeight})`,
      events
    };
  }

  // 3. Release hold (NO delta change - funds return to sender)
  const holdMap = lock.senderIsLeft ? accountMachine.outboundHold : accountMachine.inboundHold;
  const current = holdMap.get(lock.tokenId) || 0n;
  holdMap.set(lock.tokenId, current - lock.amount);

  // 4. Remove lock
  accountMachine.locks.delete(lockId);

  events.push(`⏰ HTLC timeout: ${lock.amount} token ${lock.tokenId} returned to sender`);

  return { success: true, events };
}
```

---

### Phase 2: Multi-Hop Routing (Cleartext) (2.5 hours)

**File:** `/Users/egor/xln/runtime/htlc-utils.ts` (NEW)

```typescript
/**
 * HTLC Utility Functions
 * Fee calculation, timelock derivation, lock ID generation
 */

import { ethers } from 'ethers';
import { HTLC_BASE_FEE_USD, HTLC_FEE_RATE_UBP, HTLC_MIN_TIMELOCK_DELTA_MS } from './constants';

/**
 * Calculate HTLC fee (Coasian micro basis points)
 * Returns: amount minus fee
 */
export function calculateHtlcFee(amount: bigint): bigint {
  // Fee = base + (amount × rate_ubp / 10,000,000)
  const rateFee = (amount * HTLC_FEE_RATE_UBP) / 10_000_000n;
  const totalFee = HTLC_BASE_FEE_USD + rateFee;

  if (totalFee >= amount) {
    throw new Error(`Fee ${totalFee} exceeds amount ${amount}`);
  }

  return amount - totalFee;
}

/**
 * Generate deterministic lock ID
 */
export function generateLockId(
  hashlock: string,
  height: number,
  nonce: number
): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`${hashlock}:${height}:${nonce}`)
  );
}

/**
 * Calculate timelock for hop (decreases per hop for griefing protection)
 * Alice gets most time (prevents Sprite/Blitz attack)
 */
export function calculateHopTimelock(
  baseTimelock: bigint,
  hopIndex: number,  // 0 = first hop (Alice), 1 = second, etc.
  totalHops: number
): bigint {
  // Each hop gets 10s less than previous
  const reduction = BigInt((totalHops - hopIndex - 1) * HTLC_MIN_TIMELOCK_DELTA_MS);
  return baseTimelock - reduction;
}

/**
 * Calculate revealBeforeHeight for hop
 * Alice gets most blocks (highest deadline)
 */
export function calculateHopRevealHeight(
  baseHeight: number,
  hopIndex: number,
  totalHops: number
): number {
  // Alice: baseHeight + totalHops
  // Hub:   baseHeight + (totalHops - 1)
  // Bob:   baseHeight + (totalHops - 2)
  return baseHeight + (totalHops - hopIndex);
}
```

**File:** `/Users/egor/xln/runtime/entity-tx/handlers/account.ts`

Add after existing account tx processing (~line 150):

```typescript
/**
 * === HTLC PROCESSING ===
 * Multi-hop routing and secret propagation
 * Reference: 2024 User.processAddPayment() + processSettlePayment()
 */

// === HTLC LOCK PROCESSING ===
if (accountTx.type === 'htlc_lock' && result.success) {
  const lock = accountMachine.locks.get(accountTx.data.lockId);
  if (!lock) {
    events.push('⚠️ HTLC lock created but not found in state');
    return;
  }

  // Decrypt routing info (or read cleartext for Phase 2)
  let routingInfo: { nextHop?: string; finalRecipient?: string; secret?: string; encryptedPackage?: string } | null = null;

  if (lock.encryptedPackage) {
    // Phase 3: Encrypted onion
    try {
      routingInfo = await decryptOnionLayer(lock.encryptedPackage, newState.signingKey);
    } catch (e) {
      events.push(`❌ HTLC: Failed to decrypt onion: ${e}`);
      return;
    }
  } else {
    // Phase 2: Cleartext routing (for testing)
    routingInfo = (accountTx.data as any).routingInfo || null;
  }

  if (!routingInfo) {
    // No routing info - this is a direct bilateral HTLC
    return;
  }

  // Check if we're final recipient
  if (routingInfo.finalRecipient === newState.entityId) {
    // FINAL RECIPIENT: Reveal immediately with provided secret
    if (!routingInfo.secret) {
      events.push('❌ HTLC: Final recipient but no secret in package');
      return;
    }

    accountMachine.mempool.push({
      type: 'htlc_reveal',
      data: {
        lockId: lock.lockId,
        secret: routingInfo.secret
      }
    });

    events.push(`🎯 HTLC: Final recipient, revealing immediately`);

  } else if (routingInfo.nextHop) {
    // INTERMEDIARY: Forward to next hop

    // 1. Register route for backward propagation (2024 hashlockMap pattern)
    newState.htlcRoutes.set(lock.hashlock, {
      hashlock: lock.hashlock,
      inboundEntity: accountMachine.proofHeader.fromEntity,
      inboundLockId: lock.lockId,
      outboundEntity: routingInfo.nextHop,
      outboundLockId: `${lock.lockId}-fwd`,  // Deterministic
      createdTimestamp: env.timestamp
    });

    // 2. Get next hop account
    const nextAccount = newState.accounts.get(routingInfo.nextHop);
    if (!nextAccount) {
      events.push(`❌ HTLC: No account with next hop ${routingInfo.nextHop}`);
      return;
    }

    // 3. Calculate forwarded amount (deduct fee)
    const forwardAmount = calculateHtlcFee(lock.amount);

    // 4. Calculate forwarded timelock/height (shorter for griefing protection)
    const forwardTimelock = lock.timelock - BigInt(HTLC_MIN_TIMELOCK_DELTA_MS);
    const forwardRevealHeight = lock.revealBeforeHeight - 1;

    // 5. Create forward HTLC
    nextAccount.mempool.push({
      type: 'htlc_lock',
      data: {
        lockId: `${lock.lockId}-fwd`,
        hashlock: lock.hashlock,
        timelock: forwardTimelock,
        revealBeforeHeight: forwardRevealHeight,
        amount: forwardAmount,
        tokenId: lock.tokenId,
        encryptedPackage: routingInfo.encryptedPackage, // Next onion layer
        routingInfo: routingInfo.encryptedPackage ? undefined : routingInfo // Cleartext fallback
      }
    });

    events.push(
      `➡️ HTLC: Forwarding to ${routingInfo.nextHop.slice(-4)}: ` +
      `${forwardAmount} (fee ${lock.amount - forwardAmount}), ` +
      `timelock ${forwardTimelock}, height ${forwardRevealHeight}`
    );
  }
}

// === HTLC SECRET PROPAGATION ===
if (result.secret && result.hashlock) {
  const route = newState.htlcRoutes.get(result.hashlock);

  if (route) {
    // Store secret in routing table
    route.secret = result.secret;

    // Propagate backward to sender (2024 pattern from processSettlePayment:738-749)
    if (route.inboundEntity && route.inboundLockId) {
      const senderAccount = newState.accounts.get(route.inboundEntity);
      if (senderAccount) {
        // Send reveal to previous hop
        senderAccount.mempool.push({
          type: 'htlc_reveal',
          data: {
            lockId: route.inboundLockId,
            secret: result.secret
          }
        });

        events.push(`⬅️ HTLC: Propagating secret to ${route.inboundEntity.slice(-4)}`);
      }
    } else {
      // We're the original sender - payment complete!
      events.push(`✅ HTLC: Payment complete (we initiated)`);
    }
  }
}
```

**File:** `/Users/egor/xln/runtime/scenarios/lock-ahb.ts` (NEW - clone of ahb.ts)

```typescript
/**
 * HTLC version of AHB scenario
 * Alice → Hub → Bob using conditional payments (HTLCs)
 *
 * Demonstrates:
 * - Multi-hop routing with cleartext paths (Phase 2)
 * - Automatic secret propagation
 * - Fee deduction at each hop
 * - Griefing protection via timelock cascade
 */

import { createEmptyEnv } from '../runtime';
import { applyRuntimeInput } from '../runtime';
import { USDC_TOKEN_ID, usd } from '../constants';
import { ethers } from 'ethers';

export async function runLockAhb() {
  const env = createEmptyEnv();

  // === SETUP (Frames 1-3: Same as AHB) ===
  // Create Alice, Hub, Bob entities
  // Fund reserves
  // Open accounts with credit limits
  // ... (copy from ahb.ts) ...

  // === Frame 4: Alice creates HTLC to Hub ===

  // Generate secret
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Buffer.from(secretBytes).toString('hex');
  const hashlock = ethers.keccak256(ethers.toUtf8Bytes(secret));

  // Calculate timelocks (Alice gets most time)
  const baseTimelock = BigInt(env.timestamp + 30000); // 30s from now
  const aliceTimelock = baseTimelock;            // 30s
  const hubTimelock = baseTimelock - 10000n;     // 20s (10s less)
  const bobTimelock = baseTimelock - 20000n;     // 10s (20s less)

  // Calculate reveal heights
  const currentHeight = env.jReplica.height;
  const aliceRevealHeight = currentHeight + 3;  // Alice: 3 blocks
  const hubRevealHeight = currentHeight + 2;    // Hub:   2 blocks
  const bobRevealHeight = currentHeight + 1;    // Bob:   1 block

  await applyRuntimeInput(env, {
    type: 'entity',
    entityId: 'alice',
    input: {
      type: 'account',
      counterpartyId: 'hub',
      accountTx: {
        type: 'htlc_lock',
        data: {
          lockId: 'alice-hub-htlc',
          hashlock,
          timelock: aliceTimelock,
          revealBeforeHeight: aliceRevealHeight,
          amount: usd(100),
          tokenId: USDC_TOKEN_ID,

          // CLEARTEXT routing (Phase 2 - no encryption)
          routingInfo: {
            nextHop: 'hub',
            encryptedPackage: JSON.stringify({
              nextHop: 'bob',
              encryptedPackage: JSON.stringify({
                finalRecipient: 'bob',
                secret
              })
            })
          }
        }
      }
    }
  });

  console.log('Frame 4: Alice locked $100 to Hub');
  console.log(`  Hashlock: ${hashlock.slice(0,16)}...`);
  console.log(`  Secret: ${secret.slice(0,16)}... (encrypted in onion)`);

  // === Frame 5: Hub receives, decrypts, forwards to Bob ===
  await tick(env);
  console.log('Frame 5: Hub forwarded to Bob (fee deducted)');

  // === Frame 6: Bob receives, reveals secret ===
  await tick(env);
  console.log('Frame 6: Bob revealed secret');

  // === Frame 7: Secret propagates to Hub ===
  await tick(env);
  console.log('Frame 7: Hub received secret, settling with Bob');

  // === Frame 8: Secret propagates to Alice ===
  await tick(env);
  console.log('Frame 8: Alice received secret, settling with Hub');

  // === Verify final balances ===
  const aliceAccount = env.entities.get('alice')?.accounts.get('hub');
  const hubToBob = env.entities.get('hub')?.accounts.get('bob');
  const bobAccount = env.entities.get('bob')?.accounts.get('hub');

  console.log('\n=== Final Balances ===');
  console.log(`Alice: ${aliceAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta} (should be -100)`);
  console.log(`Hub→Bob: ${hubToBob?.deltas.get(USDC_TOKEN_ID)?.offdelta} (hub sent to bob)`);
  console.log(`Bob: ${bobAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta} (should be ~+99, hub took fee)`);

  return env;
}
```

---

### Phase 3: Onion Encryption (1.5 hours)

**File:** `/Users/egor/xln/runtime/htlc-onion.ts` (NEW)

```typescript
/**
 * Onion Routing for HTLCs
 * Layer-by-layer encryption for payment privacy
 *
 * Reference:
 * - 2024 User.createOnionEncryptedPayment() (User.ts:568-625)
 * - 2024 User.decryptPackage() (User.ts:636-638)
 */

import { encrypt, decrypt } from 'eciesjs';
import { encode, decode } from './serialization-utils';

export interface OnionLayer {
  // Final layer (recipient sees this)
  secret?: string;
  finalRecipient?: string;

  // Intermediary layer (hub sees this)
  nextHop?: string;
  encryptedPackage?: string;  // Next layer of onion

  // Common metadata
  amount?: bigint;
  tokenId?: number;
}

/**
 * Build onion encryption from route
 * Returns: Encrypted package for first hop
 *
 * Process:
 * 1. Encrypt innermost layer for final recipient (contains secret)
 * 2. Wrap in layers (reverse order) - each hop adds encryption
 * 3. Return outermost layer for first hop
 */
export async function buildOnion(
  secret: string,
  amount: bigint,
  tokenId: number,
  route: Array<{ entityId: string; publicKey: string }>,
  finalRecipient: { entityId: string; publicKey: string }
): Promise<string> {
  // 1. Innermost layer - final recipient sees secret
  let pkg = await encryptLayer(finalRecipient.publicKey, {
    secret,
    finalRecipient: finalRecipient.entityId,
    amount,
    tokenId
  });

  // 2. Wrap in reverse order (each intermediary gets a layer)
  for (let i = route.length - 1; i >= 0; i--) {
    const isLastHop = i === route.length - 1;
    pkg = await encryptLayer(route[i].publicKey, {
      nextHop: isLastHop ? finalRecipient.entityId : route[i + 1].entityId,
      encryptedPackage: pkg,
      amount,
      tokenId
    });
  }

  return pkg;
}

/**
 * Decrypt one layer of onion
 * Each hop decrypts exactly one layer
 */
export async function decryptOnionLayer(
  encryptedPackage: string,
  privateKey: Uint8Array
): Promise<OnionLayer> {
  const decrypted = await decrypt(
    Buffer.from(privateKey),
    Buffer.from(encryptedPackage, 'hex')
  );
  return decode(decrypted);
}

/**
 * Helper: Encrypt one onion layer
 */
async function encryptLayer(publicKey: string, data: OnionLayer): Promise<string> {
  const encoded = encode(data);
  const encrypted = await encrypt(
    Buffer.from(publicKey, 'hex'),
    Buffer.from(encoded)
  );
  return encrypted.toString('hex');
}
```

**Update:** `lock-ahb.ts` to use real onion encryption instead of cleartext.

---

### Phase 4: Integration & Testing (2 hours)

**File:** `/Users/egor/xln/runtime/account-tx/apply.ts`

```typescript
import { handleHtlcLock } from './handlers/htlc-lock';
import { handleHtlcReveal } from './handlers/htlc-reveal';
import { handleHtlcTimeout } from './handlers/htlc-timeout';

export async function applyAccountTx(
  accountMachine: AccountMachine,
  accountTx: AccountTx,
  isOurFrame: boolean,
  currentTimestamp: number,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string; [key: string]: any }> {

  switch (accountTx.type) {
    case 'direct_payment':
      return handleDirectPayment(accountMachine, accountTx, isOurFrame);

    case 'set_credit_limit':
      return handleSetCreditLimit(accountMachine, accountTx, isOurFrame);

    case 'request_rebalance':
      return handleRequestRebalance(accountMachine, accountTx, isOurFrame);

    // === HTLC HANDLERS ===
    case 'htlc_lock':
      return await handleHtlcLock(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_lock' }>,
        isOurFrame,
        currentTimestamp,
        currentHeight
      );

    case 'htlc_reveal':
      return await handleHtlcReveal(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_reveal' }>,
        isOurFrame,
        currentHeight
      );

    case 'htlc_timeout':
      return await handleHtlcTimeout(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_timeout' }>,
        isOurFrame,
        currentHeight
      );

    default:
      return { success: false, error: `Unknown AccountTx type: ${(accountTx as any).type}`, events: [] };
  }
}
```

**File:** `/Users/egor/xln/runtime/state-helpers.ts`

```typescript
function manualCloneAccountMachine(account: AccountMachine): AccountMachine {
  return {
    // ... existing fields ...

    // === HTLC STATE (deep clone) ===
    locks: new Map(
      Array.from(account.locks?.entries() || [])
        .map(([k, v]) => [k, { ...v }])
    ),
    outboundHold: new Map(account.outboundHold || []),
    inboundHold: new Map(account.inboundHold || []),
  };
}

function manualCloneEntityState(state: EntityState): EntityState {
  return {
    // ... existing fields ...

    // === HTLC ROUTING TABLE ===
    htlcRoutes: new Map(
      Array.from(state.htlcRoutes?.entries() || [])
        .map(([k, v]) => [k, { ...v }])
    ),
  };
}
```

**File:** `/Users/egor/xln/runtime/account-consensus.ts`

Update frame hash to include HTLC state:

```typescript
async function createFrameHash(frame: AccountFrame): Promise<string> {
  const frameData = {
    // ... existing fields ...

    // === HTLC STATE (must be deterministic - sort by lockId) ===
    locks: frame.locks
      ? Array.from(frame.locks.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, lock]) => ({
            lockId: id,
            hashlock: lock.hashlock,
            timelock: lock.timelock.toString(),
            revealBeforeHeight: lock.revealBeforeHeight,
            amount: lock.amount.toString(),
            tokenId: lock.tokenId,
            senderIsLeft: lock.senderIsLeft,
          }))
      : [],
  };

  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(frameData)));
}
```

**File:** `/Users/egor/xln/runtime/account-utils.ts`

```typescript
/**
 * Derive account balance with HTLC holds
 * @param delta - The delta structure
 * @param isLeft - Perspective
 * @param outboundHold - Amount held in outgoing HTLCs (optional)
 * @param inboundHold - Amount held in incoming HTLCs (optional)
 */
export function deriveDelta(
  delta: Delta,
  isLeft: boolean,
  outboundHold: bigint = 0n,
  inboundHold: bigint = 0n
): DerivedDelta {
  // ... existing calculation ...

  // CRITICAL: Subtract holds from capacity (prevents double-spend)
  outCapacity = nonNegative(outCapacity - outboundHold);
  inCapacity = nonNegative(inCapacity - inboundHold);

  return { outCapacity, inCapacity, ... };
}
```

**Testing Files:**

```typescript
// runtime/__tests__/htlc-bilateral.test.ts
describe('HTLC Bilateral', () => {
  it('Lock → Reveal → Delta committed');
  it('Lock → Timeout → Funds returned');
  it('Wrong secret → Rejected');
  it('Double lock → Insufficient capacity');
  it('Reveal after timeout → Rejected');
  it('Timeout before deadline → Rejected');
});

// runtime/__tests__/htlc-multihop.test.ts
describe('HTLC Multi-Hop', () => {
  it('Alice → Hub → Bob cleartext');
  it('Alice → Hub → Bob encrypted onion');
  it('Secret propagates backward');
  it('Fee deducted at each hop');
  it('Timeout cascade (Bob offline)');
});
```

---

## 🔐 On-Chain Integration (Future)

**2024 Pattern:** HTLCs appear in `ProofBody` for on-chain disputes

```typescript
// From 2024 Channel.ts:437-509
interface SubcontractBatch {
  payment: Array<{
    deltaIndex: number;
    amount: bigint;
    revealedUntilBlock: number;  // ← revealBeforeHeight
    hash: string;                // ← hashlock
  }>;
}

// Included in ProofBody for on-chain verification
proofbody[i].subcontracts.push({
  subcontractProviderAddress: ENV.subcontractProviderAddress,
  batch: encode([subcontractBatch[i]])
});
```

**For MVP:** HTLC settlement via direct on-chain settlement (skip SubcontractProvider.sol integration). Add transformer support later.

---

## ✅ Success Criteria

### Phase 1: Bilateral
- [ ] Alice locks 1000 to Bob
- [ ] Bob reveals correct secret → Alice -1000, Bob +1000
- [ ] Bob reveals wrong secret → Rejected
- [ ] Lock expires → Timeout returns funds to Alice
- [ ] Double lock attempt → Insufficient capacity error
- [ ] Capacity holds prevent double-spend

### Phase 2: Multi-Hop (Cleartext)
- [ ] Alice → Hub → Bob route works
- [ ] Secret propagates backward (Bob → Hub → Alice)
- [ ] Hub deducts fee (Alice sends 100, Bob receives 99.99)
- [ ] Timelock cascade (Alice: 30s, Hub: 20s, Bob: 10s)
- [ ] Reveal heights decrement (Alice: h+3, Hub: h+2, Bob: h+1)

### Phase 3: Onion
- [ ] Alice builds encrypted onion for [Hub, Bob]
- [ ] Hub decrypts one layer, sees nextHop=Bob
- [ ] Bob decrypts final layer, sees secret
- [ ] Privacy: Hub doesn't know Alice is sender

### Phase 4: Production
- [ ] All existing tests still pass
- [ ] `bun run check` passes (TypeScript)
- [ ] lock-ahb.ts scenario runs end-to-end
- [ ] Hold accounting audit (sum holds = sum locked amounts)

---

## 🔑 Critical Implementation Notes

1. **Determinism:** All handlers are async but pure (same input → same output)
2. **Griefing Protection:** Alice gets most time (prevents Sprite attack)
3. **Fee Structure:** 100 μbp = 0.001% = 1 bp for hubs
4. **Capacity Validation:** `amount <= inCapacity` (auto-deducts holds)
5. **Sequential Execution:** No race conditions (R→E→A→J is deterministic)
6. **Timelock Enforcement:** Both A-layer (htlc-reveal) and J-layer (disputes)
7. **Backward Propagation:** Automatic via `htlcRoutes` table (2024 hashlockMap pattern)

---

**Total Estimated Time:** 8 hours

**Status:** ✅ READY FOR IMPLEMENTATION

---

## 🎯 Implementation Strategy

### Step 1: Bilateral HTLC Primitive (2 hours)
**Create new scenario:** `/Users/egor/xln/runtime/scenarios/lock-simple.ts`
- Single hop: Alice locks to Bob directly
- Bob reveals secret
- Test all edge cases:
  - ✅ Correct secret → Delta committed
  - ❌ Wrong secret → Rejected
  - ❌ Double lock → Insufficient capacity
  - ✅ Timeout after deadline → Funds returned
  - ❌ Timeout before deadline → Rejected
  - ❌ Reveal after deadline → Rejected

### Step 2: Multi-Hop AHB (2.5 hours)
**Create shared setup:** `/Users/egor/xln/runtime/scenarios/ahb-setup.ts`
- Shared entity/account creation for ahb.ts and lock-ahb.ts
- Prevents code duplication

**Create lock-ahb.ts:** Alice → Hub → Bob with HTLCs
- Hub forwards with fee deduction
- Secret propagates backward
- Verify fees earned counter

### Step 3: Onion Encryption (1.5 hours - DEFERRED)
- Add after bilateral + multi-hop work
- Derive encryption key from runtime.seed

---

**Implementation Order:**
1. Phase 0: Constants + Types (30m)
2. Phase 1: Bilateral handlers + lock-simple.ts (2h)
3. Phase 2: Multi-hop + lock-ahb.ts (2.5h)
4. Phase 3: Onion encryption (deferred)

**Next Step:** Start Phase 0 - Add constants and types
