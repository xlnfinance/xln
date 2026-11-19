#!/usr/bin/env bun
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { safeStringify } from '../../../../core/protocol/serialization';
import { prepareIdentities } from '../identities';
import { candidateSources } from '../budget';
import { assertUnfundedPreparation } from '../chain';
import { getAvailableJurisdictions } from '../../../../core/jurisdiction/adapter/kernel/config';

const directory = resolve('.logs/ts-usdc-cross-j-poc/public');
const sources = candidateSources();
process.env['XLN_JURISDICTIONS_PATH'] = join(directory, 'jurisdictions.json');
const jurisdictions = await getAvailableJurisdictions();
const identities = prepareIdentities(directory);
await assertUnfundedPreparation(
  identities.flatMap(identity => identity.chains),
  jurisdictions,
);
const managed = identities
  .filter(identity => identity.role !== 'user')
  .flatMap(identity =>
    identity.chains.map(chain => ({
      name: identity.role === 'hub' ? 'H1' : 'MM',
      entityId: chain.entityId,
      signerId: chain.signerId,
      jurisdictionName: chain.name,
      chainId: chain.chainId,
      depositoryAddress: (() => {
        const jurisdiction = jurisdictions.find(value => value.chainId === chain.chainId);
        if (!jurisdiction) throw new Error('USDC_PREFLIGHT_JURISDICTION_MISSING');
        return jurisdiction.depositoryAddress;
      })(),
    })),
  );
const children: ChildProcess[] = [];
const invocations: { name: string; databasePath: string | null }[] = [];
const launch = (name: string, entry: string, args: string[], env: NodeJS.ProcessEnv) => {
  const fd = openSync(join(directory, `${name}.log`), 'w', 0o600);
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', fd, fd] });
  children.push(child);
  invocations.push({ name, databasePath: env['XLN_DB_PATH'] ?? null });
  return child;
};
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/PRIVATE_KEY|MNEMONIC|SEED|RPC/.test(key)),
);
const baseEnv = {
  ...cleanEnv,
  XLN_HLT_ENGINE: 'ts',
  XLN_JURISDICTIONS_PATH: join(directory, 'jurisdictions.json'),
  XLN_ORCHESTRATOR_PID: String(process.pid),
  XLN_HUB_COUNT: '1',
  XLN_ACCOUNT_EXECUTION_WORKERS: '1',
  XLN_LOG_LEVEL: 'info',
  XLN_STORAGE_SYNC_WRITES: '1',
};

launch('gateway', 'jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts', [], {
  ...cleanEnv,
  XLN_ORCHESTRATOR_PID: String(process.pid),
  ETH_SEPOLIA_RPC: process.env['ETH_SEPOLIA_RPC'],
  ARB_SEPOLIA_RPC: process.env['ARB_SEPOLIA_RPC'],
  POC_RUNTIME_421614_RPC: process.env['POC_RUNTIME_421614_RPC'],
});
await Bun.sleep(500);
for (const role of ['hub', 'mm']) {
  const root = join(directory, role);
  const runtimeRoot = join(root, `attempt-${Date.now()}`);
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  launch(
    role,
    role === 'hub' ? 'core/orchestrator/hub-node.ts' : 'core/orchestrator/mm-node.ts',
    [
      '--name',
      role === 'hub' ? 'H1' : 'MM',
      '--signer-label',
      '1',
      '--relay-url',
      'ws://localhost:8080/relay',
      '--api-host',
      '127.0.0.1',
      '--api-port',
      role === 'hub' ? '18081' : '18082',
      '--direct-ws-url',
      `ws://127.0.0.1:${role === 'hub' ? '18081' : '18082'}/ws`,
      '--rpc-url',
      'http://localhost:8080/rpc',
      '--rpc2-url',
      'http://localhost:8080/rpc2',
      '--hub-identities-json',
      safeStringify(managed.filter(value => value.name === 'H1')),
      ...(role === 'hub'
        ? ['--support-peer-identities-json', safeStringify(managed.filter(value => value.name === 'MM'))]
        : []),
      '--db-path',
      join(runtimeRoot, 'db'),
    ],
    {
      ...baseEnv,
      XLN_RUNTIME_SEED: readFileSync(join(root, 'vault.seed'), 'utf8'),
      XLN_RADAPTER_AUTH_SEED: readFileSync(join(root, 'vault.seed'), 'utf8'),
      XLN_RADAPTER_AUDIENCE: 'poc-usdc',
      XLN_BRAINVAULT_OWNER_PATH: join(root, 'owner.json'),
      XLN_RDB_ROOT: runtimeRoot,
      XLN_DB_PATH: join(runtimeRoot, 'db'),
    },
  );
}

const stop = async () => {
  for (const child of [...children].reverse()) {
    child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(50);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
};
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
try {
  await Bun.sleep(15_000);
  const userRoot = join(directory, 'user', `attempt-${Date.now()}`);
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  const client = launch('user', 'jurisdictions/scripts/usdc-cross-j-preflight/operators/transport.ts', [], {
    ...baseEnv,
    XLN_RDB_ROOT: userRoot,
    XLN_DB_PATH: join(userRoot, 'db'),
  });
  const clientDeadline = Date.now() + 65_000;
  while (client.exitCode === null && client.signalCode === null && Date.now() < clientDeadline) await Bun.sleep(100);
  const health = await Promise.all(
    [18081, 18082].map(async port => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        return { port, httpStatus: response.status, body: await response.text() };
      } catch {
        return { port, status: 'unreachable' };
      }
    }),
  );
  await stop();
  const stopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (!stopped) throw new Error('USDC_PREFLIGHT_OPERATOR_STOP_INCOMPLETE');
  if (safeStringify(sources) !== safeStringify(candidateSources())) throw new Error('USDC_PREFLIGHT_CANDIDATE_CHANGED');
  writeFileSync(
    join(directory, 'operators.json'),
    safeStringify(
      {
        observedAt: new Date().toISOString(),
        status: 'probe-complete',
        sources,
        invocations,
        allProcessesStoppedAfterObservation: stopped,
        health,
        children: children.map(child => ({ pid: child.pid, exitCode: child.exitCode })),
      },
      2,
    ),
  );
  console.log(safeStringify(health, 2));
} finally {
  await stop();
}
