import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LoadTestScheduler,
  type LoadTestSchedulerSnapshot,
} from '@xln/frontend/lib/components/Entity/account/load-testing-scheduler';
import type { BookView } from '../../../runtime/financial/orderbook';
import { getEmbeddedEnv } from '../../../runtime/adapter';
import { useApp } from '../../../runtime/store';
import { peekXLN } from '../../../runtime/xln-loader';
import { createWalletLoadController } from './runtime';
import { LoadMarket } from './Market';

const emptyLane = () => ({ attempted: 0, submitted: 0, skipped: 0, failed: 0, stpPrevented: 0 });
const initial = (): LoadTestSchedulerSnapshot => ({
  running: false,
  draining: false,
  elapsedSeconds: 0,
  metrics: { pay: emptyLane(), swap: emptyLane() },
  lastResult: { pay: '', swap: '' },
});

export function LoadTestingPanel({ entityId, signerId, hubId }: { entityId: string; signerId: string; hubId: string }) {
  const [payRate, setPayRate] = useState(1);
  const [swapRate, setSwapRate] = useState(1);
  const [duration, setDuration] = useState(10);
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState('');
  const scheduler = useRef<LoadTestScheduler | null>(null);
  const books = useRef(new Map<string, BookView>());
  const external = useApp(s => s.externalWallet);
  const status = useApp(s => s.adapterStatus);
  const vaultId = useApp(s => s.activeVaultId);
  const activeEntityId = useApp(s => s.activeEntityId);
  const ready =
    status === 'connected' &&
    activeEntityId === entityId &&
    Boolean(getEmbeddedEnv()) &&
    external?.owner.toLowerCase() === signerId.toLowerCase();
  const onBook = useCallback((pairId: string, book: BookView | null) => {
    if (book) books.current.set(pairId, book);
    else books.current.delete(pairId);
  }, []);
  useEffect(() => {
    if (!getEmbeddedEnv()) return;
    let mounted = true;
    const controller = createWalletLoadController({
      entityId,
      signerId,
      hubId,
      bestSwapLevel: (hub, pair, side) => {
        const book = books.current.get(pair);
        if (
          hub !== hubId ||
          !book ||
          book.status !== 'live' ||
          book.pairId !== pair ||
          (book.source === 'relay' && Date.now() - book.updatedAt > 15_000)
        )
          return null;
        return (side === 0 ? book.bids : book.asks)[0] ?? null;
      },
    });
    const next = new LoadTestScheduler({
      now: Date.now,
      random: Math.random,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: timer => clearTimeout(timer),
      attempt: (lane, signal) =>
        controller.current()
          ? controller.attempt(lane, signal)
          : Promise.resolve({ status: 'skipped', reason: 'Wallet snapshot is unavailable' }),
      onSnapshot: value => {
        if (mounted) setSnapshot(value);
      },
    });
    scheduler.current = next;
    setSnapshot(initial());
    return () => {
      next.stop();
      mounted = false;
      scheduler.current = null;
    };
  }, [entityId, signerId, hubId, vaultId]);
  useEffect(() => {
    if (!ready) scheduler.current?.stop();
  }, [ready]);
  const pairs =
    peekXLN()
      ?.getDefaultSwapTradingPairs()
      .filter(pair => pair.baseTokenId === 1 || pair.quoteTokenId === 1) ?? [];
  const disabled = !ready || snapshot.running || snapshot.draining;
  const total = (name: 'attempted' | 'submitted' | 'skipped' | 'failed') =>
    snapshot.metrics.pay[name] + snapshot.metrics.swap[name];
  const metrics = {
    Attempted: total('attempted'),
    Submitted: total('submitted'),
    Skipped: total('skipped'),
    Failed: total('failed'),
    STP: snapshot.metrics.swap.stpPrevented,
  };
  const start = () => {
    try {
      if (!scheduler.current) throw new Error('LOAD_TEST_WALLET_UNAVAILABLE');
      scheduler.current.start({
        durationMinutes: duration,
        pay: { enabled: true, rate: payRate },
        swap: { enabled: true, rate: swapRate },
      });
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <section
      className="stack"
      data-testid="account-load-testing-panel"
      aria-labelledby="load-testing-title"
      style={{ minWidth: 0 }}
    >
      {pairs.map(pair => (
        <LoadMarket
          key={`${vaultId}:${entityId}:${hubId}:${pair.baseTokenId}/${pair.quoteTokenId}`}
          hubId={hubId}
          entityId={entityId}
          {...pair}
          onBook={onBook}
        />
      ))}
      <h3 id="load-testing-title">Load Testing</h3>
      <p className="note">
        Sends payments and swaps using available routes. Start uses your current wallet; Stop prevents new commands.
        Submitted commands may still settle.
      </p>
      {!ready ? <p role="status">Open a local wallet with a current asset snapshot to start.</p> : null}
      <label className="field">
        Pay rate · $1–5 each
        <input
          className="input"
          data-testid="load-pay-rate"
          type="number"
          min="0.1"
          max="100"
          step="0.1"
          value={payRate}
          disabled={disabled}
          onChange={event => setPayRate(Number(event.target.value))}
        />
      </label>
      <label className="field">
        Swap rate · $10–15 each
        <input
          className="input"
          data-testid="load-swap-rate"
          type="number"
          min="0.1"
          max="100"
          step="0.1"
          value={swapRate}
          disabled={disabled}
          onChange={event => setSwapRate(Number(event.target.value))}
        />
      </label>
      <label className="field">
        Duration · minutes
        <input
          className="input"
          data-testid="load-duration"
          type="number"
          min="1"
          max="100"
          step="1"
          value={duration}
          disabled={disabled}
          onChange={event => setDuration(Number(event.target.value))}
        />
      </label>
      <p className="note">
        0.1–100 attempts/s per lane · 1–100 minutes. Missed capacity and busy lanes are skipped; this is not a settled
        TPS measurement.
      </p>
      {snapshot.running ? (
        <button className="btn" data-testid="load-test-stop" onClick={() => scheduler.current?.stop()}>
          Stop
        </button>
      ) : (
        <button
          className="btn primary"
          data-testid="load-test-start"
          disabled={!ready || snapshot.draining}
          onClick={start}
        >
          {snapshot.draining ? 'Finishing submissions…' : 'Start'}
        </button>
      )}
      <progress
        aria-label="Load test progress"
        aria-valuenow={snapshot.elapsedSeconds}
        aria-valuemin={0}
        aria-valuemax={duration * 60}
        max={duration * 60}
        value={snapshot.elapsedSeconds}
        style={{ width: '100%' }}
      />
      <p className="note">
        {snapshot.elapsedSeconds}s · {snapshot.running ? 'Running' : snapshot.draining ? 'Draining' : 'Stopped'}
      </p>
      {Object.entries(metrics).map(([label, value]) => (
        <div className="kv" key={label}>
          <span>{label}</span>
          <strong className="num">{value.toLocaleString('en-US')}</strong>
        </div>
      ))}
      <p className="note" style={{ overflowWrap: 'anywhere' }}>
        <span data-testid="load-pay-result">Pay: {snapshot.lastResult.pay || 'No attempt yet'}</span>
        <br />
        <span data-testid="load-swap-result">Swap: {snapshot.lastResult.swap || 'No attempt yet'}</span>
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
