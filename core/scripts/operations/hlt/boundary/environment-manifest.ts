/**
 * Every switch that changes what an HLT number means travels inside the
 * report. A TPS figure without these is a diagnostic, not a result: the
 * decoder rejects a report that omits them, and readers can tell a
 * production-equivalent run (history on, hub WAL fsync on, lanes at nice 0)
 * from an isolated-Hub measurement (lanes niced) at a glance.
 */
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';

export type HltEnvironmentManifest = Readonly<{
  /** Account dispute seals are unconditional consensus; recorded so a reader never has to wonder. */
  disputeSeals: 'always';
  certifiedHistory: boolean;
  hubWalSync: boolean;
  laneWalSync: boolean;
  /** `nice` applied to lane (user Runtime) processes; 0 = full contention on one box. */
  laneNice: number;
  cryptoPoolWorkers: number | 'default';
  cryptoSignWorkers: number | 'default';
}>;

const flagOn = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off';
};

const workerCount = (name: string): number | 'default' => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 'default';
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`HLT_ENV_MANIFEST_WORKERS_INVALID:${name}:${raw}`);
  return parsed;
};

export const collectHltEnvironmentManifest = (): HltEnvironmentManifest => {
  const laneNiceRaw = process.env['XLN_HLT_LANE_NICE'];
  const laneNice = laneNiceRaw === undefined || laneNiceRaw === '' ? 0 : Number(laneNiceRaw);
  if (!Number.isSafeInteger(laneNice) || laneNice < 0 || laneNice > 20) {
    throw new Error(`HLT_ENV_MANIFEST_LANE_NICE_INVALID:${String(laneNiceRaw)}`);
  }
  return {
    disputeSeals: 'always',
    certifiedHistory: flagOn('XLN_STORAGE_CERTIFIED_HISTORY', true),
    hubWalSync: flagOn('XLN_STORAGE_WAL_SYNC', true),
    laneWalSync: process.env['XLN_HLT_LANE_WAL_SYNC'] === undefined
      ? flagOn('XLN_STORAGE_WAL_SYNC', true)
      : flagOn('XLN_HLT_LANE_WAL_SYNC', true),
    laneNice,
    cryptoPoolWorkers: workerCount('XLN_CRYPTO_POOL_WORKERS'),
    cryptoSignWorkers: workerCount('XLN_CRYPTO_SIGN_WORKERS'),
  };
};

export const decodeHltEnvironmentManifest = (value: unknown, code: string): HltEnvironmentManifest => {
  const record = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(record, [
    'disputeSeals', 'certifiedHistory', 'hubWalSync', 'laneWalSync', 'laneNice', 'cryptoPoolWorkers', 'cryptoSignWorkers',
  ], [], `${code}_FIELDS_INVALID`);
  if (record['disputeSeals'] !== 'always') throw new Error(`${code}_DISPUTE_SEALS_INVALID`);
  const bool = (key: string): boolean => {
    const raw = record[key];
    if (typeof raw !== 'boolean') throw new Error(`${code}_${key.toUpperCase()}_INVALID`);
    return raw;
  };
  const workers = (key: string): number | 'default' => {
    const raw = record[key];
    if (raw === 'default') return raw;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error(`${code}_${key.toUpperCase()}_INVALID`);
    return raw;
  };
  const laneNice = record['laneNice'];
  if (typeof laneNice !== 'number' || !Number.isSafeInteger(laneNice) || laneNice < 0 || laneNice > 20) {
    throw new Error(`${code}_LANE_NICE_INVALID`);
  }
  return {
    disputeSeals: 'always',
    certifiedHistory: bool('certifiedHistory'),
    hubWalSync: bool('hubWalSync'),
    laneWalSync: bool('laneWalSync'),
    laneNice,
    cryptoPoolWorkers: workers('cryptoPoolWorkers'),
    cryptoSignWorkers: workers('cryptoSignWorkers'),
  };
};

/** Production-equivalent means nothing that trades durability or isolation for speed was switched on. */
export const isProductionEquivalentHltEnvironment = (manifest: HltEnvironmentManifest): boolean =>
  manifest.certifiedHistory && manifest.hubWalSync && manifest.laneWalSync && manifest.laneNice === 0;
