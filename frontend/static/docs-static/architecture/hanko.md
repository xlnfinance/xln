# hanko: xln's universal signature system

## overview

hanko is a hierarchical multi-signature authorization system. entities (organizations) sign hashes via weighted quorum of EOA signers. one hanko proves an entity authorized an action - works on-chain (EP.sol ecrecover) and off-chain (secp256k1 verification).

**three-part structure:**
```
HankoBytes {
  placeholders: bytes32[]     // failed entities (index 0..N-1)
  packedSignatures: bytes     // EOA sigs packed R,S,V (index N..M-1)
  claims: HankoClaim[]        // entity verification claims (index M..inf)
}

HankoClaim {
  entityId: bytes32           // entity being verified
  entityIndexes: uint256[]    // indexes into placeholders/sigs/claims
  weights: uint256[]          // voting power per index
  threshold: uint256          // required total power
}
```

## file map

| file | role |
|------|------|
| `runtime/hanko.ts` | core primitives: sign, pack, unpack, recover, flashloan governance |
| `runtime/hanko-signing.ts` | consensus integration: signEntityHashes, buildQuorumHanko, verifyHankoForHash |
| `runtime/account-crypto.ts` | key derivation: BIP-39 + HMAC-SHA256, signDigest, verifyAccountSignature |
| `runtime/entity-consensus.ts` | entity frame consensus: proposal, hashesToSign, commit with hanko attachment |
| `jurisdictions/contracts/EntityProvider.sol` | on-chain verification: verifyHankoSignature, ecrecover, board hash |
| `jurisdictions/contracts/Types.sol` | solidity struct definitions |

## signing flow (end to end)

### 1. proposer creates entity frame

```
entity-consensus.ts:828
applyEntityFrame(env, state, mempool)
  -> returns { newState, deterministicState, outputs, collectedHashes }

deterministicState = state BEFORE account proposals (matches validator verification)
collectedHashes = account frame stateHashes + dispute hashes needing entity signing
```

### 2. proposer computes frame hash

```
entity-consensus.ts:862-868
createEntityFrameHash(prevFrameHash, height, timestamp, txs, deterministicForHash)
  -> keccak256(JSON.stringify({
       prevFrameHash, height, timestamp, txs,
       entityId, reserves, lastFinalizedJHeight,
       accountHashes (sorted by cpId: height + stateHash + ackedTransitions),
       htlcRoutesHash, htlcFeesEarned, lockBookHash, swapBookHash, orderbookHash
     }))
```

**determinism guarantee:** proposer hashes from `deterministicState` (before account proposals). validators apply txs with `verifyOnly=true` which returns before account proposals. both get identical state -> identical hash.

### 3. proposer builds hashesToSign array

```
entity-consensus.ts:873-897
hashesToSign = [
  { hash: frameHash, type: 'entityFrame', context: 'entity:XXXX:frame:N' },
  ...collectedHashes.sort(by hash)  // accountFrame, dispute, profile, settlement
]
```

entity frame hash is always index 0 (signatures[0] used for frame verification).

### 4. proposer self-signs all hashes

```
entity-consensus.ts:900-902
selfSigs = hashesToSign.map(h => signFrame(env, signerId, h.hash))

account-crypto.ts:356-364 (signDigest)
  secp256k1.signSync(messageBytes, privateKey, { recovered: true, der: false })
  -> 0x{r}{s}{recovery} (65 bytes hex)
```

**no double-hash:** signs raw keccak256 output directly. on-chain `ecrecover(hash, sig)` expects this.

### 5. proposer sends proposal to validators

```
entity-consensus.ts:921-930
proposedFrame = {
  height, txs, hash: frameHash, newState, outputs, jOutputs,
  hashesToSign, collectedSigs: Map([[selfId, selfSigs]])
}
-> broadcast to all config.validators except self
```

### 6. validator verifies and signs

```
entity-consensus.ts:496-578
1. check canVerify: state.height >= proposedFrame.height - 1
   - if behind (missed frames while offline): skip verification, wait for commit
   - BFT: up-to-date validators provide quorum

2. apply txs with verifyOnly=true:
   applyEntityFrame(env, state, txs, true)
   -> returns deterministicState (no account proposals)

3. compute hash locally:
   createEntityFrameHash(prevHash, height, timestamp, txs, validatorNewState)

4. compare: validatorComputedHash === proposedFrame.hash
   - mismatch -> reject (equivocation attack or state bug)
   - match -> sign ALL hashesToSign

5. send hashPrecommits to proposer:
   Map([[validatorSignerId, allSignatures]])
```

### 7. proposer collects quorum

```
entity-consensus.ts:620-648
calculateQuorumPower(config, signers) >= config.threshold

for each hash in hashesToSign:
  collect signatures from all validators
  buildQuorumHanko(env, entityId, hash, sigsForHash, config)
```

### 8. buildQuorumHanko assembles final hanko

```
hanko-signing.ts:152-227
1. parse each validator's signature (65 bytes: r[32] + s[32] + v[1])
2. normalize v (< 27 -> + 27)
3. pack all signatures: packRealSignatures(sigBuffers)
   - R,S concatenated (64 bytes each)
   - V bits packed 8-per-byte
4. build claim:
   entityIndexes = [0, 1, 2, ...] (index in packedSignatures)
   weights = [share_of_validator_0, share_of_validator_1, ...]
   threshold = config.threshold
5. ABI encode: tuple(bytes32[], bytes, tuple(bytes32, uint256[], uint256[], uint256)[])
```

### 9. hanko attached to account outputs

```
entity-consensus.ts:679-695
for each output with accountInput.newAccountFrame.stateHash:
  lookup hankoWitness[stateHash]
  attach as accountInput.newHanko
```

### 10. commit notification to validators

```
entity-consensus.ts:722-742
proposer sends committedFrame (with collectedSigs + hankos) to all validators
validators verify signatures and apply committed state
```

## on-chain verification (EP.sol)

### verifyHankoSignature(hankoData, hash)

```solidity
1. decode HankoBytes from ABI
2. unpack signatures (_unpackSignatures)
3. REQUIRE signatureCount > 0 (no pure circular refs)
4. recover EOA addresses via ecrecover(hash, sig)
5. for each claim:
   a. build HIERARCHICAL board hash via _buildBoardHash (see below)
   b. validate entity (lazy: entityId == boardHash, registered: stored boardHash match)
   c. sum voting power:
      - placeholders: 0 (board member who didn't authorize)
      - EOA signatures: weights[i] (signed directly)
      - entity claims: weights[i] (ASSUME YES - flashloan governance)
   d. REQUIRE eoaVotingPower >= threshold (EOA alone must suffice)
   e. REQUIRE totalVotingPower >= threshold
6. return last claim's entityId if all pass
```

### _buildBoardHash(hanko, actualSigners, claim)

**hierarchical board reconstruction using entityIndexes:**
```solidity
for each entityIndexes[i]:
  idx < placeholderCount?
    → entityIds[i] = placeholders[idx]              // board member who didn't authorize
  idx < placeholderCount + signerCount?
    → entityIds[i] = bytes32(actualSigners[idx-N])  // EOA who signed
  else?
    → entityIds[i] = claims[idx-N-M].entityId       // nested entity who authorized

boardHash = keccak256(abi.encode(Board{threshold, entityIds, weights, delays...}))
```

**three index zones:**
- `0..N-1` → placeholders (EOAs or entities who didn't authorize - stored as bytes32)
- `N..M-1` → EOA signatures (recovered addresses converted to bytes32)
- `M..∞` → entity claims (entityId from nested HankoClaim)

this enables:
- M-of-N: only M board members need to authorize
- hierarchical: board can include other entities (Corp A → Corp B → Corp C)
- mixed: board with both EOAs and entity members

### _recoverSigner(hash, signature)

```solidity
assembly { r, s, v from signature bytes }
if (v < 27) v += 27
return ecrecover(hash, v, r, s)
```

raw hash, no ethereum signed message prefix. matches `signDigest` in account-crypto.ts.

### _unpackSignatures(packedSignatures)

```
detect count from byte length: length = count * 64 + ceil(count / 8)
for each sig:
  R,S = packed[i*64..(i+1)*64]
  V bit = packed[rsBytes + i/8] >> (i%8) & 1
  V = bit ? 28 : 27
```

### _validateEntity(entityId, boardHash)

```
lazy entity (no stored board): entityId MUST == boardHash
registered entity: boardHash MUST == entities[entityId].currentBoardHash
```

### _buildBoardHash(actualSigners, claim)

```solidity
Board {
  votingThreshold: claim.threshold,
  entityIds: signers as bytes32[],
  votingPowers: claim.weights as uint16[],
  boardChangeDelay: 0,
  controlChangeDelay: 0,
  dividendChangeDelay: 0
}
boardHash = keccak256(abi.encode(Board))
```

## off-chain verification (verifyHankoForHash)

```
hanko-signing.ts:238-410
1. ABI decode hanko
2. recoverHankoEntities (flashloan governance simulation)
3. unpack EOA signatures, require count > 0
4. recover addresses via ethers.recoverAddress(hash, {r, s, v, yParity})
5. find claim matching expectedEntityId
6. board validation (MANDATORY):
   a. lookup entity replica -> config.validators
   b. derive expected addresses from validator signerIds
   c. fallback: gossip profile metadata
   d. fallback: cached public key registry
   e. ALL recovered addresses MUST be in expected board
   f. if no board found -> REJECT (production safety)
7. valid if yesEntities.length > 0 AND entityId matches AND board verified
```

## key derivation

```
account-crypto.ts
numeric signerId (e.g., "1", "2", "3"):
  BIP-39 mnemonic from seed -> HDNodeWallet.fromPhrase(mnemonic, path)
  path = getIndexedAccountPath(index)  // MetaMask-style derivation

non-numeric signerId:
  HMAC-SHA256(masterSeed, signerId)

all keys derived from env.runtimeSeed (PURE - no global state)
determinism enforced: getOrDeriveKey throws if env.runtimeSeed missing
```

## entity consensus config

```typescript
ConsensusConfig {
  mode: 'proposer-based' | 'gossip-based'
  validators: string[]         // ordered list, validators[0] = proposer
  threshold: bigint             // minimum voting power for quorum
  shares: Record<string, bigint>  // signerId -> voting power
}
```

proposer is static: `validators[0]`. accepted design - no rotation.

## BFT properties

### liveness
- requires proposer online (static proposer design)
- if proposer offline, no new frames proposed
- accepted limitation (not pursuing rotation)

### safety
- validators independently verify frame hash before signing
- hash mismatch -> reject proposal (equivocation detection)
- double-sign detection: `detectByzantineFault()` checks for conflicting signatures
- locked frame: validator locks to first proposal (CometBFT style), rejects conflicting ones
- commit verification: all signatures verified before applying committed frame

### catch-up (offline validator)
- validator missed frames -> `canVerify = false`
- skips verification, waits for commit notification
- commit transfers full proposer state (including account state)
- up-to-date validators provide quorum

### byzantine tolerance
- threshold-based: need `>= threshold` voting power from honest validators
- behind validators don't sign -> don't count toward quorum
- prevents corrupted state from propagating

## signature format

```
off-chain (account-crypto.ts):
  secp256k1.signSync(hash, privateKey) -> r[32] + s[32] + recovery[1]
  recovery = 0 or 1 (not 27/28)
  hex: 0x{r}{s}{recovery_hex}

hanko packing (hanko.ts):
  packRealSignatures: r[32]+s[32] concatenated, v bits packed 8/byte
  v MUST be 27 or 28 (normalized before packing)

on-chain (EP.sol):
  ecrecover(hash, v, r, s) where v = 27 or 28
  raw hash, NO ethereum signed message prefix
```

**v normalization chain:**
1. `signDigest` returns recovery byte (0 or 1)
2. `buildQuorumHanko` normalizes: `v < 27 ? v + 27 : v`
3. `packRealSignatures` validates: v must be 27 or 28
4. `_unpackSignatures` (solidity): bit 0 -> 27, bit 1 -> 28
5. `_recoverSigner` (solidity): `if (v < 27) v += 27`

## audit findings

### CORRECT

1. **no double-hash**: `signDigest` signs raw keccak256 output. `_recoverSigner` uses raw `ecrecover(hash, v, r, s)`. no ethereum signed message prefix on either side. match confirmed.

2. **deterministic frame hashing**: proposer uses `deterministicState` (before account proposals). validators use `verifyOnly=true` which returns before proposals. both produce identical state -> identical hash.

3. **signature ordering**: `hashesToSign[0]` is always entityFrame hash. commit verification checks `sigs[0]` against frame hash. additional hashes sorted by value for determinism.

4. **quorum power calculation**: `calculateQuorumPower` sums `config.shares[signerId]` for all signers. throws on unknown validator (prevents ghost votes).

5. **flashloan governance**: on-chain assumes referenced entities = YES. off-chain `recoverHankoEntities` mirrors this. both require >= 1 EOA signature.

6. **board verification mandatory**: `verifyHankoForHash` rejects if board cannot be verified (no fallback to trust). production-safe.

7. **behind-validator safety**: behind validators skip verification and don't sign. they can't corrupt quorum. up-to-date validators provide honest threshold.

8. **immutability**: `applyEntityInput` clones replica at start. `applyEntityFrame` clones entity state. no mutation leaks.

### KNOWN LIMITATIONS (accepted design)

1. **static proposer**: `validators[0]` is proposer. if offline, entity stops making progress. no rotation protocol. user confirmed: accepted design.

2. **single-signer fast path**: entities with 1 validator and threshold=1 skip consensus entirely (direct apply). no hash chain linkage in this mode beyond `prevFrameHash`.

3. **j-batch quorum**: j-batch signing (`broadcastBatch` in j-batch.ts) uses `signHashesAsSingleEntity` directly. for multi-signer entities, batch hash should go through entity consensus quorum. requires deferring on-chain submission to post-commit. separate refactor.

### FIXED ISSUES (this session)

1. **~~signature count mismatch~~**: FIXED. `buildQuorumHanko` now validates signerId is in `config.validators` BEFORE pushing to sigBuffers. unknown validators are skipped entirely.

2. **~~precommit signature verification gap~~**: FIXED. proposer now verifies `sigs[0]` (frame hash signature) via `verifyAccountSignature` before accepting precommit. byzantine validator with garbage signatures rejected immediately.

3. **~~dispute hanko single-signer only~~**: FIXED. commit phase now attaches quorum hanko to `accountInput.newDisputeHanko` via exact `newDisputeHash` lookup in hankoWitness.

4. **~~settlement hanko single-signer only~~**: FIXED. `handleSettleApprove` now returns `hashesToSign` with settlement hash. quorum hanko replaces single-signer hanko at commit via hankoWitness.

5. **~~stale createRealSignature~~**: FIXED. deleted from hanko.ts (used `wallet.signMessage` with ethereum prefix — wrong for raw hash signing).

6. **~~N-of-N on-chain requirement~~**: FIXED. EP.sol `_buildBoardHash` now uses `claim.entityIndexes` to reconstruct full HIERARCHICAL board from:
   - placeholders (board members who didn't authorize - EOA or entity)
   - recovered EOA signers (addresses converted to bytes32)
   - nested entity claims (entityId from HankoClaim)

   `buildQuorumHanko` in TypeScript populates `placeholders[]` with non-signing board members as bytes32. This enables true M-of-N AND hierarchical governance (Corp A → Corp B → Corp C chains).

### REMAINING MONITORS

1. **gossip-based mode precommit broadcast**: in gossip mode, precommits go to ALL validators. two validators reaching threshold simultaneously produce different hankos for same frame. safe (same state transition) but hanko witness diverges.

   **impact**: low.

2. **safeStringify in frame hash**: `createEntityFrameHash` uses `safeStringify` (handles BigInt). if `safeStringify` changes format, all frame hash chains break.

   **impact**: high if changed. currently stable. should be frozen/pinned.

## entity types

### lazy entity (0 gas)
```
entityId = keccak256(abi.encode(Board))
no on-chain registration needed
board changes = new entityId (different hash)
```

### registered entity (~50k gas)
```
entityId = sequential (1, 2, 3...)
stored currentBoardHash in EP.sol
board transitions via updateBoard() with time delays
BCD separation: Board, Control, Dividend governance layers
```

## cost model

```
traditional multisig: ~400k gas per org ($12+)
hanko lazy entity: 0 gas
hanko registered entity: ~50k gas ($1.50)
hanko verification: ~50-100k gas (ecrecover + board hash)
```

## signature packing math

```
count signatures -> packed bytes
1 sig:   64 + 1 = 65 bytes
2 sigs:  128 + 1 = 129 bytes
8 sigs:  512 + 1 = 513 bytes
9 sigs:  576 + 2 = 578 bytes
100 sigs: 6400 + 13 = 6413 bytes (vs 6500 naive = 1.4% savings)
```

## integration points

### account frame proposal -> hanko
```
entity-consensus.ts:1270
proposeAccountFrame(env, accountMachine, false, lastFinalizedJHeight)
  -> returns hashesToSign: [{ hash: stateHash, type: 'accountFrame', context }]
  -> collected during applyEntityFrame
  -> included in entity proposal hashesToSign
  -> validators sign all hashes
  -> buildQuorumHanko at commit
  -> attached to accountInput.newHanko
  -> sent to counterparty entity
```

### dispute -> hanko
```
dispute hashes collected same way as accountFrame hashes
included in hashesToSign array
signed by all validators
quorum hanko built at commit
attached to dispute output for on-chain submission
```

### settlement -> hanko
```
settlement proof requires entity authorization
hanko proves entity's board approved the settlement
on-chain Depository.sol calls EP.verifyHankoSignature
```
