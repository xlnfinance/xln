import { useEffect, useState } from 'react';
import { getEmbeddedEnv } from '../runtime/adapter';
import { peekXLN } from '../runtime/xln-loader';
import { useApp } from '../runtime/store';
import { appointProtection, type ProtectionResult } from '../runtime/protection';

export function DisputeProtection({ towers, seed }: { towers: string[]; seed: string | undefined }) {
  const vault = useApp(state => state.activeVaultId);
  const height = useApp(state => state.height);
  const [result, setResult] = useState<ProtectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setResult(null);
    setError('');
  }, [vault]);
  const appoint = async (): Promise<void> => {
    const xln = peekXLN();
    const env = getEmbeddedEnv();
    if (!xln || !env || !seed) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await appointProtection(xln, env, seed, towers));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const receipts = result?.receipts.filter(row => towers.includes(row.url)) ?? [];
  return (
    <section data-testid="watchtower-coverage-lastresort">
      <h3 className="caps" style={{ marginTop: 20 }}>
        Dispute protection
      </h3>
      <p className="note">
        Authorize a tower to answer an outdated-state dispute in the final 20% of your account’s signed response window.
        It cannot spend your funds. This appoints the current proofs; update after account changes.
      </p>
      <p className="note" data-testid="protection-state">
        {receipts.length
          ? `${receipts.length} account appointment receipts received`
          : 'No appointments verified in this session'}
        . A receipt confirms acceptance, not a successful on-chain response.
      </p>
      <button
        className="btn quiet"
        type="button"
        disabled={busy || !seed || towers.length === 0}
        onClick={() => void appoint()}
        data-testid="protection-appoint"
      >
        {busy ? 'Appointing…' : receipts.length ? 'Update account protection' : towers.length === 0 ? 'Appoint dispute protection · add a tower first' : 'Appoint dispute protection'}
      </button>
      {error || result?.errors.length ? (
        <p className="note st-dispute" role="alert">
          {error || result?.errors.join(' · ')}
        </p>
      ) : null}
      {receipts.some(row => !row.automaticResponseEnabled) && <p className="note st-dispute" role="alert">Automatic dispute response is disabled on an appointed tower. Keep your wallet online.</p>}
      {receipts.map(row => (
        <details key={`${row.url}:${row.receipt.lookupKey}`} style={{ marginTop: 12 }}>
          <summary>
            Account proof #{row.proofNonce} · {row.url}
          </summary>
          <dl className="note" style={{ overflowWrap: 'anywhere' }}>
            <dt>Automatic response</dt>
            <dd>{row.automaticResponseEnabled ? 'Tower reports response worker enabled' : 'DISABLED on this tower — receipt storage alone does not protect you'}</dd>
            <dt>Watched entity</dt>
            <dd className="mono">{row.entityId}</dd>
            <dt>Counterparty</dt>
            <dd className="mono">{row.counterparty}</dd>
            <dt>Proof hash</dt>
            <dd className="mono">{row.proofHash}</dd>
            <dt>Response window</dt>
            <dd>Final {row.windowSeconds} seconds</dd>
            <dt>Receipt expires</dt>
            <dd>{new Date(row.receipt.expiresAt!).toLocaleString()}</dd>
            <dt>Backup hash</dt>
            <dd className="mono">{row.receipt.bundleHash}</dd>
            <dt>Freshness</dt>
            <dd>
              {height > row.receipt.height
                ? 'Runtime has advanced. Update to include newer account proofs.'
                : `Frame #${row.receipt.height}`}
            </dd>
          </dl>
        </details>
      ))}
    </section>
  );
}
