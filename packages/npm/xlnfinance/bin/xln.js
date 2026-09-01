#!/usr/bin/env bun

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import {
  assertLauncherPortAvailable,
  consumeCliPairing,
  issueBrowserPairing,
  readDaemonStatus,
  waitForDaemon,
  waitForDaemonStop,
} from '../lib/api.js';
import { ask } from '../lib/prompt.js';
import { BRAINVAULT_V1_SPEC_ID, RemoteRuntimeAdapter } from '../dist/launcher-client.js';
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
  if (!existsSync(PATHS.brainvaultWorker)) {
    throw new Error(`XLN_BRAINVAULT_WORKER_BUNDLE_MISSING:${PATHS.brainvaultWorker}`);
  }
  if (!existsSync(PATHS.launcherClient)) {
    throw new Error(`XLND_LAUNCHER_CLIENT_BUNDLE_MISSING:${PATHS.launcherClient}`);
  }
  if (!existsSync(`${PATHS.app}/app.html`)) throw new Error(`XLN_APP_BUNDLE_MISSING:${PATHS.app}/app.html`);
};

const assertOwnedDaemon = (status, metadata) => {
  if (!status?.enabled) throw new Error('PORT_8080_IS_NOT_XLND');
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

const browserUrl = (pairingToken, onboardingStage, entityId = '') => {
  const params = new URLSearchParams({ xlnPair: pairingToken });
  if (onboardingStage) params.set('xlnOnboarding', onboardingStage);
  if (entityId) params.set('xlnEntity', entityId);
  return `http://localhost:8080/app#${params.toString()}`;
};

const deriveOwnerFromCli = async () => {
  const controlToken = readOrCreateSecret(PATHS.controlToken, 'xln-control');
  const paired = await consumeCliPairing(controlToken);
  const adapter = new RemoteRuntimeAdapter();
  let passphrase = '';
  try {
    await adapter.connect({
      mode: 'remote',
      wsUrl: paired.wsUrl,
      authKey: paired.token,
      requestTimeoutMs: 5_000,
    });
    if (adapter.authLevel !== 'admin') throw new Error('XLND_DERIVE_CLI_ADMIN_REQUIRED');
    const name = await ask('BrainVault username: ');
    passphrase = await ask('BrainVault password: ', true);
    if (!name) throw new Error('BRAINVAULT_NAME_INVALID');
    if (!passphrase) throw new Error('BRAINVAULT_PASSPHRASE_INVALID');
    console.log(`Deriving BrainVault · factor 4 · 1,000 shards · ${availableParallelism()} CPUs`);
    let lastPercent = -1;
    const result = await adapter.deriveBrainVault({
      specId: BRAINVAULT_V1_SPEC_ID,
      name,
      passphrase,
      shardInput: 4,
      workers: availableParallelism(),
    }, {
      onProgress: (progress) => {
        const percent = Math.floor((progress.completed / progress.total) * 100);
        if (percent === lastPercent && progress.completed !== progress.total) return;
        lastPercent = percent;
        process.stdout.write(`\rBrainVault ${percent}% · ${progress.completed}/${progress.total} · ${progress.workers} workers   `);
      },
    });
    process.stdout.write('\n');
    console.log(`Owner ready in ${(result.derivationTimeMs / 1_000).toFixed(2)}s · ${result.ethereumAddress} · entity ${result.entityId}`);
    return result;
  } finally {
    passphrase = '';
    adapter.disconnect();
  }
};

const openWallet = async ({ deriveCli = false } = {}) => {
  const status = await startDaemon();
  assertOwnedDaemon(status, readDaemonMetadata());
  const derived = deriveCli ? await deriveOwnerFromCli() : null;
  const controlToken = readOrCreateSecret(PATHS.controlToken, 'xln-control');
  const pairingToken = await issueBrowserPairing(controlToken);
  const onboardingStage = derived
    ? 'formation'
    : existsSync(PATHS.brainvaultOwner) ? '' : 'create';
  const url = browserUrl(pairingToken, onboardingStage, derived?.entityId || '');
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

const main = async () => {
  const argv = process.argv.slice(2);
  const deriveCli = argv.includes('--derive-cli');
  const showVersion = argv.includes('--version') || argv.includes('-v');
  const unknownFlags = argv.filter((argument) => argument.startsWith('--') && !['--derive-cli', '--help', '--version'].includes(argument));
  if (unknownFlags.length > 0) throw new Error(`Unknown flag: ${unknownFlags[0]}`);
  const command = argv.find((argument) => !argument.startsWith('-')) || 'start';
  if (argv.includes('--help')) {
    console.log('xlnd [start|daemon|open|status|stop|logs|version] [--derive-cli]');
    console.log('  --derive-cli  Derive the default 1,000-shard BrainVault owner in this terminal before opening the UI.');
    return;
  }
  if (showVersion || command === 'version') return console.log(VERSION);
  if (command === 'status') return showStatus();
  if (command === 'stop') return stopDaemon();
  if (command === 'logs') return showLogs();
  if (command === 'daemon') {
    await startDaemon();
    return console.log('xln daemon is running');
  }
  if (deriveCli && command !== 'open' && command !== 'start') {
    throw new Error('--derive-cli is supported only with start or open');
  }
  if (command === 'open') return openWallet({ deriveCli });
  if (command === 'start') return openWallet({ deriveCli });
  throw new Error(`Unknown command: ${command}. Use start, daemon, open, status, stop, logs, or version.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
