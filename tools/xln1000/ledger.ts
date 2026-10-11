/**
 * Local ledger input (opt-in with --ledger; offline, but it grows over time): the QA run history sqlite and
 * `.logs` files. The sqlite is APFS-cloned into a private temp copy before it is opened, so the live ledger is
 * never touched. Time windows end at the measured commit time, so later runs and logs never feed an older SHA.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DAY_MS } from './model';
import { run, type Repo } from './repo';

export const FEEDBACK_WINDOW_DAYS = 21;
export const CLEAN_WINDOW_DAYS = 30;
const QA_DB = 'qa-history.sqlite';
const LOG_PATTERN = 'Ran [0-9]+ tests across|PASS check:src|FAIL check:|lock-ahb';
const GREP_BATCH = 400;

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
  /** Commit time of the measured SHA: every time window ends here. */
  endMs: number;
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

/** QA runs created inside the `days` that end at the measured commit time. */
export const runsInWindow = (ledger: Ledger, days: number): QaRun[] =>
  ledger.runs.filter(row => row.createdAt >= ledger.endMs - days * DAY_MS && row.createdAt <= ledger.endMs);

/** `find -mmin` only narrows the scan; the exact [from, to] mtime window is applied with stat. */
const logsModifiedIn = (dir: string, fromMs: number, toMs: number): string[] => {
  const minutes = Math.max(1, Math.ceil((Date.now() - fromMs) / 60_000));
  const command = ['find', dir, '-name', '*.log', '-type', 'f', '-mmin', `-${String(minutes)}`, '-size', '-50M'];
  const filters = ['-not', '-path', '*/e2e-build-cache/*', '-not', '-path', '*/e2e-parallel/*'];
  return run([...command, ...filters])
    .split('\n')
    .filter(Boolean)
    .filter(file => {
      const mtime = statSync(file).mtimeMs;
      return mtime >= fromMs && mtime <= toMs;
    });
};

const logsWithSamples = (files: readonly string[]): string[] => {
  const matched: string[] = [];
  for (let start = 0; start < files.length; start += GREP_BATCH) {
    const batch = files.slice(start, start + GREP_BATCH);
    matched.push(...run(['grep', '-lE', LOG_PATTERN, ...batch], { okExitCodes: [0, 1] }).split('\n'));
  }
  return matched.filter(Boolean).sort();
};

const lastCount = (block: string, label: string): number | null => {
  const match = [...block.matchAll(new RegExp(`^\\s*(\\d+) ${label}$`, 'gm'))].pop();
  return match ? Number(match[1]) : null;
};

/** Full unit run (>= 700 files). Green only with 0 fail, 0 skip and 0 todo in its own summary block. */
const unitSample = (text: string): StageSample | null => {
  const ran = [...text.matchAll(/Ran (\d+) tests across (\d+) files\. \[([\d.]+)s\]/g)]
    .filter(match => Number(match[2]) >= 700)
    .pop();
  if (!ran) return null;
  const block = text.slice(0, ran.index).split('\n').slice(-8).join('\n');
  const fails = lastCount(block, 'fail');
  const notRun = (lastCount(block, 'skip') ?? 0) + (lastCount(block, 'todo') ?? 0);
  return { ok: fails === 0 && notRun === 0, minutes: Number(ran[3]) / 60 };
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

/**
 * Null when the ledger directory is absent; the run then scores ledger-dependent sub-items as unknown (0).
 * The future-dated row check is the one comparison against the wall clock (a row dated after "now" is corrupt).
 */
export const loadLedger = (dir: string, repo: Repo): Ledger | null => {
  if (!existsSync(dir)) return null;
  const futureCutoff = Date.now() + DAY_MS;
  const rows = readQaRows(dir).map(toRun);
  const fromMs = repo.commitTimeMs - FEEDBACK_WINDOW_DAYS * DAY_MS;
  const logs = parseLogs(dir, logsWithSamples(logsModifiedIn(dir, fromMs, repo.commitTimeMs)));
  return {
    dir,
    endMs: repo.commitTimeMs,
    runs: rows.filter(row => row.createdAt <= futureCutoff),
    futureRunIds: rows.filter(row => row.createdAt > futureCutoff).map(row => row.runId),
    logs,
  };
};

/** Only window-bounded counts, so the fingerprint of a past SHA does not change as the ledger grows. */
export const ledgerFingerprint = (ledger: Ledger | null) =>
  ledger && {
    dir: ledger.dir,
    windowEnd: new Date(ledger.endMs).toISOString(),
    qaRunsInWindow: runsInWindow(ledger, CLEAN_WINDOW_DAYS).length,
    runWindowDays: CLEAN_WINDOW_DAYS,
    logFilesInWindow: ledger.logs.files.length,
    logWindowDays: FEEDBACK_WINDOW_DAYS,
    futureDatedRows: ledger.futureRunIds.length,
  };
