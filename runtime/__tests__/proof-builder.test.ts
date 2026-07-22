import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  buildAccountProofBody,
  createDisputeProofHash,
  createDisputeProofHashWithNonce,
} from '../protocol/dispute/proof-builder';

const DEPOSITORY = '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1';
const HANKO_DOMAIN = { chainId: 31337, depositoryAddress: DEPOSITORY } as const;
const PROOF_BODY_HASH = '0x216659016a52d3f9df41568d0c85bd6870ee46705ada7366c9f68d60e0a83548';
const TEST_WATCH_SEED = `0x${'11'.repeat(32)}`;

describe('proof-builder dispute hash', () => {
  const proofAccount = (deltas: Map<number, { ondelta: bigint; offdelta: bigint }>) => ({
    deltas,
    locks: new Map(),
    swapOffers: new Map(),
    pulls: new Map(),
    watchSeed: TEST_WATCH_SEED,
  }) as any;

  test('uses canonical sorted account key regardless of local left/right orientation', () => {
    const leftOriented = {
      leftEntity: '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      rightEntity: '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
      proofHeader: { nextProofNonce: 1 },
      watchSeed: TEST_WATCH_SEED,
    };
    const rightOriented = {
      leftEntity: leftOriented.rightEntity,
      rightEntity: leftOriented.leftEntity,
      proofHeader: { nextProofNonce: 1 },
      watchSeed: TEST_WATCH_SEED,
    };

    const sortedKey = ethers.solidityPacked(
      ['bytes32', 'bytes32'],
      [leftOriented.leftEntity, leftOriented.rightEntity],
    );
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
        [1, HANKO_DOMAIN.chainId, DEPOSITORY, sortedKey, 1, PROOF_BODY_HASH, TEST_WATCH_SEED],
      ),
    );

    expect(createDisputeProofHash(leftOriented, PROOF_BODY_HASH, HANKO_DOMAIN)).toBe(expected);
    expect(createDisputeProofHash(rightOriented, PROOF_BODY_HASH, HANKO_DOMAIN)).toBe(expected);
    expect(createDisputeProofHashWithNonce(leftOriented, PROOF_BODY_HASH, HANKO_DOMAIN, 1)).toBe(expected);
    expect(createDisputeProofHashWithNonce(rightOriented, PROOF_BODY_HASH, HANKO_DOMAIN, 1)).toBe(expected);
  });

  test('fails fast when depository address is missing', () => {
    const account = {
      leftEntity: '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      rightEntity: '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
      proofHeader: { nextProofNonce: 1 },
      watchSeed: TEST_WATCH_SEED,
    };
    const missingAddress = { chainId: 31337, depositoryAddress: '' };
    expect(() => createDisputeProofHash(account, PROOF_BODY_HASH, missingAddress)).toThrow('INVALID_HANKO_DEPOSITORY_ADDRESS:missing');
    expect(() => createDisputeProofHashWithNonce(account, PROOF_BODY_HASH, missingAddress, 1)).toThrow(
      'INVALID_HANKO_DEPOSITORY_ADDRESS:missing',
    );
  });

  test('fails fast when the Hanko chain domain is missing', () => {
    const account = {
      leftEntity: '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      rightEntity: '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
      proofHeader: { nextProofNonce: 1 },
      watchSeed: TEST_WATCH_SEED,
    };
    expect(() => createDisputeProofHash(
      account,
      PROOF_BODY_HASH,
      { chainId: 0, depositoryAddress: DEPOSITORY },
    )).toThrow('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
  });

  test('fails fast when transformer address is missing for HTLC/swaps', () => {
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
            timelock: 123_000n,
            revealBeforeHeight: 123,
            hashlock: '0x' + '11'.repeat(32),
          },
        ],
      ]),
      swapOffers: new Map(),
      watchSeed: TEST_WATCH_SEED,
    } as any;

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow('MISSING_DELTA_TRANSFORMER_ADDRESS');
  });

  test('fails fast when an HTLC lock references a token without a delta slot', () => {
    const accountMachine = {
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map([
        ['lock-missing-token', {
          tokenId: 2,
          senderIsLeft: true,
          amount: 10n,
          timelock: 123_000n,
          revealBeforeHeight: 123,
          hashlock: '0x' + '11'.repeat(32),
        }],
      ]),
      swapOffers: new Map(),
      pulls: new Map(),
      watchSeed: TEST_WATCH_SEED,
    } as any;

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow(
      'PROOF_BODY_LOCK_TOKEN_MISSING:lock-missing-token:2',
    );
  });

  test('fails fast when a swap references a token without a delta slot', () => {
    const accountMachine = {
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map(),
      swapOffers: new Map([
        ['swap-missing-token', {
          makerIsLeft: true,
          giveTokenId: 1,
          giveAmount: 17n,
          wantTokenId: 2,
          wantAmount: 19n,
        }],
      ]),
      pulls: new Map(),
      watchSeed: TEST_WATCH_SEED,
    } as any;

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow(
      'PROOF_BODY_SWAP_TOKEN_MISSING:swap-missing-token:give=1:want=2',
    );
  });

  test('fails fast when a pull references a token without a delta slot', () => {
    const accountMachine = {
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map([
        ['pull-missing-token', {
          tokenId: 2,
          amount: 23n,
          claimedRatio: 0,
          revealedUntilTimestamp: 123_000,
          fullHash: '0x' + '33'.repeat(32),
          partialRoot: '0x' + '44'.repeat(32),
        }],
      ]),
      watchSeed: TEST_WATCH_SEED,
    } as any;

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow(
      'PROOF_BODY_PULL_TOKEN_MISSING:pull-missing-token:2',
    );
  });

  test('builds transformer allowances for payments, swaps, and pulls', () => {
    const accountMachine = {
      deltas: new Map([
        [1, { offdelta: 0n }],
        [2, { offdelta: 0n }],
        [3, { offdelta: 0n }],
      ]),
      locks: new Map([
        ['lock-left-sends', {
          tokenId: 1,
          senderIsLeft: true,
          amount: 11n,
          timelock: 123_000n,
          revealBeforeHeight: 123,
          hashlock: '0x' + '11'.repeat(32),
        }],
        ['lock-right-sends', {
          tokenId: 2,
          senderIsLeft: false,
          amount: 13n,
          timelock: 123_000n,
          revealBeforeHeight: 123,
          hashlock: '0x' + '22'.repeat(32),
        }],
      ]),
      swapOffers: new Map([
        ['swap-1', {
          makerIsLeft: true,
          giveTokenId: 1,
          giveAmount: 17n,
          wantTokenId: 2,
          wantAmount: 19n,
        }],
      ]),
      pulls: new Map([
        ['pull-positive', {
          tokenId: 3,
          amount: 23n,
          revealedUntilTimestamp: 183_000,
          fullHash: '0x' + '33'.repeat(32),
          partialRoot: '0x' + '44'.repeat(32),
        }],
        ['pull-negative', {
          tokenId: 1,
          amount: -29n,
          revealedUntilTimestamp: 183_000,
          fullHash: '0x' + '55'.repeat(32),
          partialRoot: '0x' + '66'.repeat(32),
        }],
      ]),
      watchSeed: TEST_WATCH_SEED,
    } as any;

    const proof = buildAccountProofBody(accountMachine, DEPOSITORY);
    const allowances = proof.runtimeProofBody.transformers[0]?.allowances;
    expect(allowances).toEqual([
      // Left-sender HTLC (11), maker-left give (17), and negative pull (29)
      // can only move token 1 from left to right: 11 + 17 + 29 = 57.
      { deltaIndex: 0, rightAllowance: 57n, leftAllowance: 0n },
      // Right-sender HTLC (13) and maker-left want (19) move token 2 right→left.
      { deltaIndex: 1, rightAllowance: 0n, leftAllowance: 32n },
      { deltaIndex: 2, rightAllowance: 0n, leftAllowance: 23n },
    ]);
  });

  test('rejects 129-token proof bodies before their hash can be signed', () => {
    const deltas = new Map(
      Array.from({ length: 129 }, (_, index) => [
        index + 1,
        { ondelta: 0n, offdelta: 0n },
      ] as const),
    );

    expect(() => buildAccountProofBody(proofAccount(deltas), '')).toThrow(
      'J_DISPUTE_PROOFBODY_TOKEN_LIMIT:account.signing:129',
    );
  });

  test('rejects 33 transformer clauses before their hash can be signed', () => {
    const account = proofAccount(new Map([[1, { ondelta: 0n, offdelta: 0n }]]));
    account.subcontracts = new Map(Array.from({ length: 33 }, (_, index) => [
      `subcontract-${index.toString().padStart(2, '0')}`,
      {
        transformerAddress: DEPOSITORY,
        encodedBatch: '0x',
        allowances: [],
      },
    ]));

    expect(() => buildAccountProofBody(account, '')).toThrow(
      'J_DISPUTE_PROOFBODY_TRANSFORMER_LIMIT:account.signing:33',
    );
  });

  test('rejects a ProofBody above 176 KiB before its hash can be signed', () => {
    const account = proofAccount(new Map([[1, { ondelta: 0n, offdelta: 0n }]]));
    account.subcontracts = new Map([['oversized', {
      transformerAddress: DEPOSITORY,
      encodedBatch: `0x${'ab'.repeat(177 * 1024)}`,
      allowances: [],
    }]]);

    expect(() => buildAccountProofBody(account, '')).toThrow(
      'J_DISPUTE_PROOFBODY_BYTES_EXCEEDED:account.signing',
    );
  });

  test('rejects ondelta plus offdelta overflow before their hash can be signed', () => {
    const int256Max = (1n << 255n) - 1n;
    const deltas = new Map([[1, { ondelta: int256Max, offdelta: 1n }]]);

    expect(() => buildAccountProofBody(proofAccount(deltas), '')).toThrow(
      'DISPUTE_PROOFBODY_FINAL_DELTA_OVERFLOW:token=1',
    );
  });

  test('rejects int256.min final delta before its hash can be signed', () => {
    const int256Min = -(1n << 255n);
    const deltas = new Map([[1, { ondelta: int256Min, offdelta: 0n }]]);

    expect(() => buildAccountProofBody(proofAccount(deltas), '')).toThrow(
      'DISPUTE_PROOFBODY_FINAL_DELTA_INT256_MIN:token=1',
    );
  });
});
