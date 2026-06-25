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
  display?: string;
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

const readKeys = (path: string): DevRadapterKeys => {
  const payload = JSON.parse(readFileSync(resolve(path), 'utf8')) as DevRadapterKeys;
  const readImportReady = payload.importUrl?.includes('/radapter/manage#runtime-import=')
    || payload.importUrl?.includes(`/radapter/manage#${REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM}=`);
  const adminImportReady = payload.adminImportUrl?.includes('/radapter/manage#runtime-import=')
    || payload.adminImportUrl?.includes(`/radapter/manage#${REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM}=`);
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
const api = `http://127.0.0.1:${args.apiPort}`;
const custody = `https://localhost:${args.custodyPort}`;
const custodyDaemon = `http://127.0.0.1:${args.custodyDaemonPort}`;
const watchtower = `http://127.0.0.1:${args.watchtowerPort}`;

const hyperlink = (label: string, url: string): string => {
  if (process.env['XLN_DEV_LINKS_PLAIN'] === '1') return url;
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
};

const rows: LinkRow[] = [
  { label: 'wallet', url: `${web}/app` },
  { label: 'remote import read', url: keys.importUrl!, display: '[open read import]' },
  { label: 'remote import admin', url: keys.adminImportUrl!, display: '[open admin import]' },
  { label: 'health admin', url: `${web}/health` },
  { label: 'qa cockpit', url: `${web}/qa` },
  { label: 'runs history', url: `${web}/runs` },
  { label: 'radapter inspector', url: `${web}/radapter` },
  { label: 'radapter manager', url: `${web}/radapter/manage` },
  { label: 'custody dashboard', url: custody },
  { label: 'api health', url: `${api}/api/health` },
  { label: 'custody daemon health', url: `${custodyDaemon}/api/health` },
  { label: 'watchtower health', url: `${watchtower}/api/tower/healthz` },
  { label: 'rpc ethereum', url: `http://localhost:${args.rpcPort}` },
  { label: 'rpc tron', url: `http://localhost:${args.rpc2Port}` },
];

const labelWidth = rows.reduce((width, row) => Math.max(width, row.label.length), 0);
const line = '='.repeat(88);

console.log('');
console.log(line);
console.log('XLN DEV CONTROL PANEL');
console.log(line);
for (const row of rows) {
  const value = row.display ? hyperlink(row.display, row.url) : row.url;
  console.log(`${row.label.padEnd(labelWidth)}  ${value}`);
}
console.log('-'.repeat(88));
console.log(`plain import URLs: ${resolve(args.keysPath)}`);
console.log('logs below: ANVIL, ANVIL2, MESH, WATCH, RUNTIME, VITE');
console.log('remote import links fetch fresh tokens into the manager; press Confirm in the browser.');
console.log(line);
console.log('');
