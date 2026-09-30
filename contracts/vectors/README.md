# Encoding vectors

Every value here was produced by the fork's deployed bytecode in BrowserVM (og's `createJAdapter` with the fork's
factories, see `../test/vm/rig.ts`). Two independent specs pin to these files. Regenerate with
`bun contracts/scripts/write-vectors.ts`; `bun test contracts/test/vm/vectors/vectors.test.ts` fails if the committed files drift
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

`baseline.json` pins the baseline rule: a settlement's Lock frame carries a co-signed proof for epoch + 1 (offdelta 0, no clauses, a nonce above the chain's), signed before the settlement executes. `afterSettlement`: the baseline for epoch 1 (nonce 6) is signed at epoch 0, the settlement runs (epoch 1, stored nonce 5), and a dispute started with the baseline is accepted. `afterTimeoutFinalize`: the same after a timeout finalize (epoch 1, stored nonce 8); the baseline at nonce 9 starts a dispute, one at the stored nonce 8 reverts `E2()`. `foldedOffdelta`: an Account with offdelta -30 pays Left 970 / Right 1030 / collateral 0 whether the -30 is disputed as offdelta or folded into `ondeltaDiff` by a settlement and the offdelta-0 baseline is disputed.
The next-epoch baseline is co-signed with every frame, so its nonce is fixed relative to the frame F it rides on (`baselineOffsets`, F = 7). After a settlement at nonce F the chain's nonce is F and F+1, F+2, F+3 all start a dispute. After a timeout finalize the counterparty may have started with the proposer-signed proof of the in-flight frame F+1, which leaves the chain's nonce at F+2: a baseline at F+2 (offset +2) reverts `E2()`, so the proposer would hold no valid proof, and F+3 (offset +3) is accepted. The baseline must therefore carry frame nonce + 3.

## `batch.json`

The whole Batch ABI, from the deployed bytecode. `abi.encode(Batch)` is the `encodedBatch` every `processBatch` takes; the fields in order are `layout.fields`:
`gasBudget, reserveToReserve, reserveToCollateral, collateralToReserve, settlements, disputeStarts, counterDisputes, disputeFinalizations, externalTokenToReserve, reserveToExternalToken, revealSecrets, hashLadderRegistrations`
(`gasBudget` is a uint64, the rest are arrays of the structs in `Types.sol`; the bounds are in `DepositoryBounds`: at least 500,000 gas, at most 50 ops in all, one dispute finalization).

- `layout.cases[]`: `{ label, encodedBatch, accepted, rejectedWith? }`. The deployed `DepositoryBounds.assertBatch` (a library; its selector is over the source signature `assertBatch(Batch)`, 0xab551cf9, not the expanded tuple) decodes each `encodedBatch` from calldata, the same ABI decode `processBatch` does. One case per array with only that array populated, plus every array at once in `mixed` values (every slot its own value, negative for signed types, so a swap of two slots or two fields changes the bytes), `small` and `wide` (every slot at its type's limit), the minimum budget, and two rejections (`E10`: budget 499,999; 1,000 ops).
- `ops`: the ops the lifecycle does not run, through the real Depository, each with `encodedBatch`, `entityNonce`, `batchHash`, `events` and the resulting `state`: `reserveToReserve`, `reserveToCollateral` (two pairs, one to a third entity), `collateralToReserve` (with the counterparty's cooperative-update hash and the diffs the shortcut expands to), `revealSecrets` (the hashlock is `keccak256(secret)`), `counterDispute` (Right starts at nonce 7 with Left's proof, Left locks Right's nonce-9 proof; the stored nonce stays 7), and `composite`: a reserve-to-reserve of 950 by an entity holding 900, repaid inside the batch by a collateral-to-reserve of 100 (the implicit flash; the batch lands, reserves Left 50 / Right 1950, collateral 0).

## `hanko.json`

Hanko with several signers and nested boards, verified by the deployed `EntityProvider.verifyHankoSignature`. `cases[]`: `{ label, hash, hanko, placeholders, signers, claimEntityIds, provedEntityId, result }`, `result` = `{ entityId, success }` or `{ revertedWith }`. The envelope is `abi.encode(HankoBytes)`:

- **Members are numbered** placeholders first, then the recovered signers in `packedSignatures` order, then the claims in order. A claim lists its members' positions and weights; a member that is itself a claim has a position after all placeholders and signers, and must come from an earlier claim. **The first member of a claim must be an address (a placeholder or a signer), never another claim** (`InvalidHankoFirstMember`).
- **packedSignatures** = `r||s` for each signature in turn, then the recovery bits, one per signature, packed little-endian in `ceil(n/8)` bytes (bit set = v 28), no padding bits set. A placeholder is a board member that did not sign; it counts nothing.
- **A lazy entity's id** is `keccak256(abi.encode(Board{threshold, memberIds in the claim's order, weights, 0, 0, 0}))`, where a signer's or placeholder's member id is its address left-padded to 32 bytes and a nested claim's is that claim's entity id. The last claim is the entity proved. Every claim must be referenced by a later one (`UnusedHankoClaim`), claims are listed after the ones they name (`InvalidHankoClaimOrder`), a signer is never also a placeholder (`NonCanonicalHankoPlaceholder`), a signature appears once (`DuplicateHankoSigner`), and the packed block length must match (`InvalidHankoPackedSignatureLength`).
- Cases: 2-of-3 with one member a placeholder, 3-of-3, the threshold not met, a weighted 3/1/1 board met by the heavy member alone and missed by the two light ones, nested two and three levels deep, two nested boards side by side, a nested board whose inner threshold is not met, and the six rejections above.
- `depository`: the three-level entity acts. A batch (a reserve-to-reserve of 77) signed by that nested board is accepted by `processBatch` (reserves entity 423 / target 77 after a funding of 500), and the same Hanko built over another hash is `E4`.

## Not covered

- `FinalDisputeProof` and `CooperativeDisputeProof` payloads exist in the library but nothing verifies them
  (`FinalDisputeProof.cooperative` always reverts). They are in `functions.json` from the codec only; specs should not use them.
- `counterProofCommitment` and `proofBodyHash` come from the codec, which repeats the expression; production's private
  copies are exercised by the lifecycle (start accepts the body hash) but a counter-dispute run is not recorded yet.
- Event coverage is what the lifecycle emits; debt, HTLC/swap/pull settlement and watchtower events have no recorded run yet.
- Not run against the real Depository: external token in and out (an ERC-20 has to be deployed and listed first) and hash-ladder registration (it needs a Pull dispute). Their layout is pinned in `batch.json#layout`; their behaviour is in the Hardhat tests (`Depository-part-2`, `HashLadderRegistry`).
- ERC-1271 member signatures (`memberSignatures`) are not in `hanko.json`; every case has an empty `memberSignatures`.

