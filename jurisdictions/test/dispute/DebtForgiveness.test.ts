import { expect } from 'chai';
import hre from 'hardhat';

import {
  buildSingleSignerHanko,
  canonicalAccountKey,
  computeDepositoryBatchHash,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers } = await hre.network.getOrCreate('hardhat');

describe('Depository current-debt forgiveness', () => {
  it('clears only the exact FIFO cursor debt in O(1)', async () => {
    const [owner] = await ethers.getSigners();
    const entityProvider = await deployEntityProvider(owner!.address);
    const Account = await ethers.getContractFactory('Account');
    const account = await Account.deploy();
    const Bounds = await ethers.getContractFactory('DepositoryBounds');
    const bounds = await Bounds.deploy();
    const Registry = await ethers.getContractFactory('HashLadderRegistry');
    const registry = await Registry.deploy();
    const NftCustody = await ethers.getContractFactory('NftCustody');
    const nftCustody = await NftCustody.deploy();
    const Transformer = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await Transformer.deploy();
    await Promise.all([
      account.waitForDeployment(),
      bounds.waitForDeployment(),
      registry.waitForDeployment(),
      nftCustody.waitForDeployment(),
      transformer.waitForDeployment(),
    ]);
    const Harness = await ethers.getContractFactory('DepositoryDebtHarness', {
      libraries: {
        Account: await account.getAddress(),
        DepositoryBounds: await bounds.getAddress(),
        HashLadderRegistry: await registry.getAddress(),
        NftCustody: await nftCustody.getAddress(),
      },
    });
    const harness = await Harness.deploy(
      await entityProvider.getAddress(),
      await transformer.getAddress(),
    );
    await harness.waitForDeployment();

    const debtor = ethers.keccak256(ethers.toUtf8Bytes('debtor'));
    const creditorA = ethers.keccak256(ethers.toUtf8Bytes('creditor-a'));
    const creditorB = ethers.keccak256(ethers.toUtf8Bytes('creditor-b'));
    const tokenId = 1n;
    await harness.harnessAddDebt(debtor, tokenId, creditorA, 5n);
    await harness.harnessAddDebt(debtor, tokenId, creditorB, 7n);
    await harness.harnessAddDebt(debtor, tokenId, creditorA, 9n);

    expect(await harness.harnessForgiveCurrent.staticCall(debtor, creditorB, tokenId))
      .to.deep.equal([true, false]);
    await expect(harness.harnessForgiveCurrent(debtor, creditorB, tokenId)).not.to.emit(harness, 'DebtForgiven');
    expect(await harness._debtIndex(debtor, tokenId)).to.equal(0n);
    expect((await harness._debts(debtor, tokenId, 0n)).amount).to.equal(5n);

    await expect(harness.harnessForgiveCurrent(debtor, creditorA, tokenId))
      .to.emit(harness, 'DebtForgiven')
      .withArgs(debtor, creditorA, tokenId, 5n, 0n);
    expect(await harness._debtIndex(debtor, tokenId)).to.equal(1n);
    expect(await harness.debtOutstanding(debtor, tokenId)).to.equal(16n);

    await expect(harness.harnessForgiveCurrent(debtor, creditorA, tokenId)).not.to.emit(harness, 'DebtForgiven');
    expect(await harness._debtIndex(debtor, tokenId)).to.equal(1n);
    expect((await harness._debts(debtor, tokenId, 2n)).amount).to.equal(9n);

    await harness.harnessForgiveCurrent(debtor, creditorB, tokenId);
    await harness.harnessForgiveCurrent(debtor, creditorA, tokenId);
    expect(await harness._debtIndex(debtor, tokenId)).to.equal(0n);
    expect(await harness.debtOutstanding(debtor, tokenId)).to.equal(0n);
    await expect(harness._debts(debtor, tokenId, 0n)).to.revert(ethers);
  });

  it('reverts the whole settlement when a third-party FIFO head blocks bilateral forgiveness', async () => {
    const [owner, peer, thirdParty] = await ethers.getSigners();
    const entityProvider = await deployEntityProvider(owner!.address);
    const Account = await ethers.getContractFactory('Account');
    const account = await Account.deploy();
    const Bounds = await ethers.getContractFactory('DepositoryBounds');
    const bounds = await Bounds.deploy();
    const Registry = await ethers.getContractFactory('HashLadderRegistry');
    const registry = await Registry.deploy();
    const NftCustody = await ethers.getContractFactory('NftCustody');
    const nftCustody = await NftCustody.deploy();
    const Transformer = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await Transformer.deploy();
    await Promise.all([
      account.waitForDeployment(),
      bounds.waitForDeployment(),
      registry.waitForDeployment(),
      nftCustody.waitForDeployment(),
      transformer.waitForDeployment(),
    ]);
    const Harness = await ethers.getContractFactory('DepositoryDebtHarness', {
      libraries: {
        Account: await account.getAddress(),
        DepositoryBounds: await bounds.getAddress(),
        HashLadderRegistry: await registry.getAddress(),
        NftCustody: await nftCustody.getAddress(),
      },
    });
    const harness = await Harness.deploy(
      await entityProvider.getAddress(),
      await transformer.getAddress(),
    );
    await harness.waitForDeployment();

    const actors = [owner!, peer!].map((signer, index) => ({
      entityId: singleSignerLazyEntityId(signer.address),
      privateKey: deriveHardhatPrivateKey(index),
    })).sort((a, b) => BigInt(a.entityId) < BigInt(b.entityId) ? -1 : 1);
    const left = actors[0]!;
    const right = actors[1]!;
    const blocker = singleSignerLazyEntityId(thirdParty!.address);
    const tokenId = 1n;
    const blockedAmount = 9n;
    await harness.harnessAddDebt(left.entityId, tokenId, blocker, blockedAmount);

    const accountKey = canonicalAccountKey(left.entityId, right.entityId);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const settlementHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'uint8', 'uint256', 'address', 'bytes', 'uint256',
        'tuple(uint256 tokenId,int256 leftDiff,int256 rightDiff,int256 collateralDiff,int256 ondeltaDiff)[]',
        'uint256[]',
      ],
      [0, chainId, await harness.getAddress(), accountKey, 1n, [], [tokenId]],
    ));
    const batch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs: [],
        forgiveDebtsInTokenIds: [tokenId],
        sig: buildSingleSignerHanko(right.entityId, settlementHash, right.privateKey),
        nonce: 1n,
      }],
    });
    const encodedBatch = encodeBatch(batch);
    const batchHash = await computeDepositoryBatchHash(harness, encodedBatch, 1n);
    const hanko = buildSingleSignerHanko(left.entityId, batchHash, left.privateKey);

    await expect(harness.processBatch(encodedBatch, hanko, 1n))
      .to.be.revertedWithCustomError(harness, 'E2');
    expect(await harness.entityNonces(left.entityId)).to.equal(0n);
    expect((await harness._accounts(accountKey)).nonce).to.equal(0n);
    expect(await harness._debtIndex(left.entityId, tokenId)).to.equal(0n);
    expect((await harness._debts(left.entityId, tokenId, 0n)).amount).to.equal(blockedAmount);
  });
});
