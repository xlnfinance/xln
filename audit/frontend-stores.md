# Frontend Stores Security Audit

## Executive Summary

The frontend stores handle cryptographic secrets (mnemonics, private keys) with **critical security vulnerabilities**. Raw 12-word mnemonics are stored unencrypted in localStorage and exposed in JavaScript memory. The seed is passed through multiple store layers, logged in console statements, and persisted without any encryption. This architecture would allow any XSS attack or malicious browser extension to extract all user funds.

---

## Critical (P0 - Key Exposure Possible)

- [x] **vaultStore.ts:16** - Raw mnemonic stored in `Runtime.seed` as plaintext string
- [x] **vaultStore.ts:132** - `localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(current))` stores entire runtime state including raw seeds unencrypted
- [x] **vaultStore.ts:453-461** - `getActiveSignerPrivateKey()` returns raw private key string, held in memory
- [x] **vaultStore.ts:464-472** - `getSignerPrivateKey()` exposes private keys for any signer index
- [x] **runtimeStore.ts:9** - `Runtime.seed?: string` field propagates seed through runtime layer
- [x] **runtimeStore.ts:12** - `Runtime.apiKey?: string` stores API key in plaintext
- [x] **runtimeStore.ts:77** - `ws.send(JSON.stringify({ type: 'auth', apiKey }))` sends API key over WebSocket (unencrypted if not WSS)

---

## High (P1 - Security Risk)

- [x] **vaultStore.ts:98-99** - Seed passed through `syncRuntime()` to runtimeStore metadata
- [x] **vaultStore.ts:182** - Console log mentions seed location: `console.log('[VaultStore.createRuntime] Runtime seed stored in env.runtimeSeed (pure)')`
- [x] **vaultStore.ts:263** - `seed: runtime.seed` explicitly stored in runtimes Map
- [x] **vaultStore.ts:524** - `seed: runtime.seed` propagated during initialization
- [x] **xlnStore.ts:28-47** - `exposeGlobalDebugObjects()` exposes XLN runtime to `window.XLN` and `window.xlnEnv` - any script can access
- [x] **xlnStore.ts:145-147** - Environment exposed to window: `(window as any).xlnEnv = env` for "e2e testing" - includes all runtime state
- [x] **runtimeStore.ts:166-176** - `setLocalRuntimeMetadata()` accepts seed and stores in runtime object without protection
- [x] **errorLogStore.ts:40** - `JSON.stringify(entry.details)` may serialize sensitive data in error logs

---

## Medium (P2 - Defense in Depth)

- [x] **settingsStore.ts:29-40** - Settings loaded from localStorage without validation; malicious data could be injected
- [x] **tabStore.ts:19-32** - Tab data loaded from localStorage with JSON.parse without schema validation
- [x] **timeStore.ts:9-21** - Time state loaded from localStorage without validation
- [x] **appStateStore.ts:74-90** - App state loaded from localStorage; no input sanitization
- [x] **xlnStore.ts:232-458** - `xlnFunctions` derived store exposes entity data that could contain user-identifying information
- [x] **jurisdictionStore.ts:70-83** - External jurisdiction data loaded without validation
- [x] **networkStore.ts:13** - RPC provider created from potentially untrusted network config

---

## State Management Review

### Store Interaction Flow (Security-Critical Path)
```
User creates vault
    -> vaultStore.createRuntime(name, seed)
        -> Stores seed in Runtime object (line 151)
        -> Saves to localStorage unencrypted (line 170)
        -> Creates env with xln.createEmptyEnv(seed) (line 179)
        -> Adds to runtimes store with seed (line 257-269)
        -> Syncs seed to runtimeStore (line 276)
```

### Race Condition Risks
1. **vaultStore.ts:343-352** - `addSigner()` calls async `autoCreateEntityForSigner()` without awaiting, then immediately calls `fundSignerWalletInBrowserVM()`. Entity creation could fail silently.

2. **xlnStore.ts:120-161** - `registerEnvChangeCallback` triggers async import of runtimeStore, creating potential timing issues between env updates and store syncs.

3. **vaultStore.ts:487-543** - `initialize()` has complex async flow: loads from storage, checks existing runtime, creates new env if needed. Multiple await points without atomic state updates.

### Data Exposure Surface
| Store | Persisted Data | Encryption | Risk |
|-------|---------------|------------|------|
| vaultStore | Mnemonics, addresses, entity IDs | **NONE** | CRITICAL |
| runtimeStore | Seeds, API keys (in memory) | **NONE** | CRITICAL |
| xlnStore | Full environment state | N/A (memory) | HIGH |
| settingsStore | UI preferences | N/A | LOW |
| tabStore | Tab metadata | N/A | LOW |
| timeStore | Time machine index | N/A | LOW |
| appStateStore | Mode, navigation | N/A | LOW |

---

## Specific Vulnerability Analysis

### 1. localStorage Plaintext Storage
**File:** `/Users/zigota/xln/frontend/src/lib/stores/vaultStore.ts`
**Lines:** 109-137

```typescript
// Current implementation - VULNERABLE
saveToStorage() {
  const current = get(runtimesState);
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(current)); // Raw seed!
}
```

**Impact:** Any script running in the same origin can read `localStorage.getItem('xln-vaults')` and extract all mnemonics. Browser extensions with storage permissions can also access this.

### 2. Global Window Exposure
**File:** `/Users/zigota/xln/frontend/src/lib/stores/xlnStore.ts`
**Lines:** 28-48

```typescript
function exposeGlobalDebugObjects() {
  window.XLN = XLN;           // Full runtime access
  window.xlnEnv = xlnEnvironment;  // All state
  window.xlnErrorLog = ...;   // Error logging
}
```

**Impact:** Any XSS payload can call `window.XLN` functions. Console access in shared environments exposes everything.

### 3. Private Key Derivation API
**File:** `/Users/zigota/xln/frontend/src/lib/stores/vaultStore.ts`
**Lines:** 453-472

```typescript
getActiveSignerPrivateKey(): string | null {
  return derivePrivateKey(runtime.seed, runtime.activeSignerIndex);
}
```

**Impact:** Private keys are derived on-demand but returned as strings. No memory protection, keys persist until garbage collected.

### 4. WebSocket API Key Transmission
**File:** `/Users/zigota/xln/frontend/src/lib/stores/runtimeStore.ts`
**Lines:** 73-77

```typescript
async connectRemote(uri: string, apiKey: string): Promise<void> {
  const ws = new WebSocket(`ws://${uri}/ws`);  // Note: ws:// not wss://
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', apiKey }));
  };
```

**Impact:** API key sent over unencrypted WebSocket if not using TLS. URI constructed without protocol validation.

---

## XSS Vector Analysis

### @html Usage in Frontend (from grep results)
The `@html` directive is used in landing page components with content that appears to be static/controlled:
- `LandingPage.svelte` - Multiple uses for formatted content
- `DocsView.svelte:170` - Renders markdown as HTML (`{@html renderedHtml}`)

**Risk:** If DocsView renders user-supplied or external markdown, XSS is possible. Landing page content appears to be from a controlled `c` object (likely i18n/config).

### Store Data Rendering
No direct `@html` usage of store data found, but entity IDs and addresses are rendered throughout the UI. If an attacker could inject malicious entityId/address strings, they could potentially exploit any unsafe rendering.

---

## Files Reviewed

| File | Path | Lines |
|------|------|-------|
| vaultStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/vaultStore.ts` | 605 |
| xlnStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/xlnStore.ts` | 459 |
| runtimeStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/runtimeStore.ts` | 200 |
| settingsStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/settingsStore.ts` | 153 |
| networkStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/networkStore.ts` | 30 |
| appStateStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/appStateStore.ts` | 163 |
| errorLogStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/errorLogStore.ts` | 44 |
| jurisdictionStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/jurisdictionStore.ts` | 114 |
| routePreviewStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/routePreviewStore.ts` | 23 |
| tabStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/tabStore.ts` | 162 |
| visualEffects.ts | `/Users/zigota/xln/frontend/src/lib/stores/visualEffects.ts` | 174 |
| timeStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/timeStore.ts` | 295 |
| vaultUiStore.ts | `/Users/zigota/xln/frontend/src/lib/stores/vaultUiStore.ts` | 27 |
| brainvault/core.ts | `/Users/zigota/xln/brainvault/core.ts` | 592 |

---

## Recommendations (Priority Order)

### P0 - Immediate (Before Any Production Use)

1. **Encrypt localStorage data** - Use Web Crypto API with user-provided password to encrypt vault data before storage
2. **Remove global window exposure** - Delete or gate `exposeGlobalDebugObjects()` behind dev-mode flag
3. **Memory protection for keys** - Clear private keys from memory immediately after signing, use TypedArrays that can be zeroed
4. **Audit all console.log statements** - Remove any that mention seeds/keys/secrets

### P1 - Short Term

1. **Add CSP headers** - Strict Content-Security-Policy to prevent XSS
2. **Validate all localStorage reads** - Schema validation with zod or similar
3. **Use wss:// for remote connections** - Enforce TLS for WebSocket connections
4. **Session-based key derivation** - Derive keys fresh for each session, don't store

### P2 - Medium Term

1. **Hardware wallet integration** - Move signing to hardware device
2. **Encrypted IndexedDB** - Use encrypted storage for larger state
3. **Audit third-party dependencies** - Especially ethers.js, hash-wasm imports
4. **Add security headers** - X-Frame-Options, X-Content-Type-Options, etc.

---

## BrainVault Note

The `brainvault/core.ts` implements a memory-hard key derivation using Argon2id, which is appropriate for brain wallet security. However, the derived mnemonic is still stored unencrypted in vaultStore after derivation, negating the memory-hard protection against offline attacks on the stored data.

---

*Audit conducted: 2026-01-27*
*Auditor: Claude Opus 4.5 Security Review*
