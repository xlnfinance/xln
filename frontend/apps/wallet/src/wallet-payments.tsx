import { useEffect, useState, useSyncExternalStore } from 'react';

import { readRuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import { WalletPaymentOperations } from './wallet-payment-operations';
import { WalletPaymentReceive } from './wallet-payment-receive';
import { WalletPaymentSend } from './wallet-payment-send';
import { WalletPaymentSource } from './wallet-payment-source';
import './styles/wallet-payments.css';
import './styles/wallet-payments-responsive.css';

type PaymentTab = 'send' | 'receive' | 'operations';

const shortCommandId = (value: string): string => value ? `…${value}` : '';

function PaymentsUnavailable({
  error,
  message,
  retry,
}: Readonly<{ error: boolean; message: string; retry: () => void }>) {
  return (
    <section className="wallet-payments-unavailable" role={error ? 'alert' : 'status'}>
      <p className="wallet-shell-eyebrow">Command surface unavailable</p>
      <h2>No payment command can be prepared.</h2>
      <p>{message}</p>
      <div>
        {error ? <button onClick={retry} type="button">Retry Runtime connection</button> : null}
        <a href="/app?diagnostics=1">Review diagnostics</a>
      </div>
    </section>
  );
}

export function WalletPayments() {
  const [source] = useState(() => new WalletPaymentSource(
    readRuntimeAdapterStorageSnapshot({ durable: localStorage, session: sessionStorage }),
  ));
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const [tab, setTab] = useState<PaymentTab>('send');
  const [retryError, setRetryError] = useState('');

  useEffect(() => {
    void source.start();
    return source.stop;
  }, [source]);

  const retryCommand = async (): Promise<void> => {
    setRetryError('');
    try {
      await source.retryPendingCommand();
    } catch (error: unknown) {
      setRetryError(error instanceof Error ? error.message : String(error));
    }
  };

  const projection = snapshot.projection;
  const commandVisible = snapshot.command.status !== 'idle';
  return (
    <section className="wallet-payments" aria-labelledby="wallet-payments-title">
      <header className="wallet-payments-heading">
        <p className="wallet-shell-eyebrow">Runtime-authorized value movement</p>
        <h1 id="wallet-payments-title">Payments</h1>
        <p>Quote committed capacity, submit one idempotent command, or create a recipient-owned invoice.</p>
      </header>

      {projection ? (
        <>
          <div className="wallet-payments-context">
            <label htmlFor="wallet-payments-entity">Entity</label>
            <select
              disabled={snapshot.command.status === 'pending' || snapshot.command.status === 'submitting'}
              id="wallet-payments-entity"
              onChange={(event) => source.selectEntity(event.target.value)}
              value={projection.activeEntityId}
            >
              {projection.entities.map((entity) => <option key={entity.entityId} value={entity.entityId}>{entity.label}</option>)}
            </select>
            <span>Committed height {projection.height}</span>
            <button disabled={snapshot.status === 'loading'} onClick={() => void source.refresh()} type="button">
              {snapshot.status === 'loading' ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {commandVisible ? (
            <section className={`wallet-payment-command is-${snapshot.command.status}`} role={snapshot.command.status === 'error' ? 'alert' : 'status'}>
              <div>
                <span>Runtime command {shortCommandId(snapshot.command.commandId)}</span>
                <strong>{snapshot.command.status}</strong>
              </div>
              <p>{snapshot.command.message}</p>
              <footer>
                <span>{snapshot.command.durable ? 'Encrypted durable replay identity' : 'Memory-only command identity'}</span>
                {snapshot.command.retryable ? <button onClick={() => void retryCommand()} type="button">Retry same command</button> : null}
              </footer>
              {retryError ? <p className="wallet-payment-error">{retryError}</p> : null}
            </section>
          ) : null}

          {projection.recipients.length > 0 && projection.tokens.length > 0 ? (
            <>
              <nav className="wallet-payment-tabs" aria-label="Payment tools">
                {(['send', 'receive', 'operations'] as const).map((option) => (
                  <button aria-current={tab === option ? 'page' : undefined} className={tab === option ? 'is-current' : ''} key={option} onClick={() => setTab(option)} type="button">
                    {option === 'operations' ? 'Operations' : option[0]?.toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </nav>
              {tab === 'send' ? <WalletPaymentSend projection={projection} snapshot={snapshot} source={source} /> : null}
              {tab === 'receive' ? <WalletPaymentReceive projection={projection} source={source} /> : null}
              {tab === 'operations' ? <WalletPaymentOperations projection={projection} snapshot={snapshot} source={source} /> : null}
            </>
          ) : (
            <p className="wallet-payments-empty">This Entity needs a committed asset and another Runtime Entity before payment tools can open.</p>
          )}
        </>
      ) : (
        <PaymentsUnavailable error={snapshot.status === 'error'} message={snapshot.message} retry={() => void source.refresh()} />
      )}

      <p className="wallet-payments-boundary">
        Route quotes come from the selected Runtime. External-wallet moves are excluded until the React provider boundary is live; no placeholder transaction is emitted.
      </p>
    </section>
  );
}
