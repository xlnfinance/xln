# Dispute-proof replay after finalization

Found by audit on 2026-11-14 at `da08764cc`, reproduced on Mac Studio. Fixed in `4a10c6973` with
option 2 below, the owner's choice of 2026-11-19, using 40 epoch bits instead of 32 and saturating
at the safe bound instead of reverting. The text below describes the contract before the fix.

## What happens

`Depository._applyAccountDelta` ends a dispute by setting `collateral = 0` and deleting `ondelta`.
`_disputeFinalizeInternal` then only advances the stored nonce (to the adopted signed nonce, or by
one on a timeout). `Account._disputeStart` accepts any counterparty-signed proof whose nonce is
greater than the stored one, and the signed payload (`HankoEncoding.encodeDisputeProof`: chain,
Depository, account key, nonce, proposer side, proof body hash, watch seed) binds nothing that
changes at finalization.

A proof signed before the dispute with a higher nonce is therefore still valid afterwards. Its
`offdelta` was agreed relative to the old `ondelta` and collateral, but it is now settled against an
emptied account, so the whole `offdelta` is taken from the debtor's reserve and the remainder is
booked as debt.

## Reproduced numbers

Left funds 300 of collateral. Right signs "owes 100" at nonce 1 and "owes 150" at nonce 3, so the
most Right ever agreed to owe is 150.

| Step | Left reserve | Right reserve |
|---|---|---|
| Start | 0 (300 in collateral) | 1000 |
| Dispute with nonce 1, timeout | 400 | 900 |
| Second dispute with nonce 3, timeout | 550 | 750 |

Right pays 250 instead of 150. The test asserts Right keeps at least 850 and fails with
`expected 750 to be at least 850`.

## Who can use it

- A hub against a user, without the user being offline: the user proposes frame n+1 (the proposal
  carries the user's dispute Hanko for n+1), the hub withholds its ACK, starts a dispute with n-1,
  lets the user counter with n, then replays n+1 against the emptied account.
- A user against a hub, the same way with hub-signed frames, when `offdelta` favours the user. The
  second settlement comes out of the hub's reserve.
- Anyone after one stale close that was not countered: every newer proof they hold is still usable.

## Fix options

1. **Dispute epoch in the signed payload.** Add a per-account `disputeEpoch` to `AccountInfo`, bump
   it at finalization and include it in `encodeDisputeProof` and its TS and Rust mirrors. Complete,
   but changes the signature format.
2. **Epoch in the high bits of the nonce.** At finalization set the stored nonce to the next multiple
   of 2^32. An honest signer never signs more than one nonce ahead, so every earlier proof falls
   below the new base. No signature change; TS and Rust resume from the on-chain nonce. Needs the
   in-epoch counter capped below 2^32 before signing.
3. **Retire the watch seed.** Store the finalized `watchSeed` per account and reject a start that
   carries it. Requires the runtime to rotate the seed after every finalization; that lifecycle was
   not audited.

Option 2 was applied.

## Counterexample

Insert before `it('rejects historical cooperative signatures as a dispute bypass'` in
`jurisdictions/test/dispute/Depository-part-2.ts` and run
`bunx hardhat test test/dispute/Depository-part-2.ts --grep "pre-dispute proof"` from `jurisdictions/`.

```ts
  // Audit 2026-11-14, counterexample: finalization zeroes collateral and ondelta but only
  // advances the stored nonce, so a proof signed before the dispute with a higher nonce
  // still opens a new dispute and settles its whole offdelta against the emptied account.
  it('a pre-dispute proof with a higher nonce cannot be settled a second time after finalization', async function () {
    const { depository } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await mintListedReserve(depository, left.entityId, tokenId, 300n);
    await mintListedReserve(depository, right.entityId, tokenId, 1_000n);
    const fundBatch = emptyBatch({
      reserveToCollateral: [{ tokenId, receivingEntity: left.entityId, pairs: [{ entity: right.entityId, amount: 300n }] }],
    });
    const fund = await signDepositoryBatch(depository, left.entityId, left.privateKey, fundBatch);
    await depository.connect(left.signer).processBatch(fund.encodedBatch, fund.hankoData, fund.nonce);
    const acctKey = await accountKeyFor(depository, left.entityId, right.entityId);

    // While the account was live Right signed two states: it owes Left 100 at nonce 1 and 150 at nonce 3.
    const runDispute = async (nonce: bigint, offdelta: bigint): Promise<void> => {
      const body = proofBody([offdelta], [tokenId]);
      const bodyHash = proofBodyHash(body);
      const sig = signEntityHash(right.entityId, await disputeProofHash(depository, acctKey, nonce, bodyHash), right.privateKey);
      const startBatch = emptyBatch({
        disputeStarts: [{
          counterentity: right.entityId, nonce, proofbodyHash: bodyHash, initialProofbody: body, watchSeed: TEST_WATCH_SEED, sig,
          starterInitialArguments: '0x', starterCounterArguments: '0x', starterCounterProofCommitment: ethers.ZeroHash,
        }],
      });
      const start = await signDepositoryBatch(depository, left.entityId, left.privateKey, startBatch);
      await depository.connect(left.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
      await advancePastDisputeTimeout(depository, left.entityId, right.entityId);
      const finalizeBatch = emptyBatch({
        disputeFinalizations: [{
          counterentity: right.entityId, initialNonce: nonce, finalNonce: nonce, initialProofbodyHash: bodyHash, finalProofbody: body,
          starterArguments: '0x', otherArguments: '0x', sig: '0x', startedByLeft: true, cooperative: false,
        }],
      });
      const finalize = await signDepositoryBatch(depository, left.entityId, left.privateKey, finalizeBatch);
      await depository.connect(left.signer).processBatch(finalize.encodedBatch, finalize.hankoData, finalize.nonce);
    };

    await runDispute(1n, 100n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(400n);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(900n);

    // The newest state Right ever signed says it owes 150 in total. Replaying it must not take more.
    await runDispute(3n, 150n).catch(() => undefined);
    expect(await depository._reserves(right.entityId, tokenId)).to.be.gte(850n);
  });

```

## Output at `da08764cc`

```text
  Depository
    1) a pre-dispute proof with a higher nonce cannot be settled a second time after finalization
  0 passing (133ms)
  1 failing
  1) Depository
       a pre-dispute proof with a higher nonce cannot be settled a second time after finalization:
      AssertionError: expected 750 to be at least 850.
      + expected - actual
      -750
      +850

      at Context.<anonymous> (test/dispute/Depository-part-2.ts:1123:71)
1 failing (1 mocha)
Test run failed
```
