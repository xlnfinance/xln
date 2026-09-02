import type { CSSProperties, KeyboardEvent } from 'react';

import {
  formatQuorumDate,
  quorumChartX,
  quorumChartY,
  quorumColorFor,
} from '../../../packages/runtime-client/src/qa-quorum-model';
import type { QuorumInteraction, QuorumView } from '../../../packages/runtime-client/src/qa-quorum-types';

const TICKS = [0, 250, 500, 750, 1_000] as const;
const modelStyle = (model: string): CSSProperties => ({ '--quorum-model': quorumColorFor(model) } as CSSProperties);

const selectWithKeyboard = (
  event: KeyboardEvent<SVGGElement>,
  entry: QuorumInteraction,
  onSelect: (id: string) => void,
): void => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onSelect(entry.id);
};

export function OpsQuorumChart({ onSelect, view }: Readonly<{
  onSelect: (id: string) => void;
  view: QuorumView;
}>) {
  if (view.interactions.length === 0) {
    return <div className="ops-quorum-empty">No verified interactions match this filter.</div>;
  }
  return <>
    <svg aria-label="Model response score over time" className="ops-quorum-chart" role="img" viewBox="0 0 1000 420">
      <defs>
        <linearGradient id="opsQuorumPlotGlow" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#e3ad3c" stopOpacity="0.11" />
          <stop offset="1" stopColor="#e3ad3c" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect fill="url(#opsQuorumPlotGlow)" height="320" rx="4" width="886" x="72" y="50" />
      {TICKS.map(tick => <g key={tick}>
        <line className="ops-quorum-grid-line" x1="72" x2="958" y1={370 - tick * 0.32} y2={370 - tick * 0.32} />
        <text className="ops-quorum-axis" textAnchor="end" x="58" y={375 - tick * 0.32}>{tick}</text>
      </g>)}
      {view.modelGroups.map(group => <g key={group.model}>
        {group.entries.length > 1 ? <polyline
          fill="none"
          points={group.entries.map(entry => `${quorumChartX(entry, view)},${quorumChartY(entry)}`).join(' ')}
          stroke={quorumColorFor(group.model)}
          strokeOpacity="0.34"
          strokeWidth="2"
        /> : null}
        {group.entries.map(entry => <g
          aria-label={`Select ${entry.model}, score ${entry.score}`}
          className={entry.id === view.selected?.id ? 'is-selected' : undefined}
          key={entry.id}
          onClick={() => onSelect(entry.id)}
          onKeyDown={event => selectWithKeyboard(event, entry, onSelect)}
          role="button"
          tabIndex={0}
        >
          <circle
            className={`ops-quorum-point ${entry.verdict}`}
            cx={quorumChartX(entry, view)}
            cy={quorumChartY(entry)}
            fill={quorumColorFor(entry.model)}
            r={5 + Math.min(9, Math.sqrt(entry.verifiedImpact ?? 0))}
          />
          <title>{entry.model} · {entry.score}/1000 · {entry.scope}</title>
        </g>)}
      </g>)}
      <text className="ops-quorum-axis" x="72" y="405">{formatQuorumDate(view.minTime)}</text>
      <text className="ops-quorum-axis" textAnchor="end" x="958" y="405">{formatQuorumDate(view.maxTime)}</text>
    </svg>
    <div aria-label="Recent model scores over time" className="ops-quorum-mobile-timeline">
      {view.recentInteractions.map(entry => <button key={entry.id} onClick={() => onSelect(entry.id)} type="button">
        <span><i style={modelStyle(entry.model)} /><b>{entry.model}</b><small>{formatQuorumDate(entry.occurredAt)}</small></span>
        <strong>{entry.score}</strong>
      </button>)}
    </div>
  </>;
}
