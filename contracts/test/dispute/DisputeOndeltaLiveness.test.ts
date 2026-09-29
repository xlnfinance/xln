import { expect } from 'chai';
import hre from 'hardhat';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import type { Depository, EntityProvider } from '../../typechain-types/index.js';
import {
  buildSingleSignerHanko,
  canonicalAccountKey,
  computeDepositoryBatchHash,
  deriveHardhatPrivateKey,
  deployDepositoryStack,
  deployEntityProvider,
  emptyBatch,
  encodeBatch,
  foundationListExternalToken,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { loadFixture, mine, time } = networkHelpers;
const abi = ethers.AbiCoder.defaultAbiCoder();
const DISPUTE_PROOF = 1;
const INT256_MAX = (1n << 255n) - 1n; // token-supply validity bound (Account._tokenSupply)
const MAX_MONEY = 1n << 200n; // Types.sol: cap on every financial magnitude
const WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:ondelta-liveness'));
const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

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

// Listing is a Foundation action routed through the EntityProvider (deployer
// address 0 is the 1-of-1 Foundation board in every fixture).
let entityProvider: EntityProvider;
const listErc20 = async (depository: Depository, contractAddress: string): Promise<void> => {
  await foundationListExternalToken(entityProvider, await depository.getAddress(), 0, contractAddress, 0);
};

const deployFixture = async () => {
  const [signer0, signer1] = await ethers.getSigners();
  entityProvider = await deployEntityProvider(signer0.address);
  const { depository } = await deployDepositoryStack(await entityProvider.getAddress());
  return { depository, signer0, signer1 };
};

const advancePastTimeout = async (depository: Depository, left: string, right: string): Promise<void> => {
  const timeout = (await depository._accounts(canonicalAccountKey(left, right))).disputeTimeout;
  if (BigInt(await time.latest()) <= timeout) await time.increaseTo(Number(timeout + 1n));
};

const registerFixedErc20 = async (depository: Depository, supply: bigint) => {
  const tokenFactory = await ethers.getContractFactory('ERC20Mock');
  const token = await tokenFactory.deploy('Fixed Supply', 'FIXED', 0, supply);
  await token.waitForDeployment();
  await listErc20(depository, await token.getAddress());
  const tokenId = (await depository.getTokensLength()) - 1n;
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
  proposerIsLeft = false,
): Promise<string> => {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(abi.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
    [DISPUTE_PROOF, chainId, await depository.getAddress(), accountKey, nonce, proposerIsLeft, proofbodyHash, WATCH_SEED],
  ));
};

describe('dispute ondelta liveness', function () {
  it('caps a reserve at exactly MAX_MONEY (2^200) before mutating state', async function () {
    const { depository, signer0 } = await loadFixture(deployFixture);
    const owner = actor(signer0, 0);
    const { tokenId } = await registerFixedErc20(depository, MAX_MONEY);
    const oversized = MAX_MONEY + 1n;

    await expect(depository.mintToReserve(owner.entityId, tokenId, oversized))
      .to.be.revertedWithCustomError(depository, 'E8');
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(0n);

    await depository.mintToReserve(owner.entityId, tokenId, MAX_MONEY);
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(MAX_MONEY);
    await expect(depository.mintToReserve(owner.entityId, tokenId, 1n))
      .to.be.revertedWithCustomError(depository, 'E8');
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(MAX_MONEY);
  });

  it('finalizes exactly when ondelta and offdelta both sit at the MAX_MONEY bound', async function () {
    // ondelta + offdelta = 2^201 fits int256 with room to spare, so the delta is
    // plain checked arithmetic: LEFT takes the whole collateral and RIGHT owes
    // the remaining 2^200 as debt. No sign/magnitude encoding, no transformer gate.
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(actor(signer0, 0), actor(signer1, 1));
    const { tokenId } = await registerFixedErc20(depository, MAX_MONEY);
    const proofNonce = 1n;
    const accountKey = canonicalAccountKey(left.entityId, right.entityId);

    await depository.mintToReserve(left.entityId, tokenId, MAX_MONEY);
    await processBatch(depository, left, emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: left.entityId,
        pairs: [{ entity: right.entityId, amount: MAX_MONEY }],
      }],
    }));
    const funded = await depository._collaterals(accountKey, tokenId);
    expect(funded.collateral).to.equal(MAX_MONEY);
    expect(funded.ondelta).to.equal(MAX_MONEY);

    const proofbody = {
      watchSeed: WATCH_SEED,
      leftResponseSeconds: 2,
      rightResponseSeconds: 3,
      offdeltas: [MAX_MONEY],
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
        proposerIsLeft: false,
        proofbodyHash,
        initialProofbody: proofbody,
        watchSeed: WATCH_SEED,
        sig: innerHanko,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }],
    }));

    await advancePastTimeout(depository, left.entityId, right.entityId);
    await expect(processBatch(depository, left, emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: proofNonce,
        finalNonce: proofNonce,
        proposerIsLeft: false,
        initialProofbodyHash: proofbodyHash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    }))).to.emit(depository, 'DisputeFinalized');

    const collateral = await depository._collaterals(accountKey, tokenId);
    expect(collateral.collateral).to.equal(0n);
    expect(collateral.ondelta).to.equal(0n);
    expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(MAX_MONEY);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
    expect(await depository.debtOutstanding(right.entityId, tokenId)).to.equal(MAX_MONEY);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(0n);
  });

  it('settles an offdelta of exactly -MAX_MONEY and rejects one unit past the bound at dispute start', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(actor(signer0, 0), actor(signer1, 1));
    const { tokenId } = await registerFixedErc20(depository, MAX_MONEY);
    const collateralAmount = 100n;
    const proofNonce = 1n;
    const accountKey = canonicalAccountKey(left.entityId, right.entityId);

    // RIGHT-funded collateral does not change LEFT-oriented ondelta.
    await depository.mintToReserve(right.entityId, tokenId, collateralAmount);
    await processBatch(depository, right, emptyBatch({
      reserveToCollateral: [{
        tokenId,
        receivingEntity: right.entityId,
        pairs: [{ entity: left.entityId, amount: collateralAmount }],
      }],
    }));

    const startWith = async (offdelta: bigint, nonce: bigint) => {
      const proofbody = {
        watchSeed: WATCH_SEED,
        leftResponseSeconds: 2,
        rightResponseSeconds: 3,
        offdeltas: [offdelta],
        tokenIds: [tokenId],
        transformers: [],
      };
      const proofbodyHash = ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
      const innerHash = await disputeProofHash(depository, accountKey, nonce, proofbodyHash);
      const innerHanko = buildSingleSignerHanko(right.entityId, innerHash, right.privateKey);
      const tx = processBatch(depository, left, emptyBatch({
        disputeStarts: [{
          counterentity: right.entityId,
          nonce,
          proposerIsLeft: false,
          proofbodyHash,
          initialProofbody: proofbody,
          watchSeed: WATCH_SEED,
          sig: innerHanko,
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
          starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        }],
      }));
      return { tx, proofbody, proofbodyHash };
    };

    // |offdelta| > MAX_MONEY is rejected E8 by the proof-body validation, before
    // any account state (or the outer entity nonce) moves.
    await expect((await startWith(-(MAX_MONEY + 1n), proofNonce)).tx).to.be.revertedWithCustomError(depository, 'E8');
    await expect((await startWith(MAX_MONEY + 1n, proofNonce)).tx).to.be.revertedWithCustomError(depository, 'E8');
    expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(await depository.entityNonces(left.entityId)).to.equal(0n);

    const { tx, proofbody, proofbodyHash } = await startWith(-MAX_MONEY, proofNonce);
    await tx;
    expect((await depository._accounts(accountKey)).disputeHash).to.not.equal(ethers.ZeroHash);
    await advancePastTimeout(depository, left.entityId, right.entityId);

    await expect(processBatch(depository, left, emptyBatch({
      disputeFinalizations: [{
        counterentity: right.entityId,
        initialNonce: proofNonce,
        finalNonce: proofNonce,
        proposerIsLeft: false,
        initialProofbodyHash: proofbodyHash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    }))).to.emit(depository, 'DisputeFinalized');

    // delta = -2^200: RIGHT takes the 100 collateral and LEFT owes the full 2^200
    // (a negative delta is what LEFT owes beyond the collateral RIGHT receives).
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(collateralAmount);
    expect(await depository.debtOutstanding(left.entityId, tokenId)).to.equal(MAX_MONEY);
    const collateral = await depository._collaterals(accountKey, tokenId);
    expect(collateral.collateral).to.equal(0n);
    expect(collateral.ondelta).to.equal(0n);
  });

  it('finalizes every dispute with exact debt independent of token supply', async function () {
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
      const accountKey = canonicalAccountKey(debtor.entityId, creditor.entityId);
      const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
      const proofbody = {
        watchSeed: WATCH_SEED,
        leftResponseSeconds: 2,
        rightResponseSeconds: 3,
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
        proposerIsLeft: false,
        proofbodyHash: dispute.proofbodyHash,
        initialProofbody: dispute.proofbody,
        watchSeed: WATCH_SEED,
        sig: dispute.innerHanko,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      })),
    }));
    for (const dispute of disputes) {
      await advancePastTimeout(depository, debtor.entityId, dispute.creditor.entityId);
    }

    for (let index = 0; index < disputes.length; index++) {
      const dispute = disputes[index]!;
      const finalization = processBatch(depository, debtor, emptyBatch({
        disputeFinalizations: [{
          counterentity: dispute.creditor.entityId,
          initialNonce: 1n,
          finalNonce: 1n,
          proposerIsLeft: false,
          initialProofbodyHash: dispute.proofbodyHash,
          finalProofbody: dispute.proofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: dispute.debtorIsLeft,
          cooperative: false,
        }],
      }));
      await expect(finalization).to.not.revert(ethers);
    }

    expect(await depository.debtOutstanding(debtor.entityId, tokenId)).to.equal(130n);
    expect(await depository.activeDebts(debtor.entityId)).to.equal(3n);
    expect(await depository.entityNonces(debtor.entityId)).to.equal(4n);
    expect((await depository._debts(debtor.entityId, tokenId, 0)).amount).to.equal(60n);
    expect((await depository._debts(debtor.entityId, tokenId, 1)).amount).to.equal(60n);
    expect((await depository._debts(debtor.entityId, tokenId, 2)).amount).to.equal(10n);
    for (let index = 0; index < disputes.length; index++) {
      expect((await depository._accounts(disputes[index]!.accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    }

    expect(await depository._reserves(reserveHolder.entityId, tokenId)).to.equal(10n);

    const receivingEntity = ethers.zeroPadValue(reserveHolder.signer.address, 32);
    await expect(processBatch(depository, reserveHolder, emptyBatch({
      reserveToExternalToken: [{ receivingEntity, tokenId, amount: 10n }],
    }))).to.not.revert(ethers);
    expect(await depository._reserves(reserveHolder.entityId, tokenId)).to.equal(0n);
    expect(await token.balanceOf(reserveHolder.signer.address)).to.equal(10n);
  });

  it('rejects unsupported fixed supplies at token registration', async function () {
    const { depository } = await loadFixture(deployFixture);
    const tokenFactory = await ethers.getContractFactory('ERC20Mock');
    const zeroSupply = await tokenFactory.deploy('Zero', 'ZERO', 0, 0n);
    const oversizedSupply = await tokenFactory.deploy('Oversized', 'HUGE', 0, INT256_MAX + 1n);
    await Promise.all([zeroSupply.waitForDeployment(), oversizedSupply.waitForDeployment()]);

    await expect(listErc20(depository, await zeroSupply.getAddress()))
      .to.be.revertedWithCustomError(depository, 'E11');
    await expect(listErc20(depository, await oversizedSupply.getAddress()))
      .to.be.revertedWithCustomError(depository, 'E11');
    expect(await depository.getTokensLength()).to.equal(1n);
  });

  it('finalizes an adversarial unknown-token proof as exact internal debt', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const debtor = actor(signer0, 0);
    const creditor = actor(signer1, 1);
    const tokenId = 999n;
    const requested = 5n;
    const accountKey = canonicalAccountKey(debtor.entityId, creditor.entityId);
    const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
    const proofbody = {
      watchSeed: WATCH_SEED,
      leftResponseSeconds: 2,
      rightResponseSeconds: 3,
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
        proposerIsLeft: false,
        proofbodyHash,
        initialProofbody: proofbody,
        watchSeed: WATCH_SEED,
        sig: innerHanko,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }],
    }));
    await advancePastTimeout(depository, debtor.entityId, creditor.entityId);
    await expect(processBatch(depository, debtor, emptyBatch({
      disputeFinalizations: [{
        counterentity: creditor.entityId,
        initialNonce: 1n,
        finalNonce: 1n,
        proposerIsLeft: false,
        initialProofbodyHash: proofbodyHash,
        finalProofbody: proofbody,
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: debtorIsLeft,
        cooperative: false,
      }],
    }))).to.not.revert(ethers);

    expect(await depository.debtOutstanding(debtor.entityId, tokenId)).to.equal(requested);
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
      await listErc20(depository, await token.getAddress());
      const tokenId = (await depository.getTokensLength()) - 1n;

      const accountKey = canonicalAccountKey(debtor.entityId, creditor.entityId);
      const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
      const proofbody = {
        watchSeed: WATCH_SEED,
        leftResponseSeconds: 2,
        rightResponseSeconds: 3,
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
          proposerIsLeft: false,
          proofbodyHash,
          initialProofbody: proofbody,
          watchSeed: WATCH_SEED,
          sig: buildSingleSignerHanko(creditor.entityId, innerHash, creditor.privateKey),
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        }],
      }));
      await advancePastTimeout(depository, debtor.entityId, creditor.entityId);
      await token.setMode(mode);

      await expect(processBatch(depository, debtor, emptyBatch({
        disputeFinalizations: [{
          counterentity: creditor.entityId,
          initialNonce: 1n,
          finalNonce: 1n,
          proposerIsLeft: false,
          initialProofbodyHash: proofbodyHash,
          finalProofbody: proofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: debtorIsLeft,
          cooperative: false,
        }],
      }), 15_000_000n)).to.not.revert(ethers);

      expect(await depository.debtOutstanding(debtor.entityId, tokenId)).to.equal(60n);
      expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    });
  }
});
