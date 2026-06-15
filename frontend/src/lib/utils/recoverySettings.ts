import {
  resolveDefaultRecoveryTowerUrls,
  type RecoveryTowerConfig,
} from '$lib/stores/vaultStore';

export type RecoveryServiceMode = 'blind_backup' | 'delayed_last_resort';

export function resolveOfficialRecoveryTowerUrl(): string | null {
  if (typeof window === 'undefined') return 'https://xln.finance';
  const w = window as Window & { __XLN_WATCHTOWERS__?: unknown };
  let localUrls: string | null = null;
  try {
    localUrls = localStorage.getItem('xln-watchtower-urls');
  } catch {
    localUrls = null;
  }
  return resolveDefaultRecoveryTowerUrls({
    hostname: window.location.hostname,
    globalUrls: w.__XLN_WATCHTOWERS__,
    localUrls,
    envUrls: import.meta.env?.['VITE_XLN_WATCHTOWER_URL'],
  })[0] || null;
}

export function normalizeRecoveryUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Service URL is required');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Service URL must start with http:// or https://');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function normalizeTowerMode(mode: unknown): RecoveryServiceMode {
  return mode === 'delayed_last_resort' ? 'delayed_last_resort' : 'blind_backup';
}

export function normalizeRecoveryDraft(towers: RecoveryTowerConfig[] | undefined): RecoveryTowerConfig[] {
  const deduped = new Map<string, RecoveryTowerConfig>();
  for (const tower of towers || []) {
    try {
      const url = normalizeRecoveryUrl(tower.url);
      if (tower.enabled === false) continue;
      deduped.set(url, {
        ...tower,
        id: tower.id || `manual-${deduped.size + 1}`,
        url,
        towerMode: normalizeTowerMode(tower.towerMode),
        enabled: true,
      });
    } catch {
      // Ignore malformed persisted service URLs in UI drafts.
    }
  }
  return [...deduped.values()];
}

export function isOfficialRecoveryTower(tower: RecoveryTowerConfig, officialUrl: string | null): boolean {
  if (!officialUrl) return false;
  try {
    return normalizeRecoveryUrl(tower.url) === normalizeRecoveryUrl(officialUrl);
  } catch {
    return false;
  }
}

export function getManualRecoveryTowers(
  towers: RecoveryTowerConfig[],
  officialUrl: string | null,
): RecoveryTowerConfig[] {
  return normalizeRecoveryDraft(towers).filter((tower) => !isOfficialRecoveryTower(tower, officialUrl));
}
