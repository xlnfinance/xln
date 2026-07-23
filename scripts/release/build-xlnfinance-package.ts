#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { RemoteRuntimeAdapter } from '../../runtime/radapter/remote';

const ROOT = resolve(import.meta.dir, '../..');
const PACKAGE_DIR = join(ROOT, 'packages/npm/xlnfinance');
const DIST_DIR = join(PACKAGE_DIR, 'dist');
const APP_DIR = join(PACKAGE_DIR, 'app');
const FRONTEND_BUILD = join(ROOT, 'frontend/build');
const skipBuild = process.argv.includes('--skip-build');
const shouldPack = process.argv.includes('--pack');
const shouldSmoke = process.argv.includes('--smoke');

const run = (command: string, args: string[], cwd = ROOT): void => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
};

const jsonFile = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const walkFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
  })
  .sort();

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const assertPortableServerBundle = (): void => {
  const server = readFileSync(join(DIST_DIR, 'server.js'), 'utf8');
  if (server.includes(ROOT)) throw new Error(`XLNFINANCE_SERVER_BUNDLE_CONTAINS_BUILD_PATH:${ROOT}`);
  if (!server.includes('classic-level')) throw new Error('XLNFINANCE_SERVER_BUNDLE_MISSING_LEVEL_IMPORT');
};

const assertVersions = (): string => {
  const root = jsonFile<{ version: string }>(join(ROOT, 'package.json'));
  const packageFile = jsonFile<{ version: string }>(join(PACKAGE_DIR, 'package.json'));
  if (root.version !== packageFile.version) {
    throw new Error(`XLNFINANCE_VERSION_MISMATCH:root=${root.version}:package=${packageFile.version}`);
  }
  return root.version;
};

const buildPackage = (): void => {
  const version = assertVersions();
  if (!skipBuild) {
    run('bun', ['run', 'build']);
    // The frontend embeds contract artifacts. A freshly merged checkout can still
    // have ignored Hardhat artifacts from the previous source revision, so compile
    // from the current Solidity sources before copy-static-files consumes them.
    run('bun', ['run', 'compile'], join(ROOT, 'jurisdictions'));
    run('bun', ['run', 'build'], join(ROOT, 'frontend'));
  }
  rmSync(DIST_DIR, { recursive: true, force: true });
  rmSync(APP_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  run('bun', [
    'build',
    'runtime/server/index.ts',
    '--target=bun',
    '--external=classic-level',
    '--external=msgpackr-extract',
    '--external=secp256k1',
    `--outfile=${join(DIST_DIR, 'server.js')}`,
  ]);
  assertPortableServerBundle();
  cpSync(FRONTEND_BUILD, APP_DIR, {
    recursive: true,
    filter: source => basename(source) !== '.DS_Store',
  });

  const files = [...walkFiles(DIST_DIR), ...walkFiles(APP_DIR)];
  const manifest = {
    schemaVersion: 1,
    version,
    files: files.map(path => ({
      path: relative(PACKAGE_DIR, path).replaceAll('\\', '/'),
      bytes: statSync(path).size,
      sha256: sha256(path),
    })),
  };
  writeFileSync(join(DIST_DIR, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`xlnfinance ${version}: ${manifest.files.length} files ready`);
};

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload['error'] || `HTTP_${response.status}`));
  return payload;
};

const pairPackedRuntime = async (state: string): Promise<RemoteRuntimeAdapter> => {
  const controlToken = readFileSync(join(state, 'control-token'), 'utf8').trim();
  const issued = await responseJson(await fetch('http://127.0.0.1:8080/api/local-pairing/issue', {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}` },
  }));
  const consumed = await responseJson(await fetch('http://localhost:8080/api/local-pairing/consume', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:8080',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ pairingToken: issued['pairingToken'] }),
  }));
  const manifest = consumed['manifest'] as { entries?: Array<{ wsUrl?: string; token?: string }> };
  const entry = manifest.entries?.[0];
  if (!entry?.wsUrl || !entry.token) throw new Error('XLNFINANCE_PACKAGE_SMOKE_PAIRING_MANIFEST_INVALID');

  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({
    mode: 'remote',
    wsUrl: entry.wsUrl,
    authKey: entry.token,
    requestTimeoutMs: 5_000,
  });
  if (adapter.authLevel !== 'admin') throw new Error('XLNFINANCE_PACKAGE_SMOKE_ADMIN_REQUIRED');
  return adapter;
};

const awaitHeight = async (adapter: RemoteRuntimeAdapter, minimum: number): Promise<number> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const head = await adapter.read<{ latestHeight: number }>('head');
    if (head.latestHeight >= minimum) return head.latestHeight;
    await Bun.sleep(100);
  }
  throw new Error(`XLNFINANCE_PACKAGE_SMOKE_HEIGHT_TIMEOUT:${minimum}`);
};

const smokePackedPackage = async (version: string): Promise<void> => {
  const archive = join(PACKAGE_DIR, `xlnfinance-${version}.tgz`);
  const workspace = mkdtempSync(join(tmpdir(), 'xlnfinance-package-smoke-'));
  const state = join(workspace, 'state');
  const project = join(workspace, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{"private":true}\n');
  let executable = '';

  const command = (args: string[]): void => {
    const result = spawnSync('bun', args, {
      cwd: project,
      env: { ...process.env, XLNFINANCE_STATE_DIR: state },
      encoding: 'utf8',
      timeout: 90_000,
    });
    if (result.status !== 0) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      throw new Error(`XLNFINANCE_PACKAGE_SMOKE_FAILED:${args.join(' ')}\n${output}`);
    }
  };

  try {
    command(['add', archive]);
    executable = join(project, 'node_modules', '.bin', 'xlnfinance');
    command([executable, 'daemon']);
    command([executable, 'status']);
    const firstAdapter = await pairPackedRuntime(state);
    const before = (await firstAdapter.read<{ latestHeight: number }>('head')).latestHeight;
    const sequence = firstAdapter.nextCommandSequence;
    if (!sequence) throw new Error('XLNFINANCE_PACKAGE_SMOKE_COMMAND_SEQUENCE_MISSING');
    await firstAdapter.send({ runtimeTxs: [], entityInputs: [], jInputs: [] }, {
      commandId: 'xlnfinance-package-smoke-0001',
      commandSequence: sequence,
    });
    const committed = await awaitHeight(firstAdapter, before + 1);
    firstAdapter.disconnect();
    command([executable, 'stop']);
    command([executable, 'daemon']);
    command([executable, 'status']);
    const restartedAdapter = await pairPackedRuntime(state);
    const restored = await awaitHeight(restartedAdapter, committed);
    restartedAdapter.disconnect();
    command([executable, 'stop']);
    console.log(`xlnfinance ${version}: packed admin write ${before}->${committed}, restart restored ${restored}`);
  } finally {
    if (executable) {
      spawnSync('bun', [executable, 'stop'], {
        cwd: project,
        env: { ...process.env, XLNFINANCE_STATE_DIR: state },
        stdio: 'ignore',
        timeout: 10_000,
      });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
};

buildPackage();
const version = assertVersions();
if (shouldPack || shouldSmoke) run('bun', ['pm', 'pack'], PACKAGE_DIR);
if (shouldSmoke) await smokePackedPackage(version);
