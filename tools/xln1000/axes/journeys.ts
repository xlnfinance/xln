/**
 * J: user-journey reality, J = 1.5 * sum(w * L / 3). L1 headless test, L2 browser E2E through the visible UI,
 * L3 public J + fresh profile + real clock. Owner scope (2026-10-11): the React wallet (ui/) is the only wallet,
 * so only ui/tests specs count. Strict L2 needs a clean passing ledger run whose product paths are unchanged.
 */
import type { Ledger, QaRun } from '../ledger';
import { gap, type Axis } from '../model';
import { changedSince, commitKnown, filesContaining, lineCounts, type Repo } from '../repo';

type Level = 0 | 1 | 2 | 3;
type Journey = Readonly<{
  id: string;
  w: number;
  specs: readonly string[];
  headless: readonly string[];
  reviewLevel: Level;
  deferred: boolean;
  note: string;
}>;

const PRODUCT_PATHS = ['core', 'ui/src', 'jurisdictions/contracts'];
const MAX_CANDIDATE_RUNS = 5;

/** Frozen manifest (owner-only). reviewLevel is the static best-ever level from the 2026-10-11 review (ceiling only). */
const JOURNEYS: readonly Journey[] = [
  {
    id: 'onboard_and_fund',
    w: 8,
    specs: ['ui/tests/e2e-home-faucet.spec.ts'],
    headless: [],
    reviewLevel: 2,
    deferred: false,
    note: 'local chain only',
  },
  {
    id: 'pay_and_receive',
    w: 10,
    specs: ['ui/tests/e2e-payment.spec.ts'],
    headless: ['core/scenarios/consensus/lock-ahb.ts'],
    reviewLevel: 2,
    deferred: false,
    note: 'local chain only',
  },
  {
    id: 'direct_credit_account_unaffiliated',
    w: 12,
    specs: [],
    headless: [],
    reviewLevel: 0,
    deferred: false,
    note: 'no spec opens a non-hub entity<->entity credit account',
  },
  {
    id: 'dispute_reclaim_own_collateral',
    w: 10,
    specs: ['ui/tests/e2e-dispute-finality.spec.ts'],
    headless: ['core/scenarios/disputes/lifecycle.ts'],
    reviewLevel: 2,
    deferred: false,
    note: 'passes only with evm_setNextBlockTimestamp + page.clock',
  },
  {
    id: 'dispute_reclaim_counterparty_owes',
    w: 16,
    specs: [],
    headless: [],
    reviewLevel: 1,
    deferred: false,
    note: 'no React spec; the Svelte debt-ledger spec drives txs via enqueueEntityTxs',
  },
  {
    id: 'offline_wallet_tower_defends',
    w: 12,
    specs: [],
    headless: ['core/__tests__/security/watchtower/watchtower-rpc-last-resort.test.ts'],
    reviewLevel: 1,
    deferred: false,
    note: 'never run from a browser appointment',
  },
  {
    id: 'recover_on_fresh_device',
    w: 10,
    specs: ['ui/tests/e2e-tower-restore.spec.ts'],
    headless: [],
    reviewLevel: 2,
    deferred: false,
    note: 'BrainVault fresh-profile recovery unproven',
  },
  {
    id: 'cooperative_settle_withdraw',
    w: 6,
    specs: ['ui/tests/e2e-move.spec.ts'],
    headless: [],
    reviewLevel: 2,
    deferred: false,
    note: 'local chain only',
  },
  {
    id: 'swap_same_j',
    w: 5,
    specs: ['ui/tests/e2e-swap.spec.ts'],
    headless: [],
    reviewLevel: 2,
    deferred: false,
    note: 'local chain only',
  },
  {
    id: 'swap_cross_j',
    w: 5,
    specs: ['ui/tests/e2e-cross-swap.spec.ts'],
    headless: ['core/scenarios/cross-j'],
    reviewLevel: 1,
    deferred: true,
    note: 'cross-J deferred; spec skipped without XLN_RDB_ROOT',
  },
  {
    id: 'lend_and_repay',
    w: 3,
    specs: ['ui/tests/e2e-lending.spec.ts'],
    headless: [],
    reviewLevel: 2,
    deferred: true,
    note: 'lending deferred; terms not reclaimable',
  },
  {
    id: 'company_multisig',
    w: 3,
    specs: ['ui/tests/e2e-tutorial-company.spec.ts'],
    headless: [],
    reviewLevel: 2,
    deferred: true,
    note: 'companies deferred',
  },
];

const cleanPasses = (ledger: Ledger, journey: Journey): QaRun[] =>
  ledger.runs
    .filter(
      run =>
        run.status === 'passed' && !run.dirty && run.gitHead && run.files.some(file => journey.specs.includes(file)),
    )
    .sort((left, right) => right.createdAt - left.createdAt || left.runId.localeCompare(right.runId))
    .slice(0, MAX_CANDIDATE_RUNS);

/** L2 only when a clean pass ran on a known commit whose product paths equal those at the measured SHA. */
const strictLevel = (
  repo: Repo,
  ledger: Ledger | null,
  journey: Journey,
): { level: Level; cleanPassSha: string | null } => {
  if (!ledger) return { level: 0, cleanPassSha: null };
  for (const pass of cleanPasses(ledger, journey)) {
    const head = pass.gitHead ?? '';
    if (commitKnown(repo, head) && !changedSince(repo, head, PRODUCT_PATHS)) return { level: 2, cleanPassSha: head };
  }
  return { level: 0, cleanPassSha: null };
};

const visibleUiSpecs = (repo: Repo): ReadonlySet<string> => {
  const specs = JOURNEYS.flatMap(journey => journey.specs);
  const present = lineCounts(repo, specs);
  const scripted = new Set(filesContaining(repo, 'enqueueEntityTxs', specs));
  return new Set([...present.keys()].filter(spec => !scripted.has(spec)));
};

const journeyGaps = (rows: readonly (Journey & { level: Level })[]) =>
  rows
    .filter(row => row.level < 3)
    .map(row => {
      const label = `${row.id} (L${String(row.level)}; ${row.note})`;
      return gap('J', label, 1.5 * row.w * (1 - row.level / 3), row.deferred);
    });

export const measureJourneys = (repo: Repo, ledger: Ledger | null): Axis => {
  const visible = visibleUiSpecs(repo);
  const rows = JOURNEYS.map(journey => ({
    ...journey,
    ...strictLevel(repo, ledger, journey),
    specsViaVisibleUi: journey.specs.filter(spec => visible.has(spec)).length,
  }));
  const score = 1.5 * rows.reduce((sum, row) => sum + (row.w * row.level) / 3, 0);
  const ceiling = 1.5 * rows.reduce((sum, row) => sum + (row.w * Math.max(row.level, row.reviewLevel)) / 3, 0);
  const sub = Object.fromEntries(rows.map(row => [row.id, row.level / 3]));
  const raw = { productPaths: PRODUCT_PATHS, ledgerInput: ledger !== null, rows };
  return {
    id: 'J',
    name: 'Journey reality',
    weight: 150,
    score,
    ceiling,
    sub,
    gaps: journeyGaps(rows),
    vetoes: [],
    raw,
  };
};
