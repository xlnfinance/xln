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
    await expect(transformer.revealSecret(secret))
      .to.emit(transformer, 'SecretRevealed')
      .withArgs(hash, secret);
    const firstTimestamp = await transformer.hashToTimestamp(hash);
    expect(firstTimestamp).to.be.gt(0n);

    await expect(transformer.revealSecret(secret))
      .not.to.emit(transformer, 'SecretRevealed');
    expect(await transformer.hashToTimestamp(hash)).to.equal(firstTimestamp);
  });
});
