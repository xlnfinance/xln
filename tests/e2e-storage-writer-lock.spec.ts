import { expect, test } from './global-setup';

type BrowserIssue = {
  type: 'console' | 'pageerror';
  message: string;
};

type StorageWriterResult = {
  lockName: string;
  beforeRelease: {
    held: number;
    pending: number;
    bEntered: boolean;
    bFinished: boolean;
  };
  trace: string[];
  headAfterB: number;
  headAfterStaleSave: number;
  frameHashAfterB: string;
  frameHashAfterStaleSave: string;
  staleWriterStopped: boolean;
  staleLifecycle: string;
  staleFatalMessage: string;
  staleHeightPresent: boolean;
};

test.describe('Browser storage writer serialization', () => {
  test('same-namespace restores serialize and a stale writer cannot overwrite the winner', { tag: '@resilience' }, async ({ page }, testInfo) => {
    const browserIssues: BrowserIssue[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      browserIssues.push({ type: 'console', message: message.text() });
    });
    page.on('pageerror', (error) => {
      browserIssues.push({ type: 'pageerror', message: error.message });
    });

    // A static same-origin document avoids booting the wallet's own runtime.
    // The test imports the exact browser bundle that production loads.
    await page.goto('/llms.txt', { waitUntil: 'domcontentloaded' });
    const namespace = `xln-browser-storage-writer-${process.pid}-${testInfo.workerIndex}`;

    const result = await page.evaluate(async (dbNamespace): Promise<StorageWriterResult> => {
      const runtimeUrl = new URL(`/runtime.js?v=storage-writer-lock-${Date.now()}`, window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);
      (window as typeof window & { XLN?: typeof XLN }).XLN = XLN;

      if (!navigator.locks || typeof navigator.locks.query !== 'function') {
        throw new Error('STORAGE_WRITER_E2E_WEB_LOCKS_UNAVAILABLE');
      }
      for (const method of [
        'createEmptyEnv',
        'persistRestoredEnvToDB',
        'saveEnvToDB',
        'readPersistedStorageHead',
        'readPersistedStorageFrameRecord',
        'closeRuntimeDb',
        'closeInfraDb',
      ]) {
        if (typeof XLN[method] !== 'function') {
          throw new Error(`STORAGE_WRITER_E2E_RUNTIME_API_MISSING:${method}`);
        }
      }

      const makeEnv = (seed: string, height: number, timestamp: number) => {
        const env = XLN.createEmptyEnv(seed);
        env.runtimeId = dbNamespace;
        env.dbNamespace = dbNamespace;
        env.height = height;
        env.timestamp = timestamp;
        env.quietRuntimeLogs = true;
        env.scenarioMode = false;
        return env;
      };

      const envA = makeEnv('browser-storage-writer-a', 10, 10_000);
      const envB = makeEnv('browser-storage-writer-b', 20, 20_000);
      const trace: string[] = [];
      const lockName = `xln:storage-writer:${dbNamespace}`;
      let releaseA!: () => void;
      let announceAPaused!: () => void;
      let aPaused = false;
      let bEntered = false;
      let bFinished = false;
      const aRelease = new Promise<void>((resolve) => { releaseA = resolve; });
      const aPausedAtBoundary = new Promise<void>((resolve) => { announceAPaused = resolve; });

      const closeEnv = async (env: typeof envA): Promise<void> => {
        await XLN.closeRuntimeDb(env);
        await XLN.closeInfraDb(env);
      };

      try {
        const restoreA = XLN.persistRestoredEnvToDB(envA, {
          onPersistenceBoundary: async (boundary: string) => {
            if (boundary !== 'after-restore-authoritative-swap' || aPaused) return;
            aPaused = true;
            trace.push(`a-paused:${boundary}`);
            announceAPaused();
            await aRelease;
            trace.push('a-released');
          },
        }).then(() => { trace.push('a-finished'); });

        await Promise.race([
          aPausedAtBoundary,
          restoreA.then(() => {
            throw new Error('STORAGE_WRITER_E2E_A_FINISHED_BEFORE_PAUSE');
          }),
        ]);

        const restoreB = XLN.persistRestoredEnvToDB(envB, {
          onPersistenceBoundary: (boundary: string) => {
            if (bEntered) return;
            bEntered = true;
            trace.push(`b-entered:${boundary}`);
          },
        }).then(() => {
          bFinished = true;
          trace.push('b-finished');
        });

        const queryDeadline = performance.now() + 5_000;
        let lockSnapshot = await navigator.locks.query();
        while (
          performance.now() < queryDeadline &&
          !(
            lockSnapshot.held?.some((lock) => lock.name === lockName) &&
            lockSnapshot.pending?.some((lock) => lock.name === lockName)
          )
        ) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          lockSnapshot = await navigator.locks.query();
        }

        const beforeRelease = {
          held: lockSnapshot.held?.filter((lock) => lock.name === lockName).length ?? 0,
          pending: lockSnapshot.pending?.filter((lock) => lock.name === lockName).length ?? 0,
          bEntered,
          bFinished,
        };
        trace.push('a-release-requested');
        releaseA();
        await restoreA;
        await restoreB;

        const headAfterB = await XLN.readPersistedStorageHead(envB);
        const frameAfterB = await XLN.readPersistedStorageFrameRecord(envB, 20);
        if (!headAfterB || !frameAfterB?.frameHash) {
          throw new Error('STORAGE_WRITER_E2E_WINNING_HEAD_MISSING');
        }
        const staleHeightBeforeSave = await XLN.readPersistedStorageFrameRecord(envB, 10);

        const staleSave = await XLN.saveEnvToDB(envA);
        const headAfterStaleSave = await XLN.readPersistedStorageHead(envB);
        const frameAfterStaleSave = await XLN.readPersistedStorageFrameRecord(envB, 20);
        const staleHeightAfterSave = await XLN.readPersistedStorageFrameRecord(envB, 10);
        if (!headAfterStaleSave || !frameAfterStaleSave?.frameHash) {
          throw new Error('STORAGE_WRITER_E2E_WINNING_HEAD_LOST');
        }

        return {
          lockName,
          beforeRelease,
          trace,
          headAfterB: headAfterB.latestHeight,
          headAfterStaleSave: headAfterStaleSave.latestHeight,
          frameHashAfterB: frameAfterB.frameHash,
          frameHashAfterStaleSave: frameAfterStaleSave.frameHash,
          staleWriterStopped: staleSave.staleWriterStopped,
          staleLifecycle: String(envA.runtimeState?.lifecyclePhase || ''),
          staleFatalMessage: String(envA.runtimeState?.fatalDebugPayload?.message || ''),
          staleHeightPresent: staleHeightBeforeSave !== null || staleHeightAfterSave !== null,
        };
      } finally {
        await closeEnv(envA);
        await closeEnv(envB);
      }
    }, namespace);

    expect(result.beforeRelease).toEqual({
      held: 1,
      pending: 1,
      bEntered: false,
      bFinished: false,
    });
    expect(result.trace.indexOf('a-release-requested')).toBeGreaterThan(result.trace.indexOf('a-paused:after-restore-authoritative-swap'));
    expect(result.trace.indexOf('b-entered:after-restore-current-fence')).toBeGreaterThan(result.trace.indexOf('a-release-requested'));
    expect(result.trace.indexOf('b-finished')).toBeGreaterThan(result.trace.indexOf('b-entered:after-restore-current-fence'));
    expect(result.headAfterB).toBe(20);
    expect(result.headAfterStaleSave).toBe(20);
    expect(result.frameHashAfterStaleSave).toBe(result.frameHashAfterB);
    expect(result.staleHeightPresent).toBe(false);
    expect(result.staleWriterStopped).toBe(true);
    expect(result.staleLifecycle).toBe('halted');
    expect(result.staleFatalMessage).toContain('STALE_RUNTIME_WRITER_STOPPED: frame=10');
    expect(browserIssues).toEqual([]);
  });
});
