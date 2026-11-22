import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';

const cli = 'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/progress.ts';
const hash = '0x' + 'ab'.repeat(32);
const slot = (step: string, status: string, nonce = 0, runId = 'demo-01') =>
  `USDC_EXECUTION_PROGRESS_SLOT:${safeStringify({ step, chainId: 11155111, nonce, hash, status, runId })}\n`;

const invoke = (directory: string, ...options: string[]) =>
  Bun.spawnSync([process.execPath, cli, directory, ...options], { timeout: 3_000 });

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xln-usdc-progress-')));
  const directory = join(root, 'restore-demo');
  mkdirSync(directory);
  return { root, directory, close: () => rmSync(root, { recursive: true, force: true }) };
};

test('reports user catch-up and ignores an in-flight log line in a read-only session', () => {
  const { directory, close } = fixture();
  try {
    writeFileSync(join(directory, 'user-restored.json'), '{"height":32}');
    writeFileSync(
      join(directory, 'user.log'),
      [
        '[INFO][jadapter.rpc] watcher.startup_progress {"complete":false,"chains":[{"chainId":11155111,"targetBlock":150,"authenticatedThrough":90,"committedCursor":85}]}',
        '[INFO][jadapter.rpc] watcher.authenticated_range {"chainId":11155111,"fromBlock":91,"toBlock":120,"committedBeforeRange":85}',
        '[INFO][jadapter.rpc] watcher.authenticated_range {',
      ].join('\n'),
    );
    const result = invoke(directory);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('User  authenticating J history (WAL frame at startup 32)');
    expect(result.stdout.toString()).toContain(
      'first 91 | authenticated through 120 | last reported committed cursor 85 | startup target 150 | 30 blocks remaining',
    );
  } finally {
    close();
  }
});

test('reports supervised deadline, RPC timing and slot evidence and stops watch after exit', () => {
  const { root, directory, close } = fixture();
  const journey = join(root, 'journey-demo');
  mkdirSync(journey);
  try {
    const expiresAt = Date.now() + 60_000;
    writeFileSync(
      join(journey, 'launcher.log'),
      `USDC_EXECUTION_PROGRESS_RUN:${safeStringify({ runId: 'demo-01', expiresAt })}\n`,
    );
    writeFileSync(
      join(journey, 'supervisor.log'),
      `USDC_SESSION_DIRECTORY:${directory}\nUSDC_SESSION_READY:${directory}\n`,
    );
    writeFileSync(join(journey, 'exit-status'), '1\n');
    writeFileSync(
      join(directory, 'gateway.log'),
      [
        'USDC_PREFLIGHT_HEADER_TIMING:{"id":1,"chainId":11155111,"phase":"queued","elapsedMs":0}',
        'USDC_PREFLIGHT_HEADER_TIMING:{"id":1,"chainId":11155111,"phase":"admitted","elapsedMs":700}',
        'USDC_PREFLIGHT_HEADER_TIMING:{"id":1,"chainId":11155111,"phase":"sent","elapsedMs":800}',
        'USDC_PREFLIGHT_HEADER_TIMING:{"id":1,"chainId":11155111,"phase":"upstream-replied","elapsedMs":931}',
        'USDC_HYPERRPC_RECEIPTS:{"queueMs":200,"ms":90}',
        'USDC_HYPERSYNC_RANGE_TIMING:{"queueMs":300,"upstreamMs":110}',
      ].join('\n') +
        '\n' +
        slot('approval', 'submitted') +
        slot('deposit', 'attempted', 1) +
        slot('collateral', 'submitted', 2) +
        slot('approval', 'reverted', 3, 'other-run'),
    );
    writeFileSync(
      join(journey, 'execution.log'),
      'USDC_POC_STAGE:execution-user-relay-connected\n' +
        slot('approval', 'confirmed') +
        slot('collateral', 'unavailable', 2) +
        slot('withdrawal', 'conflict'),
    );
    const result = invoke(journey, '--watch');
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain('Launcher exited (1)');
    expect(output).toContain(`Run demo-01 | authority expires ${new Date(expiresAt).toISOString()}`);
    expect(output).toContain('Ethereum Sepolia headers  queue 700 ms | upstream 131 ms');
    expect(output).toContain('HyperRPC receipts  queue 200 ms | upstream 90 ms');
    expect(output).toContain('HyperSync range  queue 300 ms | upstream 110 ms');
    expect(output).toContain('approval nonce 0  confirmed');
    expect(output).toContain('deposit nonce 1  attempted, acceptance unknown');
    expect(output).toContain('collateral nonce 2  accepted by RPC | receipt evidence unavailable');
    expect(output).toContain(`withdrawal nonce 0  nonce conflict  ${hash}`);
    expect(output).not.toContain('nonce 3');
  } finally {
    close();
  }
});

test('rejects a journey log that references a restore outside its sessions directory', () => {
  const { root, directory, close } = fixture();
  const journey = join(root, 'nested', 'journey-demo');
  mkdirSync(journey, { recursive: true });
  try {
    writeFileSync(join(journey, 'supervisor.log'), `USDC_SESSION_DIRECTORY:${directory}\n`);
    const result = invoke(journey);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('PROGRESS_SESSION_OUTSIDE_JOB_DIRECTORY');
  } finally {
    close();
  }
});
