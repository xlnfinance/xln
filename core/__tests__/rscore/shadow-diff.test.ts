import { describe, expect, test } from 'bun:test';

import { findFirstShadowDifference } from '../../rscore/shadow';

describe('rscore shadow first divergence', () => {
  test('names the first nested output field deterministically', () => {
    const typescript = [['forward', 1, '10'], ['secret', 'lock-1', '0xaa', 'left']];
    const rust = [['forward', 1, '10'], ['secret', 'lock-1', '0xaa', 'right']];

    expect(findFirstShadowDifference(typescript, rust, '$.outputs')).toEqual({
      path: '$.outputs[1][3]',
      reason: 'value-mismatch',
    });
  });

  test('names a missing output row without dumping the whole batch', () => {
    expect(findFirstShadowDifference([['ack']], [['ack'], ['proposal']], '$.outputs')).toEqual({
      path: '$.outputs[1]',
      reason: 'missing-typescript',
    });
  });
});
