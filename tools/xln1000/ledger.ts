/**
 * Local ledger input (offline, but it grows over time): the QA run history sqlite and recent `.logs` files.
 * The sqlite is APFS-cloned into a private temp copy before it is opened, so the live ledger is never touched.
 * Time windows are anchored at the measured commit, not at the wall clock.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DAY_MS } from './model';
import { run, type Repo } from './repo';

export const FEEDBACK_WINDOW_DAYS = 21;
const QA_DB = 'qa-history.sqlite';
const LOG_PATTERN = 'Ran [0-9]+ tests across|PASS check:src|FAIL check:|lock-ahb';

export type QaRun = Readonly<{
  runId: string;
  createdAt: number;
  status: string;
  totalMs: number | null;
  gitHead: string | null;
  dirty: boolean;
  shards: number;
  files: readonly string[];
}>;
export type StageSample = Readonly<{ ok: boolean; minutes: number }>;
type LogSamples = Readonly<{
  check: readonly StageSample[];
  checkShortMinutes: readonly number[];
  unit: readonly StageSample[];
  lockAhb: readonly StageSample[];
  files: readonly string[];
}>;
export type Ledger = Readonly<{
  dir: string;
  runs: readonly QaRun[];
  futureRunIds: readonly string[];
  logs: LogSamples;
}>;

type Row = {
  run_id: string;
  created_at: number;
  status: string;
  total_ms: number | null;
  git_head: string | null;
  dirty: number;
  manifest_json: string;
  total_shards: number;
};
type Manifest = { gateConfig?: { args?: { pwFiles?: string[] }; tasks?: { pwTargets?: string[] }[] } };

const specFiles = (manifestJson: string): string[] => {
  const manifest = JSON.parse(manifestJson) as Manifest;
  const tasks = manifest.gateConfig?.tasks ?? [];
  return [...(manifest.gateConfig?.args?.pwFiles ?? []), ...tasks.flatMap(task => task.pwTargets ?? [])];
};

const toRun = (row: Row): QaRun => ({
  runId: row.run_id,
  createdAt: row.created_at,
  status: row.status,
  totalMs: row.total_ms,
  gitHead: row.git_head,
  dirty: row.dirty !== 0,
  shards: row.total_shards,
  files: specFiles(row.manifest_json),
});

/** Reads a private copy-on-write clone (with its WAL) so concurrent writers and readers never interfere. */
const readQaRows = (dir: string): Row[] => {
  const source = join(dir, QA_DB);
  if (!existsSync(source)) return [];
  const scratch = mkdtempSync(join(tmpdir(), 'xln1000-qa-'));
  try {
    for (const suffix of ['', '-wal']) {
      if (existsSync(`${source}${suffix}`)) run(['cp', '-c', `${source}${suffix}`, join(scratch, `${QA_DB}${suffix}`)]);
    }
    const db = new Database(join(scratch, QA_DB));
    const query =
      'select run_id, created_at, status, total_ms, git_head, dirty, manifest_json, total_shards from qa_runs order by run_id';
    const rows = db.query(query).all() as Row[];
    db.close();
    return rows;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const recentLogFiles = (dir: string, sinceMs: number): string[] => {
  const minutes = Math.max(1, Math.ceil((Date.now() - sinceMs) / 60_000));
  const command = ['find', dir, '-name', '*.log', '-mmin', `-${String(minutes)}`, '-size', '-50M'];
  const filters = ['-not', '-path', '*/e2e-build-cache/*', '-not', '-path', '*/e2e-parallel/*'];
  const output = run([...command, ...filters, '-exec', 'grep', '-lE', LOG_PATTERN, '{}', '+'], { okExitCodes: [0, 1] });
  return output.split('\n').filter(Boolean).sort();
};

const unitSample = (text: string): StageSample | null => {
  const ran = [...text.matchAll(/Ran (\d+) tests across (\d+) files\. \[([\d.]+)s\]/g)]
    .filter(match => Number(match[2]) >= 700)
    .pop();
  if (!ran) return null;
  const fails = [...text.matchAll(/^\s*(\d+) fail$/gm)].pop();
  return { ok: !!fails && Number(fails[1]) === 0, minutes: Number(ran[3]) / 60 };
};

const checkSample = (text: string): StageSample | null => {
  const passed = /PASS check:src (\d+)ms/.exec(text);
  const failed = /FAIL check:[\w:-]+ (\d+)ms/.exec(text);
  const ms = passed?.[1] ?? failed?.[1];
  return ms === undefined ? null : { ok: !!passed && !failed, minutes: Number(ms) / 60_000 };
};

const parseLogs = (dir: string, files: readonly string[]): LogSamples => {
  const texts = files.map(file => readFileSync(file, 'utf8'));
  const lockAhb = texts.flatMap(text =>
    [...text.matchAll(/^(PASS|FAIL)\s+lock-ahb\s+([\d.]+)s/gm)].map(match => ({
      ok: match[1] === 'PASS',
      minutes: Number(match[2]) / 60,
    })),
  );
  const checkShortMinutes = texts.flatMap(text =>
    [...text.matchAll(/(?:PASS|FAIL) check:contract-artifact-drift (\d+)ms/g)].map(match => Number(match[1]) / 60_000),
  );
  return {
    check: texts.map(checkSample).filter(sample => sample !== null),
    checkShortMinutes,
    unit: texts.map(unitSample).filter(sample => sample !== null),
    lockAhb,
    files: files.map(file => relative(dir, file)),
  };
};

/** Null when the ledger directory is absent; the run then scores ledger-dependent sub-items as unknown (0). */
export const loadLedger = (dir: string, repo: Repo): Ledger | null => {
  if (!existsSync(dir)) return null;
  const futureCutoff = Date.now() + DAY_MS;
  const rows = readQaRows(dir).map(toRun);
  const logs = parseLogs(dir, recentLogFiles(dir, repo.commitTimeMs - FEEDBACK_WINDOW_DAYS * DAY_MS));
  return {
    dir,
    runs: rows.filter(row => row.createdAt <= futureCutoff),
    futureRunIds: rows.filter(row => row.createdAt > futureCutoff).map(row => row.runId),
    logs,
  };
};

export const ledgerFingerprint = (ledger: Ledger | null) =>
  ledger && {
    dir: ledger.dir,
    qaRuns: ledger.runs.length,
    newestRunAt:
      ledger.runs.length > 0 ? new Date(Math.max(...ledger.runs.map(row => row.createdAt))).toISOString() : null,
    logFiles: ledger.logs.files.length,
  };
