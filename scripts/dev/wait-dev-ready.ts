#!/usr/bin/env bun

import { stat } from 'node:fs/promises';

export type DevReadyProbe = {
  apiUrl: string;
  webUrl: string;
  watchtowerUrl: string;
  runtimeBundle: string;
  startedAtMs: number;
};

export type DevReadyResult = { ready: true } | { ready: false; reason: string };

const fetchWithin = (url: string): Promise<Response> =>
  fetch(url, { signal: AbortSignal.timeout(2_000) });

const readObject = async (response: Response): Promise<Record<string, unknown>> => {
  const value: unknown = await response.json();
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
