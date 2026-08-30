import { layoutHltTpsChart } from '../../../../core/qa/hlt/hlt-dashboard-preview';
import { formatMs, formatTps, type HltDashboardPayload } from '../../../src/lib/qa/hlt';

function PaymentResult({ snapshot }: Readonly<{ snapshot: HltDashboardPayload }>) {
  const payment = snapshot.payment;
  if (!payment) return null;
  const stages = [
    { label: 'Started', value: payment.submittedPayments },
    { label: 'H1 accepted', value: payment.acceptedPayments },
    { label: 'Completed', value: payment.completedPayments },
    { label: 'ACK drained', value: payment.drainedPayments },
  ];
  const maximum = Math.max(1, ...stages.map(stage => stage.value));
  return (
    <section className="ops-hlt-result-block" data-testid="hlt-payment-result">
      <header><span>PAYMENT RESULT</span><h2 data-testid="hlt-result-tps">{formatTps(payment.deliveredTps)}</h2><p>Delivered payment TPS</p></header>
      <div className="ops-hlt-result-stats">
        <article><span>H1 frames</span><strong data-testid="hlt-result-frames">{payment.hubFrames}</strong></article>
        <article><span>Pays / frame</span><strong>{payment.paymentsPerFrame.toFixed(1)}</strong></article>
        <article><span>Wall</span><strong>{formatMs(payment.elapsedMs)}</strong></article>
        <article><span>Source p95 / max</span><strong>{payment.sourceDispatchP95Ms} / {payment.sourceDispatchMaxMs}ms</strong></article>
        <article><span>ACK max</span><strong>{payment.sourceAckMaxMs}ms</strong></article>
      </div>
      <div className="ops-hlt-pipeline" data-testid="hlt-payment-pipeline">
        {stages.map(stage => (
          <div key={stage.label}><span>{stage.label}</span><i><b style={{ width: `${(stage.value / maximum) * 100}%` }} /></i><strong>{stage.value}</strong></div>
        ))}
      </div>
    </section>
  );
}

function SwapResult({ snapshot }: Readonly<{ snapshot: HltDashboardPayload }>) {
  const swap = snapshot.swap;
  if (!swap) return null;
  return (
    <section className="ops-hlt-result-block" data-testid="hlt-swap-result">
      <header><span>SWAP RESULT</span><h2>{formatTps(swap.matchedTps)}</h2><p>Matched economic swaps</p></header>
      <div className="ops-hlt-result-stats">
        <article><span>Settled TPS</span><strong>{formatTps(swap.fullySettledTps)}</strong></article>
        <article><span>Hub frames</span><strong>{swap.hubFrames}</strong></article>
        <article><span>Settled wall</span><strong>{formatMs(swap.fullySettledElapsedMs)}</strong></article>
        <article><span>STP</span><strong data-testid="hlt-swap-stp">{swap.stp}</strong></article>
        <article><span>Source p95 / max</span><strong>{swap.sourceDispatchP95Ms} / {swap.sourceDispatchMaxMs}ms</strong></article>
      </div>
    </section>
  );
}

function ReplayResult({ snapshot }: Readonly<{ snapshot: HltDashboardPayload }>) {
  if (!snapshot.replay) return null;
  return (
    <section className="ops-hlt-panel" data-testid="hlt-replay-result">
      <header><span>EXACT H1 REPLAY</span><h2>State + ordered outbox equivalent</h2></header>
      <div className="ops-hlt-trials">
        {snapshot.replay.trials.map((trial, index) => (
          <article key={`${trial.offeredTps}:${index}`}>
            <span>{trial.offeredTps === null ? 'MAX THROUGHPUT' : `OFFERED ${trial.offeredTps}/S`}</span>
            <strong>{formatTps(trial.accountTxTps)}</strong>
            <p>{trial.frames} frames · {trial.outboxEnvelopes} outbox · pending {trial.finalPendingOutbox}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function PerformanceResult({ snapshot }: Readonly<{ snapshot: HltDashboardPayload }>) {
  const maximum = Math.max(1, ...snapshot.perf.rows.map(row => row.totalMs));
  return (
    <section className="ops-hlt-panel" data-testid="hlt-perf">
      <header><span>PROCESS PROFILES</span><h2>Hottest functions</h2></header>
      {snapshot.perf.rows.length === 0 ? <p className="ops-hlt-empty">No profile lines. Enable hub profiles for the next run.</p> : (
        <div className="ops-hlt-perf-list">
          {snapshot.perf.rows.map((row, index) => (
            <div data-testid="hlt-perf-row" key={`${row.runtime}:${row.metric}:${index}`}>
              <span style={{ width: `${(row.totalMs / maximum) * 100}%` }} />
              <p><strong>{row.runtime} / {row.metric}</strong><small>n={row.count} · avg {row.avgMs.toFixed(1)}ms · p95 {row.p95Ms.toFixed(1)}ms</small></p>
              <b>{row.totalMs.toFixed(0)}ms</b>
            </div>
          ))}
        </div>
      )}
      {snapshot.hubPerf.length > 0 ? (
        <div className="ops-hlt-hub-perf" data-testid="hlt-hub-perf">
          {snapshot.hubPerf.map(hub => <span key={hub.hubLabel}>{hub.hubLabel} · avg {hub.processAvgMs.toFixed(1)}ms {hub.cpuTps === null ? '' : `· ${formatTps(hub.cpuTps)}`}</span>)}
        </div>
      ) : null}
    </section>
  );
}

function ProgressLedger({ snapshot }: Readonly<{ snapshot: HltDashboardPayload }>) {
  const chart = layoutHltTpsChart(snapshot.ledger);
  return (
    <section className="ops-hlt-panel" data-testid="hlt-ledger">
      <header><span>AUTHORITATIVE HISTORY</span><h2>Progress to 1000/s</h2></header>
      <div className="ops-hlt-chart-wrap">
        <svg aria-label="HLT TPS history" role="img" viewBox={`0 0 ${chart.width} ${chart.height}`}>
          {chart.yTicks.map(tick => <g key={tick.value}><text x="8" y={tick.y + 4}>{tick.label}</text><line x1="44" x2={chart.width - 18} y1={tick.y} y2={tick.y} /></g>)}
          <path d={chart.payPath} /><path className="is-swap" d={chart.swapPath} />
          {chart.payPoints.map((point, index) => <circle cx={point.x} cy={point.y} key={`pay:${index}`} r="4" />)}
          {chart.swapPoints.map((point, index) => <circle className="is-swap" cx={point.x} cy={point.y} key={`swap:${index}`} r="3.5" />)}
        </svg>
      </div>
      <div className="ops-hlt-ledger-list">
        {[...snapshot.ledger].reverse().slice(0, 8).map(run => (
          <article data-status={run.status} data-testid="hlt-ledger-row" key={`${run.at}:${run.commit}`}>
            <span>{run.status}</span><div><h3>{run.headline}</h3><p>{formatTps(run.paymentsTps)} pay · {formatTps(run.swapsTps)} swap · {run.users} users · {run.commit}</p></div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function OpsHltProgress({ snapshot }: Readonly<{ snapshot: HltDashboardPayload | null }>) {
  if (!snapshot || (!snapshot.payment && !snapshot.swap && !snapshot.replay && snapshot.ledger.length === 0)) {
    return <section className="ops-hlt-empty-state"><span>NO RESULT</span><h2>Record or replay an isolated shard.</h2><p>Progress evidence appears only after the HLT endpoint reports a completed run.</p></section>;
  }
  return (
    <div className="ops-hlt-progress" data-testid="hlt-progress-view">
      <PaymentResult snapshot={snapshot} /><SwapResult snapshot={snapshot} /><ReplayResult snapshot={snapshot} />
      <PerformanceResult snapshot={snapshot} /><ProgressLedger snapshot={snapshot} />
    </div>
  );
}
