# Jurisdiction Layer Audit

## Executive Summary

The Jurisdiction (J-machine) layer provides blockchain integration for the xln protocol, handling entity registration, reserve management, settlement processing, and dispute resolution. The codebase implements a dual-mode architecture (BrowserVM for simnet, RPC for mainnet) with a unified interface pattern.

**Overall Risk Assessment: MEDIUM-HIGH**

Key concerns:
- No block confirmation waiting for finality (events processed immediately)
- No explicit reorg detection or handling
- Hardcoded private key in evm.ts (development convenience that could leak to production)
- Cross-chain entity ID collisions possible
- Settlement nonce desynchronization risk on failed batches

---

## Critical (P0)

- [ ] **NO-REORG-HANDLING**: The j-event-watcher processes events immediately upon observation without waiting for block confirmations. The `CONFIRMATION_BLOCKS: 12` constant in constants.ts is defined but **never used** in event processing code. A chain reorganization could cause the system to apply events that are later reverted, leading to state divergence between on-chain and off-chain state.
  - **Location**: `/runtime/j-event-watcher.ts` lines 262-336, `/runtime/constants.ts` line 143
  - **Impact**: Fund loss if settlements are processed then reorged out
  - **Recommendation**: Implement confirmation waiting before finalizing j-blocks; track block hashes and detect when observed hashes no longer exist in canonical chain

- [ ] **HARDCODED-PRIVATE-KEY**: Production-grade private key handling uses hardcoded Hardhat account in `evm.ts`:
  ```typescript
  const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  ```
  - **Location**: `/runtime/evm.ts` line 186
  - **Impact**: If this code path is used in production, all transactions would be signed by the same well-known key
  - **Recommendation**: Remove hardcoded key; require explicit signer injection

---

## High (P1)

- [ ] **SETTLEMENT-NONCE-DESYNC**: When a batch broadcast fails (`HankoBatchProcessed` with `success=false`), the jBatch is not cleared but `pendingBroadcast` remains true. The on-chain nonce has NOT been consumed, but the local state may have incremented `onChainSettlementNonce` optimistically. Recovery path is unclear.
  - **Location**: `/runtime/entity-tx/j-events.ts` lines 806-832
  - **Impact**: Entity may become unable to submit new batches or may submit with wrong nonce
  - **Recommendation**: Add explicit nonce reconciliation on batch failure; query on-chain nonce before retry

- [ ] **CROSS-CHAIN-ENTITY-COLLISION**: Entity IDs are 32-byte hashes that do not include chain ID. The same entity ID could theoretically exist on multiple chains with different state. The `JurisdictionConfig` tracks `chainId` but entity registration does not bind entity ID to chain.
  - **Location**: `/runtime/types.ts` lines 222-228
  - **Impact**: Cross-chain attacks where an entity on chain A claims to be the same entity on chain B
  - **Recommendation**: Include chainId in entity ID derivation or track entity-chain binding

- [ ] **NO-JBLOCK-GAP-HANDLING**: The j-block consensus code (`tryFinalizeJBlocks`) skips blocks that are already finalized but does not handle gaps. If block N+1 arrives before block N, block N will never be finalized.
  - **Location**: `/runtime/entity-tx/j-events.ts` lines 99-107
  - **Impact**: Missed events if j-watcher delivers blocks out of order
  - **Recommendation**: Implement gap detection and request missing blocks; or buffer out-of-order observations

- [ ] **BILATERAL-JBLOCK-RACE**: AccountSettled events require 2-of-2 bilateral consensus, but there's no timeout handling if counterparty never sends their j_event_claim. The entity would be stuck waiting forever.
  - **Location**: `/runtime/entity-tx/j-events.ts` lines 152-243
  - **Impact**: Denial of service by unresponsive counterparty
  - **Recommendation**: Add timeout with fallback to on-chain dispute

---

## Medium (P2)

- [ ] **SIMULATED-TX-HASH**: BrowserVM generates fake transaction hashes using `Math.random()`:
  ```typescript
  hash: '0x' + Math.random().toString(16).slice(2)
  ```
  - **Location**: `/runtime/jurisdiction/browser-jurisdiction.ts` lines 112, 139
  - **Impact**: Testing may not catch issues related to tx hash uniqueness; non-deterministic in simnet mode
  - **Recommendation**: Use deterministic hash generation (e.g., keccak256 of batch content + nonce)

- [ ] **NO-GAS-PRICE-CHECK**: The `MAX_GAS_PRICE_GWEI: 300` constant is defined but never enforced. Transactions could be submitted at any gas price.
  - **Location**: `/runtime/constants.ts` line 149
  - **Impact**: Excessive gas costs during network congestion
  - **Recommendation**: Add gas price check before transaction submission

- [ ] **PROOF-BODY-HASH-MISMATCH-CONTINUES**: When dispute proof hash doesn't match on-chain, the code logs an error but continues:
  ```typescript
  if (localProof.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
    console.error(`❌ CONSENSUS DIVERGENCE...`);
    // Continue but log for audit
  }
  ```
  - **Location**: `/runtime/entity-tx/j-events.ts` lines 756-764
  - **Impact**: Disputes may proceed with incorrect state
  - **Recommendation**: Treat hash mismatch as critical failure; halt and require manual intervention

- [ ] **SINGLE-RPC-FAILOVER**: `RpcJurisdiction` uses a single `JsonRpcProvider` with no failover:
  - **Location**: `/runtime/jurisdiction/rpc-jurisdiction.ts` line 60
  - **Impact**: Single point of failure for RPC connectivity
  - **Recommendation**: Implement RPC rotation from `rpcs: string[]` array defined in config

- [ ] **STALE-TOKEN-CACHE**: `RpcJurisdiction.loadTokens()` is called once during `init()` and never refreshed:
  - **Location**: `/runtime/jurisdiction/rpc-jurisdiction.ts` lines 85-104
  - **Impact**: Newly added tokens will not be recognized until restart
  - **Recommendation**: Add token refresh mechanism or cache invalidation

- [ ] **BROWSERVM-METHODS-THROW**: Several methods in `BrowserJurisdiction` throw "not implemented" or call unimplemented `BrowserVMProvider` methods:
  - **Location**: `/runtime/jurisdiction/browser-jurisdiction.ts` lines 124-127, `/runtime/evms/browser-evm-adapter.ts` lines 47-51, 157-158
  - **Impact**: Feature gaps between browser and RPC modes
  - **Recommendation**: Implement or clearly document unsupported operations

---

## Multi-Chain Security Analysis

### Cross-Chain Risks

1. **Entity ID Portability**: Entity IDs are derived from board hashes without chain binding. An entity registered on Base could claim to be "the same" entity on Ethereum mainnet. The system relies on contract addresses being different per chain, but entity IDs themselves are portable.

2. **No Bridge Protocol**: The codebase has no native cross-chain bridge. Multi-chain operation is treated as isolated jurisdictions. This is actually safer (no bridge = no bridge exploits) but limits interoperability.

3. **Chain ID in Hanko Hash**: The batch hanko hash correctly includes chainId (`computeBatchHankoHash`), preventing replay of batch signatures across chains:
   ```typescript
   return ethers.keccak256(ethers.solidityPacked(
     ['bytes32', 'uint256', 'address', 'bytes', 'uint256'],
     [BATCH_DOMAIN_SEPARATOR, chainId, depositoryAddress, encodedBatch, nonce]
   ));
   ```

### Block Finality

| Chain | Assumed Finality | Actual Finality | Gap |
|-------|-----------------|-----------------|-----|
| Ethereum | 12 blocks (~3 min) | 12 blocks (conservative) | NONE (but unused) |
| Base | 12 blocks | ~5 minutes (L1 finality) | CRITICAL |
| BrowserVM | Instant | Instant | NONE |

**Critical Gap**: For L2s like Base, the code's 12-block assumption is insufficient. L2 transactions need L1 finality (~12 ETH blocks after L2 sequencer posts batch) before being truly final. The current code would accept L2 events immediately.

### Reorg Handling

**Current Status: NOT IMPLEMENTED**

The codebase has no explicit reorg detection. Observations from the `types.ts` comment suggest awareness:
```typescript
// TODO: For multi-signer production, add appliedJBlockHashes: Set<string>
// to track exact block hashes and reject conflicting observations
```

**Reorg Scenario Analysis**:
1. Entity observes AccountSettled in block N
2. Block N is finalized locally, reserves updated
3. Chain reorgs, block N is replaced by block N'
4. Block N' has different (or no) AccountSettled event
5. Entity state is now divergent from chain

**Recommended Mitigation**:
- Implement `appliedJBlockHashes` as noted in TODO
- On receiving observation for height H with different hash: trigger reconciliation
- For L2: track L1 finality of L2 batches before local finalization

---

## Contract Interaction Security

### Depository Contract

**processBatch()**: Main entry point for all entity operations. Security relies on:
- Hanko signature verification (EntityProvider validates board)
- Nonce tracking per entity (replay protection)
- ChainId in domain separator (cross-chain replay protection)

**Potential Issues**:
1. Gas limit hardcoded to 5M (`PROCESS_BATCH_GAS_LIMIT`) - large batches could exceed this
2. No tx.wait() timeout - could hang indefinitely on slow chains
3. Failed batches leave `pendingBroadcast=true` requiring manual `j_clear_batch`

### EntityProvider Contract

**registerNumberedEntity()**: Entity creation. Security relies on:
- Board hash uniqueness (no two entities with same board)
- Admin-only name assignment

**Potential Issue**: Batch registration (`registerNumberedEntitiesBatch`) has no limit on array size, allowing potential DoS via gas exhaustion.

---

## State Root Verification

### Current Implementation

State root verification is implicit rather than explicit:

1. **BrowserVM**: Tracks state root via `@ethereumjs/vm` internally; exposed through `captureStateRoot()` for time-travel
2. **RPC Mode**: No state root verification - trusts RPC responses entirely

### Verification Gaps

- No Merkle proof verification for RPC responses
- No cross-validation between multiple RPC endpoints
- Event data from single RPC assumed correct

### Recommended Improvements

1. For mainnet: Use execution client with `eth_getProof` for state verification
2. Implement RPC response validation against multiple endpoints
3. Add state root commitment to j-block consensus (signers attest to state root)

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `/runtime/jurisdiction/index.ts` | 41 | Module exports |
| `/runtime/jurisdiction/interface.ts` | 212 | IJurisdiction interface, factory |
| `/runtime/jurisdiction/browser-jurisdiction.ts` | 173 | In-memory simnet implementation |
| `/runtime/jurisdiction/rpc-jurisdiction.ts` | 224 | Production RPC implementation |
| `/runtime/j-event-watcher.ts` | 874 | Blockchain event subscription |
| `/runtime/j-batch.ts` | 973 | Batch aggregation system |
| `/runtime/evm.ts` | 964 | EVM connection utilities |
| `/runtime/evm-interface.ts` | 169 | Unified EVM interface |
| `/runtime/evms/browser-evm-adapter.ts` | 270 | BrowserVM EVM wrapper |
| `/runtime/evms/rpc-evm-adapter.ts` | 265 | RPC EVM wrapper |
| `/runtime/entity-tx/j-events.ts` | 842 | J-event processing handlers |
| `/runtime/types.ts` | 1853 | Type definitions |
| `/runtime/constants.ts` | 264 | System constants |

---

## Summary Table

| Severity | Count | Key Issues |
|----------|-------|------------|
| P0 Critical | 2 | No reorg handling, hardcoded private key |
| P1 High | 4 | Nonce desync, cross-chain collision, gap handling, bilateral timeout |
| P2 Medium | 6 | Simulated tx hash, gas price, proof mismatch, RPC failover, token cache, browser methods |

---

*Audit conducted: 2026-01-27*
*Auditor: Claude Opus 4.5*
