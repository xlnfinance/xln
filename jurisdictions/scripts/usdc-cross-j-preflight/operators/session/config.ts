import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isLoopbackUrl } from '../../../../../core/network/p2p/loopback-url';
import { readExistingIdentities } from '../../identities';

export const roles = ['hub', 'mm', 'user'] as const;
export type Role = (typeof roles)[number];
export type SessionConfig = {
  directory: string;
  apiBase: string;
  hubPort: number;
  mmPort: number;
  startupTimeoutMs: number;
  externalGateway: boolean;
  operatorsOnly: boolean;
  hubOnly?: boolean;
  authorityFile: string | null;
  stores: Record<Role, string>;
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
  '--startup-timeout-ms',
];
export const readSessionConfig = (args: readonly string[]): SessionConfig => {
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
    stores: {
      hub: storePath(directory, 'hub', options.get('--hub-store')),
      mm: storePath(directory, 'mm', options.get('--mm-store')),
      user: storePath(directory, 'user', options.get('--user-store')),
    },
  };
};

export const sessionRoles = (config: SessionConfig): readonly Role[] =>
  config.hubOnly ? ['hub'] : config.operatorsOnly ? ['hub', 'mm'] : roles;

const storePath = (directory: string, role: Role, value: string | undefined): string => {
  if (!value) throw new Error(`USDC_SESSION_STORE_REQUIRED:${role}`);
  const vaultRoot = realpathSync(join(directory, role));
  const store = realpathSync(resolve(value));
  const child = relative(vaultRoot, store);
  if (child.startsWith('..') || child.startsWith('/')) throw new Error(`USDC_SESSION_STORE_OUTSIDE_ROLE:${role}`);
  return store;
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
];
