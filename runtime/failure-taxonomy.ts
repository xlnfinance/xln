export type RuntimeFailureCategory = 'ExpectedEmpty' | 'TransientRace' | 'Contradiction';

export type RuntimeFailureSignal = {
  category: RuntimeFailureCategory;
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
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
