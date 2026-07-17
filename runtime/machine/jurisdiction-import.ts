import { ethers } from 'ethers';

import { ensureLocalDisputeDelayConfigured } from '../jadapter/local-config';
import { createJAdapterWithRetry } from '../jadapter/retry';
import { createStructuredLogger } from '../infra/logger';
import type { JAdapter, JAdapterConfig } from '../jadapter/types';
import { safeStringify } from '../protocol/serialization';
import type {
  Env,
  JurisdictionImportRequest,
  JurisdictionImportResult,
  JReplica,
  PendingJurisdictionImport,
  RuntimeTx,
} from '../types';

type ImportJRuntimeTx = Extract<RuntimeTx, { type: 'importJ' }>;
type CompleteImportJRuntimeTx = Extract<RuntimeTx, { type: 'completeImportJ' }>;

const LOCAL_J_IMPORT_RESULT = Symbol.for('xln.runtime.j-import-result.local');
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const jurisdictionImportLog = createStructuredLogger('runtime.jurisdiction_import');
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const normalizeAddress = (value: unknown, label: string): string => {
  let normalized: string;
  try {
    normalized = ethers.getAddress(String(value ?? '')).toLowerCase();
  } catch {
    throw new Error(`IMPORT_J_${label}_ADDRESS_INVALID:${String(value ?? '')}`);
  }
  if (normalized === ZERO_ADDRESS) throw new Error(`IMPORT_J_${label}_ADDRESS_ZERO`);
  return normalized;
};

const normalizeContracts = (
  contracts: JurisdictionImportRequest['contracts'],
  required: boolean,
): JurisdictionImportResult['contracts'] | undefined => {
  if (!contracts) {
    if (required) throw new Error('IMPORT_J_RPC_CONTRACTS_REQUIRED');
    return undefined;
  }
  const missing = [
    !contracts.depository ? 'depository' : null,
    !contracts.entityProvider ? 'entityProvider' : null,
    !contracts.account ? 'account' : null,
    !contracts.deltaTransformer ? 'deltaTransformer' : null,
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    throw new Error(`IMPORT_J_CONTRACTS_INCOMPLETE:${missing.join(',')}`);
  }
  return {
    depository: normalizeAddress(contracts.depository, 'DEPOSITORY'),
    entityProvider: normalizeAddress(contracts.entityProvider, 'ENTITY_PROVIDER'),
    account: normalizeAddress(contracts.account, 'ACCOUNT'),
    deltaTransformer: normalizeAddress(contracts.deltaTransformer, 'DELTA_TRANSFORMER'),
  };
};

export const normalizeJurisdictionImportRequest = (
  raw: JurisdictionImportRequest,
): JurisdictionImportRequest => {
  const name = String(raw.name ?? '').trim();
  const ticker = String(raw.ticker ?? '').trim().toUpperCase();
  const chainId = Number(raw.chainId);
  if (!name || name.length > 128) throw new Error('IMPORT_J_NAME_INVALID');
  if (!ticker || ticker.length > 16) throw new Error('IMPORT_J_TICKER_INVALID');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`IMPORT_J_CHAIN_ID_INVALID:${String(raw.chainId)}`);
  }
  if (!Array.isArray(raw.rpcs)) throw new Error('IMPORT_J_RPCS_INVALID');
  const rpcs = raw.rpcs.map((value, index) => {
    const rpc = String(value ?? '').trim();
    if (!rpc) throw new Error(`IMPORT_J_RPC_INVALID:${index}`);
    let url: URL;
    try {
      url = new URL(rpc);
    } catch {
      throw new Error(`IMPORT_J_RPC_INVALID:${index}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`IMPORT_J_RPC_PROTOCOL_INVALID:${index}:${url.protocol}`);
    }
    return url.toString();
  });
  if (new Set(rpcs).size !== rpcs.length) throw new Error('IMPORT_J_RPC_DUPLICATED');
  if (rpcs.length > 8) throw new Error(`IMPORT_J_RPC_LIMIT_EXCEEDED:${rpcs.length}`);
  const isBrowserVM = rpcs.length === 0;
  const contracts = normalizeContracts(raw.contracts, !isBrowserVM);
  const entityProviderDeploymentBlock = Number(raw.entityProviderDeploymentBlock);
  if (!isBrowserVM && raw.entityProviderDeploymentBlock === undefined) {
    throw new Error('IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_REQUIRED');
  }
  if (
    raw.entityProviderDeploymentBlock !== undefined &&
    (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1)
  ) {
    throw new Error(
      `IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${String(raw.entityProviderDeploymentBlock)}`,
    );
  }
  if (isBrowserVM && raw.entityProviderDeploymentBlock !== undefined) {
    throw new Error('IMPORT_J_BROWSERVM_DEPLOYMENT_BLOCK_UNEXPECTED');
  }
  if ((raw.tokens?.length ?? 0) > 0) throw new Error('IMPORT_J_CUSTOM_TOKENS_UNSUPPORTED');
  if (
    raw.blockTimeMs !== undefined &&
    (!Number.isSafeInteger(raw.blockTimeMs) || raw.blockTimeMs <= 0)
  ) throw new Error(`IMPORT_J_BLOCK_TIME_INVALID:${String(raw.blockTimeMs)}`);
  if (raw.startAtCurrentBlock !== undefined && typeof raw.startAtCurrentBlock !== 'boolean') {
    throw new Error('IMPORT_J_START_AT_CURRENT_BLOCK_INVALID');
  }
  if (raw.rpcPolicy !== undefined) {
    if (raw.rpcPolicy === 'failover') {
      throw new Error('IMPORT_J_RPC_POLICY_UNSUPPORTED:failover');
    }
    if (
      typeof raw.rpcPolicy === 'object' &&
      raw.rpcPolicy !== null &&
      raw.rpcPolicy.mode === 'quorum' &&
      Number.isSafeInteger(raw.rpcPolicy.min) &&
      raw.rpcPolicy.min > 0 &&
      raw.rpcPolicy.min <= rpcs.length
    ) {
      throw new Error('IMPORT_J_RPC_POLICY_UNSUPPORTED:quorum');
    }
    if (raw.rpcPolicy !== 'single' && (
      !raw.rpcPolicy ||
      raw.rpcPolicy.mode !== 'quorum' ||
      !Number.isSafeInteger(raw.rpcPolicy.min) ||
      raw.rpcPolicy.min <= 0 ||
      raw.rpcPolicy.min > rpcs.length
    )) {
      throw new Error('IMPORT_J_RPC_POLICY_INVALID');
    }
    if (raw.rpcPolicy === 'single' && rpcs.length !== 1) {
      throw new Error(`IMPORT_J_RPC_POLICY_SINGLE_REQUIRES_ONE_RPC:${rpcs.length}`);
    }
  }
  if (rpcs.length > 1) throw new Error(`IMPORT_J_MULTIPLE_RPCS_UNSUPPORTED:${rpcs.length}`);
  return {
    name,
    chainId,
    ticker,
    rpcs,
    ...(!isBrowserVM ? { entityProviderDeploymentBlock } : {}),
    ...(raw.blockTimeMs !== undefined ? { blockTimeMs: raw.blockTimeMs } : {}),
    ...(raw.startAtCurrentBlock !== undefined
      ? { startAtCurrentBlock: raw.startAtCurrentBlock }
      : {}),
    ...(raw.rpcPolicy !== undefined ? { rpcPolicy: structuredClone(raw.rpcPolicy) } : {}),
    ...(contracts ? { contracts } : {}),
  };
};

export const buildJurisdictionImportRequestHash = (
  request: JurisdictionImportRequest,
): string => ethers.keccak256(ethers.toUtf8Bytes(safeStringify({
  domain: 'xln/jurisdiction-import/v1',
  request: normalizeJurisdictionImportRequest(request),
})));

const jurisdictionNameKey = (name: string): string => name.trim().toLowerCase();

const findJurisdictionReplica = (
  env: Env,
  name: string,
): [string, JReplica] | null => {
  const wanted = jurisdictionNameKey(name);
  for (const entry of env.jReplicas.entries()) {
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
  const depository = replica.depositoryAddress ?? replica.contracts?.depository;
  const entityProvider = replica.entityProviderAddress ?? replica.contracts?.entityProvider;
  const account = replica.contracts?.account;
  const deltaTransformer = replica.contracts?.deltaTransformer;
  const existingContracts = normalizeContracts({
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
  env: Env,
  runtimeTx: ImportJRuntimeTx,
): void => {
  const request = normalizeJurisdictionImportRequest(runtimeTx.data);
  if (request.rpcs.length === 0) {
    const conflictingReplica = [...env.jReplicas.entries()].find(([name, replica]) =>
      jurisdictionNameKey(name) !== jurisdictionNameKey(request.name) &&
      Array.isArray(replica.rpcs) && replica.rpcs.length === 0);
    const conflictingIntent = [...(env.runtimeState?.pendingJurisdictionImports?.values() ?? [])]
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
  env.runtimeState ??= {};
  env.runtimeState.pendingJurisdictionImports ??= new Map();
  const nameKey = jurisdictionNameKey(request.name);
  for (const pending of env.runtimeState.pendingJurisdictionImports.values()) {
    if (jurisdictionNameKey(pending.request.name) !== nameKey) continue;
    if (pending.importId === importId && pending.requestHash === requestHash) return;
    throw new Error(`IMPORT_J_PENDING_CONFLICT:${request.name}`);
  }
  env.runtimeState.pendingJurisdictionImports.set(importId, {
    importId,
    requestHash,
    request,
  });
};

export const markLocalJImportResultRuntimeTx = <T extends CompleteImportJRuntimeTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_J_IMPORT_RESULT, { value: true, enumerable: false });
  return tx;
};

export const copyLocalJImportResultRuntimeTxAuthorization = (
  source: RuntimeTx,
  target: RuntimeTx,
): void => {
  if (
    source.type === 'completeImportJ' &&
    target.type === 'completeImportJ' &&
    (source as RuntimeTx & { [LOCAL_J_IMPORT_RESULT]?: boolean })[LOCAL_J_IMPORT_RESULT]
  ) markLocalJImportResultRuntimeTx(target);
};

export const markRestoredJImportResultRuntimeTxs = (runtimeTxs: RuntimeTx[]): void => {
  for (const runtimeTx of runtimeTxs) {
    if (runtimeTx.type === 'completeImportJ') markLocalJImportResultRuntimeTx(runtimeTx);
  }
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
  const contracts = normalizeContracts(raw.contracts, true)!;
  if (request.contracts && safeStringify(contracts) !== safeStringify(request.contracts)) {
    throw new Error(`IMPORT_J_RESULT_CONTRACTS_MISMATCH:${pending.importId}`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw.blockNumber)) {
    throw new Error(`IMPORT_J_RESULT_BLOCK_NUMBER_INVALID:${raw.blockNumber}`);
  }
  const isBrowserVM = request.rpcs.length === 0;
  if (isBrowserVM) {
    if (!raw.stateRoot || !/^0x[0-9a-fA-F]{64}$/.test(raw.stateRoot)) {
      throw new Error('IMPORT_J_RESULT_STATE_ROOT_INVALID');
    }
    if (!raw.browserVMState) throw new Error('IMPORT_J_RESULT_BROWSERVM_STATE_MISSING');
  } else if (raw.stateRoot !== null || raw.browserVMState !== undefined) {
    throw new Error('IMPORT_J_RESULT_RPC_STATE_INVALID');
  }
  for (const [label, value] of [
    ['DEFAULT_DISPUTE_DELAY', raw.defaultDisputeDelayBlocks],
    ['WATCHER_CONFIRMATION_DEPTH', raw.watcherConfirmationDepth],
    ['ENTITY_PROVIDER_DEPLOYMENT_BLOCK', raw.entityProviderDeploymentBlock],
  ] as const) {
    const minimum = label === 'ENTITY_PROVIDER_DEPLOYMENT_BLOCK' ? 1 : 0;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`IMPORT_J_RESULT_${label}_INVALID:${String(value)}`);
    }
  }
  return { ...structuredClone(raw), contracts };
};

const assertReplicaMatchesResult = (
  replica: JReplica,
  result: JurisdictionImportResult,
): void => {
  assertReplicaMatchesRequest(replica, result);
  if (
    replica.blockNumber.toString() !== result.blockNumber ||
    Number(replica.defaultDisputeDelayBlocks) !== result.defaultDisputeDelayBlocks ||
    Number(replica.watcherConfirmationDepth) !== result.watcherConfirmationDepth ||
    Number(replica.entityProviderDeploymentBlock) !== result.entityProviderDeploymentBlock
  ) throw new Error(`IMPORT_J_RESULT_EXISTING_REPLICA_CONFLICT:${result.name}`);
};

const assertWatcherIdentityAvailable = (
  env: Env,
  result: JurisdictionImportResult,
): void => {
  for (const [name, replica] of env.jReplicas.entries()) {
    if (Number(replica.chainId) !== result.chainId) continue;
    const rawDepository = replica.depositoryAddress ?? replica.contracts?.depository;
    if (!rawDepository) continue;
    const depository = normalizeAddress(rawDepository, 'EXISTING_DEPOSITORY');
    if (depository !== result.contracts.depository) continue;
    throw new Error(
      `IMPORT_J_WATCHER_IDENTITY_CONFLICT:${result.name}:${name}:` +
      `${result.chainId}:${result.contracts.depository}`,
    );
  }
};

export const applyCompleteImportJurisdiction = (
  env: Env,
  runtimeTx: CompleteImportJRuntimeTx,
): void => {
  const existing = findJurisdictionReplica(env, runtimeTx.data.name);
  const pending = env.runtimeState?.pendingJurisdictionImports?.get(runtimeTx.data.importId);
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
    env.jReplicas.set(result.name, {
      name: result.name,
      blockNumber: BigInt(result.blockNumber),
      stateRoot,
      mempool: [],
      blockDelayMs: 300,
      ...(result.blockTimeMs ? { blockTimeMs: result.blockTimeMs } : {}),
      lastBlockTimestamp: env.timestamp,
      position: { x: 0, y: 50, z: 0 },
      depositoryAddress: result.contracts.depository,
      entityProviderAddress: result.contracts.entityProvider,
      entityProviderDeploymentBlock: result.entityProviderDeploymentBlock,
      contracts: structuredClone(result.contracts),
      rpcs: [...result.rpcs],
      chainId: result.chainId,
      defaultDisputeDelayBlocks: result.defaultDisputeDelayBlocks,
      watcherConfirmationDepth: result.watcherConfirmationDepth,
    });
  }
  if (result.browserVMState) env.browserVMState = structuredClone(result.browserVMState);
  env.runtimeState!.pendingJurisdictionImports!.delete(result.importId);
  if (env.runtimeState!.pendingJurisdictionImports!.size === 0) {
    delete env.runtimeState!.pendingJurisdictionImports;
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
      throw new Error(`IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_REQUIRED:${request.name}`);
    }
    return BigInt(deploymentBlock - 1);
  }
  if (!adapter.getCurrentBlockNumber) {
    throw new Error(`IMPORT_J_CURRENT_BLOCK_UNAVAILABLE:${request.name}`);
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
  const contracts = normalizeContracts(adapter.addresses, true)!;
  if (request.contracts && safeStringify(contracts) !== safeStringify(request.contracts)) {
    throw new Error(`IMPORT_J_ADAPTER_CONTRACTS_MISMATCH:${request.name}`);
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

export const prepareJurisdictionImportResult = async (
  pending: PendingJurisdictionImport,
): Promise<JurisdictionImportResult> => {
  const request = pending.request;
  const isBrowserVM = request.rpcs.length === 0;
  jurisdictionImportLog.info('jurisdiction.import_start', {
    name: request.name,
    chainId: request.chainId,
    mode: isBrowserVM ? 'browservm' : 'rpc',
  });
  const adapterConfig: JAdapterConfig = {
    mode: isBrowserVM ? 'browservm' : 'rpc',
    chainId: request.chainId,
  };
  if (!isBrowserVM) {
    const rpcUrl = request.rpcs[0];
    if (!rpcUrl) throw new Error(`IMPORT_J_RPC_MISSING:${request.name}`);
    const contracts = normalizeContracts(request.contracts, true)!;
    adapterConfig.rpcUrl = rpcUrl;
    adapterConfig.fromReplica = {
      name: request.name,
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 300,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 50, z: 0 },
      depositoryAddress: contracts.depository,
      entityProviderAddress: contracts.entityProvider,
      contracts,
      rpcs: request.rpcs,
      chainId: request.chainId,
      ...(request.entityProviderDeploymentBlock !== undefined
        ? { entityProviderDeploymentBlock: request.entityProviderDeploymentBlock }
        : {}),
    };
  }
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
    const contracts = assertAdapterAddresses(adapter, request);
    const defaultDisputeDelayBlocks = await ensureLocalDisputeDelayConfigured(adapter, request.name);
    const watcherConfirmationDepth = adapter.getFinalityDepth?.();
    if (
      watcherConfirmationDepth === undefined ||
      !Number.isSafeInteger(watcherConfirmationDepth) ||
      watcherConfirmationDepth < 0
    ) throw new Error(`IMPORT_J_FINALITY_POLICY_MISSING:${request.name}`);
    const stateRootBytes = adapter.captureStateRoot ? await adapter.captureStateRoot() : null;
    if (isBrowserVM && !(stateRootBytes instanceof Uint8Array && stateRootBytes.length === 32)) {
      throw new Error(`IMPORT_J_STATE_ROOT_UNAVAILABLE:${request.name}`);
    }
    if (!isBrowserVM && stateRootBytes !== null) {
      throw new Error(`IMPORT_J_RPC_STATE_ROOT_UNEXPECTED:${request.name}`);
    }
    const entityProviderDeploymentBlock = adapter.entityProviderDeploymentBlock;
    if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
      throw new Error(`IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${request.name}`);
    }
    const browserVMState = isBrowserVM ? await adapter.dumpState() : undefined;
    if (isBrowserVM && (!browserVMState || typeof browserVMState === 'string')) {
      throw new Error(`IMPORT_J_BROWSERVM_STATE_UNAVAILABLE:${request.name}`);
    }
    result = {
      importId: pending.importId,
      requestHash: pending.requestHash,
      name: request.name,
      chainId: request.chainId,
      ticker: request.ticker,
      rpcs: [...request.rpcs],
      ...(request.blockTimeMs ? { blockTimeMs: request.blockTimeMs } : {}),
      blockNumber: (await resolveInitialBlockNumber(adapter, request)).toString(),
      stateRoot: stateRootBytes ? ethers.hexlify(stateRootBytes) : null,
      defaultDisputeDelayBlocks,
      watcherConfirmationDepth,
      entityProviderDeploymentBlock,
      contracts,
      ...(browserVMState && typeof browserVMState !== 'string'
        ? { browserVMState: structuredClone(browserVMState) }
        : {}),
    };
  } catch (error) {
    primaryError = error;
  }
  await closePreparedAdapter(adapter, primaryError);
  if (!result) throw new Error(`IMPORT_J_RESULT_MISSING:${request.name}`);
  return result;
};

export const materializePendingJurisdictionImportResults = async (
  env: Env,
  enqueue: (runtimeTx: CompleteImportJRuntimeTx) => void,
): Promise<void> => {
  const pending = env.runtimeState?.pendingJurisdictionImports;
  if (!pending || pending.size === 0) return;
  const queuedIds = new Set((env.runtimeMempool ?? env.runtimeInput).runtimeTxs
    .filter((tx): tx is CompleteImportJRuntimeTx => tx.type === 'completeImportJ')
    .map(tx => tx.data.importId));
  const ordered = [...pending.values()].sort((left, right) =>
    jurisdictionNameKey(left.request.name).localeCompare(jurisdictionNameKey(right.request.name)) ||
    left.importId.localeCompare(right.importId));
  for (const intent of ordered) {
    if (queuedIds.has(intent.importId)) continue;
    let result: JurisdictionImportResult;
    try {
      result = await prepareJurisdictionImportResult(intent);
    } catch (error) {
      jurisdictionImportLog.error('jurisdiction.import_failed', {
        name: intent.request.name,
        chainId: intent.request.chainId,
        error: errorMessage(error),
      });
      throw error;
    }
    enqueue(markLocalJImportResultRuntimeTx({ type: 'completeImportJ', data: result }));
    jurisdictionImportLog.info('jurisdiction.ready', {
      name: result.name,
      chainId: result.chainId,
      blockNumber: result.blockNumber,
    });
    queuedIds.add(intent.importId);
  }
};
