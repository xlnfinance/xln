import { expect } from 'chai';
import hre from 'hardhat';

import { deployEntityProvider } from './helpers/hanko.ts';

const { ethers } = hre;

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
    const Transformer = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await Transformer.deploy();
    await Promise.all([
      account.waitForDeployment(),
      bounds.waitForDeployment(),
      registry.waitForDeployment(),
      transformer.waitForDeployment(),
    ]);
    const Harness = await ethers.getContractFactory('DepositoryDebtHarness', {
      libraries: {
        Account: await account.getAddress(),
        DepositoryBounds: await bounds.getAddress(),
        HashLadderRegistry: await registry.getAddress(),
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
    await expect(harness._debts(debtor, tokenId, 0n)).to.be.reverted;
  });
});
