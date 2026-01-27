# TypeScript Type Safety Audit

## Executive Summary

The XLN codebase demonstrates strong type discipline in critical financial areas (branded types for identifiers, explicit BigInt handling) but has **15 compile-time errors** and **80+ instances of `any` usage** that reduce type safety. The most critical issues are:

1. **Type definition mismatch** - `DerivedDelta` interface missing fields that code returns
2. **Signature type confusion** - `ProposedEntityFrame.signatures` typed as `string[][]` but code uses `Map`
3. **`any` escape hatches** - Extensive `any` usage in financial event handling, reducing compile-time guarantees

---

## Critical (P0 - Runtime type errors possible)

- [ ] **DerivedDelta missing fields** (`/runtime/account-utils.ts:156`)
  - Code returns `peerCreditUsed` and `ownCreditUsed` but `DerivedDelta` interface in `/runtime/types.ts:1053-1070` lacks these fields
  - **Risk**: Runtime object has extra properties, but consumers may not know they exist
  - **Fix**: Add `peerCreditUsed: bigint` and `ownCreditUsed: bigint` to `DerivedDelta` interface

- [ ] **ProposedEntityFrame.signatures type mismatch** (`/runtime/types.ts:1365`, `/runtime/state-helpers.ts:309`)
  - `signatures` typed as `string[][]` but code calls `cloneMap(replica.proposal.signatures)` expecting `Map<unknown, unknown>`
  - Error: `Type 'string[][] | undefined' is not assignable to parameter of type 'Map<unknown, unknown>'`
  - **Risk**: Runtime crash when cloning proposals with signatures
  - **Fix**: Align type definition - either change interface to `Map<string, string>` or update clone code

- [ ] **JReplica.contracts optional mismatch** (`/runtime/state-helpers.ts:382`)
  - `contracts` can be `undefined` but assignment expects non-optional `{ depository?: string; ... }`
  - **Risk**: Snapshot creation fails with strict null checks
  - **Fix**: Make `contracts` explicitly optional: `contracts?: { ... } | undefined`

- [ ] **BrowserVMInstance missing methods** (`/runtime/state-helpers.ts:366-374`)
  - Code calls `browserVM?.captureStateRoot` and `browserVM?.serializeState` but `BrowserVMInstance` type in `/runtime/xln-api.ts:86-113` lacks these
  - **Risk**: TypeScript won't catch typos in method names; runtime errors possible
  - **Fix**: Add `captureStateRoot?(): Promise<Uint8Array>` and `serializeState?(): Promise<BrowserVMState>` to interface

- [ ] **Nullable string passed to non-null parameter** (`/runtime/state-helpers.ts:406,414,416`)
  - `entityId` from `key.split(':')[0]` is `string | undefined`, passed where `string` expected
  - **Risk**: `undefined` passed to functions expecting string, causing runtime errors
  - **Fix**: Add null check or use `extractEntityId()` from ids.ts

---

## High (P1 - Type safety gaps in financial code)

- [ ] **`any` in J-event handling** (`/runtime/j-event-watcher.ts:342-744`)
  - Multiple functions return `any[]` or accept `any`:
    - `browserVMEventToJEvents(...): any[]`
    - `rpcEventToJEvent(entityId: string, event: any): any | null`
  - **Risk**: Financial events processed without type validation
  - **Fix**: Define `BrowserVMEvent` and `RPCEvent` interfaces, use `JurisdictionEvent` return type

- [ ] **`any` in EntityTx data** (`/runtime/types.ts:434,448,468`)
  - Three EntityTx variants use `any`:
    - `chatMessage.metadata[key: string]: any`
    - `profile-update.data.profile: any`
    - `j_event_account_claim.events: any[]`
  - **Risk**: Invalid event data passes type checks
  - **Fix**: Create `ChatMetadata`, `ProfileData`, `JEventClaim` interfaces

- [ ] **`any` in Env fields** (`/runtime/types.ts:1291,1294,1321,1435,1438`)
  - Five `any` fields: `crontabState`, `jBatchState`, `orderbookExt`, `gossip`, `browserVM`
  - Comments note "avoid circular import" but doesn't require `any`
  - **Risk**: Mutations to these fields bypass type checking
  - **Fix**: Use `import type` and conditional types, or create `/runtime/shared-types.ts`

- [ ] **JTx.batch typed as `any`** (`/runtime/types.ts:1546`)
  - Settlement batches have no type validation at compile time
  - **Risk**: Malformed batches not caught until runtime/on-chain failure
  - **Fix**: Import `JBatch` type from `j-batch.ts`

- [ ] **XlnomySnapshot.evmState.vmState typed as `any`** (`/runtime/types.ts:1841,1849`)
  - Serialized VM state and replica state both `any`
  - **Risk**: Corrupted state could be loaded without detection
  - **Fix**: Define `SerializedVMState` and use `EntityReplica[]`

---

## Medium (P2 - Code quality / maintainability)

- [ ] **80+ `any` usage across runtime** (see grep results)
  - Heavy `any` in:
    - `/runtime/runtime.ts` (console wrappers, snapshot normalization)
    - `/runtime/entity-tx/j-events.ts` (event processing)
    - `/runtime/account-crypto.ts` (env parameter)
    - `/runtime/scenarios/*.ts` (test data structures)
  - **Impact**: Reduced IDE support, easier to introduce regressions

- [ ] **Type assertions (`as`) without validation** (40+ occurrences)
  - Examples:
    - `return entry as ReplicaEntry` in scenarios
    - `ext.orderbookExt as OrderbookExtState | undefined`
    - `new Map(raw as Array<[string, EntityReplica]>)`
  - **Risk**: If assumption is wrong, runtime crash
  - **Fix**: Use type guards before casting, or `satisfies` operator

- [ ] **console.log/warn/error use `any[]`** (`/runtime/runtime.ts:214-226`)
  ```typescript
  console.log = function(...args: any[]) { ... }
  ```
  - Necessary for console wrapper but creates type hole

- [ ] **Branded types not enforced everywhere** (`/runtime/ids.ts`)
  - Excellent `EntityId`, `SignerId`, `JId` branded types defined
  - But many functions accept plain `string` instead of branded type
  - Gradual migration in progress (see `safeParseReplicaKey`)

- [ ] **Optional chaining overuse** (various files)
  - Pattern `browserVM?.captureStateRoot` used even when `browserVM` existence was just checked
  - Creates false sense of safety while hiding missing type definitions

---

## Type System Recommendations

### 1. Fix Compile Errors First (P0)
The 15 compile errors from `bun run check` must be fixed before deployment:
```
/runtime/account-utils.ts:156 - Add missing DerivedDelta fields
/runtime/state-helpers.ts:104,298,309,318,366,367,370,373,374,382,406,414,416 - Fix null/type mismatches
```

### 2. Create Shared Type File
Move shared types to `/runtime/shared-types.ts` to break circular imports:
```typescript
// shared-types.ts
export interface CrontabState { ... }
export interface JBatchState { ... }
export interface OrderbookExtState { ... }
```
Then import with `import type { ... } from './shared-types'`.

### 3. Define Event Interfaces
```typescript
// event-types.ts
export interface BrowserVMEvent {
  name: string;
  args: {
    entityId?: string;
    tokenId?: bigint;
    ...
  };
}

export interface RPCEvent {
  event: string;
  args: unknown[];
  blockNumber: number;
  transactionHash: string;
}
```

### 4. Use `unknown` Instead of `any` for External Data
```typescript
// Before
function processEvent(event: any): JurisdictionEvent { ... }

// After
function processEvent(event: unknown): JurisdictionEvent {
  if (!isValidEvent(event)) throw new Error('Invalid event');
  return parseEvent(event);
}
```

### 5. Add Type Guards
```typescript
function isJurisdictionEvent(e: unknown): e is JurisdictionEvent {
  return typeof e === 'object' && e !== null && 'type' in e && 'data' in e;
}
```

### 6. BigInt Serialization is Correct
The `safeStringify`/`safeParse` pattern in `/runtime/serialization-utils.ts` properly handles BigInt:
- Serializes as `"BigInt(123)"`
- Revives back to `123n`
- Used consistently in snapshot-coder.ts

**No changes needed for BigInt serialization.**

---

## Files Reviewed

| File | Lines | Issues |
|------|-------|--------|
| `/runtime/types.ts` | 1853 | 8 `any`, 3 interface mismatches |
| `/runtime/xln-api.ts` | 346 | 2 `any` (acceptable for external module interface) |
| `/runtime/ids.ts` | 519 | 0 - Excellent branded types |
| `/runtime/evm-interface.ts` | 169 | 5 `any` in event listeners |
| `/runtime/state-helpers.ts` | 731 | 9 compile errors, 3 `any` |
| `/runtime/serialization-utils.ts` | 116 | 2 `any` (necessary for replacer/reviver) |
| `/runtime/account-utils.ts` | 228 | 1 compile error (DerivedDelta) |
| `/runtime/j-event-watcher.ts` | ~800 | 8 `any` in event processing |
| `/runtime/runtime.ts` | ~2300 | 12 `any` (console, snapshots) |
| `/runtime/account-crypto.ts` | ~450 | 4 `any` (env parameter) |
| `/runtime/entity-tx/j-events.ts` | ~350 | 6 `any` in event handling |

---

## Severity Summary

| Severity | Count | Action |
|----------|-------|--------|
| P0 - Critical | 5 | Fix before deployment |
| P1 - High | 5 | Fix in next sprint |
| P2 - Medium | 5 | Technical debt backlog |

**Total `any` occurrences**: 80+
**Total type assertions (`as`)**: 40+
**Compile errors**: 15

---

## Next Steps

1. **Immediate**: Fix the 5 P0 issues causing compile errors
2. **This week**: Address P1 issues in financial event handling
3. **Ongoing**: Gradually replace `any` with proper types during feature work
4. **CI/CD**: Enable `noImplicitAny` in tsconfig.json once P0/P1 resolved
