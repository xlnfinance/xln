#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';
import { deriveRuntimeAdapterCapabilityToken } from '../radapter/auth';

type DevRuntime = {
  name: 'H1' | 'H2' | 'H3' | 'MM';
  portOffset: number;
};

const RUNTIMES: DevRuntime[] = [
  { name: 'H1', portOffset: 10 },
  { name: 'H2', portOffset: 11 },
  { name: 'H3', portOffset: 12 },
  { name: 'MM', portOffset: 13 },
];

const args = process.argv.slice(2);

const readArg = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] || fallback;
};

const requireNumberArg = (name: string): number => {
  const value = Number(readArg(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`DEV_RADAPTER_ARG_INVALID: ${name}`);
  }
  return value;
};

const quoteForShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const webPort = requireNumberArg('--web-port');
const apiPort = requireNumberArg('--api-port');
const outPath = resolve(readArg('--out', './db/dev/radapter-keys.json')!);
const envOutPath = resolve(readArg('--env-out', './db/dev/radapter-keys.env')!);
const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

const seeds: Record<string, string> = {};
const entries = RUNTIMES.map(runtime => {
  const seed = randomBytes(32).toString('hex');
  seeds[runtime.name] = seed;
  const wsUrl = `ws://localhost:${apiPort + runtime.portOffset}/rpc`;
  const appUrl =
    `https://localhost:${webPort}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&key=paste`;
  return {
    name: runtime.name,
    wsUrl,
    appUrl,
    authSeed: seed,
    inspectToken: deriveRuntimeAdapterCapabilityToken(seed, 'read', expiresAt, {
      keyId: `dev-${runtime.name.toLowerCase()}`,
    }),
  };
});

const payload = {
  generatedAt: new Date().toISOString(),
  expiresAt,
  note: 'Local dev secrets. This file is under db/ and must not be committed.',
  entries,
};

mkdirSync(dirname(outPath), { recursive: true });
mkdirSync(dirname(envOutPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
writeFileSync(
  envOutPath,
  `export XLN_MESH_RADAPTER_AUTH_SEEDS_JSON=${quoteForShell(JSON.stringify(seeds))}\n`,
  { mode: 0o600 },
);
chmodSync(outPath, 0o600);
chmodSync(envOutPath, 0o600);

console.log('');
console.log(`XLN dev radapter keys written to ${outPath}`);
console.log(`Runtime auth env written to ${envOutPath}`);
console.log('Open these URLs, then paste inspectToken from the key file when prompted:');
for (const entry of entries) {
  console.log(`  ${entry.name}: ${entry.appUrl}`);
}
console.log('');
