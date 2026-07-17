import { loadFixture, mine } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
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
const DISPUTE_PROOF = 1;
const INT256_MAX = (1n << 255n) - 1n;
const WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:ondelta-liveness'));
const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

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

const registerFixedErc20 = async (depository: Depository, supply: bigint) => {
  const tokenFactory = await ethers.getContractFactory('ERC20Mock');
  const token = await tokenFactory.deploy('Fixed Supply', 'FIXED', 0, supply);
  await token.waitForDeployment();
  const tokenId = await depository.registerExternalToken.staticCall(0, await token.getAddress(), 0);
  await depository.registerExternalToken(0, await token.getAddress(), 0);
  return { token, tokenId };
};

const processBatch = async (
  depository: Depository,
  sender: Actor,
  batch: Record<string, unknown>,
  gasLimit?: bigint,
) => {
  const encoded = encodeBatch(batch);
  const nonce = await depository.entityNonces(sender.entityId) + 1n;
  const hash = await computeDepositoryBatchHash(depository, encoded, nonce);
  const hanko = buildSingleSignerHanko(sender.entityId, hash, sender.privateKey);
  return depository.connect(sender.signer).processBatch(
    encoded,
    hanko,
    nonce,
    gasLimit === undefined ? {} : { gasLimit },
  );
};

const disputeProofHash = async (
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  proofbodyHash: string,
): Promise<string> => {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(abi.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
    [DISPUTE_PROOF, chainId, await depository.getAddress(), accountKey, nonce, proofbodyHash, WATCH_SEED],
  ));
};

describe('dispute ondelta liveness', function () {
  it('rejects a reserve balance above int256.max before mutating state', async function () {
    const { depository, signer0 } = await loadFixture(deployFixture);
    const owner = actor(signer0, 0);
    const { tokenId } = await registerFixedErc20(depository, INT256_MAX);
    const oversized = INT256_MAX + 1n;

    await expect(depository.mintToReserve(owner.entityId, tokenId, oversized))
      .to.be.revertedWithCustomError(depository, 'E8');
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(0n);

    await depository.mintToReserve(owner.entityId, tokenId, INT256_MAX);
    await expect(depository.mintToReserve(owner.entityId, tokenId, 1n))
      .to.be.revertedWithCustomError(depository, 'E8');
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(INT256_MAX);
  });

  it('finalizes the exact wide delta after same-nonce unilateral R2C crosses int256.max', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(actor(signer0, 0), actor(signer1, 1));
    const { tokenId } = await registerFixedErc20(depository, INT256_MAX);
    const initialCollateral = INT256_MAX - 10n;
    const laterCollateral = 1n;
    const signedOffdelta = 10n;
    const proofNonce = 1n;
    const accountKey = await depository.accountKey(left.entityId, right.entityId);

    await depository.mintToReserve(left.entityId, tokenId, initialCollateral + laterCollateral);
    await processBatch(depository, left, emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: initialCollateral }],
      }],
    }));

    const transformer = right.signer.address;
    const proofbody = {
      watchSeed: WATCH_SEED,
      offdeltas: [signedOffdelta],
      tokenIds: [tokenId],
      transformers: [{ transformerAddress: transformer, encodedBatch: '0x', allowances: [] }],
    };
    const proofbodyHash = ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
    const innerHash = await disputeProofHash(depository, accountKey, proofNonce, proofbodyHash);
    const innerHanko = buildSingleSignerHanko(right.entityId, innerHash, right.privateKey);
    await processBatch(depository, left, emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: proofNonce,
        proofbodyHash,
        initialProofbody: proofbody,
        watchSeed: WATCH_SEED,
        sig: innerHanko,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      }],
    }));

    // R2C is unilateral and deliberately keeps the bilateral Account nonce.
    // The exact final delta is now int256.max + 1, while collateral and the
    // resulting ten-token shortfall still fit their native uint256 domains.
    await processBatch(depository, left, emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: laterCollateral }],
      }],
    }));
    expect((await depository._accounts(accountKey)).nonce).to.equal(proofNonce);

    await mine(Number(await depository.defaultDisputeDelay()));
    await expect(processBatch(depository, left, emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: proofNonce,
        finalNonce: proofNonce,
        initialProofbodyHash: proofbodyHash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    }))).to.emit(depository, 'TransformerClauseSkipped')
      .withArgs(ethers.keccak256(accountKey), 0n, transformer, 7n);

    const collateral = await depository._collaterals(accountKey, tokenId);
    expect(collateral.collateral).to.equal(0n);
    expect(collateral.ondelta).to.equal(0n);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(initialCollateral + laterCollateral);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
    expect(await depository.debtOutstanding(right.entityId, tokenId)).to.equal(signedOffdelta);
  });

  it('settles int256.min as an exact signed magnitude instead of negation panic', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(actor(signer0, 0), actor(signer1, 1));
    const { tokenId } = await registerFixedErc20(depository, INT256_MAX);
    const collateralAmount = 100n;
    const signedOffdelta = -(1n << 255n);
    const proofNonce = 1n;
    const accountKey = await depository.accountKey(left.entityId, right.entityId);

    // RIGHT-funded collateral does not change LEFT-oriented ondelta.
    await depository.mintToReserve(right.entityId, tokenId, collateralAmount);
    await processBatch(depository, right, emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: right.entityId,
        pairs: [{ entity: left.entityId, amount: collateralAmount }],
      }],
    }));

    const proofbody = {
      watchSeed: WATCH_SEED,
      offdeltas: [signedOffdelta],
      tokenIds: [tokenId],
      transformers: [],
    };
    const proofbodyHash = ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
    const innerHash = await disputeProofHash(depository, accountKey, proofNonce, proofbodyHash);
    const innerHanko = buildSingleSignerHanko(right.entityId, innerHash, right.privateKey);
    await processBatch(depository, left, emptyBatch({
      disputeStarts: [{
        counterentity: right.entityId,
        nonce: proofNonce,
        proofbodyHash,
        initialProofbody: proofbody,
        watchSeed: WATCH_SEED,
        sig: innerHanko,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      }],
    }));
    await mine(Number(await depository.defaultDisputeDelay()));

    await expect(processBatch(depository, left, emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: proofNonce,
        finalNonce: proofNonce,
        initialProofbodyHash: proofbodyHash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    }))).to.emit(depository, 'FatalTokenError').withArgs(
      tokenId,
      left.entityId,
      1n << 255n,
      INT256_MAX,
      INT256_MAX,
      0n,
    );

    expect(await depository._reserves(right.entityId, tokenId)).to.equal(collateralAmount);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(INT256_MAX);
    const collateral = await depository._collaterals(accountKey, tokenId);
    expect(collateral.collateral).to.equal(0n);
    expect(collateral.ondelta).to.equal(0n);
  });

  it('finalizes every dispute while capping aggregate debt to the token supply', async function () {
    const { depository, signer0 } = await loadFixture(deployFixture);
    const signers = await ethers.getSigners();
    const debtor = actor(signer0, 0);
    const creditors = [actor(signers[1]!, 1), actor(signers[2]!, 2), actor(signers[3]!, 3)];
    const reserveHolder = actor(signers[4]!, 4);
    const { token, tokenId } = await registerFixedErc20(depository, 100n);
    await token.approve(await depository.getAddress(), 10n);
    await depository.adminRegisterExternalToken({
      entity: reserveHolder.entityId,
      contractAddress: await token.getAddress(),
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: tokenId,
      amount: 10n,
    });
    const requestedDebts = [60n, 60n, 10n] as const;

    const disputes = await Promise.all(creditors.map(async (creditor, index) => {
      const accountKey = await depository.accountKey(debtor.entityId, creditor.entityId);
      const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
      const proofbody = {
        watchSeed: WATCH_SEED,
        offdeltas: [debtorIsLeft ? -requestedDebts[index]! : requestedDebts[index]!],
        tokenIds: [tokenId],
        transformers: [],
      };
      const proofbodyHash = ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
      const innerHash = await disputeProofHash(depository, accountKey, 1n, proofbodyHash);
      return {
        creditor,
        accountKey,
        debtorIsLeft,
        proofbody,
        proofbodyHash,
        innerHanko: buildSingleSignerHanko(creditor.entityId, innerHash, creditor.privateKey),
      };
    }));

    await processBatch(depository, debtor, emptyBatch({
      disputeStarts: disputes.map((dispute) => ({
        counterentity: dispute.creditor.entityId,
        nonce: 1n,
        proofbodyHash: dispute.proofbodyHash,
        initialProofbody: dispute.proofbody,
        watchSeed: WATCH_SEED,
        sig: dispute.innerHanko,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      })),
    }));
    await mine(Number(await depository.defaultDisputeDelay()));

    for (let index = 0; index < disputes.length; index++) {
      const dispute = disputes[index]!;
      const finalization = processBatch(depository, debtor, emptyBatch({
        disputeFinalizations: [{
          counterentity: dispute.creditor.entityId,
          initialNonce: 1n,
          finalNonce: 1n,
          initialProofbodyHash: dispute.proofbodyHash,
          finalProofbody: dispute.proofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: dispute.debtorIsLeft,
          cooperative: false,
        }],
      }));
      if (index === 0) {
        await expect(finalization).to.not.be.reverted;
      } else {
        await expect(finalization).to.emit(depository, 'FatalTokenError').withArgs(
          tokenId,
          debtor.entityId,
          requestedDebts[index],
          index === 1 ? 40n : 0n,
          100n,
          index === 1 ? 60n : 100n,
        );
      }
    }

    expect(await depository.debtOutstanding(debtor.entityId, tokenId)).to.equal(100n);
    expect(await depository._activeDebtsByToken(debtor.entityId, tokenId)).to.equal(2n);
    expect(await depository.entityNonces(debtor.entityId)).to.equal(4n);
    expect((await depository._debts(debtor.entityId, tokenId, 0)).amount).to.equal(60n);
    expect((await depository._debts(debtor.entityId, tokenId, 1)).amount).to.equal(40n);
    for (let index = 0; index < disputes.length; index++) {
      expect((await depository._accounts(disputes[index]!.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    }

    expect(await depository._reserves(reserveHolder.entityId, tokenId)).to.equal(10n);

    const receivingEntity = ethers.zeroPadValue(reserveHolder.signer.address, 32);
    await expect(processBatch(depository, reserveHolder, emptyBatch({
      reserveToExternalToken: [{ receivingEntity, tokenId, amount: 10n }],
    }))).to.not.be.reverted;
    expect(await depository._reserves(reserveHolder.entityId, tokenId)).to.equal(0n);
    expect(await token.balanceOf(reserveHolder.signer.address)).to.equal(10n);
  });

  it('rejects unsupported fixed supplies at token registration', async function () {
    const { depository } = await loadFixture(deployFixture);
    const tokenFactory = await ethers.getContractFactory('ERC20Mock');
    const zeroSupply = await tokenFactory.deploy('Zero', 'ZERO', 0, 0n);
    const oversizedSupply = await tokenFactory.deploy('Oversized', 'HUGE', 0, INT256_MAX + 1n);
    await Promise.all([zeroSupply.waitForDeployment(), oversizedSupply.waitForDeployment()]);

    await expect(depository.registerExternalToken(0, await zeroSupply.getAddress(), 0))
      .to.be.revertedWithCustomError(depository, 'E11');
    await expect(depository.registerExternalToken(0, await oversizedSupply.getAddress(), 0))
      .to.be.revertedWithCustomError(depository, 'E11');
    expect(await depository.getTokensLength()).to.equal(1n);
  });

  it('finalizes an adversarial unknown-token proof as zero debt with fatal evidence', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const debtor = actor(signer0, 0);
    const creditor = actor(signer1, 1);
    const tokenId = 999n;
    const requested = 5n;
    const accountKey = await depository.accountKey(debtor.entityId, creditor.entityId);
    const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
    const proofbody = {
      watchSeed: WATCH_SEED,
      offdeltas: [debtorIsLeft ? -requested : requested],
      tokenIds: [tokenId],
      transformers: [],
    };
    const proofbodyHash = ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
    const innerHash = await disputeProofHash(depository, accountKey, 1n, proofbodyHash);
    const innerHanko = buildSingleSignerHanko(creditor.entityId, innerHash, creditor.privateKey);

    await processBatch(depository, debtor, emptyBatch({
      disputeStarts: [{
        counterentity: creditor.entityId,
        nonce: 1n,
        proofbodyHash,
        initialProofbody: proofbody,
        watchSeed: WATCH_SEED,
        sig: innerHanko,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      }],
    }));
    await mine(Number(await depository.defaultDisputeDelay()));
    await expect(processBatch(depository, debtor, emptyBatch({
      disputeFinalizations: [{
        counterentity: creditor.entityId,
        initialNonce: 1n,
        finalNonce: 1n,
        initialProofbodyHash: proofbodyHash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: debtorIsLeft,
        cooperative: false,
      }],
    }))).to.emit(depository, 'FatalTokenError').withArgs(
      tokenId,
      debtor.entityId,
      requested,
      0n,
      0n,
      0n,
    );

    expect(await depository.debtOutstanding(debtor.entityId, tokenId)).to.equal(0n);
    expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
  });

  for (const [label, mode] of [['gas-burning', 1n], ['returndata-bomb', 2n]] as const) {
    it(`finalizes after a registered token becomes ${label}`, async function () {
      const { depository, signer0, signer1 } = await loadFixture(deployFixture);
      const debtor = actor(signer0, 0);
      const creditor = actor(signer1, 1);
      const supplyFactory = await ethers.getContractFactory('SupplyLivenessHarness');
      const token = await supplyFactory.deploy(100n);
      await token.waitForDeployment();
      const tokenId = await depository.registerExternalToken.staticCall(0, await token.getAddress(), 0);
      await depository.registerExternalToken(0, await token.getAddress(), 0);

      const accountKey = await depository.accountKey(debtor.entityId, creditor.entityId);
      const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
      const proofbody = {
        watchSeed: WATCH_SEED,
        offdeltas: [debtorIsLeft ? -60n : 60n],
        tokenIds: [tokenId],
        transformers: [],
      };
      const proofbodyHash = ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
      const innerHash = await disputeProofHash(depository, accountKey, 1n, proofbodyHash);
      await processBatch(depository, debtor, emptyBatch({
        disputeStarts: [{
          counterentity: creditor.entityId,
          nonce: 1n,
          proofbodyHash,
          initialProofbody: proofbody,
          watchSeed: WATCH_SEED,
          sig: buildSingleSignerHanko(creditor.entityId, innerHash, creditor.privateKey),
          starterInitialArguments: '0x',
          starterIncrementedArguments: '0x',
        }],
      }));
      await mine(Number(await depository.defaultDisputeDelay()));
      await token.setMode(mode);

      await expect(processBatch(depository, debtor, emptyBatch({
        disputeFinalizations: [{
          counterentity: creditor.entityId,
          initialNonce: 1n,
          finalNonce: 1n,
          initialProofbodyHash: proofbodyHash,
          finalProofbody: proofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: debtorIsLeft,
          cooperative: false,
        }],
      }), 15_000_000n)).to.emit(depository, 'FatalTokenError').withArgs(
        tokenId,
        debtor.entityId,
        60n,
        0n,
        0n,
        0n,
      );

      expect(await depository.debtOutstanding(debtor.entityId, tokenId)).to.equal(0n);
      expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    });
  }
});
