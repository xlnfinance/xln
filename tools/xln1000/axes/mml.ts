/**
 * M: MML edges. M = 40 * log10(1 + U) / log10(1 + 3.65e9), U = USD-days of outstanding obligations between
 * UNAFFILIATED entities on a public J (secured part x1, unsecured debt x0.5). Owner decision 2026-10-11: a payment
 * routed through a hub counts once, on the commercial edge; operator, hub, MM and test entities are excluded.
 */
import { gap, round, type Axis } from '../model';
import { readJsonAt, type Repo } from '../repo';

const TARGET_USD_DAYS = 3.65e9;
const LEDGER_FILE = 'docs/evidence/mml/unaffiliated-edges.json';

type MmlEdge = Readonly<{
  jurisdictionId: string;
  leftEntityId: string;
  rightEntityId: string;
  affiliated: boolean;
  isHubOrOperatorEdge: boolean;
  securedUsd: number;
  unsecuredUsd: number;
  daysOutstanding: number;
}>;

type MmlLedger = Readonly<{
  sourceSha?: string;
  edges?: readonly MmlEdge[];
}>;

const computeUsdDays = (ledger: MmlLedger | null): number => {
  if (!ledger?.edges) return 0;
  return ledger.edges
    .filter(edge => !edge.affiliated && !edge.isHubOrOperatorEdge && edge.daysOutstanding > 0)
    .reduce(
      (sum, edge) =>
        sum + (Math.max(0, edge.securedUsd) + 0.5 * Math.max(0, edge.unsecuredUsd)) * edge.daysOutstanding,
      0,
    );
};

export const measureMml = (repo?: Repo): Axis => {
  const ledger = repo ? readJsonAt<MmlLedger>(repo, LEDGER_FILE) : null;
  const usdDays = round(computeUsdDays(ledger), 2);
  const score = 40 * (Math.log10(1 + usdDays) / Math.log10(1 + TARGET_USD_DAYS));
  const raw = {
    unaffiliatedUsdDays: usdDays,
    ledgerFile: LEDGER_FILE,
    counted: 'outstanding |delta| between unaffiliated entities; never volume, limits or hub hops',
  };
  const gaps = [gap('M', `outstanding obligations between unaffiliated entities (${String(usdDays)} USD-days)`, 40 - score)];
  return {
    id: 'M',
    name: 'MML edges (unaffiliated)',
    weight: 40,
    score,
    ceiling: score,
    sub: { usdDays: score / 40 },
    gaps,
    vetoes: [],
    raw,
  };
};
