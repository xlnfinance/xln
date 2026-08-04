import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeControllerHandle } from '../../frontend/src/lib/stores/runtimeControllerStore';
import { runtimeQueryClient } from '../../frontend/src/lib/stores/runtimeQueryClient';
import {
  assertRuntimeViewIsLive,
  normalizeRuntimeViewAtHeight,
  readRuntimeViewSelection,
  refreshSelectedRuntimeView,
  resetRuntimeView,
  runtimeView,
  runtimeViewAccountsPage,
  runtimeViewFrameMatchesAtHeight,
  runtimeViewPageInfo,
  runtimeViewPublicationMatches,
  runtimeViewQueryAtHeight,
  setRuntimeViewPage,
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

    await expect(historical).rejects.toThrow('stale historical read failed');
    expect(readStore(runtimeView)).toMatchObject({ atHeight: null, height: 12, frame: { height: 12 }, error: null });
  });

  test('LIVE and historical height changes reject superseded remote publications', async () => {
    runtimeControllerHandle.set({
      id: 'remote-a',
      runtimeId: 'remote-a',
      pendingRuntimeId: '',
      mode: 'remote',
      endpoint: 'ws://remote-a',
      permissions: 'read',
      status: 'connected',
      height: 12,
      authLevel: 'read',
    });
    runtimeQueryClient.readHead = async () => ({ latestHeight: 12 }) as never;
    runtimeQueryClient.readViewFrame = async (query = {}) => ({ height: query.atHeight ?? 12 }) as never;
    resetRuntimeView();

    const published: string[] = [];
    const publishIfCurrent = async (
      selection: ReturnType<typeof readRuntimeViewSelection>,
      result: Promise<string>,
    ): Promise<void> => {
      const resolved = await result;
      if (runtimeViewPublicationMatches(1, 1, selection)) published.push(resolved);
    };

    const liveSelection = readRuntimeViewSelection();
    let resolveLive!: (value: string) => void;
    const staleLive = publishIfCurrent(
      liveSelection,
      new Promise<string>((resolve) => { resolveLive = resolve; }),
    );
    await setRuntimeViewAtHeight(7);
    resolveLive('LIVE');
    await staleLive;

    const heightSevenSelection = readRuntimeViewSelection();
    let resolveHeightSeven!: (value: string) => void;
    const staleHeightSeven = publishIfCurrent(
      heightSevenSelection,
      new Promise<string>((resolve) => { resolveHeightSeven = resolve; }),
    );
    await setRuntimeViewAtHeight(8);
    resolveHeightSeven('h7');
    await staleHeightSeven;

    expect(published).toEqual([]);
    expect(readRuntimeViewSelection().atHeight).toBe(8);
  });

  test('historical frame and pager publish from the same current height read', async () => {
    runtimeControllerHandle.set({
      id: 'remote-a',
      runtimeId: 'remote-a',
      pendingRuntimeId: '',
      mode: 'remote',
      endpoint: 'ws://remote-a',
      permissions: 'read',
      status: 'connected',
      height: 12,
      authLevel: 'read',
    });
    const frameAt = (height: number, accountsPageCount: number) => ({
      height,
      entities: [],
      activeEntityId: '0xentity-a',
      activeEntity: {
        summary: { entityId: '0xentity-a' },
        core: { entityId: '0xentity-a', timestamp: height },
        accounts: {
          items: [],
          totalItems: accountsPageCount,
          pageIndex: 0,
          pageCount: accountsPageCount,
          prevCursor: null,
          nextCursor: accountsPageCount > 1 ? `accounts-${height}` : null,
        },
        books: {
          items: [],
          totalItems: 0,
          pageIndex: 0,
          pageCount: 1,
          prevCursor: null,
          nextCursor: null,
        },
      },
    }) as never;
    runtimeQueryClient.readHead = async () => ({ latestHeight: 12 }) as never;
    runtimeQueryClient.readViewFrame = async () => frameAt(12, 10);
    resetRuntimeView();
    await refreshSelectedRuntimeView();
    expect(readStore(runtimeViewPageInfo)?.accountsPageCount).toBe(10);

    const deferred = new Map<number, (frame: never) => void>();
    runtimeQueryClient.readViewFrame = async (query = {}) => new Promise<never>((resolve) => {
      deferred.set(Number(query.atHeight), resolve);
    });
    const heightSeven = setRuntimeViewAtHeight(7);
    expect(readStore(runtimeViewPageInfo)).toBeNull();
    const heightEight = setRuntimeViewAtHeight(8);

    deferred.get(7)?.(frameAt(7, 7));
    await heightSeven;
    expect(readStore(runtimeViewPageInfo)).toBeNull();

    deferred.get(8)?.(frameAt(8, 2));
    await heightEight;
    expect(readStore(runtimeView)).toMatchObject({ atHeight: 8, frame: { height: 8 } });
    expect(readStore(runtimeViewPageInfo)).toMatchObject({
      entityId: '0xentity-a',
      accountsPageCount: 2,
      accountsNextCursor: 'accounts-8',
    });
  });

  test('changing a wallet page invalidates an in-flight projection before the queued refresh starts', async () => {
    let resolveFrame!: (frame: never) => void;
    runtimeControllerHandle.set({
      id: 'remote-a',
      runtimeId: 'remote-a',
      pendingRuntimeId: '',
      mode: 'remote',
      endpoint: 'ws://remote-a',
      permissions: 'read',
      status: 'connected',
      height: 12,
      authLevel: 'read',
    });
    runtimeQueryClient.readHead = async () => ({ latestHeight: 12 }) as never;
    runtimeQueryClient.readViewFrame = async () => new Promise<never>((resolve) => { resolveFrame = resolve; });
    resetRuntimeView();

    const stalePage = refreshSelectedRuntimeView();
    setRuntimeViewPage('accounts', 1);
    resolveFrame({ height: 12, activeEntityId: '0xentity-a' } as never);
    await stalePage;

    expect(readStore(runtimeViewAccountsPage)).toBe(1);
    expect(readStore(runtimeView).frame).toBeNull();
  });


  test('time store uses -1 for live and never stores max index as live', () => {
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

});
