import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { deriveRuntimeAdapterCapabilityToken } from '../../api/runtime-adapter/security/auth';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import { deserializeTaggedJson } from '../../protocol/serialization';
import { fetchLoopback } from '../server/loopback-fetch';
import {
  buildManagedRuntimeChildSecretEnv,
  childSecretFdEnv,
  type ChildSecrets,
  writeInheritedChildSecrets,
} from '../../infra/process/child-secrets';

const DEFAULT_CHILD_READY_TIMEOUT_MS = 120_000;
const LOG_TAIL_LINES = 80;
const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const assertChildStillRunning = (child: ManagedChild | null): void => {
  if (!child || child.proc.exitCode === null) return;
  throw new Error(
    `${child.name} exited early with code=${String(child.proc.exitCode)}\n` +
    `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
  );
};

const resolveCustodyJurisdictionsJsonPath = (): string => {
  const overridePath = process.env['XLN_JURISDICTIONS_PATH']?.trim() || '';
  return overridePath.length > 0
    ? resolve(overridePath)
    : join(process.cwd(), 'jurisdictions', 'jurisdictions.json');
};

const resolveCustodyServiceHttps = (): boolean => {
  const raw = String(process.env['CUSTODY_HTTPS'] || '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  return false;
};

const waitForCustodyServiceReady = async (
  port: number,
  child: ManagedChild,
  useHttps: boolean,
  timeoutMs = DEFAULT_CHILD_READY_TIMEOUT_MS,
): Promise<string> => {
  const urls = useHttps
    ? [`https://127.0.0.1:${port}/api/me`, `http://127.0.0.1:${port}/api/me`]
    : [`http://127.0.0.1:${port}/api/me`, `https://127.0.0.1:${port}/api/me`];
  const perAttemptTimeoutMs = 4_000;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not-started';

  while (Date.now() < deadline) {
    for (const url of urls) {
      try {
        await waitForHttpReady(url, child, perAttemptTimeoutMs);
        return url;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (child.proc.exitCode !== null) {
      break;
    }
  }

  throw new Error(`custody-service did not become ready on http/https for port ${port}: ${lastError}`);
};

export type DebugEntitySummary = {
  entityId?: string;
  isHub?: boolean;
  online?: boolean;
  name?: string;
  metadata?: {
    jurisdiction?: {
      name?: string;
      chainId?: number;
      depositoryAddress?: string;
      entityProviderAddress?: string;
    };
  };
  accounts?: unknown[];
  publicAccounts?: unknown[];
};

export type CustodyJurisdictionTarget = {
  key: string;
  name: string;
  chainId?: number;
  depositoryAddress?: string;
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

const requireExactHex = (value: unknown, bytes: number, code: string): string => {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(code);
  }
  return value;
};

export const decodeDaemonControlCliResult = (value: unknown): DaemonControlCliResult => {
  const response = requireBoundaryRecord(value, 'DAEMON_CONTROL_RESULT_INVALID');
  requireExactBoundaryKeys(response, ['ok', 'command', 'result'], [], 'DAEMON_CONTROL_RESULT_FIELDS_INVALID');
  const result = requireBoundaryRecord(response['result'], 'DAEMON_CONTROL_RESULT_IDENTITY_INVALID');
  requireExactBoundaryKeys(result, ['entityId', 'signerId', 'name'], [], 'DAEMON_CONTROL_RESULT_IDENTITY_FIELDS_INVALID');
  if (typeof response['ok'] !== 'boolean' || typeof response['command'] !== 'string' ||
      typeof result['name'] !== 'string' || !result['name']) {
    throw new Error('DAEMON_CONTROL_RESULT_INVALID');
  }
  const entityId = requireExactHex(result['entityId'], 32, 'DAEMON_CONTROL_RESULT_ENTITY_ID_INVALID');
  const signerId = requireExactHex(result['signerId'], 20, 'DAEMON_CONTROL_RESULT_SIGNER_ID_INVALID');
  return {
    ok: response['ok'],
    command: response['command'],
    result: { entityId, signerId, name: result['name'] },
  };
};

export type ManagedChild = {
  name: string;
  proc: ChildProcess & { stdout: Readable; stderr: Readable };
  stdoutLines: string[];
  stderrLines: string[];
  startupSecretsWritten: Promise<void>;
};

function assertCapturedChildPipes(
  proc: ChildProcess,
): asserts proc is ChildProcess & { stdout: Readable; stderr: Readable } {
  if (proc.stdout && proc.stderr) return;
  proc.kill('SIGTERM');
  throw new Error('MANAGED_CHILD_LOG_PIPE_MISSING');
}

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
  jurisdictionId: string;
};

export type StartedCustodySupport = {
  daemonChild: ManagedChild;
  custodyChild: ManagedChild;
  identity: ManagedIdentity;
  hubIds: string[];
  custodyBaseUrl: string;
  daemonAuthSeed: string;
  daemonAuthAudience: string;
  daemonAuthKey: string;
};

const DEFAULT_CUSTODY_TOKEN_IDS = [1, 2, 3] as const;

const tailLines = (lines: string[]): string => lines.slice(-LOG_TAIL_LINES).join('\n');

const hasManagedChildExited = (child: ManagedChild): boolean =>
  child.proc.exitCode !== null || child.proc.signalCode !== null;

const waitForManagedChildExit = async (child: ManagedChild, timeoutMs: number): Promise<boolean> => {
  if (hasManagedChildExited(child)) return true;
  return await new Promise<boolean>(resolveExit => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.proc.off('exit', onExit);
      child.proc.off('close', onClose);
      child.proc.off('error', onError);
      resolveExit(exited || hasManagedChildExited(child));
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    // A ChildProcess `error` means an operation on the handle failed; it does
    // not prove that the OS process exited. Only exit/close or the recorded
    // exit state may release the runtime lease.
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.proc.once('exit', onExit);
    child.proc.once('close', onClose);
    child.proc.once('error', onError);
    if (hasManagedChildExited(child)) finish(true);
  });
};

export const spawnBunChild = (
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  startupSecrets?: ChildSecrets,
): ManagedChild => {
  const mirrorStdout = process.env['XLN_CHILD_MIRROR_STDOUT'] === '1';
  const hasStartupSecrets = startupSecrets !== undefined;
  const proc = spawn('bun', args, {
    cwd: process.cwd(),
    env: {
      ...buildManagedRuntimeChildSecretEnv(process.env, false),
      ...env,
      ...(hasStartupSecrets ? childSecretFdEnv() : {}),
      // Bun watch replaces the orchestrator without reaping grandchildren.
      // The child must therefore fail closed when this exact parent exits.
      XLN_MANAGED_PARENT_PID: String(process.pid),
    },
    stdio: hasStartupSecrets
      ? ['pipe', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe'],
  });
  assertCapturedChildPipes(proc);

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const pushLines = (buffer: Buffer, target: string[]) => {
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      target.push(trimmed);
      if (target.length > 500) target.shift();
      if (mirrorStdout) console.log(`[${name}] ${trimmed}`);
    }
  };

  proc.stdout.on('data', chunk => pushLines(chunk, stdoutLines));
  proc.stderr.on('data', chunk => pushLines(chunk, stderrLines));

  const startupSecretsWritten = startupSecrets
    ? writeInheritedChildSecrets(proc, startupSecrets)
    : Promise.resolve();
  return { name, proc, stdoutLines, stderrLines, startupSecretsWritten };
};

export const stopManagedChild = async (
  child: ManagedChild | null,
  opts: { terminateTimeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<void> => {
  if (!child || hasManagedChildExited(child)) return;
  const terminateTimeoutMs = opts.terminateTimeoutMs ?? 5_000;
  const killTimeoutMs = opts.killTimeoutMs ?? 5_000;
  let terminateError: unknown = null;

  try {
    if (!child.proc.kill('SIGTERM')) {
      terminateError = new Error('SIGTERM was not delivered');
    }
  } catch (error) {
    terminateError = error;
  }
  if (terminateError === null && await waitForManagedChildExit(child, terminateTimeoutMs)) return;
  if (terminateError !== null && hasManagedChildExited(child)) return;

  let killError: unknown = null;

  try {
    if (!child.proc.kill('SIGKILL')) {
      killError = new Error('SIGKILL was not delivered');
    }
  } catch (error) {
    killError = error;
  }
  if (await waitForManagedChildExit(child, killTimeoutMs)) return;

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  throw new Error(
    `MANAGED_CHILD_STOP_TIMEOUT name=${child.name} pid=${child.proc.pid ?? 'unknown'}\n` +
    `SIGTERM=${terminateError === null ? 'delivered' : describeError(terminateError)}\n` +
    `SIGKILL=${killError === null ? 'delivered' : describeError(killError)}\n` +
    `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
  );
};

export const waitForHttpReady = async (
  url: string,
  child: ManagedChild | null = null,
  timeoutMs = DEFAULT_CHILD_READY_TIMEOUT_MS,
  isReady?: (response: Response, bodyText: string) => boolean | Promise<boolean>,
): Promise<void> => {
  if (child) await child.startupSecretsWritten;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not-started';
  while (Date.now() < deadline) {
    assertChildStillRunning(child);
    try {
      const response = await fetchLoopback(url);
      const bodyText = await response.text();
      if (response.status < 500) {
        const ready = isReady ? await isReady(response, bodyText) : true;
        if (ready) {
          assertChildStillRunning(child);
          return;
        }
        lastError = `predicate=false status=${response.status}`;
      } else {
        lastError = `status=${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    assertChildStillRunning(child);
    await sleep(1000);
  }

  if (child) {
    throw new Error(
      `${child.name} did not become ready at ${url}: ${lastError}\n` +
      `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
    );
  }

  throw new Error(`URL did not become ready at ${url}: ${lastError}`);
};

export const isPublicDaemonHealthReady = (payload: unknown): boolean => {
  // Bootstrap consumes only the unauthenticated health contract. Private adapter
  // details are intentionally redacted there, while `ready` is published only
  // after jurisdiction adapters and P2P have completed startup.
  try {
    const body = requireBoundaryRecord(payload, 'PUBLIC_DAEMON_HEALTH_INVALID');
    requireExactBoundaryKeys(body, [
      'timestamp', 'uptime', 'failures', 'system', 'source', 'bootstrap',
      'boot', 'relay', 'hubMesh',
      'marketMaker', 'custody', 'bootstrapReserves', 'disk', 'storage', 'hubs',
    ], ['coreOk', 'systemOk', 'degraded'], 'PUBLIC_DAEMON_HEALTH_FIELDS_INVALID');
    const system = requireBoundaryRecord(body['system'], 'PUBLIC_DAEMON_HEALTH_SYSTEM_INVALID');
    requireExactBoundaryKeys(system, ['runtime', 'p2p', 'relay'], [], 'PUBLIC_DAEMON_HEALTH_SYSTEM_FIELDS_INVALID');
    const boot = requireBoundaryRecord(body['boot'], 'PUBLIC_DAEMON_HEALTH_BOOT_INVALID');
    requireExactBoundaryKeys(boot, ['phase', 'startedAt', 'completedAt', 'error'], [], 'PUBLIC_DAEMON_HEALTH_BOOT_FIELDS_INVALID');
    return system['runtime'] === true && boot['phase'] === 'ready';
  } catch {
    return false;
  }
};

const isDaemonHealthReady = (_response: Response, bodyText: string): boolean => {
  try {
    return isPublicDaemonHealthReady(JSON.parse(bodyText));
  } catch {
    return false;
  }
};

const runDaemonControl = async (
  args: string[],
  env: NodeJS.ProcessEnv,
  secrets: ChildSecrets,
): Promise<DaemonControlCliResult> => {
  const proc = spawn('bun', ['runtime/scripts/operations/production/daemon-control.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...buildManagedRuntimeChildSecretEnv(process.env, false),
      ...env,
      ...childSecretFdEnv(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!proc.stdout || !proc.stderr) {
    proc.kill('SIGTERM');
    throw new Error('DAEMON_CONTROL_STDIO_MISSING');
  }
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;
  const result = new Promise<DaemonControlCliResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    stdoutStream.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    stderrStream.on('data', chunk => {
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
        resolve(decodeDaemonControlCliResult(deserializeTaggedJson(lastLine)));
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
  await writeInheritedChildSecrets(proc, secrets);
  return await result;
};

const fetchDebugEntities = async (apiBaseUrl: string): Promise<DebugEntitySummary[]> => {
  const response = await fetch(new URL('/api/debug/entities?limit=5000', apiBaseUrl));
  if (!response.ok) {
    throw new Error(`debug entities endpoint failed (${response.status})`);
  }
  const body = requireBoundaryRecord(deserializeTaggedJson(await response.text()), 'DEBUG_ENTITIES_RESPONSE_INVALID');
  requireExactBoundaryKeys(body, ['entities'], [], 'DEBUG_ENTITIES_RESPONSE_FIELDS_INVALID');
  if (!Array.isArray(body['entities'])) throw new Error('DEBUG_ENTITIES_RESPONSE_ENTITIES_INVALID');
  return body['entities'].map((entry, index) => {
    const entity = requireBoundaryRecord(entry, `DEBUG_ENTITY_INVALID:index=${index}`);
    requireExactBoundaryKeys(
      entity,
      ['entityId', 'name', 'isHub', 'online', 'lastUpdated', 'accounts', 'publicAccounts', 'metadata'],
      ['runtimeId', 'apiPort', 'exitCode', 'dbPath'],
      `DEBUG_ENTITY_FIELDS_INVALID:index=${index}`,
    );
    if (typeof entity['entityId'] !== 'string' || typeof entity['name'] !== 'string' ||
        typeof entity['isHub'] !== 'boolean' || typeof entity['online'] !== 'boolean' ||
        !Array.isArray(entity['accounts']) || !Array.isArray(entity['publicAccounts'])) {
      throw new Error(`DEBUG_ENTITY_INVALID:index=${index}`);
    }
    const metadata = requireBoundaryRecord(entity['metadata'], `DEBUG_ENTITY_METADATA_INVALID:index=${index}`);
    const jurisdictionRaw = metadata['jurisdiction'];
    let jurisdiction: NonNullable<DebugEntitySummary['metadata']>['jurisdiction'];
    if (jurisdictionRaw !== undefined) {
      const raw = requireBoundaryRecord(jurisdictionRaw, `DEBUG_ENTITY_JURISDICTION_INVALID:index=${index}`);
      requireExactBoundaryKeys(raw, ['name'], ['chainId', 'depositoryAddress', 'entityProviderAddress'], `DEBUG_ENTITY_JURISDICTION_FIELDS_INVALID:index=${index}`);
      if (typeof raw['name'] !== 'string' ||
          (raw['chainId'] !== undefined && (!Number.isSafeInteger(raw['chainId']) || Number(raw['chainId']) <= 0)) ||
          (raw['depositoryAddress'] !== undefined && typeof raw['depositoryAddress'] !== 'string') ||
          (raw['entityProviderAddress'] !== undefined && typeof raw['entityProviderAddress'] !== 'string')) {
        throw new Error(`DEBUG_ENTITY_JURISDICTION_INVALID:index=${index}`);
      }
      jurisdiction = {
        name: raw['name'],
        ...(raw['chainId'] === undefined ? {} : { chainId: Number(raw['chainId']) }),
        ...(raw['depositoryAddress'] === undefined ? {} : { depositoryAddress: raw['depositoryAddress'] }),
        ...(raw['entityProviderAddress'] === undefined ? {} : { entityProviderAddress: raw['entityProviderAddress'] }),
      };
    }
    return {
      entityId: entity['entityId'], name: entity['name'], isHub: entity['isHub'], online: entity['online'],
      accounts: entity['accounts'], publicAccounts: entity['publicAccounts'],
      ...(jurisdiction === undefined ? {} : { metadata: { jurisdiction } }),
    };
  });
};

const toLowerId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : '';
};

const readCustodyJurisdictionTarget = async (
  jurisdictionsPath: string,
  key: string,
): Promise<CustodyJurisdictionTarget> => {
  const normalizedKey = key.trim();
  if (!normalizedKey) throw new Error('CUSTODY_JURISDICTION_ID_MISSING');
  const raw = await readFile(jurisdictionsPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('CUSTODY_JURISDICTIONS_FILE_INVALID:json', { cause: error });
  }
  const payload = requireBoundaryRecord(parsed, 'CUSTODY_JURISDICTIONS_FILE_INVALID');
  const jurisdictions = requireBoundaryRecord(payload['jurisdictions'], 'CUSTODY_JURISDICTIONS_ENTRIES_INVALID');
  const rawEntry = jurisdictions[normalizedKey];
  const entry = rawEntry === undefined
    ? undefined
    : requireBoundaryRecord(rawEntry, `CUSTODY_JURISDICTION_INVALID:${normalizedKey}`);
  if (!entry) throw new Error(`CUSTODY_JURISDICTION_NOT_FOUND:${normalizedKey}`);
  const contracts = requireBoundaryRecord(entry['contracts'], `CUSTODY_JURISDICTION_CONTRACTS_INVALID:${normalizedKey}`);
  const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
  const chainId = entry['chainId'];
  const depositoryAddress = toLowerId(contracts['depository']);
  if (!name || typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0 || !depositoryAddress) {
    throw new Error(`CUSTODY_JURISDICTION_INCOMPLETE:${normalizedKey}`);
  }
  return {
    key: normalizedKey,
    name,
    chainId,
    depositoryAddress,
  };
};

const isSameDebugJurisdiction = (
  entry: DebugEntitySummary,
  target: CustodyJurisdictionTarget,
): boolean => {
  const jurisdiction = entry.metadata?.jurisdiction;
  if (!jurisdiction) return false;
  const entryDepository = toLowerId(jurisdiction.depositoryAddress);
  const targetDepository = toLowerId(target.depositoryAddress);
  const entryChainId = Number(jurisdiction.chainId);
  if (entryDepository && targetDepository && Number.isFinite(entryChainId) && Number.isFinite(target.chainId)) {
    return entryDepository === targetDepository && entryChainId === target.chainId;
  }
  return String(jurisdiction.name || '').trim().toLowerCase() === target.name.trim().toLowerCase();
};

const hasPositiveCapacity = (value: unknown): boolean => {
  return typeof value === 'bigint' && value > 0n;
};

const hasAccountCapacityForToken = (
  entry: DebugEntitySummary,
  counterpartyId: string,
  tokenId: number,
): boolean => {
  if (!Array.isArray(entry.accounts)) return false;
  const counterpartyNorm = counterpartyId.toLowerCase();
  const tokenKey = String(tokenId);
  for (const rawAccount of entry.accounts) {
    if (!rawAccount || typeof rawAccount !== 'object' || Array.isArray(rawAccount)) continue;
    const account = rawAccount as Record<string, unknown>;
    if (toLowerId(account['counterpartyId']) !== counterpartyNorm) continue;
    const capacities = account['tokenCapacities'];
    if (!capacities || typeof capacities !== 'object' || Array.isArray(capacities)) continue;
    const capacity = (capacities as Record<string, unknown>)[tokenKey];
    if (!capacity || typeof capacity !== 'object') continue;
    const capacityRecord = capacity as Record<string, unknown>;
    if (hasPositiveCapacity(capacityRecord['inCapacity']) || hasPositiveCapacity(capacityRecord['outCapacity'])) {
      return true;
    }
  }
  return false;
};

const isEntityRouteableAcrossHubs = (
  entry: DebugEntitySummary,
  hubEntityIds: string[],
  tokenIds: readonly number[],
): boolean => {
  for (const hubEntityId of hubEntityIds) {
    const hubNorm = hubEntityId.toLowerCase();
    let tokenReady = false;
    for (const tokenId of tokenIds) {
      if (hasAccountCapacityForToken(entry, hubNorm, tokenId)) {
        tokenReady = true;
        break;
      }
    }
    if (!tokenReady) return false;
  }
  return true;
};

const isCounterpartyRouteableFromHubs = (
  entities: DebugEntitySummary[],
  counterpartyId: string,
  hubEntityIds: string[],
  tokenIds: readonly number[],
): boolean => {
  const counterpartyNorm = counterpartyId.toLowerCase();
  for (const hubEntityId of hubEntityIds) {
    const hubEntry = entities.find(entry => toLowerId(entry.entityId) === hubEntityId);
    if (!hubEntry) return false;
    let tokenReady = false;
    for (const tokenId of tokenIds) {
      if (hasAccountCapacityForToken(hubEntry, counterpartyNorm, tokenId)) {
        tokenReady = true;
        break;
      }
    }
    if (!tokenReady) return false;
  }
  return true;
};

export const waitForCustodyRouteableState = async (
  apiBaseUrl: string,
  entityId: string,
  hubEntityIds: string[],
  tokenIds: readonly number[] = DEFAULT_CUSTODY_TOKEN_IDS,
  timeoutMs = 60_000,
): Promise<DebugEntitySummary> => {
  const normalizedEntityId = entityId.toLowerCase();
  const normalizedHubIds = hubEntityIds.map(id => id.toLowerCase()).filter(Boolean);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const entities = await fetchDebugEntities(apiBaseUrl);
    const custodyEntry = entities.find(entry => toLowerId(entry.entityId) === normalizedEntityId);
    if (
      custodyEntry &&
      (
        isEntityRouteableAcrossHubs(custodyEntry, normalizedHubIds, tokenIds) ||
        isCounterpartyRouteableFromHubs(entities, normalizedEntityId, normalizedHubIds, tokenIds)
      )
    ) {
      return custodyEntry;
    }

    await sleep(500);
  }

  throw new Error(
    `CUSTODY_ROUTEABLE_STATE_NOT_READY: entity=${entityId} hubs=${normalizedHubIds.join(',')} tokenIds=${tokenIds.join(',')}`,
  );
};

export const discoverHubIds = async (
  apiBaseUrl: string,
  minCount = 3,
  timeoutMs = 30_000,
  jurisdictionTarget?: CustodyJurisdictionTarget,
): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  let latestVisible = 0;
  while (Date.now() < deadline) {
    const entities = await fetchDebugEntities(apiBaseUrl);
    latestVisible = entities.filter(entry => entry.isHub === true).length;
    const hubs = entities
      .filter((entry): entry is DebugEntitySummary & { entityId: string } => entry.isHub === true && typeof entry.entityId === 'string')
      .filter(entry => !jurisdictionTarget || isSameDebugJurisdiction(entry, jurisdictionTarget))
      .map(entry => entry.entityId.toLowerCase())
      .slice(0, minCount);
    if (hubs.length >= minCount) return hubs;
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${minCount} hub ids from ${apiBaseUrl}` +
    (jurisdictionTarget
      ? ` jurisdiction=${jurisdictionTarget.name} chainId=${String(jurisdictionTarget.chainId)} visibleHubs=${latestVisible}`
      : ''),
  );
};

export const startCustodySupport = async (
  options: StartCustodySupportOptions,
): Promise<StartedCustodySupport> => {
  let daemonChild: ManagedChild | null = null;
  let custodyChild: ManagedChild | null = null;
  try {
    const shardJurisdictionsPath = join(options.dbRoot, 'jurisdictions.json');
    await mkdir(options.dbRoot, { recursive: true });
    await writeFile(shardJurisdictionsPath, await readFile(resolveCustodyJurisdictionsJsonPath(), 'utf8'), 'utf8');
    const jurisdictionTarget = await readCustodyJurisdictionTarget(shardJurisdictionsPath, options.jurisdictionId);
    const daemonAuthSeed = randomBytes(32).toString('hex');
    const daemonAuthAudience = `custody-daemon-${options.daemonPort}`;
    const deriveDaemonAdminKey = (): string => deriveRuntimeAdapterCapabilityToken(
      daemonAuthSeed,
      'full',
      Date.now() + 30 * 60_000,
      {
        audience: daemonAuthAudience,
        keyId: 'custody-bootstrap',
        tokenId: randomBytes(16).toString('hex'),
      },
    );
    const daemonAuthKey = deriveDaemonAdminKey();
    daemonChild = spawnBunChild(
      'custody-daemon',
      ['runtime/api/server/index.ts', '--port', String(options.daemonPort), '--host', '127.0.0.1', '--server-id', `custody-daemon-${options.daemonPort}`],
      {
        USE_ANVIL: 'true',
        XLN_USE_PREDEPLOYED_ADDRESSES: 'true',
        XLN_PREDEPLOYED_JURISDICTION_KEY: options.jurisdictionId,
        BOOTSTRAP_LOCAL_HUBS: '0',
        XLN_SKIP_SERVER_BOOTSTRAP: '1',
        XLN_EARLY_HTTP_BIND: '1',
        XLN_RADAPTER_AUTH_SEED: daemonAuthSeed,
        XLN_RADAPTER_AUDIENCE: daemonAuthAudience,
        XLN_RADAPTER_REQUIRE_STRONG_AUTH_SEED: '1',
        ANVIL_RPC: options.rpcUrl,
        PUBLIC_RPC: options.rpcUrl,
        XLN_STARTUP_STEP_TIMEOUT_MS: process.env['XLN_STARTUP_STEP_TIMEOUT_MS'] ?? '60000',
        RELAY_URL: options.relayUrl,
        XLN_RUNTIME_SEED: options.daemonRuntimeSeed || `${options.seed}:runtime`,
        XLN_DB_PATH: `${options.dbRoot}/daemon-db`,
        XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      },
      {
        startupSignerSeed: options.seed,
        startupSignerLabel: options.signerLabel,
      },
    );
    const [, hubIds] = await Promise.all([
      waitForHttpReady(`http://127.0.0.1:${options.daemonPort}/api/health`, daemonChild, DEFAULT_CHILD_READY_TIMEOUT_MS, isDaemonHealthReady),
      discoverHubIds(options.apiBaseUrl, 3, 30_000, jurisdictionTarget),
    ]);
    const controlResult = await runDaemonControl(
      [
        'setup-custody',
        '--base-url', `http://127.0.0.1:${options.daemonPort}`,
        '--name', options.profileName,
        '--signer-label', options.signerLabel,
        '--hub-ids', hubIds.join(','),
        '--relay-url', options.relayUrl,
        '--gossip-poll-ms', '250',
      ],
      {
        USE_ANVIL: 'true',
      },
      { seed: options.seed, authKey: daemonAuthKey },
    );

    if (!controlResult.ok) {
      throw new Error('setup-custody returned ok=false');
    }

    const identity = controlResult.result;
    await waitForCustodyRouteableState(options.apiBaseUrl, identity.entityId, hubIds);
    const custodyHttps = resolveCustodyServiceHttps();

    custodyChild = spawnBunChild(
      'custody-service',
      ['custody/server.ts'],
      {
        CUSTODY_HOST: '127.0.0.1',
        CUSTODY_PORT: String(options.custodyPort),
        CUSTODY_HTTPS: custodyHttps ? '1' : '0',
        CUSTODY_DAEMON_WS: `ws://127.0.0.1:${options.daemonPort}/rpc`,
        CUSTODY_DAEMON_AUTH_SEED: daemonAuthSeed,
        CUSTODY_DAEMON_AUTH_AUDIENCE: daemonAuthAudience,
        CUSTODY_WALLET_URL: options.walletUrl,
        CUSTODY_ENTITY_ID: identity.entityId,
        CUSTODY_SIGNER_ID: identity.signerId,
        CUSTODY_JURISDICTION_ID: options.jurisdictionId,
        CUSTODY_DB_PATH: `${options.dbRoot}/custody.sqlite`,
      },
      { daemonRuntimeSeed: options.daemonRuntimeSeed || `${options.seed}:runtime` },
    );
    const custodyReadyUrl = await waitForCustodyServiceReady(options.custodyPort, custodyChild, custodyHttps);
    const custodyBaseUrl = new URL(custodyReadyUrl).origin;

    return {
      daemonChild,
      custodyChild,
      identity,
      hubIds,
      custodyBaseUrl,
      daemonAuthSeed,
      daemonAuthAudience,
      daemonAuthKey,
    };
  } catch (error) {
    await Promise.allSettled([
      stopManagedChild(custodyChild),
      stopManagedChild(daemonChild),
    ]);
    throw error;
  }
};
