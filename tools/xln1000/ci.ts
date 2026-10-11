/** Networked input, read only with `--ci`: GitHub Actions build-and-test status and the Contracts job log at the SHA. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Repo } from './repo';

const WORKFLOW = 'build-and-test';
const CONTRACTS_JOB = 'Contracts';
const RECENT_RUNS = 20;

type RunRow = Readonly<{ databaseId: number; headSha: string; conclusion: string; status: string }>;
type JobRow = Readonly<{ name: string; conclusion: string; databaseId: number }>;

export type CiEvidence = Readonly<{
  workflow: string;
  runId: string | null;
  jobs: Readonly<Record<string, string>>;
  hardhatPass: ReadonlySet<string>;
  hardhatFail: ReadonlySet<string>;
  recent: Readonly<{ success: number; total: number }>;
}>;

const gh = (repo: Repo, args: readonly string[], timeoutMs = 30_000): string =>
  run(['gh', ...args], { cwd: repo.root, timeoutMs });

/** The log of a finished job never changes, so it is cached by job id outside the repository. */
const contractsLog = (repo: Repo, runId: string, jobId: number): string => {
  const cache = join(tmpdir(), `xln1000-ci-job-${String(jobId)}.log`);
  if (existsSync(cache)) return readFileSync(cache, 'utf8');
  const log = gh(repo, ['run', 'view', runId, '--log', '--job', String(jobId)], 90_000);
  writeFileSync(cache, log);
  return log;
};

/** Hardhat (mocha) titles: `✔ title (12ms)` passes, `  1) title` failures; suite-name failure headers are skipped. */
const parseHardhatLog = (log: string): { pass: Set<string>; fail: Set<string> } => {
  const pass = new Set<string>();
  const fail = new Set<string>();
  for (const line of log.split('\n')) {
    const body = line.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /, '');
    const passed = /^\s*✔ (.+?)(?: \(\d+ms\))?\s*$/.exec(body);
    if (passed?.[1]) pass.add(passed[1].trim());
    const failed = /^\s{2,6}\d+\) (.+?)\s*$/.exec(body);
    if (failed?.[1] && !/^\s*\d+\) [A-Z][A-Za-z]+$/.test(body)) fail.add(failed[1].replace(/:$/, '').trim());
  }
  for (const title of fail) pass.delete(title);
  return { pass, fail };
};

const listRuns = (repo: Repo): RunRow[] =>
  JSON.parse(
    gh(repo, [
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--limit',
      '40',
      '--json',
      'databaseId,headSha,conclusion,status',
    ]),
  ) as RunRow[];

const recentGreen = (runs: readonly RunRow[]) => {
  const done = runs.filter(row => row.status === 'completed' && row.conclusion !== 'cancelled').slice(0, RECENT_RUNS);
  return { success: done.filter(row => row.conclusion === 'success').length, total: done.length };
};

/** Fails loudly when `gh` is unavailable: `--ci` was requested explicitly, so missing CI is an error, not a zero. */
export const fetchCi = (repo: Repo): CiEvidence => {
  const runs = listRuns(repo);
  const atSha = runs.find(row => row.headSha === repo.sha && row.status === 'completed');
  const empty = {
    workflow: WORKFLOW,
    runId: null,
    jobs: {},
    hardhatPass: new Set<string>(),
    hardhatFail: new Set<string>(),
  };
  if (!atSha) return { ...empty, recent: recentGreen(runs) };
  const runId = String(atSha.databaseId);
  const jobs = (JSON.parse(gh(repo, ['run', 'view', runId, '--json', 'jobs'])) as { jobs: JobRow[] }).jobs;
  const contracts = jobs.find(job => job.name === CONTRACTS_JOB);
  const parsed = contracts
    ? parseHardhatLog(contractsLog(repo, runId, contracts.databaseId))
    : { pass: new Set<string>(), fail: new Set<string>() };
  return {
    workflow: WORKFLOW,
    runId,
    jobs: Object.fromEntries(
      jobs.map(job => [job.name, job.conclusion] as const).sort((a, b) => a[0].localeCompare(b[0])),
    ),
    hardhatPass: parsed.pass,
    hardhatFail: parsed.fail,
    recent: recentGreen(runs),
  };
};

export const ciVetoes = (repo: Repo, ci: CiEvidence | null): string[] => {
  if (!ci) return [];
  const red = [...ci.hardhatFail].sort().map(title => `CI_RED_AT_SHA (${CONTRACTS_JOB}): ${title}`);
  const failed = Object.values(ci.jobs).some(conclusion => conclusion === 'failure');
  return failed ? [...red, `CI_FAILED_AT_SHA: ${WORKFLOW} run ${String(ci.runId)} at ${repo.short}`] : red;
};
