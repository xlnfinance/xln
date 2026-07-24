import { expect } from 'chai';
import hre from 'hardhat';
import { deployEntityProvider } from './helpers/hanko.ts';

import {
  createFoundationReleaseBoard,
  signReleaseEnvelope,
  type ReleaseEnvelope,
} from '../../frontend/src/lib/releases/release-signature.ts';

const { ethers } = hre;
const PRIVATE_KEYS = [
  `0x${'01'.padStart(64, '0')}`,
  `0x${'02'.padStart(64, '0')}`,
  `0x${'03'.padStart(64, '0')}`,
];

describe('Foundation release Hanko parity', function () {
  it('verifies the exact 2-of-3 release Hanko in EntityProvider.sol', async function () {
    const [deployer] = await ethers.getSigners();
    const provider = await deployEntityProvider(deployer.address);

    const addresses = PRIVATE_KEYS.map((key) => ethers.computeAddress(new ethers.SigningKey(key).publicKey));
    const board = createFoundationReleaseBoard(addresses, 2);
    const envelope: ReleaseEnvelope = {
      version: '0.1.7',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      codeSnapshotRoot: `0x${'11'.repeat(32)}`,
      frozenCoreRoot: `0x${'22'.repeat(32)}`,
      generatedAt: '2026-07-11T00:00:00.000Z',
    };
    const attestation = signReleaseEnvelope(envelope, board, PRIVATE_KEYS);
    const [entityId, success] = await provider.verifyHankoSignature(attestation.hanko, attestation.envelopeHash);
    const [, tamperedSuccess] = await provider.verifyHankoSignature(attestation.hanko, ethers.keccak256('0x1234'));

    expect(success).to.equal(true);
    expect(entityId).to.equal(board.entityId);
    expect(tamperedSuccess).to.equal(false);
  });
});
