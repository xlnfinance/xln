import { expect } from 'chai';
import hre from 'hardhat';

const { ethers } = hre;

describe('DeltaTransformer secret reveal liveness', function () {
  it('treats an exact repeated reveal as an idempotent no-op', async function () {
    const factory = await ethers.getContractFactory('DeltaTransformer');
    const transformer = await factory.deploy();
    await transformer.waitForDeployment();

    const secret = ethers.encodeBytes32String('idempotent-secret');
    const hash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [secret]),
    );
    await transformer.revealSecret(secret);
    const firstBlock = await transformer.hashToBlock(hash);
    const firstTimestamp = await transformer.hashToTimestamp(hash);

    await expect(transformer.revealSecret(secret)).not.to.be.reverted;
    expect(await transformer.hashToBlock(hash)).to.equal(firstBlock);
    expect(await transformer.hashToTimestamp(hash)).to.equal(firstTimestamp);
    expect(await transformer.hashRevealed(hash)).to.equal(true);
  });
});
