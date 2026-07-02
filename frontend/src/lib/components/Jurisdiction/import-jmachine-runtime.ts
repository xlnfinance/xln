import type { Env, RuntimeInput } from '@xln/runtime/xln-api';
import {
  deriveJMachineCreatedAt,
  jmachineOperations,
  type JMachineConfig,
} from '$lib/stores/jmachineStore';
import { submitRuntimeInput } from '$lib/stores/xlnStore';

export type JMachineCreateDetail = {
  name: string;
  mode: 'browservm' | 'rpc';
  chainId: number;
  rpcs: string[];
  blockTimeMs: number;
  ticker: string;
  contracts?: JMachineConfig['contracts'];
  deploy?: boolean;
};

export type RuntimeJMachineImportResult = {
  env: Env;
  config: JMachineConfig;
};

const J_MACHINE_IMPORT_COMMIT_WAIT_MS = 3_000;
const J_MACHINE_IMPORT_COMMIT_POLL_MS = 50;

const normalizeName = (value: unknown): string => String(value || '').trim();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeMode = (value: unknown): JMachineCreateDetail['mode'] =>
  value === 'browservm' ? 'browservm' : 'rpc';

const normalizeChainId = (value: unknown): number => {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric < 1) throw new Error('J_MACHINE_CHAIN_ID_INVALID');
  return numeric;
};

const normalizeBlockTimeMs = (value: unknown): number => {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric < 1) throw new Error('J_MACHINE_BLOCK_TIME_INVALID');
  return numeric;
};

const normalizeRpcList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
      .map((entry) => String(entry || '').trim())
      .filter((entry) => entry.startsWith('http://') || entry.startsWith('https://'))
    : [];

export const normalizeJMachineCreateDetail = (detail: JMachineCreateDetail): JMachineCreateDetail => {
  const name = normalizeName(detail.name);
  const mode = normalizeMode(detail.mode);
  const chainId = normalizeChainId(detail.chainId);
  const blockTimeMs = normalizeBlockTimeMs(detail.blockTimeMs);
  const ticker = normalizeName(detail.ticker).toUpperCase();
  const rpcs = mode === 'browservm' ? [] : normalizeRpcList(detail.rpcs);
  if (!name) throw new Error('J_MACHINE_NAME_REQUIRED');
  if (!ticker) throw new Error('J_MACHINE_TICKER_REQUIRED');
  if (mode === 'rpc' && rpcs.length === 0) throw new Error('J_MACHINE_RPC_REQUIRED');
  return {
    name,
    mode,
    chainId,
    ticker,
    rpcs,
    blockTimeMs,
    ...(detail.contracts ? { contracts: detail.contracts } : {}),
    ...(detail.deploy ? { deploy: true } : {}),
  };
};

export const buildJMachineImportRuntimeInput = (detail: JMachineCreateDetail): RuntimeInput => {
  const config = normalizeJMachineCreateDetail(detail);
  return {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: config.name,
        chainId: config.chainId,
        ticker: config.ticker,
        rpcs: config.rpcs,
        blockTimeMs: config.blockTimeMs,
        ...(config.contracts ? { contracts: config.contracts } : {}),
      },
    }],
    entityInputs: [],
  };
};

const readImportedContracts = (
  env: Env,
  name: string,
  fallback?: JMachineConfig['contracts'],
): JMachineConfig['contracts'] | undefined => {
  const imported = env.jReplicas?.get?.(name);
  const contracts = {
    depository: String(imported?.depositoryAddress || imported?.contracts?.depository || fallback?.depository || ''),
    entityProvider: String(imported?.entityProviderAddress || imported?.contracts?.entityProvider || fallback?.entityProvider || ''),
    account: String(imported?.contracts?.account || fallback?.account || ''),
    deltaTransformer: String(imported?.contracts?.deltaTransformer || fallback?.deltaTransformer || ''),
  };
  if (!contracts.depository && !contracts.entityProvider && !contracts.account && !contracts.deltaTransformer) return undefined;
  return {
    ...(contracts.depository ? { depository: contracts.depository } : {}),
    ...(contracts.entityProvider ? { entityProvider: contracts.entityProvider } : {}),
    ...(contracts.account ? { account: contracts.account } : {}),
    ...(contracts.deltaTransformer ? { deltaTransformer: contracts.deltaTransformer } : {}),
  };
};

export const buildPersistedJMachineConfig = (
  detail: JMachineCreateDetail,
  env?: Env | null,
  existing?: JMachineConfig | null,
): JMachineConfig => {
  const config = normalizeJMachineCreateDetail(detail);
  const contracts = env ? readImportedContracts(env, config.name, config.contracts) : config.contracts;
  return {
    name: config.name,
    mode: config.mode,
    chainId: config.chainId,
    ticker: config.ticker,
    rpcs: config.rpcs,
    blockTimeMs: config.blockTimeMs,
    ...(contracts ? { contracts } : {}),
    createdAt: existing?.createdAt ?? deriveJMachineCreatedAt(config),
  };
};

export const importJMachineViaRuntime = async (
  env: Env,
  detail: JMachineCreateDetail,
): Promise<RuntimeJMachineImportResult> => {
  const normalized = normalizeJMachineCreateDetail(detail);
  const nextEnv = await submitRuntimeInput(buildJMachineImportRuntimeInput(normalized));
  if (!nextEnv) throw new Error(`J_MACHINE_IMPORT_REQUIRES_EMBEDDED_RUNTIME:${normalized.name}`);
  const startedAt = Date.now();
  while (!nextEnv.jReplicas?.get?.(normalized.name) && Date.now() - startedAt < J_MACHINE_IMPORT_COMMIT_WAIT_MS) {
    await sleep(J_MACHINE_IMPORT_COMMIT_POLL_MS);
  }
  if (!nextEnv.jReplicas?.get?.(normalized.name)) {
    throw new Error(`J_MACHINE_IMPORT_NOT_COMMITTED:${normalized.name}`);
  }
  const config = buildPersistedJMachineConfig(
    normalized,
    nextEnv,
    jmachineOperations.getByName(normalized.name) ?? null,
  );
  jmachineOperations.upsert(config);
  return { env: nextEnv, config };
};
