#!/usr/bin/env bun

import { probeDevBackendReady, type DevBackendReadyProbe } from './wait-dev-ready';

const flags = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value || value.startsWith('--')) {
    throw new Error(`DEV_BACKEND_READY_ARG_INVALID:${name || 'missing'}`);
  }
  flags.set(name, value);
  index += 1;
}

const stringFlag = (name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`DEV_BACKEND_READY_ARG_INVALID:${name}`);
  return value;
};

const positiveIntegerFlag = (name: string): number => {
  const value = Number(stringFlag(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`DEV_BACKEND_READY_ARG_INVALID:${name}`);
  }
  return value;
};

const input: DevBackendReadyProbe = {
  apiUrl: stringFlag('--api-url').replace(/\/$/, ''),
  watchtowerUrl: stringFlag('--watchtower-url').replace(/\/$/, ''),
  runtimeBundle: stringFlag('--runtime-bundle'),
  startedAtMs: positiveIntegerFlag('--started-at-ms'),
};
const timeoutMs = positiveIntegerFlag('--timeout-ms');
const probeStartedAtMs = Date.now();
const deadline = probeStartedAtMs + timeoutMs;
let lastReason = 'not-started';

while (Date.now() < deadline) {
  const result = await probeDevBackendReady(input);
  if (result.ready) {
    console.log(
      `DEV_BACKEND_READY totalElapsedMs=${Date.now() - input.startedAtMs} ` +
      `probeElapsedMs=${Date.now() - probeStartedAtMs}`,
    );
    process.exit(0);
  }
  lastReason = result.reason;
  if (result.fatal) {
    console.error(`DEV_BACKEND_NOT_READY fatal=true reason=${result.reason}`);
    process.exit(1);
  }
  await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
}

console.error(`DEV_BACKEND_NOT_READY fatal=false reason=${lastReason}`);
process.exit(1);
