import { mine } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  buildSingleSignerHanko,
  deriveHardhatPrivateKey,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const { ethers } = hre;

const BOARD = 0;
const CONTROL = 1;
const DIVIDEND = 2;
const FOUNDATION = 3;
const FOUNDATION_ID = ethers.zeroPadValue(ethers.toBeHex(1), 32);
const ENTITY_ID = ethers.zeroPadValue(ethers.toBeHex(2), 32);
const PROPOSAL_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V3'));
const CANCEL_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_CANCEL_V3'));
const ARTICLES = {
  controlDelay: 3,
  dividendDelay: 5,
  foundationDelay: 7,
};
const AUTHORITY = [BOARD, CONTROL, DIVIDEND, FOUNDATION] as const;
const PRIORITY: Record<number, number> = {
  [CONTROL]: 4,
  [BOARD]: 3,
  [DIVIDEND]: 2,
  [FOUNDATION]: 1,
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

const entityAddress = (entityNumber: bigint): string =>
  ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(entityNumber), 20));

const signDigest = (signerIndex: number, digest: string): string =>
  ethers.Signature.from(
    new ethers.SigningKey(deriveHardhatPrivateKey(signerIndex)).sign(digest),
  ).serialized;

async function fixture(articles = ARTICLES) {
  const signers = await ethers.getSigners();
  const [foundation, currentBoard] = signers;
  const EntityProvider = await ethers.getContractFactory('EntityProvider');
  const provider = await EntityProvider.deploy(foundation.address);
  await provider.waitForDeployment();
  await provider.foundationRegisterEntity(singleSignerLazyEntityId(currentBoard.address), articles);

  const address = entityAddress(2n);
  const [controlTokenId, dividendTokenId] = await provider.getTokenIds(2);
  const supply = await provider.TOTAL_CONTROL_SUPPLY();
  await ethers.provider.send('hardhat_impersonateAccount', [address]);
  await foundation.sendTransaction({ to: address, value: ethers.parseEther('1') });
  const entitySigner = await ethers.getSigner(address);
  await provider.connect(entitySigner).safeTransferFrom(
    address,
    signers[3].address,
    controlTokenId,
    (supply * 60n) / 100n,
    '0x',
  );
  await provider.connect(entitySigner).safeTransferFrom(
    address,
    signers[5].address,
    dividendTokenId,
    (supply * 60n) / 100n,
    '0x',
  );
  await ethers.provider.send('hardhat_stopImpersonatingAccount', [address]);

  return {
    provider,
    signers,
    articles,
    address,
    controlTokenId,
    dividendTokenId,
    supply,
  };
}

const boardHash = (seed: string): string => ethers.keccak256(ethers.toUtf8Bytes(seed));

async function authorityAuthorization(
  fx: Fixture,
  authority: number,
  digest: string,
  currentBoardSigner = 1,
): Promise<string[]> {
  if (authority === CONTROL) return [signDigest(3, digest)];
  if (authority === DIVIDEND) return [signDigest(5, digest)];
  if (authority === BOARD) {
    return [buildSingleSignerHanko(ENTITY_ID, digest, deriveHardhatPrivateKey(currentBoardSigner))];
  }
  return [buildSingleSignerHanko(FOUNDATION_ID, digest, deriveHardhatPrivateKey(0))];
}

async function propose(
  fx: Fixture,
  authority: number,
  nextBoardHash: string,
  currentBoardSigner = 1,
) {
  const nonce = (await fx.provider.boardActionNonces(ENTITY_ID)) + 1n;
  const digest = await fx.provider.computeBoardProposalHash(
    ENTITY_ID,
    nextBoardHash,
    authority,
    nonce,
  );
  const authorization = await authorityAuthorization(fx, authority, digest, currentBoardSigner);
  return fx.provider.proposeBoard(
    ENTITY_ID,
    nextBoardHash,
    authority,
    authorization,
  );
}

async function cancel(fx: Fixture, canceller: number) {
  const entity = await fx.provider.entities(ENTITY_ID);
  const nonce = await fx.provider.boardActionNonces(ENTITY_ID);
  const digest = await fx.provider.computeBoardProposalCancelHash(
    ENTITY_ID,
    entity.proposedBoardHash,
    entity.proposerType,
    canceller,
    nonce,
  );
  const authorization = await authorityAuthorization(fx, canceller, digest);
  return fx.provider.cancelBoardProposal(
    ENTITY_ID,
    canceller,
    authorization,
  );
}

describe('EntityProvider board-rotation authority', function () {
  it('fixes both share classes at 100 billion and exposes no mint/burn entrypoint', async function () {
    const fx = await fixture();
    expect(await fx.provider.TOTAL_CONTROL_SUPPLY()).to.equal(100_000_000_000n);
    expect(await fx.provider.TOTAL_DIVIDEND_SUPPLY()).to.equal(100_000_000_000n);
    const functionNames = fx.provider.interface.fragments
      .filter((fragment) => fragment.type === 'function')
      .map((fragment) => fragment.name);
    expect(functionNames).not.to.include('mint');
    expect(functionNames).not.to.include('burn');
  });

  it('enforces CONTROL > BOARD > DIVIDEND > FOUNDATION for all 16 replacements', async function () {
    for (const incumbent of AUTHORITY) {
      for (const challenger of AUTHORITY) {
        const fx = await fixture();
        const firstHash = boardHash(`incumbent-${incumbent}-${challenger}`);
        await propose(fx, incumbent, firstHash);
        const priorNonce = await fx.provider.boardActionNonces(ENTITY_ID);
        const replacementHash = boardHash(`challenger-${incumbent}-${challenger}`);

        if (PRIORITY[challenger] > PRIORITY[incumbent]) {
          await expect(propose(fx, challenger, replacementHash)).to.emit(fx.provider, 'BoardProposed');
          const entity = await fx.provider.entities(ENTITY_ID);
          expect(entity.proposedBoardHash).to.equal(replacementHash);
          expect(entity.proposerType).to.equal(challenger);
          expect(await fx.provider.boardActionNonces(ENTITY_ID)).to.equal(priorNonce + 1n);
        } else {
          await expect(propose(fx, challenger, replacementHash))
            .to.be.revertedWithCustomError(fx.provider, 'BoardProposalPriority');
          const entity = await fx.provider.entities(ENTITY_ID);
          expect(entity.proposedBoardHash).to.equal(firstHash);
          expect(await fx.provider.boardActionNonces(ENTITY_ID)).to.equal(priorNonce);
        }
      }
    }
  });

  it('enforces the same 4x4 priority rule for cancellation without consuming a second nonce', async function () {
    for (const incumbent of AUTHORITY) {
      for (const challenger of AUTHORITY) {
        const fx = await fixture();
        await propose(fx, incumbent, boardHash(`cancel-${incumbent}-${challenger}`));
        const proposalNonce = await fx.provider.boardActionNonces(ENTITY_ID);

        if (PRIORITY[challenger] > PRIORITY[incumbent]) {
          await expect(cancel(fx, challenger)).to.emit(fx.provider, 'ProposalCancelled');
          expect((await fx.provider.entities(ENTITY_ID)).proposedBoardHash).to.equal(ethers.ZeroHash);
          expect(await fx.provider.boardActionNonces(ENTITY_ID)).to.equal(proposalNonce);
        } else {
          await expect(cancel(fx, challenger)).to.be.revertedWithCustomError(fx.provider, 'CancellationPriority');
          expect((await fx.provider.entities(ENTITY_ID)).proposedBoardHash).to.not.equal(ethers.ZeroHash);
          expect(await fx.provider.boardActionNonces(ENTITY_ID)).to.equal(proposalNonce);
        }
      }
    }
  });

  it('disables dividend and foundation lanes only when their article delay is zero', async function () {
    const articles = { ...ARTICLES, dividendDelay: 0, foundationDelay: 0 };
    const fx = await fixture(articles);
    await expect(propose(fx, DIVIDEND, boardHash('disabled-dividend')))
      .to.be.revertedWithCustomError(fx.provider, 'DividendAuthorityDisabled');
    await expect(propose(fx, FOUNDATION, boardHash('disabled-foundation')))
      .to.be.revertedWithCustomError(fx.provider, 'FoundationAuthorityDisabled');
    await expect(propose(fx, BOARD, boardHash('enabled-board'))).to.emit(fx.provider, 'BoardProposed');
  });

  it('uses the configured per-authority delay and permits activation exactly at the boundary', async function () {
    for (const authority of AUTHORITY) {
      const fx = await fixture();
      const tx = await propose(fx, authority, boardHash(`delayed-${authority}`));
      const receipt = await tx.wait();
      const expectedDelay = authority === DIVIDEND
        ? ARTICLES.dividendDelay
        : authority === FOUNDATION
          ? ARTICLES.foundationDelay
          : ARTICLES.controlDelay;
      const entity = await fx.provider.entities(ENTITY_ID);
      expect(entity.activateAtBlock).to.equal(BigInt(receipt!.blockNumber + expectedDelay));
      await expect(fx.provider.connect(fx.signers[7]).activateBoard.staticCall(ENTITY_ID))
        .to.be.revertedWith('Delay period not met');
      await mine(expectedDelay - 1);
      await expect(fx.provider.connect(fx.signers[7]).activateBoard(ENTITY_ID))
        .to.emit(fx.provider, 'BoardActivated');
    }
  });

  it('requires sorted unique direct holders and samples their balances at submission', async function () {
    const duplicate = await fixture();
    const duplicateHash = boardHash('duplicate');
    const duplicateNonce = 1n;
    const duplicateDigest = await duplicate.provider.computeBoardProposalHash(
      ENTITY_ID, duplicateHash, CONTROL, duplicateNonce,
    );
    const repeated = signDigest(3, duplicateDigest);
    await expect(duplicate.provider.proposeBoard(
      ENTITY_ID, duplicateHash, CONTROL, [repeated, repeated],
    )).to.be.revertedWithCustomError(duplicate.provider, 'DuplicateShareSupporter');

    const split = await fixture();
    await split.provider.connect(split.signers[3]).safeTransferFrom(
      split.signers[3].address,
      split.signers[4].address,
      split.controlTokenId,
      (split.supply * 10n) / 100n,
      '0x',
    );
    const splitHash = boardHash('split-majority');
    const splitDigest = await split.provider.computeBoardProposalHash(ENTITY_ID, splitHash, CONTROL, 1n);
    const entries = [3, 4].map((index) => ({
      address: split.signers[index].address.toLowerCase(),
      signature: signDigest(index, splitDigest),
    })).sort((left, right) => left.address.localeCompare(right.address));
    await expect(split.provider.proposeBoard(
      ENTITY_ID, splitHash, CONTROL, entries.toReversed().map((entry) => entry.signature),
    )).to.be.revertedWithCustomError(split.provider, 'ShareSupportersNotSorted');
    await expect(split.provider.proposeBoard(
      ENTITY_ID, splitHash, CONTROL, entries.map((entry) => entry.signature),
    )).to.emit(split.provider, 'BoardProposed');

    const transferred = await fixture();
    const transferredHash = boardHash('transferred-before-submit');
    const digest = await transferred.provider.computeBoardProposalHash(ENTITY_ID, transferredHash, CONTROL, 1n);
    const originalSignature = signDigest(3, digest);
    await transferred.provider.connect(transferred.signers[3]).safeTransferFrom(
      transferred.signers[3].address,
      transferred.signers[4].address,
      transferred.controlTokenId,
      (transferred.supply * 20n) / 100n,
      '0x',
    );
    await expect(transferred.provider.proposeBoard(
      ENTITY_ID, transferredHash, CONTROL, [originalSignature],
    )).to.be.revertedWithCustomError(transferred.provider, 'InsufficientShareSupport');
    const movedEntries = [
      { address: transferred.signers[3].address.toLowerCase(), signature: originalSignature },
      { address: transferred.signers[4].address.toLowerCase(), signature: signDigest(4, digest) },
    ].sort((left, right) => left.address.localeCompare(right.address));
    await expect(transferred.provider.proposeBoard(
      ENTITY_ID, transferredHash, CONTROL, movedEntries.map((entry) => entry.signature),
    )).to.emit(transferred.provider, 'BoardProposed');
  });

  it('rejects exactly 50%, unknown holders, and the wrong share class', async function () {
    const half = await fixture();
    await half.provider.connect(half.signers[3]).safeTransferFrom(
      half.signers[3].address,
      half.address,
      half.controlTokenId,
      (half.supply * 10n) / 100n,
      '0x',
    );
    const halfHash = boardHash('exact-half');
    const halfDigest = await half.provider.computeBoardProposalHash(ENTITY_ID, halfHash, CONTROL, 1n);
    await expect(half.provider.proposeBoard(
      ENTITY_ID, halfHash, CONTROL, [signDigest(3, halfDigest)],
    )).to.be.revertedWithCustomError(half.provider, 'InsufficientShareSupport');

    const unknown = await fixture();
    const unknownHash = boardHash('unknown-holder');
    const unknownDigest = await unknown.provider.computeBoardProposalHash(ENTITY_ID, unknownHash, CONTROL, 1n);
    await expect(unknown.provider.proposeBoard(
      ENTITY_ID, unknownHash, CONTROL, [signDigest(7, unknownDigest)],
    )).to.be.revertedWithCustomError(unknown.provider, 'ShareSupporterHasNoShares');

    const wrongClass = await fixture();
    const wrongHash = boardHash('wrong-class');
    const controlDigest = await wrongClass.provider.computeBoardProposalHash(ENTITY_ID, wrongHash, CONTROL, 1n);
    await expect(wrongClass.provider.proposeBoard(
      ENTITY_ID, wrongHash, DIVIDEND, [signDigest(3, controlDigest)],
    )).to.be.revertedWithCustomError(wrongClass.provider, 'ShareSupporterHasNoShares');
  });

  it('accepts only one canonical Hanko from the exact current board', async function () {
    const fx = await fixture();
    const rotatedBoardHash = singleSignerLazyEntityId(fx.signers[8].address);
    await propose(fx, CONTROL, rotatedBoardHash);
    await mine(ARTICLES.controlDelay);
    await fx.provider.activateBoard(ENTITY_ID);

    const nextHash = singleSignerLazyEntityId(fx.signers[2].address);
    const digest = await fx.provider.computeBoardProposalHash(ENTITY_ID, nextHash, BOARD, 2n);
    const previousHanko = buildSingleSignerHanko(ENTITY_ID, digest, deriveHardhatPrivateKey(1));
    const currentHanko = buildSingleSignerHanko(ENTITY_ID, digest, deriveHardhatPrivateKey(8));
    expect(await fx.provider.verifyHankoSignature(previousHanko, digest)).to.deep.equal([ENTITY_ID, true]);
    await expect(fx.provider.proposeBoard(ENTITY_ID, nextHash, BOARD, [previousHanko]))
      .to.be.revertedWithCustomError(fx.provider, 'InvalidAuthorityAuthorization');
    await expect(fx.provider.proposeBoard(ENTITY_ID, nextHash, BOARD, [currentHanko]))
      .to.emit(fx.provider, 'BoardProposed');

    const extra = await fixture();
    const extraHash = boardHash('extra-hanko');
    const extraDigest = await extra.provider.computeBoardProposalHash(ENTITY_ID, extraHash, BOARD, 1n);
    const hanko = buildSingleSignerHanko(ENTITY_ID, extraDigest, deriveHardhatPrivateKey(1));
    await expect(extra.provider.proposeBoard(ENTITY_ID, extraHash, BOARD, [hanko, hanko]))
      .to.be.revertedWithCustomError(extra.provider, 'InvalidHankoAuthorizationCount');
  });

  it('binds V3 proposal/cancel digests to chain, provider, board epoch, authority, and nonce', async function () {
    const fx = await fixture();
    const nextHash = boardHash('golden-domain');
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const providerAddress = await fx.provider.getAddress();
    const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint8', 'uint256'],
      [PROPOSAL_DOMAIN, chainId, providerAddress, ENTITY_ID, 0n, nextHash, CONTROL, 1n],
    ));
    expect(await fx.provider.computeBoardProposalHash(ENTITY_ID, nextHash, CONTROL, 1n)).to.equal(expected);

    const wrongChain = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint8', 'uint256'],
      [PROPOSAL_DOMAIN, chainId + 1n, providerAddress, ENTITY_ID, 0n, nextHash, CONTROL, 1n],
    ));
    await expect(fx.provider.proposeBoard(
      ENTITY_ID, nextHash, CONTROL, [signDigest(3, wrongChain)],
    )).to.be.revertedWithCustomError(fx.provider, 'ShareSupporterHasNoShares');

    await propose(fx, FOUNDATION, nextHash);
    const nonce = await fx.provider.boardActionNonces(ENTITY_ID);
    const cancelExpected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint8', 'uint8', 'uint256'],
      [CANCEL_DOMAIN, chainId, providerAddress, ENTITY_ID, 0n, nextHash, FOUNDATION, DIVIDEND, nonce],
    ));
    expect(await fx.provider.computeBoardProposalCancelHash(
      ENTITY_ID, nextHash, FOUNDATION, DIVIDEND, nonce,
    )).to.equal(cancelExpected);
    await cancel(fx, DIVIDEND);
    expect(await fx.provider.boardActionNonces(ENTITY_ID)).to.equal(1n);
    await expect(propose(fx, FOUNDATION, boardHash('after-cancel')))
      .to.emit(fx.provider, 'BoardProposed')
      .withArgs(ENTITY_ID, boardHash('after-cancel'), FOUNDATION, 2n, await activationBlock(fx, FOUNDATION));
  });

  it('rejects cross-provider and stale-nonce authorization replays', async function () {
    const left = await fixture();
    const right = await fixture();
    const replayHash = boardHash('cross-provider-replay');
    const leftDigest = await left.provider.computeBoardProposalHash(
      ENTITY_ID, replayHash, CONTROL, 1n,
    );
    await expect(right.provider.proposeBoard(
      ENTITY_ID, replayHash, CONTROL, [signDigest(3, leftDigest)],
    )).to.be.revertedWithCustomError(right.provider, 'ShareSupporterHasNoShares');

    await propose(left, FOUNDATION, boardHash('low-priority-pending'));
    const staleDigest = await left.provider.computeBoardProposalHash(
      ENTITY_ID, replayHash, CONTROL, 1n,
    );
    await expect(left.provider.proposeBoard(
      ENTITY_ID, replayHash, CONTROL, [signDigest(3, staleDigest)],
    )).to.be.revertedWithCustomError(left.provider, 'ShareSupporterHasNoShares');
    expect(await left.provider.boardActionNonces(ENTITY_ID)).to.equal(1n);
  });

  it('keeps every mutating EntityProvider action current-board-only during grace', async function () {
    const fx = await fixture();
    const currentBoardSigner = 8;
    await propose(fx, BOARD, singleSignerLazyEntityId(fx.signers[currentBoardSigner].address));
    await mine(ARTICLES.controlDelay);
    await fx.provider.activateBoard(ENTITY_ID);

    const oldHanko = (digest: string) => buildSingleSignerHanko(
      ENTITY_ID,
      digest,
      deriveHardhatPrivateKey(1),
    );
    const currentHanko = (digest: string) => buildSingleSignerHanko(
      ENTITY_ID,
      digest,
      deriveHardhatPrivateKey(currentBoardSigner),
    );

    const transferHash = await fx.provider.computeEntityTransferHankoHash(
      2n, fx.signers[2].address, fx.controlTokenId, 1n, 1n,
    );
    expect(await fx.provider.verifyHankoSignature(oldHanko(transferHash), transferHash))
      .to.deep.equal([ENTITY_ID, true]);
    await expect(fx.provider.entityTransferTokens(
      2n, fx.signers[2].address, fx.controlTokenId, 1n, oldHanko(transferHash),
    )).to.be.revertedWith('Invalid entity signature');
    await expect(fx.provider.entityTransferTokens(
      2n, fx.signers[2].address, fx.controlTokenId, 1n, currentHanko(transferHash),
    )).to.emit(fx.provider, 'EntityProviderActionExecuted');

    const cancelledActionHash = boardHash('current-board-cancel');
    const cancelHash = await fx.provider.computeCancelEntityProviderActionHankoHash(
      2n, 2n, cancelledActionHash, 0,
    );
    await expect(fx.provider.cancelEntityProviderAction(
      2n, cancelledActionHash, 0, oldHanko(cancelHash),
    )).to.be.revertedWith('Invalid entity signature');
    await expect(fx.provider.cancelEntityProviderAction(
      2n, cancelledActionHash, 0, currentHanko(cancelHash),
    )).to.emit(fx.provider, 'EntityProviderActionCancelled');

    const purpose = 'current-board-only';
    const releaseHash = await fx.provider.computeReleaseControlSharesHankoHash(
      2n, fx.signers[7].address, 0n, 1n, purpose, 3n,
    );
    await expect(fx.provider.releaseControlShares(
      2n, fx.signers[7].address, 0n, 1n, purpose, oldHanko(releaseHash),
    )).to.be.revertedWith('Invalid entity signature');
    await expect(fx.provider.releaseControlShares(
      2n, fx.signers[7].address, 0n, 1n, purpose, currentHanko(releaseHash),
    )).to.emit(fx.provider, 'EntityProviderActionExecuted');
    expect(await fx.provider.entityActionNonces(ENTITY_ID)).to.equal(3n);
  });

  it('never revives a pending EntityProvider action after A -> B -> A', async function () {
    const fx = await fixture();
    const boardBSigner = 8;
    const amount = (fx.supply * 40n) / 100n;
    const purpose = 'old-board-action-must-expire';
    const oldDigest = await fx.provider.computeReleaseControlSharesHankoHash(
      2n,
      fx.signers[7].address,
      amount,
      0n,
      purpose,
      1n,
    );
    const oldHanko = buildSingleSignerHanko(
      ENTITY_ID,
      oldDigest,
      deriveHardhatPrivateKey(1),
    );

    await propose(fx, BOARD, singleSignerLazyEntityId(fx.signers[boardBSigner].address));
    await mine(ARTICLES.controlDelay);
    await fx.provider.activateBoard(ENTITY_ID);
    expect(await fx.provider.boardEpochs(ENTITY_ID)).to.equal(1n);
    expect(await fx.provider.entityActionNonces(ENTITY_ID)).to.equal(0n);
    expect(await fx.provider.computeReleaseControlSharesHankoHash(
      2n, fx.signers[7].address, amount, 0n, purpose, 1n,
    )).to.not.equal(oldDigest);
    await expect(fx.provider.releaseControlShares(
      2n, fx.signers[7].address, amount, 0n, purpose, oldHanko,
    )).to.be.revertedWith('Invalid entity signature');

    await propose(fx, BOARD, singleSignerLazyEntityId(fx.signers[1].address), boardBSigner);
    await mine(ARTICLES.controlDelay);
    await fx.provider.activateBoard(ENTITY_ID);
    expect(await fx.provider.boardEpochs(ENTITY_ID)).to.equal(2n);
    expect(await fx.provider.entityActionNonces(ENTITY_ID)).to.equal(0n);
    expect(await fx.provider.computeReleaseControlSharesHankoHash(
      2n, fx.signers[7].address, amount, 0n, purpose, 1n,
    )).to.not.equal(oldDigest);
    await expect(fx.provider.releaseControlShares(
      2n, fx.signers[7].address, amount, 0n, purpose, oldHanko,
    )).to.be.revertedWith('Invalid entity signature');
    expect(await fx.provider.balanceOf(fx.signers[7].address, fx.controlTokenId)).to.equal(0n);
  });

  it('lets one board govern many numbered entities without proposal squatting', async function () {
    const fx = await fixture();
    const sharedBoardHash = boardHash('shared-board-no-global-reservation');
    await fx.provider.registerNumberedEntity(sharedBoardHash);
    expect((await fx.provider.entities(ethers.zeroPadValue(ethers.toBeHex(3), 32))).currentBoardHash)
      .to.equal(sharedBoardHash);

    await expect(propose(fx, FOUNDATION, sharedBoardHash)).to.emit(fx.provider, 'BoardProposed');
    await mine(fx.articles.foundationDelay);
    await fx.provider.activateBoard(ENTITY_ID);
    expect((await fx.provider.entities(ENTITY_ID)).currentBoardHash).to.equal(sharedBoardHash);

    await fx.provider.registerNumberedEntity(sharedBoardHash);
    expect((await fx.provider.entities(ethers.zeroPadValue(ethers.toBeHex(4), 32))).currentBoardHash)
      .to.equal(sharedBoardHash);
  });

  it('keeps a lazy Entity root board immutable forever', async function () {
    const fx = await fixture();
    const lazyEntityId = singleSignerLazyEntityId(fx.signers[1].address);
    await expect(fx.provider.proposeBoard(
      lazyEntityId,
      boardHash('forbidden-lazy-root-rotation'),
      FOUNDATION,
      [],
    )).to.be.revertedWith("Entity doesn't exist");
    await expect(fx.provider.activateBoard(lazyEntityId))
      .to.be.revertedWith("Entity doesn't exist");
  });
});

async function activationBlock(fx: Fixture, authority: number): Promise<bigint> {
  const current = BigInt(await ethers.provider.getBlockNumber());
  const delay = authority === FOUNDATION
    ? fx.articles.foundationDelay
    : authority === DIVIDEND
      ? fx.articles.dividendDelay
      : fx.articles.controlDelay;
  return current + 1n + BigInt(delay);
}
