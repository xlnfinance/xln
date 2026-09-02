import type { CSSProperties } from 'react';

import {
  formatQuorumDate,
  quorumColorFor,
  quorumVerdictLabel,
  shortQuorumSha,
} from '../../../packages/runtime-client/src/qa-quorum-model';
import type { QuorumInteraction, QuorumView } from '../../../packages/runtime-client/src/qa-quorum-types';

const modelStyle = (model: string): CSSProperties => ({ '--quorum-model': quorumColorFor(model) } as CSSProperties);

function SelectedInteraction({ selected }: Readonly<{ selected: QuorumInteraction | null }>) {
  return <article className="ops-quorum-detail" data-testid="quorum-selected-interaction">
    <header><div><span>SELECTED INTERACTION</span><h2>{selected?.model ?? '—'}</h2></div>
      {selected ? <strong className={`ops-quorum-verdict ${selected.verdict}`}>{quorumVerdictLabel(selected.verdict)}</strong> : null}
    </header>
    {selected ? <>
      <div className="ops-quorum-score"><strong>{selected.score}</strong><span>/1000<br />auditor score</span></div>
      <h3>{selected.scope}</h3>
      <p>{selected.summary}</p>
      <aside><span>DECISIVE EVIDENCE</span><p>{selected.evidence}</p></aside>
      <dl>
        <div><dt>Observed</dt><dd>{formatQuorumDate(selected.occurredAt)} UTC</dd></div>
        <div><dt>Source</dt><dd>{shortQuorumSha(selected.sourceSha)}</dd></div>
        <div><dt>Session</dt><dd>{selected.sessionId ?? 'not recorded'}</dd></div>
        <div><dt>Response</dt><dd>{selected.responseMinutes === undefined ? 'not recorded' : `${selected.responseMinutes} min`}</dd></div>
        <div><dt>Impact</dt><dd>{selected.verifiedImpact ?? 0}</dd></div>
        <div><dt>Missed before discovery</dt><dd>{selected.missedHours === undefined ? '—' : `${selected.missedHours} h`}</dd></div>
      </dl>
    </> : null}
  </article>;
}

function ModelLeaderboard({ onSelect, view }: Readonly<{
  onSelect: (id: string) => void;
  view: QuorumView;
}>) {
  return <article className="ops-quorum-leaders">
    <header><div><span>MODEL LEADERBOARD</span><h2>Verified usefulness</h2></div></header>
    <div className="ops-quorum-leader-table">
      <div className="ops-quorum-leader-row is-header"><span>Model</span><span>Score</span><span>Verified</span><span>Impact</span><span>Median</span></div>
      {view.modelGroups.map((item, index) => <button
        className="ops-quorum-leader-row"
        key={item.model}
        onClick={() => {
          const latest = item.entries.at(-1);
          if (latest) onSelect(latest.id);
        }}
        type="button"
      >
        <span><b>{index + 1}</b><i style={modelStyle(item.model)} />{item.model}<small>{item.interactions} answers</small></span>
        <strong data-label="Score">{item.averageScore}</strong><span data-label="Verified">{item.verifiedRate}%</span>
        <span data-label="Impact">{item.verifiedImpact}</span>
        <span data-label="Median">{item.medianResponseMinutes === null ? '—' : `${item.medianResponseMinutes}m`}</span>
      </button>)}
    </div>
  </article>;
}

function ReviewChains({ onSelect, view }: Readonly<{
  onSelect: (id: string) => void;
  view: QuorumView;
}>) {
  return <section className="ops-quorum-chains">
    <header><div><span>REVIEW CHAINS</span><h2>Who challenged what</h2></div>
      <p>Only explicit follow-up audits are connected. Missing links remain missing.</p></header>
    {view.reviewChains.length === 0 ? <div className="ops-quorum-empty compact">No explicit review chains match this filter.</div> :
      view.reviewChains.map(chain => <button key={chain.challenger.id} onClick={() => onSelect(chain.challenger.id)} type="button">
        <span><i style={modelStyle(chain.challenged.model)} /><b>{chain.challenged.model}</b><small>{chain.challenged.score}/1000 · {chain.challenged.scope}</small></span>
        <em>challenged by →</em>
        <span><i style={modelStyle(chain.challenger.model)} /><b>{chain.challenger.model}</b><small>{chain.challenger.score}/1000 · {chain.challenger.scope}</small></span>
      </button>)}
  </section>;
}

const WEIGHTS = [
  ['400', 'Claim accuracy', 'Every material statement survives direct code inspection.'],
  ['250', 'Real impact', 'Live TPS, reproduced bug, or deleted complexity—not a theoretical percentage.'],
  ['150', 'Evidence', 'Exact path, input, frame, profile, test, SHA and session.'],
  ['100', 'Speed', 'Time from question to actionable verified answer.'],
  ['100', 'Low noise', 'Few false positives, duplicate ideas or protocol misunderstandings.'],
] as const;

function ScoringContract() {
  return <section className="ops-quorum-method">
    <header><span>SCORING CONTRACT</span><h2>How the 1000 points are earned</h2></header>
    <div>{WEIGHTS.map(([weight, title, detail]) => <article key={title}>
      <strong>{weight}</strong><span>{title}</span><p>{detail}</p>
    </article>)}</div>
  </section>;
}

export function OpsQuorumEvidence({ onSelect, view }: Readonly<{
  onSelect: (id: string) => void;
  view: QuorumView;
}>) {
  return <>
    <section className="ops-quorum-split">
      <SelectedInteraction selected={view.selected} />
      <ModelLeaderboard onSelect={onSelect} view={view} />
    </section>
    <ReviewChains onSelect={onSelect} view={view} />
    <ScoringContract />
  </>;
}
