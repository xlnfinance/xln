#!/usr/bin/env bun
/**
 * Managed anvil lifecycle for the RPC settlement parity harness.
 *
 * Anvil runs with its own mkdtemp TMPDIR so a parity run never garbage-collects
 * a temp directory shared with another live anvil.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createXlnJsonRpcProvider } from '../jadapter';

export type ManagedAnvil = {
  child: ChildProcess;
  tmpRoot: string;
};

export type AnvilSpawnOptions = {
  chainId: number;
  port: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForRpcReady = async (rpcUrl: string, timeoutMs = 20_000): Promise<void> => {
  const provider = createXlnJsonRpcProvider(rpcUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      await provider.getBlockNumber();
      await provider.destroy();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  await provider.destroy();
  throw new Error(`RPC not ready at ${rpcUrl}: ${lastError}`);
};

const waitForAnvilExit = async (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
};

export const startAnvil = async (options: AnvilSpawnOptions): Promise<ManagedAnvil> => {
  const anvilTmpRoot = await mkdtemp(join(tmpdir(), 'xln-rpc-settlement-anvil-'));
  const child = spawn('anvil', [
    '--host', '127.0.0.1',
    '--port', String(options.port),
    '--chain-id', String(options.chainId),
    '--mixed-mining',
    '--block-time', '1',
    '--block-gas-limit', '60000000',
    '--code-size-limit', '65536',
    '--prune-history', '256',
    '--state', join(anvilTmpRoot, 'state.json'),
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, TMPDIR: anvilTmpRoot },
  });
  child.stderr?.on('data', chunk => process.stderr.write(`[anvil] ${chunk.toString()}`));
  return { child, tmpRoot: anvilTmpRoot };
};

export const stopAnvil = async (managed: ManagedAnvil | null, keepAnvil: boolean): Promise<void> => {
  if (!managed || keepAnvil) return;
  const { child, tmpRoot } = managed;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const exited = await waitForAnvilExit(child, 3_000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForAnvilExit(child, 3_000);
    }
  }
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};
