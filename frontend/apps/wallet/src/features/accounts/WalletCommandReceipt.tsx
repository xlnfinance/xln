import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';

export const WalletCommandReceipt = ({ receipt }: Readonly<{ receipt: CommandReceipt | null }>) => {
  if (!receipt) return null;
  const terminal = receipt.status === 'committed' || receipt.status === 'observed' || receipt.status === 'error';
  return (
    <section
      className={`wallet-command-receipt is-${receipt.status}`}
      data-testid="wallet-command-receipt"
      data-status={receipt.status}
      aria-live="polite"
    >
      <div>
        <span>Runtime command</span>
        <strong>{receipt.status}</strong>
      </div>
      <dl>
        <div><dt>Command</dt><dd>{receipt.commandId}</dd></div>
        <div><dt>Accepted height</dt><dd>{receipt.acceptedAtHeight ?? 'waiting'}</dd></div>
        <div><dt>Committed height</dt><dd>{receipt.committedAtHeight ?? (terminal ? 'not committed' : 'waiting')}</dd></div>
      </dl>
      {receipt.error && <p role="alert">{receipt.error}</p>}
    </section>
  );
};
