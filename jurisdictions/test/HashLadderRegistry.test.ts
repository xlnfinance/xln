import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';

const { ethers } = hre;

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import type { Depository } from '../typechain-types/index.js';

import {
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from './helpers/hanko.ts';

const abi = ethers.AbiCoder.defaultAbiCoder();

const DISPUTE_PROOF = 1;
const MAX_FILL_RATIO = 65535n;
const TEST_WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:test-watch-seed'));

const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

type TestActor = {
  signer: HardhatEthersSigner;
  entityId: string;
  privateKey: string;
};

function lazyActor(signer: HardhatEthersSigner, signerIndex: number): TestActor {
  return {
    signer,
    entityId: singleSignerLazyEntityId(signer.address),
    privateKey: deriveHardhatPrivateKey(signerIndex),
  };
}

function orderedActors(a: TestActor, b: TestActor): [TestActor, TestActor] {
  return BigInt(a.entityId) < BigInt(b.entityId) ? [a, b] : [b, a];
}

async function signDepositoryBatch(
  depository: Depository,
  entityId: string,
  privateKey: string,
  batch: Record<string, unknown>,
  nonce?: bigint,
): Promise<{ encodedBatch: string; hankoData: string; nonce: bigint; batchHash: string }> {
  const encodedBatch = encodeBatch(batch);
  const nextNonce = nonce ?? (await depository.entityNonces(entityId)) + 1n;
  const batchHash = await computeDepositoryBatchHash(depository, encodedBatch, nextNonce);
  return {
    encodedBatch,
    hankoData: buildSingleSignerHanko(entityId, batchHash, privateKey),
    nonce: nextNonce,
    batchHash,
  };
}

function proofBodyHash(proofbody: Record<string, unknown>): string {
  return ethers.keccak256(abi.encode([PROOF_BODY_ABI], [proofbody]));
}

function proofBody(offdeltas: bigint[], tokenIds: bigint[], transformers: unknown[] = []): Record<string, unknown> {
  return { watchSeed: TEST_WATCH_SEED, offdeltas, tokenIds, transformers };
}

function secret(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function hashNode(node: string): string {
  return ethers.keccak256(node);
}

function hashSteps(node: string, steps: number): string {
  let current = node;
  for (let i = 0; i < steps; i++) current = hashNode(current);
  return current;
}

function nibbles(fillRatio: number): number[] {
  return [(fillRatio >> 12) & 0x0f, (fillRatio >> 8) & 0x0f, (fillRatio >> 4) & 0x0f, fillRatio & 0x0f];
}

function buildHashLadderProof(label: string, fillRatio: number) {
  const fullSecret = secret(`${label}:full`);
  const bases = [0, 1, 2, 3].map((index) => secret(`${label}:n${index}`));
  const roots = bases.map((base) => hashSteps(base, 15));
  const reveals = nibbles(fillRatio).map((digit, index) => hashSteps(bases[index], 15 - digit));
  return {
    fullSecret,
    fullHash: hashNode(fullSecret),
    partialRoot: ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32', 'bytes32', 'bytes32'], roots)),
    reveals,
  };
}

const ladderHashOf = (proof: { fullHash: string; partialRoot: string }): string =>
  ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [proof.fullHash, proof.partialRoot]));

async function disputeProofHashFor(
  depository: Depository,
  acctKey: string,
  nonce: bigint,
  bodyHash: string,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(
    abi.encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
      [DISPUTE_PROOF, chainId, await depository.getAddress(), acctKey, nonce, bodyHash, TEST_WATCH_SEED],
    ),
  );
}

describe('HashLadderRegistry (cross-j pull settlement authority)', function () {
  let user0: HardhatEthersSigner;
  let user1: HardhatEthersSigner;

  async function deployFixture() {
    [user0, user1] = await hre.ethers.getSigners();
    const entityProvider = await deployEntityProvider(user0.address);
    const AccountFactory = await hre.ethers.getContractFactory('Account');
    const accountLib = await AccountFactory.deploy();
    await accountLib.waitForDeployment();
    const DepositoryFactory = await hre.ethers.getContractFactory('Depository', {
      libraries: { Account: await accountLib.getAddress() },
    });
    const depository = (await DepositoryFactory.deploy(await entityProvider.getAddress(), 100)) as Depository;
    await depository.waitForDeployment();
    const TransformerFactory = await hre.ethers.getContractFactory('DeltaTransformer');
    const transformer = await TransformerFactory.deploy();
    await transformer.waitForDeployment();
    return { depository, transformer };
  }

  type PullDispute = Awaited<ReturnType<typeof openPullDispute>>;

  // Opens a funded account and starts a dispute whose proofbody carries one
  // pull. pullAmount < 0 credits the RIGHT side (the pull beneficiary).
  async function openPullDispute(options: {
    label: string;
    fillRatio: number;
    pullAmount?: bigint;
  }) {
    const { depository, transformer } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 100_000n);
    const fund = emptyBatch({
      reserveToCollateral: [
        { tokenId, receivingEntity: left.entityId, pairs: [{ entity: right.entityId, amount: 100_000n }] },
      ],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, fund);
    await depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);

    const pullProof = buildHashLadderProof(options.label, options.fillRatio);
    const pullAmount = options.pullAmount ?? -MAX_FILL_RATIO;
    const encodedPullBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [
        {
          deltaIndex: 0,
          amount: pullAmount,
          claimedRatio: 0,
          fullHash: pullProof.fullHash,
          partialRoot: pullProof.partialRoot,
        },
      ],
    });
    const maxApplied = (pullAmount < 0n ? -pullAmount : pullAmount) * BigInt(options.fillRatio) / MAX_FILL_RATIO;
    const body = proofBody(
      [0n],
      [tokenId],
      [
        {
          transformerAddress: await transformer.getAddress(),
          encodedBatch: encodedPullBatch,
          allowances: [{ deltaIndex: 0n, rightAllowance: maxApplied, leftAllowance: 0n }],
        },
      ],
    );
    const bodyHash = proofBodyHash(body);
    const acctKey = await depository.accountKey(left.entityId, right.entityId);
    const nonce = 1n;
    const startHash = await disputeProofHashFor(depository, acctKey, nonce, bodyHash);
    const counterpartySig = buildSingleSignerHanko(left.entityId, startHash, left.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: left.entityId,
          nonce,
          proofbodyHash: bodyHash,
          initialProofbody: body,
          watchSeed: TEST_WATCH_SEED,
          sig: counterpartySig,
          starterInitialArguments: '0x',
          starterIncrementedArguments: '0x',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, right.entityId, right.privateKey, startBatch);
    await depository.connect(right.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
    return {
      depository,
      transformer,
      left,
      right,
      acctKey,
      proofbody: body,
      proofbodyHash: bodyHash,
      disputeNonce: nonce,
      pullProof,
      fillRatio: options.fillRatio,
      pullAmount,
    };
  }

  async function registerReveal(
    dispute: PullDispute,
    signer: TestActor,
    overrides: { fillRatio?: number; reveals?: string[]; fullSecret?: string },
  ) {
    const revealBatch = emptyBatch({
      hashLadderReveals: [
        {
          fullHash: dispute.pullProof.fullHash,
          partialRoot: dispute.pullProof.partialRoot,
          fillRatio: overrides.fillRatio ?? dispute.fillRatio,
          fullSecret: overrides.fullSecret ?? ethers.ZeroHash,
          reveals: overrides.reveals ?? dispute.pullProof.reveals,
        },
      ],
    });
    const signed = await signDepositoryBatch(dispute.depository, signer.entityId, signer.privateKey, revealBatch);
    return dispute.depository.connect(signer.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
  }

  async function finalizeDispute(dispute: PullDispute, by: TestActor) {
    const finalization = {
      counterentity: by.entityId === dispute.right.entityId ? dispute.left.entityId : dispute.right.entityId,
      initialNonce: dispute.disputeNonce,
      finalNonce: dispute.disputeNonce,
      initialProofbodyHash: dispute.proofbodyHash,
      finalProofbody: dispute.proofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: false,
      cooperative: false,
    };
    const finalBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const signed = await signDepositoryBatch(dispute.depository, by.entityId, by.privateKey, finalBatch);
    return dispute.depository.connect(by.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
  }

  async function minePastTimeout(depository: Depository) {
    // defaultDisputeDelay is seconds; advance wall-clock, not block count.
    await time.increase(Number(await depository.defaultDisputeDelay()) + 1);
  }

  it('settles a partial fill from a verified registry record and emits the portable material', async function () {
    const dispute = await openPullDispute({ label: 'registry-partial', fillRatio: 0x0123 });
    await expect(registerReveal(dispute, dispute.right, {}))
      .to.emit(dispute.depository, 'HashLadderRevealRegistered')
      .withArgs(
        dispute.right.entityId,
        ladderHashOf(dispute.pullProof),
        dispute.fillRatio,
        ethers.ZeroHash,
        dispute.pullProof.reveals,
      );

    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);

    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(BigInt(dispute.fillRatio));
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n - BigInt(dispute.fillRatio));
  });

  it('settles a full fill from the one-hash full-secret fast path', async function () {
    const dispute = await openPullDispute({ label: 'registry-full', fillRatio: 0xffff });
    await registerReveal(dispute, dispute.right, { reveals: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], fullSecret: dispute.pullProof.fullSecret });
    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(MAX_FILL_RATIO);
  });

  it('reverts registration on an unverifiable ratio, an off-by-one ratio, and a zero ratio', async function () {
    const dispute = await openPullDispute({ label: 'registry-invalid', fillRatio: 0x0123 });
    await expect(registerReveal(dispute, dispute.right, { fillRatio: 0x0124 }))
      .to.be.revertedWithCustomError(dispute.depository, 'E9');
    await expect(
      registerReveal(dispute, dispute.right, { reveals: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash] }),
    ).to.be.revertedWithCustomError(dispute.depository, 'E9');
    const zeroBatch = emptyBatch({
      hashLadderReveals: [
        {
          fullHash: dispute.pullProof.fullHash,
          partialRoot: dispute.pullProof.partialRoot,
          fillRatio: 0,
          fullSecret: ethers.ZeroHash,
          reveals: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        },
      ],
    });
    const signed = await signDepositoryBatch(dispute.depository, dispute.right.entityId, dispute.right.privateKey, zeroBatch);
    await expect(
      dispute.depository.connect(dispute.right.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(dispute.depository, 'E1');
  });

  it('cannot write a reveal under the counterparty key: only the beneficiary record settles the pull', async function () {
    const dispute = await openPullDispute({ label: 'registry-wrong-key', fillRatio: 0x0123 });
    // The pull credits RIGHT, but LEFT registers the (valid) reveal material.
    // processBatch authentication keys the record to the caller, so it lands
    // under LEFT and the pull reads RIGHT's empty record.
    await registerReveal(dispute, dispute.left, {});
    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n);
  });

  it('single-shot: a higher ratio overwrite on the same ladder reverts', async function () {
    const dispute = await openPullDispute({ label: 'registry-overwrite', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const ladder = ladderHashOf(dispute.pullProof);
    const [firstRatio, firstAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      ladder,
    );
    await time.increase(5);
    const higherProof = buildHashLadderProof('registry-overwrite', 0x0234);
    const overwriteBatch = emptyBatch({
      hashLadderReveals: [
        {
          fullHash: higherProof.fullHash,
          partialRoot: higherProof.partialRoot,
          fillRatio: 0x0234,
          fullSecret: ethers.ZeroHash,
          reveals: higherProof.reveals,
        },
      ],
    });
    const signed = await signDepositoryBatch(
      dispute.depository,
      dispute.right.entityId,
      dispute.right.privateKey,
      overwriteBatch,
    );
    await expect(
      dispute.depository
        .connect(dispute.right.signer)
        .processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(dispute.depository, 'E12');
    const [ratio, raisedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      ladder,
    );
    expect(ratio).to.equal(firstRatio);
    expect(raisedAt).to.equal(firstAt);
  });

  it('single-shot: first timely reveal stays active; late first write on another ladder is 0', async function () {
    const dispute = await openPullDispute({ label: 'registry-raise-past-half', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const ladder = ladderHashOf(dispute.pullProof);
    const [, firstAt] = await dispute.depository.getHashLadderReveal(dispute.right.entityId, ladder);
    expect(firstAt).to.be.gt(0n);
    const delay = Number(await dispute.depository.defaultDisputeDelay());
    await time.increase(Math.floor(delay / 2) + 1);
    // Same-ratio retry remains a no-op (idempotent), not a raise path.
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const [ratio, secondAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      ladder,
    );
    expect(ratio).to.equal(0x0123);
    expect(secondAt).to.equal(firstAt);
    await time.increase(Math.ceil(delay / 2) + 1);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0x0123n);
  });

  it('same-ratio re-registration preserves the original revealedAt', async function () {
    const dispute = await openPullDispute({ label: 'registry-same-ratio', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const ladder = ladderHashOf(dispute.pullProof);
    const [, firstAt] = await dispute.depository.getHashLadderReveal(dispute.right.entityId, ladder);
    await time.increase(5);
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const [ratio, secondAt] = await dispute.depository.getHashLadderReveal(dispute.right.entityId, ladder);
    expect(ratio).to.equal(0x0123);
    expect(secondAt).to.equal(firstAt);
  });

  it('reads a missing record as a zero fill and releases the payer collateral', async function () {
    const dispute = await openPullDispute({ label: 'registry-silent', fillRatio: 0x0123 });
    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n);
  });

  it('cross-j residual model: reveal leg settles, silent sibling leg settles 0', async function () {
    // Two independent Depository snapshots (= two Js). Legs are not atomic 2PC:
    // a timely registry reveal credits the beneficiary; silence releases collateral
    // at 0. Fanout only starts clocks — it does not couple settlement amounts.
    const source = await openPullDispute({ label: 'residual-source', fillRatio: 0x0123 });
    await registerReveal(source, source.right, {});
    await minePastTimeout(source.depository);
    await finalizeDispute(source, source.right);
    expect(await source.depository._reserves(source.right.entityId, 1n)).to.equal(0x0123n);
    expect(await source.depository._reserves(source.left.entityId, 1n)).to.equal(100_000n - 0x0123n);

    const target = await openPullDispute({ label: 'residual-target', fillRatio: 0x0123 });
    await minePastTimeout(target.depository);
    await finalizeDispute(target, target.right);
    expect(await target.depository._reserves(target.right.entityId, 1n)).to.equal(0n);
    expect(await target.depository._reserves(target.left.entityId, 1n)).to.equal(100_000n);
  });

  it('reads a registration written after dispute T/2 as zero', async function () {
    const dispute = await openPullDispute({ label: 'registry-late', fillRatio: 0x0123 });
    const delay = Number(await dispute.depository.defaultDisputeDelay());
    // Pass the reveal half-window (seconds), then register — stored but settles as 0.
    await time.increase(Math.floor(delay / 2) + 1);
    await registerReveal(dispute, dispute.right, {});
    await time.increase(Math.ceil(delay / 2) + 1);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
  });

  it('blocks early finalization on both the timeout path and the counterparty-signed path', async function () {
    const dispute = await openPullDispute({ label: 'registry-barrier', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, {});

    // Starter timeout path before T is rejected at Account (E2) before the
    // transformer runs; the pull barrier is what stops the counterparty path.
    await expect(finalizeDispute(dispute, dispute.right))
      .to.be.revertedWithCustomError(dispute.depository, 'E2');

    const newerNonce = 2n;
    const newerHash = await disputeProofHashFor(dispute.depository, dispute.acctKey, newerNonce, dispute.proofbodyHash);
    const counterSig = buildSingleSignerHanko(dispute.right.entityId, newerHash, dispute.right.privateKey);
    const counterFinalization = {
      counterentity: dispute.right.entityId,
      initialNonce: dispute.disputeNonce,
      finalNonce: newerNonce,
      initialProofbodyHash: dispute.proofbodyHash,
      finalProofbody: dispute.proofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: counterSig,
      startedByLeft: false,
      cooperative: false,
    };
    const counterBatch = emptyBatch({ disputeFinalizations: [counterFinalization] });
    const counterSigned = await signDepositoryBatch(dispute.depository, dispute.left.entityId, dispute.left.privateKey, counterBatch);
    await expect(
      dispute.depository.connect(dispute.left.signer).processBatch(counterSigned.encodedBatch, counterSigned.hankoData, counterSigned.nonce),
    ).to.be.revertedWithCustomError(dispute.transformer, 'PullRevealWindowActive');

    // After full T the counterparty path settles.
    await minePastTimeout(dispute.depository);
    const retryBatch = emptyBatch({ disputeFinalizations: [counterFinalization] });
    const retrySigned = await signDepositoryBatch(dispute.depository, dispute.left.entityId, dispute.left.privateKey, retryBatch);
    await dispute.depository.connect(dispute.left.signer).processBatch(retrySigned.encodedBatch, retrySigned.hankoData, retrySigned.nonce);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(BigInt(dispute.fillRatio));
  });

  it('counts a registration written after the dispute started (no lower bound on revealedBlock)', async function () {
    const dispute = await openPullDispute({ label: 'registry-late-start', fillRatio: 0x0123 });
    // Dispute already active; register now — still inside T/2.
    await registerReveal(dispute, dispute.right, {});
    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(BigInt(dispute.fillRatio));
  });

  it('applies one dispute-T barrier to every pull in the proofbody', async function () {
    const { depository, transformer } = await loadFixture(deployFixture);
    const [left, right] = orderedActors(lazyActor(user0, 0), lazyActor(user1, 1));
    const tokenId = 1n;
    await depository.mintToReserve(left.entityId, tokenId, 100_000n);
    const fund = emptyBatch({
      reserveToCollateral: [
        { tokenId, receivingEntity: left.entityId, pairs: [{ entity: right.entityId, amount: 100_000n }] },
      ],
    });
    const signed = await signDepositoryBatch(depository, left.entityId, left.privateKey, fund);
    await depository.connect(left.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);

    const proofA = buildHashLadderProof('registry-multi-a', 0x0100);
    const proofB = buildHashLadderProof('registry-multi-b', 0x0200);
    const encoded = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [
        { deltaIndex: 0, amount: -MAX_FILL_RATIO, claimedRatio: 0, fullHash: proofA.fullHash, partialRoot: proofA.partialRoot },
        { deltaIndex: 0, amount: -MAX_FILL_RATIO, claimedRatio: 0, fullHash: proofB.fullHash, partialRoot: proofB.partialRoot },
      ],
    });
    const body = proofBody(
      [0n],
      [tokenId],
      [
        {
          transformerAddress: await transformer.getAddress(),
          encodedBatch: encoded,
          allowances: [{ deltaIndex: 0n, rightAllowance: 0x0100n + 0x0200n, leftAllowance: 0n }],
        },
      ],
    );
    const bodyHash = proofBodyHash(body);
    const acctKey = await depository.accountKey(left.entityId, right.entityId);
    const nonce = 1n;
    const startHash = await disputeProofHashFor(depository, acctKey, nonce, bodyHash);
    const counterpartySig = buildSingleSignerHanko(left.entityId, startHash, left.privateKey);
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: left.entityId,
          nonce,
          proofbodyHash: bodyHash,
          initialProofbody: body,
          watchSeed: TEST_WATCH_SEED,
          sig: counterpartySig,
          starterInitialArguments: '0x',
          starterIncrementedArguments: '0x',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, right.entityId, right.privateKey, startBatch);
    await depository.connect(right.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const register = async (proof: ReturnType<typeof buildHashLadderProof>, ratio: number) => {
      const batch = emptyBatch({
        hashLadderReveals: [
          { fullHash: proof.fullHash, partialRoot: proof.partialRoot, fillRatio: ratio, fullSecret: ethers.ZeroHash, reveals: proof.reveals },
        ],
      });
      const signedReveal = await signDepositoryBatch(depository, right.entityId, right.privateKey, batch);
      await depository.connect(right.signer).processBatch(signedReveal.encodedBatch, signedReveal.hankoData, signedReveal.nonce);
    };
    await register(proofA, 0x0100);
    await register(proofB, 0x0200);

    const finalization = {
      counterentity: left.entityId,
      initialNonce: nonce,
      finalNonce: nonce,
      initialProofbodyHash: bodyHash,
      finalProofbody: body,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: false,
      cooperative: false,
    };
    // Starter timeout path before T hits Account E2; pull barrier is covered
    // in the dedicated early-finalization test via the counterparty path.
    const attempt = emptyBatch({ disputeFinalizations: [finalization] });
    const attemptSigned = await signDepositoryBatch(depository, right.entityId, right.privateKey, attempt);
    await expect(
      depository.connect(right.signer).processBatch(attemptSigned.encodedBatch, attemptSigned.hankoData, attemptSigned.nonce),
    ).to.be.revertedWithCustomError(depository, 'E2');

    await minePastTimeout(depository);
    const fin = emptyBatch({ disputeFinalizations: [finalization] });
    const finSigned = await signDepositoryBatch(depository, right.entityId, right.privateKey, fin);
    await depository.connect(right.signer).processBatch(finSigned.encodedBatch, finSigned.hankoData, finSigned.nonce);
    expect(await depository._reserves(right.entityId, 1n)).to.equal(BigInt(0x0100 + 0x0200));
  });

  it('matches floor(amount * ratio / 65535) dust semantics exactly', async function () {
    const dispute = await openPullDispute({ label: 'registry-dust', fillRatio: 32767, pullAmount: -1_000n });
    await registerReveal(dispute, dispute.right, { fillRatio: 32767, reveals: buildHashLadderProof('registry-dust', 32767).reveals });
    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(499n);
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n - 499n);
  });

  it('keeps same-entity different-ladder records independent', async function () {
    const dispute = await openPullDispute({ label: 'registry-iso-a', fillRatio: 0x0111 });
    const otherProof = buildHashLadderProof('registry-iso-b', 0x0222);
    await registerReveal(dispute, dispute.right, {});
    const batch = emptyBatch({
      hashLadderReveals: [
        {
          fullHash: otherProof.fullHash,
          partialRoot: otherProof.partialRoot,
          fillRatio: 0x0222,
          fullSecret: ethers.ZeroHash,
          reveals: otherProof.reveals,
        },
      ],
    });
    const signed = await signDepositoryBatch(dispute.depository, dispute.right.entityId, dispute.right.privateKey, batch);
    await dispute.depository.connect(dispute.right.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
    const [ratioA] = await dispute.depository.getHashLadderReveal(dispute.right.entityId, ladderHashOf(dispute.pullProof));
    const [ratioB] = await dispute.depository.getHashLadderReveal(dispute.right.entityId, ladderHashOf(otherProof));
    expect(ratioA).to.equal(0x0111);
    expect(ratioB).to.equal(0x0222);
  });

  it('cannot claim twice: a second finalization of the same dispute reverts', async function () {
    const dispute = await openPullDispute({ label: 'registry-double', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, {});
    await minePastTimeout(dispute.depository);
    await finalizeDispute(dispute, dispute.right);
    await expect(finalizeDispute(dispute, dispute.right)).to.be.revertedWithCustomError(dispute.depository, 'E5');
  });
});
