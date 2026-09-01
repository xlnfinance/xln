import { QA } from '../../../../core/config/qa';
import { qaFetch } from '../../../packages/browser/src/qa-api-client';
import {
  decodeQaEnvelope,
  isQaHistoryBackfillResult,
  isQaRetentionPurgeResult,
  isRestartStatus,
} from '../../../packages/runtime-client/src/qa-boundary';
import type {
  QaHistoryBackfillResult,
  QaRetentionPurgeResult,
  RestartStatus,
} from '../../../packages/runtime-client/src/qa-types';
import { readJsonUnknown } from '../../../packages/runtime-client/src/boundary';

export const OPS_QA_CONFIRMATIONS = {
  restart: QA.RESTART_CONFIRM,
  abort: QA.RESTART_ABORT_CONFIRM,
  backfill: QA.HISTORY_BACKFILL_CONFIRM,
  retention: QA.RETENTION_CONFIRM,
} as const;

export type OpsQaRestartPlan = Readonly<{
  command: readonly string[];
  expectedGitHead: string;
  codeHash: string;
  dirty: boolean;
}>;

export type OpsQaRestartRequest = Readonly<{
  runId: string;
  shard: number;
  operatorId: string;
  reason: string;
  confirm: string;
  expectedGitHead: string;
}>;

export type OpsQaActionPost = (url: string, body: Readonly<object>) => Promise<unknown>;

const postQaJson: OpsQaActionPost = async (url, body) => {
  const response = await qaFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readJsonUnknown(response);
  if (!response.ok) throw new Error(`OPS_QA_ACTION_HTTP_${response.status}`);
  return payload;
};

const optionalString = (value: unknown, code: string): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

export const planOpsQaRestart = async (
  runId: string,
  shard: number,
  post: OpsQaActionPost = postQaJson,
): Promise<OpsQaRestartPlan> => {
  const payload = decodeQaEnvelope(
    await post('/api/qa/restart?mode=plan', { runId, shard }),
    ['ok', 'qaAuth', 'mode', 'target', 'title', 'command', 'expectedGitHead', 'gitBranch', 'codeHash', 'dirty', 'restart', 'restartAllowed', 'error'],
  );
  const command = payload['command'];
  if (!Array.isArray(command) || !command.every(entry => typeof entry === 'string')) {
    throw new Error('OPS_QA_RESTART_PLAN_COMMAND_INVALID');
  }
  if (payload['dirty'] !== undefined && typeof payload['dirty'] !== 'boolean') {
    throw new Error('OPS_QA_RESTART_PLAN_DIRTY_INVALID');
  }
  return {
    command,
    expectedGitHead: optionalString(payload['expectedGitHead'], 'OPS_QA_RESTART_PLAN_HEAD_INVALID'),
    codeHash: optionalString(payload['codeHash'], 'OPS_QA_RESTART_PLAN_HASH_INVALID'),
    dirty: payload['dirty'] === true,
  };
};

export const runOpsQaRestart = async (
  request: OpsQaRestartRequest,
  post: OpsQaActionPost = postQaJson,
): Promise<RestartStatus> => {
  const payload = decodeQaEnvelope(
    await post('/api/qa/restart?mode=run', request),
    ['ok', 'qaAuth', 'restart', 'restartAllowed', 'error'],
  );
  if (!isRestartStatus(payload['restart'])) throw new Error('OPS_QA_RESTART_INVALID');
  return payload['restart'];
};

export const abortOpsQaRestart = async (
  confirm: string,
  post: OpsQaActionPost = postQaJson,
): Promise<RestartStatus> => {
  const payload = decodeQaEnvelope(
    await post('/api/qa/restart/abort', { confirm }),
    ['ok', 'qaAuth', 'restart', 'restartAllowed', 'error'],
  );
  if (!isRestartStatus(payload['restart'])) throw new Error('OPS_QA_RESTART_ABORT_INVALID');
  return payload['restart'];
};

export const backfillOpsQaHistory = async (
  confirm: string,
  post: OpsQaActionPost = postQaJson,
): Promise<QaHistoryBackfillResult> => {
  const payload = decodeQaEnvelope(
    await post('/api/qa/history/backfill', { confirm, limit: 500 }),
    ['ok', 'qaAuth', 'result', 'error'],
  );
  if (!isQaHistoryBackfillResult(payload['result'])) throw new Error('OPS_QA_HISTORY_BACKFILL_INVALID');
  return payload['result'];
};

export const purgeOpsQaHistory = async (
  confirm: string,
  post: OpsQaActionPost = postQaJson,
): Promise<QaRetentionPurgeResult> => {
  const payload = decodeQaEnvelope(
    await post('/api/qa/retention', { confirm }),
    ['ok', 'qaAuth', 'result', 'error'],
  );
  if (!isQaRetentionPurgeResult(payload['result'])) throw new Error('OPS_QA_RETENTION_INVALID');
  return payload['result'];
};

export const isOpsQaAdmin = (auth: string): boolean => auth === 'admin' || auth === 'open';
