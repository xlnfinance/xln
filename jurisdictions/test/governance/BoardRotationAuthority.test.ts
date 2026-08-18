import { expect } from 'chai';
import hre from 'hardhat';

import {
  buildFoundationAction,
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployDepositoryStack,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { mine } = networkHelpers;
const BOARD = 0;
const CONTROL = 1;
const FOUNDATION = 3;
const TARGET_ID = ethers.zeroPadValue(ethers.toBeHex(2), 32);
const HOLDER_A_ID = ethers.zeroPadValue(ethers.toBeHex(3), 32);
const HOLDER_B_ID = ethers.zeroPadValue(ethers.toBeHex(4), 32);
const ARTICLES = { controlDelay: 3, dividendDelay: 5, foundationDelay: 7 };

const nextBoard = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));

async function fixture(splitA = 60n) {
  const signers = await ethers.getSigners();
  const provider = await deployEntityProvider(signers[0]!.address);
  const targetBoard = singleSignerLazyEntityId(signers[1]!.address);
  const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'tuple(uint32 controlDelay,uint32 dividendDelay,uint32 foundationDelay)'],
    [targetBoard, ARTICLES],
  ));
  const registration = await buildFoundationAction(
    provider,
    await provider.FOUNDATION_REGISTER_ENTITY(),
    argumentsHash,
  );
  await provider.foundationRegisterEntity(
    targetBoard,
    ARTICLES,
    registration.hankoData,
    registration.actionNonce,
  );
  await provider.registerNumberedEntity(singleSignerLazyEntityId(signers[3]!.address));
  await provider.registerNumberedEntity(singleSignerLazyEntityId(signers[4]!.address));

  const { depository } = await deployDepositoryStack(await provider.getAddress());
  const supply = await provider.TOTAL_CONTROL_SUPPLY();
  const depositoryAddress = await depository.getAddress();
  const purpose = 'settled-control-governance';
  const releaseHash = await provider.computeReleaseControlSharesHankoHash(
    2n,
    depositoryAddress,
    supply,
    0n,
    purpose,
    1n,
  );
  await provider.releaseControlShares(
    2n,
    depositoryAddress,
    supply,
    0n,
    purpose,
    buildSingleSignerHanko(TARGET_ID, releaseHash, deriveHardhatPrivateKey(1)),
  );
  const controlTokenId = (await depository.getTokensLength()) - 1n;
  const amountA = (supply * splitA) / 100n;
  const batch = emptyBatch({
    reserveToReserve: [
      { receivingEntity: HOLDER_A_ID, tokenId: controlTokenId, amount: amountA },
      { receivingEntity: HOLDER_B_ID, tokenId: controlTokenId, amount: supply - amountA },
    ],
  });
  const encodedBatch = encodeBatch(batch);
  const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, 1n);
  await depository.processBatch(
    encodedBatch,
    buildSingleSignerHanko(TARGET_ID, batchHash, deriveHardhatPrivateKey(1)),
    1n,
  );
  return { provider, depository, signers, supply, controlTokenId };
}

const controlHanko = async (
  fx: Awaited<ReturnType<typeof fixture>>,
  holderId: string,
  signerIndex: number,
  boardHash: string,
  nonce = 1n,
): Promise<string> => {
  const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, CONTROL, nonce);
  return buildSingleSignerHanko(holderId, digest, deriveHardhatPrivateKey(signerIndex));
};

describe('EntityProvider settled CONTROL governance', function () {
  it('binds one Depository and releases CONTROL only into that custody', async function () {
    const fx = await fixture();
    expect(await fx.provider.shareDepository()).to.equal(await fx.depository.getAddress());
    expect(await fx.depository._reserves(HOLDER_A_ID, fx.controlTokenId)).to.equal(fx.supply * 60n / 100n);
    await expect(fx.provider.bindShareDepository(await fx.depository.getAddress()))
      .to.be.revertedWithCustomError(fx.provider, 'ShareDepositoryAlreadyBound');
    const releaseHash = await fx.provider.computeReleaseControlSharesHankoHash(
      2n,
      fx.signers[8]!.address,
      1n,
      0n,
      'wrong-custody',
      2n,
    );
    await expect(fx.provider.releaseControlShares(
      2n,
      fx.signers[8]!.address,
      1n,
      0n,
      'wrong-custody',
      buildSingleSignerHanko(TARGET_ID, releaseHash, deriveHardhatPrivateKey(1)),
    )).to.be.revertedWithCustomError(fx.provider, 'ShareDepositoryRequired');
  });

  it('lets a current Entity Hanko backed by more than 50% settled CONTROL schedule rotation', async function () {
    const fx = await fixture();
    const boardHash = nextBoard('reserve-majority');
    const hanko = await controlHanko(fx, HOLDER_A_ID, 3, boardHash);
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [hanko]))
      .to.emit(fx.provider, 'BoardProposed');
    await mine(ARTICLES.controlDelay);
    await expect(fx.provider.activateBoard(TARGET_ID)).to.emit(fx.provider, 'BoardActivated');
    expect((await fx.provider.entities(TARGET_ID)).currentBoardHash).to.equal(boardHash);
  });

  it('rejects exactly 50%, duplicate/unsorted supporters, and an unbacked Entity', async function () {
    const half = await fixture(50n);
    const halfBoard = nextBoard('exact-half');
    await expect(half.provider.proposeBoard(
      TARGET_ID,
      halfBoard,
      CONTROL,
      [await controlHanko(half, HOLDER_A_ID, 3, halfBoard)],
    )).to.be.revertedWithCustomError(half.provider, 'InsufficientShareSupport');

    const fx = await fixture();
    const boardHash = nextBoard('supporter-order');
    const a = await controlHanko(fx, HOLDER_A_ID, 3, boardHash);
    const b = await controlHanko(fx, HOLDER_B_ID, 4, boardHash);
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [a, a]))
      .to.be.revertedWithCustomError(fx.provider, 'DuplicateShareSupporter');
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [b, a]))
      .to.be.revertedWithCustomError(fx.provider, 'ShareSupportersNotSorted');

    const unbackedId = singleSignerLazyEntityId(fx.signers[7]!.address);
    const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, CONTROL, 1n);
    const unbacked = buildSingleSignerHanko(unbackedId, digest, deriveHardhatPrivateKey(7));
    await expect(fx.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [unbacked]))
      .to.be.revertedWithCustomError(fx.provider, 'ShareSupporterHasNoShares');
  });

  it('rejects a retired shareholder board even during historical-proof grace', async function () {
    const fx = await fixture();
    const replacement = singleSignerLazyEntityId(fx.signers[8]!.address);
    const shareholderNonce = 1n;
    const shareholderDigest = await fx.provider.computeBoardProposalHash(
      HOLDER_A_ID,
      replacement,
      BOARD,
      shareholderNonce,
    );
    await fx.provider.proposeBoard(
      HOLDER_A_ID,
      replacement,
      BOARD,
      [buildSingleSignerHanko(HOLDER_A_ID, shareholderDigest, deriveHardhatPrivateKey(3))],
    );
    await mine(1_000);
    await fx.provider.activateBoard(HOLDER_A_ID);

    const targetBoard = nextBoard('retired-shareholder-board');
    const stale = await controlHanko(fx, HOLDER_A_ID, 3, targetBoard);
    await expect(fx.provider.proposeBoard(TARGET_ID, targetBoard, CONTROL, [stale]))
      .to.be.revertedWithCustomError(fx.provider, 'InvalidShareSupportSignature');
    const current = await controlHanko(fx, HOLDER_A_ID, 8, targetBoard);
    await expect(fx.provider.proposeBoard(TARGET_ID, targetBoard, CONTROL, [current]))
      .to.emit(fx.provider, 'BoardProposed');
  });

  it('binds proposal signatures to provider, epoch and nonce', async function () {
    const left = await fixture();
    const right = await fixture();
    const boardHash = nextBoard('replay-domain');
    const leftHanko = await controlHanko(left, HOLDER_A_ID, 3, boardHash);
    await expect(right.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [leftHanko]))
      .to.be.revertedWithCustomError(right.provider, 'InvalidShareSupportSignature');
    await left.provider.proposeBoard(TARGET_ID, boardHash, CONTROL, [leftHanko]);
    await expect(left.provider.proposeBoard(TARGET_ID, nextBoard('stale'), CONTROL, [leftHanko]))
      .to.revert(ethers);
  });

  it('keeps BOARD authority current-only and activation permissionless', async function () {
    const fx = await fixture();
    const boardHash = nextBoard('board-authority');
    const digest = await fx.provider.computeBoardProposalHash(TARGET_ID, boardHash, BOARD, 1n);
    await fx.provider.proposeBoard(
      TARGET_ID,
      boardHash,
      BOARD,
      [buildSingleSignerHanko(TARGET_ID, digest, deriveHardhatPrivateKey(1))],
    );
    await mine(ARTICLES.controlDelay);
    await expect(fx.provider.connect(fx.signers[9]!).activateBoard(TARGET_ID))
      .to.emit(fx.provider, 'BoardActivated');

    const lowerPriority = nextBoard('foundation-after-board');
    const nonce = (await fx.provider.boardActionNonces(TARGET_ID)) + 1n;
    const foundationDigest = await fx.provider.computeBoardProposalHash(
      TARGET_ID,
      lowerPriority,
      FOUNDATION,
      nonce,
    );
    await expect(fx.provider.proposeBoard(
      TARGET_ID,
      lowerPriority,
      FOUNDATION,
      [buildSingleSignerHanko(ethers.zeroPadValue(ethers.toBeHex(1), 32), foundationDigest, deriveHardhatPrivateKey(0))],
    )).to.emit(fx.provider, 'BoardProposed');
  });
});
