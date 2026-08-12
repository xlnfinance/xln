import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';

const { ethers } = hre;

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers.js';
import type { Depository } from '../../typechain-types/index.js';

import {
  buildSingleSignerHanko,
  computeDepositoryBatchHash,
  deployEntityProvider,
  deriveHardhatPrivateKey,
  emptyBatch,
  encodeBatch,
  singleSignerLazyEntityId,
} from '../helpers/hanko.ts';

const abi = ethers.AbiCoder.defaultAbiCoder();

const DISPUTE_PROOF = 1;
const MAX_FILL_RATIO = 65535n;
const TEST_WATCH_SEED = ethers.keccak256(ethers.toUtf8Bytes('xln:test-watch-seed'));

const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

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
  return {
    watchSeed: TEST_WATCH_SEED,
    leftResponseSeconds: 50,
    rightResponseSeconds: 50,
    offdeltas,
    tokenIds,
    transformers,
  };
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
  proposerIsLeft = false,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return ethers.keccak256(
    abi.encode(
      ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
      [DISPUTE_PROOF, chainId, await depository.getAddress(), acctKey, nonce, proposerIsLeft, bodyHash, TEST_WATCH_SEED],
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
    const BoundsFactory = await hre.ethers.getContractFactory('DepositoryBounds');
    const boundsLib = await BoundsFactory.deploy();
    await boundsLib.waitForDeployment();
    const RegistryFactory = await hre.ethers.getContractFactory('HashLadderRegistry');
    const registryLib = await RegistryFactory.deploy();
    await registryLib.waitForDeployment();
    const TransformerFactory = await hre.ethers.getContractFactory('DeltaTransformer');
    const transformer = await TransformerFactory.deploy();
    await transformer.waitForDeployment();
    const DepositoryFactory = await hre.ethers.getContractFactory('Depository', {
      libraries: {
        Account: await accountLib.getAddress(),
        DepositoryBounds: await boundsLib.getAddress(),
        HashLadderRegistry: await registryLib.getAddress(),
      },
    });
    const depository = (await DepositoryFactory.deploy(
      await entityProvider.getAddress(),
      await transformer.getAddress(),
    )) as Depository;
    await depository.waitForDeployment();
    return { depository, transformer };
  }

  type PullDispute = Awaited<ReturnType<typeof openPullDispute>>;

  // Opens a funded account and starts a dispute whose proofbody carries one
  // pull. pullAmount < 0 credits the RIGHT side (the pull beneficiary).
  async function openPullDispute(options: {
    label: string;
    fillRatio: number;
    pullAmount?: bigint;
    /** Target role: opens at its own dispute start; beneficiary window counts. */
    targetRole?: boolean;
    /** Register Target in the exact processBatch/block that opens the dispute. */
    registerWithStart?: boolean;
    starter?: 'left' | 'right';
    proposerIsLeft?: boolean;
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
          targetRole: options.targetRole === true,
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
    const starter = options.starter === 'left' ? left : right;
    const counterparty = starter === left ? right : left;
    const proposerIsLeft = options.proposerIsLeft ?? (starter === left);
    const startHash = await disputeProofHashFor(
      depository,
      acctKey,
      nonce,
      bodyHash,
      proposerIsLeft,
    );
    const counterpartySig = buildSingleSignerHanko(
      counterparty.entityId,
      startHash,
      counterparty.privateKey,
    );
    const startBatch = emptyBatch({
      disputeStarts: [
        {
          counterentity: counterparty.entityId,
          nonce,
          proposerIsLeft,
          proofbodyHash: bodyHash,
          initialProofbody: body,
          watchSeed: TEST_WATCH_SEED,
          sig: counterpartySig,
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
      ...(options.registerWithStart ? {
        hashLadderRegistrations: [{
          counterpartyEntity: counterparty.entityId,
          targetRole: options.targetRole === true,
          fullHash: pullProof.fullHash,
          partialRoot: pullProof.partialRoot,
          witness: {
            fillRatio: options.fillRatio,
            fullSecret: options.fillRatio === 0xffff ? pullProof.fullSecret : ethers.ZeroHash,
            reveals: options.fillRatio === 0xffff
              ? [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash]
              : pullProof.reveals,
          },
        }],
      } : {}),
    });
    const start = await signDepositoryBatch(
      depository,
      starter.entityId,
      starter.privateKey,
      startBatch,
    );
    await depository.connect(starter.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);
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
      targetRole: options.targetRole === true,
      startedByLeft: starter === left,
      initialProposerIsLeft: proposerIsLeft,
    };
  }

  async function registerReveal(
    dispute: PullDispute,
    signer: TestActor,
    overrides: {
      counterpartyEntity?: string;
      fillRatio?: number;
      reveals?: string[];
      fullSecret?: string;
    },
  ) {
    const revealBatch = emptyBatch({
      hashLadderRegistrations: [
        {
          counterpartyEntity: overrides.counterpartyEntity ?? (
            signer.entityId === dispute.left.entityId
              ? dispute.right.entityId
              : dispute.left.entityId
          ),
          targetRole: dispute.targetRole,
          fullHash: dispute.pullProof.fullHash,
          partialRoot: dispute.pullProof.partialRoot,
          witness: {
            fillRatio: overrides.fillRatio ?? dispute.fillRatio,
            fullSecret: overrides.fullSecret ?? ethers.ZeroHash,
            reveals: overrides.reveals ?? dispute.pullProof.reveals,
          },
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
      proposerIsLeft: dispute.initialProposerIsLeft,
      initialProofbodyHash: dispute.proofbodyHash,
      finalProofbody: dispute.proofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: dispute.startedByLeft,
      cooperative: false,
    };
    const finalBatch = emptyBatch({ disputeFinalizations: [finalization] });
    const signed = await signDepositoryBatch(dispute.depository, by.entityId, by.privateKey, finalBatch);
    return dispute.depository.connect(by.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
  }

  async function minePastTimeout(depository: Depository, acctKey: string) {
    const account = await depository._accounts(acctKey);
    await time.increaseTo(Number(account.disputeTimeout) + 1);
  }

  it('settles a partial fill from a verified registry record and emits the portable material', async function () {
    const dispute = await openPullDispute({ label: 'registry-partial', fillRatio: 0x0123 });
    await expect(registerReveal(dispute, dispute.right, {}))
      .to.emit(dispute.depository, 'HashLadderRevealRegistered');

    await minePastTimeout(dispute.depository, dispute.acctKey);
    await finalizeDispute(dispute, dispute.right);

    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(BigInt(dispute.fillRatio));
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n - BigInt(dispute.fillRatio));
  });

  it('settles a full fill from the one-hash full-secret fast path', async function () {
    const dispute = await openPullDispute({ label: 'registry-full', fillRatio: 0xffff });
    await registerReveal(dispute, dispute.right, { reveals: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], fullSecret: dispute.pullProof.fullSecret });
    await minePastTimeout(dispute.depository, dispute.acctKey);
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
    const zeroBatch = emptyBatch({ hashLadderRegistrations: [{
      counterpartyEntity: dispute.left.entityId,
      targetRole: false,
      fullHash: dispute.pullProof.fullHash,
      partialRoot: dispute.pullProof.partialRoot,
      witness: {
        fillRatio: 0,
        fullSecret: ethers.ZeroHash,
        reveals: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      },
    }] });
    const signed = await signDepositoryBatch(dispute.depository, dispute.right.entityId, dispute.right.privateKey, zeroBatch);
    await expect(
      dispute.depository.connect(dispute.right.signer).processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(dispute.depository, 'E1');
  });

  it('authenticates only the batch writer; routing metadata cannot write another entity record', async function () {
    const dispute = await openPullDispute({ label: 'registry-wrong-key', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.left, {});
    const ladder = ladderHashOf(dispute.pullProof);
    expect((await dispute.depository.getHashLadderReveal(
      dispute.left.entityId, dispute.right.entityId, ladder, false,
    ))[0]).to.equal(0x0123n);
    expect((await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, false,
    ))[0]).to.equal(0n);
    await minePastTimeout(dispute.depository, dispute.acctKey);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
  });

  it('rejects a first Source write for a declared pair without an active dispute', async function () {
    const dispute = await openPullDispute({ label: 'registry-account-scope', fillRatio: 0x0123 });
    const falseCounterparty = ethers.zeroPadValue('0xbeef', 32);
    await expect(registerReveal(dispute, dispute.right, { counterpartyEntity: falseCounterparty }))
      .to.be.revertedWithCustomError(dispute.depository, 'E12');

    const ladder = ladderHashOf(dispute.pullProof);
    expect((await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, false,
    ))[0]).to.equal(0n);
    expect((await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, falseCounterparty, ladder, false,
    ))[0]).to.equal(0n);

    await minePastTimeout(dispute.depository, dispute.acctKey);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
  });

  it('single-shot: a higher ratio overwrite on the same ladder reverts', async function () {
    const dispute = await openPullDispute({ label: 'registry-overwrite', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const ladder = ladderHashOf(dispute.pullProof);
    const [firstRatio, firstAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladder,
      false,
    );
    await time.increase(5);
    const higherProof = buildHashLadderProof('registry-overwrite', 0x0234);
    await expect(registerReveal(dispute, dispute.right, {
      fillRatio: 0x0234,
      reveals: higherProof.reveals,
    })).to.be.revertedWithCustomError(dispute.depository, 'E12');
    const [ratio, raisedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladder,
      false,
    );
    expect(ratio).to.equal(firstRatio);
    expect(raisedAt).to.equal(firstAt);
  });

  it('target: a higher ratio replaces even after timeout and the late timestamp settles zero', async function () {
    const dispute = await openPullDispute({
      label: 'registry-target-overwrite',
      fillRatio: 0x0123,
      targetRole: true,
    });
    await registerReveal(dispute, dispute.right, {});
    await minePastTimeout(dispute.depository, dispute.acctKey);

    const higherProof = buildHashLadderProof('registry-target-overwrite', 0x0234);
    await registerReveal(dispute, dispute.right, {
      fillRatio: 0x0234,
      reveals: higherProof.reveals,
    });
    const ladder = ladderHashOf(dispute.pullProof);
    const [ratio, revealedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, true,
    );
    const account = await dispute.depository._accounts(dispute.acctKey);
    expect(ratio).to.equal(0x0234);
    expect(revealedAt).to.be.gt(account.disputeTimeout);

    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n);
  });

  it('source exact retry preserves its timely record after the response window', async function () {
    const dispute = await openPullDispute({ label: 'registry-source-sticky', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const ladder = ladderHashOf(dispute.pullProof);
    const [, firstAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, false,
    );
    expect(firstAt).to.be.gt(0n);
    await minePastTimeout(dispute.depository, dispute.acctKey);
    // Same-ratio retry remains a no-op (idempotent), not a raise path.
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const [ratio, secondAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladder,
      false,
    );
    expect(ratio).to.equal(0x0123);
    expect(secondAt).to.equal(firstAt);
    await time.increase(51);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0x0123n);
  });

  it('target same-ratio re-registration refreshes revealedAt', async function () {
    const dispute = await openPullDispute({ label: 'registry-same-ratio', fillRatio: 0x0123, targetRole: true });
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const ladder = ladderHashOf(dispute.pullProof);
    const [, firstAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, true,
    );
    await time.increase(5);
    await registerReveal(dispute, dispute.right, { fillRatio: 0x0123 });
    const [ratio, secondAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, true,
    );
    expect(ratio).to.equal(0x0123);
    expect(secondAt).to.be.gt(firstAt);
  });

  it('reads a missing record as a zero fill and releases the payer collateral', async function () {
    const dispute = await openPullDispute({ label: 'registry-silent', fillRatio: 0x0123 });
    await minePastTimeout(dispute.depository, dispute.acctKey);
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
    await minePastTimeout(source.depository, source.acctKey);
    await finalizeDispute(source, source.right);
    expect(await source.depository._reserves(source.right.entityId, 1n)).to.equal(0x0123n);
    expect(await source.depository._reserves(source.left.entityId, 1n)).to.equal(100_000n - 0x0123n);

    const target = await openPullDispute({ label: 'residual-target', fillRatio: 0x0123 });
    await minePastTimeout(target.depository, target.acctKey);
    await finalizeDispute(target, target.right);
    expect(await target.depository._reserves(target.right.entityId, 1n)).to.equal(0n);
    expect(await target.depository._reserves(target.left.entityId, 1n)).to.equal(100_000n);
  });

  it('rejects a late first Source registration without consuming its immutable slot', async function () {
    const dispute = await openPullDispute({ label: 'registry-late', fillRatio: 0x0123 });
    // Right is the Pull beneficiary, so its signed 50-second side window is the
    // Source deadline. A late first write must not poison the single-shot slot.
    await time.increase(51);
    await expect(registerReveal(dispute, dispute.right, {}))
      .to.be.revertedWithCustomError(dispute.depository, 'E12');
    const [ratio, revealedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladderHashOf(dispute.pullProof),
      false,
    );
    expect(ratio).to.equal(0n);
    expect(revealedAt).to.equal(0n);
    await time.increase(51);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(0n);
  });

  it('accepts a first Source registration at the inclusive owner deadline', async function () {
    const dispute = await openPullDispute({ label: 'registry-source-deadline', fillRatio: 0x0123 });
    const account = await dispute.depository._accounts(dispute.acctKey);
    await time.setNextBlockTimestamp(Number(account.disputeStartTimestamp) + 50);
    await expect(registerReveal(dispute, dispute.right, {}))
      .to.emit(dispute.depository, 'HashLadderRevealRegistered');
    const [, revealedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladderHashOf(dispute.pullProof),
      false,
    );
    expect(revealedAt).to.equal(account.disputeStartTimestamp + 50n);
  });

  it('accepts Source registration in the exact batch and block that starts its dispute', async function () {
    const dispute = await openPullDispute({
      label: 'registry-source-same-block',
      fillRatio: 0x0123,
      registerWithStart: true,
    });
    const account = await dispute.depository._accounts(dispute.acctKey);
    const [ratio, revealedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladderHashOf(dispute.pullProof),
      false,
    );
    expect(ratio).to.equal(0x0123n);
    expect(revealedAt).to.equal(account.disputeStartTimestamp);
  });

  it('settles a target registration immediately after its dispute starts', async function () {
    const dispute = await openPullDispute({
      label: 'registry-target-after-source-window',
      fillRatio: 0x0123,
      targetRole: true,
    });
    // Target opens immediately with its own dispute; it does not wait for a
    // synthetic second phase on this Account.
    await registerReveal(dispute, dispute.right, {});
    const ladder = ladderHashOf(dispute.pullProof);
    expect((await dispute.depository.getHashLadderReveal(
      dispute.right.entityId, dispute.left.entityId, ladder, true,
    ))[0]).to.equal(BigInt(dispute.fillRatio));
    await minePastTimeout(dispute.depository, dispute.acctKey);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(BigInt(dispute.fillRatio));
  });

  it('accepts target registration in the exact batch and block that starts its dispute', async function () {
    const dispute = await openPullDispute({
      label: 'registry-target-same-block',
      fillRatio: 0x0123,
      targetRole: true,
      registerWithStart: true,
    });
    const account = await dispute.depository._accounts(dispute.acctKey);
    const [ratio, revealedAt] = await dispute.depository.getHashLadderReveal(
      dispute.right.entityId,
      dispute.left.entityId,
      ladderHashOf(dispute.pullProof),
      true,
    );
    expect(ratio).to.equal(0x0123n);
    expect(revealedAt).to.equal(account.disputeStartTimestamp);
  });

  it('blocks early finalization on both the timeout path and the counterparty-signed path', async function () {
    const dispute = await openPullDispute({ label: 'registry-barrier', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, {});

    // Starter timeout path before T is rejected at Account (E2) before the
    // transformer runs; the pull barrier is what stops the counterparty path.
    await expect(finalizeDispute(dispute, dispute.right))
      .to.be.revertedWithCustomError(dispute.depository, 'E2');

    const newerNonce = 2n;
    const newerHash = await disputeProofHashFor(
      dispute.depository,
      dispute.acctKey,
      newerNonce,
      dispute.proofbodyHash,
      true,
    );
    const counterSig = buildSingleSignerHanko(dispute.right.entityId, newerHash, dispute.right.privateKey);
    const counterFinalization = {
      counterentity: dispute.right.entityId,
      initialNonce: dispute.disputeNonce,
      finalNonce: newerNonce,
      proposerIsLeft: true,
      initialProofbodyHash: dispute.proofbodyHash,
      finalProofbody: dispute.proofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: counterSig,
      startedByLeft: false,
      cooperative: false,
    };
    const counterLock = {
      counterentity: dispute.right.entityId,
      initialNonce: dispute.disputeNonce,
      initialProofbodyHash: dispute.proofbodyHash,
      counterNonce: newerNonce,
      proposerIsLeft: true,
      counterProofbody: dispute.proofbody,
      sig: counterSig,
    };
    const counterBatch = emptyBatch({ counterDisputes: [counterLock] });
    const counterSigned = await signDepositoryBatch(dispute.depository, dispute.left.entityId, dispute.left.privateKey, counterBatch);
    await expect(
      dispute.depository.connect(dispute.left.signer).processBatch(counterSigned.encodedBatch, counterSigned.hankoData, counterSigned.nonce),
    ).to.emit(dispute.depository, 'CounterDisputeRegistered');

    // The lock selects N+1 but cannot execute Pull settlement before T.
    const earlySelectedBatch = emptyBatch({ disputeFinalizations: [counterFinalization] });
    const earlySelected = await signDepositoryBatch(
      dispute.depository, dispute.left.entityId, dispute.left.privateKey, earlySelectedBatch,
    );
    await expect(
      dispute.depository.connect(dispute.left.signer).processBatch(
        earlySelected.encodedBatch, earlySelected.hankoData, earlySelected.nonce,
      ),
    ).to.be.revertedWithCustomError(dispute.depository, 'E2');

    // After full T the selected counter-proof settles; the starter can no
    // longer race the obsolete initial body.
    await minePastTimeout(dispute.depository, dispute.acctKey);
    await expect(finalizeDispute(dispute, dispute.right))
      .to.be.revertedWithCustomError(dispute.depository, 'E2');
    // Registration already authenticated the selected branch. If the
    // non-starter disappears, the starter must still be able to execute that
    // exact stored identity at T without possessing another inner signature.
    const starterSelectedFinalization = {
      ...counterFinalization,
      counterentity: dispute.left.entityId,
      sig: '0x',
    };
    const retryBatch = emptyBatch({ disputeFinalizations: [starterSelectedFinalization] });
    const starterRetrySigned = await signDepositoryBatch(
      dispute.depository,
      dispute.right.entityId,
      dispute.right.privateKey,
      retryBatch,
    );
    await dispute.depository.connect(dispute.right.signer).processBatch(
      starterRetrySigned.encodedBatch,
      starterRetrySigned.hankoData,
      starterRetrySigned.nonce,
    );
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(BigInt(dispute.fillRatio));
  });

  it('orders mutually signed same-nonce branches by LEFT proposer', async function () {
    const dispute = await openPullDispute({
      label: 'same-nonce-left-wins', fillRatio: 0x2222, starter: 'right', proposerIsLeft: false,
    });
    const leftBody = { ...dispute.proofbody, offdeltas: [1n] };
    const leftHash = proofBodyHash(leftBody);
    const leftDigest = await disputeProofHashFor(
      dispute.depository, dispute.acctKey, dispute.disputeNonce, leftHash, true,
    );
    const leftSig = buildSingleSignerHanko(
      dispute.right.entityId, leftDigest, dispute.right.privateKey,
    );
    const leftCounter = {
      counterentity: dispute.right.entityId,
      initialNonce: dispute.disputeNonce,
      initialProofbodyHash: dispute.proofbodyHash,
      counterNonce: dispute.disputeNonce,
      proposerIsLeft: true,
      counterProofbody: leftBody,
      sig: leftSig,
    };
    const submit = async (counterProof = leftCounter) => {
      const signed = await signDepositoryBatch(
        dispute.depository,
        dispute.left.entityId,
        dispute.left.privateKey,
        emptyBatch({ counterDisputes: [counterProof] }),
      );
      return dispute.depository.connect(dispute.left.signer)
        .processBatch(signed.encodedBatch, signed.hankoData, signed.nonce);
    };
    await expect(submit())
      .to.emit(dispute.depository, 'CounterDisputeRegistered')
      .withArgs(
        dispute.left.entityId,
        dispute.right.entityId,
        dispute.disputeNonce,
        true,
        leftHash,
      );
    const selected = await dispute.depository._accounts(dispute.acctKey);
    expect(selected.disputeCounterNonce).to.equal(dispute.disputeNonce);
    expect(selected.disputeCounterProofbodyHash).to.equal(leftHash);
    expect(selected.disputeCounterProposerIsLeft).to.equal(true);

    await expect(submit()).to.not.emit(dispute.depository, 'CounterDisputeRegistered');
    const conflictingBody = { ...leftBody, offdeltas: [2n] };
    const conflictingHash = proofBodyHash(conflictingBody);
    const conflictingDigest = await disputeProofHashFor(
      dispute.depository, dispute.acctKey, dispute.disputeNonce, conflictingHash, true,
    );
    const conflictingSig = buildSingleSignerHanko(
      dispute.right.entityId, conflictingDigest, dispute.right.privateKey,
    );
    const accountErrorAbi = await ethers.getContractAt(
      'Account', await dispute.depository.getAddress(),
    );
    await expect(submit({
      ...leftCounter,
      counterProofbody: conflictingBody,
      sig: conflictingSig,
    })).to.be.revertedWithCustomError(accountErrorAbi, 'E9');
  });

  it('rejects a RIGHT same-nonce branch when the initial proposer was LEFT', async function () {
    const dispute = await openPullDispute({
      label: 'same-nonce-right-loses', fillRatio: 0x1111, starter: 'left', proposerIsLeft: true,
    });
    const rightBody = { ...dispute.proofbody, offdeltas: [1n] };
    const rightHash = proofBodyHash(rightBody);
    const rightDigest = await disputeProofHashFor(
      dispute.depository, dispute.acctKey, dispute.disputeNonce, rightHash, false,
    );
    const rightSig = buildSingleSignerHanko(
      dispute.left.entityId, rightDigest, dispute.left.privateKey,
    );
    const signed = await signDepositoryBatch(
      dispute.depository,
      dispute.right.entityId,
      dispute.right.privateKey,
      emptyBatch({ counterDisputes: [{
        counterentity: dispute.left.entityId,
        initialNonce: dispute.disputeNonce,
        initialProofbodyHash: dispute.proofbodyHash,
        counterNonce: dispute.disputeNonce,
        proposerIsLeft: false,
        counterProofbody: rightBody,
        sig: rightSig,
      }] }),
    );
    const accountErrorAbi = await ethers.getContractAt(
      'Account', await dispute.depository.getAddress(),
    );
    await expect(
      dispute.depository.connect(dispute.right.signer)
        .processBatch(signed.encodedBatch, signed.hankoData, signed.nonce),
    ).to.be.revertedWithCustomError(accountErrorAbi, 'E2');
  });

  it('counts a registration written inside this dispute window', async function () {
    const dispute = await openPullDispute({ label: 'registry-late-start', fillRatio: 0x0123 });
    // The lower bound is this exact dispute start; registration after the
    // start and before the role deadline is valid.
    await registerReveal(dispute, dispute.right, {});
    await minePastTimeout(dispute.depository, dispute.acctKey);
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
        { deltaIndex: 0, amount: -MAX_FILL_RATIO, claimedRatio: 0, fullHash: proofA.fullHash, partialRoot: proofA.partialRoot, targetRole: false },
        { deltaIndex: 0, amount: -MAX_FILL_RATIO, claimedRatio: 0, fullHash: proofB.fullHash, partialRoot: proofB.partialRoot, targetRole: false },
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
          proposerIsLeft: false,
          proofbodyHash: bodyHash,
          initialProofbody: body,
          watchSeed: TEST_WATCH_SEED,
          sig: counterpartySig,
          starterInitialArguments: '0x',
          starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });
    const start = await signDepositoryBatch(depository, right.entityId, right.privateKey, startBatch);
    await depository.connect(right.signer).processBatch(start.encodedBatch, start.hankoData, start.nonce);

    const register = async (
      proof: ReturnType<typeof buildHashLadderProof>,
      ratio: number,
    ) => {
      const batch = emptyBatch({
        hashLadderRegistrations: [{
          counterpartyEntity: left.entityId,
          targetRole: false,
          fullHash: proof.fullHash,
          partialRoot: proof.partialRoot,
          witness: {
            fillRatio: ratio,
            fullSecret: ethers.ZeroHash,
            reveals: proof.reveals,
          },
        }],
      });
      const signedReveal = await signDepositoryBatch(depository, right.entityId, right.privateKey, batch);
      await depository.connect(right.signer).processBatch(signedReveal.encodedBatch, signedReveal.hankoData, signedReveal.nonce);
    };
    await register(proofA, 0x0100);
    await register(proofB, 0x0200);
    const [ratioA] = await depository.getHashLadderReveal(
      right.entityId, left.entityId, ladderHashOf(proofA), false,
    );
    const [ratioB] = await depository.getHashLadderReveal(
      right.entityId, left.entityId, ladderHashOf(proofB), false,
    );
    expect(ratioA).to.equal(0x0100);
    expect(ratioB).to.equal(0x0200);

    const finalization = {
      counterentity: left.entityId,
      initialNonce: nonce,
      finalNonce: nonce,
      proposerIsLeft: false,
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

    await minePastTimeout(depository, acctKey);
    const fin = emptyBatch({ disputeFinalizations: [finalization] });
    const finSigned = await signDepositoryBatch(depository, right.entityId, right.privateKey, fin);
    await depository.connect(right.signer).processBatch(finSigned.encodedBatch, finSigned.hankoData, finSigned.nonce);
    expect(await depository._reserves(right.entityId, 1n)).to.equal(BigInt(0x0100 + 0x0200));
  });

  it('matches floor(amount * ratio / 65535) dust semantics exactly', async function () {
    const dispute = await openPullDispute({ label: 'registry-dust', fillRatio: 32767, pullAmount: -1_000n });
    await registerReveal(dispute, dispute.right, { fillRatio: 32767, reveals: buildHashLadderProof('registry-dust', 32767).reveals });
    await minePastTimeout(dispute.depository, dispute.acctKey);
    await finalizeDispute(dispute, dispute.right);
    expect(await dispute.depository._reserves(dispute.right.entityId, 1n)).to.equal(499n);
    expect(await dispute.depository._reserves(dispute.left.entityId, 1n)).to.equal(100_000n - 499n);
  });

  it('cannot claim twice: a second finalization of the same dispute reverts', async function () {
    const dispute = await openPullDispute({ label: 'registry-double', fillRatio: 0x0123 });
    await registerReveal(dispute, dispute.right, {});
    await minePastTimeout(dispute.depository, dispute.acctKey);
    await finalizeDispute(dispute, dispute.right);
    // Account is a linked library, so its bubbled E5 selector is absent from
    // Depository's generated ABI. Decode the exact revert with Account's ABI
    // while still executing the real Depository call.
    const accountErrorAbi = await ethers.getContractAt(
      'Account',
      await dispute.depository.getAddress(),
    );
    await expect(finalizeDispute(dispute, dispute.right))
      .to.be.revertedWithCustomError(accountErrorAbi, 'E5');
  });
});
