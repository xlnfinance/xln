/**
 * Every switch that changes what an HLT number means travels inside the
 * report. A TPS figure without these is a diagnostic, not a result: the
 * decoder rejects a report that omits them, and readers can tell a
 * production-equivalent run (all WALs on, lanes at nice 0)
 * from an isolated-Hub measurement (lanes niced) at a glance.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';
import { canonicalTsAccountWorkerCount } from '../../../../rscore/ts-worker/provider';

export type HltAccountWorkerEvidence = number | 'unknown';

/**
 * What exactly produced a number: the tree, the engine binary, the parity
 * recording it was gated on, and the stand-lock grant it ran under. Missing
 * pieces are recorded as `unknown`/`null`, never invented.
 */
export type HltRunProvenance = Readonly<{
  gitSha: string;
  /** Modified tracked files at run time; -1 when git was unavailable. */
  gitDirtyFiles: number;
  rustBinarySha256: string | null;
  parityRecordingSha256: string | null;
  standLockToken: string | null;
}>;

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
  provenance?: HltRunProvenance;
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

const gitText = (args: readonly string[]): string | null => {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/** Tracked inputs that can change an HLT runtime, its wire/storage contract or its launcher. */
export const XLN_HLT_PROVENANCE_PATHS = [
  'core', 'rscore', 'jurisdictions', 'brainvault', 'custody', 'native', 'cli',
  'scripts', 'tools', 'packages/npm', 'package.json', 'bun.lock', 'tsconfig.json',
  'tsconfig.runtime.json', 'frozen-core.json', 'VERSION',
] as const;

const xlnTrackedStatus = (): string | null => gitText([
  'status', '--short', '--untracked-files=no', '--', ...XLN_HLT_PROVENANCE_PATHS,
]);

const fileSha256 = (path: string | undefined): string | null => {
  if (!path) return null;
  const resolved = resolve(path);
  if (!existsSync(resolved)) return null;
  return `0x${createHash('sha256').update(readFileSync(resolved)).digest('hex')}`;
};

export const collectHltRunProvenance = (engine: 'ts' | 'rust'): HltRunProvenance => {
  const sha = gitText(['rev-parse', 'HEAD']);
  // This is an inclusion list, not a growing exclusion list. Reference UIs,
  // design assets and external workspaces cannot invalidate an HLT number;
  // every currently direct runtime dependency remains fail-closed here.
  const dirty = xlnTrackedStatus();
  return {
    gitSha: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown',
    gitDirtyFiles: dirty === null ? -1 : dirty.split('\n').filter(line => line.trim()).length,
    rustBinarySha256: engine === 'rust'
      ? fileSha256(process.env['XLN_RSCORE_BINARY'] ?? 'rscore/target/release/xlnrs')
      : null,
    parityRecordingSha256: fileSha256(process.env['XLN_HLT_PARITY_RECORDING']),
    standLockToken: process.env['XLN_STAND_LOCK_TOKEN'] || null,
  };
};

const decodeHltRunProvenance = (value: unknown, code: string): HltRunProvenance => {
  const record = requireBoundaryRecord(value, `${code}_PROVENANCE_INVALID`);
  requireExactBoundaryKeys(record, [
    'gitSha', 'gitDirtyFiles', 'rustBinarySha256', 'parityRecordingSha256', 'standLockToken',
  ], [], `${code}_PROVENANCE_FIELDS_INVALID`);
  const gitSha = record['gitSha'];
  if (typeof gitSha !== 'string' || !(gitSha === 'unknown' || /^[0-9a-f]{40}$/.test(gitSha))) {
    throw new Error(`${code}_PROVENANCE_GIT_SHA_INVALID`);
  }
  const gitDirtyFiles = record['gitDirtyFiles'];
  if (typeof gitDirtyFiles !== 'number' || !Number.isSafeInteger(gitDirtyFiles) || gitDirtyFiles < -1) {
    throw new Error(`${code}_PROVENANCE_GIT_DIRTY_INVALID`);
  }
  const nullableText = (key: string): string | null => {
    const raw = record[key];
    if (raw === null) return null;
    if (typeof raw !== 'string' || raw === '') throw new Error(`${code}_PROVENANCE_${key.toUpperCase()}_INVALID`);
    return raw;
  };
  return {
    gitSha,
    gitDirtyFiles,
    rustBinarySha256: nullableText('rustBinarySha256'),
    parityRecordingSha256: nullableText('parityRecordingSha256'),
    standLockToken: nullableText('standLockToken'),
  };
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
  const engine = selectedEngine(options.engine);
  const accountWorkers = resolveAccountWorkers(engine, options.rustAccountWorkers);
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
    provenance: collectHltRunProvenance(engine),
  };
};

export const decodeHltEnvironmentManifest = (value: unknown, code: string): HltEnvironmentManifest => {
  const record = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(record, [
    'disputeHankos', 'hubWalSync', 'lanePersistence', 'laneWalSync', 'laneNice', 'cryptoPoolWorkers', 'cryptoSignWorkers',
    'accountWorkers',
  ], ['provenance'], `${code}_FIELDS_INVALID`);
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
    ...(record['provenance'] === undefined
      ? {}
      : { provenance: decodeHltRunProvenance(record['provenance'], code) }),
  };
};

/** The measured Hub is production-durable; load users are intentionally RAM-only. */
export const isProductionEquivalentHltEnvironment = (manifest: HltEnvironmentManifest): boolean =>
  manifest.hubWalSync
  && !manifest.lanePersistence
  && !manifest.laneWalSync
  && manifest.laneNice === 0;
