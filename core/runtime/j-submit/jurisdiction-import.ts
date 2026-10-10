import { normalizeJurisdictionImportRequest, normalizeJurisdictionImportAddress, normalizeJurisdictionImportContracts } from './jurisdiction-import-request';
import { ethers } from 'ethers';

import { createJAdapterWithRetry } from '../../jurisdiction/adapter/kernel/retry';
import { createStructuredLogger } from '../../support/logger';
import type { JAdapter, JAdapterConfig } from '../../jurisdiction/adapter/types';
import { safeStringify } from '../../protocol/serialization';
import type {
  JurisdictionImportFailure,
  JurisdictionImportRequest,
  JurisdictionImportResult,
  PendingJurisdictionImport,
  RuntimeReplica,
  RuntimeTx,
} from '../types';
import type { JReplica } from '../../types/jurisdiction-runtime';
import { requireRuntimeMempool } from '../mempool/input-queue';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import { jSubmitDueClockMs } from './j-submit-state';

type ImportJRuntimeTx = Extract<RuntimeTx, { type: 'importJ' }>;
type CompleteImportJRuntimeTx = Extract<RuntimeTx, { type: 'completeImportJ' }>;

const LOCAL_J_IMPORT_RESULT = Symbol.for('xln.runtime.j-import-result.local');
const jurisdictionImportLog = createStructuredLogger('runtime.jurisdiction_import');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const IMPORT_RETRY_BASE_MS = 5_000;
const IMPORT_RETRY_MAX_MS = 300_000;

/** The request or its own endpoint contradicts the import: retrying this intent cannot succeed. */
class JurisdictionImportRejectedError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}:${detail}`);
    this.name = 'JurisdictionImportRejectedError';
  }
}

export const buildJurisdictionImportRequestHash = (
  request: JurisdictionImportRequest,
): string => ethers.keccak256(ethers.toUtf8Bytes(safeStringify({
  domain: 'xln/jurisdiction-import/v1',
  request: normalizeJurisdictionImportRequest(request),
})));

const jurisdictionNameKey = (name: string): string => name.trim().toLowerCase();

const findJurisdictionReplica = (
  env: RuntimeReplica,
  name: string,
): [string, JReplica] | null => {
  const wanted = jurisdictionNameKey(name);
  for (const entry of env.state.jReplicas.entries()) {
    if (jurisdictionNameKey(entry[0]) === wanted) return entry;
  }
  return null;
};

const assertReplicaMatchesRequest = (
  replica: JReplica,
  request: JurisdictionImportRequest,
): void => {
  if (Number(replica.chainId) !== request.chainId) {
    throw new Error(`IMPORT_J_EXISTING_CHAIN_CONFLICT:${request.name}`);
  }
  if (
    request.entityProviderDeploymentBlock !== undefined &&
    Number(replica.entityProviderDeploymentBlock) !== request.entityProviderDeploymentBlock
  ) {
    throw new Error(`IMPORT_J_EXISTING_DEPLOYMENT_BLOCK_CONFLICT:${request.name}`);
  }
  const requestedContracts = request.contracts;
  if (!requestedContracts) return;
  const depository = replica.contracts?.depository;
  const entityProvider = replica.contracts?.entityProvider;
  const account = replica.contracts?.account;
  const deltaTransformer = replica.contracts?.deltaTransformer;
  const existingContracts = normalizeJurisdictionImportContracts({
    ...(depository ? { depository } : {}),
    ...(entityProvider ? { entityProvider } : {}),
    ...(account ? { account } : {}),
    ...(deltaTransformer ? { deltaTransformer } : {}),
  }, true)!;
  if (safeStringify(existingContracts) !== safeStringify(requestedContracts)) {
    throw new Error(`IMPORT_J_EXISTING_CONTRACTS_CONFLICT:${request.name}`);
  }
};

export const applyImportJurisdictionIntent = (
  env: RuntimeReplica,
  runtimeTx: ImportJRuntimeTx,
): void => {
  const request = normalizeJurisdictionImportRequest(runtimeTx.data);
  if (request.rpcs.length === 0) {
    const conflictingReplica = [...env.state.jReplicas.entries()].find(([name, replica]) =>
      jurisdictionNameKey(name) !== jurisdictionNameKey(request.name) &&
      Array.isArray(replica.rpcs) && replica.rpcs.length === 0);
    const conflictingIntent = [...(env.infrastructure?.pendingJurisdictionImports?.values() ?? [])]
      .find(intent =>
        jurisdictionNameKey(intent.request.name) !== jurisdictionNameKey(request.name) &&
        intent.request.rpcs.length === 0);
    if (conflictingReplica || conflictingIntent) {
      throw new Error(
        `IMPORT_J_MULTIPLE_BROWSERVM_UNSUPPORTED:${request.name}:` +
        `${conflictingReplica?.[0] ?? conflictingIntent?.request.name ?? 'unknown'}`,
      );
    }
  }
  const existing = findJurisdictionReplica(env, request.name);
  if (existing) {
    assertReplicaMatchesRequest(existing[1], request);
    return;
  }
  const requestHash = buildJurisdictionImportRequestHash(request);
  const importId = requestHash;
  env.infrastructure ??= {};
  env.infrastructure.pendingJurisdictionImports ??= new Map();
  const nameKey = jurisdictionNameKey(request.name);
  for (const pending of env.infrastructure.pendingJurisdictionImports.values()) {
    if (jurisdictionNameKey(pending.request.name) !== nameKey) continue;
    if (pending.importId === importId && pending.requestHash === requestHash) return;
    throw new Error(`IMPORT_J_PENDING_CONFLICT:${request.name}`);
  }
  env.infrastructure.pendingJurisdictionImports.set(importId, {
    importId,
    requestHash,
    request,
  });
};

const markLocalJImportResultRuntimeTx = <T extends CompleteImportJRuntimeTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_J_IMPORT_RESULT, { value: true, enumerable: false });
  return tx;
};

export const assertJImportResultRuntimeTxAuthorized = (
  runtimeTx: RuntimeTx,
  replay: boolean,
): void => {
  if (runtimeTx.type !== 'completeImportJ') return;
  if (
    replay ||
    (runtimeTx as RuntimeTx & { [LOCAL_J_IMPORT_RESULT]?: boolean })[LOCAL_J_IMPORT_RESULT]
  ) return;
  throw new Error('J_IMPORT_RESULT_EXTERNAL_INGRESS_REJECTED');
};

const validateImportResult = (
  pending: PendingJurisdictionImport,
  raw: JurisdictionImportResult,
): JurisdictionImportResult => {
  const request = pending.request;
  if (
    raw.importId !== pending.importId ||
    raw.requestHash !== pending.requestHash ||
    raw.name !== request.name ||
    raw.chainId !== request.chainId ||
    raw.ticker !== request.ticker ||
    safeStringify(raw.rpcs) !== safeStringify(request.rpcs) ||
    raw.blockTimeMs !== request.blockTimeMs
  ) throw new Error(`IMPORT_J_RESULT_INTENT_MISMATCH:${pending.importId}`);
  const contracts = normalizeJurisdictionImportContracts(raw.contracts, true)!;
  if (request.contracts && safeStringify(contracts) !== safeStringify(request.contracts)) {
    throw new Error(`IMPORT_J_RESULT_CONTRACTS_MISMATCH:${pending.importId}`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw.blockNumber)) {
    throw new Error(`IMPORT_J_RESULT_BLOCK_NUMBER_INVALID:${raw.blockNumber}`);
  }
  const isBrowserVM = request.rpcs.length === 0;
  if (raw.watcherReceiptCommitment !== undefined &&
    (raw.watcherReceiptCommitment !== 'tron-rpc-attested' || isBrowserVM || raw.watcherConfirmationDepth !== 0)) {
    throw new Error('IMPORT_J_RESULT_RECEIPT_COMMITMENT_INVALID');
  }
  if (isBrowserVM) {
    if (!raw.stateRoot || !/^0x[0-9a-fA-F]{64}$/.test(raw.stateRoot)) {
      throw new Error('IMPORT_J_RESULT_STATE_ROOT_INVALID');
    }
    if (!raw.browserVMState) throw new Error('IMPORT_J_RESULT_BROWSERVM_STATE_MISSING');
  } else if (raw.stateRoot !== null || raw.browserVMState !== undefined) {
    throw new Error('IMPORT_J_RESULT_RPC_STATE_INVALID');
  }
  for (const [label, value] of [
    ['WATCHER_CONFIRMATION_DEPTH', raw.watcherConfirmationDepth],
    ['ENTITY_PROVIDER_DEPLOYMENT_BLOCK', raw.entityProviderDeploymentBlock],
  ] as const) {
    const minimum = label === 'ENTITY_PROVIDER_DEPLOYMENT_BLOCK' ? 1 : 0;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`IMPORT_J_RESULT_${label}_INVALID:${String(value)}`);
    }
  }
  const tokenIds = new Set<number>();
  const tokenReferences = new Set<string>();
  for (const [index, token] of raw.tokenRegistry.entries()) {
    const prefix = `IMPORT_J_RESULT_TOKEN_${index}`;
    if (!Number.isSafeInteger(token.tokenId) || token.tokenId < 1 || tokenIds.has(token.tokenId)) {
      throw new Error(`${prefix}_ID_INVALID:${String(token.tokenId)}`);
    }
    if (![0, 1, 2].includes(token.tokenType)) throw new Error(`${prefix}_TYPE_INVALID:${String(token.tokenType)}`);
    if (!Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
      throw new Error(`${prefix}_DECIMALS_INVALID:${String(token.decimals)}`);
    }
    const address = normalizeJurisdictionImportAddress(token.address, `${prefix}_ADDRESS`);
    if (typeof token.symbol !== 'string' || typeof token.name !== 'string' || token.externalTokenId < 0n) {
      throw new Error(`${prefix}_METADATA_INVALID`);
    }
    tokenIds.add(token.tokenId);
    // Depository._packTokenReference identifies a listed asset by type, contract and external id.
    // CONTROL and DIVIDEND legitimately share their EP address; only the exact triple is a duplicate.
    const reference = `${token.tokenType}:${address}:${token.externalTokenId}`;
    if (tokenReferences.has(reference)) throw new Error(`${prefix}_REFERENCE_DUPLICATE:${reference}`);
    tokenReferences.add(reference);
    token.address = address;
  }
  raw.tokenRegistry.sort((left, right) => left.tokenId - right.tokenId);
  return { ...structuredClone(raw), contracts };
};

const assertReplicaMatchesResult = (
  replica: JReplica,
  result: JurisdictionImportResult,
): void => {
  assertReplicaMatchesRequest(replica, result);
  if (
    replica.blockNumber.toString() !== result.blockNumber ||
    Number(replica.watcherConfirmationDepth) !== result.watcherConfirmationDepth ||
    replica.watcherReceiptCommitment !== result.watcherReceiptCommitment ||
    Number(replica.entityProviderDeploymentBlock) !== result.entityProviderDeploymentBlock ||
    safeStringify(replica.tokenRegistry) !== safeStringify(result.tokenRegistry)
  ) throw new Error(`IMPORT_J_RESULT_EXISTING_REPLICA_CONFLICT:${result.name}`);
};

const assertWatcherIdentityAvailable = (
  env: RuntimeReplica,
  result: JurisdictionImportResult,
): void => {
  for (const [name, replica] of env.state.jReplicas.entries()) {
    if (Number(replica.chainId) !== result.chainId) continue;
    const rawDepository = replica.contracts?.depository;
    if (!rawDepository) continue;
    const depository = normalizeJurisdictionImportAddress(rawDepository, 'EXISTING_DEPOSITORY');
    if (depository !== result.contracts.depository) continue;
    throw new Error(
      `IMPORT_J_WATCHER_IDENTITY_CONFLICT:${result.name}:${name}:` +
      `${result.chainId}:${result.contracts.depository}`,
    );
  }
};

export const applyCompleteImportJurisdiction = (
  env: RuntimeReplica,
  runtimeTx: CompleteImportJRuntimeTx,
): void => {
  const existing = findJurisdictionReplica(env, runtimeTx.data.name);
  const pending = env.infrastructure?.pendingJurisdictionImports?.get(runtimeTx.data.importId);
  if (!pending) {
    if (existing) {
      assertReplicaMatchesResult(existing[1], runtimeTx.data);
      return;
    }
    throw new Error(`IMPORT_J_RESULT_STALE:${runtimeTx.data.importId}`);
  }
  const result = validateImportResult(pending, runtimeTx.data);
  if (existing) {
    assertReplicaMatchesResult(existing[1], result);
  } else {
    assertWatcherIdentityAvailable(env, result);
    const stateRoot = result.stateRoot ? ethers.getBytes(result.stateRoot) : null;
    env.state.jReplicas.set(result.name, {
      name: result.name,
      blockNumber: BigInt(result.blockNumber),
      stateRoot,
      mempool: [],
      blockDelayMs: 300,
      ...(result.blockTimeMs ? { blockTimeMs: result.blockTimeMs } : {}),
      lastBlockTimestamp: env.state.timestamp,
      position: { x: 0, y: 50, z: 0 },
      entityProviderDeploymentBlock: result.entityProviderDeploymentBlock,
      contracts: structuredClone(result.contracts),
      rpcs: [...result.rpcs],
      chainId: result.chainId,
      watcherConfirmationDepth: result.watcherConfirmationDepth,
      ...(result.watcherReceiptCommitment ? { watcherReceiptCommitment: result.watcherReceiptCommitment } : {}),
      tokenRegistry: structuredClone(result.tokenRegistry),
    });
  }
  if (result.browserVMState) env.browserVMState = structuredClone(result.browserVMState);
  env.infrastructure!.pendingJurisdictionImports!.delete(result.importId);
  if (env.infrastructure!.pendingJurisdictionImports!.size === 0) {
    delete env.infrastructure!.pendingJurisdictionImports;
  }
  env.activeJurisdiction ||= result.name;
};

const resolveInitialBlockNumber = async (
  adapter: JAdapter,
  request: JurisdictionImportRequest,
): Promise<bigint> => {
  if (!request.startAtCurrentBlock) {
    if (request.rpcs.length === 0) return 0n;
    const deploymentBlock = request.entityProviderDeploymentBlock;
    if (deploymentBlock === undefined) {
      throw new JurisdictionImportRejectedError('IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_REQUIRED', request.name);
    }
    return BigInt(deploymentBlock - 1);
  }
  if (!adapter.getCurrentBlockNumber) {
    throw new JurisdictionImportRejectedError('IMPORT_J_CURRENT_BLOCK_UNAVAILABLE', request.name);
  }
  const current = await adapter.getCurrentBlockNumber();
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error(`IMPORT_J_CURRENT_BLOCK_INVALID:${request.name}:${String(current)}`);
  }
  return BigInt(current);
};

const assertAdapterAddresses = (
  adapter: JAdapter,
  request: JurisdictionImportRequest,
): JurisdictionImportResult['contracts'] => {
  const contracts = normalizeJurisdictionImportContracts(adapter.addresses, true)!;
  if (request.contracts && safeStringify(contracts) !== safeStringify(request.contracts)) {
    throw new JurisdictionImportRejectedError('IMPORT_J_ADAPTER_CONTRACTS_MISMATCH', request.name);
  }
  return contracts;
};

const closePreparedAdapter = async (
  adapter: JAdapter,
  primaryError?: unknown,
): Promise<void> => {
  try {
    await adapter.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError([primaryError, closeError], 'IMPORT_J_PREPARE_AND_CLOSE_FAILED');
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
};

const buildJurisdictionImportAdapterConfig = (
  request: JurisdictionImportRequest,
  isBrowserVM: boolean,
): JAdapterConfig => {
  const config: JAdapterConfig = {
    mode: isBrowserVM ? 'browservm' : 'rpc',
    chainId: request.chainId,
    ...(!isBrowserVM ? { watchOnly: true } : {}),
  };
  if (isBrowserVM) return config;

  const rpcUrl = request.rpcs[0];
  if (!rpcUrl) throw new JurisdictionImportRejectedError('IMPORT_J_RPC_MISSING', request.name);
  const contracts = normalizeJurisdictionImportContracts(request.contracts, true)!;
  config.rpcUrl = rpcUrl;
  config.fromReplica = {
    name: request.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 300,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 50, z: 0 },
    contracts,
    rpcs: request.rpcs,
    chainId: request.chainId,
    ...(request.entityProviderDeploymentBlock !== undefined
      ? { entityProviderDeploymentBlock: request.entityProviderDeploymentBlock }
      : {}),
  };
  return config;
};

const requireWatcherConfirmationDepth = (
  adapter: JAdapter,
  request: JurisdictionImportRequest,
): number => {
  const depth = adapter.getFinalityDepth?.();
  if (depth === undefined || !Number.isSafeInteger(depth) || depth < 0) {
    throw new JurisdictionImportRejectedError('IMPORT_J_FINALITY_POLICY_MISSING', request.name);
  }
  return depth;
};

const buildPreparedJurisdictionImportResult = async (
  pending: PendingJurisdictionImport,
  adapter: JAdapter,
  isBrowserVM: boolean,
): Promise<JurisdictionImportResult> => {
  const request = pending.request;
  const contracts = assertAdapterAddresses(adapter, request);
  const watcherConfirmationDepth = requireWatcherConfirmationDepth(adapter, request);
  const stateRootBytes = adapter.captureStateRoot ? await adapter.captureStateRoot() : null;
  if (isBrowserVM && !(stateRootBytes instanceof Uint8Array && stateRootBytes.length === 32)) {
    throw new JurisdictionImportRejectedError('IMPORT_J_STATE_ROOT_UNAVAILABLE', request.name);
  }
  if (!isBrowserVM && stateRootBytes !== null) {
    throw new JurisdictionImportRejectedError('IMPORT_J_RPC_STATE_ROOT_UNEXPECTED', request.name);
  }
  const entityProviderDeploymentBlock = adapter.entityProviderDeploymentBlock;
  if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
    throw new JurisdictionImportRejectedError('IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID', request.name);
  }
  const browserVMState = isBrowserVM ? await adapter.dumpState() : undefined;
  const tokenRegistry = await adapter.getTokenRegistry();
  if (isBrowserVM && (!browserVMState || typeof browserVMState === 'string')) {
    throw new JurisdictionImportRejectedError('IMPORT_J_BROWSERVM_STATE_UNAVAILABLE', request.name);
  }
  return {
    importId: pending.importId,
    requestHash: pending.requestHash,
    name: request.name,
    chainId: request.chainId,
    ticker: request.ticker,
    rpcs: [...request.rpcs],
    ...(request.blockTimeMs ? { blockTimeMs: request.blockTimeMs } : {}),
    blockNumber: (await resolveInitialBlockNumber(adapter, request)).toString(),
    stateRoot: stateRootBytes ? ethers.hexlify(stateRootBytes) : null,
    watcherConfirmationDepth,
    ...(adapter.mode === 'tron' ? { watcherReceiptCommitment: 'tron-rpc-attested' as const } : {}),
    tokenRegistry,
    entityProviderDeploymentBlock,
    contracts,
    ...(browserVMState && typeof browserVMState !== 'string'
      ? { browserVMState: structuredClone(browserVMState) }
      : {}),
  };
};

const prepareJurisdictionImportResult = async (
  pending: PendingJurisdictionImport,
): Promise<JurisdictionImportResult> => {
  const request = pending.request;
  const isBrowserVM = request.rpcs.length === 0;
  jurisdictionImportLog.info('jurisdiction.import_start', {
    name: request.name,
    chainId: request.chainId,
    mode: isBrowserVM ? 'browservm' : 'rpc',
  });
  const adapterConfig = buildJurisdictionImportAdapterConfig(request, isBrowserVM);
  const adapter = await createJAdapterWithRetry(adapterConfig, {
    context: `importJ:${request.name}`,
    attempts: typeof window !== 'undefined' ? 5 : 3,
    onRetry: (attempt, attempts, error) => {
      jurisdictionImportLog.warn('jurisdiction.import_retry', {
        name: request.name,
        chainId: request.chainId,
        attempt,
        attempts,
        error: errorMessage(error),
      });
    },
  });
  let result: JurisdictionImportResult | undefined;
  let primaryError: unknown;
  try {
    result = await buildPreparedJurisdictionImportResult(pending, adapter, isBrowserVM);
  } catch (error) {
    primaryError = error;
  }
  await closePreparedAdapter(adapter, primaryError);
  if (!result) throw new Error(`IMPORT_J_RESULT_MISSING:${request.name}`);
  return result;
};

const rejectedImportCode = (error: unknown): string | null => {
  const causes = error instanceof AggregateError ? error.errors : [error];
  const rejected = causes.find((cause): cause is JurisdictionImportRejectedError =>
    cause instanceof JurisdictionImportRejectedError);
  return rejected?.code ?? null;
};

/**
 * Materialization is external I/O against an operator- or user-supplied RPC,
 * run before every frame: a failure must never leave the loop. A typed
 * contradiction is not retried in this process; anything else backs off.
 */
const recordImportFailure = (env: RuntimeReplica, intent: PendingJurisdictionImport, error: unknown, now: number): void => {
  const failures = ensureRuntimeInfrastructure(env).jurisdictionImportFailures ??= new Map();
  const count = (failures.get(intent.importId)?.failures ?? 0) + 1;
  const code = rejectedImportCode(error);
  const failure: JurisdictionImportFailure = code
    ? { category: 'rejected', code, message: errorMessage(error), failures: count, retryAt: null }
    : {
        category: 'transient',
        code: 'IMPORT_J_MATERIALIZE_UNAVAILABLE',
        message: errorMessage(error),
        failures: count,
        retryAt: now + Math.min(IMPORT_RETRY_MAX_MS, IMPORT_RETRY_BASE_MS * 2 ** (count - 1)),
      };
  failures.set(intent.importId, failure);
  jurisdictionImportLog.error('jurisdiction.import_failed', {
    name: intent.request.name,
    chainId: intent.request.chainId,
    ...failure,
  });
};

const importIsDue = (env: RuntimeReplica, importId: string, now: number): boolean => {
  const failure = env.infrastructure?.jurisdictionImportFailures?.get(importId);
  return !failure || (failure.retryAt !== null && failure.retryAt <= now);
};

export const hasDueJurisdictionImport = (env: RuntimeReplica): boolean => {
  const now = jSubmitDueClockMs(env);
  return [...(env.infrastructure?.pendingJurisdictionImports?.keys() ?? [])]
    .some(importId => importIsDue(env, importId, now));
};

export const getNextJurisdictionImportRetryAt = (env: RuntimeReplica): number | null => {
  const retries = [...(env.infrastructure?.pendingJurisdictionImports?.keys() ?? [])]
    .flatMap(importId => env.infrastructure?.jurisdictionImportFailures?.get(importId)?.retryAt ?? []);
  return retries.length > 0 ? Math.min(...retries) : null;
};

const pruneSettledImportFailures = (env: RuntimeReplica): void => {
  const failures = env.infrastructure?.jurisdictionImportFailures;
  if (!failures) return;
  for (const importId of failures.keys()) {
    if (!env.infrastructure?.pendingJurisdictionImports?.has(importId)) failures.delete(importId);
  }
};

export const materializePendingJurisdictionImportResults = async (
  env: RuntimeReplica,
  enqueue: (runtimeTx: CompleteImportJRuntimeTx) => void,
): Promise<void> => {
  pruneSettledImportFailures(env);
  const pending = env.infrastructure?.pendingJurisdictionImports;
  if (!pending || pending.size === 0) return;
  const now = jSubmitDueClockMs(env);
  const queuedIds = new Set(requireRuntimeMempool(env).runtimeTxs
    .filter((tx): tx is CompleteImportJRuntimeTx => tx.type === 'completeImportJ')
    .map(tx => tx.data.importId));
  const ordered = [...pending.values()].sort((left, right) =>
    jurisdictionNameKey(left.request.name).localeCompare(jurisdictionNameKey(right.request.name)) ||
    left.importId.localeCompare(right.importId));
  for (const intent of ordered) {
    if (queuedIds.has(intent.importId) || !importIsDue(env, intent.importId, now)) continue;
    let result: JurisdictionImportResult;
    try {
      result = await prepareJurisdictionImportResult(intent);
    } catch (error) {
      recordImportFailure(env, intent, error, now);
      continue;
    }
    env.infrastructure?.jurisdictionImportFailures?.delete(intent.importId);
    enqueue(markLocalJImportResultRuntimeTx({ type: 'completeImportJ', data: result }));
    jurisdictionImportLog.info('jurisdiction.ready', {
      name: result.name,
      chainId: result.chainId,
      blockNumber: result.blockNumber,
    });
    queuedIds.add(intent.importId);
  }
};
