import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
import type { DeltaTransformer } from "../../typechain-types/index.js";
import { buildAccountProofBody } from "../../../runtime/protocol/dispute/proof-builder.ts";
import { createEmptyAccountJClaimAccumulator } from "../../../runtime/account/j-claims/j-claim-accumulator";
import { buildPositionalSwapFillRatioBuckets } from "../../../runtime/protocol/transform/transformer-ordering";
import { asOfferId } from "../../../runtime/orderbook/swap-keys.ts";
import { deriveSwapOffdeltaChanges } from "../../../runtime/orderbook/swap-execution.ts";
import type { AccountReplica, SwapOffer } from "../../../runtime/types.ts";

const { ethers } = hre;
const MAX_FILL_RATIO = 65535n;
const TEST_WATCH_SEED = `0x${"11".repeat(32)}`;
const LEFT_ENTITY = `0x${"0a".repeat(32)}`;
const RIGHT_ENTITY = `0x${"0b".repeat(32)}`;

function makeSwapOffer(
  offerId: string,
  makerIsLeft: boolean,
  giveTokenId: number,
  giveAmount: bigint,
  wantTokenId: number,
  wantAmount: bigint,
): SwapOffer {
  return {
    offerId,
    giveTokenId,
    giveAmount,
    wantTokenId,
    wantAmount,
    makerIsLeft,
    createdHeight: 0,
    quantizedGive: giveAmount,
    quantizedWant: wantAmount,
  };
}

function makeProofAccountReplica(swaps: Array<[string, SwapOffer]>): AccountReplica {
  return {
    state: {
      leftEntity: "left",
      rightEntity: "right",
      domain: {
        chainId: 31_337,
        depositoryAddress: "0x1111111111111111111111111111111111111111",
      },
      watchSeed: TEST_WATCH_SEED,
      deltas: new Map([
        [1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 111n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
        [2, { tokenId: 2, collateral: 0n, ondelta: 0n, offdelta: -222n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
      ]),
      locks: new Map(),
      swapOffers: new Map(swaps),
      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
    },
    status: "active",
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: "",
      deltas: [],
      stateHash: "",
      byLeft: true,
    },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: "left", toEntity: "right", nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
}

function encodeWrappedDisputeArguments(fillRatios: number[]): string {
  const inner = encodeTransformerArguments(fillRatios);
  return ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]"], [[inner]]);
}

// Cross-j pulls take no dispute arguments: their ratio comes from the
// Depository reveal registry, so the transformer argument tuple carries only
// same-jurisdiction swap ratios and payment secrets.
function encodeTransformerArguments(fillRatios: number[], secrets: string[] = []): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint16[] fillRatios, bytes32[] secrets)"],
    [{
      fillRatios,
      secrets,
    }],
  );
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
  return [
    (fillRatio >> 12) & 0x0f,
    (fillRatio >> 8) & 0x0f,
    (fillRatio >> 4) & 0x0f,
    fillRatio & 0x0f,
  ];
}

function buildPullProof(label: string, fillRatio: number) {
  const fullSecret = secret(`${label}:full`);
  const bases = [0, 1, 2, 3].map((index) => secret(`${label}:n${index}`));
  const roots = bases.map((base) => hashSteps(base, 15));
  const reveals = nibbles(fillRatio).map((digit, index) => hashSteps(bases[index], 15 - digit));
  return {
    fullSecret,
    fullHash: hashNode(fullSecret),
    partialRoot: ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32", "bytes32", "bytes32"], roots)),
    reveals,
  };
}

function unwrapWrappedDisputeArguments(wrapped: string): string {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["bytes[]"], wrapped)[0] as string[];
  return decoded[0] || "0x";
}

function applyExpectedSwapBatch(
  initialDeltas: bigint[],
  swaps: Array<{ ownerIsLeft: boolean; addDeltaIndex: number; addAmount: bigint; subDeltaIndex: number; subAmount: bigint }>,
  leftFillRatios: number[],
  rightFillRatios: number[],
): bigint[] {
  const deltas = [...initialDeltas];
  let leftIndex = 0;
  let rightIndex = 0;
  for (const swap of swaps) {
    const fillRatio = swap.ownerIsLeft ? rightFillRatios[rightIndex++] : leftFillRatios[leftIndex++];
    const ratio = BigInt(fillRatio || 0);
    const change = deriveSwapOffdeltaChanges(
      swap.ownerIsLeft,
      (swap.addAmount * ratio) / MAX_FILL_RATIO,
      (swap.subAmount * ratio) / MAX_FILL_RATIO,
    );
    deltas[swap.addDeltaIndex] += change.give;
    deltas[swap.subDeltaIndex] += change.want;
  }
  return deltas;
}

describe("DeltaTransformer", function () {
  async function deployFixture() {
    const factory = await hre.ethers.getContractFactory("DeltaTransformer");
    const transformer = await factory.deploy();
    await transformer.waitForDeployment();
    const registryFactory = await hre.ethers.getContractFactory("MockRevealRegistry");
    const registry = await registryFactory.deploy();
    await registry.waitForDeployment();
    return { transformer: transformer as DeltaTransformer, registry };
  }

  // Pulls read the reveal registry at msg.sender, so pull-bearing batches must
  // be applied through a registry-backed contract; swap/payment-only batches
  // never touch the registry and can call the transformer directly.
  async function applyCanonical(
    transformer: DeltaTransformer,
    deltas: Array<bigint | number>,
    encodedBatch: string,
    leftArguments: string,
    rightArguments: string,
    leftArgumentsTimestamp?: number,
    rightArgumentsTimestamp?: number,
    tokenIds: Array<bigint | number> = deltas.map((_, index) => index + 1),
  ) {
    const currentTimestamp = await time.latest();
    const disputeStartTimestamp = Math.max(1, currentTimestamp - 2);
    const disputeTimeout = disputeStartTimestamp + 2;
    return transformer.applyBatch.staticCall(
      deltas,
      tokenIds,
      encodedBatch,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp ?? currentTimestamp,
      rightArgumentsTimestamp ?? currentTimestamp,
      LEFT_ENTITY,
      RIGHT_ENTITY,
      disputeStartTimestamp,
      disputeTimeout,
      1,
      1,
    );
  }

  async function applyViaRegistry(
    registry: Awaited<ReturnType<typeof deployFixture>>["registry"],
    transformer: DeltaTransformer,
    deltas: Array<bigint | number>,
    encodedBatch: string,
    leftArguments: string,
    rightArguments: string,
    tokenIds: Array<bigint | number> = deltas.map((_, index) => index + 1),
    disputeClock?: {
      startTs: number;
      timeoutTs: number;
      leftResponseSeconds?: number;
      rightResponseSeconds?: number;
    },
  ) {
    const currentTimestamp = await time.latest();
    // Default: dispute already past full T (seconds) so pull settlement can run.
    const startTs = disputeClock?.startTs ?? Math.max(1, currentTimestamp - 200);
    const timeoutTs = disputeClock?.timeoutTs ?? currentTimestamp;
    const totalWindow = timeoutTs - startTs;
    const leftResponseSeconds = disputeClock?.leftResponseSeconds ?? Math.floor(totalWindow / 2);
    const rightResponseSeconds = disputeClock?.rightResponseSeconds ?? totalWindow - leftResponseSeconds;
    return registry.applyBatchViaRegistry.staticCall(
      await transformer.getAddress(),
      deltas,
      tokenIds,
      encodedBatch,
      leftArguments,
      rightArguments,
      currentTimestamp,
      currentTimestamp,
      LEFT_ENTITY,
      RIGHT_ENTITY,
      startTs,
      timeoutTs,
      leftResponseSeconds,
      rightResponseSeconds,
    );
  }

  it("decodes swap fill ratios from uint16 calldata arguments", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const batch = {
      payment: [],
      swap: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          addAmount: 1_000,
          subDeltaIndex: 1,
          subAmount: 2_000,
        },
      ],
      pull: [],
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const rightArguments = encodeTransformerArguments([32767]);

    const result = await applyCanonical(transformer, [0, 0], encodedBatch, "0x", rightArguments);

    expect(result[0]).to.equal(-499);
    expect(result[1]).to.equal(999);
  });

  it("treats malformed adversarial argument blobs as empty evidence", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const batch = {
      payment: [],
      swap: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          addAmount: 1_000,
          subDeltaIndex: 1,
          subAmount: 2_000,
        },
      ],
      pull: [],
    };
    const encodedBatch = await transformer.encodeBatch(batch);

    const result = await applyCanonical(transformer, [0, 0], encodedBatch, "0x", "0x1234");

    expect(result[0]).to.equal(0);
    expect(result[1]).to.equal(0);
  });

  it("requires token IDs to stay aligned one-to-one with deltas", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const encodedBatch = await transformer.encodeBatch({ payment: [], swap: [], pull: [] });
    const timestamp = await time.latest();
    const disputeStartTimestamp = Math.max(1, timestamp - 2);

    await expect(
      transformer.applyBatch.staticCall(
        [0n, 0n],
        [1n],
        encodedBatch,
        "0x",
        "0x",
        timestamp,
        timestamp,
        LEFT_ENTITY,
        RIGHT_ENTITY,
        disputeStartTimestamp,
        disputeStartTimestamp + 2,
        1,
        1,
      ),
    ).to.be.revertedWithCustomError(transformer, "ContextLengthMismatch");
  });

  it("reverts on out-of-bounds swap delta indices", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const batch = {
      payment: [],
      swap: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 1,
          addAmount: 1,
          subDeltaIndex: 0,
          subAmount: 1,
        },
      ],
      pull: [],
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const rightArguments = encodeTransformerArguments([65535]);

    await expect(
      applyCanonical(transformer, [0], encodedBatch, "0x", rightArguments),
    ).to.be.reverted;
  });

  it("settles pulls only from role-windowed records of this dispute", async function () {
    const { transformer, registry } = await loadFixture(deployFixture);
    const partialRatio = 0x1234;
    const partialProof = buildPullProof("delta-partial", partialRatio);
    const fullProof = buildPullProof("delta-full", 0xffff);
    const ladderHash = (proof: { fullHash: string; partialRoot: string }): string =>
      ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [proof.fullHash, proof.partialRoot]));
    const nowTs = await time.latest();
    const openStart = nowTs;
    const openTimeout = nowTs + 100; // T=100s still open
    const settledStart = Math.max(1, nowTs - 200);
    const settledTimeout = nowTs; // T already elapsed
    const timelyRevealAt = settledStart + 10; // inside the beneficiary Source window

    const batch = {
      payment: [],
      swap: [],
      pull: [
        {
          deltaIndex: 0,
          amount: MAX_FILL_RATIO,
          claimedRatio: 0,
          fullHash: partialProof.fullHash,
          partialRoot: partialProof.partialRoot,
          targetRole: false,
        },
        {
          deltaIndex: 1,
          amount: -1234,
          claimedRatio: 0,
          fullHash: fullProof.fullHash,
          partialRoot: fullProof.partialRoot,
          targetRole: false,
        },
      ],
    };
    const encodedBatch = await transformer.encodeBatch(batch);

    // Timely registry writes but dispute still open → barrier.
    await registry.setReveal(LEFT_ENTITY, RIGHT_ENTITY, ladderHash(partialProof), false, partialRatio, timelyRevealAt);
    await registry.setReveal(RIGHT_ENTITY, LEFT_ENTITY, ladderHash(fullProof), false, 0xffff, timelyRevealAt);
    await expect(
      applyViaRegistry(registry, transformer, [0, 0], encodedBatch, "0x", "0x", [1, 2], {
        startTs: openStart,
        timeoutTs: openTimeout,
      }),
    ).to.be.revertedWithCustomError(transformer, "PullRevealWindowActive");

    // Past full T: same timely records settle.
    const result = await applyViaRegistry(registry, transformer, [0, 0], encodedBatch, "0x", "0x", [1, 2], {
      startTs: settledStart,
      timeoutTs: settledTimeout,
    });
    expect(result[0]).to.equal(BigInt(partialRatio));
    expect(result[1]).to.equal(-1234n);

    // Source (targetRole=false): registration after the beneficiary-side
    // response window settles as 0.
    const lateProof = buildPullProof("delta-late", 0x0100);
    const lateBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [{
        deltaIndex: 0,
        amount: MAX_FILL_RATIO,
        claimedRatio: 0,
        fullHash: lateProof.fullHash,
        partialRoot: lateProof.partialRoot,
          targetRole: false,
      }],
    });
    const sourceBeneficiaryWindow = 100;
    const sourceDeadline = settledStart + sourceBeneficiaryWindow;
    await registry.setReveal(
      LEFT_ENTITY,
      RIGHT_ENTITY,
      ladderHash(lateProof),
      false,
      0x0100,
      sourceDeadline + 1,
    );
    const late = await applyViaRegistry(registry, transformer, [0], lateBatch, "0x", "0x", [1], {
      startTs: settledStart,
      timeoutTs: settledTimeout,
      leftResponseSeconds: sourceBeneficiaryWindow,
      rightResponseSeconds: 100,
    });
    expect(late[0]).to.equal(0n);

    // A record from before this dispute never becomes valid merely because a
    // broken client reused the same ladder in a later signed ProofBody.
    const staleProof = buildPullProof("delta-stale-prior-dispute", 0x0110);
    const staleBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [{
        deltaIndex: 0,
        amount: MAX_FILL_RATIO,
        claimedRatio: 0,
        fullHash: staleProof.fullHash,
        partialRoot: staleProof.partialRoot,
        targetRole: false,
      }],
    });
    await registry.setReveal(
      LEFT_ENTITY,
      RIGHT_ENTITY,
      ladderHash(staleProof),
      false,
      0x0110,
      settledStart - 1,
    );
    const stale = await applyViaRegistry(
      registry,
      transformer,
      [0],
      staleBatch,
      "0x",
      "0x",
      [1],
      { startTs: settledStart, timeoutTs: settledTimeout },
    );
    expect(stale[0]).to.equal(0n);

    // Target (targetRole=true) opens at its own dispute start and receives the
    // beneficiary's exact signed window. Use asymmetric windows because a
    // 50/50 fixture cannot detect selecting the wrong side.
    const targetProof = buildPullProof("delta-target", 0x0200);
    const targetBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [{
        deltaIndex: 0,
        amount: MAX_FILL_RATIO,
        claimedRatio: 0,
        fullHash: targetProof.fullHash,
        partialRoot: targetProof.partialRoot,
        targetRole: true,
      }],
    });
    const asymmetricClock = {
      startTs: settledStart,
      timeoutTs: settledTimeout,
      leftResponseSeconds: 30,
      rightResponseSeconds: 170,
    };
    // Beneficiary is LEFT, so the exact Target deadline is S+30. The full
    // S+200 sum remains only the finalization barrier.
    await registry.setReveal(
      LEFT_ENTITY, RIGHT_ENTITY, ladderHash(targetProof), true, 0x0200,
      settledStart,
    );
    const immediateTarget = await applyViaRegistry(
      registry, transformer, [0], targetBatch, "0x", "0x", [1], asymmetricClock,
    );
    expect(immediateTarget[0]).to.equal(0x0200n);
    await registry.setReveal(
      LEFT_ENTITY, RIGHT_ENTITY, ladderHash(targetProof), true, 0x0200,
      settledStart + 30,
    );
    const deadlineTarget = await applyViaRegistry(
      registry, transformer, [0], targetBatch, "0x", "0x", [1], asymmetricClock,
    );
    expect(deadlineTarget[0]).to.equal(0x0200n);
    await registry.setReveal(
      LEFT_ENTITY, RIGHT_ENTITY, ladderHash(targetProof), true, 0x0200,
      settledStart + 31,
    );
    const lateTarget = await applyViaRegistry(
      registry, transformer, [0], targetBatch, "0x", "0x", [1], asymmetricClock,
    );
    expect(lateTarget[0]).to.equal(0n);

    // No record at all settles as 0 once the barrier has cleared.
    const noneProof = buildPullProof("delta-none", 0x0100);
    const noneBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [{
        deltaIndex: 0,
        amount: MAX_FILL_RATIO,
        claimedRatio: 0,
        fullHash: noneProof.fullHash,
        partialRoot: noneProof.partialRoot,
        targetRole: false,
      }],
    });
    const none = await applyViaRegistry(registry, transformer, [0], noneBatch, "0x", "0x", [1], {
      startTs: settledStart,
      timeoutTs: settledTimeout,
    });
    expect(none[0]).to.equal(0n);

    // Telescoping: a partially claimed pull applies only the increment.
    const previouslyClaimed = 0x1000;
    const cumulativeBatch = await transformer.encodeBatch({
      payment: [],
      swap: [],
      pull: [{
        deltaIndex: 0,
        amount: MAX_FILL_RATIO,
        claimedRatio: previouslyClaimed,
        fullHash: partialProof.fullHash,
        partialRoot: partialProof.partialRoot,
        targetRole: false,
      }],
    });
    const cumulative = await applyViaRegistry(registry, transformer, [0], cumulativeBatch, "0x", "0x", [1], {
      startTs: settledStart,
      timeoutTs: settledTimeout,
    });
    expect(cumulative[0]).to.equal(BigInt(partialRatio - previouslyClaimed));

    // Pulls without a registry behind msg.sender fail loud, never silent-zero.
    await expect(
      applyCanonical(transformer, [0], cumulativeBatch, "0x", "0x"),
    ).to.be.revertedWithCustomError(transformer, "PullRevealRegistryUnavailable");
  });

  it("uses timestamp deadlines for payment secrets from arguments and on-chain reveals", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const secretValue = ethers.encodeBytes32String("payment-secret");
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [secretValue]));
    const deadline = (await time.latest()) + 60;
    const batch = {
      payment: [{
        deltaIndex: 0,
        amount: 7,
        revealedUntilTimestamp: deadline,
        hash,
      }],
      swap: [],
      pull: [],
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const leftArguments = encodeTransformerArguments([], [secretValue]);

    const beforeDeadline = await applyCanonical(
      transformer,
      [0],
      encodedBatch,
      leftArguments,
      "0x",
      deadline,
      deadline + 1,
    );
    expect(beforeDeadline[0]).to.equal(7n);

    const afterDeadline = await applyCanonical(
      transformer,
      [0],
      encodedBatch,
      leftArguments,
      "0x",
      deadline + 1,
      deadline + 1,
    );
    expect(afterDeadline[0]).to.equal(0n);

    await transformer.revealSecret(secretValue);
    const revealedAt = await transformer.hashToTimestamp(hash);
    expect(revealedAt > 0n).to.equal(true);
    expect(revealedAt <= BigInt(deadline)).to.equal(true);

    const onChainReveal = await applyCanonical(
      transformer,
      [0],
      encodedBatch,
      "0x",
      "0x",
      deadline + 1,
      deadline + 1,
    );
    expect(onChainReveal[0]).to.equal(7n);
  });

  it("stores the first secret reveal timestamp and treats exact retries as no-ops", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const secret = ethers.encodeBytes32String("secret");
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [secret]));

    await transformer.revealSecret(secret);
    const firstRevealAt = await transformer.hashToTimestamp(hash);

    expect(firstRevealAt > 0n).to.equal(true);
    await expect(transformer.revealSecret(secret)).not.to.be.reverted;
    expect(await transformer.hashToTimestamp(hash)).to.equal(firstRevealAt);
  });

  it("applies mixed-side positional fill ratio arrays exactly in batch order", async function () {
    const { transformer } = await loadFixture(deployFixture);

    const batch = {
      payment: [],
      swap: [
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          addAmount: 1000,
          subDeltaIndex: 1,
          subAmount: 2000,
        },
        {
          ownerIsLeft: true,
          addDeltaIndex: 0,
          addAmount: 2000,
          subDeltaIndex: 1,
          subAmount: 5000,
        },
        {
          ownerIsLeft: false,
          addDeltaIndex: 1,
          addAmount: 3000,
          subDeltaIndex: 0,
          subAmount: 7000,
        },
        {
          ownerIsLeft: false,
          addDeltaIndex: 1,
          addAmount: 4000,
          subDeltaIndex: 0,
          subAmount: 8000,
        },
      ],
      pull: [],
    };

    const encodedBatch = await transformer.encodeBatch(batch);
    const leftFillRatios = [16384, 8192];
    const rightFillRatios = [65535, 32768];
    const leftArguments = encodeTransformerArguments(leftFillRatios);
    const rightArguments = encodeTransformerArguments(rightFillRatios);

    const result = await applyCanonical(transformer, [0, 0], encodedBatch, leftArguments, rightArguments);

    let expected0 = 0n;
    let expected1 = 0n;
    let leftIndex = 0;
    let rightIndex = 0;
    for (const swap of batch.swap) {
      const fillRatio = swap.ownerIsLeft ? rightFillRatios[rightIndex++] : leftFillRatios[leftIndex++];
      const ratio = BigInt(fillRatio);
      const addAmount = (BigInt(swap.addAmount) * ratio) / MAX_FILL_RATIO;
      const subAmount = (BigInt(swap.subAmount) * ratio) / MAX_FILL_RATIO;
      const change = deriveSwapOffdeltaChanges(swap.ownerIsLeft, addAmount, subAmount);
      if (swap.addDeltaIndex === 0) expected0 += change.give;
      if (swap.addDeltaIndex === 1) expected1 += change.give;
      if (swap.subDeltaIndex === 0) expected0 += change.want;
      if (swap.subDeltaIndex === 1) expected1 += change.want;
    }

    expect(result[0]).to.equal(expected0);
    expect(result[1]).to.equal(expected1);
  });

  it("keeps proof body swaps, positional fill ratios, wrapped dispute args, and contract deltas aligned end-to-end", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const transformerAddress = await transformer.getAddress();

    const accountReplica = makeProofAccountReplica([
      ["b2", makeSwapOffer("b2", false, 2, 400n, 1, 800n)],
      ["a10", makeSwapOffer("a10", true, 1, 100n, 2, 200n)],
      ["a2", makeSwapOffer("a2", true, 1, 200n, 2, 500n)],
      ["b1", makeSwapOffer("b1", false, 2, 300n, 1, 700n)],
    ]);

    const fillRatiosByOfferId = new Map([
      [asOfferId("a10"), 65535],
      [asOfferId("a2"), 32768],
      [asOfferId("b1"), 16384],
      [asOfferId("b2"), 8192],
    ]);

    const proofBody = buildAccountProofBody(accountReplica, transformerAddress);
    const proofTransformer = proofBody.proofBodyStruct.transformers[0];
    const runtimeTransformer = proofBody.runtimeProofBody.transformers[0];
    if (!proofTransformer || !runtimeTransformer) {
      throw new Error("EXPECTED_DELTA_TRANSFORMER_PROOF");
    }

    const { leftFillRatios, rightFillRatios } = buildPositionalSwapFillRatioBuckets(
      accountReplica.state.swapOffers.entries(),
      fillRatiosByOfferId,
    );

    const leftWrappedArguments = encodeWrappedDisputeArguments(leftFillRatios);
    const rightWrappedArguments = encodeWrappedDisputeArguments(rightFillRatios);
    const leftArguments = unwrapWrappedDisputeArguments(leftWrappedArguments);
    const rightArguments = unwrapWrappedDisputeArguments(rightWrappedArguments);

    const initialDeltas = [...proofBody.runtimeProofBody.offdeltas];
    const expected = applyExpectedSwapBatch(
      initialDeltas,
      runtimeTransformer.batch.swaps,
      leftFillRatios,
      rightFillRatios,
    );

    const result = await applyCanonical(
      transformer,
      [...initialDeltas],
      proofTransformer.encodedBatch,
      leftArguments,
      rightArguments,
      undefined,
      undefined,
      [...proofBody.runtimeProofBody.tokenIds],
    );

    expect([...result]).to.deep.equal(expected);
  });

  it("fits the runtime maximum swap book inside the canonical transformer gas budget", async function () {
    const { transformer } = await loadFixture(deployFixture);
    const swap = {
      ownerIsLeft: true,
      addDeltaIndex: 0,
      addAmount: 1n,
      subDeltaIndex: 1,
      subAmount: 1n,
    };
    const encodedBatch = await transformer.encodeBatch({
      payment: [],
      swap: Array.from({ length: 1_000 }, () => swap),
      pull: [],
    });
    const rightArguments = encodeTransformerArguments(Array.from({ length: 1_000 }, () => 65_535));
    const timestamp = await time.latest();
    const disputeStartTimestamp = Math.max(1, timestamp - 2);
    const gas = await transformer.applyBatch.estimateGas(
      [0n, 0n],
      [1n, 2n],
      encodedBatch,
      "0x",
      rightArguments,
      timestamp,
      timestamp,
      LEFT_ENTITY,
      RIGHT_ENTITY,
      disputeStartTimestamp,
      disputeStartTimestamp + 2,
      1,
      1,
    );
    expect(gas).to.be.lessThanOrEqual(4_000_000n);
  });
});
