import { getHubOpeningCredit, readSavedCollateralPolicy } from '@xln/frontend/lib/utils/onboarding/onboardingPreferences';
import { sameJurisdictionIdentity } from '@xln/core/jurisdiction/machine/jurisdiction-runtime';
import { useState } from 'react';
import { Sheet } from '../Sheet';
import { useApp } from '../../runtime/store';
import { sendEntityTxs } from '../../runtime/tx';
import { accountDisputeConfig, gossipProfile } from '../../runtime/financial/roles';
import { getTokenMeta, parseAmount, shortId, plainAmount } from '../../runtime/format';
import type { WalletView } from '../../runtime/views';

export function OpenAccountSheet({ wallet, onClose }: { wallet: WalletView; onClose: () => void }) {
  const toast = useApp(s => s.toast);
  const selectedTokenId = useApp(s => s.selectedTokenId);
  const [targetId, setTargetId] = useState('');
  const [creditText, setCreditText] = useState('');
  const [policy] = useState(readSavedCollateralPolicy);
  const [autoCollateral, setAutoCollateral] = useState(policy.mode === 'autopilot');
  const [softText, setSoftText] = useState(String(policy.softLimitUsd));
  const [hardText, setHardText] = useState(String(policy.hardLimitUsd));
  const [feeText, setFeeText] = useState(String(policy.maxFeeUsd));
  const [submitting, setSubmitting] = useState(false);
  const meta = getTokenMeta(selectedTokenId);
  const existing = new Set(wallet.accounts.map(account => account.counterpartyId));
  const jurisdiction = wallet.frame?.activeEntity?.core.config.jurisdiction;
  const targetJurisdiction = wallet.summaries.find(summary => summary.entityId.toLowerCase() === targetId)?.jurisdiction;
  const compatibleTarget = sameJurisdictionIdentity(jurisdiction, targetJurisdiction);
  const candidates = wallet.summaries
    .filter(summary => sameJurisdictionIdentity(jurisdiction, summary.jurisdiction))
    .map(summary => summary.entityId.toLowerCase())
    .filter(id => id && id !== wallet.entityId && !existing.has(id));

  const openAccount = async (): Promise<void> => {
    if (!wallet.entityId || !wallet.signerId || !targetId) return;
    if (!compatibleTarget) {
      toast('Choose a counterparty in the same jurisdiction and contract stack.', 'danger');
      return;
    }
    setSubmitting(true);
    try {
      const creditAmount = creditText.trim() ? parseAmount(creditText, meta.decimals) : 0n;
      // Same optional policy the SvelteKit hub onboarding attaches: the hub tops up
      // collateral on its own once the soft limit is crossed, up to the hard limit.
      let rebalancePolicy: { r2cRequestSoftLimit: bigint; hardLimit: bigint; maxAcceptableFee: bigint } | null = null;
      if (autoCollateral && wallet.hubs.has(targetId)) {
        const r2cRequestSoftLimit = parseAmount(softText || '0', meta.decimals);
        const hardLimit = parseAmount(hardText || '0', meta.decimals);
        const maxAcceptableFee = parseAmount(feeText || '0', meta.decimals);
        if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit || maxAcceptableFee < 0n)
          throw new Error('Soft limit must be positive and the hard limit at least as large');
        rebalancePolicy = { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
      }
      // A hub answers a dispute in an hour and a person in a day. The pair is
      // signed into the Account and can never be renegotiated, so it is derived
      // from both parties' committed or gossiped roles; an unknown role refuses
      // the proposal instead of granting the counterparty a day it is not owed.
      const disputeConfig = accountDisputeConfig({
        entityId: wallet.entityId,
        counterpartyId: targetId,
        summaries: wallet.summaries,
      });
      await sendEntityTxs(wallet.entityId, wallet.signerId, [
        {
          type: 'openAccount',
          data: {
            targetEntityId: targetId,
            creditAmount,
            tokenId: selectedTokenId,
            disputeConfig,
            ...(rebalancePolicy ? { rebalancePolicy } : {}),
          },
        },
      ]);
      toast('Account proposed');
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  /** Routing fee, swap fee and jurisdiction, straight off the signed profile. */
  const counterpartyTerms = (id: string): string => {
    const metadata = gossipProfile(id)?.metadata;
    if (!metadata) return 'terms not published yet';
    const parts: string[] = [];
    if (Number.isFinite(metadata.routingFeePPM)) parts.push(`${metadata.routingFeePPM} ppm to route`);
    if (Number.isSafeInteger(metadata.swapTakerFeeBps)) parts.push(`${metadata.swapTakerFeeBps} bps to take a swap`);
    const jurisdiction = String(metadata.jurisdiction?.name || '').trim();
    if (jurisdiction) parts.push(`on ${jurisdiction}`);
    return parts.length > 0 ? parts.join(' · ') : 'terms not published yet';
  };

  return (
    <Sheet title="Open account" onClose={onClose}>
      <div className="field">
        <span className="field-label">Counterparty</span>
        {candidates.map(id => (
          <button
            key={id}
            type="button"
            className={`picker-option${targetId === id ? ' active' : ''}`}
            style={{ padding: '10px 10px' }}
            onClick={() => { setTargetId(id); setCreditText(wallet.hubs.has(id) ? plainAmount(getHubOpeningCredit(meta.decimals), meta.decimals) : '0'); }}
          >
            <span className="t">
              {wallet.names.get(id) || 'Entity'}
              {wallet.hubs.has(id) ? <span className="chip hub">hub</span> : null}
            </span>
            <span className="hash">{shortId(id, 10, 6)}</span>
            {/* What actually decides who to open an account with: what they
						    charge to route and to take a swap, and where they are. */}
            <span className="s">{counterpartyTerms(id)}</span>
          </button>
        ))}
        <input
          className="input mono"
          placeholder="or paste an entity id, 0x…"
          value={targetId}
          onChange={event => { const id = event.target.value.trim().toLowerCase(); setTargetId(id); setCreditText(wallet.hubs.has(id) ? plainAmount(getHubOpeningCredit(meta.decimals), meta.decimals) : '0'); }}
          spellCheck={false}
        />
      </div>
      {targetId && !compatibleTarget ? <p className="note" role="alert">Choose a counterparty in the same jurisdiction and contract stack. Unknown networks cannot be verified.</p> : null}
      <div className="field">
        <span className="field-label">Credit line you extend · optional</span>
        <div className="field-row">
          <input
            className="input"
            placeholder="0.00"
            inputMode="decimal"
            value={creditText}
            onChange={event => setCreditText(event.target.value)}
          />
          <span className="muted">{meta.symbol}</span>
        </div>
        <p className="note">Credit lets them owe you up to this amount, so they can pay you without pre-funding.</p>
      </div>
      {wallet.hubs.has(targetId) ? (
        <div className="field">
          <label className="setting" style={{ padding: '6px 0', cursor: 'pointer' }}>
            <span className="t">Automatic collateral from the hub</span>
            <input
              type="checkbox"
              checked={autoCollateral}
              onChange={event => setAutoCollateral(event.target.checked)}
              data-testid="open-auto-collateral"
            />
          </label>
          {autoCollateral ? (
            <div className="fade-in">
              <div className="field-row" style={{ marginTop: 8 }}>
                <input
                  className="input"
                  placeholder="Soft limit"
                  inputMode="decimal"
                  value={softText}
                  onChange={event => setSoftText(event.target.value)}
                />
                <input
                  className="input"
                  placeholder="Hard limit"
                  inputMode="decimal"
                  value={hardText}
                  onChange={event => setHardText(event.target.value)}
                />
                <input
                  className="input"
                  placeholder="Max fee"
                  inputMode="decimal"
                  value={feeText}
                  onChange={event => setFeeText(event.target.value)}
                />
              </div>
              <p className="note">
                When what the hub owes you passes the soft limit, it locks collateral for you (up to the hard limit) and
                charges at most this fee per top-up.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="btn"
        disabled={!/^0x[0-9a-f]{64}$/.test(targetId) || !compatibleTarget || submitting}
        onClick={() => void openAccount()}
      >
        {submitting ? 'Proposing…' : 'Propose account'}
      </button>
    </Sheet>
  );
}
