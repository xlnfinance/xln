import { closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { openDaemonLog, PACKAGE_ROOT, PATHS } from './state.js';

export const spawnDaemon = ({ instanceId, version, runtimeSeed, authSeed, controlToken }) => {
  const logDescriptor = openDaemonLog();
  const child = spawn(process.execPath, [
    PATHS.server,
    '--host', '127.0.0.1',
    '--port', '8080',
    '--static-dir', PATHS.app,
    '--server-id', 'xlnfinance-local',
  ], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: ['ignore', logDescriptor, logDescriptor],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RUNTIME_VERBOSE_LOGS: '0',
      XLN_DB_PATH: PATHS.database,
      XLN_JURISDICTIONS_PATH: PATHS.jurisdictions,
      XLN_DISTRIBUTION_VERSION: version,
      XLN_LOCAL_CONTROL_TOKEN: controlToken,
      XLN_LOCAL_INSTANCE_ID: instanceId,
      XLN_LOCAL_OWNER_LABEL: 'xlnfinance-owner',
      XLN_LOCAL_OWNER_PROFILE_NAME: 'xln finance',
      XLN_RADAPTER_AUTH_SEED: authSeed,
      XLN_RADAPTER_REQUIRE_AUTH_SEED: '1',
      XLN_RUNTIME_SEED: runtimeSeed,
      XLN_SKIP_SERVER_BOOTSTRAP: '1',
    },
  });
  child.unref();
  closeSync(logDescriptor);
  if (!child.pid) throw new Error('XLN_DAEMON_PID_MISSING');
  return child.pid;
};

export const openSystemBrowser = (url) => {
  const command = process.platform === 'darwin'
    ? ['open', url]
    : process.platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
};

export const stopDaemonProcess = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`XLN_DAEMON_PID_INVALID:${pid}`);
  process.kill(pid, 'SIGTERM');
};
