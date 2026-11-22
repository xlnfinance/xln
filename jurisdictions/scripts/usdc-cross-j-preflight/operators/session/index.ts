#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../../../core/protocol/serialization';
import { requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { decodeJurisdictionsData } from '../../../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { readExistingIdentities, readVaultSeed } from '../../identities';
import { readSessionConfig, sessionRoles, sessionWatcherEnv, type Role } from './config';
import { acquireSessionStores, assertCommittedSessionStores } from './stores';
import {
  assertSessionChildrenLive,
  launchSessionChild,
  readSessionStatus,
  stopSessionChildren,
  waitSessionChild,
  waitSessionReady,
  type ManagedChild,
} from './processes';

const config = readSessionConfig(process.argv.slice(2));
const selectedRoles = sessionRoles(config);
const release = acquireSessionStores(config);
const children: ManagedChild[] = [];
const shutdown = new AbortController();
const stop = (): void => shutdown.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await assertCommittedSessionStores(config);
  const originalCatalogPath = join(config.directory, 'jurisdictions.json');
  const catalog = decodeJurisdictionsData(JSON.parse(readFileSync(originalCatalogPath, 'utf8')));
  const runs = join(config.directory, 'sessions');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const runDirectory = mkdtempSync(join(runs, 'restore-'));
  const catalogPath = join(runDirectory, 'jurisdictions.json');
  writeFileSync(catalogPath, safeStringify(catalog, 2), { flag: 'wx', mode: 0o600 });
  console.log(`USDC_SESSION_DIRECTORY:${runDirectory}`);
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
    XLN_HLT_ENGINE: 'ts',
    XLN_JURISDICTIONS_PATH: catalogPath,
    XLN_ORCHESTRATOR_PID: String(process.pid),
    XLN_HUB_COUNT: '1',
    XLN_ACCOUNT_EXECUTION_WORKERS: '1',
    XLN_LOG_LEVEL: 'info',
    XLN_STORAGE_SYNC_WRITES: '1',
    ...(config.authorityFile ? { XLN_EVM_FEE_CEILING_WEI: '0' } : {}),
    ...sessionWatcherEnv(),
    POC_API_BASE: config.apiBase,
  };
  if (!config.externalGateway) {
    launchSessionChild(
      children,
      runDirectory,
      'gateway',
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts',
      [
        '--api-base',
        config.apiBase,
        ...(config.authorityFile ? ['--authority-file', config.authorityFile] : []),
        ...(config.runId ? ['--run-id', config.runId] : []),
      ],
      {
        ...baseEnv,
        XLN_JURISDICTIONS_PATH: originalCatalogPath,
        ETH_SEPOLIA_RPC: process.env['ETH_SEPOLIA_RPC'],
        ARB_SEPOLIA_RPC: process.env['ARB_SEPOLIA_RPC'],
        POC_RUNTIME_11155111_RPC: process.env['POC_RUNTIME_11155111_RPC'],
        POC_RUNTIME_421614_RPC: process.env['POC_RUNTIME_421614_RPC'],
        POC_ARBITRUM_SECONDARY_HEADER_RPC: process.env['POC_ARBITRUM_SECONDARY_HEADER_RPC'],
        POC_HYPERSYNC_ARBITRUM_HEADERS: process.env['POC_HYPERSYNC_ARBITRUM_HEADERS'],
        POC_HYPERSYNC_TOKEN: process.env['POC_HYPERSYNC_TOKEN'],
        POC_HYPERRPC_ETHEREUM_RECEIPT_BATCH_CALLS: process.env['POC_HYPERRPC_ETHEREUM_RECEIPT_BATCH_CALLS'],
        POC_HYPERRPC_11155111_RPC: process.env['POC_HYPERRPC_11155111_RPC'],
        POC_HEADER_BATCH_TIMING: process.env['POC_HEADER_BATCH_TIMING'],
        POC_RPC_READ_PACING: process.env['POC_RPC_READ_PACING'],
        POC_RPC_HEADER_INTERVAL_MS: process.env['POC_RPC_HEADER_INTERVAL_MS'],
        POC_RPC_RECEIPT_INTERVAL_MS: process.env['POC_RPC_RECEIPT_INTERVAL_MS'],
      },
    );
  }
  await waitSessionReady(children, 'gateway', async () => {
    for (const [path, chainId] of [
      ['/rpc', 11155111],
      ['/rpc2', 421614],
    ] as const) {
      let response: Response;
      try {
        response = await fetch(config.apiBase + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(1_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        });
      } catch {
        return false;
      }
      const reply = requireBoundaryRecord(await response.json(), 'USDC_SESSION_GATEWAY_REPLY_INVALID');
      if (
        typeof reply['result'] !== 'string' ||
        !/^0x[0-9a-f]+$/i.test(reply['result']) ||
        BigInt(reply['result']) !== BigInt(chainId)
      )
        throw new Error(`USDC_SESSION_GATEWAY_CHAIN_MISMATCH:${path}`);
    }
    return true;
  }, config.startupTimeoutMs, shutdown.signal);
  shutdown.signal.throwIfAborted();
  console.log(`USDC_SESSION_GATEWAY_READY:${runDirectory}`);
  const identities = readExistingIdentities(config.directory);
  const roleEnv = (role: Role): NodeJS.ProcessEnv => ({
    ...baseEnv,
    ...(role === 'mm' ? { XLN_MARKET_MAKER_HUB_READY_TIMEOUT_MS: String(config.startupTimeoutMs) } : {}),
    XLN_RUNTIME_SEED: readVaultSeed(join(config.directory, role)),
    XLN_RADAPTER_AUTH_SEED: readVaultSeed(join(config.directory, role)),
    XLN_RADAPTER_AUDIENCE: 'poc-usdc',
    XLN_BRAINVAULT_OWNER_PATH: join(config.directory, role, 'owner.json'),
    XLN_RDB_ROOT: config.stores[role],
    XLN_DB_PATH: join(config.stores[role], 'db'),
  });
  for (const role of selectedRoles) {
    const inspection = launchSessionChild(
      children,
      runDirectory,
      `inspect-${role}`,
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/inspect.ts',
      [config.directory, role, join(runDirectory, `${role}-restored.json`)],
      roleEnv(role),
    );
    await waitSessionChild(inspection, shutdown.signal);
    children.splice(children.indexOf(inspection), 1);
    shutdown.signal.throwIfAborted();
  }
  const hubs = identities
    .find(identity => identity.role === 'hub')!
    .chains.map(chain => ({
      name: 'H1',
      entityId: chain.entityId,
      signerId: chain.signerId,
      jurisdictionName: chain.name,
      chainId: chain.chainId,
      depositoryAddress: Object.values(catalog.jurisdictions).find(j => j.chainId === chain.chainId)!.contracts
        .depository,
    }));
  const makers = identities
    .find(identity => identity.role === 'mm')!
    .chains.map(chain => ({
      name: 'MM',
      entityId: chain.entityId,
      signerId: chain.signerId,
      jurisdictionName: chain.name,
      chainId: chain.chainId,
      depositoryAddress: Object.values(catalog.jurisdictions).find(j => j.chainId === chain.chainId)!.contracts
        .depository,
    }));
  const readiness: Promise<void>[] = [];
  for (const role of selectedRoles) {
    if (role === 'user') continue;
    const port = role === 'hub' ? config.hubPort : config.mmPort;
    launchSessionChild(
      children,
      runDirectory,
      role,
      role === 'hub' ? 'core/orchestrator/hub-node.ts' : 'core/orchestrator/mm-node.ts',
      [
        '--require-restore',
        '--name',
        role === 'hub' ? 'H1' : 'MM',
        '--signer-label',
        '1',
        '--relay-url',
        config.apiBase.replace('http', 'ws') + '/relay',
        '--api-host',
        '127.0.0.1',
        '--api-port',
        String(port),
        '--direct-ws-url',
        `ws://127.0.0.1:${port}/ws`,
        '--rpc-url',
        `${config.apiBase}/rpc`,
        '--rpc2-url',
        `${config.apiBase}/rpc2`,
        '--hub-identities-json',
        safeStringify(hubs),
        ...(role === 'hub' ? ['--support-peer-identities-json', safeStringify(makers)] : []),
        '--db-path',
        join(config.stores[role], 'db'),
      ],
      roleEnv(role),
    );
    if (role === 'hub' && selectedRoles.includes('mm')) {
      await waitSessionReady(children, 'hub-api', async () =>
        (await readSessionStatus(port, '/api/info'))?.['runtimeId'] === hubs[0]!.signerId,
        config.startupTimeoutMs,
        shutdown.signal,
      );
    }
    // Each Runtime drains its own WAL and J history. MM uses the Hub's
    // authenticated delivery readiness before beginning its quote watchdog.
    readiness.push(waitSessionReady(
      children,
      role,
      async () => {
        if (role === 'hub' && (await readSessionStatus(port, '/api/info'))?.['deliveryReady'] !== true) return false;
        const health = await readSessionStatus(port, '/api/health');
        if (!health) return false;
        if (role === 'mm') return health['ready'] === true;
        const reserves = requireBoundaryRecord(health['bootstrapReserves'], 'USDC_SESSION_HUB_RESERVES_INVALID');
        const adapter = requireBoundaryRecord(health['jadapter'], 'USDC_SESSION_HUB_ADAPTER_INVALID');
        return health['ok'] === true && reserves['ok'] === true && adapter['ready'] === true;
      },
      config.startupTimeoutMs,
      shutdown.signal,
    ));
  }
  if (selectedRoles.includes('user')) {
    const userReady = join(runDirectory, 'user-ready.json');
    launchSessionChild(
      children,
      runDirectory,
      'user',
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/user.ts',
      [config.directory, config.apiBase, userReady],
      roleEnv('user'),
    );
    readiness.push(waitSessionReady(children, 'user', async () => existsSync(userReady), config.startupTimeoutMs, shutdown.signal));
  }
  await Promise.all(readiness);
  shutdown.signal.throwIfAborted();
  writeFileSync(
    join(runDirectory, 'session.json'),
    safeStringify(
      {
        status: 'ready',
        mode: 'restore',
        configuration: catalogPath,
        stores: config.stores,
        children: children.map(({ name, child }) => ({ name, pid: child.pid })),
        identities,
        financialCommandsSubmitted: 0,
        gateway: config.externalGateway ? 'external' : config.authorityFile ? 'authorized-execution' : 'read-only',
        operatorsOnly: config.operatorsOnly,
        hubOnly: config.hubOnly === true,
      },
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(`USDC_SESSION_READY:${runDirectory}`);
  while (!shutdown.signal.aborted) {
    assertSessionChildrenLive(children);
    await Bun.sleep(100);
  }
} catch (error) {
  if (error !== shutdown.signal.reason) throw error;
} finally {
  try {
    await stopSessionChildren(children);
  } finally {
    release();
  }
}
