import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createXlnJsonRpcProvider } from '../../../../jurisdiction/adapter';

const CHAIN_ID = 31_337;
const fixture = join(import.meta.dir, '../../../fixtures/jurisdiction/j-submit-real-rpc-crash-child.ts');
const repoRoot = resolve(import.meta.dir, '../../../../..');

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
  anchorFrameHeights: number[];
  anchorFinalizedJHeights: Record<string, number>;
  receiverFunding: string;
};

type RecoveryProof = {
  runtimeId: string;
  pendingBefore: number;
  pendingAfter: number;
  submitAttempts: number;
  resultOutcome: string | null;
  resultAttemptId: string | null;
  entityNonce: number;
  nextRetryTimestampBefore: number | null;
  restoredTimestamp: number;
  finalTimestamp: number;
  retryBackoffAt: number;
  finalRuntimeHeight: number;
  finalEntityHeight: number;
  canonicalHash: string;
  runtimeHash: string;
  trustedRpcUrl: string;
  committedRpcUrl: string;
  chainNonce: string;
  senderReserve: string;
  receiverReserve: string;
  hankoBatchLogCount: number;
  anchorFrameHeights: number[];
  checkpointHeightsAtRestore: number[];
  selectedCheckpointHeight: number;
  replayedFrameCount: number;
  restoredJHistoryScannedThrough: Record<string, number | null>;
  receiverAdmissionFrames: number | null;
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
      '--code-size-limit', '65536',
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
  phase: 'crash' | 'recover' | 'pending-crash' | 'pending-recover' | 'accepted-crash' | 'prepared-crash' | 'prepared-recover'
    | 'anchor-crash' | 'anchor-recover',
  seed: string,
  anvil: ManagedAnvil,
  dbRoot: string,
  proofPath: string,
  recoveryPath: string,
  storageEnv: Record<string, string> = {},
): Promise<{ exitCode: number; signalCode: string | null; stdout: string; stderr: string }> => {
  console.info(`J_SUBMIT_REAL_RPC_CHILD_START:${phase}`);
  const child = Bun.spawn({
    cmd: [process.execPath, fixture, phase, seed, anvil.rpcUrl, proofPath, recoveryPath],
    cwd: repoRoot,
    env: {
      ...process.env,
      XLN_DB_PATH: dbRoot,
      ANVIL_RPC: anvil.rpcUrl,
      XLN_RPC_POLLING_INTERVAL_MS: '50',
      JADAPTER_TX_WAIT_TIMEOUT_MS: '10000',
      ...storageEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drain both pipes while the real RPC child runs; boot logs may fill a pipe.
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  console.info(`J_SUBMIT_REAL_RPC_CHILD_EXIT:${phase}:${exitCode}:${child.signalCode}`);
  return { exitCode, signalCode: child.signalCode, stdout, stderr };
};

test('applies a mined processBatch JEvent after the runtime is SIGKILLed before its result is durable', async () => {
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
    // Signed preparation is accepted in a later WAL frame before broadcast.
    expect(crashProof.lastSubmittedAt).toBeLessThan(crashProof.runtimeTimestamp);
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
    expect(recoveryProof.resultOutcome).toBeNull();
    expect(recoveryProof.resultAttemptId).toBeNull();
    expect(recoveryProof.entityNonce).toBe(1);
    expect(recoveryProof.nextRetryTimestampBefore).toBeNull();
    expect(recoveryProof.finalTimestamp).toBeGreaterThanOrEqual(recoveryProof.restoredTimestamp);
    expect(recoveryProof.finalTimestamp).toBeLessThan(recoveryProof.retryBackoffAt);
    expect(recoveryProof.finalRuntimeHeight).toBeGreaterThan(0);
    expect(recoveryProof.finalEntityHeight).toBeGreaterThan(0);
    expect(recoveryProof.canonicalHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recoveryProof.runtimeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recoveryProof.trustedRpcUrl).not.toBe(anvil.rpcUrl);
    expect(recoveryProof.committedRpcUrl).toBe(anvil.rpcUrl);
    expect(recoveryProof.chainNonce).toBe('1');
    expect(recoveryProof.senderReserve).toBe('90');
    expect(recoveryProof.receiverReserve).toBe('10');
    expect(recoveryProof.hankoBatchLogCount).toBe(1);
  } finally {
    await stopAnvil(anvil);
    await rm(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 120_000);

// Cut A replays the committed 'j_anchor' from the WAL tail; cut B carries it in
// a checkpoint. Either way the restored Entity keeps anchor finality and the
// mined batch applies exactly once through the authenticated J event.
const anchoredCuts = [
  { cut: 'A WAL-replayed anchor', storageEnv: {}, checkpointCarriesAnchor: false },
  { cut: 'B checkpoint-carried anchor', storageEnv: { XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES: '2' }, checkpointCarriesAnchor: true },
] as const;
for (const { cut, storageEnv, checkpointCarriesAnchor } of anchoredCuts) {
  test(`recovers anchored lazy Entities after SIGKILL before the batch result is durable (${cut})`, async () => {
    const anvil = await startAnvil();
    const root = await mkdtemp(join(tmpdir(), 'xln-j-anchor-crash-'));
    const proofPath = join(root, 'crash-proof.json');
    const recoveryPath = join(root, 'recovery-proof.json');
    const seed = `J anchor real RPC crash ${process.pid} ${cut}`;
    try {
      const crashed = await runFixture('anchor-crash', seed, anvil, join(root, 'db'), proofPath, recoveryPath, storageEnv);
      expect(crashed.exitCode, `${crashed.stdout}\n${crashed.stderr}\nanvil=${anvil.stderr}`).toBe(137);
      expect(crashed.signalCode, `${crashed.stdout}\n${crashed.stderr}`).toBe('SIGKILL');
      const crashProof = JSON.parse(await Bun.file(proofPath).text()) as CrashProof;
      expect(crashProof.anchorFrameHeights.length).toBeGreaterThan(0);
      expect(Object.keys(crashProof.anchorFinalizedJHeights)).toHaveLength(2);
      expect(crashProof.submitAttempts).toBe(1);
      expect([crashProof.chainNonce, crashProof.senderReserve, crashProof.receiverReserve]).toEqual(['1', '90', '60']);
      expect(crashProof.hankoBatchLogCount).toBe(1);

      const recovered = await runFixture('anchor-recover', seed, anvil, join(root, 'db'), proofPath, recoveryPath, storageEnv);
      expect(recovered.exitCode, `${recovered.stdout}\n${recovered.stderr}\nanvil=${anvil.stderr}`).toBe(0);
      expect(recovered.signalCode).toBeNull();
      const recoveryProof = JSON.parse(await Bun.file(recoveryPath).text()) as RecoveryProof;
      expect(recoveryProof.receiverAdmissionFrames).toBeGreaterThan(0);
      expect(recoveryProof.anchorFrameHeights).toEqual(crashProof.anchorFrameHeights);
      const anchorHeight = Math.min(...crashProof.anchorFrameHeights);
      expect(recoveryProof.checkpointHeightsAtRestore.length).toBeGreaterThan(0);
      expect(recoveryProof.checkpointHeightsAtRestore.some(height => height >= anchorHeight)).toBe(checkpointCarriesAnchor);
      // A replays the committed j_anchor frame from the WAL; B restores a checkpoint that already holds it.
      expect(recoveryProof.selectedCheckpointHeight >= anchorHeight).toBe(checkpointCarriesAnchor);
      expect(recoveryProof.selectedCheckpointHeight + recoveryProof.replayedFrameCount).toBeGreaterThanOrEqual(anchorHeight);
      expect([recoveryProof.pendingBefore, recoveryProof.pendingAfter, recoveryProof.submitAttempts]).toEqual([1, 0, 1]);
      // The pre-poll admission frame records the exact wire as observer-only 'submitted'.
      expect([recoveryProof.resultAttemptId, recoveryProof.resultOutcome]).toEqual([crashProof.attemptId, 'submitted']);
      expect(recoveryProof.entityNonce).toBe(1);
      expect([recoveryProof.chainNonce, recoveryProof.senderReserve, recoveryProof.receiverReserve]).toEqual(['1', '90', '60']);
      expect(recoveryProof.hankoBatchLogCount).toBe(1);
      console.info('J_ANCHOR_CRASH_RECOVERY_PROOF', cut, await Bun.file(recoveryPath).text());
    } finally {
      await stopAnvil(anvil);
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 60_000);
}

test('restores a pending broadcast hash after SIGKILL and polls it without a second transaction', async () => {
  const anvil = await startAnvil();
  const root = await mkdtemp(join(tmpdir(), 'xln-j-pending-recovery-'));
  try {
    const proof = join(root, 'proof.json');
    const recovered = join(root, 'recovered.json');
    const seed = `pending J recovery ${process.pid}`;
    const crash = await runFixture('pending-crash', seed, anvil, join(root, 'db'), proof, recovered);
    expect(crash.exitCode, `${crash.stdout}\n${crash.stderr}`).toBe(137);
    const result = await runFixture('pending-recover', seed, anvil, join(root, 'db'), proof, recovered);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const recovery = await Bun.file(recovered).json();
    expect(recovery).toMatchObject({ submitCalls: 0, logs: 1, status: 1 });
    console.info('J_SUBMIT_PENDING_RECOVERY_PROOF', await Bun.file(recovered).text());
  } finally {
    await stopAnvil(anvil);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('recovers the exact signed batch after node acceptance and SIGKILL before any result WAL', async () => {
  const anvil = await startAnvil();
  const root = await mkdtemp(join(tmpdir(), 'xln-j-pending-recovery-'));
  try {
    const proof = join(root, 'proof.json');
    const recovered = join(root, 'recovered.json');
    const seed = `pending J recovery ${process.pid}`;
    const crash = await runFixture('accepted-crash', seed, anvil, join(root, 'db'), proof, recovered);
    expect(crash.exitCode, `${crash.stdout}\n${crash.stderr}`).toBe(137);
    const result = await runFixture('pending-recover', seed, anvil, join(root, 'db'), proof, recovered);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const recovery = await Bun.file(recovered).json();
    expect(recovery).toMatchObject({ submitCalls: 0, logs: 1, status: 1 });
    console.info('J_SUBMIT_PENDING_RECOVERY_PROOF', await Bun.file(recovered).text());
  } finally {
    await stopAnvil(anvil);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('reserves a committed EVM nonce after SIGKILL before broadcast and after a rejected new preparation', async () => {
  const anvil = await startAnvil();
  const root = await mkdtemp(join(tmpdir(), 'xln-j-pending-recovery-'));
  try {
    const proof = join(root, 'proof.json');
    const recovered = join(root, 'recovered.json');
    const seed = `pending J recovery ${process.pid}`;
    const crash = await runFixture('prepared-crash', seed, anvil, join(root, 'db'), proof, recovered);
    expect(crash.exitCode, `${crash.stdout}\n${crash.stderr}`).toBe(137);
    const result = await runFixture('prepared-recover', seed, anvil, join(root, 'db'), proof, recovered);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const recovery = await Bun.file(recovered).json();
    expect(recovery.observed).toEqual([recovery.reservedNonce + 1, recovery.reservedNonce + 1]);
    console.info('J_SUBMIT_PENDING_RECOVERY_PROOF', await Bun.file(recovered).text());
  } finally {
    await stopAnvil(anvil);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
