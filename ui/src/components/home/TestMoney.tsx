import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditLimitFullError } from '../../runtime/financial/credit-limit';
import { useApp } from '../../runtime/store';
import type { WalletView } from '../../runtime/views';
import { requireAdapter } from '../../runtime/adapter';
import { receiveTestMoney } from '../../runtime/financial/test-money';
import { getTokenMeta } from '../../runtime/token-meta';

/** Test-credit consent stays beside the action; success requires committed funds. */
export function TestMoney({ wallet }: { wallet: WalletView }) {
  const commandReady = useApp(state => state.commandReady);
  const { symbol } = getTokenMeta(1);
  const hub = wallet.accounts.find(account => account.isHub && !account.disputed);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [limitAccountId, setLimitAccountId] = useState('');
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const receive = async () => {
    if (busy || !hub || !requireAdapter().commandReady) return;
    setBusy(true);
    setError('');
    setLimitAccountId('');
    setDone(false);
    try {
      await receiveTestMoney(wallet, setStage);
      setDone(true);
      setStage('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof CreditLimitFullError) setLimitAccountId(failure.accountId);
      setStage('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="test-money" aria-label="Test money faucet">
      <div className="test-money-intro">
        <span className="test-money-label">Testnet faucet</span>
        <span className="note">For trying payments · no real value</span>
      </div>
      <button
        type="button"
        className="btn primary sm"
        disabled={busy || !hub || !commandReady}
        onClick={() => void receive()}
        data-testid="home-faucet"
        aria-label={`Get 100 test ${symbol}`}
      >
        {busy ? stage || 'Receiving…' : `Get 100 test ${symbol}`}
      </button>
      {hub && (
        <details className="disclosure">
          <summary>How test money works</summary>
          <p className="note">
            Each click sends 100 {symbol} of test money from {hub.label}. It arrives on the credit limit you extend to{' '}
            {hub.label} and never changes that limit.
          </p>
        </details>
      )}
      {done && (
        <span role="status" data-testid="test-money-status">
          100 {symbol} received
        </span>
      )}
      {!hub && (
        <p role="status">
          {wallet.accounts.some(account => account.isHub && account.disputed)
            ? wallet.accounts.some(account => account.isHub && account.disputed && account.dispute !== 'closed')
              ? 'Your hub account is frozen by a dispute. Connect another hub below to receive test money.'
              : 'Your hub account is closed after a dispute. Connect another hub below to receive test money.'
            : 'Connecting your hub account…'}
        </p>
      )}
      {error && limitAccountId && (
        <p role="alert" data-testid="test-money-limit-full">
          {error}{' '}
          <button type="button" className="btn sm" onClick={() => navigate(`/accounts/${limitAccountId}`)} data-testid="test-money-raise-limit">
            Raise limit
          </button>
        </p>
      )}
      {error && !limitAccountId && <p role="alert">{error} Check your balance before trying again.</p>}
    </section>
  );
}
