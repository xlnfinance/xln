import { describe, expect, test } from 'bun:test';

import {
  engineOutputProjection,
  findFirstShadowDifference,
  findShadowEnvelopeDifference,
} from '../../rscore/shadow';

describe('rscore shadow first divergence', () => {
  test('names the first nested output field deterministically', () => {
    const typescript = [['forward', 1, '10'], ['offerUpsert', 'offer-1', 'left']];
    const rust = [['forward', 1, '10'], ['offerUpsert', 'offer-1', 'right']];

    expect(findFirstShadowDifference(typescript, rust, '$.outputs')).toEqual({
      path: '$.outputs[1][2]',
      reason: 'value-mismatch',
      typescript: { type: 'string', value: '"left"', totalChars: 6 },
      rust: { type: 'string', value: '"right"', totalChars: 7 },
    });
  });

  test('names a missing output row without dumping the whole batch', () => {
    expect(findFirstShadowDifference([['ack']], [['ack'], ['proposal']], '$.outputs')).toEqual({
      path: '$.outputs[1]',
      reason: 'missing-typescript',
      typescript: { type: 'missing', value: '<missing>', totalChars: 0 },
      rust: { type: 'array', value: '["proposal"]', totalChars: 12 },
    });
  });

  test('redacts a mismatched secret before returning its value preview', () => {
    const difference = findFirstShadowDifference(
      [['secret', 'lock-1', '0xaa', 'typescript-preimage']],
      [['secret', 'lock-1', '0xaa', 'rust-preimage']],
      '$.outputs',
    );

    expect(difference?.path).toBe('$.outputs[0][3]');
    expect(difference?.typescript.value).not.toContain('typescript-preimage');
    expect(difference?.rust.value).not.toContain('rust-preimage');
  });

  test('reports the semantic field before derived root noise', () => {
    const difference = findFirstShadowDifference(
      { accountStateRoot: '0xaa', status: 'active' },
      { accountStateRoot: '0xbb', status: 'disputed' },
      '$.account',
    );

    expect(difference?.path).toBe('$.account.status');
  });

  test('decodes canonical envelope tags so the diff names the replica field', () => {
    const difference = findShadowEnvelopeDifference(
      [
        ['status', [4, 'active']],
        ['pendingFrame', [8, [['height', [2, '4']], ['txs', [5, [[8, [['type', [4, 'directPayment']]]]]]]]]],
      ],
      [
        ['status', [4, 'active']],
        ['pendingFrame', [8, [['height', [2, '4']], ['txs', [5, [[8, [['type', [4, 'htlcLock']]]]]]]]]],
      ],
    );

    expect(difference?.firstDifference.path)
      .toBe('$.accountEnvelope.pendingFrame.txs[0].type');
    expect(difference?.firstDifference.typescript.value).toBe('"directPayment"');
    expect(difference?.firstDifference.rust.value).toBe('"htlcLock"');
  });

  test('reports a missing canonical envelope field by name', () => {
    const difference = findShadowEnvelopeDifference(
      [['status', [4, 'active']], ['currentHeight', [2, '5']]],
      [['status', [4, 'active']]],
    );

    expect(difference?.firstDifference).toMatchObject({
      path: '$.accountEnvelope.currentHeight',
      reason: 'missing-rust',
    });
  });

  test('decodes the finalized Account-settlement effect emitted by Rust', () => {
    const accountId = new Uint8Array(32).fill(7);
    expect(engineOutputProjection([
      [0, 0, accountId, [6, 1, 26, '100', '-2']],
    ], Buffer.from(accountId).toString('hex'))).toEqual([
      [0, 0, ['accountSettledFinalized', 1, 26, '100', '-2']],
    ]);
  });
});
