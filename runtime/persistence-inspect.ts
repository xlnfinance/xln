import { readFileSync } from 'node:fs';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  deriveRuntimeRecoveryLookupKey,
  getPersistedLatestHeight,
  inspectStorageDb,
  listPersistedCheckpointHeights,
  readPersistedFrameJournals,
  validateRuntimeRecoveryBundle,
  verifyRuntimeChain,
} from './runtime';
import { deserializeTaggedJson } from './serialization-utils';
import type { Env } from './types';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoveryBundleV1,
  TowerReceiptV1,
} from './recovery/types';

export type PersistenceIssueSeverity = 'info' | 'warning' | 'critical';

export type PersistenceIssue = {
  severity: PersistenceIssueSeverity;
  code: string;
  message: string;
};

export type PersistenceWalTailSummary = {
  fromHeight: number;
  toHeight: number;
  presentCount: number;
  missingHeights: number[];
  lastFrameLogCount: number;
};

export type PersistenceBundleSummary = {
  checked: boolean;
  valid: boolean;
  encrypted: boolean;
  runtimeId?: string;
  height?: number;
  checkpointHash?: string;
  bundleHash?: string;
  error?: string;
};

export type PersistenceTowerSummary = {
  checked: boolean;
  ok: boolean;
  url?: string;
  lookupKey?: string;
  receipt?: TowerReceiptV1;
  error?: string;
};

export type PersistenceInspectionSummary = {
  runtimeId: string;
  dbNamespace: string;
  latestHeight: number;
  checkpointHeights: number[];
  storage: Awaited<ReturnType<typeof inspectStorageDb>>;
  walTail: PersistenceWalTailSummary;
  bundle: PersistenceBundleSummary;
  tower: PersistenceTowerSummary;
  verification?: Awaited<ReturnType<typeof verifyRuntimeChain>>;
  status: 'ok' | 'warning' | 'critical';
  issues: PersistenceIssue[];
  repairPlan: string[];
};

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const severityRank = (severity: PersistenceIssueSeverity): number =>
  severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;

const statusFor = (issues: PersistenceIssue[]): PersistenceInspectionSummary['status'] => {
  const max = issues.reduce((rank, issue) => Math.max(rank, severityRank(issue.severity)), 0);
  return max >= 2 ? 'critical' : max >= 1 ? 'warning' : 'ok';
};

export const repairPlanFor = (issues: PersistenceIssue[]): string[] => {
  const plan = new Set<string>();
  for (const issue of issues) {
    if (issue.code === 'PERSISTENCE_EMPTY') {
      plan.add('No local persisted runtime was found. Restore from a recovery bundle, tower, or trusted peer before using the runtime.');
    }
    if (issue.code === 'WAL_TAIL_MISSING') {
      plan.add('Do not advance or rewrite local WAL. Restore missing frames from a trusted backup/peer, then rerun inspect with --verify.');
    }
    if (issue.code === 'VERIFY_FAILED') {
      plan.add('Treat the local store as corrupt. Stop the runtime and restore from the latest valid checkpoint/tower backup.');
    }
    if (issue.code === 'BUNDLE_MISSING' || issue.code === 'BUNDLE_STALE' || issue.code === 'BUNDLE_INVALID') {
      plan.add('Create and upload a fresh recovery bundle after the runtime reaches a stable frame.');
    }
    if (issue.code === 'TOWER_MISSING' || issue.code === 'TOWER_STALE' || issue.code === 'TOWER_UNAVAILABLE') {
      plan.add('Re-upload the latest recovery bundle to the configured watchtower and confirm a fresh tower receipt.');
    }
  }
  return Array.from(plan);
};

export const buildPersistenceIssues = (input: {
  latestHeight: number;
  checkpointHeights: number[];
  walTail: PersistenceWalTailSummary;
  bundle: PersistenceBundleSummary;
  tower: PersistenceTowerSummary;
  verification?: Awaited<ReturnType<typeof verifyRuntimeChain>>;
}): PersistenceIssue[] => {
  const issues: PersistenceIssue[] = [];
  if (input.latestHeight <= 0) {
    issues.push({
      severity: 'critical',
      code: 'PERSISTENCE_EMPTY',
      message: 'No persisted runtime frames were found.',
    });
  }
  if (input.latestHeight > 0 && input.checkpointHeights.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'CHECKPOINT_MISSING',
      message: 'Persisted frames exist but no checkpoint snapshot was found.',
    });
  }
  if (input.walTail.missingHeights.length > 0) {
    issues.push({
      severity: 'critical',
      code: 'WAL_TAIL_MISSING',
      message: `Missing persisted frame journals in tail: ${input.walTail.missingHeights.join(',')}.`,
    });
  }
  if (input.verification && !input.verification.ok) {
    issues.push({
      severity: 'critical',
      code: 'VERIFY_FAILED',
      message: `Replay verification failed at height ${input.verification.restoredHeight}.`,
    });
  }
  if (input.bundle.checked) {
    if (!input.bundle.valid) {
      issues.push({
        severity: 'critical',
        code: 'BUNDLE_INVALID',
        message: input.bundle.error || 'Recovery bundle is invalid.',
      });
    } else if (Number(input.bundle.height || 0) < input.latestHeight) {
      issues.push({
        severity: 'warning',
        code: 'BUNDLE_STALE',
        message: `Recovery bundle height ${Number(input.bundle.height || 0)} is behind latest ${input.latestHeight}.`,
      });
    }
  } else {
    issues.push({
      severity: 'info',
      code: 'BUNDLE_MISSING',
      message: 'Recovery bundle was not checked. Pass --bundle to validate recovery coverage.',
    });
  }
  if (input.tower.checked) {
    if (!input.tower.ok || !input.tower.receipt) {
      issues.push({
        severity: 'warning',
        code: 'TOWER_UNAVAILABLE',
        message: input.tower.error || 'Tower receipt is unavailable.',
      });
    } else if (Number(input.tower.receipt.height || 0) < input.latestHeight) {
      issues.push({
        severity: 'warning',
        code: 'TOWER_STALE',
        message: `Tower receipt height ${Number(input.tower.receipt.height || 0)} is behind latest ${input.latestHeight}.`,
      });
    }
  } else {
    issues.push({
      severity: 'info',
      code: 'TOWER_MISSING',
      message: 'Tower receipt was not checked. Pass --tower-url and --lookup-key, or --runtime-seed to derive the lookup key.',
    });
  }
  return issues;
};

const buildWalTail = async (env: Env, latestHeight: number, tail: number): Promise<PersistenceWalTailSummary> => {
  const toHeight = Math.max(0, latestHeight);
  const fromHeight = toHeight > 0 ? Math.max(1, toHeight - Math.max(1, tail) + 1) : 0;
  if (fromHeight <= 0 || toHeight <= 0) {
    return { fromHeight: 0, toHeight: 0, presentCount: 0, missingHeights: [], lastFrameLogCount: 0 };
  }
  const journals = await readPersistedFrameJournals(env, {
    fromHeight,
    toHeight,
    limit: Math.max(1, tail),
  });
  const present = new Set(journals.map((entry) => entry.height));
  const missingHeights: number[] = [];
  for (let height = fromHeight; height <= toHeight; height += 1) {
    if (!present.has(height)) missingHeights.push(height);
  }
  return {
    fromHeight,
    toHeight,
    presentCount: journals.length,
    missingHeights,
    lastFrameLogCount: journals.at(-1)?.logs?.length ?? 0,
  };
};

const parseBundleFile = (path: string): unknown => {
  const raw = readFileSync(path, 'utf8');
  try {
    return deserializeTaggedJson<unknown>(raw);
  } catch {
    return JSON.parse(raw);
  }
};

export const inspectRecoveryBundleFile = (path?: string): PersistenceBundleSummary => {
  if (!path) return { checked: false, valid: false, encrypted: false };
  try {
    const parsed = parseBundleFile(path) as Partial<RuntimeRecoveryBundleV1 & EncryptedRuntimeRecoveryBundleV1>;
    if (parsed && typeof parsed === 'object' && typeof parsed.checkpointHash === 'string') {
      const bundle = validateRuntimeRecoveryBundle(parsed as RuntimeRecoveryBundleV1);
      return {
        checked: true,
        valid: true,
        encrypted: false,
        runtimeId: bundle.runtimeId,
        height: bundle.runtimeHeight,
        checkpointHash: bundle.checkpointHash,
      };
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.bundleHash === 'string' && typeof parsed.ciphertext === 'string') {
      return {
        checked: true,
        valid: true,
        encrypted: true,
        runtimeId: String(parsed.runtimeId || '').toLowerCase(),
        height: Math.max(0, Math.floor(Number(parsed.height || 0))),
        bundleHash: String(parsed.bundleHash || ''),
      };
    }
    return { checked: true, valid: false, encrypted: false, error: 'RECOVERY_BUNDLE_FORMAT_UNKNOWN' };
  } catch (error) {
    return { checked: true, valid: false, encrypted: false, error: messageOf(error) };
  }
};

export const inspectTowerReceipt = async (
  towerUrl?: string,
  lookupKey?: string,
): Promise<PersistenceTowerSummary> => {
  const normalizedUrl = String(towerUrl || '').trim();
  const normalizedLookupKey = String(lookupKey || '').trim().toLowerCase();
  if (!normalizedUrl || !normalizedLookupKey) {
    return { checked: false, ok: false };
  }
  try {
    const endpoint = new URL(`/api/tower/receipt/${encodeURIComponent(normalizedLookupKey)}`, normalizedUrl);
    const response = await fetch(endpoint);
    const payload = await response.json().catch(() => null) as { ok?: boolean; receipt?: TowerReceiptV1; error?: string } | null;
    if (!response.ok || !payload?.ok || !payload.receipt) {
      return {
        checked: true,
        ok: false,
        url: normalizedUrl,
        lookupKey: normalizedLookupKey,
        error: payload?.error || `HTTP_${response.status}`,
      };
    }
    return {
      checked: true,
      ok: true,
      url: normalizedUrl,
      lookupKey: normalizedLookupKey,
      receipt: payload.receipt,
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      url: normalizedUrl,
      lookupKey: normalizedLookupKey,
      error: messageOf(error),
    };
  }
};

export const buildPersistenceInspection = async (options: {
  runtimeId?: string;
  runtimeSeed?: string;
  tail?: number;
  verify?: boolean;
  bundlePath?: string;
  towerUrl?: string;
  lookupKey?: string;
}): Promise<PersistenceInspectionSummary> => {
  const env = createEmptyEnv(options.runtimeSeed ?? null);
  if (options.runtimeId) {
    env.runtimeId = options.runtimeId.toLowerCase();
    env.dbNamespace = env.runtimeId;
  }
  const runtimeId = String(env.runtimeId || '').toLowerCase();
  if (!runtimeId) throw new Error('PERSISTENCE_INSPECT_RUNTIME_ID_REQUIRED');

  try {
    const [storage, checkpointHeights] = await Promise.all([
      inspectStorageDb(env),
      listPersistedCheckpointHeights(env),
    ]);
    const latestHeight = Math.max(
      0,
      Math.floor(Number(await getPersistedLatestHeight(env).catch(() => storage?.head?.latestHeight ?? 0))),
    );
    const walTail = await buildWalTail(env, latestHeight, Math.max(1, Math.floor(Number(options.tail || 32))));
    const bundle = inspectRecoveryBundleFile(options.bundlePath);
    const derivedLookupKey =
      options.lookupKey
      || (options.runtimeSeed ? deriveRuntimeRecoveryLookupKey(runtimeId, options.runtimeSeed) : '');
    const tower = await inspectTowerReceipt(options.towerUrl, derivedLookupKey);
    const verification = options.verify
      ? await verifyRuntimeChain(runtimeId, options.runtimeSeed ?? null, {
          fromSnapshotHeight: checkpointHeights.at(-1) || 1,
        })
      : undefined;
    const issues = buildPersistenceIssues({
      latestHeight,
      checkpointHeights,
      walTail,
      bundle,
      tower,
      ...(verification ? { verification } : {}),
    });
    return {
      runtimeId,
      dbNamespace: env.dbNamespace || runtimeId,
      latestHeight,
      checkpointHeights,
      storage,
      walTail,
      bundle,
      tower,
      ...(verification ? { verification } : {}),
      status: statusFor(issues),
      issues,
      repairPlan: repairPlanFor(issues),
    };
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
};
