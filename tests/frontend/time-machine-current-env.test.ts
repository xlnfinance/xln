import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('frontend time-machine current env contract', () => {
  test('TimeMachine keeps -1 as the only live cursor sentinel', () => {
    const source = read('frontend/src/lib/view/core/TimeMachine.svelte');

    expect(source).toContain('const LIVE_TIME_INDEX = -1;');
    expect(source).toContain('$isLive && $timeIndex !== LIVE_TIME_INDEX');
    expect(source).toContain('safeSet(timeIndex, LIVE_TIME_INDEX);');
    expect(source).toContain('!$isLive && $timeIndex === LIVE_TIME_INDEX');
    expect(source).not.toContain('safeSet(timeIndex, maxTimeIndex)');
    expect(source).not.toContain('safeSet(timeIndex, $history.length - 1)');
  });

  test('legacy time store uses -1 for live and never stores max index as live', () => {
    const source = read('frontend/src/lib/stores/timeStore.ts');

    expect(source).toContain('currentTimeIndex: -1');
    expect(source).toContain('currentTimeIndex: current.isLive ? -1');
    expect(source).toContain('currentTimeIndex: -1,');
    expect(source).not.toContain('currentTimeIndex: current.isLive ? maxIndex');
    expect(source).not.toContain('currentTimeIndex: maxIndex');
  });

  test('View preserves explicit historical cursor while current env keeps updating', () => {
    const source = read('frontend/src/lib/view/View.svelte');

    expect(source).toContain('setLocalHistoryPreservingCursor');
    expect(source).toContain('if (get(localIsLive))');
    expect(source).toContain('localTimeIndex.set(-1)');
    expect(source).not.toContain('localIsLive.set(true);\n        localTimeIndex.set(-1);\n        registerEnvChanges(nextEnv);');
  });

  test('demo and graph actions return to live current env instead of latest history frame', () => {
    const architect = read('frontend/src/lib/view/panels/ArchitectPanel.svelte');
    const graph = read('frontend/src/lib/view/panels/Graph3DPanel.svelte');
    const dock = read('frontend/src/lib/view/DockRoot.svelte');

    expect(architect).toContain('function publishCurrentEnv');
    expect(architect).not.toContain('isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1)');
    expect(architect).not.toContain('isolatedTimeIndex.set(Math.max(0, frames.length - 1))');
    expect(architect).not.toContain('isolatedIsLive.set(false)');

    expect(graph).toContain('export let isolatedIsLive: Writable<boolean>;');
    expect(graph).toContain('isolatedTimeIndex.set(-1)');
    expect(graph).toContain('isolatedIsLive.set(true)');
    expect(dock).toContain('isolatedIsLive,');
  });
});
