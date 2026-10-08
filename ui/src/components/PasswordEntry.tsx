import { useState } from 'react';
import { savePasswordVault, unlockPasswordVault } from '../../../frontend/src/lib/security/passwordVault';

type Props = {
  status?: string | null;
  id: string;
  name: string;
  seed?: string;
  onOpen: (seed: string) => Promise<void>;
  onBack: () => void;
};
export function PasswordEntry({ status, id, name, seed, onOpen, onBack }: Props) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const secret = password;
    setPassword('');
    try {
      if (seed && secret.length < 8) throw new Error('Use at least 8 characters.');
      if (seed && secret !== confirmation) throw new Error('Passwords do not match.');
      if (seed) await savePasswordVault(id, seed, secret);
      await onOpen(seed ?? (await unlockPasswordVault(id, secret)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConfirmation('');
      setBusy(false);
    }
  };
  return (
    <div className="gate">
      <div className="gate-sheet">
        <form
          className="gate-form password-form"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="muted">{name}</p>
          <h1>{seed ? 'Set a local password' : 'Unlock wallet'}</h1>
          <label htmlFor="wallet-password">Password</label>
          <input
            className="input boxed"
            id="wallet-password"
            type="password"
            autoComplete={seed ? 'new-password' : 'current-password'}
            value={password}
            onChange={event => setPassword(event.target.value)}
            required
            minLength={seed ? 8 : undefined}
            disabled={busy}
          />
          {seed && (
            <>
              <label htmlFor="wallet-confirm">Confirm password</label>
              <input
                className="input boxed"
                id="wallet-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={event => setConfirmation(event.target.value)}
                required
                disabled={busy}
              />
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy || !password}>
            {busy ? status || 'Opening…' : seed ? 'Save and open' : 'Unlock'}
          </button>
          <button type="button" className="btn quiet" onClick={onBack} disabled={busy}>
            Back
          </button>
        </form>
      </div>
    </div>
  );
}
