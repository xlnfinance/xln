import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';

const { ethers } = hre;
const abi = ethers.AbiCoder.defaultAbiCoder();

/**
 * Cross-vector: Account.encodeDisputeHash (Solidity) must match the watchtower
 * packing in core/watchtower/action.ts. Without this, a TS drift silently
 * makes last-resort disputeHash checks compare the wrong digest.
 */
const encodeDisputeHashTs = (
  nonce: bigint,
  startedByLeft: boolean,
  initialProposerIsLeft: boolean,
  timeout: bigint,
  leftResponseSeconds: bigint,
  rightResponseSeconds: bigint,
  proofbodyHash: string,
  disputeStartTimestamp: bigint,
  starterInitialArguments: string,
  starterCounterArguments: string,
  starterCounterProofCommitment: string,
): string => {
  const initialCommitment = ethers.keccak256(
    abi.encode(['bytes', 'bool', 'uint256'], [starterInitialArguments, startedByLeft, disputeStartTimestamp]),
  );
  const counterCommitment = ethers.keccak256(
    abi.encode(['bytes', 'bool', 'uint256'], [starterCounterArguments, startedByLeft, disputeStartTimestamp]),
  );
  return ethers.keccak256(
    ethers.solidityPacked(
      ['uint256', 'bool', 'bool', 'uint256', 'uint32', 'uint32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bool'],
      [
        nonce,
        startedByLeft,
        initialProposerIsLeft,
        timeout,
        leftResponseSeconds,
        rightResponseSeconds,
        proofbodyHash,
        disputeStartTimestamp,
        initialCommitment,
        counterCommitment,
        starterCounterProofCommitment,
        0n,
        ethers.ZeroHash,
        false,
      ],
    ),
  );
};

describe('dispute hash Solidity↔TS vector', function () {
  async function deployAccount() {
    const factory = await ethers.getContractFactory('Account');
    const account = await factory.deploy();
    await account.waitForDeployment();
    return { account };
  }

  it('matches watchtower encodeDisputeHash packing for empty and non-empty args', async function () {
    const { account } = await loadFixture(deployAccount);
    const cases = [
      {
        nonce: 1n,
        startedByLeft: true,
        initialProposerIsLeft: false,
        timeout: 1_700_003_600n,
        leftResponseSeconds: 1_800n,
        rightResponseSeconds: 1_800n,
        proofbodyHash: ethers.keccak256(ethers.toUtf8Bytes('xln:dispute-hash-vector:a')),
        disputeStartTimestamp: 1_700_000_000n,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      },
      {
        nonce: 42n,
        startedByLeft: false,
        initialProposerIsLeft: true,
        timeout: 1_700_086_523n,
        leftResponseSeconds: 3_600n,
        rightResponseSeconds: 82_800n,
        proofbodyHash: ethers.keccak256(ethers.toUtf8Bytes('xln:dispute-hash-vector:b')),
        disputeStartTimestamp: 1_700_000_123n,
        starterInitialArguments: '0x1234',
        starterCounterArguments: '0xabcd',
        starterCounterProofCommitment: ethers.keccak256(ethers.toUtf8Bytes('xln:counter-proof:b')),
      },
    ] as const;

    for (const c of cases) {
      const onchain = await account.encodeDisputeHash(
        c.nonce,
        c.startedByLeft,
        c.initialProposerIsLeft,
        c.timeout,
        c.leftResponseSeconds,
        c.rightResponseSeconds,
        c.proofbodyHash,
        c.disputeStartTimestamp,
        c.starterInitialArguments,
        c.starterCounterArguments,
        c.starterCounterProofCommitment,
      );
      const offchain = encodeDisputeHashTs(
        c.nonce,
        c.startedByLeft,
        c.initialProposerIsLeft,
        c.timeout,
        c.leftResponseSeconds,
        c.rightResponseSeconds,
        c.proofbodyHash,
        c.disputeStartTimestamp,
        c.starterInitialArguments,
        c.starterCounterArguments,
        c.starterCounterProofCommitment,
      );
      expect(onchain, `vector nonce=${c.nonce}`).to.equal(offchain);
    }
  });
});
