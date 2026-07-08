export type RuntimeRecoveryDiscoveryStatus = {
  runtimeId: string;
  checkedTowers: number;
  checkedPeers?: number;
  peerBackupCount?: number;
  backupCount: number;
  errors: string[];
  failures?: RuntimeRecoveryDiscoveryFailureStatus[];
  checkedAt: number;
};

export type RuntimeRecoveryDiscoveryFailureStatus = {
  source: 'tower' | 'peer';
  sourceLabel: string;
  category: 'ExpectedEmpty' | 'TransientRace' | 'Contradiction';
  code: string;
  message: string;
};

const STORAGE_PREFIX = 'xln-runtime-recovery-discovery:';

const normalizeRuntimeId = (value: string | null | undefined): string =>
  String(value || '').trim().toLowerCase();

const storageKey = (runtimeId: string): string =>
  `${STORAGE_PREFIX}${normalizeRuntimeId(runtimeId)}`;

const normalizeFailureStatus = (failure: unknown): RuntimeRecoveryDiscoveryFailureStatus | null => {
  if (!failure || typeof failure !== 'object') return null;
  const source = String((failure as { source?: unknown }).source || '').trim();
  const category = String((failure as { category?: unknown }).category || '').trim();
  if (source !== 'tower' && source !== 'peer') return null;
  if (category !== 'ExpectedEmpty' && category !== 'TransientRace' && category !== 'Contradiction') return null;
  const sourceLabel = String((failure as { sourceLabel?: unknown }).sourceLabel || source).trim() || source;
  const code = String((failure as { code?: unknown }).code || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
  const message = String((failure as { message?: unknown }).message || code).trim() || code;
  return { source, sourceLabel, category, code, message };
};

const normalizeFailureStatuses = (failures: unknown): RuntimeRecoveryDiscoveryFailureStatus[] =>
  Array.isArray(failures)
    ? failures.flatMap((failure) => {
      const normalized = normalizeFailureStatus(failure);
      return normalized ? [normalized] : [];
    })
    : [];

export function writeRuntimeRecoveryDiscoveryStatus(status: RuntimeRecoveryDiscoveryStatus): void {
  if (typeof localStorage === 'undefined') return;
  const runtimeId = normalizeRuntimeId(status.runtimeId);
  if (!runtimeId) return;
  localStorage.setItem(storageKey(runtimeId), JSON.stringify({
    runtimeId,
    checkedTowers: Math.max(0, Math.floor(Number(status.checkedTowers || 0))),
    checkedPeers: Math.max(0, Math.floor(Number(status.checkedPeers || 0))),
    peerBackupCount: Math.max(0, Math.floor(Number(status.peerBackupCount || 0))),
    backupCount: Math.max(0, Math.floor(Number(status.backupCount || 0))),
    errors: status.errors.map((entry) => String(entry || '')).filter(Boolean),
    failures: normalizeFailureStatuses(status.failures),
    checkedAt: Math.max(0, Math.floor(Number(status.checkedAt || Date.now()))),
  }));
}

export function readRuntimeRecoveryDiscoveryStatus(
  runtimeId: string | null | undefined,
): RuntimeRecoveryDiscoveryStatus | null {
  if (typeof localStorage === 'undefined') return null;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return null;
  const raw = localStorage.getItem(storageKey(normalizedRuntimeId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeRecoveryDiscoveryStatus>;
    if (normalizeRuntimeId(parsed.runtimeId) !== normalizedRuntimeId) return null;
    return {
      runtimeId: normalizedRuntimeId,
      checkedTowers: Math.max(0, Math.floor(Number(parsed.checkedTowers || 0))),
      checkedPeers: Math.max(0, Math.floor(Number(parsed.checkedPeers || 0))),
      peerBackupCount: Math.max(0, Math.floor(Number(parsed.peerBackupCount || 0))),
      backupCount: Math.max(0, Math.floor(Number(parsed.backupCount || 0))),
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map((entry) => String(entry || '')).filter(Boolean)
        : [],
      failures: normalizeFailureStatuses(parsed.failures),
      checkedAt: Math.max(0, Math.floor(Number(parsed.checkedAt || 0))),
    };
  } catch {
    localStorage.removeItem(storageKey(normalizedRuntimeId));
    return null;
  }
}

export function clearRuntimeRecoveryDiscoveryStatus(runtimeId: string | null | undefined): void {
  if (typeof localStorage === 'undefined') return;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  localStorage.removeItem(storageKey(normalizedRuntimeId));
}
