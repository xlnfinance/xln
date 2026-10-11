/**
 * R: reclaimability. R = 2 * sum(w * d * e) over 12 off-chain state types (sum w = 100).
 * d is the design verdict cited to contract file:line; e = 1 only when a listed adversarial test passed
 * at this SHA in CI and none failed. Without `--ci` every test is UNKNOWN, so e = 0 (unknown is not proof).
 */
import type { CiEvidence } from '../ci';
import { gap, type Axis } from '../model';
import { lineCounts, needlesPresent, type Repo } from '../repo';

type Verdict = 0 | 0.5 | 1;
type StateType = Readonly<{
  id: string;
  w: number;
  design: Verdict;
  why: string;
  tests: readonly string[];
  deferred: boolean;
}>;
type TestStatus = 'ABSENT' | 'PASS' | 'FAIL' | 'UNKNOWN';

const TEST_DIRS = ['jurisdictions/test', 'core/__tests__', 'tests'];
const GROWTH_FIX_TEST = 'test_unsolicitedCompanySharesCannotEnlargeExitProof';

/** Frozen manifest (owner-only): ids, weights and design verdicts from the 2026-10-11 contracts review. */
const STATE_TYPES: readonly StateType[] = [
  {
    id: 'collateral_share',
    w: 10,
    design: 1,
    why: 'Depository.sol:939-981 split',
    deferred: false,
    tests: [
      'requires timeout for unilateral dispute finalization and bumps account nonce once',
      'test_disputeStartThenTimeoutFinalizeByStarter',
      'test_wideOffsetResetAfterSplitCollateralFinalization',
    ],
  },
  {
    id: 'latest_signed_offdelta',
    w: 10,
    design: 1,
    why: 'Account.sol:1053-1098; unACKed frames lost by design',
    deferred: false,
    tests: [
      'lets only the non-starter finalize a newer jointly signed counter-proof',
      'cannot claim twice: a second finalization of the same dispute reverts',
      'reverts caller gas starvation without consuming the active dispute',
    ],
  },
  {
    id: 'stale_state_countered',
    w: 10,
    design: 1,
    why: 'counter-dispute higher nonce / LEFT tie-break (Account.sol:1426-1507)',
    deferred: false,
    tests: [
      'orders mutually signed same-nonce branches by LEFT proposer',
      'rejects a RIGHT same-nonce branch when the initial proposer was LEFT',
      'blocks early finalization on both the timeout path and the counterparty-signed path',
    ],
  },
  {
    id: 'offline_party_defended',
    w: 10,
    design: 0.5,
    why: 'tower = counter only, operator-run, unfunded key (start-watchtower.sh:43-47)',
    deferred: false,
    tests: [
      'allows a designated tower to submit a delayed last-resort counter-dispute',
      'rejects watchtower counter-dispute from the wrong tower or without a newer signed proof',
      'core/__tests__/security/watchtower/watchtower-rpc-last-resort.test.ts',
    ],
  },
  {
    id: 'credit_beyond_collateral',
    w: 16,
    design: 0.5,
    why: 'same-token same-Depository reserve, then FIFO no-interest debt (Depository.sol:984-1008)',
    deferred: false,
    tests: [
      'test_disputeCreatesDebtWhenReserveIsShort',
      'locks outstanding debt before reserve outflows and pays FIFO debt in bounded chunks',
      'finalizes every dispute with exact debt independent of token supply',
    ],
  },
  {
    id: 'htlc_lock',
    w: 8,
    design: 1,
    why: 'DeltaTransformer.sol:258-290',
    deferred: false,
    tests: [
      'uses timestamp deadlines for payment secrets from arguments and on-chain reveals',
      'test_lateSecretsDoNotApplyEitherFullWidthHtlc',
    ],
  },
  {
    id: 'same_j_swap',
    w: 6,
    design: 1,
    why: 'DeltaTransformer.sol:190-212',
    deferred: false,
    tests: [
      'decodes swap fill ratios from uint16 calldata arguments',
      'test_fullUint256SwapPartialFillPreservesExactOppositeLegs',
    ],
  },
  {
    id: 'cross_j_value',
    w: 8,
    design: 0.5,
    why: 'pulls need disputes on both Js, both operators online; tower has no pull support',
    deferred: true,
    tests: [
      'waits the signed window for a newer Pull proof and settles only registry evidence',
      'settles pulls only from role-windowed records of this dispute',
    ],
  },
  {
    id: 'lending_terms',
    w: 8,
    design: 0,
    why: 'loan terms only in EntityState.lending; lending_fund is a plain payment (lending.ts:76-107)',
    deferred: true,
    tests: [],
  },
  {
    id: 'custom_clause',
    w: 6,
    design: 0,
    why: 'admission returns MAX_SAFE_INTEGER (dispute-gas-budget.ts:22); failing clause blocks account',
    deferred: false,
    tests: ['keeps the dispute active when any signed transformer cannot execute exactly'],
  },
  {
    id: 'inflight_settlement',
    w: 4,
    design: 0.5,
    why: 'higher-nonce settlement stays executable; WIP reserves rows',
    deferred: false,
    tests: [
      'rejects historical cooperative signatures as a dispute bypass',
      'blocks cooperative settlement and C2R while a dispute is active',
    ],
  },
  {
    id: 'adversarial_growth_bounded',
    w: 4,
    design: 0,
    why: 'unsolicited custody -> 12.66M gas exit; guard test absent at this SHA',
    deferred: false,
    tests: [GROWTH_FIX_TEST],
  },
];

/** The growth verdict is the only design verdict the tree can flip: the guard test either exists at the SHA or not. */
const manifestAt = (repo: Repo): readonly StateType[] => {
  if (needlesPresent(repo, [GROWTH_FIX_TEST], ['jurisdictions/test']).size === 0) return STATE_TYPES;
  const why = 'unsolicited-asset guard test present at this SHA';
  return STATE_TYPES.map(row => (row.id === 'adversarial_growth_bounded' ? { ...row, design: 1, why } : row));
};

const isPathTest = (test: string): boolean => test.includes('/');

const testStatus = (test: string, present: boolean, ci: CiEvidence | null): TestStatus => {
  if (!present) return 'ABSENT';
  if (ci?.hardhatFail.has(test)) return 'FAIL';
  return ci?.hardhatPass.has(test) ? 'PASS' : 'UNKNOWN';
};

const scoreRow = (row: StateType, present: ReadonlySet<string>, ci: CiEvidence | null) => {
  const tests = row.tests.map(test => ({ test, status: testStatus(test, present.has(test), ci) }));
  const anyFail = tests.some(item => item.status === 'FAIL');
  const evidence = tests.some(item => item.status === 'PASS') && !anyFail ? 1 : 0;
  const ceiling = tests.some(item => item.status !== 'ABSENT') && !anyFail ? 1 : 0;
  return { ...row, tests, evidence, ceiling };
};

const presentTests = (repo: Repo, rows: readonly StateType[]): Set<string> => {
  const all = rows.flatMap(row => row.tests);
  const titles = needlesPresent(
    repo,
    all.filter(test => !isPathTest(test)),
    TEST_DIRS,
  );
  const files = lineCounts(repo, all.filter(isPathTest));
  return new Set([...titles, ...files.keys()]);
};

type ScoredRow = ReturnType<typeof scoreRow>;

const reclaimGaps = (rows: readonly ScoredRow[]) =>
  rows
    .filter(row => row.design * row.evidence < 1)
    .map(row => {
      const label = `${row.id} (d=${String(row.design)}, e=${String(row.evidence)})`;
      return gap('R', label, 2 * row.w * (1 - row.design * row.evidence), row.deferred);
    });

const weighted = (rows: readonly ScoredRow[], factor: (row: ScoredRow) => number): number =>
  2 * rows.reduce((sum, row) => sum + row.w * row.design * factor(row), 0);

export const measureReclaim = (repo: Repo, ci: CiEvidence | null): Axis => {
  const manifest = manifestAt(repo);
  const present = presentTests(repo, manifest);
  const rows = manifest.map(row => scoreRow(row, present, ci));
  const score = weighted(rows, row => row.evidence);
  const ceiling = weighted(rows, row => row.ceiling);
  const sub = Object.fromEntries(rows.map(row => [row.id, row.design * row.evidence]));
  const raw = { designMax: weighted(rows, () => 1), ciInput: ci !== null, rows };
  return {
    id: 'R',
    name: 'Reclaimability',
    weight: 200,
    score,
    ceiling,
    sub,
    gaps: reclaimGaps(rows),
    vetoes: [],
    raw,
  };
};
