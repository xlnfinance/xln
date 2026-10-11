/**
 * M: MML edges. M = 40 * log10(1 + U) / log10(1 + 3.65e9), U = USD-days of outstanding obligations between
 * UNAFFILIATED entities on a public J (secured part x1, unsecured debt x0.5). Owner decision 2026-10-11: a payment
 * routed through a hub counts once, on the commercial edge; operator, hub, MM and test entities are excluded.
 * The data source is TBD (no indexer collector exists), so U is 0 by definition, not by measurement.
 */
import { gap, type Axis } from '../model';

const TARGET_USD_DAYS = 3.65e9;

export const measureMml = (): Axis => {
  const usdDays = 0;
  const score = 40 * (Math.log10(1 + usdDays) / Math.log10(1 + TARGET_USD_DAYS));
  const raw = {
    unaffiliatedUsdDays: usdDays,
    dataSource: 'TBD: needs an indexer collector plus an affiliation registry',
    counted: 'outstanding |delta| between unaffiliated entities; never volume, limits or hub hops',
  };
  const gaps = [gap('M', 'outstanding obligations between unaffiliated entities (data source TBD)', 40 - score)];
  return {
    id: 'M',
    name: 'MML edges (unaffiliated)',
    weight: 40,
    score,
    ceiling: score,
    sub: { usdDays: 0 },
    gaps,
    vetoes: [],
    raw,
  };
};
