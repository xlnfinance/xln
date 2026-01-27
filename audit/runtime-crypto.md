# Cryptographic Primitives Audit - Runtime Layer

**Auditor:** Claude Opus 4.5 (Automated Security Analysis)
**Date:** 2026-01-27
**Scope:** runtime/ folder - Signature schemes, hash functions, key derivation, randomness

---

## Executive Summary

The xln runtime implements a **multi-layered cryptographic architecture** supporting:
1. **Entity signatures** - secp256k1 (Ethereum-compatible) via @noble/secp256k1
2. **Hanko aggregated signatures** - Multi-signer entity governance
3. **Account bilateral consensus** - Frame signing with hanko
4. **Onion routing encryption** - X25519 + ChaCha20-Poly1305 (noble/ciphers)
5. **Key derivation** - BIP-39 HD wallets + HMAC-SHA256 for named signers

**Overall Assessment: MEDIUM-HIGH SECURITY**

The implementation uses well-audited cryptographic libraries (@noble/*, ethers.js) with correct algorithm choices. The primary concerns are:
- Non-constant-time buffer comparisons (timing attack surface)
- Missing signature verification in some code paths
- Flashloan governance intentionally allows circular entity validation

---

## Critical (P0 - Key/signature compromise possible)

- [x] **P0-1: Non-constant-time signature/buffer comparisons**
  - **Location:** Multiple files use `===` for signature/buffer comparison
    - `runtime/entity-consensus.ts:128` - `existingSig !== newSignature`
    - `runtime/account-consensus.ts:1041` - `ourComputedState !== theirClaimedState`
    - `runtime/hanko-signing.ts:128` - `detectByzantineFault` signature comparison
  - **Issue:** String equality in JavaScript is not constant-time. An attacker could use timing differences to extract signature bytes incrementally.
  - **Impact:** Theoretical timing attack on signature verification. Requires local network position.
  - **Severity:** MEDIUM-HIGH - Mitigated by signatures being public in most protocols
  - **Mitigation:** Use `crypto.timingSafeEqual()` or manual constant-time comparison

- [x] **P0-2: Intentional circular entity validation ("flashloan governance")**
  - **Location:** `runtime/hanko.ts:5-36` (documented design decision)
  - **Issue:** Entities can mutually validate each other without any EOA signatures. This is **intentional** but violates traditional cryptographic trust models.
  - **Impact:** Two colluding entities can create valid hankos without hardware key involvement
  - **Severity:** LOW (by design) - UI layer must enforce EOA requirements
  - **Mitigation:** `verifyHankoForHash()` in hanko-signing.ts now requires board validation

---

## High (P1 - Significant security weakness)

- [x] **P1-1: createHash fallback uses weak non-cryptographic hash**
  - **Location:** `runtime/utils.ts:35-66` - Browser fallback for `createHash('sha256')`
  - **Issue:** Browser fallback uses a simple DJB2-like hash that repeats 8 hex chars to fill 32 bytes. This produces **collisions** trivially.
  - **Code:**
    ```typescript
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
    }
    const baseHash = Math.abs(hash).toString(16).padStart(8, '0');
    const fullHash = (baseHash + baseHash + baseHash + baseHash).slice(0, 64);
    ```
  - **Impact:** Hash collisions possible. Second preimage attacks trivial.
  - **Severity:** HIGH if used for security-critical hashing
  - **Mitigation:** This appears to be a demo fallback. The `hanko.ts` and `account-crypto.ts` use proper `ethers.keccak256`. Audit code paths to ensure no security-critical use.

- [x] **P1-2: randomBytes uses crypto.getRandomValues (correct) but no CSPRNG validation**
  - **Location:** `runtime/utils.ts:70-77`
  - **Issue:** No check that `crypto.getRandomValues` is available/working. Falls through to Node's `crypto.randomBytes` which is correct.
  - **Impact:** If browser crypto API is compromised/missing, could fail open
  - **Severity:** MEDIUM - Modern browsers all support this
  - **Mitigation:** Add explicit check and throw if CSPRNG unavailable

- [x] **P1-3: HTLC secret generation uses browser crypto without validation**
  - **Location:** `runtime/htlc-utils.ts:66-71` - `generateHashlock()`
  - **Code:**
    ```typescript
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    ```
  - **Issue:** Direct use of global `crypto` without checking availability
  - **Impact:** Could throw in unusual environments
  - **Severity:** LOW - Standard API, but should validate

- [x] **P1-4: Frame hash uses non-cryptographic placeholder**
  - **Location:** `runtime/entity-consensus.ts:587`
  - **Code:**
    ```typescript
    const frameHash = `frame_${workingReplica.state.height + 1}_${newTimestamp}`;
    ```
  - **Issue:** This "hash" is just a formatted string, not a cryptographic commitment. Validators sign this, meaning they don't commit to transaction content.
  - **Impact:** Equivocation attacks possible - proposer could claim different tx sets for same frame
  - **Severity:** HIGH for multi-validator setups
  - **Mitigation:** Comment notes this as TODO for BFT hardening. Replace with Merkle root.

---

## Medium (P2 - Best practice violations)

- [x] **P2-1: Signature recovery byte handling inconsistent**
  - **Location:** `runtime/hanko.ts:169-170`, `runtime/account-crypto.ts:361`
  - **Issue:** Recovery byte (v) handling varies:
    - hanko.ts: `v >= 27 ? v - 27 : v` for yParity
    - account-crypto.ts: `recovery.toString(16).padStart(2, '0')` as raw append
  - **Impact:** Potential signature format incompatibility
  - **Severity:** MEDIUM - Both paths work but inconsistent

- [x] **P2-2: Key derivation cache not cleared on seed change**
  - **Location:** `runtime/account-crypto.ts:129-139` - `setRuntimeSeed()`
  - **Issue:** `setRuntimeSeed()` clears caches but `runtimeSeedLocked` flag can block this
  - **Impact:** Stale keys could persist if seed update is blocked
  - **Severity:** LOW - Lock is intentional security feature

- [x] **P2-3: HMAC-based key derivation for named signers**
  - **Location:** `runtime/account-crypto.ts:116-127`
  - **Issue:** Named signers (non-numeric) use `HMAC-SHA256(masterSeed, signerId)` instead of proper KDF like HKDF
  - **Impact:** Simpler than HKDF but cryptographically sound. No salt/context separation.
  - **Severity:** LOW - HMAC-SHA256 is acceptable for key derivation

- [x] **P2-4: Deterministic RNG uses keccak256 with UTF-8 encoding**
  - **Location:** `runtime/deterministic-rng.ts:42-58`
  - **Issue:** RNG uses `ethers.keccak256(ethers.toUtf8Bytes(input))` - correct but UTF-8 encoding adds overhead
  - **Impact:** None - functionally correct
  - **Severity:** INFORMATIONAL

- [x] **P2-5: Noble crypto provider uses raw shared secret as key**
  - **Location:** `runtime/crypto-noble.ts:41-42`
  - **Code:**
    ```typescript
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, recipientPubBytes);
    const key = sharedSecret.slice(0, 32);
    ```
  - **Issue:** Uses raw X25519 output directly as ChaCha20 key without HKDF
  - **Impact:** Theoretically suboptimal. NIST recommends HKDF after ECDH.
  - **Severity:** LOW - X25519 output is already uniformly distributed

- [x] **P2-6: RSA-OAEP with SHA-256 (WebCrypto provider)**
  - **Location:** `runtime/crypto-webcrypto.ts:12-17`
  - **Issue:** 4096-bit RSA-OAEP is secure but deprecated for new protocols
  - **Impact:** None - this is fallback/alternative to X25519
  - **Severity:** INFORMATIONAL

---

## Low (P3 - Minor issues)

- [x] **P3-1: Verbose logging of cryptographic operations**
  - **Location:** `runtime/account-crypto.ts:146-162`, `runtime/hanko.ts:187`
  - **Issue:** Console.log statements log key derivation and signature operations
  - **Impact:** Information disclosure in browser console
  - **Mitigation:** Already has `quietRuntimeLogs` guard in some places

- [x] **P3-2: Buffer polyfill type casting**
  - **Location:** `runtime/hanko-signing.ts:17`, `runtime/hanko.ts:57`
  - **Issue:** `return bytes as Buffer` type casts Uint8Array to Buffer
  - **Impact:** Type safety reduced, but functionally correct

- [x] **P3-3: seeded-rng modulo bias**
  - **Location:** `runtime/scenarios/seeded-rng.ts:61-64`
  - **Code:**
    ```typescript
    const value = BigInt(bytes);
    return value % max;
    ```
  - **Issue:** Modulo of keccak256 output can have slight bias for small max values
  - **Impact:** Negligible - only used in scenarios, not production

---

## Signature Verification Analysis

### Entity Frame Signing (entity-consensus.ts)

```
Flow:
1. Proposer creates frame with txs
2. Frame hash = `frame_${height}_${timestamp}` (WEAK - not content-bound)
3. Proposer signs with signAccountFrame() -> keccak256(frameHash) + secp256k1
4. Validators sign same hash
5. Threshold reached -> commit
```

**Issues:**
- Frame hash doesn't commit to transaction content
- Same height+timestamp could have different tx sets

### Account Frame Signing (account-consensus.ts)

```
Flow:
1. Proposer creates AccountFrame with full state
2. Frame hash = keccak256(JSON(frameData)) including:
   - height, timestamp, jHeight
   - prevFrameHash (chain linkage)
   - accountTxs, tokenIds, deltas
   - fullDeltaStates
3. Sign with signHashesAsSingleEntity() -> hanko
4. Counterparty verifies with verifyHankoForHash()
5. ACK with hanko on same hash
```

**Strengths:**
- Full state commitment in hash
- Chain linkage via prevFrameHash
- Bilateral verification required

### Hanko Signature System (hanko.ts, hanko-signing.ts)

```
Flow:
1. Build hanko with:
   - placeholders (failed entities)
   - packedSignatures (EOA secp256k1 sigs)
   - claims (entity governance rules)
2. Each claim: { entityId, entityIndexes, weights, threshold }
3. Verification: recover signers, check board membership, validate threshold
```

**Key Security:**
- `verifyHankoForHash()` now requires board validation (P0-2 mitigation)
- Must verify recovered addresses against entity's validator list
- Rejects hankos without EOA signatures

---

## Randomness Analysis

| Source | Location | Quality | Use Case |
|--------|----------|---------|----------|
| `crypto.getRandomValues()` | utils.ts:70-74 | CSPRNG | HTLC secrets, encryption nonces |
| `crypto.randomBytes()` | utils.ts (Node) | CSPRNG | Same, Node.js path |
| Deterministic RNG | deterministic-rng.ts | keccak256-based | Scenario testing |
| Seeded RNG | seeded-rng.ts | keccak256-based | HTLC secrets in scenarios |

**Finding:** Production code uses CSPRNGs correctly. Deterministic RNGs are clearly scoped to scenario/test code.

---

## Serialization for Signing

### Deterministic JSON (safeStringify)
- **Location:** `runtime/serialization-utils.ts`
- **Handles:** BigInt, Map, Set, Buffer, Functions
- **Issue:** Standard JSON key ordering not guaranteed
- **Mitigation:** Account frames use explicit field ordering

### Frame Hash Serialization
- **Location:** `runtime/account-consensus.ts:148-186`
- **Method:** `JSON.stringify` with `safeStringify` for BigInt
- **Issue:** JSON key order can vary between implementations
- **Mitigation:** Both sides compute hash independently and compare

### ABI Encoding for Contracts
- **Location:** `runtime/hanko-signing.ts:109-123`
- **Method:** `ethers.AbiCoder.defaultAbiCoder().encode()`
- **Status:** Deterministic - ABI encoding is well-specified

---

## Key Derivation Analysis

### BIP-39 HD Wallet (Numeric Signers)
- **Location:** `runtime/account-crypto.ts:104-109`
- **Method:** `HDNodeWallet.fromPhrase(mnemonic, undefined, path)`
- **Path:** `getIndexedAccountPath(index)` (MetaMask compatible)
- **Status:** CORRECT - Standard BIP-39/44 derivation

### HMAC Key Derivation (Named Signers)
- **Location:** `runtime/account-crypto.ts:125-127`
- **Method:** `hmac(sha256, masterSeed, signerId)`
- **Status:** ACCEPTABLE - Not HKDF but cryptographically sound

### BrainVault Master Key
- **Location:** `brainvault/core.ts` (separate audit exists)
- **Method:** Argon2id sharded + BLAKE3
- **Status:** See `/audit/brainvault-crypto.md`

---

## Timing Attack Surface

| Operation | Constant-Time? | Risk Level |
|-----------|----------------|------------|
| secp256k1 signing (@noble) | YES | None |
| secp256k1 verify (@noble) | YES | None |
| keccak256 (ethers) | YES | None |
| HMAC-SHA256 (@noble) | YES | None |
| Buffer comparison | NO | MEDIUM |
| String comparison (signatures) | NO | MEDIUM |
| JSON serialization | NO | LOW |
| ChaCha20-Poly1305 (@noble) | YES | None |
| X25519 (@noble) | YES | None |

**Recommendation:** Replace all signature/hash comparisons with constant-time variants.

---

## Files Reviewed

| File | Lines | Purpose | Risk Areas |
|------|-------|---------|------------|
| `account-crypto.ts` | 430 | secp256k1 signing, key derivation | Key caching, HMAC KDF |
| `hanko-signing.ts` | 300 | Hanko creation/verification | Board validation, ABI encoding |
| `hanko.ts` | 644 | Signature packing, flashloan governance | Circular validation (by design) |
| `crypto-noble.ts` | 101 | X25519 + ChaCha20-Poly1305 | Raw ECDH key use |
| `crypto-webcrypto.ts` | 105 | RSA-OAEP fallback | Deprecated for new use |
| `crypto-provider.ts` | 36 | Interface definition | - |
| `serialization-utils.ts` | 116 | BigInt-safe JSON | Determinism |
| `sign-as-entity.ts` | 76 | Hash collection for signing | - |
| `deterministic-rng.ts` | 103 | Scenario RNG | Test use only |
| `scenarios/seeded-rng.ts` | 94 | HTLC secret generation | Modulo bias (minor) |
| `htlc-utils.ts` | 108 | HTLC fee/timelock calculations | Randomness source |
| `entity-consensus.ts` | 1209 | Entity frame consensus | Weak frame hash |
| `account-consensus.ts` | 1420 | Bilateral consensus | Timing comparisons |
| `utils.ts` | 492 | Utility functions | Weak hash fallback |

---

## Recommendations

### Critical (Before Production)

1. **Replace string comparisons with constant-time equivalents**
   ```typescript
   // Instead of: if (sig1 !== sig2)
   import { timingSafeEqual } from 'crypto';
   const eq = timingSafeEqual(Buffer.from(sig1, 'hex'), Buffer.from(sig2, 'hex'));
   ```

2. **Replace weak entity frame hash with Merkle root**
   ```typescript
   // Instead of: `frame_${height}_${timestamp}`
   const txRoot = computeMerkleRoot(txs.map(tx => keccak256(serialize(tx))));
   const frameHash = keccak256(abi.encode(['uint256', 'uint256', 'bytes32'], [height, timestamp, txRoot]));
   ```

3. **Remove weak hash fallback in utils.ts**
   - Ensure all browser paths use Web Crypto API
   - Fail explicitly if crypto unavailable

### High Priority

4. **Add HKDF step after X25519** in crypto-noble.ts
5. **Validate CSPRNG availability** before generating secrets
6. **Document flashloan governance risks** in protocol spec

### Medium Priority

7. **Standardize signature recovery byte format** across all signing code
8. **Add frame size limits** to prevent DoS via large payloads
9. **Consider adding nonce to frame hash** for replay protection enhancement

---

## Conclusion

The xln runtime cryptographic layer is **fundamentally sound**, using well-audited libraries (@noble/*, ethers.js) for core operations. The primary concerns are:

1. **Timing attacks** via non-constant-time comparisons (fixable)
2. **Weak entity frame hash** not binding to transaction content (needs redesign)
3. **Flashloan governance** allows circular validation (documented, UI must enforce)

For a financial protocol handling real value, these issues should be addressed before mainnet deployment. The bilateral account consensus (account-consensus.ts) is notably more robust than the entity-level consensus.

**Security Rating:** B+ (Good foundation, needs hardening for production)

---

*This audit is automated analysis. Manual review by cryptography experts is recommended before production deployment with significant funds.*
