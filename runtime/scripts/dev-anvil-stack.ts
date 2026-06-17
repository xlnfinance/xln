import { spawn, type ChildProcess } from 'node:child_process';

import { createJAdapter, createXlnJsonRpcProvider } from '../jadapter';
import { ensureLocalDisputeDelayConfigured } from '../jadapter/local-config';

type Args = {
  name: string;
  ticker: string;
  port: number;
  host: string;
  chainId: number;
  blockTime: number;
  spawnAnvil: boolean;
  keepAlive: boolean;
  jsonOnly: boolean;
};

const parseArgs = (): Args => {
  const flags = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!current?.startsWith('--')) continue;
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(current, true);
      continue;
    }
    flags.set(current, next);
    index += 1;
  }

  const port = Number(flags.get('--port') || 8546);
  const chainId = Number(flags.get('--chain-id') || 31337);
  const blockTime = Number(flags.get('--block-time') || process.env['XLN_ANVIL_BLOCK_TIME'] || 1);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port: ${String(flags.get('--port') || '')}`);
  }
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`Invalid --chain-id: ${String(flags.get('--chain-id') || '')}`);
  }
  if (!Number.isFinite(blockTime) || blockTime <= 0) {
    throw new Error(`Invalid --block-time: ${String(flags.get('--block-time') || '')}`);
  }

  return {
    name: String(flags.get('--name') || 'Localhost 2'),
    ticker: String(flags.get('--ticker') || 'ETH'),
    port: Math.floor(port),
    host: String(flags.get('--host') || '127.0.0.1'),
    chainId: Math.floor(chainId),
    blockTime: Math.floor(blockTime),
    spawnAnvil: flags.has('--spawn-anvil'),
    keepAlive: flags.has('--keep-alive'),
    jsonOnly: flags.has('--json-only'),
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const destroyProvider = async (provider: unknown): Promise<void> => {
  const destroy = (provider as { destroy?: () => void | Promise<void> }).destroy;
  if (typeof destroy === 'function') {
    await destroy.call(provider);
  }
};

const waitForRpcReady = async (rpcUrl: string, timeoutMs = 20_000): Promise<void> => {
  const provider = createXlnJsonRpcProvider(rpcUrl);
  try {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'unknown';
    while (Date.now() < deadline) {
      try {
        await provider.getBlockNumber();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(250);
      }
    }
    throw new Error(`RPC not ready at ${rpcUrl}: ${lastError}`);
  } finally {
    await destroyProvider(provider);
  }
};

const log = (enabled: boolean, message: string): void => {
  if (enabled) console.log(message);
};

const keepAlive = (): Promise<void> =>
  new Promise(() => undefined);

const childExited = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

const main = async (): Promise<void> => {
  const args = parseArgs();
  const rpcUrl = `http://${args.host}:${args.port}`;
  const verbose = !args.jsonOnly;
  let anvil: ChildProcess | null = null;

  if (args.spawnAnvil) {
    log(verbose, `[dev-anvil-stack] starting anvil on ${rpcUrl}`);
    anvil = spawn('anvil', [
      '--host', args.host,
      '--port', String(args.port),
      '--chain-id', String(args.chainId),
      '--mixed-mining',
      '--block-time', String(args.blockTime),
      '--block-gas-limit', '60000000',
      '--code-size-limit', '65536',
    ], {
      stdio: args.jsonOnly ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    const activeAnvil = anvil;
    if (!args.jsonOnly && activeAnvil.stdout) activeAnvil.stdout.on('data', () => undefined);
    if (!args.jsonOnly && activeAnvil.stderr) activeAnvil.stderr.on('data', () => undefined);
  }

  const cleanup = (): void => {
    const child = anvil;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
  };

  const stopSpawnedAnvil = async (): Promise<void> => {
    const child = anvil;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (anvil === child) anvil = null;
      return;
    }

    child.kill('SIGTERM');
    const exited = await Promise.race([
      childExited(child).then(() => true),
      sleep(2_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await childExited(child);
    }
    if (anvil === child) anvil = null;
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('exit', cleanup);

  await waitForRpcReady(rpcUrl);
  const jadapter = await createJAdapter({
    mode: 'rpc',
    chainId: args.chainId,
    rpcUrl,
  });
  await jadapter.deployStack();
  const defaultDisputeDelayBlocks = await ensureLocalDisputeDelayConfigured(jadapter, args.name);

  const config = {
    name: args.name,
    mode: 'rpc' as const,
    chainId: args.chainId,
    ticker: args.ticker,
    rpcs: [rpcUrl],
    contracts: {
      account: jadapter.addresses.account,
      depository: jadapter.addresses.depository,
      entityProvider: jadapter.addresses.entityProvider,
      deltaTransformer: jadapter.addresses.deltaTransformer,
    },
    ...(Number.isFinite(defaultDisputeDelayBlocks) && defaultDisputeDelayBlocks
      ? { defaultDisputeDelayBlocks }
      : {}),
    createdAt: Date.now(),
  };

  console.log(args.jsonOnly ? JSON.stringify(config) : JSON.stringify(config, null, 2));

  if (args.keepAlive) {
    log(verbose, '[dev-anvil-stack] stack ready; keeping process alive');
    await keepAlive();
    return;
  }

  await destroyProvider(jadapter.provider);
  await stopSpawnedAnvil();
};

await main();
