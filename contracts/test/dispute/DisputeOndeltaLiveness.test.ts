import { expect } from 'chai';
import hre from 'hardhat';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import type { Depository, EntityProvider } from '../../typechain-types/index.js';
import { decodeInt512, decodeUint512, decodeUint768, encodeInt512 } from '../../../core/protocol/crypto/abi-money.ts';
import {
  accountEpoch,
  buildSingleSignerHanko,
  canonicalAccountKey,
  computeDepositoryBatchHash,
  computeDisputeProofHash,
  deriveHardhatPrivateKey,
  deployDepositoryStack,
  deployEntityProvider,
  emptyBatch,
  encodeForkBatch,
  foundationListExternalToken,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const { ethers, networkHelpers } = await hre.network.getOrCreate('hardhat');
const { loadFixture, mine, time } = networkHelpers;
const abi = ethers.AbiCoder.defaultAbiCoder();
const INT256_MAX = (1n << 255n) - 1n; // token-supply validity bound (Account._tokenSupply)
// Retired policy cap (2^200): the wide-integer rewrite removed it, so 2^200 is now only a large value that must stay exact.
const MAX_MONEY = 1n << 200n;
const UINT256_MAX = (1n << 256n) - 1n;
// Response windows are floored at 60 s (H2); the timeout is the sum of both.
const LEFT_WINDOW = 60;
const RIGHT_WINDOW = 90;
const WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:ondelta-liveness'));
const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,tuple(int256 high,uint256 low)[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

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
  const encoded = encodeForkBatch(batch);
  const nonce = await depository.entityNonces(sender.entityId) + 1n;
  const hash = await computeDepositoryBatchHash(depository, sender.entityId, encoded, nonce);
  const hanko = buildSingleSignerHanko(sender.entityId, hash, sender.privateKey);
  return depository.connect(sender.signer).processBatch(
    sender.entityId,
    encoded,
    hanko,
    nonce,
    gasLimit === undefined ? {} : { gasLimit },
  );
};

// C1: the signed dispute proof binds the Account's ondelta epoch (0 until the first settlement / C2R / finalize).
const disputeProofHash = async (
  depository: Depository,
  accountKey: string,
  nonce: bigint,
  proofbodyHash: string,
  proposerIsLeft = false,
): Promise<string> => {
  const left = ethers.dataSlice(accountKey, 0, 32);
  const right = ethers.dataSlice(accountKey, 32, 64);
  return computeDisputeProofHash(
    depository,
    accountKey,
    await accountEpoch(depository, left, right),
    nonce,
    proposerIsLeft,
    proofbodyHash,
    WATCH_SEED,
  );
};

// Proof-body offdeltas are Int512 {high, low} limbs on the ABI.
const bodyOf = (offdelta: bigint, tokenId: bigint) => ({
  watchSeed: WATCH_SEED,
  leftResponseSeconds: LEFT_WINDOW,
  rightResponseSeconds: RIGHT_WINDOW,
  offdeltas: [encodeInt512(offdelta)],
  tokenIds: [tokenId],
  transformers: [],
});

describe('dispute ondelta liveness', function () {
  it('accepts reserves above the retired 2^200 cap and stops only at the uint256 representation bound', async function () {
    // The wide-integer rewrite removed the 2^200 financial-magnitude cap (E8 no longer guards reserves): a reserve is a
    // plain checked uint256, so 2^200 + 1 is stored exactly and only an overflow of uint256 itself reverts.
    const { depository, signer0 } = await loadFixture(deployFixture);
    const owner = actor(signer0, 0);
    const { tokenId } = await registerFixedErc20(depository, MAX_MONEY);
    const beyondCap = MAX_MONEY + 1n;

    await depository.mintToReserve(owner.entityId, tokenId, beyondCap);
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(beyondCap);

    await depository.mintToReserve(owner.entityId, tokenId, UINT256_MAX - beyondCap);
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(UINT256_MAX);
    await expect(depository.mintToReserve(owner.entityId, tokenId, 1n)).to.be.revertedWithPanic(0x11);
    expect(await depository._reserves(owner.entityId, tokenId)).to.equal(UINT256_MAX);
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
    expect(decodeInt512(funded.ondelta)).to.equal(MAX_MONEY);

    const proofbody = bodyOf(MAX_MONEY, tokenId);
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
    expect(decodeInt512(collateral.ondelta)).to.equal(0n);
    expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    expect(await depository._reserves(left.entityId, tokenId)).to.equal(MAX_MONEY);
    expect(await depository._reserves(right.entityId, tokenId)).to.equal(0n);
    expect(decodeUint768(await depository.debtOutstanding(right.entityId, tokenId))).to.equal(MAX_MONEY);
    expect(decodeUint768(await depository.debtOutstanding(left.entityId, tokenId))).to.equal(0n);
  });

  // The old suite rejected |offdelta| > 2^200 at dispute start (E8) and settled exactly -2^200. The cap is gone with the
  // wide-integer rewrite: proof-body offdeltas are Int512 and the debt is an exact Uint512, so both the old bound and
  // one unit past it start and settle exactly.
  for (const [label, offdelta] of [['-MAX_MONEY', -MAX_MONEY], ['-(MAX_MONEY + 1), one unit past the retired cap', -(MAX_MONEY + 1n)]] as const) {
    it(`settles an offdelta of exactly ${label}`, async function () {
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

      const proofbody = bodyOf(offdelta, tokenId);
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

      // delta = offdelta: RIGHT takes the 100 collateral and LEFT owes the full |offdelta|
      // (a negative delta is what LEFT owes beyond the collateral RIGHT receives).
      expect(await depository._reserves(right.entityId, tokenId)).to.equal(collateralAmount);
      expect(decodeUint768(await depository.debtOutstanding(left.entityId, tokenId))).to.equal(-offdelta);
      const collateral = await depository._collaterals(accountKey, tokenId);
      expect(collateral.collateral).to.equal(0n);
      expect(decodeInt512(collateral.ondelta)).to.equal(0n);
    });
  }

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
      const proofbody = bodyOf(debtorIsLeft ? -requestedDebts[index]! : requestedDebts[index]!, tokenId);
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

    expect(decodeUint768(await depository.debtOutstanding(debtor.entityId, tokenId))).to.equal(130n);
    expect(await depository.activeDebts(debtor.entityId)).to.equal(3n);
    expect(await depository.entityNonces(debtor.entityId)).to.equal(4n);
    expect(decodeUint512((await depository._debts(debtor.entityId, tokenId, 0)).amount)).to.equal(60n);
    expect(decodeUint512((await depository._debts(debtor.entityId, tokenId, 1)).amount)).to.equal(60n);
    expect(decodeUint512((await depository._debts(debtor.entityId, tokenId, 2)).amount)).to.equal(10n);
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

  it('rejects a zero fixed supply at token registration and no longer caps the supply at int256', async function () {
    // Registration only requires a non-zero fixed supply. The int256 upper bound (E11 for supply > 2^255 - 1) went with
    // the wide-integer rewrite: balances, debts and deltas are exact wide values, so a larger supply is representable.
    const { depository } = await loadFixture(deployFixture);
    const tokenFactory = await ethers.getContractFactory('ERC20Mock');
    const zeroSupply = await tokenFactory.deploy('Zero', 'ZERO', 0, 0n);
    const oversizedSupply = await tokenFactory.deploy('Oversized', 'HUGE', 0, INT256_MAX + 1n);
    await Promise.all([zeroSupply.waitForDeployment(), oversizedSupply.waitForDeployment()]);

    await expect(listErc20(depository, await zeroSupply.getAddress()))
      .to.be.revertedWithCustomError(depository, 'E11');
    expect(await depository.getTokensLength()).to.equal(1n);
    await listErc20(depository, await oversizedSupply.getAddress());
    expect(await depository.getTokensLength()).to.equal(2n);
  });

  it('finalizes an adversarial unknown-token proof as exact internal debt', async function () {
    const { depository, signer0, signer1 } = await loadFixture(deployFixture);
    const debtor = actor(signer0, 0);
    const creditor = actor(signer1, 1);
    const tokenId = 999n;
    const requested = 5n;
    const accountKey = canonicalAccountKey(debtor.entityId, creditor.entityId);
    const debtorIsLeft = BigInt(debtor.entityId) < BigInt(creditor.entityId);
    const proofbody = bodyOf(debtorIsLeft ? -requested : requested, tokenId);
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

    expect(decodeUint768(await depository.debtOutstanding(debtor.entityId, tokenId))).to.equal(requested);
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
      const proofbody = bodyOf(debtorIsLeft ? -60n : 60n, tokenId);
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

      expect(decodeUint768(await depository.debtOutstanding(debtor.entityId, tokenId))).to.equal(60n);
      expect((await depository._accounts(accountKey)).disputeHash).to.equal(ethers.ZeroHash);
    });
  }
});
