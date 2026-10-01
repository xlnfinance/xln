// R-J2: Account.encodeDisputeHash (the deployed fork bytecode) must match the watchtower packing in core/watchtower/action.ts. Without this a TS
// drift silently makes last-resort disputeHash checks compare the wrong digest. (The action.ts function is module-private, so its packing is
// mirrored here field for field.) It was a Hardhat test in test/dispute, which no gate runs; this is the same vector on BrowserVM.
// One file per process: `bun test contracts/test/vm/vectors/DisputeHashVector.test.ts`.
import { describe, expect, test } from "bun:test";
import { createAddressFromString } from "@ethereumjs/util";
import { ethers } from "ethers";
import { Account__factory } from "../../../typechain-types/index.ts";
import { boot } from "../rig.ts";

const abi = ethers.AbiCoder.defaultAbiCoder();

type Vector = {
  readonly nonce: bigint;
  readonly startedByLeft: boolean;
  readonly initialProposerIsLeft: boolean;
  readonly timeout: bigint;
  readonly leftResponseSeconds: bigint;
  readonly rightResponseSeconds: bigint;
  readonly proofbodyHash: string;
  readonly disputeStartTimestamp: bigint;
  readonly starterInitialArguments: string;
  readonly starterCounterArguments: string;
  readonly starterCounterProofCommitment: string;
};

/** The watchtower's packing (core/watchtower/action.ts encodeDisputeHash), with the zero counter fields the Account's own encodeDisputeHash fixes. */
const encodeDisputeHashTs = (v: Vector): string => {
  const commitment = (args: string): string => ethers.keccak256(abi.encode(["bytes", "bool", "uint256"], [args, v.startedByLeft, v.disputeStartTimestamp]));
  return ethers.keccak256(ethers.solidityPacked(
    ["uint256", "bool", "bool", "uint256", "uint32", "uint32", "bytes32", "uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bool"],
    [v.nonce, v.startedByLeft, v.initialProposerIsLeft, v.timeout, v.leftResponseSeconds, v.rightResponseSeconds, v.proofbodyHash, v.disputeStartTimestamp,
      commitment(v.starterInitialArguments), commitment(v.starterCounterArguments), v.starterCounterProofCommitment, 0n, ethers.ZeroHash, false],
  ));
};

const VECTORS: readonly Vector[] = [
  {
    nonce: 1n, startedByLeft: true, initialProposerIsLeft: false, timeout: 1_700_003_600n, leftResponseSeconds: 1_800n, rightResponseSeconds: 1_800n,
    proofbodyHash: ethers.keccak256(ethers.toUtf8Bytes("xln:dispute-hash-vector:a")), disputeStartTimestamp: 1_700_000_000n,
    starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: ethers.ZeroHash,
  },
  {
    nonce: 42n, startedByLeft: false, initialProposerIsLeft: true, timeout: 1_700_086_523n, leftResponseSeconds: 3_600n, rightResponseSeconds: 82_800n,
    proofbodyHash: ethers.keccak256(ethers.toUtf8Bytes("xln:dispute-hash-vector:b")), disputeStartTimestamp: 1_700_000_123n,
    starterInitialArguments: "0x1234", starterCounterArguments: "0xabcd", starterCounterProofCommitment: ethers.keccak256(ethers.toUtf8Bytes("xln:counter-proof:b")),
  },
];

describe("R-J2 dispute hash Solidity to TS vector", () => {
  test("R-J2 Account.encodeDisputeHash matches the watchtower packing for empty and non-empty args", async () => {
    const rig = await boot("dispute-hash-vector");
    const account = Account__factory.createInterface();
    for (const v of VECTORS) {
      const data = account.encodeFunctionData("encodeDisputeHash", [
        v.nonce, v.startedByLeft, v.initialProposerIsLeft, v.timeout, v.leftResponseSeconds, v.rightResponseSeconds, v.proofbodyHash,
        v.disputeStartTimestamp, v.starterInitialArguments, v.starterCounterArguments, v.starterCounterProofCommitment,
      ]);
      const result = await rig.vm.runReadOnlyCall({ to: createAddressFromString(rig.chain.addresses.account), caller: rig.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 5_000_000n });
      expect(result.execResult.exceptionError).toBeUndefined();
      const onchain = account.decodeFunctionResult("encodeDisputeHash", ethers.hexlify(result.execResult.returnValue))[0] as string;
      expect(onchain, `vector nonce=${v.nonce}`).toBe(encodeDisputeHashTs(v));
    }
  }, 300_000);

  test("R-J2 the TS packing is sensitive to every slot: changing any one field changes the digest", () => {
    const base = VECTORS[1]!;
    const digest = encodeDisputeHashTs(base);
    const changes: readonly Partial<Vector>[] = [
      { nonce: base.nonce + 1n }, { startedByLeft: !base.startedByLeft }, { initialProposerIsLeft: !base.initialProposerIsLeft }, { timeout: base.timeout + 1n },
      { leftResponseSeconds: base.leftResponseSeconds + 1n }, { rightResponseSeconds: base.rightResponseSeconds + 1n }, { proofbodyHash: ethers.ZeroHash },
      { disputeStartTimestamp: base.disputeStartTimestamp + 1n }, { starterInitialArguments: "0x12" }, { starterCounterArguments: "0xab" },
      { starterCounterProofCommitment: ethers.ZeroHash },
    ];
    for (const change of changes) expect(encodeDisputeHashTs({ ...base, ...change }), JSON.stringify(change, (_k, value) => (typeof value === "bigint" ? value.toString() : value))).not.toBe(digest);
  });
});
