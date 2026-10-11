/**
 * X: exit economics, read from committed gas evidence. X = executable * 120 * (0.7 cost + 0.3 capacity).
 * Positive evidence counts only while jurisdictions/contracts is unchanged since its binding commit.
 * Negative evidence counts from the tree or the working tree, if its source SHA has the same contracts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clamp01, gap, logScore, round, type Axis } from '../model';
import { changedSince, commitKnown, lastTouch, readJsonAt, showAt, type Repo } from '../repo';

const COVERED = ['jurisdictions/contracts'];
const BUDGET_FILE = 'docs/evidence/xlnc-20261010/dispute-budget-contracts.json';
const JURISDICTIONS_FILE = 'jurisdictions/jurisdictions.json';

/** Fixed reference prices (owner-only). The reference J is the first release J (Ethereum, Sepolia first). */
const REFERENCE = {
  gwei: 10,
  ethUsd: 3000,
  jurisdiction: 'ethereum-sepolia',
  blockGasLimit: 60_000_000,
  jShare: 0.5,
  maxExitShareOfAccount: 0.01,
} as const;

type Budget = Readonly<{
  transactionBudget: number;
  tests: readonly Readonly<{
    name: string;
    transactionGas: Readonly<{ start: number; reveal?: number; finalize: number }>;
  }>[];
}>;
type NegativeSpec = Readonly<{
  file: string;
  shaField: string;
  gasField: string;
  failed: (json: Record<string, unknown>) => boolean;
}>;

/** Reproduced exit failures. Each stays open while contracts equal those at its source SHA. */
const NEGATIVE_EVIDENCE: readonly NegativeSpec[] = [
  {
    file: 'docs/evidence/xlnc-20261010/unsolicited-custody-before.json',
    shaField: 'sourceSha',
    gasField: 'finalizationGasIncludingCalldata',
    failed: json => json['fiveMillionGasCall'] === 'reverted',
  },
  {
    file: 'docs/evidence/xlnc-20261010/mixed-exit-current.json',
    shaField: 'sourceCommit',
    gasField: 'finalizeExecutionGas',
    failed: json => Number(json['failed']) > 0,
  },
];

const readNegative = (repo: Repo, spec: NegativeSpec) => {
  const committed = showAt(repo, spec.file);
  const worktreePath = join(repo.root, spec.file);
  if (committed === null && !existsSync(worktreePath)) return null;
  const source = committed === null ? 'worktree' : 'tree';
  const json = JSON.parse(committed ?? readFileSync(worktreePath, 'utf8')) as Record<string, unknown>;
  const sourceSha = String(json[spec.shaField] ?? '');
  const known = commitKnown(repo, sourceSha);
  const sameContracts = known && !changedSince(repo, sourceSha, COVERED);
  const open = sameContracts && spec.failed(json);
  return { file: spec.file, source, sourceSha, known, sameContracts, open, gas: Number(json[spec.gasField] ?? 0) };
};

const budgetFacts = (budget: Budget) => {
  const totals = budget.tests.map(test => {
    const gas = test.transactionGas;
    return {
      name: test.name,
      total: gas.start + (gas.reveal ?? 0) + gas.finalize,
      start: gas.start,
      maxPhase: Math.max(gas.start, gas.reveal ?? 0, gas.finalize),
    };
  });
  const worst = totals.reduce((best, item) => (item.total > best.total ? item : best), {
    name: '',
    total: 0,
    start: 0,
    maxPhase: 0,
  });
  const maxStart = Math.max(0, ...totals.map(item => item.start));
  return {
    worstPath: { name: worst.name, gas: worst.total },
    maxStart,
    worstGasWithCounter: worst.total + maxStart,
    typicalGas: Math.min(...totals.map(item => item.total)),
    maxPhase: Math.max(0, ...totals.map(item => item.maxPhase)),
    transactionBudget: budget.transactionBudget,
  };
};

const referenceGasPerSecond = (repo: Repo): number | null => {
  type Jurisdictions = { jurisdictions: Record<string, { blockTimeMs?: number }> };
  const blockTimeMs = readJsonAt<Jurisdictions>(repo, JURISDICTIONS_FILE)?.jurisdictions[REFERENCE.jurisdiction]
    ?.blockTimeMs;
  return blockTimeMs ? REFERENCE.blockGasLimit / (blockTimeMs / 1000) : null;
};

const economics = (worstGas: number, gasPerSecond: number) => {
  const usdPerGas = REFERENCE.gwei * 1e-9 * REFERENCE.ethUsd;
  const worstUsd = worstGas * usdPerGas;
  const minAccountUsd = worstUsd / REFERENCE.maxExitShareOfAccount;
  const exitsPerDay = (gasPerSecond * 86_400 * REFERENCE.jShare) / worstGas;
  return {
    usdPerGas,
    worstUsd: round(worstUsd, 2),
    minAccountUsdAt1pct: round(minAccountUsd),
    exitsPerDay: Math.round(exitsPerDay),
    cost: logScore(minAccountUsd, 100, 1e6),
    capacity: clamp01((Math.log10(exitsPerDay) - 3) / 3),
  };
};

const budgetBinding = (repo: Repo) => {
  const binding = lastTouch(repo, BUDGET_FILE);
  return { file: BUDGET_FILE, binding, current: binding !== null && !changedSince(repo, binding, COVERED) };
};

type Negative = NonNullable<ReturnType<typeof readNegative>>;

const negativeVetoes = (negatives: readonly Negative[], repo: Repo): string[] =>
  negatives
    .filter(item => item.open)
    .map(
      item =>
        `EXIT_UNEXECUTABLE: reproduced ${String(item.gas)}-gas exit (${item.file}, ${item.source}, source ${item.sourceSha.slice(0, 9)}, contracts unchanged to ${repo.short})`,
    );

const phaseVetoes = (maxPhase: number, cap: number): string[] =>
  maxPhase > cap
    ? [`EXIT_UNEXECUTABLE: admitted dispute phase ${String(maxPhase)} gas > ${String(cap)} budget (${BUDGET_FILE})`]
    : [];

type Money = ReturnType<typeof economics>;

/** Cost and capacity only pay out once the axis is executable on current evidence, so their labels say so. */
const exitGaps = (score: number, ceiling: number, executable: number, money: Money) => {
  const blocked = score < ceiling ? (executable ? 'after fresh gas evidence: ' : 'after the veto: ') : '';
  const unblock = executable ? 'refresh stale exit gas evidence' : 'close the exit veto';
  const capacity = `${String(money.exitsPerDay)} worst exits/day on ${REFERENCE.jurisdiction}`;
  return [
    ...(blocked ? [gap('X', unblock, ceiling - score)] : []),
    gap('X', `${blocked}cheaper worst-case exit (worst $${String(money.worstUsd)})`, 120 * 0.7 * (1 - money.cost)),
    gap('X', `${blocked}exit capacity (${capacity})`, 120 * 0.3 * (1 - money.capacity)),
  ];
};

const unmeasuredExit = (repo: Repo, negatives: readonly Negative[], reason: string): Axis => {
  const vetoes = negativeVetoes(negatives, repo);
  const sub = { executable: vetoes.length === 0 ? 1 : 0, cost: 0, capacity: 0, evidenceCurrent: 0 };
  const gaps = [gap('X', `commit exit gas evidence (${reason})`, 120)];
  const raw = { reference: REFERENCE, unmeasured: reason, negativeEvidence: negatives };
  return { id: 'X', name: 'Exit economics', weight: 120, score: 0, ceiling: 0, sub, gaps, vetoes, raw };
};

export const measureExit = (repo: Repo): Axis => {
  const negatives = NEGATIVE_EVIDENCE.map(spec => readNegative(repo, spec)).filter(item => item !== null);
  const budget = readJsonAt<Budget>(repo, BUDGET_FILE);
  const gasPerSecond = referenceGasPerSecond(repo);
  if (!budget) return unmeasuredExit(repo, negatives, `${BUDGET_FILE} absent at ${repo.short}`);
  if (!gasPerSecond) return unmeasuredExit(repo, negatives, `${REFERENCE.jurisdiction} blockTimeMs absent`);
  const facts = budgetFacts(budget);
  const binding = budgetBinding(repo);
  const money = economics(facts.worstGasWithCounter, gasPerSecond);
  const vetoes = [...negativeVetoes(negatives, repo), ...phaseVetoes(facts.maxPhase, facts.transactionBudget)];
  const ceiling = 120 * (0.7 * money.cost + 0.3 * money.capacity);
  const executable = vetoes.length === 0 ? 1 : 0;
  const score = binding.current ? ceiling * executable : 0;
  const sub = { executable, cost: money.cost, capacity: money.capacity, evidenceCurrent: binding.current ? 1 : 0 };
  const typicalUsd = round(facts.typicalGas * money.usdPerGas, 2);
  const raw = { reference: REFERENCE, budget: binding, ...facts, ...money, typicalUsd, negativeEvidence: negatives };
  return {
    id: 'X',
    name: 'Exit economics',
    weight: 120,
    score,
    ceiling,
    sub,
    gaps: exitGaps(score, ceiling, executable, money),
    vetoes,
    raw,
  };
};
