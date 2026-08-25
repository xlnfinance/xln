#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HUB_NAMES, REMOTE_RUNTIME } from '../../../config/constants';

type DevRadapterKeys = {
  importUrl?: string;
  adminImportUrl?: string;
};

type Args = {
  webPort: number;
  webHttpPort: number;
  webScheme: 'http' | 'https';
  apiPort: number;
  rpcPort: number;
  rpc2Port: number;
  custodyPort: number;
  custodyScheme: 'http' | 'https';
  custodyDaemonPort: number;
  watchtowerPort: number;
  keysPath: string;
};

type LinkRow = {
  label: string;
  url: string;
};

const flags = new Map<string, string>();

for (let index = 2; index < process.argv.length; index += 1) {
  const current = process.argv[index];
  if (!current?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`DEV_LINKS_ARG_MISSING:${current}`);
  }
  flags.set(current, next);
  index += 1;
}

const numberFlag = (name: string): number => {
  const value = Number(flags.get(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`DEV_LINKS_ARG_INVALID:${name}`);
  }
  return value;
};

const stringFlag = (name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`DEV_LINKS_ARG_INVALID:${name}`);
  return value;
};

const schemeFlag = (name: string): 'http' | 'https' => {
  const value = stringFlag(name);
  if (value !== 'http' && value !== 'https') {
    throw new Error(`DEV_LINKS_ARG_INVALID:${name}`);
  }
  return value;
};

const readKeys = (path: string): DevRadapterKeys => {
  const payload = JSON.parse(readFileSync(resolve(path), 'utf8')) as DevRadapterKeys;
  const readImportReady = payload.importUrl?.includes(`/app#${REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM}=`);
  const adminImportReady = payload.adminImportUrl?.includes(`/app#${REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM}=`);
  if (!readImportReady) {
    throw new Error('DEV_LINKS_IMPORT_URL_MISSING');
  }
  if (!adminImportReady) {
    throw new Error('DEV_LINKS_ADMIN_IMPORT_URL_MISSING');
  }
  return payload;
};

const args: Args = {
  webPort: numberFlag('--web-port'),
  webHttpPort: numberFlag('--web-http-port'),
  webScheme: schemeFlag('--web-scheme'),
  apiPort: numberFlag('--api-port'),
  rpcPort: numberFlag('--rpc-port'),
  rpc2Port: numberFlag('--rpc2-port'),
  custodyPort: numberFlag('--custody-port'),
  custodyScheme: schemeFlag('--custody-scheme'),
  custodyDaemonPort: numberFlag('--custody-daemon-port'),
  watchtowerPort: numberFlag('--watchtower-port'),
  keysPath: stringFlag('--keys'),
};

const keys = readKeys(args.keysPath);
const web = `http://localhost:${args.webHttpPort}`;
const webTls = args.webScheme === 'https' ? `https://localhost:${args.webPort}` : null;
const api = `http://127.0.0.1:${args.apiPort}`;
const custody = `${args.custodyScheme}://localhost:${args.custodyPort}`;
const custodyDaemon = `http://127.0.0.1:${args.custodyDaemonPort}`;
const watchtower = `http://127.0.0.1:${args.watchtowerPort}`;

const rows: LinkRow[] = [
  { label: 'wallet', url: `${web}/app` },
  ...(webTls ? [{ label: 'wallet tls', url: `${webTls}/app` }] : []),
  { label: 'remote admin import', url: keys.adminImportUrl! },
  { label: 'suggested runtimes', url: `${api}/api/runtime-import?access=admin` },
  { label: 'health admin', url: `${web}/health` },
  { label: 'qa cockpit', url: `${web}/qa` },
  { label: 'runs history', url: `${web}/runs` },
  { label: 'custody dashboard', url: custody },
  { label: 'api health', url: `${api}/api/health` },
  { label: 'custody daemon health', url: `${custodyDaemon}/api/health` },
  { label: 'watchtower health', url: `${watchtower}/api/tower/healthz` },
  { label: 'rpc ethereum', url: `http://localhost:${args.rpcPort}` },
  { label: 'rpc tron', url: `http://localhost:${args.rpc2Port}` },
];

const labelWidth = rows.reduce((width, row) => Math.max(width, row.label.length), 0);
const line = '='.repeat(88);
const expectedRemoteRuntimes = [...HUB_NAMES, 'MM', 'Custody'].join(', ');

console.log('');
console.log(line);
console.log('xln dev control panel');
console.log('Services are starting. Wait for DEV_READY before opening links.');
console.log(line);
for (const row of rows) {
  console.log(`${row.label.padEnd(labelWidth)}  ${row.url}`);
}
console.log('-'.repeat(88));
console.log(`runtime import key file: ${resolve(args.keysPath)}`);
console.log('suggested runtimes endpoint lists fresh H/MM/Custody import tokens for the app runtime list.');
console.log(`expected remote runtimes: ${expectedRemoteRuntimes}`);
console.log(`local tls: ${webTls ? `enabled at ${webTls}` : 'disabled; localhost HTTP remains a secure browser context'}`);
console.log('status/logs below: ANVIL, ANVIL2, MESH, WATCH, RUNTIME, VITE, VITE_HTTP, READY');
console.log(line);
console.log('');
