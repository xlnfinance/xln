import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createXlnJsonRpcProvider } from '../jadapter';

const CHAIN_ID = 31_337;
const fixture = join(import.meta.dir, 'fixtures/j-submit-real-rpc-crash-child.ts');
const repoRoot = resolve(import.meta.dir, '../..');

type ManagedAnvil = {
  child: ChildProcessWithoutNullStreams;
  rpcUrl: string;
  root: string;
  stderr: string;
};

type CrashProof = {
  runtimeId: string;
  attemptId: string;
  batchHash: string;
  txHash: string;
  blockNumber: number;
  submitAttempts: number;
  lastSubmittedAt: number;
  runtimeTimestamp: number;
  chainNonce: string;
  senderReserve: string;
  receiverReserve: string;
  hankoBatchLogCount: number;
};

type RecoveryProof = {
  runtimeId: string;
  pendingBefore: number;
  pendingAfter: number;
  submitAttempts: number;
  resultOutcome: string;
  resultAttemptId: string;
  nextRetryTimestampBefore: number | null;
  restoredTimestamp: number;
  finalTimestamp: number;
  retryBackoffAt: number;
  finalRuntimeHeight: number;
  finalEntityHeight: number;
  canonicalHash: string;
  chainNonce: string;
  senderReserve: string;
  receiverReserve: string;
  hankoBatchLogCount: number;
};

const reservePort = async (): Promise<number> => await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('J_SUBMIT_REAL_RPC_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const startAnvil = async (): Promise<ManagedAnvil> => {
  const port = await reservePort();
  const root = await mkdtemp(join(tmpdir(), 'xln-j-submit-real-rpc-anvil-'));
  const managed: ManagedAnvil = {
    child: spawn('anvil', [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--chain-id', String(CHAIN_ID),
      '--timestamp', '4102444800',
      '--block-gas-limit', '60000000',
      '--prune-history', '256',
      '--silent',
      '--state', join(root, 'state.json'),
    ], { env: { ...process.env, TMPDIR: root } }),
    rpcUrl: `http://127.0.0.1:${port}`,
    root,
    stderr: '',
  };
  managed.child.stderr.on('data', (chunk) => { managed.stderr += chunk.toString(); });
  const provider = createXlnJsonRpcProvider(managed.rpcUrl);
  try {
    let lastError = 'not ready';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await provider.getNetwork()).chainId === BigInt(CHAIN_ID)) return managed;
        lastError = 'wrong chain id';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(50);
    }
    throw new Error(`J_SUBMIT_REAL_RPC_ANVIL_NOT_READY:${lastError}\n${managed.stderr}`);
  } finally {
    await provider.destroy();
  }
};

const stopAnvil = async (managed: ManagedAnvil): Promise<void> => {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    managed.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolveExit) => managed.child.once('exit', () => resolveExit())),
      Bun.sleep(3_000).then(() => {
        if (managed.child.exitCode === null && managed.child.signalCode === null) {
          managed.child.kill('SIGKILL');
        }
      }),
    ]);
  }
  await rm(managed.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

const runFixture = async (
  phase: 'crash' | 'recover',
  seed: string,
  anvil: ManagedAnvil,
  dbRoot: string,
  proofPath: string,
  recoveryPath: string,
): Promise<{ exitCode: number; signalCode: string | null; stdout: string; stderr: string }> => {
  const child = Bun.spawn({
    cmd: [process.execPath, fixture, phase, seed, anvil.rpcUrl, proofPath, recoveryPath],
    cwd: repoRoot,
    env: {
      ...process.env,
      XLN_DB_PATH: dbRoot,
      ANVIL_RPC: anvil.rpcUrl,
      XLN_RPC_POLLING_INTERVAL_MS: '50',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, signalCode: child.signalCode, stdout, stderr };
};

test('reconciles a mined processBatch after the runtime is SIGKILLed before its result is durable', async () => {
  const anvil = await startAnvil();
  const testRoot = await mkdtemp(join(tmpdir(), 'xln-j-submit-real-rpc-test-'));
  const dbRoot = join(testRoot, 'db');
  const proofPath = join(testRoot, 'crash-proof.json');
  const recoveryPath = join(testRoot, 'recovery-proof.json');
  const seed = `J submit external Anvil crash ${process.pid} deterministic seed`;
  try {
    const crashed = await runFixture('crash', seed, anvil, dbRoot, proofPath, recoveryPath);
    expect(crashed.exitCode, `${crashed.stdout}\n${crashed.stderr}\nanvil=${anvil.stderr}`).toBe(137);
    expect(crashed.signalCode, `${crashed.stdout}\n${crashed.stderr}`).toBe('SIGKILL');
    expect(await Bun.file(proofPath).exists()).toBe(true);
    const crashProof = JSON.parse(await Bun.file(proofPath).text()) as CrashProof;
    expect(crashProof.submitAttempts).toBe(1);
    expect(crashProof.lastSubmittedAt).toBe(crashProof.runtimeTimestamp);
    expect(crashProof.chainNonce).toBe('1');
    expect(crashProof.senderReserve).toBe('90');
    expect(crashProof.receiverReserve).toBe('10');
    expect(crashProof.hankoBatchLogCount).toBe(1);

    // This provider belongs to the parent test process. The successful receipt
    // proves the chain outlived the SIGKILLed runtime instead of disappearing
    // with an in-process BrowserVM fixture.
    const parentProvider = createXlnJsonRpcProvider(anvil.rpcUrl);
    const receipt = await parentProvider.getTransactionReceipt(crashProof.txHash);
    expect(receipt?.status).toBe(1);
    expect(receipt?.blockNumber).toBe(crashProof.blockNumber);
    await parentProvider.destroy();

    const recovered = await runFixture('recover', seed, anvil, dbRoot, proofPath, recoveryPath);
    expect(recovered.exitCode, `${recovered.stdout}\n${recovered.stderr}\nanvil=${anvil.stderr}`).toBe(0);
    expect(recovered.signalCode).toBeNull();
    expect(await Bun.file(recoveryPath).exists()).toBe(true);
    const recoveryProof = JSON.parse(await Bun.file(recoveryPath).text()) as RecoveryProof;
    expect(recoveryProof.runtimeId).toBe(crashProof.runtimeId);
    expect(recoveryProof.pendingBefore).toBe(1);
    expect(recoveryProof.pendingAfter).toBe(0);
    expect(recoveryProof.submitAttempts).toBe(1);
    expect(recoveryProof.resultOutcome).toBe('reconciled');
    expect(recoveryProof.resultAttemptId).toBe(crashProof.attemptId);
    expect(recoveryProof.nextRetryTimestampBefore).toBeNull();
    expect(recoveryProof.finalTimestamp).toBeGreaterThanOrEqual(recoveryProof.restoredTimestamp);
    expect(recoveryProof.finalTimestamp).toBeLessThan(recoveryProof.retryBackoffAt);
    expect(recoveryProof.finalRuntimeHeight).toBeGreaterThan(0);
    expect(recoveryProof.finalEntityHeight).toBeGreaterThan(0);
    expect(recoveryProof.canonicalHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recoveryProof.chainNonce).toBe('1');
    expect(recoveryProof.senderReserve).toBe('90');
    expect(recoveryProof.receiverReserve).toBe('10');
    expect(recoveryProof.hankoBatchLogCount).toBe(1);
  } finally {
    await stopAnvil(anvil);
    await rm(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 120_000);
