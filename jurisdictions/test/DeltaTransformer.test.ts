import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers.js";
import { expect } from "chai";
import hre from "hardhat";
import type { DeltaTransformer } from "../typechain-types/index.js";
import { buildAccountProofBody, setDeltaTransformerAddress } from "../../runtime/proof-builder.ts";
import { buildPositionalSwapFillRatioBuckets } from "../../runtime/transformer-ordering.ts";
import { asOfferId } from "../../runtime/swap-keys.ts";
import type { AccountMachine, SwapOffer } from "../../runtime/types.ts";

const { ethers } = hre;
const MAX_FILL_RATIO = 65535n;

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
    minFillRatio: 0,
    createdHeight: 0,
    quantizedGive: giveAmount,
    quantizedWant: wantAmount,
  };
}

function makeProofAccountMachine(swaps: Array<[string, SwapOffer]>): AccountMachine {
  return {
    leftEntity: "left",
    rightEntity: "right",
    status: "active",
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: "",
      tokenIds: [],
      deltas: [],
      stateHash: "",
      byLeft: true,
    },
    deltas: new Map([
      [1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 111n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
      [2, { tokenId: 2, collateral: 0n, ondelta: 0n, offdelta: -222n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
    ]),
    locks: new Map(),
    swapOffers: new Map(swaps),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: "left", toEntity: "right", nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
  };
}

function encodeWrappedDisputeArguments(fillRatios: number[]): string {
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(["uint16[]", "bytes32[]"], [fillRatios, []]);
  return ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]"], [[inner]]);
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
    deltas[swap.addDeltaIndex] += (swap.addAmount * ratio) / MAX_FILL_RATIO;
    deltas[swap.subDeltaIndex] -= (swap.subAmount * ratio) / MAX_FILL_RATIO;
  }
  return deltas;
}

describe("DeltaTransformer", function () {
  async function deployFixture() {
    const factory = await hre.ethers.getContractFactory("DeltaTransformer");
    const transformer = await factory.deploy();
    await transformer.waitForDeployment();
    return { transformer: transformer as DeltaTransformer };
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
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const rightArguments = abiCoder.encode(["uint16[]", "bytes32[]"], [[32767], []]);

    const result = await transformer.applyBatch.staticCall([0, 0], encodedBatch, "0x", rightArguments);

    expect(result[0]).to.equal(499);
    expect(result[1]).to.equal(-999);
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
    };
    const encodedBatch = await transformer.encodeBatch(batch);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const rightArguments = abiCoder.encode(["uint16[]", "bytes32[]"], [[65535], []]);

    await expect(
      transformer.applyBatch.staticCall([0], encodedBatch, "0x", rightArguments),
    ).to.be.reverted;
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
    };

    const encodedBatch = await transformer.encodeBatch(batch);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const leftFillRatios = [16384, 8192];
    const rightFillRatios = [65535, 32768];
    const leftArguments = abiCoder.encode(["uint16[]", "bytes32[]"], [leftFillRatios, []]);
    const rightArguments = abiCoder.encode(["uint16[]", "bytes32[]"], [rightFillRatios, []]);

    const result = await transformer.applyBatch.staticCall([0, 0], encodedBatch, leftArguments, rightArguments);

    let expected0 = 0n;
    let expected1 = 0n;
    let leftIndex = 0;
    let rightIndex = 0;
    for (const swap of batch.swap) {
      const fillRatio = swap.ownerIsLeft ? rightFillRatios[rightIndex++] : leftFillRatios[leftIndex++];
      const ratio = BigInt(fillRatio);
      const addAmount = (BigInt(swap.addAmount) * ratio) / MAX_FILL_RATIO;
      const subAmount = (BigInt(swap.subAmount) * ratio) / MAX_FILL_RATIO;
      if (swap.addDeltaIndex === 0) expected0 += addAmount;
      if (swap.addDeltaIndex === 1) expected1 += addAmount;
      if (swap.subDeltaIndex === 0) expected0 -= subAmount;
      if (swap.subDeltaIndex === 1) expected1 -= subAmount;
    }

    expect(result[0]).to.equal(expected0);
    expect(result[1]).to.equal(expected1);
  });

  it("keeps proof body swaps, positional fill ratios, wrapped dispute args, and contract deltas aligned end-to-end", async function () {
    const { transformer } = await loadFixture(deployFixture);
    setDeltaTransformerAddress(await transformer.getAddress());

    const accountMachine = makeProofAccountMachine([
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

    const proofBody = buildAccountProofBody(accountMachine);
    const proofTransformer = proofBody.proofBodyStruct.transformers[0];
    const runtimeTransformer = proofBody.runtimeProofBody.transformers[0];
    if (!proofTransformer || !runtimeTransformer) {
      throw new Error("EXPECTED_DELTA_TRANSFORMER_PROOF");
    }

    const { leftFillRatios, rightFillRatios } = buildPositionalSwapFillRatioBuckets(
      accountMachine.swapOffers.entries(),
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

    const result = await transformer.applyBatch.staticCall(
      [...initialDeltas],
      proofTransformer.encodedBatch,
      leftArguments,
      rightArguments,
    );

    expect([...result]).to.deep.equal(expected);
  });
});
