export type RuntimeRecoveryDiscoveryStatus = {
  runtimeId: string;
  checkedTowers: number;
  backupCount: number;
  errors: string[];
  checkedAt: number;
};

const STORAGE_PREFIX = 'xln-runtime-recovery-discovery:';

const normalizeRuntimeId = (value: string | null | undefined): string =>
  String(value || '').trim().toLowerCase();

const storageKey = (runtimeId: string): string =>
  `${STORAGE_PREFIX}${normalizeRuntimeId(runtimeId)}`;

export function writeRuntimeRecoveryDiscoveryStatus(status: RuntimeRecoveryDiscoveryStatus): void {
  if (typeof localStorage === 'undefined') return;
  const runtimeId = normalizeRuntimeId(status.runtimeId);
  if (!runtimeId) return;
  localStorage.setItem(storageKey(runtimeId), JSON.stringify({
    runtimeId,
    checkedTowers: Math.max(0, Math.floor(Number(status.checkedTowers || 0))),
    backupCount: Math.max(0, Math.floor(Number(status.backupCount || 0))),
    errors: status.errors.map((entry) => String(entry || '')).filter(Boolean),
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
      backupCount: Math.max(0, Math.floor(Number(parsed.backupCount || 0))),
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map((entry) => String(entry || '')).filter(Boolean)
        : [],
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
