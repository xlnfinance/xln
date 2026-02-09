# XLN Cryptographic Primitives and Security Model

## 1. Notation and Conventions

| Symbol | Meaning |
|--------|---------|
| `H_k(m)` | Keccak-256 hash of message `m` |
| `H_s(m)` | SHA-256 hash of message `m` |
| `H_b(m)` | BLAKE3 hash of message `m` |
| `Sign_sk(h)` | secp256k1 ECDSA signature of 32-byte hash `h` under private key `sk` |
| `Recover(h, sig)` | ECDSA public key recovery from hash and signature |
| `addr(pk)` | Ethereum address: last 20 bytes of `H_k(pk_uncompressed[1:])` |
| `ABI(...)` | Solidity ABI encoding (`abi.encode(...)`) |
| `||` | Concatenation |

All hashes produce 32-byte outputs. Entity IDs are 32-byte values. Addresses are 20 bytes, left-padded to 32 bytes in Hanko structures.

## 2. Elliptic Curve and Signature Scheme

**Curve:** secp256k1 (NIST standard, identical to Ethereum)

**Signing:** Raw hash signing (NO `\x19Ethereum Signed Message` prefix). Given a 32-byte digest `h` and private key `sk`:

```
sig = ECDSA_Sign(sk, h)  -->  (r: 32B, s: 32B, v: 1B)
```

where `v in {27, 28}` is the recovery parameter. This matches Solidity `ecrecover(h, v, r, s)` directly.

**Libraries:**
- Off-chain signing: `@noble/secp256k1` (synchronous `signSync` with `recovered: true, der: false`)
- On-chain signing: `ethers.SigningKey.sign(h)` for Hanko construction
- On-chain recovery: Solidity `ecrecover` in `EntityProvider._recoverSigner`

**Domain separation:** XLN does NOT use EIP-191 or EIP-712 message prefixes. Signatures are over raw `keccak256` digests. This is intentional for gas efficiency and direct `ecrecover` compatibility.

## 3. Hash Functions by Layer

| Context | Hash | Rationale |
|---------|------|-----------|
| Account frame `stateHash` | `keccak256` | EVM `ecrecover` compatibility |
| Entity frame hash | `keccak256` | EVM `ecrecover` compatibility |
| Dispute proof hash | `keccak256(ABI(...))` | On-chain verification in Account.sol |
| Settlement hash | `keccak256(ABI(...))` | On-chain verification in Account.sol |
| ProofBody hash | `keccak256(ABI_encode(ProofBody))` | Direct on-chain comparison |
| HTLC routing sub-hashes | `keccak256` | Merkle-like compression of Maps |
| HTLC hashlock | SHA-256 (preimage reveal) | Standard lightning-style HTLC |
| BrainVault shard salt | BLAKE3 | Speed for iterated KDF |
| BrainVault shard KDF | Argon2id (256 MB) | Memory-hard brute-force resistance |
| BrainVault final combine | BLAKE3 | Domain-separated finalization |
| BrainVault mnemonic checksum | SHA-256 | BIP-39 standard |
| Key derivation (named signers) | HMAC-SHA256 | Deterministic, non-invertible |
| Browser demo hash | DJB2-variant | Non-cryptographic, dev only |

## 4. Key Derivation

### 4.1 BrainVault Master Seed

BrainVault derives a master key from memorable inputs `(name, passphrase, factor)`:

1. **Shard count:** `N = 10^(factor - 1)`, where `factor in [1..9]`
2. **Per-shard salt:** `salt_i = BLAKE3(NFKD(name) || ALG_ID || uint32_BE(N) || uint32_BE(i))`
   where `ALG_ID = "brainvault/argon2id-sharded/v1.0"`
3. **Per-shard KDF:** `shard_i = Argon2id(NFKD(passphrase), salt_i, mem=256MB, t=1, p=1, out=32B)`
4. **Combine:** `master = BLAKE3(shard_0 || shard_1 || ... || shard_{N-1} || domain_tag)`
   where `domain_tag` encodes all KDF parameters for domain separation
5. **Sub-keys:** `key_ctx = BLAKE3(master || context_string, dkLen=len)`

The master key yields a BIP-39 mnemonic (256-bit entropy -> 24 words) with SHA-256 checksum per BIP-39 spec.

### 4.2 Signer Key Derivation

From the runtime seed (BrainVault mnemonic or arbitrary string):

- **Numeric signer IDs** (e.g., `"1"`, `"42"`): BIP-39 + BIP-44 HD derivation.
  `seed -> mnemonic -> HDNodeWallet.fromPhrase(mnemonic, path=getIndexedAccountPath(index))`
  Path follows MetaMask convention: `m/44'/60'/0'/0/{index}` where `index = parseInt(signerId) - 1`.

- **Named signer IDs** (non-numeric strings): `sk = HMAC-SHA256(master_seed, signerId_bytes)`

- **Address derivation:** `addr(sk) = H_k(secp256k1_pubkey_uncompressed(sk)[1:])[12:]` (standard Ethereum)

### 4.3 Seed Determinism Invariant

All signing operations require `env.runtimeSeed`. Functions throw `CRYPTO_DETERMINISM_VIOLATION` if seed is absent. This ensures the pure function property: identical seeds produce identical key material across all nodes.

## 5. Hanko Quorum Signature Format

A **Hanko** is an M-of-N multi-party authorization proof. It is ABI-encoded for on-chain verification.

### 5.1 Wire Format

```
HankoBytes := ABI.encode(tuple(bytes32[], bytes, tuple(bytes32, uint256[], uint256[], uint256)[]))
```

Decoded structure:

| Field | Type | Description |
|-------|------|-------------|
| `placeholders` | `bytes32[]` | Addresses of non-signing board members (left-padded to 32B) |
| `packedSignatures` | `bytes` | Compact-packed EOA signatures |
| `claims` | `HankoClaim[]` | Entity quorum claims |

Each `HankoClaim`:

| Field | Type | Description |
|-------|------|-------------|
| `entityId` | `bytes32` | Entity making the claim |
| `entityIndexes` | `uint256[]` | Indices into unified array: `[placeholders... | signers... | claims...]` |
| `weights` | `uint256[]` | Voting weight per member (parallel to entityIndexes) |
| `threshold` | `uint256` | Minimum weighted sum for quorum |

### 5.2 Signature Packing

Signatures are packed for gas efficiency:

```
packed = RS_values || V_bits
RS_values = r_0[32] || s_0[32] || r_1[32] || s_1[32] || ...   (64 bytes per sig)
V_bits    = ceil(n/8) bytes, bit i = (v_i == 28 ? 1 : 0)
```

Total size for `n` signatures: `64n + ceil(n/8)` bytes.

### 5.3 Flashloan Governance Verification

Verification uses optimistic "assume YES" semantics (mirrors Solidity):

1. Unpack and recover EOA addresses from `packedSignatures` via `ecrecover(hash, sig)`
2. Map recovered addresses to `yesEntities` (as bytes32, left-padded)
3. For each `claim[i]`:
   - Sum weights where `entityIndexes[j]` points to a placeholder (weight=0), a recovered signer (counted), or another claim (optimistically assumed YES)
   - Self-references (`claim[i]` referencing itself) are excluded
   - If `sum >= threshold`, add `claim[i].entityId` to `yesEntities`
4. XLN layer enforces: `eoaSignatures.length >= 1` (prevents pure circular validation)

**On-chain (EntityProvider.sol):** Board verification reconstructs the quorum from `ecrecover` results. For registered entities, `boardHash` is stored on-chain. For lazy entities, `entityId == boardHash` (self-describing).

### 5.4 Board Hash

```
boardHash = keccak256(ABI.encode(Board))
Board = { entityIds: bytes32[], votingPowers: uint16[], votingThreshold: uint16 }
```

For lazy entities: `entityId = uint256(boardHash)`, so the entity ID cryptographically commits to its governance structure.

## 6. Bilateral Frame Signing (A-Layer)

### 6.1 Account Frame Hash

```
frameHash = keccak256(UTF8(deterministicJSON({
    height, timestamp, jHeight, prevFrameHash,
    accountTxs: [{type, data}, ...],
    tokenIds: [...],
    deltas: [...],              // BigInt as string
    fullDeltaStates: [{         // All delta fields as strings
        tokenId, collateral, ondelta, offdelta,
        leftCreditLimit, rightCreditLimit,
        leftAllowance, rightAllowance,
        leftHtlcHold, rightHtlcHold,
        leftSwapHold, rightSwapHold,
        leftSettleHold, rightSettleHold
    }, ...]
})))
```

Frame chain linkage: `prevFrameHash = currentFrame.stateHash` (not hash-of-hash).

### 6.2 Bilateral Signing Protocol

1. Proposer computes `frameHash`, signs with `signAccountFrame(env, signerId, frameHash)` using `@noble/secp256k1.signSync`
2. Proposer builds Hanko via `signEntityHashes` and sends `{newAccountFrame, newHanko}` to counterparty
3. Counterparty verifies: recomputes `frameHash` from frame data, verifies Hanko via `verifyHankoForHash`
4. Counterparty sends ACK with `{prevHanko}` (their Hanko on the same frame)
5. Both store `currentFrameHanko` and `counterpartyFrameHanko`

### 6.3 Signature Verification

`verifyAccountSignature` uses `@noble/secp256k1.verify(compactSig[64B], messageBytes, publicKey)` against the raw frame hash (no prefix).

## 7. Entity Frame Signing (E-Layer BFT)

### 7.1 Entity Frame Hash

```
entityFrameHash = keccak256(UTF8(safeStringify({
    prevFrameHash, height, timestamp,
    txs: [{type, data}, ...],
    entityId,
    reserves: [[tokenId, amount_string], ...],  // sorted by tokenId
    lastFinalizedJHeight,
    accountHashes: [{cpId, height, stateHash}, ...],  // sorted by cpId
    htlcRoutesHash: keccak256(...) | null,
    htlcFeesEarned: string,
    lockBookHash: keccak256(...) | null,
    swapBookHash: keccak256(...) | null,
    orderbookHash: keccak256(...) | null
})))
```

Sub-hashes for large Maps use `keccak256(UTF8(safeStringify(sortedEntries)))`.

### 7.2 BFT Precommit Flow

1. **PROPOSE:** Proposer applies txs, computes `entityFrameHash`, collects `hashesToSign` (entity frame hash + account-level hashes)
2. **PRECOMMIT:** Each validator independently re-applies txs from genesis-consistent state, computes own hash, signs only if hash matches. Sends `hashPrecommits: Map<signerId, signature[]>` (one sig per hash in `hashesToSign`)
3. **COMMIT:** Once `sum(shares[signerId]) >= threshold` for all hashes, proposer builds quorum Hanko via `buildQuorumHanko`. Validators use their own computed state (not proposer's `newState`).

**Security invariant:** Validators NEVER trust proposer-supplied state. They recompute independently and only sign if hashes match.

## 8. Dispute Proof Construction

### 8.1 ProofBody

```
ProofBody := ABI.encode({
    offdeltas: int256[],              // sorted by tokenId ascending
    tokenIds: uint256[],
    transformers: TransformerClause[]
})

TransformerClause := {
    transformerAddress: address,
    encodedBatch: bytes,              // ABI.encode(Batch)
    allowances: Allowance[]
}

Batch := {
    payment: Payment[],               // HTLC locks, sorted by lockId
    swap: Swap[]                      // Swap offers, sorted by offerId
}
```

`proofBodyHash = keccak256(ABI.encode(ProofBody))`

### 8.2 Dispute Message

```
disputeHash = keccak256(ABI.encode(
    MessageType.DisputeProof,         // uint256 = 1
    depositoryAddress,                // address (replay protection)
    channelKey,                       // solidityPacked(leftEntity, rightEntity)
    cooperativeNonce,                 // uint256
    disputeNonce,                     // uint256
    proofBodyHash                     // bytes32
))
```

### 8.3 Settlement Message

```
settlementHash = keccak256(ABI.encode(
    MessageType.CooperativeUpdate,    // uint256 = 0
    depositoryAddress,                // address
    channelKey,                       // bytes
    onChainCooperativeNonce,          // uint256
    diffs[],                          // tuple(uint256,int256,int256,int256,int256)[]
    forgiveDebtsInTokenIds[],         // uint256[]
    insuranceRegs[]                   // tuple(bytes32,bytes32,uint256,uint256,uint256)[]
))
```

## 9. Replay Protection

| Mechanism | Scope | How |
|-----------|-------|-----|
| Frame chain | A-layer, E-layer | `prevFrameHash` links each frame to its predecessor |
| `cooperativeNonce` | On-chain settlement | Monotonic counter in Account.sol, incremented per settlement |
| `disputeNonce` | On-chain disputes | Separate counter for dispute proof versioning |
| `depositoryAddress` | Cross-chain | Domain separator binding proof to specific chain + depository |
| `channelKey` | Cross-account | `solidityPacked(leftEntity, rightEntity)` uniquely identifies account |
| Frame height | Ordering | Monotonically increasing, prevents out-of-order frame acceptance |

## 10. Deterministic Serialization

XLN uses `safeStringify` for hash inputs:
- `BigInt` values serialize as `"BigInt(N)"` strings
- `Map` objects convert to plain objects via `Object.fromEntries`
- `Set` objects convert to arrays
- `Buffer` objects serialize as `"Buffer(N bytes)"`
- Functions serialize as `"[Function: name]"`

For ABI encoding (on-chain proofs), standard Solidity ABI encoding is used via `ethers.AbiCoder`.

## 11. Security Model

### 11.1 Adversary Assumptions

- **A-layer (bilateral):** Assumes at most one of two parties is Byzantine. Safety requires 2-of-2 signatures. Liveness depends on counterparty responsiveness (timeout to dispute).
- **E-layer (BFT):** Tolerates `f < threshold` Byzantine validators. Safety requires quorum agreement. Liveness requires `>= threshold` honest validators online.
- **J-layer (on-chain):** Inherits EVM security model. Smart contracts are immutable trust anchors.

### 11.2 Trust Boundaries

| Boundary | Verified | Assumed |
|----------|----------|---------|
| Proposer state | Rejected (validators recompute) | Transaction ordering within frame |
| EOA signatures | `ecrecover` on raw hash | secp256k1 hardness |
| Hanko quorum | Weight sum >= threshold | Board membership is current |
| Frame chain | `prevFrameHash` linkage | No hash collisions (keccak256) |
| On-chain settlement | Contract logic + nonce checks | EVM execution correctness |
| HTLC preimage | `H_s(secret) == hashlock` | SHA-256 preimage resistance |
| Key derivation | Deterministic from seed | Seed secrecy (BrainVault entropy) |

### 11.3 Explicit Non-Guarantees

1. **Circular Hanko claims** are intentionally permitted at the protocol level. The XLN application layer enforces `>= 1 EOA signature` to prevent pure circular validation.
2. **Browser demo** uses a non-cryptographic hash (DJB2-variant) for `createHash` in browser mode. This is development-only; production uses Node.js `crypto.createHash('sha256')`.
3. **Named signer derivation** (`HMAC-SHA256(seed, name)`) provides 256-bit security but depends entirely on seed entropy. BrainVault's Argon2id sharding provides the memory-hard protection layer.

### 11.4 State Injection Defense

Validators never accept a proposer's `newState` directly. The protocol enforces:
1. Proposer broadcasts `(height, timestamp, txs, hash)`
2. Validator applies `txs` to its own state copy
3. Validator computes hash from its own resulting state
4. Validator signs only if `validator_hash == proposer_hash`
5. At commit time, validator uses `validatorComputedState`, not `proposer.newState`

This prevents a Byzantine proposer from injecting inflated reserves, fabricated balances, or corrupted account state.
