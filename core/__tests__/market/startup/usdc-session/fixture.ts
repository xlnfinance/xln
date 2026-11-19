import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JAdapter } from '../../../../jurisdiction/adapter';
import { startStandaloneRelayServer } from '../../../../network/relay/standalone-server';
import { safeStringify } from '../../../../protocol/serialization';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import {
  prepareIdentities,
  readVaultSeed,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import { deployFixtureChain } from './chain';

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('TEST_PORT_MISSING'));
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

export const until = async (label: string, ready: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`USDC_FIXTURE_TIMEOUT:${label}`);
    await Bun.sleep(50);
  }
};

export const stopFixtureChildren = async (
  children: ChildProcess[],
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> => {
  for (const child of [...children].reverse()) child.kill(signal);
  await until('shutdown', async () => children.every(child => child.exitCode !== null || child.signalCode !== null));
};

export const createUsdcFixture = async (
  options: Readonly<{
    reserves?: readonly [bigint, bigint];
    operators?: 'start' | 'defer';
  }> = {},
) => {
  const root = mkdtempSync(join(tmpdir(), 'xln-usdc-session-'));
  const identities = prepareIdentities(root);
  const children: ChildProcess[] = [];
  const nodes: ChildProcess[] = [];
  const operators: ChildProcess[] = [];
  const adapters: JAdapter[] = [];
  const hubPort = await freePort();
  const mmPort = await freePort();
  const gatewayPort = await freePort();
  const apiBase = `http://127.0.0.1:${gatewayPort}`;
  const relayUrl = apiBase.replace('http', 'ws') + '/relay';
  const upstreams = new Map<string, string>();
  let pendingRpc = 0;
  const gateway = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: gatewayPort,
    serverId: 'usdc-session-fixture',
    audience: relayUrl,
    httpHandler: async request => {
      const upstream = upstreams.get(new URL(request.url).pathname);
      if (!upstream || request.method !== 'POST') return new Response('Local USDC fixture');
      pendingRpc++;
      try {
        const response = await fetch(upstream, {
          method: 'POST',
          body: await request.text(),
          headers: { 'content-type': 'application/json' },
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      } finally {
        pendingRpc--;
      }
    },
  });
  const launch = (name: string, entry: string, args: string[], env: NodeJS.ProcessEnv, command = process.execPath) => {
    const fd = openSync(join(root, `${name}.log`), 'w', 0o600);
    const child = spawn(command, command === process.execPath ? [entry, ...args] : args, {
      env,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    children.push(child);
    if (command === 'anvil') nodes.push(child);
    return child;
  };
  const stores = {
    hub: join(root, 'hub', 'runtime'),
    mm: join(root, 'mm', 'runtime'),
    user: join(root, 'user', 'runtime'),
  };
  const catalogPath = join(root, 'jurisdictions.json');
  const roleEnv = (role: 'hub' | 'mm' | 'user'): NodeJS.ProcessEnv => ({
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
    XLN_RUNTIME_SEED: readVaultSeed(join(root, role)),
    XLN_RADAPTER_AUTH_SEED: readVaultSeed(join(root, role)),
    XLN_BRAINVAULT_OWNER_PATH: join(root, role, 'owner.json'),
    XLN_RADAPTER_AUDIENCE: 'poc-usdc',
    XLN_RDB_ROOT: stores[role],
    XLN_DB_PATH: join(stores[role], 'db'),
    XLN_JURISDICTIONS_PATH: catalogPath,
    XLN_ORCHESTRATOR_PID: String(process.pid),
    XLN_HUB_COUNT: '1',
    XLN_ACCOUNT_EXECUTION_WORKERS: '1',
    XLN_HLT_ENGINE: 'ts',
    XLN_STORAGE_SYNC_WRITES: '1',
    XLN_LOG_LEVEL: 'warn',
    XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL: join(stores[role], 'bootstrap.jsonl'),
  });
  let gatewayClosed = false;
  const closeGateway = () => {
    if (gatewayClosed) return;
    gatewayClosed = true;
    gateway.close();
  };
  const close = async () => {
    await stopFixtureChildren(children.filter(child => !nodes.includes(child)));
    for (const adapter of adapters) await adapter.close();
    closeGateway();
    await until('rpc-drain', async () => pendingRpc === 0);
    await stopFixtureChildren(nodes);
  };
  try {
    const chains: (Awaited<ReturnType<typeof deployFixtureChain>> & { rpc: string })[] = [];
    for (const index of [0, 1]) {
      const port = await freePort();
      const rpc = `http://127.0.0.1:${port}`;
      launch(
        `anvil-${index}`,
        '',
        [
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--chain-id',
          String(index === 0 ? 11155111 : 421614),
          '--block-gas-limit',
          '60000000',
          '--block-time',
          '1',
          '--mixed-mining',
          '--silent',
        ],
        process.env,
        'anvil',
      );
      const hub = identities.find(identity => identity.role === 'hub')!.chains[index]!;
      const chain = await deployFixtureChain(index, rpc, hub.entityId, adapters, options.reserves?.[index]);
      const path = index === 0 ? '/rpc' : '/rpc2';
      upstreams.set(path, rpc);
      chains.push({ ...chain, rpc: apiBase + path });
    }
    writeFileSync(
      catalogPath,
      safeStringify({
        version: '1',
        lastUpdated: new Date().toISOString(),
        jurisdictions: { rpc: chains[0], rpc2: chains[1] },
        defaults: { timeout: 30_000, retryAttempts: 3, gasLimit: 3_000_000 },
      }),
    );
    for (const role of ['hub', 'mm', 'user'] as const) mkdirSync(stores[role], { mode: 0o700 });
    const managed = (role: 'hub' | 'mm') =>
      identities
        .find(identity => identity.role === role)!
        .chains.map(chain => ({
          name: role === 'hub' ? 'H1' : 'MM',
          entityId: chain.entityId,
          signerId: chain.signerId,
          jurisdictionName: chain.name,
          chainId: chain.chainId,
          depositoryAddress: chains.find(selected => selected.chainId === chain.chainId)!.contracts.depository,
        }));
    const startOperators = async () => {
      if (operators.length) throw new Error('USDC_FIXTURE_OPERATORS_ALREADY_STARTED');
      for (const role of ['hub', 'mm'] as const) {
        const port = role === 'hub' ? hubPort : mmPort;
        operators.push(
          launch(
            role,
            role === 'hub' ? 'core/orchestrator/hub-node.ts' : 'core/orchestrator/mm-node.ts',
            [
              '--name',
              role === 'hub' ? 'H1' : 'MM',
              '--signer-label',
              '1',
              '--relay-url',
              relayUrl,
              '--api-host',
              '127.0.0.1',
              '--api-port',
              String(port),
              '--direct-ws-url',
              `ws://127.0.0.1:${port}/ws`,
              '--rpc-url',
              apiBase + '/rpc',
              '--rpc2-url',
              apiBase + '/rpc2',
              '--hub-identities-json',
              safeStringify(managed('hub')),
              ...(role === 'hub' ? ['--support-peer-identities-json', safeStringify(managed('mm'))] : []),
              '--db-path',
              join(stores[role], 'db'),
            ],
            roleEnv(role),
          ),
        );
      }
      await until('maker-ready', async () => {
        if (operators.some(child => child.exitCode !== null || child.signalCode !== null))
          throw new Error(`USDC_FIXTURE_CHILD_EXIT:${root}`);
        const current = await health();
        return current !== null && current['ready'] === true;
      });
    };
    const health = async (): Promise<Record<string, unknown> | null> => {
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${mmPort}/api/health`);
      } catch {
        return null;
      }
      return requireBoundaryRecord(await response.json(), 'USDC_FIXTURE_HEALTH_INVALID');
    };
    if (options.operators !== 'defer') await startOperators();
    return {
      root,
      identities,
      stores,
      apiBase,
      hubPort,
      mmPort,
      chains,
      children,
      operators,
      roleEnv,
      launch,
      close,
      health,
      closeGateway,
      rpcUpstreams: upstreams,
      startOperators,
    };
  } catch (error) {
    await close();
    throw error;
  }
};
