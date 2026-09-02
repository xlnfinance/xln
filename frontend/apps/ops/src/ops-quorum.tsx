import { useMemo, useState, type CSSProperties } from 'react';

import {
  buildQuorumView,
  quorumColorFor,
  readQuorumCategoryFilter,
  readQuorumRange,
} from '../../../packages/runtime-client/src/qa-quorum-model';
import type { QuorumCategoryFilter, QuorumRange } from '../../../packages/runtime-client/src/qa-quorum-types';
import { OpsQuorumChart } from './ops-quorum-chart';
import { OpsQuorumEvidence } from './ops-quorum-evidence';
import { OPS_QUORUM_INTERACTIONS } from './ops-quorum-source';
import { OpsShell } from './ops-shell';
import './styles/ops-quorum.css';

const INITIAL_SELECTION = 'fable-wire-fit-20260822';
const modelStyle = (model: string): CSSProperties => ({ '--quorum-model': quorumColorFor(model) } as CSSProperties);

export function OpsQuorumPage() {
  const [range, setRange] = useState<QuorumRange>('all');
  const [category, setCategory] = useState<QuorumCategoryFilter>('all');
  const [selectedId, setSelectedId] = useState(INITIAL_SELECTION);
  const view = useMemo(
    () => buildQuorumView(OPS_QUORUM_INTERACTIONS, { range, category, selectedId }),
    [category, range, selectedId],
  );
  const hitRate = view.interactions.length === 0 ? 0 : Math.round(100 * view.verified / view.interactions.length);

  return <OpsShell activePath="/qa/quorum">
    <div className="ops-quorum" data-testid="quorum-dashboard">
      <header className="ops-quorum-hero">
        <div>
          <a href="/qa/hlt">← QA / HLT</a>
          <span>QA · QUORUM INTELLIGENCE</span>
          <h1>Who actually finds the bottleneck?</h1>
          <p>Every point is scored by the primary auditor after code, test, or live-profile verification. Self-reported confidence is ignored.</p>
        </div>
        <form aria-label="Quorum filters" onSubmit={event => event.preventDefault()}>
          <label>Window<select aria-label="Window" onChange={event => setRange(readQuorumRange(event.currentTarget.value))} value={range}>
            <option value="7d">7 days</option><option value="30d">30 days</option><option value="all">All time</option>
          </select></label>
          <label>Work<select aria-label="Work" onChange={event => setCategory(readQuorumCategoryFilter(event.currentTarget.value))} value={category}>
            <option value="all">All categories</option><option value="performance">Performance</option>
            <option value="security">Security</option><option value="protocol">Protocol</option><option value="reliability">Reliability</option>
          </select></label>
        </form>
      </header>

      <section aria-label="Quorum summary" className="ops-quorum-metrics">
        <article><span>Audited answers</span><strong>{view.interactions.length}</strong><small>{view.summaries.length} models</small></article>
        <article><span>Verified</span><strong>{view.verified}</strong><small>{hitRate}% hit rate</small></article>
        <article><span>Average score</span><strong>{view.averageScore}</strong><small>of 1000</small></article>
        <article><span>Verified impact</span><strong>{view.verifiedImpact}</strong><small>weighted evidence points</small></article>
      </section>

      <section className="ops-quorum-plot">
        <header>
          <div><span>AUDITOR SCORE OVER TIME</span><h2>Evidence beats eloquence</h2></div>
          <div className="ops-quorum-legend">{view.modelGroups.map(group => <span key={group.model}>
            <i style={modelStyle(group.model)} />{group.model}
          </span>)}</div>
        </header>
        <OpsQuorumChart onSelect={setSelectedId} view={view} />
      </section>
      <OpsQuorumEvidence onSelect={setSelectedId} view={view} />
    </div>
  </OpsShell>;
}
