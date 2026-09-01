import { join, resolve } from 'node:path';

const DEV_RESERVED_PORTS = new Set([
  8_080, 8_081, 8_082, 8_087, 8_088,
  8_092, 8_093, 8_094, 8_095, 8_096,
  8_545, 8_546, 9_100, 17_999,
]);

const SCENARIO_STORAGE_ENV = [
  'ANVIL_TMPDIR',
  'XLN_DB_PATH',
  'XLN_DEV_DATA_ROOT',
  'XLN_JDB_ROOT',
  'XLN_MESH_DB_ROOT',
  'XLN_RDB_ROOT',
  'XLN_STORAGE_HISTORY_PATH',
] as const;

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';

export const assertScenarioRpcOutsideDev = (rpcUrl: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch (cause) {
    throw new Error(`SCENARIO_RPC_URL_INVALID:${rpcUrl}`, { cause });
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (isLoopbackHost(parsed.hostname) && DEV_RESERVED_PORTS.has(port)) {
    throw new Error(`SCENARIO_RPC_USES_DEV_PORT:${port}`);
  }
};

export const requireScenarioLeasePort = (offset: number): number => {
  const basePort = Number(process.env['XLN_SCENARIO_LEASE_BASE']);
  if (!Number.isSafeInteger(basePort) || !Number.isSafeInteger(offset) || offset < 0 || offset >= 19) {
    throw new Error(`SCENARIO_LEASE_PORT_INVALID:base=${String(process.env['XLN_SCENARIO_LEASE_BASE'])}:offset=${offset}`);
  }
  const port = basePort + offset;
  assertScenarioRpcOutsideDev(`http://127.0.0.1:${port}`);
  return port;
};

export const buildScenarioIsolatedEnv = (
  source: NodeJS.ProcessEnv,
  dbRoot: string,
  rpcUrl: string | null,
): NodeJS.ProcessEnv => {
  const env = { ...source };
  for (const name of SCENARIO_STORAGE_ENV) delete env[name];
  const root = resolve(dbRoot);
  if (rpcUrl) env['ANVIL_RPC'] = rpcUrl;
  else delete env['ANVIL_RPC'];
  env['ANVIL_TMPDIR'] = join(root, 'anvil-tmp');
  env['XLN_DB_PATH'] = root;
  env['XLN_JDB_ROOT'] = join(root, 'jdb');
  env['XLN_MESH_DB_ROOT'] = join(root, 'mesh');
  env['XLN_RDB_ROOT'] = join(root, 'rdb');
  env['XLN_STORAGE_HISTORY_PATH'] = join(root, 'history');
  return env;
};
