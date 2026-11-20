import {
  closeSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { safeParse, safeStringify } from '../../../../../core/protocol/serialization';
import { authorityDigest, type ExecutionAuthority } from '../authority';
import { hex } from '../boundary';
import type { ExecutionConfig } from '../config';
import type { preflightFreshRun } from './preflight';

export type FreshPreflight = Awaited<ReturnType<typeof preflightFreshRun>>;
export type RecordApprovalAttempt = (hash: string, preflight: FreshPreflight) => void;

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const writeReport = (output: string, report: Record<string, unknown>) =>
  writeFileSync(output, safeStringify(report, 2), { mode: 0o600, flag: 'wx' });

const writePreflight = (store: string, directory: string, hash: string, evidence: Record<string, unknown>): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(directory, '.preflight-'));
  try {
    const pending = join(scratch, 'report.json');
    writeFileSync(pending, safeStringify(evidence, 2), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(pending, join(directory, `${hash}.json`));
    // Preserve the original preflight evidence across process replacement.
    for (let parent = directory; parent !== dirname(store); parent = dirname(parent)) {
      const fd = openSync(parent, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export const runReportEvidence = (config: Pick<ExecutionConfig, 'runId' | 'store'>, authority: ExecutionAuthority) => {
  const binding = {
    runId: config.runId,
    candidateHead: authority.candidateHead,
    candidateDigest: authority.candidateDigest,
    authorityDigest: authorityDigest(authority),
  };
  const directory = join(config.store, 'execution-reports', binding.authorityDigest, binding.runId);
  return {
    binding,
    recordApproval(hash: string, preflight: FreshPreflight) {
      const approvalHash = hex(hash, 32);
      writePreflight(config.store, directory, approvalHash, { ...binding, approvalHash, preflight });
    },
    preflightFor(hash: string) {
      try {
        const value = safeParse(readFileSync(join(directory, `${hex(hash, 32)}.json`), 'utf8'));
        const report = requireBoundaryRecord(value, 'USDC_EXECUTION_PREFLIGHT_REPORT_INVALID');
        if (report['approvalHash'] !== hash || Object.entries(binding).some(([key, value]) => report[key] !== value))
          throw new Error('USDC_EXECUTION_PREFLIGHT_REPORT_BINDING_MISMATCH');
        return requireBoundaryRecord(report['preflight'], 'USDC_EXECUTION_PREFLIGHT_REPORT_INVALID');
      } catch (error) {
        if (!missing(error)) throw error;
        return null;
      }
    },
  };
};

export const reasonText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const throwAfter = async (original: unknown, diagnose: () => unknown | Promise<unknown>): Promise<never> => {
  try {
    await diagnose();
  } catch (secondary) {
    throw new AggregateError([original, secondary], reasonText(original), { cause: original });
  }
  throw original;
};

export const withCleanup = async <T>(run: () => Promise<T>, cleanup: () => void | Promise<void>): Promise<T> => {
  const result = await run().catch(error => throwAfter(error, cleanup));
  await cleanup();
  return result;
};
