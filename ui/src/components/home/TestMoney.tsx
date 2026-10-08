import { useState } from 'react';
import { useApp } from '../../runtime/store';
import type { WalletView } from '../../runtime/views';
import { requireAdapter } from '../../runtime/adapter';
import { receiveTestMoney } from '../../runtime/financial/test-money';

/** Test-credit consent stays beside the action; success requires committed funds. */
export function TestMoney({ wallet }: { wallet: WalletView }) {
  const commandReady = useApp(state => state.commandReady);
  const setTour = useApp(state => state.setTour);
  const hub = wallet.accounts.find(account => account.isHub && !account.disputed);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const receive = async () => {
    if (busy || !hub || !requireAdapter().commandReady) return;
    setBusy(true);
    setError('');
    setDone(false);
    try {
      await receiveTestMoney(wallet, setStage);
      setDone(true);
      setStage('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStage('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="testmode" aria-label="Test money faucet">
      <span className="testmode-label">Test money</span>
      <span className="note">Try payments with funds that have no real value.</span>
      {hub && (
        <details className="disclosure">
          <summary>How it works</summary>
          <p className="note">
            Each click adds 100 USDC of test money. Existing credit is used first; if needed, this action increases how
            much {hub.label} can owe you without collateral.
          </p>
        </details>
      )}
      <button
        type="button"
        className="btn sm"
        disabled={busy || !hub || !commandReady}
        onClick={() => void receive()}
        data-testid="home-faucet"
        aria-label="Get 100 test USDC"
      >
        {busy ? stage || 'Receiving…' : 'Get 100 USDC'}
      </button>
      <button type="button" className="more" onClick={() => setTour({ active: true, index: 0 })}>
        Tour
      </button>
      {done && (
        <span role="status" data-testid="test-money-status">
          100 USDC received
        </span>
      )}
      {!hub && <p role="status">Connecting your hub account…</p>}
      {error && <p role="alert">{error} Check your balance before trying again.</p>}
    </section>
  );
}
