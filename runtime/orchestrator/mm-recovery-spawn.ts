import { scheduler } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import type { MarketMakerChild } from './orchestrator-types';

export type MarketMakerRecoverySpawnDeps = {
  marketMakerChild: MarketMakerChild;
  fencingGraceMs: number;
  backoffMs: number;
  shouldAbortSpawn: () => boolean;
  spawnMarketMaker: () => Promise<void>;
  waitForMarketMakerSelfReady: () => Promise<void>;
  rememberControlledStop: (proc: ChildProcess | null | undefined) => void;
  stopProcess: (proc: ChildProcess | null | undefined) => Promise<void>;
  onSpawned: () => void;
  onSpawnFailed: (error: unknown) => void;
};

/**
 * Schedule a fenced MM respawn. The fencing wait is uncancellable; re-check
 * shutdown/reset after it so teardown cannot race a late spawn.
 */
export const scheduleMarketMakerRecoverySpawn = (
  deps: MarketMakerRecoverySpawnDeps,
): void => {
  const { marketMakerChild } = deps;
  marketMakerChild.recoveryInProgress = true;
  marketMakerChild.restartTimer = setTimeout(() => {
    marketMakerChild.restartTimer = null;
    void (async () => {
      await scheduler.wait(deps.fencingGraceMs);
      if (deps.shouldAbortSpawn()) {
        marketMakerChild.recoveryInProgress = false;
        return;
      }
      await deps.spawnMarketMaker();
      await deps.waitForMarketMakerSelfReady();
      marketMakerChild.recoveryInProgress = false;
      deps.onSpawned();
    })().catch(async (error) => {
      if (marketMakerChild.recoveryInProgress && marketMakerChild.restartTimer) return;
      const failedProc = marketMakerChild.proc;
      marketMakerChild.proc = null;
      deps.rememberControlledStop(failedProc);
      await deps.stopProcess(failedProc);
      marketMakerChild.recoveryInProgress = false;
      deps.onSpawnFailed(error);
    });
  }, deps.backoffMs);
};

export const shouldAbortMarketMakerSpawn = (flags: {
  fatalShutdown: boolean;
  orchestratorShutdown: boolean;
  resetInProgress: boolean;
}): boolean =>
  flags.fatalShutdown || flags.orchestratorShutdown || flags.resetInProgress;
