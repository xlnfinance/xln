# BrainVault Cryptographic Audit

**Auditor:** Claude Opus 4.5 (Automated Security Analysis)
**Date:** 2026-01-27
**Scope:** brainvault/ folder - core.ts, cli.ts, worker-*.ts, core.test.ts

## Executive Summary

BrainVault is a **well-designed** brain wallet implementation that significantly improves upon historical brain wallet disasters (brainwallet.io, etc.). The use of Argon2id with 256MB memory-hard sharding provides meaningful protection against commodity hardware attacks.

**Overall Assessment: MEDIUM-HIGH SECURITY**

The implementation is cryptographically sound for its stated purpose, with appropriate algorithm choices (Argon2id, BLAKE3, BIP39). However, brain wallets remain inherently dangerous due to human password entropy limitations. The sharding approach provides cost-multiplier defense but cannot compensate for weak passphrases.

**Key Strengths:**
- Argon2id with 256MB memory-hard requirement per shard
- Proper Unicode normalization (NFKD)
- Domain-separated key derivation
- BIP39-compliant mnemonic generation
- Deterministic salt derivation

**Key Weaknesses:**
- Time cost of 1 iteration is suboptimal
- Minimum passphrase length of 6 characters is too permissive
- No protection against passphrase enumeration attacks on common patterns
- Entropy estimation gives false confidence for dictionary-based passwords

---

## Critical (P0 - Key compromise possible)

- [ ] **NONE IDENTIFIED** - No immediate key compromise vulnerabilities found

---

## High (P1 - Weakens security significantly)

- [x] **H1: Argon2id time cost = 1 is suboptimal**
  - **Location:** `core.ts:25` - `ARGON_TIME_COST: 1`
  - **Issue:** OWASP recommends minimum t=3 for Argon2id. Single iteration reduces computational cost for attackers with optimized implementations.
  - **Impact:** Reduces attacker cost by ~3x compared to t=3
  - **Mitigation:** Cannot change (frozen spec), but future versions should use t=3+

- [x] **H2: Minimum passphrase length of 6 characters**
  - **Location:** `core.ts:29` - `MIN_PASSPHRASE_LENGTH: 6`
  - **Issue:** 6-character passphrases provide only ~28-47 bits of entropy depending on character classes. Combined with Argon2id cost, this may be crackable for low factors.
  - **Impact:** Factor 1-2 wallets with 6-char passwords are vulnerable to targeted attacks
  - **Mitigation:** UI should strongly discourage < 12 characters, enforce > 60 bits entropy

- [x] **H3: Entropy estimation assumes random character selection**
  - **Location:** `core.ts:91-127` - `estimatePasswordStrength()`
  - **Issue:** Estimation uses `log2(poolSize) * length` which is only valid for random passwords. Dictionary words, patterns like "Password123!" score much higher than actual entropy.
  - **Impact:** Users may believe weak passwords are strong
  - **Example:** "Password1!" scores 66 bits (rated "good") but is in common password lists
  - **Mitigation:** Integrate zxcvbn or similar pattern-aware estimator

- [x] **H4: No rate limiting in browser worker**
  - **Location:** `worker-browser.ts`
  - **Issue:** Browser derivation has no mechanism to prevent rapid retry attacks if an attacker gains access to user's browser session
  - **Impact:** Local attacker could rapidly iterate through common passphrases
  - **Mitigation:** Consider progressive delays between derivation attempts

---

## Medium (P2 - Best practice violations)

- [x] **M1: Salt includes mutable algorithm identifier**
  - **Location:** `core.ts:182-203` - `createShardSalt()`
  - **Issue:** Salt construction: `BLAKE3(name_NFKD || ALG_ID || shardCount || shardIndex)`. The ALG_ID string includes version making salt forward-compatible but tying wallets to specific version strings.
  - **Impact:** Low - version is frozen, but increases brittleness
  - **Note:** This is intentional domain separation, actually a good practice

- [x] **M2: Password suggestion uses weak PRNG**
  - **Location:** `BrainVaultView.svelte:161-175` - `suggestPassphrase()`
  - **Issue:** Uses `Math.random()` for passphrase suggestion which is not cryptographically secure
  - **Impact:** Suggested passphrases may be predictable if browser PRNG is compromised
  - **Mitigation:** Use `crypto.getRandomValues()` for word selection

- [x] **M3: Shard results stored in memory until complete**
  - **Location:** `cli.ts:37` - `const shardResults: Uint8Array[] = new Array(shardCount)`
  - **Issue:** All shard results held in memory simultaneously. For factor 5+ (10,000 shards), this is 320KB which is fine, but pattern allows memory inspection.
  - **Impact:** Low - data is intermediate, not the final key
  - **Mitigation:** Consider streaming XOR accumulation to reduce window

- [x] **M4: No memory wiping after key derivation**
  - **Location:** All files
  - **Issue:** JavaScript cannot reliably zero memory. Derived keys, mnemonics, and intermediate values may persist in heap.
  - **Impact:** Memory forensics could recover keys after derivation
  - **Mitigation:** Platform limitation - document as known issue

- [x] **M5: Test vectors use weak passwords**
  - **Location:** `core.test.ts:16-37` and `cli.ts:138-153`
  - **Issue:** Test vectors use passwords like "secret123456" and "password123" - same weak patterns users might choose
  - **Impact:** Low for tests, but normalizes weak password patterns
  - **Mitigation:** Use clearly random test passwords

- [x] **M6: BIP44 path hardcoded without user control**
  - **Location:** `core.ts:306` - `"m/44'/60'/0'/0/0"`
  - **Issue:** Only derives first account of Ethereum path. No support for other coins or account indices.
  - **Impact:** Limited to single ETH address without additional derivation
  - **Mitigation:** Accept path parameter for flexibility

---

## Low (P3 - Minor issues)

- [x] **L1: Console output in test file**
  - **Location:** `core.test.ts:112-113`
  - **Issue:** `console.log` statements in test file (acceptable for CLI tests)

- [x] **L2: Potential timing difference in salt construction**
  - **Location:** `core.ts:188-202` - Variable-length name encoding
  - **Issue:** Salt construction time varies with name length due to string encoding
  - **Impact:** Negligible - salt computation is not the sensitive operation

- [x] **L3: Worker error handling exposes stack traces**
  - **Location:** `worker-browser.ts:113`
  - **Issue:** Error responses include full stack trace which could leak implementation details
  - **Impact:** Information disclosure, not a crypto issue

---

## Attack Cost Analysis

### Assumptions
- Argon2id 256MB, t=1, p=1 per shard
- AWS c5.metal (96 vCPUs, 192GB RAM) at $4.08/hr can run ~700 shards/hour
- Optimized ASIC/FPGA provides ~10x speedup (memory-hard limits this)

### Cost per Factor Level

| Factor | Shards | Memory Equiv | Time (c5.metal) | Cost/Attempt | 10B Attempts |
|--------|--------|--------------|-----------------|--------------|--------------|
| 1 | 1 | 256MB | 5s | $0.006 | $57M |
| 2 | 10 | 2.5GB | 51s | $0.058 | $580M |
| 3 | 100 | 25GB | 8.5min | $0.58 | $5.8B |
| 4 | 1,000 | 256GB | 1.4hr | $5.80 | $58B |
| 5 | 10,000 | 2.5TB | 14hr | $58 | $580B |

### Attack Scenarios

**Scenario 1: Weak Password + Factor 3**
- Password: "summer2024" (common pattern, ~25 bits real entropy)
- Attempts needed: ~33 million (assuming pattern dictionary)
- Cost: 33M * $0.58 = **$19M**
- **Verdict: VULNERABLE** to well-funded attacker

**Scenario 2: Medium Password + Factor 4**
- Password: "MyDog-Spot-2019!" (40 bits real entropy)
- Attempts needed: ~1 trillion
- Cost: 1T * $5.80 = **$5.8 trillion**
- **Verdict: SECURE** against any attacker

**Scenario 3: Strong Password + Factor 2**
- Password: "correct-horse-battery-staple" (44 bits)
- Attempts needed: ~17 trillion
- Cost: 17T * $0.058 = **$1 trillion**
- **Verdict: SECURE** even at low factor

### GPU/ASIC Resistance

Argon2id's 256MB memory requirement per shard provides strong GPU resistance:
- RTX 4090 (24GB VRAM): Only 93 parallel computations possible
- ASIC development: Memory bandwidth is bottleneck, ~10x speedup ceiling
- Sharding prevents memory sharing between attempts

**Memory-hardness is the primary defense, not time cost.**

---

## Side Channel Analysis

### Timing Attacks

| Operation | Timing Constant? | Risk |
|-----------|------------------|------|
| NFKD normalization | NO | Low - name is public |
| BLAKE3 salt derivation | YES | None |
| Argon2id (hash-wasm) | YES | None (memory-hard) |
| Argon2id (@node-rs) | YES | None (native binding) |
| Shard combination | YES | None |
| BIP39 word lookup | NO | Low - post-derivation |
| ethers.js HD derivation | Unknown | Medium - external lib |

### Memory Access Patterns

- Argon2id memory access is data-independent by design
- BLAKE3 uses constant-time comparisons
- No secret-dependent branching observed in core algorithm

### Cache Timing

- WebAssembly (hash-wasm) provides some isolation
- Native binding (@node-rs) subject to system cache timing
- **Recommendation:** Run derivation in isolated process/worker

---

## Implementation Bug Analysis

### Off-by-One Errors

- [x] **NONE FOUND** - Shard indexing is 0-based and correctly bounded
- [x] Array allocations match shard count exactly

### Type Confusion

- [x] **NONE FOUND** - TypeScript provides type safety
- [x] Uint8Array used consistently for binary data
- [x] Proper hex encoding/decoding with length validation

### Integer Overflow

- [x] `getShardCount()` uses `Math.pow(10, factor - 1)` - safe for factor 1-9
- [x] Factor 9 = 100M shards = still within JS safe integer range

### Unicode Handling

- [x] **CORRECT** - NFKD normalization applied to both name and passphrase
- [x] TextEncoder used for UTF-8 byte conversion

### Endianness

- [x] **CORRECT** - `setUint32(0, value, false)` uses big-endian explicitly
- [x] Consistent across all platforms

---

## BIP39 Compliance Verification

| Requirement | Status | Notes |
|-------------|--------|-------|
| 2048-word English list | PASS | Complete wordlist embedded |
| 256-bit entropy for 24 words | PASS | `deriveKey(..., 32)` |
| 128-bit entropy for 12 words | PASS | `deriveKey(..., 16)` |
| SHA256 checksum | PASS | `sha256(entropy)` |
| Checksum bits = entropy/32 | PASS | Correct calculation |
| 11-bit word indices | PASS | `parseInt(chunk, 2)` |
| Space-separated output | PASS | `words.join(' ')` |

**BIP39 Implementation: COMPLIANT**

---

## Recommendations

### Critical (Implement before production use)

1. **Enforce minimum 40-bit entropy** - Reject passphrases below zxcvbn score 3
2. **Add passphrase strength warning** - Show attack cost estimate for chosen passphrase
3. **Document time cost limitation** - Users should understand t=1 tradeoff

### High Priority

4. **Integrate zxcvbn** - Replace naive entropy estimation with pattern-aware analysis
5. **Add derivation rate limiting** - Progressive delays in browser to prevent local brute-force
6. **Use crypto.getRandomValues()** - For passphrase suggestion in UI

### Medium Priority

7. **Consider t=3 for v2** - When breaking change is acceptable
8. **Add multi-coin derivation** - Support BIP44 paths for BTC, etc.
9. **Document memory forensics risk** - JavaScript cannot guarantee memory wiping

### Low Priority

10. **Streaming shard accumulation** - XOR shards incrementally to reduce memory window
11. **Sanitize error messages** - Remove stack traces in production builds

---

## Files Reviewed

| File | Lines | Purpose | Risk Areas |
|------|-------|---------|------------|
| `core.ts` | 592 | Main algorithm | Salt derivation, entropy, BIP39 |
| `cli.ts` | 323 | CLI interface | Input validation, worker management |
| `worker-native.ts` | 20 | Node.js worker | Argon2id binding |
| `worker-wasm.ts` | 9 | Legacy WASM worker | API compatibility |
| `worker-browser.ts` | 117 | Browser worker | Memory, timing |
| `core.test.ts` | 114 | Test vectors | Determinism verification |
| `readme.md` | 31 | Documentation | - |

---

## Conclusion

BrainVault represents a **significant improvement** over historical brain wallet implementations. The Argon2id sharding approach provides meaningful cost amplification against brute-force attacks.

However, **no amount of key derivation hardening can compensate for human password entropy**. A 6-character password with factor 5 is still weaker than a 20-character password with factor 1.

**Recommended minimum security posture:**
- Factor 3+ (100 shards)
- Passphrase with 60+ bits entropy (zxcvbn score 4)
- Unique passphrase not used elsewhere

**For high-value wallets (>$100K):**
- Factor 4+ (1,000 shards)
- Passphrase with 80+ bits entropy
- Consider hardware wallet with mnemonic export instead

---

*This audit is automated analysis. Manual review by cryptography experts is recommended before production deployment with significant funds.*
