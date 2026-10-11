/** Human-readable table: the 10 axes, total, vetoes and the top in-scope gaps. */
import type { Measurement } from './measure';
import { round } from './model';

const TOP_GAPS = 10;

const pad = (value: string | number, width: number): string => String(value).padStart(width);

const inputsLine = (result: Measurement): string => {
  const ledger = result.inputs.ledger;
  const ledgerText = ledger
    ? `ledger ${String(ledger.qaRunsInWindow)} QA runs + ${String(ledger.logFilesInWindow)} logs to ${ledger.windowEnd} (${ledger.dir})`
    : 'ledger off (--ledger)';
  const ciText = result.inputs.ci ? `ci run ${String(result.inputs.ci.runIdAtSha)}` : 'ci off (--ci)';
  const worktree = result.inputs.worktreeNegativeEvidence;
  const worktreeText =
    worktree.length > 0 ? `worktree negative evidence: ${worktree.join(', ')}` : 'no worktree evidence';
  return `inputs: tree ${result.sha.slice(0, 9)} | ${ledgerText} | ${ciText} | ${worktreeText}`;
};

const axisLines = (result: Measurement): string[] => [
  `${'axis'.padEnd(32)}${pad('score', 7)}${pad('weight', 8)}${pad('gap', 8)}${pad('ceiling', 9)}`,
  ...result.axes.map(
    axis =>
      `${`${axis.id}  ${axis.name}`.padEnd(32)}${pad(axis.score, 7)}${pad(axis.weight, 8)}${pad(axis.gap, 8)}${pad(axis.ceiling, 9)}`,
  ),
  `${'total'.padEnd(32)}${pad(result.total, 7)}${pad(1000, 8)}${pad(round(1000 - result.total), 8)}${pad(result.ceilingTotal, 9)}`,
];

const gapLines = (result: Measurement): string[] => {
  const inScope = result.gaps.filter(item => !item.deferred);
  const deferred = result.gaps.filter(item => item.deferred);
  const deferredPoints = round(deferred.reduce((sum, item) => sum + item.points, 0));
  return [
    `top gaps (points gained at full credit; divide by hours to pick):`,
    ...inScope
      .slice(0, TOP_GAPS)
      .map((item, index) => `  ${pad(index + 1, 2)}. ${item.axis}  ${pad(item.points, 6)}  ${item.item}`),
    `deferred scope (not picked): ${String(deferred.length)} items, ${String(deferredPoints)} points`,
  ];
};

export const formatTable = (result: Measurement): string =>
  [
    `XLN-1000 @ ${result.sha.slice(0, 9)} (${result.commitTime})  total ${String(result.total)} / 1000  ceiling ${String(result.ceilingTotal)}`,
    inputsLine(result),
    '',
    ...axisLines(result),
    '',
    result.vetoes.length > 0 ? 'vetoes (close first):' : 'vetoes: none',
    ...result.vetoes.map(veto => `  - ${veto}`),
    '',
    ...gapLines(result),
  ].join('\n');
