#!/usr/bin/env bun

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

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
  DEV_PATHS,
  TESTNET_PATHS,
  pathsForMode,
  readDaemonMetadata,
  readOrCreateSecret,
  writeDaemonMetadata,
} from '../lib/state.js';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = String(packageJson.version);

const ALL_PATHS = [TESTNET_PATHS, DEV_PATHS];

const requireDistributionAssets = (paths) => {
  if (!existsSync(paths.server)) throw new Error(`XLN_SERVER_BUNDLE_MISSING:${paths.server}`);
  if (!existsSync(paths.brainvaultWorker)) {
    throw new Error(`XLN_BRAINVAULT_WORKER_BUNDLE_MISSING:${paths.brainvaultWorker}`);
  }
  if (!existsSync(paths.launcherClient)) {
    throw new Error(`XLNFINANCE_LAUNCHER_CLIENT_BUNDLE_MISSING:${paths.launcherClient}`);
  }
  if (!existsSync(`${paths.app}/app.html`)) throw new Error(`XLN_APP_BUNDLE_MISSING:${paths.app}/app.html`);
};

const assertOwnedDaemon = (status, metadata) => {
  if (!status?.enabled) throw new Error('PORT_8080_IS_NOT_XLNFINANCE');
  if (!metadata?.instanceId || status.instanceId !== metadata.instanceId) {
    throw new Error('XLN_DAEMON_INSTANCE_MISMATCH');
  }
};

const ownedDaemon = (status) => {
  for (const paths of ALL_PATHS) {
    const metadata = readDaemonMetadata(paths);
    if (metadata?.instanceId && status?.instanceId === metadata.instanceId) return { paths, metadata };
  }
  return null;
};

const startDaemon = async (mode = 'testnet') => {
  const paths = pathsForMode(mode);
  const existingStatus = await readDaemonStatus();
  if (existingStatus) {
    const existing = ownedDaemon(existingStatus);
    if (!existing) throw new Error('PORT_8080_IS_NOT_XLNFINANCE');
    if (existing.paths.mode !== mode) {
      throw new Error(`XLNFINANCE_${existing.paths.mode.toUpperCase()}_IS_RUNNING:run_xlnfinance_stop_first`);
    }
    assertOwnedDaemon(existingStatus, existing.metadata);
    return existingStatus;
  }
  await assertLauncherPortAvailable();

  requireDistributionAssets(paths);
  const runtimeSeed = readOrCreateSecret(paths.runtimeSeed, 'xln-runtime', paths);
  const authSeed = readOrCreateSecret(paths.authSeed, 'xln-radapter', paths);
  const controlToken = readOrCreateSecret(paths.controlToken, 'xln-control', paths);
  const instanceId = randomBytes(16).toString('hex');
  const pid = await spawnDaemon({ instanceId, version: VERSION, runtimeSeed, authSeed, controlToken, paths });
  writeDaemonMetadata({ pid, instanceId, version: VERSION, mode, startedAt: new Date().toISOString() }, paths);

  try {
    const status = await waitForDaemon();
    assertOwnedDaemon(status, readDaemonMetadata(paths));
    return status;
  } catch (error) {
    const tail = existsSync(paths.log)
      ? readFileSync(paths.log, 'utf8').split('\n').slice(-30).join('\n')
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

const deriveOwnerFromCli = async (paths) => {
  const controlToken = readOrCreateSecret(paths.controlToken, 'xln-control', paths);
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
    if (adapter.authLevel !== 'admin') throw new Error('XLNFINANCE_DERIVE_CLI_ADMIN_REQUIRED');
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

const openWallet = async ({ deriveCli = false, mode = 'testnet' } = {}) => {
  const paths = pathsForMode(mode);
  const status = await startDaemon(mode);
  assertOwnedDaemon(status, readDaemonMetadata(paths));
  const derived = deriveCli ? await deriveOwnerFromCli(paths) : null;
  const controlToken = readOrCreateSecret(paths.controlToken, 'xln-control', paths);
  const pairingToken = await issueBrowserPairing(controlToken);
  const onboardingStage = derived
    ? 'formation'
    : existsSync(paths.brainvaultOwner) ? '' : 'create';
  const url = browserUrl(pairingToken, onboardingStage, derived?.entityId || '');
  openSystemBrowser(url);
  console.log(`xln ${mode} is running at http://localhost:8080/app`);
};

const showStatus = async () => {
  const status = await readDaemonStatus();
  if (!status) {
    console.log('xln is stopped');
    return;
  }
  const owned = ownedDaemon(status);
  if (!owned) throw new Error('PORT_8080_IS_NOT_XLNFINANCE');
  assertOwnedDaemon(status, owned.metadata);
  console.log(`xln ${owned.paths.mode} is running · runtime ${status.ready ? 'ready' : 'starting'} · ${status.version || VERSION}`);
};

const stopDaemon = async () => {
  const status = await readDaemonStatus();
  if (!status) {
    console.log('xln is already stopped');
    return;
  }
  const owned = ownedDaemon(status);
  if (!owned) throw new Error('PORT_8080_IS_NOT_XLNFINANCE');
  assertOwnedDaemon(status, owned.metadata);
  stopDaemonProcess(owned.metadata.pid);
  await waitForDaemonStop();
  rmSync(owned.paths.pid, { force: true });
  console.log('xln stopped');
};

const showLogs = () => {
  const running = ALL_PATHS.find(paths => readDaemonMetadata(paths)?.pid);
  const paths = running || TESTNET_PATHS;
  if (!existsSync(paths.log)) {
    console.log(`No logs yet: ${paths.log}`);
    return;
  }
  console.log(readFileSync(paths.log, 'utf8').split('\n').slice(-120).join('\n'));
};

const runWorkspaceScript = (command, args) => {
  try {
    const packagePath = join(process.cwd(), 'package.json');
    const workspacePackage = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (workspacePackage?.name !== 'xlnfinance' || typeof workspacePackage?.scripts?.[command] !== 'string') return false;
    const result = spawnSync('bun', ['run', command, ...args], { cwd: process.cwd(), stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const rawCommand = argv.find((argument) => !argument.startsWith('-')) || 'start';
  if (rawCommand !== 'start' && runWorkspaceScript(rawCommand, argv.slice(argv.indexOf(rawCommand) + 1))) return;
  const deriveCli = argv.includes('--derive-cli');
  const devMode = rawCommand === 'dev' || argv.includes('--dev');
  const showVersion = argv.includes('--version') || argv.includes('-v');
  const unknownFlags = argv.filter((argument) => argument.startsWith('--') && !['--derive-cli', '--dev', '--help', '--version'].includes(argument));
  if (unknownFlags.length > 0) throw new Error(`Unknown flag: ${unknownFlags[0]}`);
  const command = rawCommand;
  if (argv.includes('--help')) {
    console.log('xlnfinance [start|dev|daemon|open|status|stop|logs|version] [--derive-cli]');
    console.log('  start (default)  Connect to the current xln.finance production testnet.');
    console.log('  dev              Start the self-contained local development network.');
    console.log('  <bun script>     In an xln checkout, map exactly to bun run <script>.');
    console.log('  --derive-cli  Derive the default 1,000-shard BrainVault owner in this terminal before opening the UI.');
    return;
  }
  if (showVersion || command === 'version') return console.log(VERSION);
  if (command === 'status') return showStatus();
  if (command === 'stop') return stopDaemon();
  if (command === 'logs') return showLogs();
  if (deriveCli && command !== 'open' && command !== 'start' && command !== 'dev') {
    throw new Error('--derive-cli is supported only with start, open, or dev');
  }
  if (command === 'daemon') {
    await startDaemon(devMode ? 'dev' : 'testnet');
    return console.log(`xln ${devMode ? 'dev' : 'testnet'} daemon is running`);
  }
  if (command === 'dev') return openWallet({ deriveCli, mode: 'dev' });
  if (command === 'open') return openWallet({ deriveCli, mode: 'testnet' });
  if (command === 'start') return openWallet({ deriveCli, mode: 'testnet' });
  throw new Error(`Unknown command: ${command}. In an xln checkout, xlnfinance <script> maps to bun run <script>.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
