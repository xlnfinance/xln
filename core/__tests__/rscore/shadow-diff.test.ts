import { describe, expect, test } from 'bun:test';

import { engineOutputProjection, findFirstShadowDifference } from '../../rscore/shadow';

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

  test('decodes the finalized Account-settlement effect emitted by Rust', () => {
    const accountId = new Uint8Array(32).fill(7);
    expect(engineOutputProjection([
      [0, 0, accountId, [6, 1, 26, '100', '-2']],
    ], Buffer.from(accountId).toString('hex'))).toEqual([
      [0, 0, ['accountSettledFinalized', 1, 26, '100', '-2']],
    ]);
  });
});
