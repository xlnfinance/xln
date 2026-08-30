import type { Dispatch, SetStateAction } from 'react';
import type { HltDashboardPreview } from '../../../../core/qa/hlt/hlt-dashboard-preview';
import {
  readOpsHltHubs,
  readOpsHltMode,
  readOpsHltReplayMode,
  type OpsHltControlState,
  type OpsHltPhase,
} from './ops-hlt-model';

type SetControls = Dispatch<SetStateAction<OpsHltControlState>>;

const integerValue = (value: string, code: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
};

function patchControl<K extends keyof OpsHltControlState>(
  setControls: SetControls,
  key: K,
  value: OpsHltControlState[K],
): void {
  setControls(current => ({ ...current, [key]: value }));
}

export function OpsHltControls({ controls, setControls, preview, busy, runActive, onStart }: Readonly<{
  controls: OpsHltControlState;
  setControls: SetControls;
  preview: HltDashboardPreview;
  busy: boolean;
  runActive: boolean;
  onStart: (phase: OpsHltPhase) => void;
}>) {
  const runtimeProcessCount = Math.ceil(controls.users / preview.config.runtimesPerProcess);
  return (
    <div className="ops-hlt-control" data-testid="hlt-control-view">
      <section className="ops-hlt-run-modes">
        <article>
          <div><span>01 / RECORD</span><h2>Live shard + exact H1 inputs</h2><p>Run sovereign users, drain Account ACKs, and persist the authoritative recording.</p></div>
          <button data-testid="hlt-record" disabled={busy || runActive} onClick={() => onStart('build')} type="button">
            {busy ? 'Starting…' : 'Start record'}
          </button>
        </article>
        <article>
          <div><span>02 / REPLAY</span><h2>Deterministic H1 replay</h2><p>Replay saved inputs without users and verify identical state plus ordered outbox.</p></div>
          <div className="ops-hlt-replay-actions">
            <label>Mode
              <select
                data-testid="hlt-replay-mode"
                onChange={event => patchControl(setControls, 'replayMode', readOpsHltReplayMode(event.currentTarget.value))}
                value={controls.replayMode}
              >
                <option value="max">Max throughput</option><option value="fixed">Fixed 1000 TPS</option><option value="sweep">Saturation sweep</option>
              </select>
            </label>
            <button data-testid="hlt-replay" disabled={busy || runActive} onClick={() => onStart('replay')} type="button">
              {busy ? 'Starting…' : 'Start replay'}
            </button>
          </div>
          {controls.replayMode === 'sweep' ? (
            <label className="ops-hlt-rates">Offered TPS points
              <input data-testid="hlt-replay-rates" onChange={event => patchControl(setControls, 'replayRates', event.currentTarget.value)} value={controls.replayRates} />
            </label>
          ) : null}
        </article>
      </section>

      <section className="ops-hlt-config">
        <header><span>CONFIGURATION</span><h2>Population and workload</h2><p>Preview changes locally. Starting a run submits the exact visible values.</p></header>
        <div className="ops-hlt-fields">
          <label>Users total <strong data-testid="hlt-users">{controls.users}</strong>
            <input data-testid="hlt-users-input" max="1000" min="2" onChange={event => patchControl(setControls, 'users', integerValue(event.currentTarget.value, 'OPS_HLT_USERS_INVALID'))} step="2" type="range" value={controls.users} />
          </label>
          <div className="ops-hlt-packing" data-testid="hlt-runtime-packing"><span>Runtime processes</span><strong>{runtimeProcessCount}</strong><small>{preview.config.runtimesPerProcess} users per OS process</small></div>
          <label>Actions / user / s <strong>{controls.ratePerUserPerSecond}</strong>
            <input max="10" min="1" onChange={event => patchControl(setControls, 'ratePerUserPerSecond', integerValue(event.currentTarget.value, 'OPS_HLT_RATE_INVALID'))} type="range" value={controls.ratePerUserPerSecond} />
          </label>
          <label>Duration seconds <strong>{controls.durationSeconds}</strong>
            <input max="60" min="1" onChange={event => patchControl(setControls, 'durationSeconds', integerValue(event.currentTarget.value, 'OPS_HLT_DURATION_INVALID'))} type="range" value={controls.durationSeconds} />
          </label>
          <label>Workload
            <select data-testid="hlt-mode" onChange={event => patchControl(setControls, 'mode', readOpsHltMode(event.currentTarget.value))} value={controls.mode}>
              <option value="payments">Payments</option><option value="same">Same-J swaps</option><option value="mixed">Pay + swap</option><option value="cross">Cross-J swaps</option>
            </select>
          </label>
          <label>Hubs
            <select data-testid="hlt-hubs" onChange={event => patchControl(setControls, 'hubs', readOpsHltHubs(event.currentTarget.value))} value={controls.hubs}>
              <option value="H1">H1</option><option value="H1,H2">H1,H2</option><option value="H1,H2,H3">H1,H2,H3</option>
            </select>
          </label>
          <label>Payment minimum <strong>{controls.paymentAmountMin}</strong>
            <input data-testid="hlt-payment-amount-min-input" max="10000" min="1" onChange={event => {
              const paymentAmountMin = integerValue(event.currentTarget.value, 'OPS_HLT_PAYMENT_MIN_INVALID');
              setControls(current => ({ ...current, paymentAmountMin, paymentAmountMax: Math.max(current.paymentAmountMax, paymentAmountMin) }));
            }} type="range" value={controls.paymentAmountMin} />
          </label>
          <label>Payment maximum <strong>{controls.paymentAmountMax}</strong>
            <input data-testid="hlt-payment-amount-max-input" max="10000" min="1" onChange={event => {
              const paymentAmountMax = integerValue(event.currentTarget.value, 'OPS_HLT_PAYMENT_MAX_INVALID');
              setControls(current => ({ ...current, paymentAmountMax: Math.max(current.paymentAmountMin, paymentAmountMax) }));
            }} type="range" value={controls.paymentAmountMax} />
          </label>
          <label className="ops-hlt-check"><input checked={controls.profile} onChange={event => patchControl(setControls, 'profile', event.currentTarget.checked)} type="checkbox" />Hub profiles</label>
        </div>
      </section>

      <section className="ops-hlt-preview" aria-label="HLT preview metrics">
        <article><span>Daemons</span><strong data-testid="hlt-daemons">{preview.daemons}</strong></article>
        <article><span>Pay / s offered</span><strong data-testid="hlt-offered-pay">{preview.offeredPayPerSecond}/s</strong></article>
        <article><span>Swap / s offered</span><strong data-testid="hlt-offered-swap">{preview.offeredSwapPerSecond}/s</strong></article>
        <article><span>Rounds</span><strong>{preview.rounds}</strong></article>
      </section>

      <section className="ops-hlt-routing">
        <div><span style={{ width: `${preview.hubShare.workerSingleHubPct}%` }} /><i style={{ width: `${preview.hubShare.workerMultiHubPct}%` }} /></div>
        <p>{preview.hubShare.note}</p><strong>{preview.warning}</strong>
      </section>
      <pre className="ops-hlt-command" data-testid="hlt-command">{preview.isolatedCommand}</pre>
    </div>
  );
}
