import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import type { Depository } from '../typechain-types/index.js';
import {
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const { ethers } = hre;
const abi = ethers.AbiCoder.defaultAbiCoder();
const COOPERATIVE_UPDATE = 0;
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
  const entityProviderFactory = await ethers.getContractFactory('EntityProvider');
  const entityProvider = await entityProviderFactory.deploy(signer0.address);
  await entityProvider.waitForDeployment();
  const accountFactory = await ethers.getContractFactory('Account');
  const account = await accountFactory.deploy();
  await account.waitForDeployment();
  const depositoryFactory = await ethers.getContractFactory('Depository', {
    libraries: { Account: await account.getAddress() },
  });
  const depository = await depositoryFactory.deploy(await entityProvider.getAddress()) as Depository;
  await depository.waitForDeployment();
  return { depository, signer0, signer1 };
};

const cooperativeUpdateHash = async (
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  forgiveTokenIds: bigint[],
): Promise<string> => {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(abi.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', SETTLEMENT_DIFFS_ABI, 'uint256[]'],
    [COOPERATIVE_UPDATE, chainId, await depository.getAddress(), accountKey, nonce, [], forgiveTokenIds],
  ));
};

describe('settlement finality events', function () {
  it('emits AccountSettled for a successful pure-forgiveness settlement', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(actor(signer0, 0), actor(signer1, 1));
    const settlementNonce = 1n;
    const forgiveTokenIds = [1n];
    const accountKey = await depository.accountKey(left.entityId, right.entityId);
    const settlementHash = await cooperativeUpdateHash(
      depository,
      accountKey,
      settlementNonce,
      forgiveTokenIds,
    );
    const settlementHanko = buildSingleSignerHanko(right.entityId, settlementHash, right.privateKey);
    const batch = emptyBatch({
      settlements: [{
        leftEntity: left.entityId,
        rightEntity: right.entityId,
        diffs: [],
        forgiveDebtsInTokenIds: forgiveTokenIds,
        sig: settlementHanko,
        entityProvider: ethers.ZeroAddress,
        hankoData: '0x',
        nonce: settlementNonce,
      }],
    });
    const encodedBatch = encodeBatch(batch);
    const batchNonce = 1n;
    const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, batchNonce);
    const batchHanko = buildSingleSignerHanko(left.entityId, batchHash, left.privateKey);

    await expect(
      depository.connect(left.signer).processBatch(encodedBatch, batchHanko, batchNonce),
    ).to.emit(depository, 'AccountSettled');

    expect((await depository._accounts(accountKey)).nonce).to.equal(settlementNonce);
  });
});
