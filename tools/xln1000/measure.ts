/** Runs every axis against one SHA and assembles the result. Only `--ci` touches the network; `--ledger` is opt-in. */
import { analyzeCore } from './ast';
import { measureCanonical } from './axes/canonical';
import { measureExit } from './axes/exit';
import { measureFeedback } from './axes/feedback';
import { measureHonesty } from './axes/honesty';
import { measureJourneys } from './axes/journeys';
import { measureKernel } from './axes/kernel';
import { measureMml } from './axes/mml';
import { measureProcess } from './axes/process';
import { measurePublicJ } from './axes/public-j';
import { measureReclaim } from './axes/reclaim';
import { ciVetoes, fetchCi, type CiEvidence } from './ci';
import { ledgerFingerprint, loadLedger, type Ledger } from './ledger';
import { round, type Axis, type Gap } from './model';
import { ensureCoreSnapshot, openRepo, type Repo } from './repo';

const TOOL_VERSION = 'xln1000/2';

export type MeasureOptions = Readonly<{ root: string; rev: string; ledgerDir: string | null; ci: boolean }>;

const worktreeEvidence = (axes: readonly Axis[]): string[] => {
  const exit = axes.find(axis => axis.id === 'X');
  const negatives = (exit?.raw['negativeEvidence'] ?? []) as readonly { file: string; source: string }[];
  return negatives.filter(item => item.source === 'worktree').map(item => item.file);
};

const ciInput = (ci: CiEvidence | null) =>
  ci && {
    workflow: ci.workflow,
    runIdAtSha: ci.runId,
    jobs: ci.jobs,
    hardhatPass: ci.hardhatPass.size,
    hardhatFail: [...ci.hardhatFail].sort(),
    recent: ci.recent,
  };

const rankGaps = (axes: readonly Axis[]): Gap[] =>
  axes
    .flatMap(axis => axis.gaps)
    .filter(item => item.points > 0)
    .sort(
      (left, right) =>
        right.points - left.points || left.axis.localeCompare(right.axis) || left.item.localeCompare(right.item),
    );

const measureAxes = (repo: Repo, ledger: Ledger | null, ci: CiEvidence | null): Axis[] => {
  const info = analyzeCore(ensureCoreSnapshot(repo));
  const kernel = measureKernel(repo, info);
  return [
    measureReclaim(repo, ci),
    measureJourneys(repo, ledger),
    measureExit(repo),
    measureHonesty(repo, ledger, ci),
    kernel.axis,
    measureCanonical(repo, info),
    measureFeedback(ledger),
    measureProcess(repo, kernel.closureLoc),
    measurePublicJ(repo),
    measureMml(),
  ];
};

const axisRow = (axis: Axis) => ({
  id: axis.id,
  name: axis.name,
  weight: axis.weight,
  score: round(axis.score),
  ceiling: round(axis.ceiling),
  gap: round(axis.weight - axis.score),
});

export const measure = (options: MeasureOptions) => {
  const repo = openRepo(options.root, options.rev);
  const ci = options.ci ? fetchCi(repo) : null;
  const ledger = options.ledgerDir === null ? null : loadLedger(options.ledgerDir, repo);
  const axes = measureAxes(repo, ledger, ci);
  return {
    tool: TOOL_VERSION,
    sha: repo.sha,
    commitTime: new Date(repo.commitTimeMs).toISOString(),
    total: round(axes.reduce((sum, axis) => sum + axis.score, 0)),
    ceilingTotal: round(axes.reduce((sum, axis) => sum + axis.ceiling, 0)),
    inputs: {
      tree: repo.sha,
      ledger: ledgerFingerprint(ledger),
      ci: ciInput(ci),
      worktreeNegativeEvidence: worktreeEvidence(axes),
    },
    axes: axes.map(axisRow),
    vetoes: [...axes.flatMap(axis => axis.vetoes), ...ciVetoes(repo, ci)],
    gaps: rankGaps(axes),
    detail: Object.fromEntries(axes.map(axis => [axis.id, { sub: axis.sub, raw: axis.raw }])),
  };
};

export type Measurement = ReturnType<typeof measure>;
