import { describe, expect, test } from 'bun:test';

import {
  formatExclusiveSampling,
  summarizeExclusiveSampling,
} from '../../../support/performance/sampling-summary';

describe('exclusive sampling summary', () => {
  test('every sample lands in exactly one bucket and percents sum to 100', () => {
    const summary = summarizeExclusiveSampling({
      sources: [{ sourceID: 1, url: '/Users/zigota/xln/core/runtime/frame.ts' }],
      traces: [
        { frames: [{ name: 'samplingProfilerStackTraces' }, { name: 'applyFrame', sourceID: 1, line: 40 }] },
        { frames: [{ name: 'applyFrame', sourceID: 1, line: 40 }] },
        { frames: [{ name: 'encodeUncached', sourceURL: '/Users/zigota/xln/core/protocol/serialization/canonical-consensus-value.ts', line: 116 }] },
        { frames: [] },
      ],
    }, 10);
    expect(summary.samples).toBe(4);
    expect(summary.counted).toBe(4);
    const percentSum = summary.buckets.reduce((sum, bucket) => sum + bucket.percent, 0);
    expect(percentSum).toBeCloseTo(100, 6);
    expect(summary.buckets[0]?.label).toContain('applyFrame');
    expect(summary.buckets.some(bucket => bucket.label === '(empty)')).toBe(true);
    expect(formatExclusiveSampling(summary).join('\n')).toContain('exclusive-sum=4');
  });
});
