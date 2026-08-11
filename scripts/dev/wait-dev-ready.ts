#!/usr/bin/env bun

import { stat } from 'node:fs/promises';
import { deriveSignerAddressSync, signDigest } from '../../runtime/account/crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../runtime/protocol/p2p-crypto';
import {
  deserializeWsMessage,
  hashHelloMessage,
  serializeWsMessage,
} from '../../runtime/network/p2p/ws-protocol';
import { fetchLoopback, isLoopbackHttps } from '../../runtime/orchestrator/loopback-fetch';
import { relayAudienceFromWebUrl } from '../../runtime/orchestrator/relay-audience';

export type DevReadyProbe = {
  apiUrl: string;
  webUrl: string;
  relayWebUrls: string[];
  watchtowerUrl: string;
  runtimeBundle: string;
  startedAtMs: number;
};

export type DevReadyResult = { ready: true } | { ready: false; reason: string };

const fetchWithin = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetchLoopback(url, { ...init, signal: AbortSignal.timeout(2_000) });

const readObject = async (response: Response): Promise<Record<string, unknown>> => {
  const value: unknown = await response.json();
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
};

const probeRelayChallenge = (webUrl: string): Promise<DevReadyResult> => new Promise(resolve => {
  const expectedAudience = relayAudienceFromWebUrl(webUrl);
  const origin = new URL(webUrl).origin;
  const probeSeed = `xln/dev-ready/relay-auth/v1:${expectedAudience}`;
  const signerLabel = '1';
  const runtimeId = deriveSignerAddressSync(probeSeed, signerLabel).toLowerCase();
  const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(probeSeed).publicKey);
  const socket = new WebSocket(expectedAudience, {
    headers: { Origin: origin },
    // DEV uses a self-signed localhost certificate. Disable verification only
    // for this loopback readiness client; browser and non-loopback TLS policy
    // remain unchanged.
    ...(isLoopbackHttps(webUrl) ? { tls: { rejectUnauthorized: false } } : {}),
  });
  socket.binaryType = 'arraybuffer';
  let settled = false;
  const finish = (result: DevReadyResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (result.ready && socket.readyState === WebSocket.OPEN) {
      const closeFallback = setTimeout(() => resolve(result), 500);
      socket.onclose = () => {
        clearTimeout(closeFallback);
        resolve(result);
      };
      socket.close(1000, 'dev-ready-complete');
      return;
    }
    socket.close();
    resolve(result);
  };
  const timer = setTimeout(
    () => finish({ ready: false, reason: 'wallet-relay-challenge-timeout' }),
    2_000,
  );
  socket.onmessage = event => {
    try {
      const message = deserializeWsMessage(event.data as ArrayBuffer);
      if (message.type === 'hello_ack') {
        if (message.to !== runtimeId) {
          finish({ ready: false, reason: 'wallet-relay-auth-runtime-mismatch' });
          return;
        }
        finish({ ready: true });
        return;
      }
      if (message.type !== 'hello_challenge') return;
      if (message.audience !== expectedAudience) {
        finish({
          ready: false,
          reason: `wallet-relay-audience-mismatch:${String(message.audience || 'missing')}`,
        });
        return;
      }
      const timestamp = Date.now();
      socket.send(serializeWsMessage({
        type: 'hello',
        from: runtimeId,
        fromEncryptionPubKey: encryptionPubKey,
        timestamp,
        audience: expectedAudience,
        auth: {
          nonce: message.challenge!,
          timestamp,
          signature: signDigest(
            probeSeed,
            signerLabel,
            hashHelloMessage(runtimeId, encryptionPubKey, timestamp, message.challenge!, expectedAudience),
          ),
        },
      }));
    } catch (error) {
      finish({ ready: false, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  socket.onerror = () => finish({ ready: false, reason: 'wallet-relay-websocket-error' });
});

const probeOffchainFaucetPipe = async (webUrl: string): Promise<DevReadyResult> => {
  const hubsResponse = await fetchWithin(`${webUrl}/api/hubs`);
  const hubsBody = await readObject(hubsResponse);
  const hubs = Array.isArray(hubsBody['hubs']) ? hubsBody['hubs'] : [];
  const hubEntityId = String((hubs[0] as Record<string, unknown> | undefined)?.['entityId'] || '');
  if (!hubsResponse.ok || !/^0x[0-9a-fA-F]{64}$/.test(hubEntityId)) {
    return { ready: false, reason: `wallet-faucet-hubs-${hubsResponse.status}` };
  }

  // This intentionally invalid user id proves browser proxy -> orchestrator ->
  // exact hub child routing without enqueueing a financial RuntimeInput.
  const response = await fetchWithin(`${webUrl}/api/faucet/offchain`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: new URL(webUrl).origin,
    },
    body: JSON.stringify({
      userEntityId: 'dev-ready-invalid-entity',
      hubEntityId,
      tokenId: 1,
      amount: '1',
    }),
  });
  const body = await readObject(response);
  return response.status === 400 && body['code'] === 'FAUCET_INVALID_USER_ENTITY_ID'
    ? { ready: true }
    : {
        ready: false,
        reason: `wallet-faucet-pipe-${response.status}:${String(body['code'] || 'missing-code')}`,
      };
};

export const probeDevReady = async (input: DevReadyProbe): Promise<DevReadyResult> => {
  try {
    const importResponse = await fetchWithin(`${input.apiUrl}/api/runtime-import?access=admin`);
    const importStatus = await readObject(importResponse);
    if (!importResponse.ok || importStatus['ready'] !== true) {
      return {
        ready: false,
        reason: String(importStatus['reason'] || importStatus['error'] || `runtime-import-http-${importResponse.status}`),
      };
    }

    const bundle = await stat(input.runtimeBundle);
    if (bundle.size <= 0 || bundle.mtimeMs < input.startedAtMs) {
      return { ready: false, reason: 'runtime-bundle-not-fresh' };
    }

    const [appResponse, runtimeResponse, watchtowerResponse] = await Promise.all([
      fetchWithin(`${input.webUrl}/app`),
      fetchWithin(`${input.webUrl}/runtime.js`),
      fetchWithin(`${input.watchtowerUrl}/api/tower/healthz`),
    ]);
    await appResponse.body?.cancel();
    if (!appResponse.ok) return { ready: false, reason: `wallet-http-${appResponse.status}` };
    const runtimeType = runtimeResponse.headers.get('content-type') || '';
    await runtimeResponse.body?.cancel();
    if (!runtimeResponse.ok || !runtimeType.includes('javascript')) {
      return { ready: false, reason: `runtime-http-${runtimeResponse.status}` };
    }
    const watchtower = await readObject(watchtowerResponse);
    if (!watchtowerResponse.ok || watchtower['ok'] !== true) {
      return { ready: false, reason: `watchtower-http-${watchtowerResponse.status}` };
    }
    for (const webUrl of input.relayWebUrls) {
      const relay = await probeRelayChallenge(webUrl);
      if (!relay.ready) {
        return { ready: false, reason: `${webUrl}:${relay.reason}` };
      }
      const faucet = await probeOffchainFaucetPipe(webUrl);
      if (!faucet.ready) {
        return { ready: false, reason: `${webUrl}:${faucet.reason}` };
      }
    }
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const flags = new Map<string, string>();
if (import.meta.main) {
  for (let index = 2; index < process.argv.length; index += 1) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`DEV_READY_ARG_INVALID:${name || 'missing'}`);
    }
    flags.set(name, value);
    index += 1;
  }
}

const stringFlag = (name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`DEV_READY_ARG_INVALID:${name}`);
  return value;
};

const stringListFlag = (name: string): string[] => {
  const values = stringFlag(name)
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (values.length === 0) throw new Error(`DEV_READY_ARG_INVALID:${name}`);
  return [...new Set(values)];
};

const numberFlag = (name: string): number => {
  const value = Number(stringFlag(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`DEV_READY_ARG_INVALID:${name}`);
  }
  return value;
};

const waitForShutdown = (): Promise<void> => new Promise(resolve => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

if (import.meta.main) {
  const input: DevReadyProbe = {
    apiUrl: stringFlag('--api-url').replace(/\/$/, ''),
    webUrl: stringFlag('--web-url').replace(/\/$/, ''),
    relayWebUrls: stringListFlag('--relay-web-urls'),
    watchtowerUrl: stringFlag('--watchtower-url').replace(/\/$/, ''),
    runtimeBundle: stringFlag('--runtime-bundle'),
    startedAtMs: numberFlag('--started-at-ms'),
  };
  const timeoutMs = numberFlag('--timeout-ms');
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'not-started';
  let ready = false;
  while (Date.now() < deadline) {
    const result = await probeDevReady(input);
    if (result.ready) {
      ready = true;
      break;
    }
    lastReason = result.reason;
    await Bun.sleep(1_000);
  }
  const elapsedMs = Date.now() - input.startedAtMs;
  if (!ready) {
    console.error(`DEV_NOT_READY elapsedMs=${elapsedMs} reason=${lastReason}`);
    process.exit(1);
  }
  console.log(`DEV_READY elapsedMs=${elapsedMs} wallet=${input.webUrl}/app api=${input.apiUrl}`);
  await waitForShutdown();
}
