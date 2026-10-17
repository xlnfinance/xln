import { Icon } from './Icons';
import { useApp, type VaultMeta } from '../runtime/store';

type Props = {
  onMode: (mode: 'create' | 'import' | 'remote') => void;
  onUnlock: (vault: VaultMeta) => void;
  onLearn: () => void;
  testNetwork: boolean;
};

const identity = (vault: VaultMeta) => `${vault.name} · ${vault.id.slice(-8)}`;

export function GateWelcome({ onMode, onUnlock, onLearn, testNetwork }: Props) {
  const vaults = useApp(s => s.vaults).filter(vault => vault.kind !== 'sandbox');
  const activeId = useApp(s => s.activeVaultId);
  const selected = vaults.find(vault => vault.id === activeId) ?? vaults[0];
  const others = vaults.filter(vault => vault.id !== selected?.id);
  return (
    <div className="gate-cards gate-welcome fade-in">
      {selected && (
        <section className="gate-resume">
          <p className="caps muted">Your saved wallet</p>
          <h2>{selected.name}</h2>
          <p className="muted mono" title={selected.id}>
            Wallet · {selected.id.slice(-8)}
          </p>
          <button type="button" className="btn primary" onClick={() => onUnlock(selected)}>
            Continue <Icon name="arrow" size={16} />
          </button>
          {others.length > 0 && (
            <details className="gate-other-wallets">
              <summary>Choose another wallet ({others.length})</summary>
              {others.map(vault => (
                <button key={vault.id} type="button" className="gate-wallet-row" onClick={() => onUnlock(vault)}>
                  <span>{identity(vault)}</span>
                  <Icon name="chevronRight" size={16} />
                </button>
              ))}
            </details>
          )}
        </section>
      )}
      {testNetwork && (
      <section className="gate-start">
        {!selected && (
          <>
              <h2>Open a test wallet</h2>
              <p className="muted">Use the full wallet on the test network. Choose your own payments and trades.</p>
          </>
        )}
          <button type="button" className={`btn ${selected ? 'quiet' : 'primary'}`} onClick={onLearn} data-testid="gate-learn">
            Open a test wallet
          <Icon name="arrow" size={16} />
        </button>
          <p className="note">No password needed. Encrypted on this device. Test funds only.</p>
      </section>
      )}
      <div className="gate-or" aria-hidden>
        <span>or</span>
      </div>
      <div className="gate-entry-actions">
        <button type="button" className="gate-entry-action" onClick={() => onMode('create')}>
          <Icon name="plus" size={18} />
          <span>
            <strong>Create a wallet</strong>
            <small>Use a name and passphrase</small>
          </span>
        </button>
        <button type="button" className="gate-entry-action" onClick={() => onMode('import')}>
          <Icon name="receive" size={18} />
          <span>
            <strong>Restore a wallet</strong>
            <small>Import a phrase · 12 or 24 words</small>
          </span>
        </button>
      </div>
      <details className="gate-advanced">
        <summary>Advanced connection</summary>
        <button type="button" className="btn quiet" onClick={() => onMode('remote')}>
          Connect a remote runtime
        </button>
      </details>
    </div>
  );
}
