import { isUnknownRecord as isRecord } from '#lib/utils/boundary/index.ts';
import { buildPushRegistrationMessage, buildPushUnregisterMessage, hashPushToken } from '@xln/core/watchtower/push/registration';
import type { PushRegistrationRequestV1, PushUnregisterRequestV1 } from '@xln/core/watchtower/push/types';
import type { PushWakeTarget, PushWakeDeviceToken } from './pushWakeTypes';
import { normalizeRuntimeId, normalizeEntityId, normalizeAddress, normalizeChainId, normalizePlatform, normalizeDeviceToken, normalizeHttpUrl, normalizeTokenHash, normalizeTowerUrl } from './pushWakeBoundary';
const getPath = (value: unknown, path: string[]): unknown => {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const replicaEntityId = (key: string, replica: unknown): string => {
  const entityId = getPath(replica, ['entityId']) || getPath(replica, ['state', 'entityId']) || key.split(':')[0];
  return String(entityId || '').trim().toLowerCase();
};

const findEntityReplica = (env: unknown, entityId: string): unknown => {
  const target = normalizeEntityId(entityId);
  const replicas = getPath(env, ['state', 'eReplicas']);
  if (!(replicas instanceof Map)) throw new Error('PUSH_ENV_ENTITY_REPLICAS_UNAVAILABLE');
  for (const [key, replica] of replicas.entries()) {
    if (replicaEntityId(String(key), replica) === target) return replica;
  }
  throw new Error(`PUSH_ENTITY_REPLICA_NOT_FOUND:${target}`);
};

const findJReplica = (env: unknown, chainId: number, depositoryAddress: string): unknown => {
  const jReplicas = getPath(env, ['state', 'jReplicas']);
  if (!(jReplicas instanceof Map)) throw new Error('PUSH_ENV_J_REPLICAS_UNAVAILABLE');
  for (const replica of jReplicas.values()) {
    const replicaChainId = Number(getPath(replica, ['chainId']) || getPath(replica, ['jadapter', 'chainId']) || 0);
    const replicaDepository = String(
      getPath(replica, ['depositoryAddress'])
        || getPath(replica, ['contracts', 'depository'])
        || getPath(replica, ['jadapter', 'addresses', 'depository'])
        || '',
    ).trim().toLowerCase();
    if (replicaChainId === chainId && replicaDepository === depositoryAddress.toLowerCase()) return replica;
  }
  throw new Error('PUSH_JURISDICTION_REPLICA_NOT_FOUND');
};

const firstHttpRpc = (replica: unknown, preferredAddress: unknown): string => {
  const rawRpcs = getPath(replica, ['rpcs']);
  const adapterRpcs = getPath(replica, ['jadapter', 'rpcs']);
  const candidates = [
    preferredAddress,
    getPath(replica, ['rpc']),
    getPath(replica, ['jadapter', 'rpc']),
    ...(Array.isArray(adapterRpcs) ? adapterRpcs : []),
    ...(Array.isArray(rawRpcs) ? rawRpcs : []),
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (/^https?:\/\//i.test(raw)) return normalizeHttpUrl(raw, 'PUSH_RPC_URL');
  }
  throw new Error('PUSH_RPC_URL_UNAVAILABLE');
};

const resolvePushWakeRpcOverride = (chainId: number, depositoryAddress: string): string | null => {
  if (typeof window === 'undefined') return null;
  const source = (window as Window & { __XLN_PUSH_WAKE_RPC_URLS__?: unknown }).__XLN_PUSH_WAKE_RPC_URLS__;
  if (!source) return null;
  const targetKey = `${chainId}:${depositoryAddress.toLowerCase()}`;
  if (typeof source === 'string') return normalizeHttpUrl(source, 'PUSH_RPC_URL');
  if (isRecord(source)) {
    const exact = source[targetKey];
    const byChain = source[String(chainId)];
    const defaultEntry = source['default'];
    const value = exact || byChain || defaultEntry;
    if (typeof value === 'string') return normalizeHttpUrl(value, 'PUSH_RPC_URL');
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === 'string') return normalizeHttpUrl(entry, 'PUSH_RPC_URL');
      if (!isRecord(entry)) continue;
      const entryChainId = Math.floor(Number(entry['chainId'] || 0));
      const entryDepository = String(entry['depositoryAddress'] || '').trim().toLowerCase();
      if (entryChainId === chainId && (!entryDepository || entryDepository === depositoryAddress.toLowerCase())) {
        return normalizeHttpUrl(entry['rpcUrl'], 'PUSH_RPC_URL');
      }
    }
  }
  return null;
};

export const resolvePushWakeTarget = (
  env: unknown,
  options: {
    runtimeId: string;
    entityId: string;
    jurisdictionName?: string;
  },
): PushWakeTarget => {
  const runtimeId = normalizeRuntimeId(options.runtimeId);
  const entityId = normalizeEntityId(options.entityId);
  const replica = findEntityReplica(env, entityId);
  const jurisdiction = getPath(replica, ['state', 'config', 'jurisdiction']);
  if (!isRecord(jurisdiction)) throw new Error('PUSH_ENTITY_JURISDICTION_MISSING');

  const chainId = normalizeChainId(jurisdiction['chainId']);
  const depositoryAddress = normalizeAddress(jurisdiction['depositoryAddress'], 'PUSH_DEPOSITORY');
  const jReplica = findJReplica(env, chainId, depositoryAddress);
  const rpcUrl = resolvePushWakeRpcOverride(chainId, depositoryAddress) || firstHttpRpc(jReplica, jurisdiction['address']);

  return { runtimeId, entityId, chainId, depositoryAddress, rpcUrl };
};

export const buildWatchtowerPushRequestUrl = (
  towerUrl: string,
  towerPath: '/api/push/register' | '/api/push/unregister',
  pageHref?: string,
): string => {
  const normalizedBaseUrl = normalizeTowerUrl(towerUrl);
  const pageUrl = pageHref
    ? new URL(pageHref)
    : typeof window !== 'undefined'
      ? new URL(window.location.href)
      : null;
  const targetUrl = new URL(`${normalizedBaseUrl}/`);
  const isSecurePage = pageUrl?.protocol === 'https:';
  const isLocalInsecureTower =
    targetUrl.protocol === 'http:'
    && (targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost');
  if (pageUrl && isSecurePage && isLocalInsecureTower) {
    const proxyUrl = new URL('/api/watchtower-proxy', pageUrl.origin);
    proxyUrl.searchParams.set('target', normalizedBaseUrl);
    proxyUrl.searchParams.set('path', towerPath);
    return proxyUrl.toString();
  }
  return new URL(towerPath, `${normalizedBaseUrl}/`).toString();
};

export const buildPushWakeRegistrationPayload = (
  target: PushWakeTarget,
  device: PushWakeDeviceToken,
  signedAt: number,
): { tokenHash: string; message: string } => {
  const token = normalizeDeviceToken(device.token);
  const platform = normalizePlatform(device.platform, 'web');
  const tokenHash = hashPushToken(token);
  return {
    tokenHash,
    message: buildPushRegistrationMessage(
      target.runtimeId,
      target.entityId,
      tokenHash,
      platform,
      target.chainId,
      target.depositoryAddress,
      target.rpcUrl,
      signedAt,
    ),
  };
};

export const buildPushWakeRegistrationRequest = (
  target: PushWakeTarget,
  device: PushWakeDeviceToken,
  signedAt: number,
  ownerSignature: string,
): PushRegistrationRequestV1 => ({
  type: 'push_registration',
  version: 1,
  runtimeId: target.runtimeId,
  entityId: target.entityId,
  token: normalizeDeviceToken(device.token),
  platform: normalizePlatform(device.platform, 'web'),
  chainId: target.chainId,
  depositoryAddress: target.depositoryAddress,
  rpcUrl: target.rpcUrl,
  signedAt: Math.floor(Number(signedAt)),
  ownerSignature: String(ownerSignature || '').trim(),
});

export const buildPushWakeUnregisterPayload = (
  runtimeId: string,
  tokenHash: string,
  signedAt: number,
): { tokenHash: string; message: string } => {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  const normalizedTokenHash = normalizeTokenHash(tokenHash);
  return {
    tokenHash: normalizedTokenHash,
    message: buildPushUnregisterMessage(normalizedRuntimeId, normalizedTokenHash, signedAt),
  };
};

export const buildPushWakeUnregisterRequest = (
  runtimeId: string,
  tokenHash: string,
  signedAt: number,
  ownerSignature: string,
): PushUnregisterRequestV1 => ({
  type: 'push_unregister',
  version: 1,
  runtimeId: normalizeRuntimeId(runtimeId),
  tokenHash: normalizeTokenHash(tokenHash),
  signedAt: Math.floor(Number(signedAt)),
  ownerSignature: String(ownerSignature || '').trim(),
});
