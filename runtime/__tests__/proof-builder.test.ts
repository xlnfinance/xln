import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  buildAccountProofBody,
  createDisputeProofHash,
  createDisputeProofHashWithNonce,
  setDeltaTransformerAddress,
} from '../proof-builder';

const DEPOSITORY = '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1';
const PROOF_BODY_HASH = '0x216659016a52d3f9df41568d0c85bd6870ee46705ada7366c9f68d60e0a83548';

describe('proof-builder dispute hash', () => {
  test('uses canonical sorted account key regardless of local left/right orientation', () => {
    const leftOriented = {
      leftEntity: '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      rightEntity: '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
      proofHeader: { nonce: 1 },
    };
    const rightOriented = {
      leftEntity: leftOriented.rightEntity,
      rightEntity: leftOriented.leftEntity,
      proofHeader: { nonce: 1 },
    };

    const sortedKey = ethers.solidityPacked(
      ['bytes32', 'bytes32'],
      [leftOriented.leftEntity, leftOriented.rightEntity],
    );
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'address', 'bytes', 'uint256', 'bytes32'],
        [1, DEPOSITORY, sortedKey, 1, PROOF_BODY_HASH],
      ),
    );

    expect(createDisputeProofHash(leftOriented, PROOF_BODY_HASH, DEPOSITORY)).toBe(expected);
    expect(createDisputeProofHash(rightOriented, PROOF_BODY_HASH, DEPOSITORY)).toBe(expected);
    expect(createDisputeProofHashWithNonce(leftOriented, PROOF_BODY_HASH, DEPOSITORY, 1)).toBe(expected);
    expect(createDisputeProofHashWithNonce(rightOriented, PROOF_BODY_HASH, DEPOSITORY, 1)).toBe(expected);
  });

  test('fails fast when depository address is missing', () => {
    const account = {
      leftEntity: '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      rightEntity: '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
      proofHeader: { nonce: 1 },
    };
    expect(() => createDisputeProofHash(account, PROOF_BODY_HASH, '')).toThrow('MISSING_DEPOSITORY_ADDRESS');
    expect(() => createDisputeProofHashWithNonce(account, PROOF_BODY_HASH, '', 1)).toThrow(
      'MISSING_DEPOSITORY_ADDRESS',
    );
  });

  test('fails fast when transformer address is missing for HTLC/swaps', () => {
    setDeltaTransformerAddress('');
    const accountMachine = {
      deltas: new Map([
        [
          1,
          {
            offdelta: 10n,
          },
        ],
      ]),
      locks: new Map([
        [
          'lock-1',
          {
            tokenId: 1,
            senderIsLeft: true,
            amount: 10n,
            revealBeforeHeight: 123,
            hashlock: '0x' + '11'.repeat(32),
          },
        ],
      ]),
      swapOffers: new Map(),
    } as any;

    expect(() => buildAccountProofBody(accountMachine)).toThrow('MISSING_DELTA_TRANSFORMER_ADDRESS');
  });
});
