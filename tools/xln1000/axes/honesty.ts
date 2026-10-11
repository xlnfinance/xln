/**
 * H: evidence honesty, H = 120 * (0.3 clean + 0.2 shaBound + 0.2 durable + 0.2 ci + 0.1 ledger).
 * Counts artifacts, not claims. Tree parts are exact for the SHA; clean/ledger need the local ledger, ci needs `--ci`.
 */
import type { CiEvidence } from '../ci';
import type { Ledger } from '../ledger';
import { DAY_MS, gap, weightedSum, type Axis } from '../model';
import { countMatches, filesMatching, listTree, type Repo } from '../repo';

const WEIGHTS = { cleanRuns: 0.3, shaBoundEvidence: 0.2, durableRefs: 0.2, ciGreen: 0.2, ledgerIntegrity: 0.1 };
const CLEAN_WINDOW_DAYS = 30;
const SHA_FIELD =
  '"[A-Za-z]*(sha|Sha|SHA|commit|Commit|head|Head|candidate)[A-Za-z]*"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,40}"';
const EPHEMERAL_REF = '(/tmp/|/private/tmp/|\\.logs/)[A-Za-z0-9_./-]+';
const DURABLE_REF = 'evidence/[A-Za-z0-9_./-]+';
const MARKDOWN = ['*.md', ':(exclude)docs/releases', ':(exclude)brainvault/vendor'];

const treeFacts = (repo: Repo) => {
  const evidenceJson = listTree(repo, 'docs/evidence').filter(path => path.endsWith('.json')).length;
  const shaBound = filesMatching(repo, SHA_FIELD, ['docs/evidence/*.json']).length;
  const ephemeralRefs = countMatches(repo, EPHEMERAL_REF, MARKDOWN);
  const durableRefs = countMatches(repo, DURABLE_REF, MARKDOWN);
  return { evidenceJson, shaBound, ephemeralRefs, durableRefs };
};

const ledgerFacts = (repo: Repo, ledger: Ledger | null) => {
  if (!ledger) return { windowRuns: 0, cleanRuns: 0, futureDatedRuns: [] as readonly string[] };
  const since = repo.commitTimeMs - CLEAN_WINDOW_DAYS * DAY_MS;
  const window = ledger.runs.filter(run => run.createdAt >= since);
  return {
    windowRuns: window.length,
    cleanRuns: window.filter(run => !run.dirty && run.gitHead).length,
    futureDatedRuns: ledger.futureRunIds,
  };
};

type TreeFacts = ReturnType<typeof treeFacts>;
type LedgerFacts = ReturnType<typeof ledgerFacts>;

const gapLabels = (tree: TreeFacts, local: LedgerFacts, ledger: boolean, ci: CiEvidence | null) => ({
  cleanRuns: ledger
    ? `clean QA runs with a known SHA (${String(local.cleanRuns)}/${String(local.windowRuns)} in ${String(CLEAN_WINDOW_DAYS)} days)`
    : 'clean QA runs with a known SHA (unknown: ledger absent)',
  shaBoundEvidence: `SHA-bound evidence JSON (${String(tree.shaBound)}/${String(tree.evidenceJson)})`,
  durableRefs: `durable evidence refs in docs (${String(tree.durableRefs)} vs ${String(tree.ephemeralRefs)} /tmp or .logs)`,
  ciGreen: ci
    ? `green build-and-test (${String(ci.recent.success)}/${String(ci.recent.total)})`
    : 'green build-and-test (unknown without --ci)',
  ledgerIntegrity: ledger
    ? `QA ledger integrity (${String(local.futureDatedRuns.length)} future-dated rows)`
    : 'QA ledger integrity (unknown: ledger absent)',
});

export const measureHonesty = (repo: Repo, ledger: Ledger | null, ci: CiEvidence | null): Axis => {
  const tree = treeFacts(repo);
  const local = ledgerFacts(repo, ledger);
  const refs = tree.durableRefs + tree.ephemeralRefs;
  const sub = {
    cleanRuns: local.windowRuns > 0 ? local.cleanRuns / local.windowRuns : 0,
    shaBoundEvidence: tree.evidenceJson > 0 ? tree.shaBound / tree.evidenceJson : 0,
    durableRefs: refs > 0 ? tree.durableRefs / refs : 0,
    ciGreen: ci && ci.recent.total > 0 ? ci.recent.success / ci.recent.total : 0,
    ledgerIntegrity: ledger && local.futureDatedRuns.length === 0 ? 1 : 0,
  };
  const score = 120 * weightedSum(sub, WEIGHTS);
  const labels = gapLabels(tree, local, ledger !== null, ci);
  const keys = Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[];
  const gaps = keys.map(key => gap('H', labels[key], 120 * WEIGHTS[key] * (1 - sub[key])));
  const raw = { ...tree, ...local, cleanWindowDays: CLEAN_WINDOW_DAYS, ciRecent: ci?.recent ?? null };
  return { id: 'H', name: 'Evidence honesty', weight: 120, score, ceiling: score, sub, gaps, vetoes: [], raw };
};
