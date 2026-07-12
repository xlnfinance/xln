export type RuntimeFailureCategory = 'ExpectedEmpty' | 'TransientRace' | 'Contradiction';

export type RuntimeFailureSignal = {
  category: RuntimeFailureCategory;
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
};

const RUNTIME_FAILURE_CATEGORIES = new Set<RuntimeFailureCategory>([
  'ExpectedEmpty',
  'TransientRace',
  'Contradiction',
]);

export const isRuntimeFailureCategory = (value: unknown): value is RuntimeFailureCategory =>
  typeof value === 'string' && RUNTIME_FAILURE_CATEGORIES.has(value as RuntimeFailureCategory);

export const isRuntimeFailureSignal = (value: unknown): value is RuntimeFailureSignal =>
  typeof value === 'object' &&
  value !== null &&
  isRuntimeFailureCategory((value as RuntimeFailureSignal).category) &&
  typeof (value as RuntimeFailureSignal).code === 'string' &&
  typeof (value as RuntimeFailureSignal).message === 'string' &&
  typeof (value as RuntimeFailureSignal).retryable === 'boolean' &&
  typeof (value as RuntimeFailureSignal).fatal === 'boolean' &&
  (value as RuntimeFailureSignal).retryable === ((value as RuntimeFailureSignal).category === 'TransientRace') &&
  (value as RuntimeFailureSignal).fatal === ((value as RuntimeFailureSignal).category === 'Contradiction');

const HEALTH_DEGRADED_CODES: Record<string, string> = {
  storage: 'STORAGE_NOT_READY',
  hubs: 'HUBS_NOT_READY',
  hubMesh: 'HUB_MESH_NOT_READY',
  reset: 'RESET_NOT_READY',
  marketMaker: 'MARKET_MAKER_NOT_READY',
  custody: 'CUSTODY_NOT_READY',
  bootstrapReserves: 'BOOTSTRAP_RESERVES_NOT_READY',
  bootstrapReserveTargets: 'BOOTSTRAP_RESERVE_TARGETS_NOT_READY',
};

const TRANSPORT_FAILURE_CATEGORIES: Record<string, RuntimeFailureCategory> = {
  ENTITY_HUB_PROXY_ENTITY_NOT_FOUND: 'ExpectedEmpty',
  FAUCET_HUB_NOT_FOUND: 'ExpectedEmpty',
  NO_HEALTHY_HUB_API_AVAILABLE: 'TransientRace',
  PROXY_UPSTREAM_TIMEOUT: 'TransientRace',
  REQUESTED_HUB_API_UNAVAILABLE: 'TransientRace',
  RPC_UPSTREAM_NOT_CONFIGURED: 'Contradiction',
};

const FAUCET_FAILURE_CATEGORIES: Record<string, RuntimeFailureCategory> = {
  FAUCET_ACCOUNT_NOT_OPEN: 'ExpectedEmpty',
  FAUCET_HUB_REQUIRED: 'Contradiction',
  FAUCET_INSUFFICIENT_OUT_CAPACITY: 'ExpectedEmpty',
  FAUCET_INVALID_HUB_ENTITY_ID: 'Contradiction',
  FAUCET_INVALID_TOKEN_ID: 'Contradiction',
  FAUCET_INVALID_USER_ENTITY_ID: 'Contradiction',
  FAUCET_HUB_INSUFFICIENT_RESERVES: 'ExpectedEmpty',
  FAUCET_J_BATCH_TIMEOUT: 'TransientRace',
  FAUCET_J_ADAPTER_NOT_INITIALIZED: 'TransientRace',
  FAUCET_PAYMENT_ADMISSION_FAILED: 'TransientRace',
  FAUCET_PAYMENT_RECEIPT_FAILED: 'TransientRace',
  FAUCET_REQUESTED_HUB_NOT_FOUND: 'ExpectedEmpty',
  FAUCET_RESERVE_EVENT_MISSING: 'Contradiction',
  FAUCET_RESERVE_UPDATE_TIMEOUT: 'TransientRace',
  FAUCET_RUNTIME_REQUIRED: 'TransientRace',
  FAUCET_RUNTIME_NOT_INITIALIZED: 'TransientRace',
  FAUCET_SENT_BATCH_TIMEOUT: 'TransientRace',
  FAUCET_TOKEN_UNKNOWN: 'Contradiction',
  FAUCET_USER_ENTITY_ID_REQUIRED: 'Contradiction',
};

const BOOTSTRAP_STAGE_CODES: Record<string, string> = {
  preflight: 'BOOTSTRAP_PREFLIGHT_NOT_READY',
  'hub-mesh': 'BOOTSTRAP_HUB_MESH_NOT_READY',
  'same-chain': 'BOOTSTRAP_SAME_CHAIN_BOOKS_NOT_READY',
  'cross-chain': 'BOOTSTRAP_CROSS_CHAIN_ROUTES_NOT_READY',
  'market-maker': 'BOOTSTRAP_MARKET_MAKER_NOT_READY',
  custody: 'BOOTSTRAP_CUSTODY_NOT_READY',
  'health-poll': 'BOOTSTRAP_HEALTH_POLL_NOT_READY',
  'ready-hash': 'BOOTSTRAP_READY_HASH_NOT_READY',
};

const MARKET_MAKER_FAILURE_CATEGORIES: Record<string, RuntimeFailureCategory> = {
  MARKET_MAKER_DISABLED: 'ExpectedEmpty',
  MARKET_MAKER_CHILD_INACTIVE: 'TransientRace',
  MARKET_MAKER_HEALTH_MISSING: 'TransientRace',
  MARKET_MAKER_STARTUP_PHASE_NOT_READY: 'TransientRace',
  MARKET_MAKER_CHILD_NOT_READY: 'TransientRace',
  MARKET_MAKER_HUB_COUNT_MISMATCH: 'TransientRace',
  MARKET_MAKER_HUB_DEPTH_NOT_READY: 'TransientRace',
  MARKET_MAKER_CROSS_NOT_READY: 'TransientRace',
};

const J_BATCH_FAILURE_CATEGORIES: Record<string, RuntimeFailureCategory> = {
  J_BATCH_EMPTY: 'ExpectedEmpty',
  J_BATCH_SENT_PENDING: 'TransientRace',
  J_BATCH_JURISDICTION_MISSING: 'Contradiction',
  J_BATCH_JURISDICTION_UNAVAILABLE: 'TransientRace',
  J_BATCH_CHAIN_ID_MISSING: 'Contradiction',
  J_BATCH_SIGNER_MISSING: 'Contradiction',
  J_BATCH_LIMIT_EXCEEDED: 'Contradiction',
  J_BATCH_CONSENSUS_HANKO_MISSING: 'Contradiction',
  J_SUBMIT_MISSING_JREPLICA: 'TransientRace',
  J_SUBMIT_MISSING_JADAPTER: 'TransientRace',
  J_SUBMIT_TRANSIENT: 'TransientRace',
  J_SUBMIT_FATAL: 'Contradiction',
};

export const normalizeRuntimeFailureCode = (value: unknown): string => {
  const raw = String(value || '').trim();
  const token = raw.split(/[\s:]/)[0] || 'UNKNOWN';
  return token.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
};

export const buildRuntimeFailureSignal = (input: {
  category: RuntimeFailureCategory;
  code: string;
  message?: string;
}): RuntimeFailureSignal => {
  const code = normalizeRuntimeFailureCode(input.code);
  const message = String(input.message || code).trim() || code;
  return {
    category: input.category,
    code,
    message,
    retryable: input.category === 'TransientRace',
    fatal: input.category === 'Contradiction',
  };
};

export const classifyRuntimeImportReadinessReason = (reason: string): RuntimeFailureSignal => {
  const normalized = String(reason || '').trim() || 'unknown';
  const code = normalizeRuntimeFailureCode(normalized);
  const category: RuntimeFailureCategory =
    code === 'NO_MANAGED_RUNTIME_IMPORTS'
      ? 'ExpectedEmpty'
      : code === 'INVALID_RUNTIME_IMPORT_MANIFEST' || code === 'RUNTIME_IMPORT_TOKEN_MISMATCH'
        ? 'Contradiction'
        : 'TransientRace';
  return buildRuntimeFailureSignal({
    category,
    code,
    message: normalized,
  });
};

export const classifyRuntimeHealthDegradedReason = (reason: string): RuntimeFailureSignal => {
  const normalized = String(reason || '').trim() || 'unknown';
  const code = HEALTH_DEGRADED_CODES[normalized] ?? normalizeRuntimeFailureCode(normalized);
  return buildRuntimeFailureSignal({
    category: 'TransientRace',
    code,
    message: normalized,
  });
};

export const buildRuntimeHealthFailures = (degraded: string[]): RuntimeFailureSignal[] =>
  degraded.map(classifyRuntimeHealthDegradedReason);

export const classifyRuntimeTransportFailure = (code: string, message?: string): RuntimeFailureSignal => {
  const normalizedCode = normalizeRuntimeFailureCode(code);
  const category = TRANSPORT_FAILURE_CATEGORIES[normalizedCode] ?? 'TransientRace';
  return buildRuntimeFailureSignal({
    category,
    code: normalizedCode,
    message: message ?? normalizedCode,
  });
};

export const classifyRuntimeFaucetFailure = (code: string, message?: string): RuntimeFailureSignal => {
  const normalizedCode = normalizeRuntimeFailureCode(code);
  const category = FAUCET_FAILURE_CATEGORIES[normalizedCode] ?? (
    normalizedCode.startsWith('FAUCET_INVALID_') ? 'Contradiction' : 'TransientRace'
  );
  return buildRuntimeFailureSignal({
    category,
    code: normalizedCode,
    message: message ?? normalizedCode,
  });
};

export const classifyRuntimeBootstrapStageFailure = (
  stageKey: string,
  status: string,
  reason?: string,
): RuntimeFailureSignal | null => {
  if (status === 'done' || status === 'disabled') return null;
  const code = BOOTSTRAP_STAGE_CODES[String(stageKey || '').trim()] ?? `BOOTSTRAP_${normalizeRuntimeFailureCode(stageKey)}_NOT_READY`;
  return buildRuntimeFailureSignal({
    category: 'TransientRace',
    code,
    message: reason ?? code,
  });
};

export const classifyRuntimeMarketMakerFailure = (
  code: string,
  message?: string,
): RuntimeFailureSignal => {
  const normalizedCode = normalizeRuntimeFailureCode(code);
  const category = MARKET_MAKER_FAILURE_CATEGORIES[normalizedCode] ?? 'TransientRace';
  return buildRuntimeFailureSignal({
    category,
    code: normalizedCode,
    message: message ?? normalizedCode,
  });
};

export const classifyRuntimeJBatchFailure = (
  code: string,
  message?: string,
): RuntimeFailureSignal => {
  const normalizedCode = normalizeRuntimeFailureCode(code);
  const category = J_BATCH_FAILURE_CATEGORIES[normalizedCode] ?? (
    normalizedCode.startsWith('J_SUBMIT_TRANSIENT') ? 'TransientRace' : 'Contradiction'
  );
  return buildRuntimeFailureSignal({
    category,
    code: normalizedCode,
    message: message ?? normalizedCode,
  });
};
