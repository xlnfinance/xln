import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isLoopbackUrl } from '../../../../core/network/p2p/loopback-url';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../core/protocol/boundary-validation';
import { readSessionConfig, roles, type SessionConfig } from '../operators/session/config';
import { integer, text } from './boundary';

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
  session?: SessionConfig;
}>;

export type StatusConfig = Readonly<{
  stand: SessionConfig<string | null>;
  authorityPath: string;
  runId: string;
  json: boolean;
}>;

/** Establish native storage ownership before any Runtime module is loaded. */
export const configureExecutionHost = (config: ExecutionConfig): void => {
  process.env['XLN_JURISDICTIONS_PATH'] = join(config.directory, 'jurisdictions.json');
  process.env['XLN_RDB_ROOT'] = config.store;
  process.env['XLN_DB_PATH'] = join(config.store, 'db');
  process.env['XLN_HLT_ENGINE'] = 'ts';
  process.env['XLN_STORAGE_SYNC_WRITES'] = '1';
  if (config.action === 'run') process.env['XLN_EVM_FEE_CEILING_WEI'] = '0';
  process.env['USDC_POC_STAGE_TIMEOUT_MS'] = '600000';
};

const standArgs = (file: string, authorityPath: string): string[] => {
  const fullPath = realpathSync(resolve(file));
  const root = dirname(fullPath);
  const stand = requireBoundaryRecord(JSON.parse(readFileSync(fullPath, 'utf8')), 'USDC_EXECUTION_STAND_INVALID');
  requireExactBoundaryKeys(
    stand,
    ['directory', 'stores'],
    ['apiBase', 'hubPort', 'mmPort', 'startupTimeoutMs'],
    'USDC_EXECUTION_STAND_FIELDS_INVALID',
  );
  const stores = requireBoundaryRecord(stand['stores'], 'USDC_EXECUTION_STAND_STORES_INVALID');
  requireExactBoundaryKeys(stores, roles, [], 'USDC_EXECUTION_STAND_STORE_ROLES_INVALID');
  const options = [
    ['apiBase', '--api-base'],
    ['hubPort', '--hub-port'],
    ['mmPort', '--mm-port'],
    ['startupTimeoutMs', '--startup-timeout-ms'],
  ] as const;
  return [
    '--directory',
    resolve(root, text(stand['directory'])),
    '--operators-only',
    '--authority-file',
    authorityPath,
    ...roles.flatMap(role => [`--${role}-store`, resolve(root, text(stores[role]))]),
    ...options.flatMap(([key, flag]) => {
      if (!Object.hasOwn(stand, key)) return [];
      return [flag, key === 'apiBase' ? text(stand[key]) : String(integer(stand[key]))];
    }),
  ];
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

const readOptions = (args: readonly string[], allowed: readonly string[], flag?: string) => {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if ((!allowed.includes(key) && key !== flag) || options.has(key)) throw new Error('USDC_EXECUTION_OPTION_INVALID');
    const value = key === flag ? 'true' : args[++index];
    if (!value || value.startsWith('--')) throw new Error('USDC_EXECUTION_OPTION_INVALID');
    options.set(key, value);
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new Error(`USDC_EXECUTION_OPTION_REQUIRED:${key}`);
    return value;
  };
  return { options, required };
};

export const readExecutionStatusConfig = (args: readonly string[]): StatusConfig => {
  const { options, required } = readOptions(args, ['--stand', '--authority-file', '--run-id'], '--json');
  const authorityPath = realpathSync(resolve(required('--authority-file')));
  return {
    stand: readSessionConfig(standArgs(required('--stand'), authorityPath), true),
    authorityPath,
    runId: required('--run-id'),
    json: options.has('--json'),
  };
};

export const readExecutionConfig = (args: readonly string[]): ExecutionConfig => {
  const [action, ...rest] = args;
  if (action !== 'prepare' && action !== 'run') throw new Error('USDC_EXECUTION_ACTION_REQUIRED');
  const { options, required } = readOptions(rest, [
    '--directory',
    '--stand',
    '--user-store',
    '--api-base',
    '--hub-url',
    '--authority-file',
    '--limits-file',
    '--run-id',
    '--output',
  ]);
  if (
    options.has('--stand') &&
    (action !== 'run' || ['--directory', '--user-store', '--api-base', '--hub-url'].some(key => options.has(key)))
  )
    throw new Error('USDC_EXECUTION_STAND_OPTIONS_CONFLICT');
  const authorityPath = action === 'run' ? realpathSync(resolve(required('--authority-file'))) : '';
  const session = options.has('--stand') ? readSessionConfig(standArgs(required('--stand'), authorityPath)) : undefined;
  const directory = session?.directory ?? realpathSync(resolve(required('--directory')));
  const output = resolve(required('--output'));
  if (existsSync(output)) throw new Error('USDC_EXECUTION_OUTPUT_ALREADY_EXISTS');
  const store = session?.stores.user ?? realpathSync(resolve(required('--user-store')));
  const child = relative(realpathSync(join(directory, 'user')), store);
  if (child.startsWith('..') || child.startsWith('/')) throw new Error('USDC_EXECUTION_FOREIGN_STORE');
  const apiBase = session?.apiBase ?? origin(options.get('--api-base') ?? 'http://localhost:8080');
  const hubUrl = session
    ? `ws://127.0.0.1:${session.hubPort}/rpc`
    : (options.get('--hub-url') ?? 'ws://127.0.0.1:18081/rpc');
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
    authorityPath,
    limitsPath: action === 'prepare' ? realpathSync(resolve(required('--limits-file'))) : '',
    runId: action === 'run' ? required('--run-id') : '',
    ...(session ? { session } : {}),
  };
};
