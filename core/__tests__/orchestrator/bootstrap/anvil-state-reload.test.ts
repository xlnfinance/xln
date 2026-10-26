import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { keccak256 } from 'ethers';

import { safeStringify } from '../../../protocol/serialization';
import { stopProcess, type ManagedChildProcess } from '../../../scripts/e2e/harness/e2e-managed-process';

const CORE_ROOT = join(import.meta.dir, '../../..');
const REPO_ROOT = join(CORE_ROOT, '..');
const NO_CREATE2_INJECTION = '--disable-default-create2-deployer';
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const STACK_DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SLOT_WRITER = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
// Runtime code: store calldata word 0 at slot 0 (PUSH0 CALLDATALOAD PUSH0 SSTORE STOP).
const SLOT_WRITER_INITCODE = '0x6005600c60003960056000f35f355f5500';
const SLOT_0 = `0x${'0'.repeat(64)}`;

const reservePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('ANVIL_RELOAD_TEST_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

const rpcCall = async (rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeStringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(`ANVIL_RELOAD_TEST_RPC:${method}:${payload.error.message || 'unknown'}`);
  return payload.result;
};

// Same persistence flags as scripts/operations/start-anvil.sh.
const startAnvil = async (port: number, root: string): Promise<ManagedChildProcess> => {
  const child = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent',
    '--block-gas-limit', '60000000', '--code-size-limit', '65536', '--prune-history', '128',
    '--state', join(root, 'anvil-state.json'), '--state-interval', '60', NO_CREATE2_INJECTION,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: root } }) as ManagedChildProcess;
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await rpcCall(rpcUrl, 'eth_chainId') === '0x7a69') return child;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(50);
  }
  throw new Error('ANVIL_RELOAD_TEST_NOT_READY');
};

const stopWithStateDump = (child: ManagedChildProcess): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ANVIL_RELOAD_TEST_SIGTERM_TIMEOUT')), 10_000);
  child.once('exit', () => {
    clearTimeout(timer);
    resolve();
  });
  child.kill('SIGTERM');
});

type HeadEvidence = { head: string; header: string; roots: string[]; create2Code: string; create2Proof: unknown };

// Binds every proof the J watcher would request at head to the head header.
const headEvidence = async (rpcUrl: string): Promise<HeadEvidence> => {
  const head = String(await rpcCall(rpcUrl, 'eth_blockNumber'));
  const block = await rpcCall(rpcUrl, 'eth_getBlockByNumber', [head, false]) as { stateRoot: string };
  const roots: string[] = [];
  let create2Proof: unknown = null;
  for (const address of [SLOT_WRITER, STACK_DEPLOYER, CREATE2_DEPLOYER]) {
    const proof = await rpcCall(rpcUrl, 'eth_getProof', [address, [SLOT_0], head]) as {
      accountProof: string[]; codeHash: string; storageHash: string; nonce: string; balance: string;
    };
    roots.push(keccak256(proof.accountProof[0]!).toLowerCase());
    if (address === CREATE2_DEPLOYER) {
      create2Proof = { codeHash: proof.codeHash, storageHash: proof.storageHash, nonce: proof.nonce, balance: proof.balance };
    }
  }
  return {
    head,
    header: block.stateRoot.toLowerCase(),
    roots,
    create2Code: String(await rpcCall(rpcUrl, 'eth_getCode', [CREATE2_DEPLOYER, head])),
    create2Proof,
  };
};

const writeSlots = async (rpcUrl: string): Promise<void> => {
  const word = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;
  await rpcCall(rpcUrl, 'eth_sendTransaction', [{ from: STACK_DEPLOYER, data: SLOT_WRITER_INITCODE }]);
  await rpcCall(rpcUrl, 'eth_sendTransaction', [{ from: STACK_DEPLOYER, to: SLOT_WRITER, data: word(7) }]);
  await rpcCall(rpcUrl, 'eth_sendTransaction', [{ from: STACK_DEPLOYER, to: SLOT_WRITER, data: word(0) }]);
};

const expectReloadProvesHeader = async (prepare: (rpcUrl: string) => Promise<void>): Promise<HeadEvidence> => {
  const port = await reservePort();
  const root = await mkdtemp(join(tmpdir(), 'xln-anvil-state-reload-'));
  const rpcUrl = `http://127.0.0.1:${port}`;
  let child: ManagedChildProcess | null = await startAnvil(port, root);
  try {
    await prepare(rpcUrl);
    const live = await headEvidence(rpcUrl);
    expect(live.roots).toEqual([live.header, live.header, live.header]);
    await stopWithStateDump(child);
    child = await startAnvil(port, root);
    const reloaded = await headEvidence(rpcUrl);
    expect(reloaded).toEqual(live);
    return reloaded;
  } finally {
    await stopProcess(child, 3_000);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
};

// The J watcher binds every eth_getProof to the hash-bound header stateRoot.
// Anvil injects its CREATE2 deployer at process start (before loading
// --state) unless told not to, and anvil_reset drops it. A dump taken after a
// reset then reloaded as dump + deployer, so every Hub restored from a
// checkpoint fail-stopped with STATE_PROOF_NODE_HASH_MISMATCH (bootstrap
// soundcheck clone, 2026-10-26).
test('a persisted Anvil chain reloaded from --state proves its head header', async () => {
  const evidence = await expectReloadProvesHeader(writeSlots);
  expect(evidence.head).toBe('0x3');
  expect(evidence.create2Code).toBe('0x');
});

test('a chain reset with anvil_reset reloads from --state without gaining the CREATE2 deployer', async () => {
  const evidence = await expectReloadProvesHeader(async rpcUrl => {
    await writeSlots(rpcUrl);
    expect(await rpcCall(rpcUrl, 'anvil_reset')).toBeNull();
    expect(await rpcCall(rpcUrl, 'eth_blockNumber')).toBe('0x0');
    await writeSlots(rpcUrl);
  });
  expect(evidence.head).toBe('0x3');
  expect(evidence.create2Code).toBe('0x');
  expect(evidence.create2Proof).toEqual({
    codeHash: keccak256('0x'),
    storageHash: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    nonce: '0x0',
    balance: '0x0',
  });
});

const listSources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(ts|sh)$/.test(name) ? [path] : [];
  });

const ANVIL_SPAWN = /spawn\(\s*(?:\[\s*)?(?:['"]anvil['"]|(?:args\.)?anvilBin)\s*,|\banvil --(?:host|port|silent|quiet)\b/;

test('every non-test Anvil start disables CREATE2 deployer injection', () => {
  const spawners = [
    ...listSources(CORE_ROOT),
    ...['scripts', 'cli', 'tools'].flatMap(dir => listSources(join(REPO_ROOT, dir))),
    join(REPO_ROOT, 'package.json'),
    join(REPO_ROOT, 'jurisdictions/package.json'),
  ]
    .filter(path => ANVIL_SPAWN.test(readFileSync(path, 'utf8')))
    .map(path => relative(REPO_ROOT, path))
    .sort();
  expect(spawners).toEqual([
    'core/scenarios/harness/boot.ts',
    'core/scripts/e2e/runners/run-e2e-parallel-isolated.ts',
    'core/scripts/e2e/runners/run-system-tests-parallel.ts',
    'core/scripts/operations/development/dev-anvil-stack.ts',
    'core/scripts/operations/settlement/rpc-settlement-anvil.ts',
    'jurisdictions/package.json',
    'scripts/dev/run-dev-child.sh',
    'scripts/operations/start-anvil.sh',
    'scripts/tron/ethereum-stand.ts',
  ]);
  for (const path of spawners) {
    const source = readFileSync(join(REPO_ROOT, path), 'utf8');
    const starts = source.split(ANVIL_SPAWN).length - 1;
    expect({ path, flags: source.split(NO_CREATE2_INJECTION).length - 1 >= starts }).toEqual({ path, flags: true });
  }
});
