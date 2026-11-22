import * as runtime from '../../../../../core/runtime';
import { drainJWatcherBacklog } from '../../../../../core/jurisdiction/adapter/operations/backlog-drain';
import { fenceJurisdictionWatchers } from '../../../../../core/runtime/loop/loop-watchers';
import { waitFor, type PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import { assertRestoredSession } from '../../operators/session/inspect';
import type { ExecutionConfig } from '../config';

export const supervisedExecutionEnv = 'XLN_USDC_SUPERVISED_EXECUTION';
export const userCaughtUp = 'USDC_EXECUTION_USER_CAUGHT_UP';
export const releaseUserDelivery = 'USDC_EXECUTION_RELEASE_USER_DELIVERY';

const waitForOperatorRelease = (signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  const send = process.send?.bind(process);
  if (!send || !process.connected) throw new Error('USDC_EXECUTION_SUPERVISOR_IPC_REQUIRED');
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown): void =>
      finish(message === releaseUserDelivery ? undefined : new Error('USDC_EXECUTION_SUPERVISOR_IPC_INVALID'));
    const onDisconnect = (): void => finish(new Error('USDC_EXECUTION_SUPERVISOR_DISCONNECTED'));
    const onAbort = (): void => finish(signal.reason);
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
    signal.addEventListener('abort', onAbort, { once: true });
    console.log(userCaughtUp);
    send(userCaughtUp, (error: Error | null) => {
      if (error) finish(error);
    });
  }).then(() => console.log(releaseUserDelivery));
};

export const activateUser = async (user: PocUser, config: ExecutionConfig, requireAuthority: () => void): Promise<void> => {
  await assertRestoredSession(user.env, config.directory, 'user');
  runtime.setRuntimeDeliveryReady(user.env, false);
  runtime.startJurisdictionWatchers(user.env);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('USDC_EXECUTION_USER_STARTUP_INTERRUPTED'));
    fenceJurisdictionWatchers(user.env);
    runtime.stopJurisdictionWatchers(user.env);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const catchUp = async (): Promise<void> => {
      await drainJWatcherBacklog(user.env, runtime.processRuntime, shutdown.signal);
      shutdown.signal.throwIfAborted();
    };
    await catchUp();
    if (process.env[supervisedExecutionEnv] === '1') {
      // Delivery may resubmit a restored J outbox. Keep it fenced until operators are ready.
      await waitForOperatorRelease(shutdown.signal);
      requireAuthority();
      await catchUp();
    }
    requireAuthority();
    runtime.startP2P(user.env, { relayUrls: [config.apiBase.replace('http', 'ws') + '/relay'], gossipSet: 'hubs' });
    runtime.startRuntimeLoop(user.env, { onFatal: ({ message }) => { console.error(message); process.exit(1); } });
    runtime.setRuntimeDeliveryReady(user.env, true);
    await waitFor('execution-user-relay-connected', () => {
      shutdown.signal.throwIfAborted();
      return runtime.getP2P(user.env)?.isConnected() === true;
    });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
};
