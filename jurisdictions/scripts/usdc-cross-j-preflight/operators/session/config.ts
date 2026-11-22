import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isLoopbackUrl } from '../../../../../core/network/p2p/loopback-url';
import { readExistingIdentities } from '../../identities';

export const roles = ['hub', 'mm', 'user'] as const;
export const sessionWatcherEnv = (): NodeJS.ProcessEnv => ({
  XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL: process.env['XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL'],
  XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_11155111: process.env['XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_11155111'],
  XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_421614: process.env['XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL_421614'],
  XLN_J_WATCHER_RPC_HEADER_BATCH_CALLS: process.env['XLN_J_WATCHER_RPC_HEADER_BATCH_CALLS'],
  XLN_J_WATCHER_RPC_BLOCK_RANGE_421614: process.env['POC_HYPERSYNC_ARBITRUM_HEADERS'],
  XLN_J_WATCHER_RPC_RECEIPT_BATCH_CALLS_11155111: process.env['POC_HYPERRPC_ETHEREUM_RECEIPT_BATCH_CALLS'],
});

export type Role = (typeof roles)[number];
export type SessionConfig<Store = string> = {
  directory: string;
  apiBase: string;
  hubPort: number;
  mmPort: number;
  startupTimeoutMs: number;
  externalGateway: boolean;
  operatorsOnly: boolean;
  hubOnly?: boolean;
  authorityFile: string | null;
  runId?: string;
  stores: Record<Role, Store>;
};

const values = [
  '--directory',
  '--api-base',
  '--hub-port',
  '--mm-port',
  '--hub-store',
  '--mm-store',
  '--user-store',
  '--authority-file',
  '--run-id',
  '--startup-timeout-ms',
];
export function readSessionConfig(args: readonly string[]): SessionConfig;
export function readSessionConfig(args: readonly string[], inspectOnly: true): SessionConfig<string | null>;
export function readSessionConfig(args: readonly string[], inspectOnly = false): SessionConfig<string | null> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (options.has(key)) throw new Error(`USDC_SESSION_DUPLICATE_OPTION:${key}`);
    if (key === '--external-gateway' || key === '--operators-only' || key === '--hub-only') {
      options.set(key, '1');
      continue;
    }
    const value = args[++index];
    if (!values.includes(key) || !value || value.startsWith('--'))
      throw new Error(`USDC_SESSION_OPTION_INVALID:${key}`);
    options.set(key, value);
  }
  const hubOnly = options.has('--hub-only');
  if (hubOnly && (options.has('--external-gateway') || options.has('--authority-file')))
    throw new Error('USDC_SESSION_HUB_ONLY_REQUIRES_MANAGED_READ_ONLY_GATEWAY');
  const runId = options.get('--run-id');
  if (runId && (!options.has('--authority-file') || options.has('--external-gateway')))
    throw new Error('USDC_SESSION_RUN_ID_REQUIRES_OWNED_AUTHORITY');
  const directory = realpathSync(resolve(options.get('--directory') ?? '.logs/ts-usdc-cross-j-poc/public'));
  const identities = readExistingIdentities(directory);
  if (new Set(identities.flatMap(role => role.chains.map(chain => chain.entityId))).size !== 6)
    throw new Error('USDC_SESSION_IDENTITIES_NOT_DISTINCT');
  const requestedApi = options.get('--api-base') ?? 'http://localhost:8080';
  const endpoint = new URL(requestedApi);
  if (
    !isLoopbackUrl(requestedApi) ||
    endpoint.protocol !== 'http:' ||
    endpoint.pathname !== '/' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('USDC_SESSION_LOCAL_API_REQUIRED');
  const apiBase = endpoint.origin;
  const port = (key: string, defaultPort: number): number => {
    const value = Number(options.get(key) ?? defaultPort);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`USDC_SESSION_PORT_INVALID:${key}`);
    return value;
  };
  const hubPort = port('--hub-port', 18081);
  const mmPort = port('--mm-port', 18082);
  const startupTimeoutMs = Number(options.get('--startup-timeout-ms') ?? 60_000);
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 60_000)
    throw new Error('USDC_SESSION_STARTUP_BUDGET_INVALID');
  if (new Set([hubPort, mmPort, Number(endpoint.port || 80)]).size !== 3) throw new Error('USDC_SESSION_PORTS_OVERLAP');
  return {
    directory,
    apiBase,
    hubPort,
    mmPort,
    startupTimeoutMs,
    externalGateway: options.has('--external-gateway'),
    operatorsOnly: options.has('--operators-only'),
    hubOnly,
    authorityFile: options.has('--authority-file') ? realpathSync(resolve(options.get('--authority-file')!)) : null,
    ...(runId ? { runId } : {}),
    stores: {
      hub: storePath(directory, 'hub', options.get('--hub-store'), inspectOnly),
      mm: storePath(directory, 'mm', options.get('--mm-store'), inspectOnly),
      user: storePath(directory, 'user', options.get('--user-store'), inspectOnly),
    },
  };
}

export const sessionRoles = (config: SessionConfig): readonly Role[] =>
  config.hubOnly ? ['hub'] : config.operatorsOnly ? ['hub', 'mm'] : roles;

const storePath = (directory: string, role: Role, value: string | undefined, inspectOnly: boolean): string | null => {
  if (!value) throw new Error(`USDC_SESSION_STORE_REQUIRED:${role}`);
  const vaultRoot = realpathSync(join(directory, role));
  const requested = resolve(value);
  let store: string;
  try {
    store = realpathSync(requested);
  } catch (cause) {
    if (!inspectOnly || !isMissingStorePath(cause)) throw cause;
    const child = relative(vaultRoot, resolveMissingPath(requested));
    if (child.startsWith('..') || child.startsWith('/')) throw new Error(`USDC_SESSION_STORE_OUTSIDE_ROLE:${role}`);
    return null;
  }
  const child = relative(vaultRoot, store);
  if (child.startsWith('..') || child.startsWith('/')) throw new Error(`USDC_SESSION_STORE_OUTSIDE_ROLE:${role}`);
  return store;
};

const isMissingStorePath = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const resolveMissingPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (!isMissingStorePath(error) || parent === path) throw error;
    return join(resolveMissingPath(parent), basename(path));
  }
};

export const sessionArgs = (config: SessionConfig): string[] => [
  '--directory',
  config.directory,
  '--api-base',
  config.apiBase,
  '--hub-port',
  String(config.hubPort),
  '--mm-port',
  String(config.mmPort),
  '--startup-timeout-ms',
  String(config.startupTimeoutMs),
  ...roles.flatMap(role => [`--${role}-store`, config.stores[role]]),
  ...(config.externalGateway ? ['--external-gateway'] : []),
  ...(config.operatorsOnly ? ['--operators-only'] : []),
  ...(config.hubOnly ? ['--hub-only'] : []),
  ...(config.authorityFile ? ['--authority-file', config.authorityFile] : []),
  ...(config.runId ? ['--run-id', config.runId] : []),
];
