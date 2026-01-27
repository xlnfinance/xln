# Name Resolution Audit

## Executive Summary

The XLN name resolution system operates on two layers: an on-chain name registry in `EntityProvider.sol` and an off-chain gossip-based profile system in `name-resolution.ts`. The on-chain system is relatively secure due to foundation-only name assignment, but the off-chain system has significant vulnerabilities including lack of name uniqueness enforcement, missing unicode normalization, and no validation of profile updates.

**Risk Level: HIGH** - Multiple issues could enable spoofing attacks in the gossip layer.

---

## Critical (P0)

- [x] **C1: Off-chain name index overwrites without collision detection**
  - **Location**: `/Users/zigota/xln/runtime/name-resolution.ts:63`
  - **Issue**: `updateNameIndex()` directly overwrites `nameIndex[name.toLowerCase()] = entityId` without checking if the name is already taken by a different entity
  - **Impact**: Any entity can squat on names in the gossip layer by calling `storeProfile()` with a desired name, overwriting legitimate mappings
  - **Code**:
    ```typescript
    // Line 63 - NO collision check before assignment
    nameIndex[name.toLowerCase()] = entityId;
    ```

- [x] **C2: No hanko signature verification in processProfileUpdate**
  - **Location**: `/Users/zigota/xln/runtime/name-resolution.ts:142-205`
  - **Issue**: `processProfileUpdate()` accepts `hankoSignature` as a parameter but never verifies it cryptographically
  - **Impact**: Any caller can forge profile updates for any entity without proving ownership
  - **Code**:
    ```typescript
    // Line 142-148 - signature passed but never verified
    export const processProfileUpdate = async (
      db: any,
      entityId: string,
      updates: ProfileUpdateTx,
      hankoSignature: string,  // NEVER VERIFIED!
      env?: Env,
    ): Promise<void> => {
    ```

---

## High (P1)

- [x] **H1: Unicode/Homograph attacks not mitigated**
  - **Location**: `/Users/zigota/xln/runtime/name-resolution.ts`, `/Users/zigota/xln/jurisdictions/contracts/EntityProvider.sol`
  - **Issue**: No unicode normalization, confusable detection, or punycode handling anywhere in the codebase (grep for `unicode|homograph|normalize|confusable|punycode` returns no results in name-related code)
  - **Impact**: Attacker can register `c\u043Einbase` (Cyrillic 'o') to impersonate `coinbase`
  - **On-chain**: EntityProvider.sol only checks `bytes(name).length > 0 && bytes(name).length <= 32` (line 231)
  - **Off-chain**: Only `toLowerCase()` normalization applied

- [x] **H2: Gossip profile timestamp bypass**
  - **Location**: `/Users/zigota/xln/runtime/gossip.ts:91-103`
  - **Issue**: Profile updates are accepted if `newTimestamp >= existingTimestamp`, allowing same-timestamp overwrites
  - **Impact**: Race condition enables profile hijacking when two profiles have identical timestamps
  - **Code**:
    ```typescript
    const shouldUpdate = !existing ||
      newTimestamp > existingTimestamp ||
      (newTimestamp === existingTimestamp && (  // SAME timestamp allows override
        (!existing.runtimeId && !!normalizedProfile.runtimeId) || ...
      ));
    ```

- [x] **H3: No rate limiting on name registration attempts**
  - **Location**: `/Users/zigota/xln/jurisdictions/contracts/EntityProvider.sol:230-244`
  - **Issue**: `assignName()` has no cooldown or fee, only `onlyFoundation` modifier
  - **Impact**: If foundation key is compromised, attacker can reassign all names instantly

---

## Medium (P2)

- [x] **M1: Reserved names list is hardcoded and non-extensible at runtime**
  - **Location**: `/Users/zigota/xln/jurisdictions/contracts/EntityProvider.sol:88-91`
  - **Issue**: Only 4 names reserved in constructor: `coinbase`, `ethereum`, `bitcoin`, `uniswap`
  - **Impact**: High-value names like `stripe`, `visa`, `mastercard` can be squatted

- [x] **M2: Name search reveals all registered names**
  - **Location**: `/Users/zigota/xln/runtime/name-resolution.ts:77-124`
  - **Issue**: `searchEntityNames()` iterates through entire name index without access control
  - **Impact**: Enables enumeration of all registered entity names for targeted attacks

- [x] **M3: Profile bio/website fields not sanitized**
  - **Location**: `/Users/zigota/xln/runtime/name-resolution.ts:165-168`
  - **Issue**: No validation on `bio` or `website` fields which could contain malicious URLs
  - **Impact**: Phishing via malicious website links in profiles

- [x] **M4: Name transfer can orphan entities**
  - **Location**: `/Users/zigota/xln/jurisdictions/contracts/EntityProvider.sol:252-266`
  - **Issue**: `transferName()` deletes old entity's name without confirmation
  - **Impact**: Foundation can forcibly remove names from entities

---

## Name Security Analysis

### Name Squatting

| Layer | Risk | Details |
|-------|------|---------|
| On-chain | LOW | `assignName()` requires foundation signature via `onlyFoundation` modifier |
| Off-chain | CRITICAL | Any entity can claim any name in gossip layer by calling `storeProfile()` |

**On-chain protection**: The foundation entity (#1) controls name assignment. Names map to entity numbers, not entity IDs directly. This is secure assuming foundation key isn't compromised.

**Off-chain vulnerability**: The gossip layer has NO authority check. Profile names are stored based on `entityId` key, but the name index maps `name.toLowerCase() -> entityId` without verifying the entity actually owns that name on-chain.

### Name Collision

| Layer | Risk | Details |
|-------|------|---------|
| On-chain | NONE | `require(nameToNumber[name] == 0, "Name already assigned")` prevents duplicates |
| Off-chain | CRITICAL | Last writer wins - no uniqueness enforcement |

**On-chain**: Solidity mapping prevents duplicate names.

**Off-chain collision attack**:
1. Alice registers entity with name "Bank" in gossip
2. Bob calls `storeProfile()` with name "Bank" for his entity
3. Name index now points to Bob's entity
4. Alice's name is silently overwritten

### Spoofing

| Vector | Risk | Mitigation Present |
|--------|------|-------------------|
| Unicode homographs | HIGH | NONE |
| Case manipulation | LOW | `.toLowerCase()` normalization |
| Whitespace injection | MEDIUM | No `.trim()` on stored names |
| Zero-width characters | HIGH | NONE |

**Attack example**:
```
Legitimate: "Coinbase" (entityId: 0x42)
Attacker:   "Coinbase\u200B" (entityId: 0x666)  // Zero-width space
```
Both display as "Coinbase" but map to different entities.

### Resolution Correctness

| Function | Correctness | Issue |
|----------|------------|-------|
| `resolveEntityName()` | CORRECT | Returns profile name or formatted ID |
| `searchEntityNames()` | BUGGY | Relevance scoring inconsistent (lines 92-97) |
| On-chain `resolveEntityId()` | INCOMPLETE | String parsing not implemented (line 490) |

**On-chain resolution gap**: `resolveEntityId()` tries to parse identifier as name, but the string-to-uint parser is noted as not implemented:
```solidity
// Note: This would need a string-to-uint parser in practice
return bytes32(0);
```

### Unicode Attack Vectors

No unicode handling exists in the codebase:
- No NFC/NFD normalization
- No confusable character detection (Unicode TR39)
- No punycode handling
- No script mixing prevention (Latin + Cyrillic)

**Recommended mitigations** (not implemented):
1. Apply NFKC normalization to all names
2. Reject names with mixed scripts
3. Use confusable detection library (e.g., `confusables` npm package)
4. Limit character set to ASCII alphanumeric + limited punctuation

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `/Users/zigota/xln/runtime/name-resolution.ts` | Off-chain name registry and profile management |
| `/Users/zigota/xln/runtime/gossip.ts` | Gossip layer profile storage |
| `/Users/zigota/xln/runtime/types.ts` | Type definitions for EntityProfile, NameIndex |
| `/Users/zigota/xln/runtime/entity-factory.ts` | Entity ID generation and name detection |
| `/Users/zigota/xln/runtime/evm.ts` | On-chain name assignment interface |
| `/Users/zigota/xln/jurisdictions/contracts/EntityProvider.sol` | On-chain name registry contract |
| `/Users/zigota/xln/jurisdictions/contracts/Depository.sol` | Settlement contract (no name logic) |

---

## Recommendations

### Immediate (Pre-Launch)

1. **Add hanko verification to profile updates** - Verify `hankoSignature` in `processProfileUpdate()` before applying changes
2. **Enforce on-chain name ownership in gossip layer** - Before accepting a profile name, query `EntityProvider.numberToName()` to verify ownership
3. **Add unicode normalization** - Apply NFKC normalization to all name inputs

### Short-term

4. **Implement name uniqueness in gossip layer** - Reject profiles with names already owned by different entities
5. **Add reserved name list management** - Allow foundation to add/remove reserved names dynamically
6. **Sanitize bio/website fields** - Validate URLs, reject javascript: and data: schemes

### Long-term

7. **Implement DNS-style name hierarchy** - `user.company.xln` to reduce squatting
8. **Add name expiration and renewal** - Prevent indefinite squatting
9. **Implement dispute resolution** - Allow trademark holders to reclaim names
