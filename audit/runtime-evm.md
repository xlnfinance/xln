# EVM Integration Audit

**Auditor:** Claude Opus 4.5
**Date:** 2026-01-27
**Scope:** runtime/evm.ts, runtime/browservm.ts, runtime/evms/*.ts, runtime/evm-interface.ts

## Executive Summary

The EVM integration implements a dual-mode architecture: BrowserVM (in-memory @ethereumjs/vm for testing/demos) and RPC (real blockchain via ethers.js). The code is generally well-structured with proper ABI encoding/decoding via ethers.js interfaces. However, several security concerns require attention, primarily around hardcoded test keys in production paths, inconsistent error handling, and potential state deserialization vulnerabilities.

**Risk Level:** Medium-High (primarily due to hardcoded keys and state restoration issues)

---

## Critical (P0)

- [ ] **HARDCODED PRIVATE KEY IN PRODUCTION PATH** (`runtime/evm.ts:186`)
  ```typescript
  const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const signer = new ethers.Wallet(privateKey, provider);
  ```
  - This Hardhat test key is used in `connectToEthereum()` which handles REAL RPC connections
  - While documented as "browser-compatible, no getSigner", this is dangerous for mainnet
  - **Impact:** Any transaction through this path uses a publicly known private key
  - **Recommendation:** Require explicit signer injection; never hardcode keys for non-BrowserVM paths

- [ ] **SAME KEY IN BROWSERVM DEPLOYER** (`runtime/browservm.ts:85`)
  ```typescript
  this.deployerPrivKey = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  ```
  - Expected for BrowserVM (test environment), but sharing the same key across modules creates confusion
  - **Recommendation:** Document clearly that this key is ONLY for BrowserVM simnet; use different identifier

---

## High (P1)

- [ ] **STATE DESERIALIZATION VULNERABLE TO TAMPERING** (`runtime/browservm.ts:1822-1928`)
  - `restoreState()` accepts serialized trie data without integrity verification
  - No hash validation of restored state matches expected stateRoot
  - localStorage-based state (`loadFromLocalStorage`) can be manipulated by malicious scripts
  ```typescript
  // Restores state without cryptographic verification
  trieMap.set(keyHex, hexToBytesSafe(valueHex));
  await this.vm.stateManager.setStateRoot(stateRoot);
  ```
  - **Impact:** Attacker with localStorage access could inject malicious EVM state
  - **Recommendation:** Add HMAC or signature verification for persisted state

- [ ] **INSUFFICIENT ERROR DETAIL PROPAGATION** (multiple locations)
  - Many error handlers catch and re-throw with generic messages, losing stack traces
  - Example in `browservm.ts:1324-1326`:
  ```typescript
  throw new Error(`Batch processing failed: ${errorLabel}${reasonSuffix}`);
  ```
  - **Impact:** Debugging complex failures is difficult; silent failures possible
  - **Recommendation:** Preserve original error chain; use cause property

- [ ] **TRANSACTION SIGNING WITHOUT CHAIN ID VERIFICATION** (`runtime/evm.ts:312-357`)
  - `submitProcessBatch` computes batch hash with chainId but doesn't verify signer matches expected chain
  - No protection against replay attacks across chains if same contracts deployed
  - **Recommendation:** Verify chainId matches expected jurisdiction before signing

---

## Medium (P2)

- [ ] **INCONSISTENT GAS LIMITS** (multiple files)
  - BrowserVM uses varying gas limits without clear rationale:
    - Contract deployment: `100000000n` (100M)
    - ERC20 operations: `200000n`
    - Settle operations: `30000000n` or `2000000n` based on sig length
    - Read calls: `100000n`
  - No gas estimation for BrowserVM; hardcoded in `browservm-ethers-provider.ts:82-83`:
  ```typescript
  case 'estimateGas':
    return 1000000; // Fixed, ignores actual computation
  ```
  - **Impact:** Transaction failures due to OOG not caught; no optimization possible
  - **Recommendation:** Implement proper gas estimation or document limits clearly

- [ ] **NONCE TRACKING INCONSISTENCY** (`runtime/browservm.ts`)
  - `this.nonce` field exists but `getCurrentNonce()` always queries VM state
  - Potential race condition if multiple transactions in flight
  ```typescript
  private async getCurrentNonce(): Promise<bigint> {
    const account = await this.vm.stateManager.getAccount(this.deployerAddress);
    return account?.nonce || 0n;
  }
  ```
  - **Recommendation:** Use atomic nonce management or remove unused field

- [ ] **MISSING INPUT VALIDATION** (multiple functions)
  - `debugFundReserves`, `reserveToReserve`, `settleWithInsurance` don't validate:
    - entityId format (should be bytes32)
    - tokenId bounds
    - amount overflow protection
  - **Recommendation:** Add explicit validation at entry points

- [ ] **EVENT CALLBACK ERROR SWALLOWING** (`runtime/evms/browser-evm-adapter.ts:29-35`)
  ```typescript
  listeners.forEach(listener => {
    try {
      listener(...Object.values(event.args || {}));
    } catch (e) {
      console.error(`Event listener error for ${event.name}:`, e);
    }
  });
  ```
  - Errors in event listeners are logged but not propagated
  - **Impact:** Silent failures in critical event handlers (e.g., state sync)
  - **Recommendation:** Option to fail-fast for critical listeners

- [ ] **CONTRACT VERSION CHECK BYPASS** (`runtime/browservm.ts:1954-1960`)
  - Version mismatch only logs warning and clears cache; doesn't prevent use
  - Could lead to ABI mismatches if state persisted with old contract version
  - **Recommendation:** Hard fail on version mismatch with user prompt

- [ ] **SIMULATED TX HASH IN BROWSERVM** (`runtime/evms/browser-evm-adapter.ts:77`)
  ```typescript
  hash: '0x' + Math.random().toString(16).slice(2), // Simulated tx hash
  ```
  - Uses `Math.random()` which violates determinism requirements from CLAUDE.md
  - **Impact:** Non-reproducible test scenarios
  - **Recommendation:** Use deterministic hash based on block/nonce

---

## BrowserVM Security

### Isolation Analysis

**Positive:**
- Each `BrowserEVM` instance creates isolated `BrowserVMProvider` (line 16)
- No shared global state between instances (singleton removed per comment line 10)
- VM created with `createVM()` fresh each init
- Custom common with chainId 1337 for clear separation

**Concerns:**
1. **localStorage persistence** - State can leak between sessions or be tampered
2. **Contract size limit disabled** (`allowUnlimitedContractSize: true`) - Expected for simnet but could mask issues
3. **Admin bypass** - `mintToReserve`, `setDefaultDisputeDelay` callable without Hanko
4. **Wallet cache shared** - `entityWallets` Map persists across operations within instance

### Time Travel Security
- `captureStateRoot()` / `timeTravel()` properly use VM's stateManager
- State roots are Uint8Array (raw bytes), not hex strings - potential encoding issues
- No validation that time-traveled state is from same session

### Event Emission
- Events emitted synchronously after tx execution
- `emitEvents()` parses logs using contract interfaces - proper ABI decoding
- Callbacks receive batched events matching real blockchain behavior

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `/Users/zigota/xln/runtime/evm.ts` | 964 | Main EVM integration, jurisdiction management |
| `/Users/zigota/xln/runtime/browservm.ts` | 2153 | In-browser EVM implementation |
| `/Users/zigota/xln/runtime/evm-interface.ts` | 169 | Unified EVM abstraction types |
| `/Users/zigota/xln/runtime/evms/browser-evm.ts` | 117 | BrowserEVM wrapper class |
| `/Users/zigota/xln/runtime/evms/browser-evm-adapter.ts` | 270 | EVM interface adapter for BrowserVM |
| `/Users/zigota/xln/runtime/evms/rpc-evm-adapter.ts` | 265 | EVM interface adapter for RPC chains |
| `/Users/zigota/xln/runtime/evms/test-evm-interface.ts` | 57 | Interface test harness |
| `/Users/zigota/xln/runtime/browservm-ethers-provider.ts` | 95 | ethers.js provider wrapper |
| `/Users/zigota/xln/runtime/jurisdiction-loader.ts` | 107 | Jurisdiction config loading |

---

## Recommendations Summary

1. **Immediate (P0):** Remove hardcoded private key from production RPC path; require signer injection
2. **Short-term (P1):** Add state integrity verification; improve error propagation
3. **Medium-term (P2):** Standardize gas handling; fix nonce management; add input validation
4. **Long-term:** Consider formal verification for settlement signature encoding

---

## Appendix: Contract Call Flow

```
User Request
    │
    ▼
evm.ts (connectToEthereum)
    │
    ├─ BrowserVM path ─────► browservm.ts (BrowserVMProvider)
    │                              │
    │                              ▼
    │                        @ethereumjs/vm (runTx)
    │
    └─ RPC path ───────────► ethers.JsonRpcProvider
                                   │
                                   ▼
                             Real Blockchain
```
