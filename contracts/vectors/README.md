# Encoding vectors

Every value here was produced by the fork's deployed bytecode in BrowserVM (og's `createJAdapter` with the fork's
factories, see `../test/vm/rig.ts`). Two independent specs pin to these files. Regenerate with
`bun contracts/scripts/write-vectors.ts`; `bun test contracts/test/vm/vectors.test.ts` fails if the committed files drift
from the contracts, and re-derives the three signed payloads below with plain ethers, independently of the contracts.

Numbers are decimal strings, bytes are lowercase hex, addresses are checksummed. chainId 31337. The Depository address is
`lifecycle.json#depository` (deterministic: the stack is deployed from a fixed deployer).

## `functions.json`

`vectors[]`: `{ contract, function, label, args, calldata, returnData, decoded }`, one entry per call made on the
deployed bytecode. Arguments are deterministic samples derived from the ABI: `small` (zeros, 7, -7, empty bytes) and
`wide` (all-ones uintN, minimum intN, non-empty bytes, two-element arrays), so field order, widths and sign handling are
both exercised. `HankoCodec` is the audit surface over `HankoEncoding.sol`, the library production calls; it is deployed at
`codecAddress` for the run.

The signed payloads (a hash is `keccak256` of the payload; a signature is over that hash, raw or inside a Hanko):

| payload | encoding |
|---|---|
| batch | `abi.encodePacked(domain, chainId, depository, entityId, encodedBatch, nonce)`; domain = `keccak256("XLN_DEPOSITORY_HANKO_V2")`, `entityId` bytes32 |
| dispute proof | `abi.encode(uint256 1, chainId, depository, accountKey, ondeltaEpoch, nonce, proposerIsLeft, proofBodyHash, watchSeed)` |
| cooperative update (settlement, C2R) | `abi.encode(uint256 0, chainId, depository, accountKey, ondeltaEpoch, nonce, SettlementDiff[], forgiveDebtsInTokenIds)` |
| dispute state (stored in the Account) | `Account.encodeDisputeHash(...)`, packed fields, see `lifecycle.json#disputeStart` |
| proof body hash | `keccak256(abi.encode(ProofBody))`, ProofBody = `(watchSeed, leftResponseSeconds, rightResponseSeconds, Int512[] offdeltas, tokenIds[], TransformerClause[])` |
| account key | `abi.encodePacked(min(a, b), max(a, b))` over the two bytes32 entity ids |
| finalization evidence | `keccak256(abi.encode(initialProofbodyHash, finalNonce, proposerIsLeft, startedByLeft, keccak256(starterArgs), keccak256(otherArgs), keccak256(sig)))`, emitted as `DisputeFinalized.finalizationEvidenceHash` |

Also covered by `HankoCodec`: watchtower counter-dispute authorization, entity transfer, release control shares, cancel
action, board proposal and board proposal cancel payloads, and `DeltaTransformer.encodeBatch` (the clause payload of a
proof body). `EntityProvider.verifyHankoSignature` is pinned for a raw 65-byte signature (the signer's lazy entity id =
`keccak256(abi.encode(Board{1, [signer], [1], 0, 0, 0}))`) and for a claims envelope.

## `lifecycle.json`

One account through the real Depository: deposit (R2C), cooperative settlement at epoch 0, a dispute started at epoch 1
and finalized by timeout (epoch 2). For each batch it records the encoded batch, the entity nonce, the hash we computed
and the `batchHash` the contract emitted (they are equal), and the decoded events (`name`, `args`, `logIndex`; block and
transaction ids are left out). The stored `disputeHash` equals `Account.encodeDisputeHash` of the same fields.

`reopen` is the same account after the epoch-advancing finalize (a timeout finalize of a dispute started at nonce 7 leaves the stored nonce at 8, epoch 2). Attempts to reopen at the stored nonce, at the old baseline nonce, and to settle at the stored nonce all revert `E2()`; a dispute started at nonce 9 is accepted. So the reopened baseline proof needs a nonce strictly above the chain's stored nonce, whatever the off-chain frame height is.

## Not covered

- `FinalDisputeProof` and `CooperativeDisputeProof` payloads exist in the library but nothing verifies them
  (`FinalDisputeProof.cooperative` always reverts). They are in `functions.json` from the codec only; specs should not use them.
- `counterProofCommitment` and `proofBodyHash` come from the codec, which repeats the expression; production's private
  copies are exercised by the lifecycle (start accepts the body hash) but a counter-dispute run is not recorded yet.
- Event coverage is what the lifecycle emits; debt, HTLC/swap/pull settlement and watchtower events have no recorded run yet.
