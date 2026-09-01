import { describe, expect, test } from 'bun:test';

import { compareStableText } from '../../protocol/serialization';

describe('canonical text ordering', () => {
  test('matches Rust UTF-16 ordering for non-ASCII and supplementary characters', () => {
    const values = ['\ue000', '\u{10000}', 'é', 'z'];
    expect(values.sort(compareStableText)).toEqual(['z', 'é', '\u{10000}', '\ue000']);
  });
});
