/**
 * Every switch that changes what an HLT number means travels inside the
 * report. A TPS figure without these is a diagnostic, not a result: the
 * decoder rejects a report that omits them, and readers can tell a
 * production-equivalent run (all WALs on, lanes at nice 0)
 * from an isolated-Hub measurement (lanes niced) at a glance.
 */
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';
import { canonicalTsAccountWorkerCount } from '../../../../rscore/ts-worker/provider';

export type HltAccountWorkerEvidence = number | 'unknown';

export type HltEnvironmentManifest = Readonly<{
  /** Account dispute Hankos are unconditional consensus; recorded so a reader never has to wonder. */
  disputeHankos: 'always';
  hubWalSync: boolean;
  /** Sovereign load-user Runtime frames are intentionally RAM-only. */
  lanePersistence: boolean;
  laneWalSync: boolean;
  /** `nice` applied to lane (user Runtime) processes; 0 = full contention on one box. */
  laneNice: number;
  cryptoPoolWorkers: number | 'default';
  cryptoSignWorkers: number | 'default';
  /** Active Account transition workers on the selected H1 engine. */
  accountWorkers: HltAccountWorkerEvidence;
}>;

type HltEnvironmentManifestOptions = Readonly<{
  engine?: 'ts' | 'rust';
  rustAccountWorkers?: number;
  requireAccountWorkers?: boolean;
}>;

const flagOn = (name: string, whenUnset: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return whenUnset;
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off';
};

const workerCount = (name: string): number | 'default' => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 'default';
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`HLT_ENV_MANIFEST_WORKERS_INVALID:${name}:${raw}`);
  return parsed;
};

const selectedEngine = (engine: HltEnvironmentManifestOptions['engine']): 'ts' | 'rust' => {
  const selected = engine ?? process.env['XLN_HLT_ENGINE'] ?? 'ts';
  if (selected !== 'ts' && selected !== 'rust') throw new Error(`HLT_ENV_MANIFEST_ENGINE_INVALID:${selected}`);
  return selected;
};

const resolveAccountWorkers = (
  engine: 'ts' | 'rust',
  rustAccountWorkers: number | undefined,
): HltAccountWorkerEvidence => {
  if (engine === 'ts') {
    const configured = process.env['XLN_TS_ACCOUNT_WORKERS'];
    if (configured !== undefined && configured !== '') {
      const parsed = Number(configured);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) return 'unknown';
    }
    return canonicalTsAccountWorkerCount();
  }
  if (rustAccountWorkers !== undefined) {
    return Number.isSafeInteger(rustAccountWorkers) && rustAccountWorkers >= 1
      ? rustAccountWorkers
      : 'unknown';
  }
  const configured = process.env['XLN_RSCORE_AUTHORITY_WORKERS'];
  if (configured === undefined || configured === '') return 'unknown';
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 'unknown';
};

export const requireHltAccountWorkerEvidence = (
  workers: HltAccountWorkerEvidence,
  code: string,
): number => {
  if (typeof workers !== 'number' || !Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`${code}_ACCOUNT_WORKERS_UNKNOWN`);
  }
  return workers;
};

export const collectHltEnvironmentManifest = (
  options: HltEnvironmentManifestOptions = {},
): HltEnvironmentManifest => {
  const laneNiceRaw = process.env['XLN_HLT_LANE_NICE'];
  const laneNice = laneNiceRaw === undefined || laneNiceRaw === '' ? 0 : Number(laneNiceRaw);
  if (!Number.isSafeInteger(laneNice) || laneNice < 0 || laneNice > 20) {
    throw new Error(`HLT_ENV_MANIFEST_LANE_NICE_INVALID:${String(laneNiceRaw)}`);
  }
  const accountWorkers = resolveAccountWorkers(selectedEngine(options.engine), options.rustAccountWorkers);
  if (options.requireAccountWorkers) {
    requireHltAccountWorkerEvidence(accountWorkers, 'HLT_ENV_MANIFEST');
  }
  return {
    disputeHankos: 'always',
    hubWalSync: flagOn('XLN_STORAGE_WAL_SYNC', true),
    lanePersistence: false,
    laneWalSync: false,
    laneNice,
    cryptoPoolWorkers: workerCount('XLN_CRYPTO_POOL_WORKERS'),
    cryptoSignWorkers: workerCount('XLN_CRYPTO_SIGN_WORKERS'),
    accountWorkers,
  };
};

export const decodeHltEnvironmentManifest = (value: unknown, code: string): HltEnvironmentManifest => {
  const record = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(record, [
    'disputeHankos', 'hubWalSync', 'lanePersistence', 'laneWalSync', 'laneNice', 'cryptoPoolWorkers', 'cryptoSignWorkers',
    'accountWorkers',
  ], [], `${code}_FIELDS_INVALID`);
  if (record['disputeHankos'] !== 'always') throw new Error(`${code}_DISPUTE_HANKOS_INVALID`);
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
  const accountWorkersRaw = record['accountWorkers'];
  if (
    accountWorkersRaw !== 'unknown' &&
    (typeof accountWorkersRaw !== 'number' || !Number.isSafeInteger(accountWorkersRaw) || accountWorkersRaw < 1)
  ) throw new Error(`${code}_ACCOUNT_WORKERS_INVALID`);
  const accountWorkers: HltAccountWorkerEvidence = accountWorkersRaw;
  return {
    disputeHankos: 'always',
    hubWalSync: bool('hubWalSync'),
    lanePersistence: bool('lanePersistence'),
    laneWalSync: bool('laneWalSync'),
    laneNice,
    cryptoPoolWorkers: workers('cryptoPoolWorkers'),
    cryptoSignWorkers: workers('cryptoSignWorkers'),
    accountWorkers,
  };
};

/** The measured Hub is production-durable; load users are intentionally RAM-only. */
export const isProductionEquivalentHltEnvironment = (manifest: HltEnvironmentManifest): boolean =>
  manifest.hubWalSync
  && !manifest.lanePersistence
  && !manifest.laneWalSync
  && manifest.laneNice === 0;
