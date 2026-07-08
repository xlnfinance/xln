import { getAddress } from 'ethers';
import {
  buildPushRegistrationMessage,
  buildPushUnregisterMessage,
  hashPushToken,
} from '@xln/runtime/push/registration';
import { Capacitor } from '@capacitor/core';
import type {
  PushPlatformV1,
  PushRegistrationRequestV1,
  PushUnregisterRequestV1,
} from '@xln/runtime/push/types';
import { requestNativePaymentWakeNotifications } from '$lib/native/capacitor';

export type PushWakeDeviceToken = {
  token: string;
  platform: PushPlatformV1;
  source: 'desktop-bridge' | 'native' | 'web-push';
};

export type PushWakeTarget = {
  runtimeId: string;
  entityId: string;
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
};

export type PushWakeRegistrationRecord = PushWakeTarget & {
  towerUrl: string;
  tokenHash: string;
  platform: PushPlatformV1;
  updatedAt: number;
};

type PushWakeDesktopBridge = {
  getPushWakeToken?: () => Promise<{ value?: unknown; token?: unknown; platform?: unknown } | string>;
};

const PUSH_WAKE_RECORDS_KEY = 'xln-push-wake-registrations-v1';
const VALID_PLATFORMS = new Set<PushPlatformV1>(['ios', 'android', 'web', 'desktop']);
const MAX_DEVICE_TOKEN_LENGTH = 4096;
const DEFAULT_PUSH_TOKEN_TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeRuntimeId = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('PUSH_RUNTIME_ID_REQUIRED');
  return getAddress(raw).toLowerCase();
};

const normalizeEntityId = (value: unknown): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(raw)) throw new Error('PUSH_ENTITY_ID_INVALID');
  return raw;
};

const normalizeAddress = (value: unknown, label: string): string => {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${label}_REQUIRED`);
  return getAddress(raw).toLowerCase();
};

const normalizeChainId = (value: unknown): number => {
  const chainId = Math.floor(Number(value));
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error('PUSH_CHAIN_ID_INVALID');
  return chainId;
};

const normalizePlatform = (value: unknown, fallback: PushPlatformV1): PushPlatformV1 => {
  const platform = String(value || fallback).trim().toLowerCase() as PushPlatformV1;
  if (!VALID_PLATFORMS.has(platform)) throw new Error('PUSH_PLATFORM_INVALID');
  return platform;
};

const normalizeDeviceToken = (value: unknown): string => {
  const token = String(value || '').trim();
  if (!token || token.length > MAX_DEVICE_TOKEN_LENGTH) throw new Error('PUSH_TOKEN_INVALID');
  return token;
};

const normalizeHttpUrl = (value: unknown, label: string): string => {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${label}_REQUIRED`);
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label}_INVALID`);
  return parsed.toString().replace(/\/+$/, '');
};

const normalizeTokenHash = (value: unknown): string => {
  const tokenHash = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tokenHash)) throw new Error('PUSH_TOKEN_HASH_INVALID');
  return tokenHash;
};

const normalizeTowerUrl = (value: unknown): string => normalizeHttpUrl(value, 'PUSH_TOWER_URL');

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
  const replicas = getPath(env, ['eReplicas']);
  if (!(replicas instanceof Map)) throw new Error('PUSH_ENV_ENTITY_REPLICAS_UNAVAILABLE');
  for (const [key, replica] of replicas.entries()) {
    if (replicaEntityId(String(key), replica) === target) return replica;
  }
  throw new Error(`PUSH_ENTITY_REPLICA_NOT_FOUND:${target}`);
};

const findJReplica = (env: unknown, chainId: number, depositoryAddress: string): unknown => {
  const jReplicas = getPath(env, ['jReplicas']);
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

const firstHttpRpc = (replica: unknown, fallbackAddress: unknown): string => {
  const rawRpcs = getPath(replica, ['rpcs']);
  const adapterRpcs = getPath(replica, ['jadapter', 'rpcs']);
  const candidates = [
    fallbackAddress,
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
    const fallback = source['default'];
    const value = exact || byChain || fallback;
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

const readAllRecords = (): PushWakeRegistrationRecord[] => {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(PUSH_WAKE_RECORDS_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  const records: PushWakeRegistrationRecord[] = [];
  for (const candidate of parsed) {
    try {
      if (!isRecord(candidate)) continue;
      records.push({
        runtimeId: normalizeRuntimeId(candidate['runtimeId']),
        entityId: normalizeEntityId(candidate['entityId']),
        towerUrl: normalizeTowerUrl(candidate['towerUrl']),
        tokenHash: normalizeTokenHash(candidate['tokenHash']),
        platform: normalizePlatform(candidate['platform'], 'web'),
        chainId: normalizeChainId(candidate['chainId']),
        depositoryAddress: normalizeAddress(candidate['depositoryAddress'], 'PUSH_DEPOSITORY'),
        rpcUrl: normalizeHttpUrl(candidate['rpcUrl'], 'PUSH_RPC_URL'),
        updatedAt: Math.max(0, Math.floor(Number(candidate['updatedAt'] || 0))),
      });
    } catch {
      // Ignore malformed local status entries; server registrations remain authoritative.
    }
  }
  return records;
};

const writeAllRecords = (records: PushWakeRegistrationRecord[]): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(PUSH_WAKE_RECORDS_KEY, JSON.stringify(records));
};

export const readPushWakeRegistrationRecords = (runtimeId?: string, entityId?: string): PushWakeRegistrationRecord[] => {
  const records = readAllRecords();
  const normalizedRuntimeId = runtimeId ? normalizeRuntimeId(runtimeId) : '';
  const normalizedEntityId = entityId ? normalizeEntityId(entityId) : '';
  return records.filter((record) =>
    (!normalizedRuntimeId || record.runtimeId === normalizedRuntimeId)
    && (!normalizedEntityId || record.entityId === normalizedEntityId),
  );
};

export const upsertPushWakeRegistrationRecord = (record: PushWakeRegistrationRecord): PushWakeRegistrationRecord[] => {
  const normalized: PushWakeRegistrationRecord = {
    runtimeId: normalizeRuntimeId(record.runtimeId),
    entityId: normalizeEntityId(record.entityId),
    towerUrl: normalizeTowerUrl(record.towerUrl),
    tokenHash: normalizeTokenHash(record.tokenHash),
    platform: normalizePlatform(record.platform, 'web'),
    chainId: normalizeChainId(record.chainId),
    depositoryAddress: normalizeAddress(record.depositoryAddress, 'PUSH_DEPOSITORY'),
    rpcUrl: normalizeHttpUrl(record.rpcUrl, 'PUSH_RPC_URL'),
    updatedAt: Math.max(0, Math.floor(Number(record.updatedAt || Date.now()))),
  };
  const next = readAllRecords()
    .filter((entry) => !(
      entry.runtimeId === normalized.runtimeId
      && entry.entityId === normalized.entityId
      && entry.towerUrl === normalized.towerUrl
      && entry.tokenHash === normalized.tokenHash
    ));
  next.push(normalized);
  writeAllRecords(next);
  return next;
};

export const removePushWakeRegistrationRecord = (record: Pick<PushWakeRegistrationRecord, 'runtimeId' | 'entityId' | 'towerUrl' | 'tokenHash'>): PushWakeRegistrationRecord[] => {
  const runtimeId = normalizeRuntimeId(record.runtimeId);
  const entityId = normalizeEntityId(record.entityId);
  const towerUrl = normalizeTowerUrl(record.towerUrl);
  const tokenHash = normalizeTokenHash(record.tokenHash);
  const next = readAllRecords().filter((entry) => !(
    entry.runtimeId === runtimeId
    && entry.entityId === entityId
    && entry.towerUrl === towerUrl
    && entry.tokenHash === tokenHash
  ));
  writeAllRecords(next);
  return next;
};

const getDesktopBridge = (): PushWakeDesktopBridge | null => {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { xlnDesktop?: PushWakeDesktopBridge }).xlnDesktop;
  return candidate && typeof candidate.getPushWakeToken === 'function' ? candidate : null;
};

const normalizeBridgeToken = (
  value: { value?: unknown; token?: unknown; platform?: unknown } | string,
  source: PushWakeDeviceToken['source'],
): PushWakeDeviceToken => {
  if (typeof value === 'string') {
    return { token: normalizeDeviceToken(value), platform: source === 'desktop-bridge' ? 'desktop' : 'web', source };
  }
  return {
    token: normalizeDeviceToken(value.value || value.token),
    platform: normalizePlatform(value.platform, source === 'desktop-bridge' ? 'desktop' : 'web'),
    source,
  };
};

const waitForNativePushToken = (timeoutMs: number): Promise<PushWakeDeviceToken> =>
  new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('PUSH_NATIVE_WINDOW_UNAVAILABLE'));
      return;
    }
    const timer = window.setTimeout(() => {
      window.removeEventListener('xln-native-push-token', onToken as EventListener);
      reject(new Error('PUSH_NATIVE_TOKEN_TIMEOUT'));
    }, Math.max(1_000, timeoutMs));

    const onToken = (event: Event): void => {
      window.clearTimeout(timer);
      window.removeEventListener('xln-native-push-token', onToken as EventListener);
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      try {
        resolve({
          token: normalizeDeviceToken(detail['value'] || detail['token']),
          platform: normalizePlatform(detail['platform'], 'ios'),
          source: 'native',
        });
      } catch (error) {
        reject(error);
      }
    };

    window.addEventListener('xln-native-push-token', onToken as EventListener, { once: true });
    void requestNativePaymentWakeNotifications().catch((error) => {
      window.clearTimeout(timer);
      window.removeEventListener('xln-native-push-token', onToken as EventListener);
      reject(error);
    });
  });

const vapidKeyBytes = (base64Url: string): ArrayBuffer => {
  const padding = '='.repeat((4 - base64Url.length % 4) % 4);
  const base64 = `${base64Url}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
};

const configuredWebPushPublicKey = (): string => {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return String(meta.env?.['VITE_XLN_WEB_PUSH_PUBLIC_KEY'] || '').trim();
};

const requestWebPushToken = async (): Promise<PushWakeDeviceToken | null> => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  const publicKey = configuredWebPushPublicKey();
  if (!publicKey) return null;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('PUSH_WEB_PUSH_UNAVAILABLE');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('PUSH_WEB_PUSH_PERMISSION_DENIED');
  const registration = await navigator.serviceWorker.register('/push-wake-sw.js');
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyBytes(publicKey),
  });
  return {
    token: JSON.stringify(subscription.toJSON()),
    platform: 'web',
    source: 'web-push',
  };
};

export const requestPushWakeDeviceToken = async (options: { timeoutMs?: number } = {}): Promise<PushWakeDeviceToken> => {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    const token = await desktopBridge.getPushWakeToken!();
    return normalizeBridgeToken(token, 'desktop-bridge');
  }

  if (Capacitor.isNativePlatform()) {
    return waitForNativePushToken(options.timeoutMs ?? DEFAULT_PUSH_TOKEN_TIMEOUT_MS);
  }

  const webToken = await requestWebPushToken();
  if (webToken) return webToken;

  throw new Error('PUSH_TOKEN_PROVIDER_UNAVAILABLE');
};
