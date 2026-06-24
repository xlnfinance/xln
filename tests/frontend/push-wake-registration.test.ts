import { beforeEach, describe, expect, test } from 'bun:test';
import { Wallet, zeroPadValue } from 'ethers';

import {
  buildPushWakeRegistrationPayload,
  buildPushWakeRegistrationRequest,
  buildPushWakeUnregisterPayload,
  buildPushWakeUnregisterRequest,
  buildWatchtowerPushRequestUrl,
  readPushWakeRegistrationRecords,
  removePushWakeRegistrationRecord,
  resolvePushWakeTarget,
  upsertPushWakeRegistrationRecord,
  type PushWakeDeviceToken,
} from '../../frontend/src/lib/utils/pushWakeRegistration';
import {
  hashPushToken,
  verifyPushRegistration,
  verifyPushUnregister,
} from '../../runtime/push/registration';

const entityId = (n: number): string => zeroPadValue(`0x${n.toString(16).padStart(2, '0')}`, 32).toLowerCase();

const installMemoryLocalStorage = (): Map<string, string> => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Partial<Storage>,
  });
  return values;
};

const makeEnv = (
  runtimeId: string,
  targetEntityId: string,
  overrides: {
    jurisdictionAddress?: string;
    rpcs?: string[];
    adapterRpcs?: string[];
  } = {},
): unknown => ({
  runtimeId,
  activeJurisdiction: 'Local',
  eReplicas: new Map([[`${targetEntityId}:${runtimeId}`, {
    entityId: targetEntityId,
    state: {
      entityId: targetEntityId,
      config: {
        jurisdiction: {
          name: 'Local',
          address: overrides.jurisdictionAddress ?? 'jreplica://Local',
          chainId: 31337,
          depositoryAddress: '0x000000000000000000000000000000000000dead',
        },
      },
    },
  }]]),
  jReplicas: new Map([['Local', {
    name: 'Local',
    chainId: 31337,
    rpcs: overrides.rpcs ?? ['http://127.0.0.1:8545'],
    jadapter: {
      rpcs: overrides.adapterRpcs ?? [],
    },
    depositoryAddress: '0x000000000000000000000000000000000000dead',
  }]]),
});

describe('push wake registration frontend contract', () => {
  beforeEach(() => installMemoryLocalStorage());

  test('builds signed register/unregister requests against compact runtime target', async () => {
    const wallet = Wallet.createRandom();
    const runtimeId = wallet.address.toLowerCase();
    const targetEntityId = entityId(9);
    const target = resolvePushWakeTarget(makeEnv(runtimeId, targetEntityId), {
      runtimeId,
      entityId: targetEntityId,
      jurisdictionName: 'Local',
    });
    const device: PushWakeDeviceToken = {
      token: 'real-device-token-from-bridge',
      platform: 'desktop',
      source: 'desktop-bridge',
    };
    const signedAt = Date.now();
    const registrationPayload = buildPushWakeRegistrationPayload(target, device, signedAt);
    const registerSignature = await wallet.signMessage(registrationPayload.message);
    const registerRequest = buildPushWakeRegistrationRequest(target, device, signedAt, registerSignature);

    const verifiedRegistration = verifyPushRegistration(registerRequest, { now: signedAt });
    expect(verifiedRegistration.runtimeId).toBe(runtimeId);
    expect(verifiedRegistration.entityId).toBe(targetEntityId);
    expect(verifiedRegistration.tokenHash).toBe(hashPushToken(device.token));
    expect(verifiedRegistration.rpcUrl).toBe('http://127.0.0.1:8545');

    const unregisterPayload = buildPushWakeUnregisterPayload(runtimeId, registrationPayload.tokenHash, signedAt);
    const unregisterSignature = await wallet.signMessage(unregisterPayload.message);
    const unregisterRequest = buildPushWakeUnregisterRequest(runtimeId, registrationPayload.tokenHash, signedAt, unregisterSignature);
    const verifiedUnregister = verifyPushUnregister(unregisterRequest, { now: signedAt });
    expect(verifiedUnregister).toEqual({ runtimeId, tokenHash: registrationPayload.tokenHash });
    expect('token' in unregisterRequest).toBe(false);
  });

  test('prefers server-reachable raw RPC over browser HTTPS proxy RPC', () => {
    const runtimeId = Wallet.createRandom().address.toLowerCase();
    const targetEntityId = entityId(5);
    const target = resolvePushWakeTarget(makeEnv(runtimeId, targetEntityId, {
      jurisdictionAddress: 'http://127.0.0.1:18545',
      rpcs: ['https://localhost:8080/rpc'],
    }), {
      runtimeId,
      entityId: targetEntityId,
      jurisdictionName: 'Local',
    });
    expect(target.rpcUrl).toBe('http://127.0.0.1:18545');
  });

  test('accepts explicit push wake RPC override from desktop shell', () => {
    const runtimeId = Wallet.createRandom().address.toLowerCase();
    const targetEntityId = entityId(6);
    const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __XLN_PUSH_WAKE_RPC_URLS__: { default: 'http://127.0.0.1:28545' } },
    });
    try {
      const target = resolvePushWakeTarget(makeEnv(runtimeId, targetEntityId, {
        rpcs: ['https://localhost:8080/rpc'],
      }), {
        runtimeId,
        entityId: targetEntityId,
        jurisdictionName: 'Local',
      });
      expect(target.rpcUrl).toBe('http://127.0.0.1:28545');
    } finally {
      if (previousWindow === undefined) {
        delete (globalThis as typeof globalThis & { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previousWindow,
        });
      }
    }
  });

  test('stores local registration status without raw device token', () => {
    const runtimeId = Wallet.createRandom().address.toLowerCase();
    const token = 'raw-token-must-not-be-persisted';
    const targetEntityId = entityId(7);
    const record = {
      runtimeId,
      entityId: targetEntityId,
      towerUrl: 'http://127.0.0.1:9100',
      tokenHash: hashPushToken(token),
      platform: 'ios' as const,
      chainId: 31337,
      depositoryAddress: '0x000000000000000000000000000000000000dead',
      rpcUrl: 'http://127.0.0.1:8545',
      updatedAt: 123,
    };

    upsertPushWakeRegistrationRecord(record);
    expect(readPushWakeRegistrationRecords(runtimeId, targetEntityId)).toEqual([record]);
    expect(localStorage.getItem('xln-push-wake-registrations-v1')).not.toContain(token);

    removePushWakeRegistrationRecord(record);
    expect(readPushWakeRegistrationRecords(runtimeId, targetEntityId)).toEqual([]);
  });

  test('uses same-origin proxy for local insecure tower on https page', () => {
    const url = buildWatchtowerPushRequestUrl(
      'http://127.0.0.1:9100',
      '/api/push/register',
      'https://localhost:8080/app',
    );
    expect(url).toBe(
      'https://localhost:8080/api/watchtower-proxy?target=http%3A%2F%2F127.0.0.1%3A9100&path=%2Fapi%2Fpush%2Fregister',
    );
  });
});
