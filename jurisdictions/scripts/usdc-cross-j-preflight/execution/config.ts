import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isLoopbackUrl } from '../../../../core/network/p2p/loopback-url';

export type ExecutionConfig = Readonly<{
  action: 'prepare' | 'run';
  directory: string;
  store: string;
  apiBase: string;
  hubUrl: string;
  authorityPath: string;
  limitsPath: string;
  runId: string;
  output: string;
}>;

/** Establish native storage ownership before any Runtime module is loaded. */
export const configureExecutionHost = (config: ExecutionConfig): void => {
  process.env['XLN_JURISDICTIONS_PATH'] = join(config.directory, 'jurisdictions.json');
  process.env['XLN_RDB_ROOT'] = config.store;
  process.env['XLN_DB_PATH'] = join(config.store, 'db');
  process.env['XLN_HLT_ENGINE'] = 'ts';
  process.env['XLN_STORAGE_SYNC_WRITES'] = '1';
  process.env['USDC_POC_STAGE_TIMEOUT_MS'] = '600000';
};

const origin = (value: string): string => {
  const url = new URL(value);
  if (
    !isLoopbackUrl(value) ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('USDC_EXECUTION_LOCAL_ORIGIN_REQUIRED');
  return url.origin;
};

export const readExecutionConfig = (args: readonly string[]): ExecutionConfig => {
  const [action, ...rest] = args;
  if (action !== 'prepare' && action !== 'run') throw new Error('USDC_EXECUTION_ACTION_REQUIRED');
  const allowed = [
    '--directory',
    '--user-store',
    '--api-base',
    '--hub-url',
    '--authority-file',
    '--limits-file',
    '--run-id',
    '--output',
  ];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!,
      value = rest[index + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || options.has(key))
      throw new Error('USDC_EXECUTION_OPTION_INVALID');
    options.set(key, value);
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new Error(`USDC_EXECUTION_OPTION_REQUIRED:${key}`);
    return value;
  };
  const directory = realpathSync(resolve(required('--directory')));
  const output = resolve(required('--output'));
  if (existsSync(output)) throw new Error('USDC_EXECUTION_OUTPUT_ALREADY_EXISTS');
  const store = realpathSync(resolve(required('--user-store')));
  const child = relative(realpathSync(join(directory, 'user')), store);
  if (child.startsWith('..') || child.startsWith('/')) throw new Error('USDC_EXECUTION_FOREIGN_STORE');
  const apiBase = origin(options.get('--api-base') ?? 'http://localhost:8080');
  const hubUrl = options.get('--hub-url') ?? 'ws://127.0.0.1:18081/rpc';
  const hub = new URL(hubUrl);
  if (!isLoopbackUrl(hubUrl) || hub.protocol !== 'ws:' || hub.username || hub.password || hub.search || hub.hash)
    throw new Error('USDC_EXECUTION_LOCAL_HUB_REQUIRED');
  return {
    action,
    directory,
    store,
    apiBase,
    hubUrl,
    output,
    authorityPath: action === 'run' ? realpathSync(resolve(required('--authority-file'))) : '',
    limitsPath: action === 'prepare' ? realpathSync(resolve(required('--limits-file'))) : '',
    runId: action === 'run' ? required('--run-id') : '',
  };
};
