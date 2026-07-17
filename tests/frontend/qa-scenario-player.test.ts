import { describe, expect, test } from 'bun:test';
import {
  buildQaScenarioCues,
  qaScenarioFailureCueIndex,
  type QaScenarioShardLike,
} from '../../frontend/src/lib/qa/scenarioPlayer';

const cancelledShard: QaScenarioShardLike = {
  shard: 7,
  status: 'cancelled',
  durationMs: 1200,
  handle: 'cancelled-shard',
  description: 'Cancelled after another shard failed',
  target: 'tests/example.spec.ts',
  title: 'cancelled scenario',
  phaseMs: null,
  slowSteps: [],
};

describe('QA scenario player', () => {
  test('represents cancelled shards without fabricating a failure', () => {
    const cues = buildQaScenarioCues(cancelledShard);
    expect(cues.at(-1)).toMatchObject({
      title: 'Cancelled',
      text: 'Runner stopped this shard before completion.',
      meta: 'cancelled',
    });
    expect(qaScenarioFailureCueIndex(cancelledShard, cues)).toBe(-1);
  });
});
