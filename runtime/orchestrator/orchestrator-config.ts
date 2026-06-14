import { join, resolve } from 'node:path';
import { normalizeLoopbackUrl } from '../loopback-url';
import type { Args } from './orchestrator-types';

const argsRaw = process.argv.slice(2);

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const STARTUP_TIMEOUT_MS = readPositiveIntEnv('XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS', 180_000);
export const HUB_SELF_READY_TIMEOUT_MS = readPositiveIntEnv('XLN_HUB_SELF_READY_TIMEOUT_MS', STARTUP_TIMEOUT_MS);
export const HUB_PROFILES_READY_TIMEOUT_MS = readPositiveIntEnv('XLN_HUB_PROFILES_READY_TIMEOUT_MS', 5_000);
export const HUB_BASELINE_TIMEOUT_MS = readPositiveIntEnv('XLN_HUB_BASELINE_TIMEOUT_MS', Math.max(90_000, STARTUP_TIMEOUT_MS));
export const HUB_DIRECT_LINK_BASELINE_GRACE_MS = readPositiveIntEnv('XLN_HUB_DIRECT_LINK_BASELINE_GRACE_MS', 5_000);
export const MARKET_MAKER_READY_TIMEOUT_MS = readPositiveIntEnv('XLN_MARKET_MAKER_READY_TIMEOUT_MS', Math.max(300_000, STARTUP_TIMEOUT_MS));
export const RELAY_MARKET_MAX_SUBSCRIPTIONS = readPositiveIntEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTIONS', 1000);
export const RELAY_MARKET_MAX_SUBSCRIPTION_CELLS = readPositiveIntEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTION_CELLS', 64);
export const RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP = readPositiveIntEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP', 8);
export const CHILD_LOG_RING_MAX = 30;
export const HUB_NAMES = ['H1', 'H2', 'H3'] as const;
export const HUB_REQUIRED_TOKEN_COUNT = 3;

const getArg = (name: string, fallback = ''): string => {
  const eq = argsRaw.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argsRaw.indexOf(name);
  if (index === -1) return fallback;
  return argsRaw[index + 1] || fallback;
};

const hasFlag = (name: string): boolean => argsRaw.includes(name);

const normalizeWsBaseUrl = (raw: string, fallbackHost: string, fallbackPort: number): string => {
  const fallback = `ws://${fallbackHost}:${fallbackPort}`;
  const value = String(raw || '').trim() || fallback;
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

const normalizeWsUrl = (raw: string, fallback: string, label: string): string => {
  const value = String(raw || '').trim() || fallback;
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
  const fallbackRelayUrl = new URL(publicWsBaseUrl);
  fallbackRelayUrl.pathname = '/relay';
  fallbackRelayUrl.search = '';
  fallbackRelayUrl.hash = '';
  return {
    host,
    port,
    relayUrl: normalizeWsUrl(getArg('--relay-url', process.env['RELAY_URL'] || ''), fallbackRelayUrl.toString(), '--relay-url'),
    publicWsBaseUrl,
    nodeApiPortBase,
    nodePublicPortBase,
    rpcUrl: normalizeLoopbackUrl(getArg('--rpc-url', process.env['ANVIL_RPC'] || 'http://localhost:8545')),
    rpc2Url: normalizeLoopbackUrl(getArg('--rpc2-url', process.env['ANVIL_RPC2'] || '')),
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
