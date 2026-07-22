import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
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

export const STATE_DIR = String(process.env['XLNFINANCE_STATE_DIR'] || '').trim() || defaultStateDir();
export const PATHS = Object.freeze({
  app: join(PACKAGE_ROOT, 'app'),
  server: join(PACKAGE_ROOT, 'dist', 'server.js'),
  database: join(STATE_DIR, 'db'),
  jurisdictions: join(STATE_DIR, 'jurisdictions.json'),
  log: join(STATE_DIR, 'xln.log'),
  pid: join(STATE_DIR, 'daemon.json'),
  runtimeSeed: join(STATE_DIR, 'runtime-seed'),
  authSeed: join(STATE_DIR, 'runtime-auth-seed'),
  controlToken: join(STATE_DIR, 'control-token'),
});

export const ensureStateDirectory = () => {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
};

export const readOrCreateSecret = (path, prefix) => {
  ensureStateDirectory();
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

export const readDaemonMetadata = () => {
  try {
    const parsed = JSON.parse(readFileSync(PATHS.pid, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number(parsed.pid),
      instanceId: String(parsed.instanceId || ''),
      version: String(parsed.version || ''),
      startedAt: String(parsed.startedAt || ''),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

export const writeDaemonMetadata = (metadata) => {
  ensureStateDirectory();
  const temporary = `${PATHS.pid}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, PATHS.pid);
  chmodSync(PATHS.pid, 0o600);
};

export const openDaemonLog = () => {
  ensureStateDirectory();
  mkdirSync(dirname(PATHS.log), { recursive: true });
  return openSync(PATHS.log, 'a', 0o600);
};
