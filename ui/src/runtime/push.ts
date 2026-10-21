import { Wallet } from 'ethers';
import workerAsset from '../../../frontend/static/push-wake-sw.js?url&no-inline';
import {
  canRequestPushWakeDeviceToken,
  requestPushWakeDeviceToken,
} from '@xln/frontend/lib/utils/recovery/pushWakeDevice';
import {
  buildPushWakeRegistrationPayload,
  buildPushWakeRegistrationRequest,
  buildPushWakeUnregisterPayload,
  buildPushWakeUnregisterRequest,
  buildWatchtowerPushRequestUrl,
  resolvePushWakeTarget,
} from '@xln/frontend/lib/utils/recovery/pushWakeRegistration';
import {
  readPushWakeRegistrationRecords,
  removePushWakeRegistrationRecord,
  upsertPushWakeRegistrationRecord,
} from '@xln/frontend/lib/utils/recovery/pushWakeRecords';
import type { PushWakeRegistrationRecord } from '@xln/frontend/lib/utils/recovery/pushWakeTypes';
import { getEmbeddedEnv } from './adapter';
import { derivePrivateKey, runtimeIdForSeed } from './keys';
import { towerHealth } from './recovery';

export { readPushWakeRegistrationRecords };
const pushPublicKey = (): string => String(import.meta.env['VITE_XLN_WEB_PUSH_PUBLIC_KEY'] || '').trim();
export const pushDeviceAvailable = (): boolean => canRequestPushWakeDeviceToken(pushPublicKey());

async function request(
  tower: string,
  path: '/api/push/register' | '/api/push/unregister',
  body: unknown,
): Promise<void> {
  const response = await fetch(buildWatchtowerPushRequestUrl(tower, path), {
    method: path.endsWith('/register') ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true)
    throw new Error(`Notification registration failed: HTTP ${response.status}`);
}

export async function enablePush(seed: string, entityId: string, towers: string[]): Promise<void> {
  const env = getEmbeddedEnv();
  const runtimeId = runtimeIdForSeed(seed);
  if (!env || env.runtimeId?.toLowerCase() !== runtimeId)
    throw new Error('Unlock this wallet on the device receiving notifications');
  if (!towers.length || !pushDeviceAvailable())
    throw new Error('Configure a notification-capable tower and a device notification provider');
  for (const tower of towers) {
    const health = await towerHealth(tower);
    if (!health.pushEnabled || health.pushSender === 'console')
      throw new Error(`${tower}: notification delivery is not configured`);
  }
  const target = resolvePushWakeTarget(env, { runtimeId, entityId });
  const workerUrl = new URL(workerAsset, window.location.origin);
  workerUrl.searchParams.set('wallet', new URL(import.meta.env.BASE_URL, window.location.origin).href);
  const device = await requestPushWakeDeviceToken({ web: { publicKey: pushPublicKey(), workerUrl: workerUrl.href } });
  const signedAt = Date.now();
  const payload = buildPushWakeRegistrationPayload(target, device, signedAt);
  const signature = await new Wallet(derivePrivateKey(seed, 0)).signMessage(payload.message);
  const body = buildPushWakeRegistrationRequest(target, device, signedAt, signature);
  const errors: string[] = [];
  for (const towerUrl of towers) {
    try {
      await request(towerUrl, '/api/push/register', body);
      upsertPushWakeRegistrationRecord({
        ...target,
        towerUrl,
        tokenHash: payload.tokenHash,
        platform: device.platform,
        updatedAt: Date.now(),
      });
    } catch (error) {
      errors.push(`${towerUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export async function disablePush(seed: string, records: PushWakeRegistrationRecord[]): Promise<void> {
  const runtimeId = runtimeIdForSeed(seed);
  const owner = new Wallet(derivePrivateKey(seed, 0));
  const errors: string[] = [];
  for (const record of records) {
    try {
      if (record.runtimeId !== runtimeId) throw new Error('Notification registration belongs to another wallet');
      const signedAt = Date.now();
      const payload = buildPushWakeUnregisterPayload(runtimeId, record.tokenHash, signedAt);
      const signature = await owner.signMessage(payload.message);
      await request(
        record.towerUrl,
        '/api/push/unregister',
        buildPushWakeUnregisterRequest(runtimeId, record.tokenHash, signedAt, signature),
      );
      removePushWakeRegistrationRecord(record);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}
