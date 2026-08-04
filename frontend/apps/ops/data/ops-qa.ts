import { clearQaToken, consumeQaTokenFromUrl, qaFetch, readQaToken, writeQaToken } from '$lib/qa/apiClient';

export type QaAuth = 'open' | 'read' | 'admin' | 'locked';
export type QaRunSummary = Readonly<{
  runId: string;
  status: string;
  suiteLabel: string;
  createdAt: number;
  totalMs: number | null;
  codeHash: string | null;
  dirty: boolean;
}>;
export type QaShard = Readonly<{
  shard: number;
  status: string;
  target: string;
  durationMs: number | null;
  failureClass: string | null;
  error: string | null;
  artifacts: readonly Readonly<{ kind: string; relativePath: string; url: string | null }>[];
}>;
export type QaRunDetail = QaRunSummary & Readonly<{ shards: readonly QaShard[] }>;
export type QaCatalogItem = Readonly<{ id: string; group: string; label: string; description: string }>;
export type QaCockpit = Readonly<{
  auth: QaAuth;
  restartAllowed: boolean;
  restartActive: boolean;
  runs: readonly QaRunSummary[];
  catalog: readonly QaCatalogItem[];
  historyCount: number;
  auditCount: number;
  storyCount: number;
}>;

const object = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};
const string = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};
const optionalString = (value: unknown, code: string): string | null => value === null || value === undefined || value === '' ? null : string(value, code);
const finite = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(code);
  return value;
};
const optionalFinite = (value: unknown, code: string): number | null => value === null || value === undefined ? null : finite(value, code);
const array = (value: unknown, code: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};
const auth = (payload: Record<string, unknown>): QaAuth => {
  const raw = payload['qaAuth'] === undefined ? {} : object(payload['qaAuth'], 'OPS_QA_AUTH_INVALID');
  if (raw['disabled'] === true) return 'open';
  if (raw['disabled'] !== undefined && raw['disabled'] !== false) throw new Error('OPS_QA_AUTH_DISABLED_INVALID');
  if (raw['scope'] === 'read' || raw['scope'] === 'admin') return raw['scope'];
  return 'locked';
};
const assertOk = (response: Response, payload: Record<string, unknown>, code: string): void => {
  if (response.ok && payload['ok'] === true) return;
  throw new Error(optionalString(payload['error'], `${code}_ERROR_INVALID`) ?? `${code}_HTTP_${response.status}`);
};
const json = async (response: Response, code: string): Promise<Record<string, unknown>> => object(await response.json(), `${code}_PAYLOAD_INVALID`);

const parseRunSummary = (value: unknown, index: number): QaRunSummary => {
  const raw = object(value, `OPS_QA_RUN_INVALID:${index}`);
  const code = object(raw['code'] ?? {}, `OPS_QA_RUN_CODE_INVALID:${index}`);
  const dirty = raw['dirty'] ?? code['dirty'] ?? false;
  if (typeof dirty !== 'boolean') throw new Error(`OPS_QA_RUN_DIRTY_INVALID:${index}`);
  const runId = string(raw['runId'], `OPS_QA_RUN_ID_INVALID:${index}`);
  return Object.freeze({
    runId,
    status: string(raw['status'], `OPS_QA_RUN_STATUS_INVALID:${index}`),
    suiteLabel: string(raw['suiteLabel'] ?? raw['suiteKey'] ?? runId, `OPS_QA_RUN_SUITE_INVALID:${index}`),
    createdAt: finite(raw['createdAt'], `OPS_QA_RUN_CREATED_INVALID:${index}`),
    totalMs: optionalFinite(raw['totalMs'] ?? raw['durationMs'], `OPS_QA_RUN_DURATION_INVALID:${index}`),
    codeHash: optionalString(code['codeHash'] ?? raw['codeHash'], `OPS_QA_RUN_HASH_INVALID:${index}`),
    dirty,
  });
};
const parseShard = (value: unknown, index: number): QaShard => {
  const raw = object(value, `OPS_QA_SHARD_INVALID:${index}`);
  const artifacts = array(raw['artifacts'], `OPS_QA_SHARD_ARTIFACTS_INVALID:${index}`).map((item, artifactIndex) => {
    const artifact = object(item, `OPS_QA_ARTIFACT_INVALID:${index}:${artifactIndex}`);
    return Object.freeze({
      kind: string(artifact['kind'], `OPS_QA_ARTIFACT_KIND_INVALID:${index}:${artifactIndex}`),
      relativePath: string(artifact['relativePath'], `OPS_QA_ARTIFACT_PATH_INVALID:${index}:${artifactIndex}`),
      url: optionalString(artifact['url'], `OPS_QA_ARTIFACT_URL_INVALID:${index}:${artifactIndex}`),
    });
  });
  return Object.freeze({
    shard: finite(raw['shard'], `OPS_QA_SHARD_INDEX_INVALID:${index}`),
    status: string(raw['status'], `OPS_QA_SHARD_STATUS_INVALID:${index}`),
    target: string(raw['target'] ?? raw['handle'] ?? raw['title'] ?? `shard-${String(raw['shard'])}`, `OPS_QA_SHARD_TARGET_INVALID:${index}`),
    durationMs: optionalFinite(raw['durationMs'] ?? raw['totalMs'], `OPS_QA_SHARD_DURATION_INVALID:${index}`),
    failureClass: optionalString(raw['failureClass'], `OPS_QA_SHARD_FAILURE_INVALID:${index}`),
    error: optionalString(raw['error'], `OPS_QA_SHARD_ERROR_INVALID:${index}`),
    artifacts: Object.freeze(artifacts),
  });
};

const fetchObject = async (url: string): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await qaFetch(url, { cache: 'no-store' });
  return { response, payload: await json(response, 'OPS_QA_READ') };
};

export const readQaCockpit = async (): Promise<QaCockpit> => {
  const [runsResult, catalogResult, historyResult, auditResult, storiesResult] = await Promise.all([
    fetchObject('/api/qa/runs?limit=20'), fetchObject('/api/qa/catalog'), fetchObject('/api/qa/history?limit=120'),
    fetchObject('/api/qa/restart-audit?limit=25'), fetchObject('/api/qa/stories?limit=200'),
  ]);
  assertOk(runsResult.response, runsResult.payload, 'OPS_QA_RUNS');
  assertOk(catalogResult.response, catalogResult.payload, 'OPS_QA_CATALOG');
  assertOk(historyResult.response, historyResult.payload, 'OPS_QA_HISTORY');
  assertOk(auditResult.response, auditResult.payload, 'OPS_QA_AUDIT');
  assertOk(storiesResult.response, storiesResult.payload, 'OPS_QA_STORIES');
  const runs = array(runsResult.payload['runs'], 'OPS_QA_RUNS_INVALID').map(parseRunSummary);
  const catalog = array(catalogResult.payload['catalog'], 'OPS_QA_CATALOG_INVALID').map((value, index) => {
    const item = object(value, `OPS_QA_CATALOG_ITEM_INVALID:${index}`);
    return Object.freeze({ id: string(item['id'], `OPS_QA_CATALOG_ID_INVALID:${index}`), group: string(item['group'], `OPS_QA_CATALOG_GROUP_INVALID:${index}`), label: string(item['label'], `OPS_QA_CATALOG_LABEL_INVALID:${index}`), description: string(item['description'], `OPS_QA_CATALOG_DESCRIPTION_INVALID:${index}`) });
  });
  const restart = object(historyResult.payload['restart'] ?? catalogResult.payload['restart'] ?? { active: false }, 'OPS_QA_RESTART_INVALID');
  if (typeof restart['active'] !== 'boolean') throw new Error('OPS_QA_RESTART_ACTIVE_INVALID');
  return Object.freeze({
    auth: auth(runsResult.payload), restartAllowed: catalogResult.payload['restartAllowed'] === true || historyResult.payload['restartAllowed'] === true,
    restartActive: restart['active'], runs: Object.freeze(runs), catalog: Object.freeze(catalog),
    historyCount: array(historyResult.payload['history'], 'OPS_QA_HISTORY_INVALID').length,
    auditCount: array(auditResult.payload['audit'], 'OPS_QA_AUDIT_INVALID').length,
    storyCount: array(storiesResult.payload['stories'], 'OPS_QA_STORIES_INVALID').length,
  });
};

export const readQaRun = async (runId: string): Promise<QaRunDetail> => {
  const { response, payload } = await fetchObject(`/api/qa/run?runId=${encodeURIComponent(runId)}`);
  assertOk(response, payload, 'OPS_QA_RUN');
  const raw = object(payload['run'], 'OPS_QA_RUN_DETAIL_INVALID');
  return Object.freeze({ ...parseRunSummary(raw, 0), shards: Object.freeze(array(raw['shards'], 'OPS_QA_SHARDS_INVALID').map(parseShard)) });
};

export const qaAdminRequest = async (url: string, body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
  const response = await qaFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await json(response, 'OPS_QA_ADMIN');
  assertOk(response, payload, 'OPS_QA_ADMIN');
  return payload;
};

export const qaToken = Object.freeze({ initialize: (): string => consumeQaTokenFromUrl() || readQaToken(), write: writeQaToken, clear: clearQaToken });
