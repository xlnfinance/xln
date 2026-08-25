import { join, resolve } from 'node:path';
import { normalizeLoopbackUrl } from '../network/p2p/loopback-url';
import { readPositiveIntegerEnv } from '../config/environment';
import { hasCliFlag, readCliOption } from '../config/cli';
import type { Args } from './orchestrator-types';
import { relayAudienceFromWebUrl } from './mesh/relay-audience';

const argsRaw = process.argv.slice(2);

export const STARTUP_TIMEOUT_MS = readPositiveIntegerEnv('XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS', 180_000);
export const CHILD_HEALTH_TIMEOUT_MS = Math.max(
  1_500,
  readPositiveIntegerEnv('XLN_CHILD_HEALTH_TIMEOUT_MS', 30_000),
);
export const HEALTH_RESPONSE_REFRESH_TIMEOUT_MS = Math.max(
  250,
  Math.min(CHILD_HEALTH_TIMEOUT_MS, readPositiveIntegerEnv('XLN_HEALTH_RESPONSE_REFRESH_TIMEOUT_MS', 1_500)),
);
export const HUB_BASELINE_TIMEOUT_MS = readPositiveIntegerEnv('XLN_HUB_BASELINE_TIMEOUT_MS', Math.max(90_000, STARTUP_TIMEOUT_MS));
export const HUB_BASELINE_STALL_TIMEOUT_MS = Math.max(
  10_000,
  readPositiveIntegerEnv('XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS', 60_000),
);
/**
 * The baseline wait has no deadline of its own: the stall detector is the only
 * exit, and it stays silent while hubs still report causal progress. A reset
 * that waits minutes therefore looks identical to one that hung. Name the
 * unmet condition on an interval so silence is never the diagnosis.
 */
export const HUB_BASELINE_STATUS_LOG_INTERVAL_MS = Math.max(
  1_000,
  readPositiveIntegerEnv('XLN_HUB_BASELINE_STATUS_LOG_INTERVAL_MS', 10_000),
);
const MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS = Math.max(
  10_000,
  readPositiveIntegerEnv('MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS', 1_500_000),
);
export const MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS = Math.max(
  10_000,
  readPositiveIntegerEnv('MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS', 60_000),
);
export const MARKET_MAKER_READY_TIMEOUT_MS = readPositiveIntegerEnv(
  'XLN_MARKET_MAKER_READY_TIMEOUT_MS',
  Math.max(MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS, STARTUP_TIMEOUT_MS),
);
export const RELAY_MARKET_MAX_SUBSCRIPTIONS = readPositiveIntegerEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTIONS', 1000);
export const RELAY_MARKET_MAX_SUBSCRIPTION_CELLS = readPositiveIntegerEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTION_CELLS', 64);
export const RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP = readPositiveIntegerEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP', 8);
export const CHILD_LOG_RING_MAX = 200;
export { HUB_COUNT, HUB_NAMES } from '../config/constants';
export const HUB_REQUIRED_TOKEN_COUNT = 3;
const RPC_PROXY_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const getArg = (name: string, defaultValue = ''): string =>
  readCliOption(argsRaw, name, defaultValue);

const hasFlag = (name: string): boolean => hasCliFlag(argsRaw, name);

const normalizeWsBaseUrl = (raw: string, defaultHost: string, defaultPort: number): string => {
  const defaultValue = `ws://${defaultHost}:${defaultPort}`;
  const value = String(raw || '').trim() || defaultValue;
  const parsed = new URL(value);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Invalid --public-ws-base-url: ${value}`);
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
};

const normalizeWsUrl = (raw: string, defaultValue: string, label: string): string => {
  const value = String(raw || '').trim() || defaultValue;
  const parsed = new URL(value);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  parsed.hash = '';
  return parsed.toString();
};

export const parseArgs = (): Args => {
  const port = Number(getArg('--port', '20002'));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port: ${String(port)}`);
  }
  const host = getArg('--host', '127.0.0.1');
  const nodeApiPortBase = Number(getArg('--node-api-port-base', String(port + 10)));
  if (!Number.isFinite(nodeApiPortBase) || nodeApiPortBase <= 0) {
    throw new Error(`Invalid --node-api-port-base: ${String(nodeApiPortBase)}`);
  }
  const nodePublicPortBase = Number(getArg('--node-public-port-base', String(nodeApiPortBase)));
  if (!Number.isFinite(nodePublicPortBase) || nodePublicPortBase <= 0) {
    throw new Error(`Invalid --node-public-port-base: ${String(nodePublicPortBase)}`);
  }
  const dbRoot = getArg('--db-root', join(process.cwd(), '.e2e-mesh-db'));
  const publicWsBaseUrl = normalizeWsBaseUrl(getArg('--public-ws-base-url', ''), host, port);
  const defaultRelayUrl = new URL(publicWsBaseUrl);
  defaultRelayUrl.pathname = '/relay';
  defaultRelayUrl.search = '';
  defaultRelayUrl.hash = '';
  const relayAudienceUrls = String(getArg('--relay-web-urls', ''))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(relayAudienceFromWebUrl);
  const rpcUrls: Record<number, string> = {};
  for (const index of RPC_PROXY_INDEXES) {
    const flag = index === 1 ? '--rpc-url' : `--rpc${index}-url`;
    const envName = index === 1 ? 'ANVIL_RPC' : `ANVIL_RPC${index}`;
    const defaultRpcUrl = index === 1
      ? process.env['ANVIL_RPC'] || 'http://localhost:8545'
      : process.env[envName] || process.env[`RPC${index}`] || process.env[`XLN_RPC${index}_URL`] || '';
    const raw = getArg(flag, index === 2 ? (process.env['ANVIL_RPC2'] || process.env['RPC_TRON'] || defaultRpcUrl) : defaultRpcUrl);
    rpcUrls[index] = raw ? normalizeLoopbackUrl(raw) : '';
  }
  return {
    host,
    port,
    relayUrl: normalizeWsUrl(getArg('--relay-url', process.env['RELAY_URL'] || ''), defaultRelayUrl.toString(), '--relay-url'),
    relayAudienceUrls,
    publicWsBaseUrl,
    nodeApiPortBase,
    nodePublicPortBase,
    rpcUrl: rpcUrls[1] || normalizeLoopbackUrl(getArg('--rpc-url', process.env['ANVIL_RPC'] || 'http://localhost:8545')),
    rpc2Url: rpcUrls[2] || '',
    rpcUrls,
    dbRoot: resolve(dbRoot),
    mmEnabled: hasFlag('--mm'),
    resetAllowed: hasFlag('--allow-reset') || process.env['XLN_MESH_RESET_ALLOWED'] === '1',
    resetToken: process.env['XLN_MESH_RESET_TOKEN'] || '',
    deferInitialReset: hasFlag('--defer-initial-reset') || process.env['XLN_MESH_DEFER_INITIAL_RESET'] === '1',
    custodyEnabled: hasFlag('--custody'),
    custodyPort: Number(getArg('--custody-port', String(port + 7))),
    custodyDaemonPort: Number(getArg('--custody-daemon-port', String(port + 8))),
    custodyDbRoot: resolve(getArg('--custody-db-root', join(dbRoot, 'custody'))),
    walletUrl: getArg('--wallet-url', `https://localhost:${port + 4}/app`),
  };
};
