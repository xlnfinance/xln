import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeControllerHandle } from '../../frontend/src/lib/stores/runtimeControllerStore';
import { runtimeQueryClient } from '../../frontend/src/lib/stores/runtimeQueryClient';
import {
  assertRuntimeViewIsLive,
  normalizeRuntimeViewAtHeight,
  resetRuntimeView,
  runtimeView,
  runtimeViewFrameMatchesAtHeight,
  runtimeViewQueryAtHeight,
  setRuntimeViewAtHeight,
} from '../../frontend/src/lib/stores/runtimeViewStore';

const repoRoot = process.cwd();

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const readStore = <T>(store: { subscribe: (run: (value: T) => void) => () => void }): T => {
  let current!: T;
  const unsubscribe = store.subscribe((value) => { current = value; });
  unsubscribe();
  return current;
};

const originalReadHead = runtimeQueryClient.readHead.bind(runtimeQueryClient);
const originalReadViewFrame = runtimeQueryClient.readViewFrame.bind(runtimeQueryClient);

afterEach(() => {
  runtimeQueryClient.readHead = originalReadHead;
  runtimeQueryClient.readViewFrame = originalReadViewFrame;
  runtimeControllerHandle.set({
    id: 'embedded',
    runtimeId: 'embedded',
    pendingRuntimeId: '',
    mode: 'embedded',
    endpoint: 'embedded',
    permissions: 'write',
    status: 'disconnected',
    height: 0,
    authLevel: null,
  });
  resetRuntimeView();
});

describe('frontend time-machine current env contract', () => {
  test('selected historical height is part of the shared RuntimeView query', () => {
    expect(normalizeRuntimeViewAtHeight(null)).toBeNull();
    expect(normalizeRuntimeViewAtHeight(7.9)).toBe(7);
    expect(() => normalizeRuntimeViewAtHeight(0)).toThrow('positive integer');

    expect(runtimeViewQueryAtHeight({ entityId: '0xabc', accountsLimit: 8 }, 7)).toEqual({
      entityId: '0xabc',
      accountsLimit: 8,
      atHeight: 7,
    });
    expect(runtimeViewQueryAtHeight({ entityId: '0xabc', atHeight: 7 }, null)).toEqual({
      entityId: '0xabc',
    });
    expect(runtimeViewFrameMatchesAtHeight({ height: 7 } as never, 7)).toBe(true);
    expect(runtimeViewFrameMatchesAtHeight({ height: 8 } as never, 7)).toBe(false);
    expect(() => assertRuntimeViewIsLive({ atHeight: 7 })).toThrow('RUNTIME_COMMAND_REQUIRES_LIVE_VIEW');
    expect(() => assertRuntimeViewIsLive({ atHeight: null })).not.toThrow();
  });

  test('returning to LIVE reloads the current frame without atHeight', async () => {
    const queries: Array<number | undefined> = [];
    runtimeControllerHandle.set({
      id: 'browser-a',
      runtimeId: 'browser-a',
      pendingRuntimeId: '',
      mode: 'embedded',
      endpoint: 'embedded',
      permissions: 'write',
      status: 'connected',
      height: 12,
      authLevel: 'admin',
    });
    runtimeQueryClient.readHead = async () => ({ latestHeight: 12 }) as never;
    runtimeQueryClient.readViewFrame = async (query = {}) => {
      queries.push(query.atHeight);
      return { height: query.atHeight ?? 12 } as never;
    };
    resetRuntimeView();

    await setRuntimeViewAtHeight(7);
    expect(readStore(runtimeView)).toMatchObject({ atHeight: 7, height: 7, frame: { height: 7 } });

    await setRuntimeViewAtHeight(null);
    expect(readStore(runtimeView)).toMatchObject({ atHeight: null, height: 12, frame: { height: 12 } });
    expect(queries).toEqual([7, undefined]);
  });

  test('a stale historical failure cannot overwrite a newer LIVE selection', async () => {
    let rejectHistorical!: (error: Error) => void;
    runtimeControllerHandle.set({
      id: 'browser-a',
      runtimeId: 'browser-a',
      pendingRuntimeId: '',
      mode: 'embedded',
      endpoint: 'embedded',
      permissions: 'write',
      status: 'connected',
      height: 12,
      authLevel: 'admin',
    });
    runtimeQueryClient.readHead = async () => ({ latestHeight: 12 }) as never;
    runtimeQueryClient.readViewFrame = async (query = {}) => {
      if (query.atHeight === 7) {
        return new Promise((_, reject) => { rejectHistorical = reject; });
      }
      return { height: 12 } as never;
    };
    resetRuntimeView();

    const historical = setRuntimeViewAtHeight(7);
    const live = setRuntimeViewAtHeight(null);
    await live;
    rejectHistorical(new Error('stale historical read failed'));

    await expect(historical).resolves.toMatchObject({ atHeight: null, frame: { height: 12 } });
    expect(readStore(runtimeView)).toMatchObject({ atHeight: null, height: 12, frame: { height: 12 }, error: null });
  });

  test('TimeMachine publishes its selected frame through RuntimeView for browser and remote runtimes', () => {
    const timeMachine = read('frontend/src/lib/view/core/TimeMachine.svelte');
    const workspace = read('frontend/src/lib/components/Entity/EntityWorkspace.svelte');
    const chrome = read('frontend/src/lib/components/Entity/EntityPanelChrome.svelte');
    const xlnStore = read('frontend/src/lib/stores/xlnStore.ts');

    expect(timeMachine).toContain('setRuntimeViewAtHeight');
    expect(timeMachine).toContain('selectedRuntimeViewHeight');
    expect(timeMachine).toContain('`${$runtimeControllerHandle.id}|${$isLive');
    expect(workspace).toContain('$runtimeView.atHeight');
    expect(workspace).toContain('runtimeViewFrameMatchesAtHeight');
    expect(xlnStore.match(/assertRuntimeViewIsLive\(get\(runtimeView\)\)/g)).toHaveLength(2);
    expect(xlnStore.match(/assertNetworkMachineIsLive\(get\(networkMachineRuntime\)\)/g)).toHaveLength(2);
    expect(chrome).not.toContain('Viewing historical state');
    expect(chrome).not.toContain('history-warning');
  });

  test('TimeMachine keeps -1 as the only live cursor sentinel', () => {
    const source = read('frontend/src/lib/view/core/TimeMachine.svelte');

    expect(source).toContain('const LIVE_TIME_INDEX = -1;');
    expect(source).toContain('$isLive && $timeIndex !== LIVE_TIME_INDEX');
    expect(source).toContain('safeSet(timeIndex, LIVE_TIME_INDEX);');
    expect(source).toContain('!$isLive && $timeIndex === LIVE_TIME_INDEX');
    expect(source).not.toContain('safeSet(timeIndex, maxTimeIndex)');
    expect(source).not.toContain('safeSet(timeIndex, $history.length - 1)');
    expect(source).toContain('safeSet(timeIndex, 0);\n      safeSet(isLive, false);');
  });

  test('remote TimeMachine deeplinks use RuntimeController identity instead of env fallback', () => {
    const source = read('frontend/src/lib/view/core/TimeMachine.svelte');

    expect(source).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';");
    expect(source).toContain("from '$lib/stores/runtimeHistoryStore';");
    expect(source).toContain('RuntimeAdapterViewFrame');
    expect(source).toContain('selectedRuntimeHistoryFrame = findRuntimeHistoryFrame($runtimeHistoryFrames');
    expect(source).toContain('remoteTargetOptions = buildRemoteTargetOptions($runtimeView.frame)');
    expect(source).toContain('liveFrameSummary = summarizeFrame($runtimeView.frame');
    expect(source).toContain('$runtimeControllerHandle.id');
    expect(source).toContain('$runtimeControllerHandle.height');
    expect(source).toContain('$runtimeControllerHandle.mode');
    expect(source).toContain('$runtimeControllerHandle.endpoint');
    expect(source).not.toContain('buildRemoteTargetOptions($env)');
    expect(source).not.toContain('summarizeFrame($env');
    expect(source).not.toContain('frameReplicas');
    expect(source).not.toContain('replicaEntityId');
    expect(source).not.toContain('appRuntimeAdapterMode');
    expect(source).not.toContain('appRuntimeAdapterEndpoint');
    expect(source).not.toContain('$env?.runtimeId');
    expect(source).not.toContain('$env.runtimeId');
    expect(source).not.toContain('$env?.height');
    expect(source).not.toContain('$env.height');
  });

  test('legacy time store uses -1 for live and never stores max index as live', () => {
    const source = read('frontend/src/lib/stores/timeStore.ts');

    expect(source).not.toContain("import { activeEnv } from './runtimeStore';");
    expect(source).not.toContain('activeEnv');
    expect(source).not.toContain('visibleReplicas');
    expect(source).not.toContain('visibleGossip');
    expect(source).not.toContain('visibleEnvironment');
    expect(source).not.toContain('eReplicas');
    expect(source).not.toContain('jReplicas');
    expect(source).not.toContain('xlnEnvironment');
    expect(source).toContain('currentTimeIndex: -1');
    expect(source).toContain('currentTimeIndex: current.isLive ? -1');
    expect(source).toContain('currentTimeIndex: -1,');
    expect(source).not.toContain('currentTimeIndex: current.isLive ? maxIndex');
    expect(source).not.toContain('currentTimeIndex: maxIndex');
  });

  test('View preserves explicit historical cursor while current env keeps updating', () => {
    const source = read('frontend/src/lib/view/View.svelte');

    expect(source).toContain('setLocalHistoryPreservingCursor');
    expect(source).toContain("import { getEnv, getXLN, history as runtimeHistory, xlnEnvironment, xlnInstance } from '$lib/stores/xlnStore';");
    expect(source).not.toContain("import { runtimeViewFrameToEnv } from '$lib/utils/runtimeViewEnv';");
    expect(source).toContain('unsubRuntimeEnv = xlnEnvironment.subscribe');
    expect(source).not.toContain('unsubActiveRuntimeView = runtimeView.subscribe');
    expect(source).not.toContain('runtimeViewFrameToEnv(');
    expect(source).toContain('onRuntimeControllerStatus');
    expect(source).toContain('refreshRuntimeView()');
    expect(source).not.toContain('onRuntimeControllerChange');
    expect(source).toContain('publishedRuntimeKey !== runtimeKey');
    expect(source).toContain('if (get(localIsLive))');
    expect(source).toContain('localTimeIndex.set(-1)');
    expect(source).not.toContain("import { activeEnv } from '$lib/stores/runtimeStore';");
    expect(source).not.toContain('$xlnEnvironment');
    expect(source).not.toContain('unsubActiveRuntimeEnv');
    expect(source).not.toContain('localIsLive.set(true);\n        localTimeIndex.set(-1);\n        registerEnvChanges(nextEnv);');
  });

  test('demo and graph actions block historical frames instead of auto-switching live', () => {
    const architect = read('frontend/src/lib/view/panels/ArchitectPanel.svelte');
    const graph = read('frontend/src/lib/view/panels/Graph3DPanel.svelte');
    const dock = read('frontend/src/lib/view/DockRoot.svelte');

    expect(architect).toContain('function publishCurrentEnv');
    expect(architect).toContain('$: isLiveActionFrame = Boolean($runtimeFrameIsLive) && $runtimeFrameTimeIndex === -1;');
    expect(architect).toContain('function requireLiveMode');
    expect(architect).toContain('Switch to the current runtime state before acting.');
    expect(architect).toContain('await ingressRuntimeInput');
    expect(architect).not.toContain('XLN.enqueueRuntimeInput($runtimeFrameEnv, {');
    expect(architect).not.toContain('runtimeFrameTimeIndex.set(($runtimeFrameEnv.history?.length || 1) - 1)');
    expect(architect).not.toContain('runtimeFrameTimeIndex.set(Math.max(0, frames.length - 1))');
    expect(architect).not.toContain('runtimeFrameIsLive.set(false)');

    expect(graph).toContain('export let runtimeFrameIsLive: Writable<boolean>;');
    expect(graph).toContain('getLiveEnvForAction');
    expect(graph).toContain('get(runtimeFrameTimeIndex) !== -1 || !get(runtimeFrameIsLive)');
    expect(graph).toContain('Switch to the current runtime state before acting.');
    expect(graph).toContain('submitRuntimeInput({ runtimeTxs: [], entityInputs: [paymentInput] })');
    expect(graph).not.toContain('submitRuntimeInput(actionEnv');
    expect(graph).not.toContain('function goToLiveForAction');
    expect(graph).not.toContain('runtimeFrameTimeIndex.set(-1)');
    expect(graph).not.toContain('runtimeFrameIsLive.set(true)');
    expect(graph).not.toContain('enqueueRuntimeInput(env,');
    expect(graph).not.toContain('$runtimeFrameEnv?.runtimeInput');
    expect(graph).not.toContain('$runtimeFrameEnv.runtimeInput');
    expect(graph).not.toContain('get(runtimeFrameEnv)?.eReplicas');
    expect(dock).toContain('runtimeFrameIsLive,');
  });

  test('ArchitectPanel resets demo state without reload-page fallback strings', () => {
    const architect = read('frontend/src/lib/view/panels/ArchitectPanel.svelte');

    expect(architect).toContain('function clearDemoRuntimeState');
    expect(architect).toContain('$runtimeFrameEnv.eReplicas.clear()');
    expect(architect).toContain("publishCurrentEnv([])");
    expect(architect).toContain("Existing economy cleared before topology rebuild");
    expect(architect).not.toContain('Reset not implemented');
    expect(architect).not.toContain('reload page to reset');
    expect(architect).not.toContain('reload page for now');
  });
});
