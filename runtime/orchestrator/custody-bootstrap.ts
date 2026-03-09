import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deserializeTaggedJson } from '../serialization-utils';

const DEFAULT_CHILD_READY_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 80;
const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const resolveCustodyJurisdictionsJsonPath = (): string => {
  const overridePath = process.env['XLN_JURISDICTIONS_PATH']?.trim() || '';
  return overridePath.length > 0
    ? resolve(overridePath)
    : join(process.cwd(), 'jurisdictions', 'jurisdictions.json');
};

export type DebugEntitySummary = {
  entityId?: string;
  isHub?: boolean;
  online?: boolean;
  name?: string;
  accounts?: unknown[];
  publicAccounts?: unknown[];
};

type DebugEntitiesResponse = {
  entities?: DebugEntitySummary[];
};

export type ManagedIdentity = {
  entityId: string;
  signerId: string;
  name: string;
};

type DaemonControlCliResult = {
  ok: boolean;
  command: string;
  result: ManagedIdentity;
};

export type ManagedChild = {
  name: string;
  proc: ChildProcessWithoutNullStreams;
  stdoutLines: string[];
  stderrLines: string[];
};

export type StartCustodySupportOptions = {
  apiBaseUrl: string;
  daemonPort: number;
  custodyPort: number;
  relayUrl: string;
  rpcUrl: string;
  walletUrl: string;
  dbRoot: string;
  seed: string;
  daemonRuntimeSeed?: string;
  signerLabel: string;
  profileName: string;
};

export type StartedCustodySupport = {
  daemonChild: ManagedChild;
  custodyChild: ManagedChild;
  identity: ManagedIdentity;
  hubIds: string[];
};

const tailLines = (lines: string[]): string => lines.slice(-LOG_TAIL_LINES).join('\n');

export const spawnBunChild = (
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ManagedChild => {
  const proc = spawn('bun', args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const pushLines = (buffer: Buffer, target: string[]) => {
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      target.push(trimmed);
      if (target.length > 500) target.shift();
    }
  };

  proc.stdout.on('data', chunk => pushLines(chunk, stdoutLines));
  proc.stderr.on('data', chunk => pushLines(chunk, stderrLines));

  return { name, proc, stdoutLines, stderrLines };
};

export const stopManagedChild = async (child: ManagedChild | null): Promise<void> => {
  if (!child || child.proc.exitCode !== null) return;
  child.proc.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (child.proc.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.proc.exitCode === null) {
    child.proc.kill('SIGKILL');
    await sleep(200);
  }
};

export const waitForHttpReady = async (
  url: string,
  child: ManagedChild | null = null,
  timeoutMs = DEFAULT_CHILD_READY_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not-started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `status=${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child && child.proc.exitCode !== null) {
      throw new Error(
        `${child.name} exited early with code=${String(child.proc.exitCode)}\n` +
        `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
      );
    }
    await sleep(250);
  }

  if (child) {
    throw new Error(
      `${child.name} did not become ready at ${url}: ${lastError}\n` +
      `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
    );
  }

  throw new Error(`URL did not become ready at ${url}: ${lastError}`);
};

export const runDaemonControl = async (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<DaemonControlCliResult> => {
  return await new Promise<DaemonControlCliResult>((resolve, reject) => {
    const proc = spawn('bun', ['runtime/scripts/daemon-control.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            `daemon-control failed code=${String(code)}\nstdout:\n${stdout.trim()}\n\nstderr:\n${stderr.trim()}`,
          ),
        );
        return;
      }
      const lines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        reject(new Error(`daemon-control returned no payload\nstderr:\n${stderr.trim()}`));
        return;
      }
      try {
        resolve(deserializeTaggedJson<DaemonControlCliResult>(lastLine));
      } catch (error) {
        reject(
          new Error(
            `Failed to parse daemon-control payload: ${error instanceof Error ? error.message : String(error)}\n` +
            `stdout:\n${stdout.trim()}\n\nstderr:\n${stderr.trim()}`,
          ),
        );
      }
    });
  });
};

export const fetchDebugEntities = async (apiBaseUrl: string): Promise<DebugEntitySummary[]> => {
  const response = await fetch(new URL('/api/debug/entities?limit=5000', apiBaseUrl));
  if (!response.ok) {
    throw new Error(`debug entities endpoint failed (${response.status})`);
  }
  const body = await response.json() as DebugEntitiesResponse;
  return Array.isArray(body.entities) ? body.entities : [];
};

export const discoverHubIds = async (
  apiBaseUrl: string,
  minCount = 3,
  timeoutMs = 30_000,
): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entities = await fetchDebugEntities(apiBaseUrl);
    const hubs = entities
      .filter((entry): entry is DebugEntitySummary & { entityId: string } => entry.isHub === true && typeof entry.entityId === 'string')
      .map(entry => entry.entityId.toLowerCase())
      .slice(0, minCount);
    if (hubs.length >= minCount) return hubs;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${minCount} hub ids from ${apiBaseUrl}`);
};

export const waitForDebugEntity = async (
  apiBaseUrl: string,
  entityId: string,
  predicate: (entry: DebugEntitySummary) => boolean,
  timeoutMs = 30_000,
): Promise<DebugEntitySummary> => {
  const normalized = entityId.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entities = await fetchDebugEntities(apiBaseUrl);
    const match = entities.find(entry => String(entry.entityId || '').toLowerCase() === normalized);
    if (match && predicate(match)) return match;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for debug entity ${entityId}`);
};

export const startCustodySupport = async (
  options: StartCustodySupportOptions,
): Promise<StartedCustodySupport> => {
  const shardJurisdictionsPath = join(options.dbRoot, 'jurisdictions.json');
  await mkdir(options.dbRoot, { recursive: true });
  await writeFile(shardJurisdictionsPath, await readFile(resolveCustodyJurisdictionsJsonPath(), 'utf8'), 'utf8');
  const daemonChild = spawnBunChild(
    'custody-daemon',
    ['runtime/server.ts', '--port', String(options.daemonPort), '--host', '127.0.0.1', '--server-id', `custody-daemon-${options.daemonPort}`],
    {
      USE_ANVIL: 'true',
      BOOTSTRAP_LOCAL_HUBS: '0',
      ANVIL_RPC: options.rpcUrl,
      PUBLIC_RPC: options.rpcUrl,
      RELAY_URL: options.relayUrl,
      XLN_RUNTIME_SEED: options.daemonRuntimeSeed || `${options.seed}:runtime`,
      XLN_DB_PATH: `${options.dbRoot}/daemon-db`,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
    },
  );
  await waitForHttpReady(`http://127.0.0.1:${options.daemonPort}/api/health`, daemonChild);

  const hubIds = await discoverHubIds(options.apiBaseUrl);
  const controlResult = await runDaemonControl(
    [
      'setup-custody',
      '--base-url', `http://127.0.0.1:${options.daemonPort}`,
      '--name', options.profileName,
      '--seed', options.seed,
      '--signer-label', options.signerLabel,
      '--hub-ids', hubIds.join(','),
      '--relay-url', options.relayUrl,
      '--gossip-poll-ms', '250',
    ],
    {
      USE_ANVIL: 'true',
    },
  );

  if (!controlResult.ok) {
    throw new Error('setup-custody returned ok=false');
  }

  const identity = controlResult.result;
  await waitForDebugEntity(
    options.apiBaseUrl,
    identity.entityId,
    entry => entry.online === true && Math.max(entry.accounts?.length ?? 0, entry.publicAccounts?.length ?? 0) > 0,
  );

  const custodyChild = spawnBunChild(
    'custody-service',
    ['custody/server.ts'],
    {
      CUSTODY_HOST: '127.0.0.1',
      CUSTODY_PORT: String(options.custodyPort),
      CUSTODY_DAEMON_WS: `ws://127.0.0.1:${options.daemonPort}/rpc`,
      CUSTODY_WALLET_URL: options.walletUrl,
      CUSTODY_ENTITY_ID: identity.entityId,
      CUSTODY_SIGNER_ID: identity.signerId,
      CUSTODY_DB_PATH: `${options.dbRoot}/custody.sqlite`,
    },
  );
  await waitForHttpReady(`http://127.0.0.1:${options.custodyPort}/api/me`, custodyChild);

  return {
    daemonChild,
    custodyChild,
    identity,
    hubIds,
  };
};
