import type { RecoveryTowerConfig, Runtime } from '../stores/vaultStore';

export type RecoveryCoverageStatus = 'ready' | 'configured' | 'missing';

export type RecoveryCoverageItem = {
  id: 'local_state' | 'tower_backup' | 'last_resort' | 'peer_refresh';
  label: string;
  status: RecoveryCoverageStatus;
  statusLabel: string;
  detail: string;
};

type RecoveryCoverageInput = {
  runtime: Runtime | null | undefined;
  towers?: RecoveryTowerConfig[];
  runtimeHeight?: number | null | undefined;
};

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

const positiveInt = (value: unknown): number => {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeMode = (mode: unknown): 'blind_backup' | 'delayed_last_resort' =>
  mode === 'delayed_last_resort' ? 'delayed_last_resort' : 'blind_backup';

export const formatRecoveryBytes = (bytes: unknown): string => {
  const value = positiveInt(bytes);
  if (value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

export const normalizeRecoveryCoverageTowers = (towers: RecoveryTowerConfig[] | undefined): RecoveryTowerConfig[] => {
  const deduped = new Map<string, RecoveryTowerConfig>();
  for (const tower of towers || []) {
    const url = String(tower.url || '').trim().replace(/\/+$/, '');
    if (!url || tower.enabled === false) continue;
    deduped.set(url, {
      ...tower,
      url,
      towerMode: normalizeMode(tower.towerMode),
      enabled: true,
    });
  }
  return [...deduped.values()];
};

export function buildRuntimeRecoveryCoverage(input: RecoveryCoverageInput): RecoveryCoverageItem[] {
  const runtime = input.runtime || null;
  const towers = normalizeRecoveryCoverageTowers(input.towers ?? runtime?.recovery?.towers);
  const backupTowerCount = towers.length;
  const lastResortTowerCount = towers.filter((tower) => normalizeMode(tower.towerMode) === 'delayed_last_resort').length;
  const observedBytes = positiveInt(runtime?.recovery?.lastKnownStoredBytes);
  const runtimeHeight = positiveInt(input.runtimeHeight);
  const quotaWarning = positiveInt(runtime?.recovery?.lastQuotaWarningAt) > 0;

  return [
    {
      id: 'local_state',
      label: 'Local state',
      status: runtime?.id ? 'ready' : 'missing',
      statusLabel: runtime?.id ? 'Available' : 'Missing',
      detail: runtime?.id
        ? runtimeHeight > 0
          ? `Browser runtime at h${runtimeHeight.toLocaleString('en-US')}`
          : 'Browser runtime selected'
        : 'Select or restore a runtime',
    },
    {
      id: 'tower_backup',
      label: 'Tower backup',
      status: backupTowerCount === 0 ? 'missing' : observedBytes > 0 ? 'ready' : 'configured',
      statusLabel: backupTowerCount === 0 ? 'Off' : observedBytes > 0 ? 'Receipt observed' : 'Configured',
      detail: backupTowerCount === 0
        ? 'No remote backup service'
        : observedBytes > 0
          ? `${plural(backupTowerCount, 'service', 'services')} · ${formatRecoveryBytes(observedBytes)} stored`
          : `${plural(backupTowerCount, 'service', 'services')} waiting for first upload`,
    },
    {
      id: 'last_resort',
      label: 'Last resort',
      status: lastResortTowerCount === 0 ? 'missing' : observedBytes > 0 ? 'ready' : 'configured',
      statusLabel: lastResortTowerCount === 0 ? 'Off' : observedBytes > 0 ? 'Receipt observed' : 'Configured',
      detail: lastResortTowerCount === 0
        ? 'No delayed dispute service'
        : quotaWarning
          ? `${plural(lastResortTowerCount, 'disputer', 'disputers')} configured · quota warning`
          : `${plural(lastResortTowerCount, 'disputer', 'disputers')} configured`,
    },
    {
      id: 'peer_refresh',
      label: 'Peer refresh',
      status: 'missing',
      statusLabel: 'Not available',
      detail: 'Restore currently depends on local state or tower backup',
    },
  ];
}
