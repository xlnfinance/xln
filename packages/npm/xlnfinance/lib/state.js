import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const defaultStateDir = () => {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'xlnfinance');
  if (process.platform === 'win32') {
    const localAppData = String(process.env['LOCALAPPDATA'] || '').trim();
    if (!localAppData) throw new Error('LOCALAPPDATA is required on Windows');
    return join(localAppData, 'xlnfinance');
  }
  const xdgState = String(process.env['XDG_STATE_HOME'] || '').trim();
  return join(xdgState || join(homedir(), '.local', 'state'), 'xlnfinance');
};

const STATE_ROOT = String(process.env['XLNFINANCE_STATE_DIR'] || process.env['XLND_STATE_DIR'] || '').trim()
  || defaultStateDir();
const makePaths = (mode) => {
  const stateDir = join(STATE_ROOT, mode);
  return Object.freeze({
    mode,
    stateDir,
    app: join(PACKAGE_ROOT, 'app'),
    server: join(PACKAGE_ROOT, 'dist', 'server.js'),
    brainvaultWorker: join(PACKAGE_ROOT, 'dist', 'brainvault-worker-native.js'),
    launcherClient: join(PACKAGE_ROOT, 'dist', 'launcher-client.js'),
    jurisdictionsTemplate: join(PACKAGE_ROOT, 'config', 'jurisdictions.json'),
    database: join(stateDir, 'db'),
    jurisdictions: join(stateDir, 'jurisdictions.json'),
    log: join(stateDir, 'xln.log'),
    pid: join(stateDir, 'daemon.json'),
    runtimeSeed: join(stateDir, 'runtime-seed'),
    authSeed: join(stateDir, 'runtime-auth-seed'),
    controlToken: join(stateDir, 'control-token'),
    brainvaultOwner: join(stateDir, 'brainvault-owner.json'),
  });
};

export const TESTNET_PATHS = makePaths('testnet');
export const DEV_PATHS = makePaths('dev');
export const PATHS = TESTNET_PATHS;
export const pathsForMode = (mode) => mode === 'dev' ? DEV_PATHS : TESTNET_PATHS;

const ensureStateDirectory = (paths = PATHS) => {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.stateDir, 0o700);
};

export const readOrCreateSecret = (path, prefix, paths = PATHS) => {
  ensureStateDirectory(paths);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (Buffer.byteLength(existing) < 32) throw new Error(`INVALID_SECRET:${path}`);
    chmodSync(path, 0o600);
    return existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const value = `${prefix}:${randomBytes(32).toString('hex')}`;
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${value}\n`);
    closeSync(descriptor);
    return value;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readFileSync(path, 'utf8').trim();
  }
};

export const readDaemonMetadata = (paths = PATHS) => {
  try {
    const parsed = JSON.parse(readFileSync(paths.pid, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number(parsed.pid),
      instanceId: String(parsed.instanceId || ''),
      version: String(parsed.version || ''),
      mode: String(parsed.mode || paths.mode),
      startedAt: String(parsed.startedAt || ''),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

export const writeDaemonMetadata = (metadata, paths = PATHS) => {
  ensureStateDirectory(paths);
  const temporary = `${paths.pid}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.pid);
  chmodSync(paths.pid, 0o600);
};

export const openDaemonLog = (paths = PATHS) => {
  ensureStateDirectory(paths);
  mkdirSync(dirname(paths.log), { recursive: true });
  return openSync(paths.log, 'a', 0o600);
};

const writePrivateJson = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const validateTestnetConfig = (config) => {
  if (!config || typeof config !== 'object' || !config.jurisdictions || typeof config.jurisdictions !== 'object') {
    throw new Error('XLNFINANCE_TESTNET_CONFIG_INVALID');
  }
  const arrakis = config.jurisdictions.arrakis;
  if (!arrakis || Number(arrakis.chainId) !== 31337 || arrakis.status !== 'active') {
    throw new Error('XLNFINANCE_TESTNET_ARRAKIS_INVALID');
  }
  for (const field of ['account', 'depository', 'entityProvider', 'deltaTransformer']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(arrakis.contracts?.[field] || ''))) {
      throw new Error(`XLNFINANCE_TESTNET_CONTRACT_INVALID:${field}`);
    }
  }
};

const absolutizeRpcUrls = (config, origin) => {
  delete config.ephemeralTestnet;
  for (const jurisdiction of Object.values(config.jurisdictions)) {
    if (!jurisdiction || typeof jurisdiction !== 'object' || typeof jurisdiction.rpc !== 'string') continue;
    jurisdiction.rpc = new URL(jurisdiction.rpc, origin).toString();
  }
  return config;
};

export const ensureJurisdictionsConfig = async (paths = PATHS) => {
  ensureStateDirectory(paths);
  if (paths.mode === 'testnet') {
    try {
      const response = await fetch('https://xln.finance/api/jurisdictions', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const config = absolutizeRpcUrls(await response.json(), 'https://xln.finance/');
      validateTestnetConfig(config);
      writePrivateJson(paths.jurisdictions, config);
      return { path: paths.jurisdictions, source: 'https://xln.finance/api/jurisdictions', config };
    } catch (error) {
      if (!existsSync(paths.jurisdictions)) throw error;
      const config = JSON.parse(readFileSync(paths.jurisdictions, 'utf8'));
      validateTestnetConfig(config);
      return { path: paths.jurisdictions, source: 'cached xln.finance config', config, warning: String(error) };
    }
  }
  if (!existsSync(paths.jurisdictionsTemplate)) {
    throw new Error(`XLNFINANCE_JURISDICTIONS_TEMPLATE_MISSING:${paths.jurisdictionsTemplate}`);
  }
  const config = JSON.parse(readFileSync(paths.jurisdictionsTemplate, 'utf8'));
  writePrivateJson(paths.jurisdictions, config);
  return { path: paths.jurisdictions, source: 'bundled local dev config', config };
};
