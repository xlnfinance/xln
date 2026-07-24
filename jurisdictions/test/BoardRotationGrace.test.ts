import { mine, time } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  buildClaimsHanko,
  buildSingleSignerHanko,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const { ethers } = hre;

const DEFAULT_ARTICLES = {
  controlDelay: 1_000,
  dividendDelay: 3_000,
  foundationDelay: 10_000,
};

const BOARD_GRACE_SECONDS = 7 * 24 * 60 * 60;

const entityAddress = (entityNumber: bigint): string =>
  ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));

const anchoredEntityMemberBoardHash = (anchor: string, memberEntityId: string): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[1, [ethers.zeroPadValue(anchor, 32), memberEntityId], [1, 1], 0, 0, 0]],
  ));

describe('EntityProvider board rotation grace', function () {
  async function fixture() {
    const [foundation, oldSigner, newSigner, dividendHolder, outsider] = await ethers.getSigners();
    const provider = await deployEntityProvider(foundation.address);

    const oldBoardHash = singleSignerLazyEntityId(oldSigner.address);
    const newBoardHash = singleSignerLazyEntityId(newSigner.address);
    await provider.registerNumberedEntity(oldBoardHash);
    const entityNumber = 2n;
    const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
    const address = entityAddress(entityNumber);
    const [controlTokenId, dividendTokenId] = await provider.getTokenIds(entityNumber);
    const totalSupply = await provider.TOTAL_CONTROL_SUPPLY();

    await ethers.provider.send('hardhat_impersonateAccount', [address]);
    await foundation.sendTransaction({ to: address, value: ethers.parseEther('1') });
    const entitySigner = await ethers.getSigner(address);
    await provider.connect(entitySigner).safeTransferFrom(
      address,
      foundation.address,
      controlTokenId,
      (totalSupply * 60n) / 100n,
      '0x',
    );
    await provider.connect(entitySigner).safeTransferFrom(
      address,
      dividendHolder.address,
      dividendTokenId,
      1n,
      '0x',
    );
    await ethers.provider.send('hardhat_stopImpersonatingAccount', [address]);

    const proposalSignature = async (newHash: string, privateKey: string): Promise<string> => {
      const nonce = await provider.boardActionNonces(entityId) + 1n;
      const digest = await provider.computeBoardProposalHash(entityId, newHash, 1, nonce);
      return ethers.Signature.from(new ethers.SigningKey(privateKey).sign(digest)).serialized;
    };

    return {
      provider,
      foundation,
      oldSigner,
      newSigner,
      dividendHolder,
      outsider,
      entityId,
      oldBoardHash,
      newBoardHash,
      proposalSignature,
      controlTokenId,
      totalSupply,
    };
  }

  it('accepts only current and immediate previous board, with an exact seven-day boundary', async function () {
    const {
      provider,
      foundation,
      oldSigner,
      newSigner,
      entityId,
      oldBoardHash,
      newBoardHash,
      proposalSignature,
    } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(0));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 1, [support]);
    await mine(DEFAULT_ARTICLES.controlDelay);

    const activation = await provider.activateBoard(entityId);
    const receipt = await activation.wait();
    const activationBlock = await ethers.provider.getBlock(receipt!.blockNumber);
    const validUntil = BigInt(activationBlock!.timestamp + BOARD_GRACE_SECONDS);

    await expect(activation).to.emit(provider, 'BoardActivated').withArgs(
      entityId,
      oldBoardHash,
      newBoardHash,
      validUntil,
    );
    const entity = await provider.entities(entityId);
    expect(entity.currentBoardHash).to.equal(newBoardHash);
    expect(entity.previousBoardHash).to.equal(oldBoardHash);
    expect(entity.previousBoardValidUntil).to.equal(validUntil);

    const digest = ethers.keccak256(ethers.toUtf8Bytes('board-grace-regression'));
    const oldHanko = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(1));
    const newHanko = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(2));
    const anchor = ethers.zeroPadValue(foundation.address, 32);
    const parentId = anchoredEntityMemberBoardHash(foundation.address, entityId);
    const oldNestedHanko = buildClaimsHanko(digest, [deriveHardhatPrivateKey(1)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    const newNestedHanko = buildClaimsHanko(digest, [deriveHardhatPrivateKey(2)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);

    expect(await provider.verifyHankoSignature(oldHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(newHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(oldNestedHanko, digest)).to.deep.equal([parentId, true]);
    expect(await provider.verifyHankoSignature(newNestedHanko, digest)).to.deep.equal([parentId, true]);
    expect(await provider.verifyCurrentHankoSignature(oldHanko, digest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyCurrentHankoSignature(newHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyCurrentHankoSignature(oldNestedHanko, digest)).to.deep.equal([
      ethers.ZeroHash,
      false,
    ]);
    expect(await provider.verifyCurrentHankoSignature(newNestedHanko, digest)).to.deep.equal([parentId, true]);

    await time.setNextBlockTimestamp(Number(validUntil) - 1);
    await mine(1);
    expect(await provider.verifyHankoSignature(oldHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(oldNestedHanko, digest)).to.deep.equal([parentId, true]);

    await time.setNextBlockTimestamp(Number(validUntil));
    await mine(1);
    expect(await provider.verifyHankoSignature(oldHanko, digest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyHankoSignature(newHanko, digest)).to.deep.equal([entityId, true]);
    expect(await provider.verifyHankoSignature(oldNestedHanko, digest)).to.deep.equal([ethers.ZeroHash, false]);
    expect(await provider.verifyHankoSignature(newNestedHanko, digest)).to.deep.equal([parentId, true]);
  });

  it('applies current-only rotation authority to every registered claim in a recursive Hanko', async function () {
    const { provider, foundation, outsider, entityId, newBoardHash, proposalSignature } = await fixture();
    const support = await proposalSignature(newBoardHash, deriveHardhatPrivateKey(0));
    await provider.connect(foundation).proposeBoard(entityId, newBoardHash, 1, [support]);
    await mine(DEFAULT_ARTICLES.controlDelay);
    await provider.activateBoard(entityId);

    const thirdBoard = ethers.keccak256(ethers.toUtf8Bytes('third-board'));
    const nonce = await provider.boardActionNonces(entityId) + 1n;
    const digest = await provider.computeBoardProposalHash(entityId, thirdBoard, 0, nonce);
    const oldBoardHanko = buildSingleSignerHanko(entityId, digest, deriveHardhatPrivateKey(1));
    await expect(provider.proposeBoard(
      entityId,
      thirdBoard,
      0,
      [oldBoardHanko],
    )).to.be.revertedWithCustomError(provider, 'InvalidAuthorityAuthorization');

    const anchor = ethers.zeroPadValue(foundation.address, 32);
    const parentBoardHash = anchoredEntityMemberBoardHash(foundation.address, entityId);
    await provider.registerNumberedEntity(parentBoardHash);
    const parentId = ethers.zeroPadValue(ethers.toBeHex(3), 32);
    const parentNextBoard = singleSignerLazyEntityId(outsider.address);
    const parentNonce = await provider.boardActionNonces(parentId) + 1n;
    const parentDigest = await provider.computeBoardProposalHash(parentId, parentNextBoard, 0, parentNonce);
    const oldNestedHanko = buildClaimsHanko(parentDigest, [deriveHardhatPrivateKey(1)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    await expect(provider.proposeBoard(parentId, parentNextBoard, 0, [oldNestedHanko]))
      .to.be.revertedWithCustomError(provider, 'InvalidAuthorityAuthorization');

    const newNestedHanko = buildClaimsHanko(parentDigest, [deriveHardhatPrivateKey(2)], [anchor], [
      [entityId, [1], [1], 1],
      [parentId, [0, 2], [1, 1], 1],
    ]);
    await expect(provider.proposeBoard(parentId, parentNextBoard, 0, [newNestedHanko]))
      .to.emit(provider, 'BoardProposed');
  });
});
