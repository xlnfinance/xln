#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REMOTE_RUNTIME } from '../constants';

type DevRadapterKeys = {
  importUrl?: string;
  adminImportUrl?: string;
};

type Args = {
  webPort: number;
  webHttpPort: number | null;
  apiPort: number;
  rpcPort: number;
  rpc2Port: number;
  custodyPort: number;
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

const optionalNumberFlag = (name: string): number | null => {
  if (!flags.has(name)) return null;
  return numberFlag(name);
};

const stringFlag = (name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`DEV_LINKS_ARG_INVALID:${name}`);
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
  webHttpPort: optionalNumberFlag('--web-http-port'),
  apiPort: numberFlag('--api-port'),
  rpcPort: numberFlag('--rpc-port'),
  rpc2Port: numberFlag('--rpc2-port'),
  custodyPort: numberFlag('--custody-port'),
  custodyDaemonPort: numberFlag('--custody-daemon-port'),
  watchtowerPort: numberFlag('--watchtower-port'),
  keysPath: stringFlag('--keys'),
};

const keys = readKeys(args.keysPath);
const web = `https://localhost:${args.webPort}`;
const webHttp = args.webHttpPort ? `http://localhost:${args.webHttpPort}` : null;
const api = `http://127.0.0.1:${args.apiPort}`;
const custody = `https://localhost:${args.custodyPort}`;
const custodyDaemon = `http://127.0.0.1:${args.custodyDaemonPort}`;
const watchtower = `http://127.0.0.1:${args.watchtowerPort}`;

const browserRows: LinkRow[] = webHttp ? [
  { label: 'wallet browser QA', url: `${webHttp}/app` },
] : [];

const rows: LinkRow[] = [
  { label: 'wallet', url: `${web}/app` },
  ...browserRows,
  { label: 'remote import read', url: keys.importUrl! },
  { label: 'remote import admin', url: keys.adminImportUrl! },
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
const expectedRemoteRuntimes = ['H1', 'H2', 'H3', 'MM', 'Custody'].join(', ');

console.log('');
console.log(line);
console.log('XLN DEV CONTROL PANEL');
console.log('Open any subsystem from here; service status/log lines stream below this block.');
console.log(line);
for (const row of rows) {
  console.log(`${row.label.padEnd(labelWidth)}  ${row.url}`);
}
console.log('-'.repeat(88));
console.log(`runtime import key file: ${resolve(args.keysPath)}`);
console.log('runtime import links fetch fresh tokens into the app runtime list.');
console.log(`expected remote runtimes: ${expectedRemoteRuntimes}`);
console.log('status/logs below: ANVIL, ANVIL2, MESH, WATCH, RUNTIME, VITE, VITE_HTTP');
console.log(line);
console.log('');
