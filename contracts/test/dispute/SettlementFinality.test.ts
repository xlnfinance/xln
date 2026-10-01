import { expect } from 'chai';
import hre from 'hardhat';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import {
  buildSingleSignerHanko,
  canonicalAccountKey,
  accountEpoch,
  computeCooperativeUpdateHash,
  computeDepositoryBatchHash,
  deriveHardhatPrivateKey,
  deployDepositoryStack,
  deployEntityProvider,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
  submitBatch,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { loadFixture } = networkHelpers;
const SETTLEMENT_DIFFS_ABI =
  'tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[]';

type Actor = Readonly<{
  signer: HardhatEthersSigner;
  entityId: string;
  privateKey: string;
}>;

const actor = (signer: HardhatEthersSigner, index: number): Actor => ({
  signer,
  entityId: singleSignerLazyEntityId(signer.address),
  privateKey: deriveHardhatPrivateKey(index),
});

const orderedActors = (first: Actor, second: Actor): [Actor, Actor] =>
  BigInt(first.entityId) < BigInt(second.entityId) ? [first, second] : [second, first];

const deployFixture = async () => {
  const [signer0, signer1] = await ethers.getSigners();
  const entityProvider = await deployEntityProvider(signer0.address);
  const { depository } = await deployDepositoryStack(await entityProvider.getAddress());
  return { depository, signer0, signer1 };
};

describe('settlement finality events', function () {
  it('emits AccountSettled for a successful pure-forgiveness settlement', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(actor(signer0, 0), actor(signer1, 1));
    const settlementNonce = 1n;
    const forgiveTokenIds = [1n];
    const accountKey = canonicalAccountKey(left.entityId, right.entityId);
    const settlementHash = await computeCooperativeUpdateHash(
      depository,
      accountKey,
      await accountEpoch(depository, left.entityId, right.entityId),
      settlementNonce,
      [],
      forgiveTokenIds,
      SETTLEMENT_DIFFS_ABI,
    );
    const settlementHanko = buildSingleSignerHanko(right.entityId, settlementHash, right.privateKey);
    const batch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs: [],
        forgiveDebtsInTokenIds: forgiveTokenIds,
        sig: settlementHanko,
        nonce: settlementNonce,
      }],
    });
    const encodedBatch = encodeBatch(batch);
    const batchNonce = 1n;
    const batchHash = await computeDepositoryBatchHash(depository, left.entityId, encodedBatch, batchNonce);
    const batchHanko = buildSingleSignerHanko(left.entityId, batchHash, left.privateKey);

    await expect(
      submitBatch(depository, left.signer, left.entityId, { encodedBatch, hankoData: batchHanko, nonce: batchNonce }),
    ).to.emit(depository, 'AccountSettled');

    expect((await depository._accounts(accountKey)).nonce).to.equal(settlementNonce);
  });
});
