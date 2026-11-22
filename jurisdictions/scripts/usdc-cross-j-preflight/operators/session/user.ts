import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootUser, closeUser } from '../../../../../core/scenarios/usdc-poc/user';
import { runtimeProof } from '../../../../../core/scenarios/usdc-poc/recovery/evidence';
import { drainJWatcherBacklog } from '../../../../../core/jurisdiction/adapter/operations/backlog-drain';
import { safeStringify } from '../../../../../core/protocol/serialization';
import { assertRestoredSession } from './inspect';
import { waitSessionReady } from './processes';
import * as runtime from '../../../../../core/runtime';
import { fenceJurisdictionWatchers } from '../../../../../core/runtime/loop/loop-watchers';
import { startParentLivenessWatch } from '../../../../../core/support/process/parent-watch';

const [directory, apiBase, output] = process.argv.slice(2);
if (!directory || !apiBase || !output) throw new Error('USDC_SESSION_USER_INPUT_INVALID');
const user = await bootUser(apiBase, join(directory, 'user'), true);
const shutdown = new AbortController();
const stop = (): void => {
  shutdown.abort();
  fenceJurisdictionWatchers(user.env);
  runtime.stopJurisdictionWatchers(user.env);
};
const stopParentWatch = startParentLivenessWatch('PoC user', process.env['XLN_ORCHESTRATOR_PID'], stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await assertRestoredSession(user.env, directory, 'user');
  // Capture recovery authority before any new chain observation or peer input.
  const restored = runtimeProof(user);
  shutdown.signal.throwIfAborted();
  runtime.setRuntimeDeliveryReady(user.env, false);
  runtime.startJurisdictionWatchers(user.env);
  await drainJWatcherBacklog(user.env, env => runtime.processRuntime(env), shutdown.signal);
  shutdown.signal.throwIfAborted();
  runtime.startP2P(user.env, { relayUrls: [apiBase.replace('http', 'ws') + '/relay'], gossipSet: 'hubs' });
  runtime.startRuntimeLoop(user.env, {
    onFatal: ({ message }) => {
      console.error(`USDC_SESSION_USER_FATAL:${message}`);
      process.exit(1);
    },
  });
  runtime.setRuntimeDeliveryReady(user.env, true);
  await waitSessionReady([], 'user-relay', async () => runtime.getP2P(user.env)?.isConnected() === true, 60_000, shutdown.signal);
  shutdown.signal.throwIfAborted();
  writeFileSync(
    output,
    safeStringify({ status: 'ready', restored, runtimeId: user.env.runtimeId, relayConnected: true }, 2),
    { flag: 'wx', mode: 0o600 },
  );
  while (!shutdown.signal.aborted) await Bun.sleep(100);
} catch (error) {
  if (error !== shutdown.signal.reason) throw error;
} finally {
  stopParentWatch();
  await closeUser(user);
}
