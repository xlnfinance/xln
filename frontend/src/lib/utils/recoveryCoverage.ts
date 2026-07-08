import type { RecoveryTowerConfig, Runtime } from '../stores/vaultStore';

export type RecoveryCoverageStatus = 'ready' | 'configured' | 'missing';
export type RecoveryTowerStatusKind = 'receipt' | 'failure' | 'pending';

export type RecoveryCoverageItem = {
  id: 'local_state' | 'tower_backup' | 'last_resort' | 'peer_refresh';
  label: string;
  status: RecoveryCoverageStatus;
  statusLabel: string;
  detail: string;
};

export type RecoveryTowerStatusItem = {
  url: string;
  status: RecoveryTowerStatusKind;
  label: string;
  detail: string;
};

type RecoveryDiscoveryFailureInput = {
  source?: 'tower' | 'peer' | string;
  sourceLabel?: string;
  category?: 'ExpectedEmpty' | 'TransientRace' | 'Contradiction' | string;
  code?: string;
  message?: string;
};

type RecoveryCoverageInput = {
  runtime: Runtime | null | undefined;
  towers?: RecoveryTowerConfig[];
  runtimeHeight?: number | null | undefined;
  peerSourceCount?: number | null | undefined;
  discovery?: {
    checkedPeers?: number | null | undefined;
    peerBackupCount?: number | null | undefined;
    failures?: RecoveryDiscoveryFailureInput[] | null | undefined;
  } | null | undefined;
};

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

const positiveInt = (value: unknown): number => {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeMode = (mode: unknown): 'blind_backup' | 'delayed_last_resort' =>
  mode === 'delayed_last_resort' ? 'delayed_last_resort' : 'blind_backup';

const normalizeUrl = (value: unknown): string => String(value || '').trim().replace(/\/+$/, '');

const latestPeerFailure = (
  failures: RecoveryDiscoveryFailureInput[] | null | undefined,
): RecoveryDiscoveryFailureInput | null => (
  Array.isArray(failures)
    ? [...failures].reverse().find((failure) => failure?.source === 'peer') ?? null
    : null
);

const peerFailureLabel = (failure: RecoveryDiscoveryFailureInput | null): string => {
  if (!failure) return '';
  const code = String(failure.code || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
  if (failure.category === 'ExpectedEmpty') return `no peer backup found (${code})`;
  if (failure.category === 'TransientRace') return `peer refresh retry pending (${code})`;
  return `peer refresh failed (${code})`;
};

const newestFirst = <T extends { receivedAt?: number; checkedAt?: number; height?: number; sequence?: number }>(
  left: T,
  right: T,
): number => (
  positiveInt(right.receivedAt ?? right.checkedAt) - positiveInt(left.receivedAt ?? left.checkedAt) ||
  positiveInt(right.height) - positiveInt(left.height) ||
  positiveInt(right.sequence) - positiveInt(left.sequence)
);

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
    const url = normalizeUrl(tower.url);
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
  const towerUrls = new Set(towers.map((tower) => tower.url));
  const receipts = (runtime?.recovery?.lastTowerReceipts || [])
    .filter((receipt) => towerUrls.has(normalizeUrl(receipt.towerUrl)));
  const backupReceipts = receipts.filter((receipt) => normalizeMode(receipt.towerMode) === 'blind_backup');
  const lastResortReceipts = receipts.filter((receipt) => normalizeMode(receipt.towerMode) === 'delayed_last_resort');
  const backupTowerCount = towers.length;
  const lastResortTowerCount = towers.filter((tower) => normalizeMode(tower.towerMode) === 'delayed_last_resort').length;
  const receiptStoredBytes = Math.max(0, ...receipts.map((receipt) => positiveInt(receipt.storedBytes)));
  const observedBytes = Math.max(positiveInt(runtime?.recovery?.lastKnownStoredBytes), receiptStoredBytes);
  const runtimeHeight = positiveInt(input.runtimeHeight);
  const quotaWarning = positiveInt(runtime?.recovery?.lastQuotaWarningAt) > 0;
  const latestBackupHeight = Math.max(0, ...backupReceipts.map((receipt) => positiveInt(receipt.height)));
  const latestLastResortHeight = Math.max(0, ...lastResortReceipts.map((receipt) => positiveInt(receipt.height)));
  const peerSourceCount = positiveInt(input.peerSourceCount);
  const checkedPeerCount = positiveInt(input.discovery?.checkedPeers);
  const peerBackupCount = positiveInt(input.discovery?.peerBackupCount);
  const peerFailure = latestPeerFailure(input.discovery?.failures);
  const peerFailureText = peerFailureLabel(peerFailure);
  const effectivePeerCount = Math.max(peerSourceCount, checkedPeerCount);
  const peerRefreshStatus: RecoveryCoverageStatus =
    peerBackupCount > 0 ? 'ready' : effectivePeerCount > 0 ? 'configured' : 'missing';
  const peerRefreshStatusLabel =
    peerBackupCount > 0
      ? 'Backup observed'
      : peerFailure?.category === 'Contradiction'
        ? 'Check failed'
        : peerFailure?.category === 'TransientRace'
          ? 'Retry pending'
          : peerFailure?.category === 'ExpectedEmpty'
            ? 'No backup'
            : effectivePeerCount > 0
              ? 'Configured'
              : 'Not available';
  const peerRefreshDetail = peerBackupCount > 0
    ? `${plural(peerBackupCount, 'peer backup', 'peer backups')} from ${plural(checkedPeerCount || effectivePeerCount, 'remote runtime', 'remote runtimes')}`
    : checkedPeerCount > 0 && peerFailureText
      ? `${plural(checkedPeerCount, 'remote runtime', 'remote runtimes')} checked · ${peerFailureText}`
    : effectivePeerCount > 0
      ? `${plural(effectivePeerCount, 'saved remote runtime', 'saved remote runtimes')} available for restore checks`
      : 'Restore currently depends on local state or tower backup';

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
      status: backupTowerCount === 0 ? 'missing' : backupReceipts.length > 0 || observedBytes > 0 ? 'ready' : 'configured',
      statusLabel: backupTowerCount === 0 ? 'Off' : backupReceipts.length > 0 ? 'Receipt observed' : observedBytes > 0 ? 'Upload observed' : 'Configured',
      detail: backupTowerCount === 0
        ? 'No remote backup service'
        : backupReceipts.length > 0
          ? `${plural(backupReceipts.length, 'receipt', 'receipts')} · h${latestBackupHeight.toLocaleString('en-US')} · ${formatRecoveryBytes(observedBytes)} stored`
          : observedBytes > 0
            ? `${plural(backupTowerCount, 'service', 'services')} · ${formatRecoveryBytes(observedBytes)} stored`
          : `${plural(backupTowerCount, 'service', 'services')} waiting for first upload`,
    },
    {
      id: 'last_resort',
      label: 'Last resort',
      status: lastResortTowerCount === 0 ? 'missing' : lastResortReceipts.length > 0 ? 'ready' : 'configured',
      statusLabel: lastResortTowerCount === 0 ? 'Off' : lastResortReceipts.length > 0 ? 'Receipt observed' : 'Configured',
      detail: lastResortTowerCount === 0
        ? 'No delayed dispute service'
        : lastResortReceipts.length > 0
          ? `${plural(lastResortReceipts.length, 'receipt', 'receipts')} · h${latestLastResortHeight.toLocaleString('en-US')}`
        : quotaWarning
          ? `${plural(lastResortTowerCount, 'disputer', 'disputers')} configured · quota warning`
          : `${plural(lastResortTowerCount, 'disputer', 'disputers')} configured`,
    },
    {
      id: 'peer_refresh',
      label: 'Peer refresh',
      status: peerRefreshStatus,
      statusLabel: peerRefreshStatusLabel,
      detail: peerRefreshDetail,
    },
  ];
}

export function buildRecoveryTowerStatuses(
  runtime: Runtime | null | undefined,
  towers: RecoveryTowerConfig[] | undefined,
): RecoveryTowerStatusItem[] {
  const receipts = runtime?.recovery?.lastTowerReceipts || [];
  const failures = runtime?.recovery?.lastTowerFailures || [];
  return normalizeRecoveryCoverageTowers(towers).map((tower) => {
    const url = normalizeUrl(tower.url);
    const latestReceipt = receipts
      .filter((receipt) => normalizeUrl(receipt.towerUrl) === url)
      .sort(newestFirst)[0] || null;
    const latestFailure = failures
      .filter((failure) => normalizeUrl(failure.towerUrl) === url)
      .sort(newestFirst)[0] || null;
    const receiptAt = positiveInt(latestReceipt?.receivedAt);
    const failureAt = positiveInt(latestFailure?.checkedAt);
    if (latestFailure && failureAt >= receiptAt) {
      return {
        url,
        status: 'failure',
        label: 'Last upload failed',
        detail: latestFailure.error,
      };
    }
    if (latestReceipt) {
      const storedBytes = positiveInt(latestReceipt.storedBytes);
      return {
        url,
        status: 'receipt',
        label: 'Receipt observed',
        detail: [
          `h${positiveInt(latestReceipt.height).toLocaleString('en-US')}`,
          `seq ${positiveInt(latestReceipt.sequence).toLocaleString('en-US')}`,
          storedBytes > 0 ? formatRecoveryBytes(storedBytes) : '',
        ].filter(Boolean).join(' · '),
      };
    }
    return {
      url,
      status: 'pending',
      label: 'Awaiting upload',
      detail: 'No tower receipt stored yet',
    };
  });
}
