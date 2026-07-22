#!/usr/bin/env bun

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  assertLauncherPortAvailable,
  issueBrowserPairing,
  readDaemonStatus,
  waitForDaemon,
  waitForDaemonStop,
} from '../lib/api.js';
import { openSystemBrowser, spawnDaemon, stopDaemonProcess } from '../lib/process.js';
import {
  PATHS,
  readDaemonMetadata,
  readOrCreateSecret,
  writeDaemonMetadata,
} from '../lib/state.js';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = String(packageJson.version);

const requireDistributionAssets = () => {
  if (!existsSync(PATHS.server)) throw new Error(`XLN_SERVER_BUNDLE_MISSING:${PATHS.server}`);
  if (!existsSync(`${PATHS.app}/app.html`)) throw new Error(`XLN_APP_BUNDLE_MISSING:${PATHS.app}/app.html`);
};

const assertOwnedDaemon = (status, metadata) => {
  if (!status?.enabled) throw new Error('PORT_8080_IS_NOT_XLNFINANCE');
  if (!metadata?.instanceId || status.instanceId !== metadata.instanceId) {
    throw new Error('XLN_DAEMON_INSTANCE_MISMATCH');
  }
};

const startDaemon = async () => {
  const existingStatus = await readDaemonStatus();
  const existingMetadata = readDaemonMetadata();
  if (existingStatus) {
    assertOwnedDaemon(existingStatus, existingMetadata);
    return existingStatus;
  }
  await assertLauncherPortAvailable();

  requireDistributionAssets();
  const runtimeSeed = readOrCreateSecret(PATHS.runtimeSeed, 'xln-runtime');
  const authSeed = readOrCreateSecret(PATHS.authSeed, 'xln-radapter');
  const controlToken = readOrCreateSecret(PATHS.controlToken, 'xln-control');
  const instanceId = randomBytes(16).toString('hex');
  const pid = spawnDaemon({ instanceId, version: VERSION, runtimeSeed, authSeed, controlToken });
  writeDaemonMetadata({ pid, instanceId, version: VERSION, startedAt: new Date().toISOString() });

  try {
    const status = await waitForDaemon();
    assertOwnedDaemon(status, readDaemonMetadata());
    return status;
  } catch (error) {
    const tail = existsSync(PATHS.log)
      ? readFileSync(PATHS.log, 'utf8').split('\n').slice(-30).join('\n')
      : 'No daemon log was created.';
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${tail}`);
  }
};

const openWallet = async () => {
  const status = await startDaemon();
  assertOwnedDaemon(status, readDaemonMetadata());
  const controlToken = readOrCreateSecret(PATHS.controlToken, 'xln-control');
  const pairingToken = await issueBrowserPairing(controlToken);
  const url = `http://localhost:8080/app#xlnPair=${encodeURIComponent(pairingToken)}`;
  openSystemBrowser(url);
  console.log('xln is running at http://localhost:8080/app');
};

const showStatus = async () => {
  const status = await readDaemonStatus();
  if (!status) {
    console.log('xln is stopped');
    return;
  }
  assertOwnedDaemon(status, readDaemonMetadata());
  console.log(`xln is running · runtime ${status.ready ? 'ready' : 'starting'} · ${status.version || VERSION}`);
};

const stopDaemon = async () => {
  const status = await readDaemonStatus();
  const metadata = readDaemonMetadata();
  if (!status) {
    console.log('xln is already stopped');
    return;
  }
  assertOwnedDaemon(status, metadata);
  stopDaemonProcess(metadata.pid);
  await waitForDaemonStop();
  rmSync(PATHS.pid, { force: true });
  console.log('xln stopped');
};

const showLogs = () => {
  if (!existsSync(PATHS.log)) {
    console.log(`No logs yet: ${PATHS.log}`);
    return;
  }
  console.log(readFileSync(PATHS.log, 'utf8').split('\n').slice(-120).join('\n'));
};

const applyLatestUpdate = () => {
  const result = spawnSync(process.execPath, ['x', 'xlnfinance@latest', '__restart'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`XLN_UPDATE_FAILED:${result.status ?? 'unknown'}`);
};

const main = async () => {
  const command = process.argv[2] || 'start';
  if (command === '--version' || command === '-v' || command === 'version') return console.log(VERSION);
  if (command === 'status') return showStatus();
  if (command === 'stop') return stopDaemon();
  if (command === 'logs') return showLogs();
  if (command === 'daemon') {
    await startDaemon();
    return console.log('xln daemon is running');
  }
  if (command === 'open') return openWallet();
  if (command === 'update') return applyLatestUpdate();
  if (command === 'start') return openWallet();
  if (command === '__restart') {
    await stopDaemon();
    return openWallet();
  }
  throw new Error(`Unknown command: ${command}. Use start, daemon, open, status, stop, logs, update, or version.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
