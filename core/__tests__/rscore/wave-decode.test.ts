import { describe, expect, test } from 'bun:test';

import type { RscoreWireValue } from '../../rscore/client';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import {
  computeCanonicalMerkleRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
} from '../../account/commitment/state-root';
import { computeEntityAccountLeafDigest } from '../../entity/consensus/state-root';
import {
  createEmptyAccountJClaimAccumulator,
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
} from '../../account/j-claims/j-claim-accumulator';
import {
  decodeWave,
  waveParityDigest,
  waveParityDigestFromWireForTests,
} from '../../rscore/wave-decode';

const bytes = (length: number, fill: number): Buffer => Buffer.alloc(length, fill);
const hex = (length: number, fill: number): string => `0x${fill.toString(16).padStart(2, '0').repeat(length)}`;

const requiredAt = <T>(values: readonly T[], index: number, field: string): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`RSCORE_TEST_MISSING_${field}:${index}`);
  return value;
};

const emptyHeader = (): RscoreWireValue[] => [
  bytes(32, 0x11),
  'h1-hub',
  [1, bytes(20, 0x44), bytes(32, 0x11), bytes(32, 0x22), bytes(32, 0x33)],
  [60, 120],
  0,
  0,
  [
    bytes(32, 0),
    bytes(32, 0),
    bytes(32, 0),
    bytes(32, 0),
    [Buffer.from(EMPTY_ACCOUNT_J_CLAIM_ROOT.slice(2), 'hex'), 0],
    [Buffer.from(EMPTY_ACCOUNT_J_CLAIM_ROOT.slice(2), 'hex'), 0],
  ],
  [[8, []], []],
  null,
];

const emptyConsensus = (): RscoreWireValue[] => [
  [], null, null, 0, null, null, null, null, null, 0, null,
];

const emptyPostAccount = (
  accountId: Buffer,
  leaf: Buffer,
): RscoreWireValue[] => {
  const descriptor: RscoreWireValue = [bytes(32, 0), 0];
  const changes: RscoreWireValue = [[], []];
  return [
    accountId,
    leaf,
    emptyHeader(),
    [descriptor, descriptor, descriptor, descriptor, descriptor],
    changes,
    changes,
    changes,
    changes,
    changes,
    emptyConsensus(),
  ];
};

const accountStateRoot = (
  deltasRoot = EMPTY_ACCOUNT_STATE_ROOT,
): string => computeCanonicalMerkleRoot(
  'account.state',
  [
    ['identity', {
      chainId: 1,
      depositoryAddress: hex(20, 0x44),
      leftEntity: hex(32, 0x11),
      rightEntity: hex(32, 0x22),
      watchSeed: hex(32, 0x33),
    }],
    ['financial', {
      deltasRoot,
      jNonce: 0,
      disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 120 },
    }],
    ['commitments', {
      locksRoot: EMPTY_ACCOUNT_STATE_ROOT,
      pullsRoot: EMPTY_ACCOUNT_STATE_ROOT,
      swapOffersRoot: EMPTY_ACCOUNT_STATE_ROOT,
      subcontractsRoot: EMPTY_ACCOUNT_STATE_ROOT,
      lendingIntentsRoot: EMPTY_ACCOUNT_STATE_ROOT,
    }],
    ['jurisdiction', {
      lastFinalizedJHeight: 0,
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    }],
    ['rebalance', {
      requestedRebalanceRoot: EMPTY_ACCOUNT_STATE_ROOT,
      requestedRebalanceFeeStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
      rebalanceFeePoliciesRoot: EMPTY_ACCOUNT_STATE_ROOT,
    }],
  ],
  'integrity',
);

const entityAccountLeaf = (
  deltasRoot = EMPTY_ACCOUNT_STATE_ROOT,
): string => computeEntityAccountLeafDigest(Object.entries({
  currentHeight: 0,
  rollbackCount: 0,
  currentFrameHash: '',
  proofHeader: {
    fromEntity: hex(32, 0x11),
    toEntity: hex(32, 0x22),
    nextProofNonce: 0,
  },
  accountStateRoot: accountStateRoot(deltasRoot),
  mempoolRoot: EMPTY_ACCOUNT_STATE_ROOT,
}));

const rawWave = (): RscoreWireValue[] => {
  const accountId = bytes(32, 0x22);
  const leaf = Buffer.from(entityAccountLeaf().slice(2), 'hex');
  return [
    4,
    bytes(32, 0x66),
    [[2, accountId, [8, 'missing account']]],
    [[1, accountId, [0, 2]]],
    [],
    [[accountId, leaf]],
    [emptyPostAccount(accountId, leaf)],
    bytes(32, 0),
    17,
  ];
};

const committedFrameEvidence = (
  stateHash: Buffer,
  committedViaNewFrame: boolean,
): RscoreWireValue => [[
  1,
  1_700_000_000_000,
  100,
  [],
  'genesis',
  bytes(32, 0x33),
  true,
  [],
  stateHash,
], committedViaNewFrame];

const withParityDigest = (raw: RscoreWireValue[]): RscoreWireValue[] => {
  raw[7] = Buffer.from(waveParityDigestFromWireForTests(raw).slice(2), 'hex');
  return raw;
};

const deltaSnapshot = (): Readonly<{
  descriptor: RscoreWireValue;
  changes: RscoreWireValue;
}> => {
  const delta = {
    tokenId: 1,
    collateral: 10n,
    ondelta: 0n,
    offdelta: 0n,
    leftCreditLimit: 0n,
    rightCreditLimit: 0n,
    leftAllowance: 0n,
    rightAllowance: 0n,
    leftHold: 0n,
    rightHold: 0n,
  };
  const tree = PersistentAccountStateMap.fromEntries('deltas', [[delta.tokenId, delta]]);
  const puts: RscoreWireValue[] = [...tree.nodeRecords()].map(record =>
    record.kind === 'branch'
      ? [
          0,
          Buffer.from(record.path),
          record.children.map(child => [
            child.slot,
            child.kind === 'branch' ? 0 : 1,
            Buffer.from(child.path),
            Buffer.from(child.edgeHash.slice(2), 'hex'),
          ]),
        ]
      : [
          1,
          Buffer.from(record.path),
          Buffer.from(record.keyBytes),
          [
            record.value.tokenId,
            record.value.collateral.toString(),
            record.value.ondelta.toString(),
            record.value.offdelta.toString(),
            record.value.leftCreditLimit.toString(),
            record.value.rightCreditLimit.toString(),
            record.value.leftAllowance.toString(),
            record.value.rightAllowance.toString(),
            record.value.leftHold.toString(),
            record.value.rightHold.toString(),
          ],
        ],
  );
  return {
    descriptor: [Buffer.from(tree.rootHash().slice(2), 'hex'), tree.size],
    changes: [puts, []],
  };
};

const installDeltaSnapshot = (raw: RscoreWireValue[]): void => {
  const post = requiredAt(raw[6] as RscoreWireValue[][], 0, 'POST_ACCOUNT');
  const snapshot = deltaSnapshot();
  (post[3] as RscoreWireValue[])[0] = snapshot.descriptor;
  post[4] = snapshot.changes;
  const root = `0x${Buffer.from((snapshot.descriptor as RscoreWireValue[])[0] as Uint8Array).toString('hex')}`;
  const leaf = Buffer.from(entityAccountLeaf(root).slice(2), 'hex');
  post[1] = leaf;
  requiredAt(raw[5] as RscoreWireValue[][], 0, 'TOUCHED_ACCOUNT')[1] = leaf;
};

describe('rscore staged wave decoder', () => {
  test('decodes admissions, operation indices and full checkpoint node rows', () => {
    const raw = rawWave();
    installDeltaSnapshot(raw);
    const wave = decodeWave(withParityDigest(raw));

    expect(wave.applied[0]).toEqual({
      operationIndex: 2,
      accountId: `0x${'22'.repeat(32)}`,
      verdict: { kind: 'failed', message: 'missing account' },
    });
    expect(wave.admissions[0]).toEqual({
      operationIndex: 1,
      accountId: `0x${'22'.repeat(32)}`,
      verdict: { kind: 'admitted', count: 2 },
    });
    expect(wave.postAccounts[0]?.sections.deltas.leafCount).toBe(1);
    expect(wave.postAccounts[0]?.nodeChanges.deltas.puts.find(row => row.kind === 'leaf'))
      .toMatchObject({
        kind: 'leaf',
        key: Buffer.concat([Buffer.alloc(31), Buffer.from([1])]),
        value: [1, '10', '0', '0', '0', '0', '0', '0', '0', '0'],
      });
    expect(waveParityDigest(wave)).toBe(wave.parityDigest);
  });

  test('decodes a rejected admission without parsing its message', () => {
    const raw = rawWave();
    const admission = requiredAt(raw[3] as RscoreWireValue[][], 0, 'ADMISSION');
    admission[2] = [
      1,
      'ACCOUNT_ADMISSION_REJECTED',
      'exact engine message',
    ];
    expect(decodeWave(withParityDigest(raw)).admissions[0]?.verdict).toEqual({
      kind: 'rejected',
      code: 'ACCOUNT_ADMISSION_REJECTED',
      message: 'exact engine message',
    });
  });

  test('carries exact committed frames and distinguishes peer-frame from ACK commits', () => {
    const frameCommit = rawWave();
    const frameStateHash = bytes(32, 0x44);
    requiredAt(frameCommit[2] as RscoreWireValue[][], 0, 'FRAME_COMMIT')[2] = [
      0,
      1,
      frameStateHash,
      bytes(65, 0x55),
      [],
      0,
      committedFrameEvidence(frameStateHash, true),
    ];
    const frameVerdict = decodeWave(withParityDigest(frameCommit)).applied[0]?.verdict;
    expect(frameVerdict).toMatchObject({
      kind: 'frameCommitted',
      height: 1,
      stateHash: hex(32, 0x44),
      committedFrame: {
        committedViaNewFrame: true,
        frame: { height: 1, stateHash: hex(32, 0x44), accountTxs: [] },
      },
    });

    const ackCommit = rawWave();
    const ackStateHash = bytes(32, 0x66);
    requiredAt(ackCommit[2] as RscoreWireValue[][], 0, 'ACK_COMMIT')[2] = [
      5,
      1,
      ackStateHash,
      [],
      committedFrameEvidence(ackStateHash, false),
    ];
    const ackVerdict = decodeWave(withParityDigest(ackCommit)).applied[0]?.verdict;
    expect(ackVerdict).toMatchObject({
      kind: 'ackCommitted',
      height: 1,
      stateHash: hex(32, 0x66),
      committedFrame: {
        committedViaNewFrame: false,
        frame: { height: 1, stateHash: hex(32, 0x66), accountTxs: [] },
      },
    });
  });

  test('rejects committed-frame evidence not bound to its verdict', () => {
    const raw = rawWave();
    const stateHash = bytes(32, 0x44);
    requiredAt(raw[2] as RscoreWireValue[][], 0, 'UNBOUND_COMMIT')[2] = [
      0,
      1,
      stateHash,
      bytes(65, 0x55),
      [],
      0,
      committedFrameEvidence(stateHash, false),
    ];
    expect(() => decodeWave(withParityDigest(raw))).toThrow('committedFrame.binding');
  });

  test('rejects old replies, duplicate operation indices and malformed admission tags', () => {
    expect(() => decodeWave(rawWave().slice(0, 7))).toThrow('wave:arity:7:9');

    const duplicate = rawWave();
    requiredAt(duplicate[2] as RscoreWireValue[][], 0, 'APPLIED')[0] = 1;
    expect(() => decodeWave(duplicate)).toThrow('wave.operationIndex:duplicate');

    const badAdmission = rawWave();
    const badAdmissionVerdict = requiredAt(
      badAdmission[3] as RscoreWireValue[][],
      0,
      'BAD_ADMISSION',
    )[2] as RscoreWireValue[];
    badAdmissionVerdict[0] = 7;
    expect(() => decodeWave(badAdmission)).toThrow('admissionResult.verdict.tag:7');

    const corruptDigest = withParityDigest(rawWave());
    corruptDigest[7] = bytes(32, 0xff);
    expect(() => decodeWave(corruptDigest)).toThrow('wave.parityDigest');
  });

  test('rejects partial, deleting or unbound post-account snapshots', () => {
    const wrongCount = rawWave();
    const post = requiredAt(wrongCount[6] as RscoreWireValue[][], 0, 'WRONG_COUNT_POST');
    (((post[3] as RscoreWireValue[])[0] as RscoreWireValue[]))[1] = 1;
    expect(() => decodeWave(wrongCount)).toThrow('postAccount.deltas.leafCount');

    const deleting = rawWave();
    const deletingPost = requiredAt(deleting[6] as RscoreWireValue[][], 0, 'DELETING_POST');
    (deletingPost[4] as RscoreWireValue[])[1] = [[0, Buffer.alloc(0)]];
    expect(() => decodeWave(deleting)).toThrow('postAccount.deltas.dels:nonempty');

    const unbound = rawWave();
    requiredAt(unbound[5] as RscoreWireValue[][], 0, 'UNBOUND_TOUCHED')[1] = bytes(32, 0xaa);
    expect(() => decodeWave(unbound)).toThrow('wave.postAccounts:binding:0');

    const badPath = rawWave();
    const badPathPost = requiredAt(badPath[6] as RscoreWireValue[][], 0, 'BAD_PATH_POST');
    ((badPathPost[3] as RscoreWireValue[])[0] as RscoreWireValue[])[1] = 1;
    (badPathPost[4] as RscoreWireValue[])[0] = [[1, Buffer.from([16]), Buffer.from([1]), [1]]];
    expect(() => decodeWave(badPath)).toThrow('postAccount.deltas.put.0.path:slot:16');

    const wrongRoot = rawWave();
    installDeltaSnapshot(wrongRoot);
    const wrongRootPost = requiredAt(wrongRoot[6] as RscoreWireValue[][], 0, 'WRONG_ROOT_POST');
    ((wrongRootPost[3] as RscoreWireValue[])[0] as RscoreWireValue[])[0] = bytes(32, 0xaa);
    expect(() => decodeWave(wrongRoot)).toThrow('postAccount.deltas.tree:root');

    const wrongEdge = rawWave();
    installDeltaSnapshot(wrongEdge);
    const wrongEdgePost = requiredAt(wrongEdge[6] as RscoreWireValue[][], 0, 'WRONG_EDGE_POST');
    const puts = requiredAt(wrongEdgePost[4] as RscoreWireValue[][], 0, 'WRONG_EDGE_PUTS');
    const branch = puts.find(row => row[0] === 0);
    if (branch === undefined) throw new Error('RSCORE_TEST_MISSING_WRONG_EDGE_BRANCH');
    requiredAt(branch[2] as RscoreWireValue[][], 0, 'WRONG_EDGE_CHILD')[3] = bytes(32, 0xbb);
    expect(() => decodeWave(wrongEdge)).toThrow('PERSISTENT_RADIX_EDGE_HASH_MISMATCH');

    const changedHeader = rawWave();
    const changedHeaderRow = requiredAt(
      changedHeader[6] as RscoreWireValue[][],
      0,
      'CHANGED_HEADER_POST',
    )[2] as RscoreWireValue[];
    changedHeaderRow[4] = 1;
    expect(() => decodeWave(changedHeader)).toThrow('ACCOUNT_LEAF_MISMATCH');

    const changedConsensus = rawWave();
    const changedConsensusRow = requiredAt(
      changedConsensus[6] as RscoreWireValue[][],
      0,
      'CHANGED_CONSENSUS_POST',
    )[9] as RscoreWireValue[];
    changedConsensusRow[3] = 1;
    expect(() => decodeWave(changedConsensus)).toThrow('ACCOUNT_LEAF_MISMATCH');

    const reversedParties = rawWave();
    const reversedHeader = requiredAt(
      reversedParties[6] as RscoreWireValue[][],
      0,
      'REVERSED_PARTIES_POST',
    )[2] as RscoreWireValue[];
    const identity = reversedHeader[2] as RscoreWireValue[];
    const left = requiredAt(identity, 2, 'REVERSED_LEFT');
    const right = requiredAt(identity, 3, 'REVERSED_RIGHT');
    identity[2] = right;
    identity[3] = left;
    expect(() => decodeWave(reversedParties)).toThrow('postAccount.header.parties:order');
  });
});
