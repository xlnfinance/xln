import { describe, expect, test } from 'bun:test';

import {
  assertRscoreCheckpointCandidate,
  decodeRscoreCheckpointChanges,
  type RscoreCheckpointToken,
} from '../../rscore/checkpoint-wire';

const root = Buffer.alloc(32, 0x31);
const signer = Buffer.alloc(32, 0x42);

const token = (
  baseRevision: number,
  revision: number,
  accountsRoot: Uint8Array = root,
  accountCount = 1,
): RscoreCheckpointToken => [baseRevision, revision, accountsRoot, signer, accountCount];

describe('rscore checkpoint wire', () => {
  test('rejects a checkpoint that regresses its durable revision', () => {
    expect(() => decodeRscoreCheckpointChanges([
      token(10, 9),
      token(9, 9),
      [],
      [],
    ])).toThrow('RSCORE_CHECKPOINT_TOKEN_RELATION');

    expect(() => decodeRscoreCheckpointChanges([
      token(10, 10),
      token(10, 10),
      [],
      [],
    ])).not.toThrow();
  });

  test('binds the durable checkpoint to the exact prepared candidate', () => {
    const checkpoint = decodeRscoreCheckpointChanges([
      token(3, 4),
      token(4, 4),
      [],
      [],
    ]);
    const expected = {
      revision: 4,
      accountsRoot: `0x${root.toString('hex')}`,
      accountCount: 1,
    };
    expect(() => assertRscoreCheckpointCandidate(checkpoint, expected)).not.toThrow();
    expect(() => assertRscoreCheckpointCandidate(checkpoint, {
      ...expected,
      revision: 5,
    })).toThrow('RSCORE_CHECKPOINT_CANDIDATE_MISMATCH');
    expect(() => assertRscoreCheckpointCandidate(checkpoint, {
      ...expected,
      accountsRoot: `0x${'ff'.repeat(32)}`,
    })).toThrow('RSCORE_CHECKPOINT_CANDIDATE_MISMATCH');
    expect(() => assertRscoreCheckpointCandidate(checkpoint, {
      ...expected,
      accountCount: 2,
    })).toThrow('RSCORE_CHECKPOINT_CANDIDATE_MISMATCH');
  });
});
