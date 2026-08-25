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
import { resolveRscoreWaveAccount } from '../../rscore/checkpoint/wave-checkpoint-decode';

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
      null,
      committedFrameEvidence(frameStateHash, true),
      ['\u{1F91D} Accepted frame 1 from Entity 2222'],
      null,
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
      ['\u2705 Frame 1 confirmed and committed'],
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

  test('decodes one atomic frame-ACK result with ordered outputs and both committed frames', () => {
    const raw = rawWave();
    const ackStateHash = bytes(32, 0x66);
    const frameStateHash = bytes(32, 0x77);
    requiredAt(raw[2] as RscoreWireValue[][], 0, 'FRAME_ACK_APPLIED')[2] = [
      9,
      [
        5,
        1,
        ackStateHash,
        [
          [4, 'ack-remove'],
          [1, 'ack-lock', 'ack-hashlock', 'ack-secret', 7, '12'],
        ],
        committedFrameEvidence(ackStateHash, false),
        ['\u2705 Frame 1 confirmed and committed'],
      ],
      [
        0,
        1,
        frameStateHash,
        bytes(65, 0x55),
        [
          [5, 'frame-cancel'],
          [2, 'frame-lock', 'frame-hashlock', 8, '13', 'frame-error'],
        ],
        [1, 4, 2],
        committedFrameEvidence(frameStateHash, true),
        [],
        null,
      ],
    ];

    const wave = decodeWave(withParityDigest(raw));
    expect(wave.applied).toHaveLength(1);
    const verdict = wave.applied[0]?.verdict;
    if (verdict?.kind !== 'frameAckApplied') throw new Error('RSCORE_TEST_EXPECTED_FRAME_ACK_APPLIED');
    expect(verdict.ackVerdict).toMatchObject({
      kind: 'ackCommitted',
      height: 1,
      stateHash: hex(32, 0x66),
      committedFrame: {
        committedViaNewFrame: false,
        frame: { height: 1, stateHash: hex(32, 0x66), accountTxs: [] },
      },
    });
    expect(verdict.frameVerdict).toMatchObject({
      kind: 'frameCommitted',
      height: 1,
      stateHash: hex(32, 0x77),
      rolledBack: { height: 1, restored: 4, proposed: 2 },
      committedFrame: {
        committedViaNewFrame: true,
        frame: { height: 1, stateHash: hex(32, 0x77), accountTxs: [] },
      },
    });
    if (verdict.ackVerdict.kind !== 'ackCommitted') {
      throw new Error('RSCORE_TEST_EXPECTED_FRAME_ACK_ACK_COMMIT');
    }
    if (verdict.frameVerdict.kind !== 'frameCommitted') {
      throw new Error('RSCORE_TEST_EXPECTED_FRAME_ACK_FRAME_COMMIT');
    }
    expect(verdict.ackVerdict.outputs).toEqual([
      { kind: 'swapOfferRemove', offerId: 'ack-remove' },
      {
        kind: 'htlcSecret',
        lockId: 'ack-lock',
        hashlock: 'ack-hashlock',
        secret: 'ack-secret',
        tokenId: 7,
        amount: '12',
      },
    ]);
    expect(verdict.frameVerdict.outputs).toEqual([
      { kind: 'swapCancelRequest', offerId: 'frame-cancel' },
      {
        kind: 'htlcError',
        lockId: 'frame-lock',
        hashlock: 'frame-hashlock',
        tokenId: 8,
        amount: '13',
        reason: 'frame-error',
      },
    ]);
    expect(waveParityDigest(wave)).toBe(wave.parityDigest);
  });

  test('decodes atomic frame-ACK rejection phases by name', () => {
    for (const [phaseTag, phase] of [[0, 'ack'], [1, 'frame']] as const) {
      const raw = rawWave();
      requiredAt(raw[2] as RscoreWireValue[][], 0, `FRAME_ACK_REJECTED_${phase}`)[2] = [
        10,
        phaseTag,
        `${phase} rejected`,
      ];
      expect(decodeWave(withParityDigest(raw)).applied[0]?.verdict).toEqual({
        kind: 'frameAckRejected',
        phase,
        reason: `${phase} rejected`,
      });
    }
  });

  test('rejects malformed or out-of-domain frame-ACK child verdicts', () => {
    const rejects = (
      verdict: RscoreWireValue[],
      message: string,
    ): void => {
      const raw = rawWave();
      requiredAt(raw[2] as RscoreWireValue[][], 0, 'BAD_FRAME_ACK')[2] = verdict;
      expect(() => decodeWave(raw)).toThrow(message);
    };

    rejects([9, [0], [4, 'frame rejected']], 'ackVerdict.tag:0:ackDomain');
    rejects([9, [6, 1], [5]], 'frameVerdict.tag:5:frameDomain');
    rejects([9, [6, 1, 2], [4, 'frame rejected']], 'ackStale:arity:3:2');
    rejects([9, [6, 1], [4]], 'rejected:arity:1:2');
    rejects([9, [8, 'failed child'], [4, 'frame rejected']], 'ackVerdict.tag:8:ackDomain');
    rejects([9, [6, 1], [8, 'failed child']], 'frameVerdict.tag:8:frameDomain');
    rejects([9, [9, [6, 1], [4, 'nested']], [4, 'frame rejected']], 'ackVerdict.tag:9:ackDomain');
    rejects([9, [6, 1], [10, 1, 'nested']], 'frameVerdict.tag:10:frameDomain');
    rejects([9, [11], [4, 'frame rejected']], 'ackVerdict.tag:11:ackDomain');
    rejects([9, [6, 1]], 'frameAckApplied:arity:2:3');
    rejects([10, 2, 'bad phase'], 'frameAckRejected.phase:2');
  });

  test('binds both frame-ACK children into the parity digest', () => {
    const withFrameAck = (ackHeight: number, currentFrameHeight: number): RscoreWireValue[] => {
      const raw = rawWave();
      requiredAt(raw[2] as RscoreWireValue[][], 0, 'FRAME_ACK_DIGEST')[2] = [
        9,
        [6, ackHeight],
        [3, 1, currentFrameHeight],
      ];
      return raw;
    };
    const original = withFrameAck(1, 2);
    const changedAck = withFrameAck(2, 2);
    const changedFrame = withFrameAck(1, 3);
    expect(waveParityDigestFromWireForTests(original))
      .not.toBe(waveParityDigestFromWireForTests(changedAck));
    expect(waveParityDigestFromWireForTests(original))
      .not.toBe(waveParityDigestFromWireForTests(changedFrame));

    const signed = withParityDigest(withFrameAck(1, 2));
    const applied = requiredAt(signed[2] as RscoreWireValue[][], 0, 'SIGNED_FRAME_ACK');
    ((applied[2] as RscoreWireValue[])[1] as RscoreWireValue[])[1] = 2;
    expect(() => decodeWave(signed)).toThrow('wave.parityDigest');
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
      null,
      committedFrameEvidence(stateHash, false),
      [],
      null,
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
    const resolve = (raw: RscoreWireValue[]): void => {
      const wave = decodeWave(withParityDigest(raw));
      const post = requiredAt(wave.postAccounts, 0, 'RESOLVE_POST');
      resolveRscoreWaveAccount(post, null);
    };

    const wrongCount = rawWave();
    const post = requiredAt(wrongCount[6] as RscoreWireValue[][], 0, 'WRONG_COUNT_POST');
    (((post[3] as RscoreWireValue[])[0] as RscoreWireValue[]))[1] = 1;
    expect(() => resolve(wrongCount)).toThrow('postAccount.deltas.tree:leafCount');

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
    expect(() => resolve(wrongRoot)).toThrow('postAccount.deltas.tree:root');

    const changedHeader = rawWave();
    installDeltaSnapshot(changedHeader);
    const changedHeaderRow = requiredAt(
      changedHeader[6] as RscoreWireValue[][],
      0,
      'CHANGED_HEADER_POST',
    )[2] as RscoreWireValue[];
    changedHeaderRow[4] = 1;
    expect(() => resolve(changedHeader)).toThrow('ACCOUNT_LEAF_MISMATCH');

    const changedConsensus = rawWave();
    installDeltaSnapshot(changedConsensus);
    const changedConsensusRow = requiredAt(
      changedConsensus[6] as RscoreWireValue[][],
      0,
      'CHANGED_CONSENSUS_POST',
    )[9] as RscoreWireValue[];
    changedConsensusRow[3] = 1;
    expect(() => resolve(changedConsensus)).toThrow('ACCOUNT_LEAF_MISMATCH');

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
