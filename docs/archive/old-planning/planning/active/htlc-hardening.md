# HTLC Hardening Plan

Codex audit findings from lock-ahb.ts review. All issues are valid and need fixes before production.

## Findings Summary

| Severity | Issue | Location |
|----------|-------|----------|
| High | No timeout/dispute path tested | lock-ahb.ts |
| Medium | lockId collision risk | htlc-utils.ts:36-48 |
| Medium | Hash encoding mismatch (breaks Solidity) | htlc-utils.ts:55-59, htlc-reveal.ts:51-53 |
| Medium | Timelock underflow on forwarding | account.ts:161-174 |

## Fix 1: lockId Collision (Medium)

### Current (Unsafe)
```typescript
// htlc-utils.ts:36-48
export function generateLockId(hashlock: string, timestamp: number): string {
  const nonce = 0;  // Always 0!
  return ethers.keccak256(
    ethers.toUtf8Bytes(hashlock + timestamp.toString() + nonce.toString())
  );
}
```

**Problem:** If same hashlock + timestamp occurs (possible with multiple senders), lockId collides.

### Fix
```typescript
export function generateLockId(
  hashlock: string,
  senderEntityId: string,
  timestamp: number,
  randomNonce?: string
): string {
  const nonce = randomNonce || ethers.hexlify(ethers.randomBytes(8));
  return ethers.keccak256(
    ethers.solidityPacked(
      ['bytes32', 'bytes32', 'uint64', 'bytes8'],
      [hashlock, senderEntityId, timestamp, nonce]
    )
  );
}
```

**Changes:**
- Include senderEntityId (unique per sender)
- Use random nonce (not 0)
- Use solidityPacked for deterministic encoding

## Fix 2: Hash Encoding Mismatch (Medium - CRITICAL for interop)

### Current (Breaks Solidity)
```typescript
// htlc-utils.ts:55-59
export function hashSecret(secret: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(secret));
}

// htlc-reveal.ts:51-53
const computedHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
```

**Problem:** `toUtf8Bytes("0xabc...")` hashes the literal hex string, not the bytes.

Solidity does:
```solidity
keccak256(abi.encodePacked(secret))  // secret is bytes32
```

These will NEVER match, breaking on-chain dispute resolution.

### Fix
```typescript
// If secret is hex string (0x...):
export function hashSecret(secret: string): string {
  // Convert hex to bytes, then hash
  const secretBytes = ethers.getBytes(secret);
  return ethers.keccak256(secretBytes);
}

// If secret is arbitrary string (for demo):
export function hashSecretString(secret: string): string {
  // Hash UTF-8 encoded string (demo only, not Solidity-compatible)
  return ethers.keccak256(ethers.toUtf8Bytes(secret));
}
```

**Decision needed:** Should secrets be:
- A) 32-byte hex (Solidity-compatible, production)
- B) Arbitrary strings (demo-friendly, current)

Recommend A for production, keep B as separate demo function.

### Solidity Contract Must Match
```solidity
// Depository.sol or HTLC contract
function verifyPreimage(bytes32 hashlock, bytes32 secret) public pure returns (bool) {
    return keccak256(abi.encodePacked(secret)) == hashlock;
}
```

## Fix 3: Timelock Underflow (Medium)

### Current (Unsafe)
```typescript
// account.ts:161-174
const forwardedLock = {
  ...
  revealBeforeHeight: lock.revealBeforeHeight - 1,  // Can underflow!
  timelock: lock.timelock - 10n,                     // Can go negative!
};
```

**Problem:** On long routes or late-arriving locks, these can underflow to invalid values.

### Fix
```typescript
// Constants
const MIN_REVEAL_BLOCKS = 10;      // Minimum blocks to reveal
const MIN_TIMELOCK_SECONDS = 60n;  // Minimum 1 minute
const BLOCK_DECREMENT = 1;
const TIME_DECREMENT = 10n;

// In forwarding logic
const newRevealHeight = lock.revealBeforeHeight - BLOCK_DECREMENT;
const newTimelock = lock.timelock - TIME_DECREMENT;

// Validate before forwarding
if (newRevealHeight < currentHeight + MIN_REVEAL_BLOCKS) {
  return {
    success: false,
    error: `Cannot forward: revealBeforeHeight too soon (${newRevealHeight} < ${currentHeight + MIN_REVEAL_BLOCKS})`,
    events
  };
}

if (newTimelock < BigInt(currentTimestamp) + MIN_TIMELOCK_SECONDS) {
  return {
    success: false,
    error: `Cannot forward: timelock too soon (${newTimelock} < ${currentTimestamp + 60})`,
    events
  };
}

const forwardedLock = {
  ...lock,
  revealBeforeHeight: newRevealHeight,
  timelock: newTimelock,
};
```

## Fix 4: Timeout/Dispute Scenario (High)

### Current
lock-ahb.ts only tests cooperative path: lock → reveal → propagate.

No test for:
- Lock expires, sender reclaims
- Dispute on-chain (reveal to contract)
- Griefing prevention (reveal deadline enforcement)

### New Scenario: scenarios/htlc-timeout.ts

```typescript
/**
 * HTLC Timeout Scenario
 *
 * Tests non-cooperative path where receiver doesn't reveal.
 *
 * Flow:
 * 1. Alice locks payment to Bob via Hub
 * 2. Bob receives but does NOT reveal secret
 * 3. Time passes (simulate blocks)
 * 4. Lock expires (revealBeforeHeight passed)
 * 5. Alice (or Hub) triggers htlc_timeout
 * 6. Funds return to sender, holds released
 */

// Step 1: Create lock (same as lock-ahb.ts)
await aliceEntity.addAccountTx({
  type: 'htlc_lock',
  data: { lockId, hashlock, amount, revealBeforeHeight: currentHeight + 10 }
});

// Step 2: Forward to Bob (Hub does this)
// ... same as lock-ahb.ts

// Step 3: Bob does NOT reveal (simulating uncooperative receiver)

// Step 4: Advance time past expiry
env.currentHeight = currentHeight + 15;  // Past revealBeforeHeight

// Step 5: Trigger timeout
await hubEntity.addAccountTx({
  type: 'htlc_timeout',
  data: { lockId }
});

// Step 6: Verify
// - Lock removed from H-B account
// - Hub's hold released
// - Hub triggers timeout on A-H account
// - Alice's hold released
// - Net effect: no funds moved, everyone whole
```

### htlc_timeout Handler Checklist
- [ ] Verify lock exists
- [ ] Verify currentHeight > revealBeforeHeight (expired)
- [ ] Release sender's hold
- [ ] Remove lock from Map
- [ ] Emit event for upstream propagation
- [ ] Do NOT update offdelta (funds stay with sender)

## Testing Checklist

### Fix 1: lockId
- [ ] Different senders, same hashlock → different lockIds
- [ ] Same sender, same hashlock, different nonce → different lockIds
- [ ] lockId is deterministic given same inputs

### Fix 2: Hash Encoding
- [ ] JS hashSecret matches Solidity keccak256(abi.encodePacked(secret))
- [ ] On-chain dispute resolution works
- [ ] Demo mode still works with string secrets (separate function)

### Fix 3: Timelock Bounds
- [ ] Reject forward if revealBeforeHeight too soon
- [ ] Reject forward if timelock too soon
- [ ] Long routes (5+ hops) still work with reasonable initial timelock

### Fix 4: Timeout Path
- [ ] htlc_timeout releases hold
- [ ] htlc_timeout only works after expiry
- [ ] htlc_timeout propagates upstream
- [ ] Cannot reveal after timeout processed
- [ ] Cannot timeout before expiry

## Priority Order

1. **Hash encoding** (breaks on-chain interop - critical)
2. **Timelock bounds** (prevents forwarding failures)
3. **lockId collision** (safety for multi-sender)
4. **Timeout scenario** (completes security model)

## References

- Lightning BOLT #2: HTLC timeout handling
- Raiden: Secret reveal / timeout mechanics
- Current impl: runtime/account-tx/handlers/htlc-*.ts
