export type RuntimeFailureCategory = 'ExpectedEmpty' | 'TransientRace' | 'Contradiction';

export type RuntimeFailureSignal = {
  category: RuntimeFailureCategory;
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
};

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
