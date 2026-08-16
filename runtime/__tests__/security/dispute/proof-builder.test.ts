import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  MAX_ACCOUNT_DISPUTE_PROOF_ATOM_BYTES,
  buildAccountProofBody,
  createDisputeProofHash,
  createDisputeProofHashWithNonce,
} from '../../../protocol/dispute/proof-builder';
import { encodeAccountStateValue } from '../../../account/commitment/state-root';
import { proofBodyHasPulls } from '../../../entity/tx/handlers/dispute/start-admission';
import { encodeBuffer } from '../../../storage/codec/codec';

const DEPOSITORY = '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1';
const HANKO_DOMAIN = { chainId: 31337, depositoryAddress: DEPOSITORY } as const;
const PROOF_BODY_HASH = '0x216659016a52d3f9df41568d0c85bd6870ee46705ada7366c9f68d60e0a83548';
const TEST_WATCH_SEED = `0x${'11'.repeat(32)}`;

describe('proof-builder dispute hash', () => {
  const proofAccount = (
    input: Map<number, { ondelta: bigint; offdelta: bigint }> | Record<string, unknown>,
  ) => ({
    state: {
      leftEntity: `0x${'01'.repeat(32)}`,
      rightEntity: `0x${'02'.repeat(32)}`,
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
      watchSeed: TEST_WATCH_SEED,
      disputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
      ...(input instanceof Map ? { deltas: input } : input),
    },
    proofHeader: { nextProofNonce: 1 },
  }) as any;

  const disputeAccount = (leftEntity: string, rightEntity: string) => ({
    state: { leftEntity, rightEntity, watchSeed: TEST_WATCH_SEED },
    proofHeader: { nextProofNonce: 1 },
  });

  const proofWithSameJOffers = (
    count: number,
    pullCount = 0,
    lockCount = 0,
  ) => buildAccountProofBody(proofAccount({
    deltas: new Map([[1, { offdelta: 0n }], [2, { offdelta: 0n }]]),
    locks: new Map(Array.from({ length: lockCount }, (_, index) => [
      `lock-${index}`,
      {
        tokenId: index % 2 === 0 ? 1 : 2,
        senderIsLeft: index % 2 === 0,
        amount: 1n,
        timelock: 100_000n,
        revealBeforeHeight: 100,
        hashlock: `0x${(index + 501).toString(16).padStart(64, '0')}`,
      },
    ])),
    pulls: new Map(Array.from({ length: pullCount }, (_, index) => [
      `pull-${index}`,
      {
        tokenId: 1,
        amount: 1n,
        claimedRatio: 0,
        fullHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
        partialRoot: `0x${(index + 101).toString(16).padStart(64, '0')}`,
        crossJurisdiction: { leg: 'target' },
      },
    ])),
    swapOffers: new Map(Array.from({ length: count }, (_, index) => [
      `offer-${index}`,
      {
        makerIsLeft: index % 2 === 0,
        giveTokenId: index % 2 === 0 ? 1 : 2,
        giveAmount: 1_000n,
        wantTokenId: index % 2 === 0 ? 2 : 1,
        wantAmount: 1_000n,
      },
    ])),
    watchSeed: TEST_WATCH_SEED,
  }), DEPOSITORY);

  test('keeps every growing transformer atom inside the physical storage-row budget', () => {
    const proof = proofWithSameJOffers(20, 18, 32);
    // The complete object exceeds the retired 9 KB pseudo-leaf limit, but it
    // is a Patricia graph whose actual scalar records remain independently
    // storable. This is the exact MM + cross-j combination that wedged H3.
    expect(encodeAccountStateValue(proof.proofBodyStruct).byteLength).toBeGreaterThan(9_000);
    expect(proof.runtimeProofBody.transformers).toHaveLength(3);
    const [paymentClause, marketClause, pullClause] = proof.runtimeProofBody.transformers;
    expect(paymentClause?.batch.payments).toHaveLength(32);
    expect(paymentClause?.batch.swaps).toHaveLength(0);
    expect(paymentClause?.batch.pulls).toHaveLength(0);
    expect(marketClause?.batch.payments).toHaveLength(0);
    expect(marketClause?.batch.swaps).toHaveLength(20);
    expect(marketClause?.batch.pulls).toHaveLength(0);
    expect(pullClause?.batch.payments).toHaveLength(0);
    expect(pullClause?.batch.swaps).toHaveLength(0);
    expect(pullClause?.batch.pulls).toHaveLength(18);
    for (const transformer of proof.proofBodyStruct.transformers) {
      expect(encodeBuffer({ kind: 'atom', value: transformer.encodedBatch }).byteLength)
        .toBeLessThan(MAX_ACCOUNT_DISPUTE_PROOF_ATOM_BYTES);
    }
  });

  test('rejects an oversized signed program before its hash enters consensus', () => {
    expect(() => proofWithSameJOffers(30)).toThrow(
      'ACCOUNT_DISPUTE_PROOF_ATOM_BYTES_EXCEEDED',
    );
  });

  test('uses canonical sorted account key regardless of local left/right orientation', () => {
    const leftOriented = disputeAccount(
      '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
    );
    const rightOriented = disputeAccount(
      leftOriented.state.rightEntity,
      leftOriented.state.leftEntity,
    );

    const sortedKey = ethers.solidityPacked(
      ['bytes32', 'bytes32'],
      [leftOriented.state.leftEntity, leftOriented.state.rightEntity],
    );
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
        [1, HANKO_DOMAIN.chainId, DEPOSITORY, sortedKey, 1, true, PROOF_BODY_HASH, TEST_WATCH_SEED],
      ),
    );

    expect(createDisputeProofHash(leftOriented, PROOF_BODY_HASH, HANKO_DOMAIN, true)).toBe(expected);
    expect(createDisputeProofHash(rightOriented, PROOF_BODY_HASH, HANKO_DOMAIN, true)).toBe(expected);
    expect(createDisputeProofHashWithNonce(leftOriented.state, PROOF_BODY_HASH, HANKO_DOMAIN, 1, true)).toBe(expected);
    expect(createDisputeProofHashWithNonce(rightOriented.state, PROOF_BODY_HASH, HANKO_DOMAIN, 1, true)).toBe(expected);
  });

  test('fails fast when depository address is missing', () => {
    const account = disputeAccount(
      '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
    );
    const missingAddress = { chainId: 31337, depositoryAddress: '' };
    expect(() => createDisputeProofHash(account, PROOF_BODY_HASH, missingAddress, true)).toThrow('INVALID_HANKO_DEPOSITORY_ADDRESS:missing');
    expect(() => createDisputeProofHashWithNonce(account.state, PROOF_BODY_HASH, missingAddress, 1, true)).toThrow(
      'INVALID_HANKO_DEPOSITORY_ADDRESS:missing',
    );
  });

  test('fails fast when the Hanko chain domain is missing', () => {
    const account = disputeAccount(
      '0x1ee7a317604eea0486bd28ef857fa194171f6e844f5933cb13efecf3cd36ec73',
      '0xbf2891acf55a366fb4f28727dfc301b1f5cd70eb0f3b8a029a31b2ac4478e1da',
    );
    expect(() => createDisputeProofHash(
      account,
      PROOF_BODY_HASH,
      { chainId: 0, depositoryAddress: DEPOSITORY },
      true,
    )).toThrow('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
  });

  test('fails fast when transformer address is missing for HTLC/swaps', () => {
    const accountMachine = proofAccount({
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
    });

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow('MISSING_DELTA_TRANSFORMER_ADDRESS');
  });

  test('maps exclusive runtime HTLC expiry to the inclusive Solidity deadline', () => {
    const proofForTimelock = (timelock: bigint) => buildAccountProofBody(proofAccount({
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map([['lock-deadline', {
        tokenId: 1,
        senderIsLeft: true,
        amount: 1n,
        timelock,
        revealBeforeHeight: 123,
        hashlock: `0x${'11'.repeat(32)}`,
      }]]),
    }), DEPOSITORY).runtimeProofBody.transformers[0]?.batch?.payments[0]?.revealedUntilTimestamp;

    expect(proofForTimelock(10_000n)).toBe(9);
    expect(proofForTimelock(10_001n)).toBe(10);
  });

  test('fails fast when an HTLC lock references a token without a delta slot', () => {
    const accountMachine = proofAccount({
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
    });

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow(
      'PROOF_BODY_LOCK_TOKEN_MISSING:lock-missing-token:2',
    );
  });

  test('fails fast when a swap references a token without a delta slot', () => {
    const accountMachine = proofAccount({
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
    });

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow(
      'PROOF_BODY_SWAP_TOKEN_MISSING:swap-missing-token:give=1:want=2',
    );
  });

  test('fails fast when a pull references a token without a delta slot', () => {
    const accountMachine = proofAccount({
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map([
        ['pull-missing-token', {
          tokenId: 2,
          amount: 23n,
          claimedRatio: 0,
          fullHash: '0x' + '33'.repeat(32),
          partialRoot: '0x' + '44'.repeat(32),
        }],
      ]),
      watchSeed: TEST_WATCH_SEED,
    });

    expect(() => buildAccountProofBody(accountMachine, '')).toThrow(
      'PROOF_BODY_PULL_TOKEN_MISSING:pull-missing-token:2',
    );
  });

  test('builds transformer allowances for payments, swaps, and pulls', () => {
    const accountMachine = proofAccount({
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
          fullHash: '0x' + '33'.repeat(32),
          partialRoot: '0x' + '44'.repeat(32),
        }],
        ['pull-negative', {
          tokenId: 1,
          amount: -29n,
          fullHash: '0x' + '55'.repeat(32),
          partialRoot: '0x' + '66'.repeat(32),
        }],
      ]),
      watchSeed: TEST_WATCH_SEED,
    });

    const proof = buildAccountProofBody(accountMachine, DEPOSITORY);
    expect(proof.runtimeProofBody.transformers).toHaveLength(3);
    expect(proof.runtimeProofBody.transformers[0]?.allowances).toEqual([
      { deltaIndex: 0, rightAllowance: 11n, leftAllowance: 0n },
      { deltaIndex: 1, rightAllowance: 0n, leftAllowance: 13n },
    ]);
    expect(proof.runtimeProofBody.transformers[1]?.allowances).toEqual([
      { deltaIndex: 0, rightAllowance: 17n, leftAllowance: 0n },
      { deltaIndex: 1, rightAllowance: 0n, leftAllowance: 19n },
    ]);
    expect(proof.runtimeProofBody.transformers[2]?.allowances).toEqual([
      { deltaIndex: 0, rightAllowance: 29n, leftAllowance: 0n },
      { deltaIndex: 2, rightAllowance: 0n, leftAllowance: 23n },
    ]);
  });

  test('encodes source vs target registry roles on pulls', () => {
    const accountMachine = proofAccount({
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map([
        ['source-pull', {
          tokenId: 1,
          amount: 11n,
          claimedRatio: 0,
          fullHash: '0x' + '11'.repeat(32),
          partialRoot: '0x' + '22'.repeat(32),
          crossJurisdiction: {
            orderId: 'order-1',
            routeHash: '0x' + 'aa'.repeat(32),
            leg: 'source',
          },
        }],
        ['target-pull', {
          tokenId: 1,
          amount: -13n,
          claimedRatio: 0,
          fullHash: '0x' + '33'.repeat(32),
          partialRoot: '0x' + '44'.repeat(32),
          crossJurisdiction: {
            orderId: 'order-1',
            routeHash: '0x' + 'aa'.repeat(32),
            leg: 'target',
          },
        }],
      ]),
      watchSeed: TEST_WATCH_SEED,
    });

    const proof = buildAccountProofBody(accountMachine, DEPOSITORY);
    const pulls = proof.runtimeProofBody.transformers[0]?.batch?.pulls ?? [];
    const byHash = new Map(pulls.map(pull => [pull.fullHash.toLowerCase(), pull]));
    expect(byHash.get(('0x' + '11'.repeat(32)).toLowerCase())?.targetRole).toBe(false);
    expect(byHash.get(('0x' + '33'.repeat(32)).toLowerCase())?.targetRole).toBe(true);
    expect(proof.proofBodyStruct.leftResponseSeconds).toBe(3_600);
    expect(proof.proofBodyStruct.rightResponseSeconds).toBe(86_400);
  });

  test('classifies pulls only for the canonical DeltaTransformer and fails loud on malformed canonical bytes', () => {
    const accountMachine = proofAccount({
      deltas: new Map([[1, { offdelta: 0n }]]),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map([['pull', {
        tokenId: 1,
        amount: 11n,
        claimedRatio: 0,
        fullHash: `0x${'77'.repeat(32)}`,
        partialRoot: `0x${'88'.repeat(32)}`,
      }]]),
      watchSeed: TEST_WATCH_SEED,
    });
    const proof = buildAccountProofBody(accountMachine, DEPOSITORY).proofBodyStruct;
    expect(proofBodyHasPulls(proof, DEPOSITORY)).toBe(true);

    const customAddress = `0x${'99'.repeat(20)}`;
    const customOnly = {
      ...proof,
      transformers: proof.transformers.map((transformer) => ({
        ...transformer,
        transformerAddress: customAddress,
      })),
    };
    expect(proofBodyHasPulls(customOnly, DEPOSITORY)).toBe(false);

    const malformedCanonical = {
      ...proof,
      transformers: [{
        ...proof.transformers[0]!,
        encodedBatch: '0x1234',
      }],
    };
    expect(() => proofBodyHasPulls(malformedCanonical, DEPOSITORY)).toThrow(
      'DISPUTE_CANONICAL_DELTA_BATCH_INVALID:0',
    );
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
    account.state.subcontracts = new Map(Array.from({ length: 33 }, (_, index) => [
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
    account.state.subcontracts = new Map([['oversized', {
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
