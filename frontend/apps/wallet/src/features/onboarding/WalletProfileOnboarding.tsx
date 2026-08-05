import { useEffect, useMemo, useState } from 'react';

import {
  hydrateJurisdictionPolicyDefaults,
  readHubJoinPreference,
  readSavedCollateralPolicy,
  type HubJoinPreference,
} from '$lib/utils/onboardingPreferences';
import { resolveOfficialRecoveryTowerUrl } from '$lib/utils/recoverySettings';
import type { RecoveryTowerSetupMode, Runtime } from '$lib/stores/vaultStore';
import { walletErrorText } from '../../error-surface';
import {
  completeWalletProfileOnboarding,
  inferWalletRecoveryMode,
} from './wallet-profile-onboarding';

export type WalletProfileOnboardingProps = Readonly<{
  runtime: Runtime;
  onComplete: () => void;
}>;

const hasSavedHubPreference = (): boolean => localStorage.getItem('xln-hub-join-preference') !== null;

export const WalletProfileOnboarding = ({ runtime, onComplete }: WalletProfileOnboardingProps) => {
  const savedPolicy = useMemo(() => readSavedCollateralPolicy(), [runtime.id]);
  const jurisdictions = useMemo(() => runtime.signers.flatMap((signer, index) => {
    const entityId = String(signer.entityId || '').trim();
    const name = String(signer.jurisdiction || (index === 0 ? 'Primary' : `Jurisdiction ${index + 1}`)).trim();
    return entityId ? [{ entityId, name }] : [];
  }), [runtime]);
  const [displayName, setDisplayName] = useState(runtime.label.slice(0, 32));
  const [softLimitUsd, setSoftLimitUsd] = useState(savedPolicy.softLimitUsd);
  const [hardLimitUsd, setHardLimitUsd] = useState(savedPolicy.hardLimitUsd);
  const [maxFeeUsd, setMaxFeeUsd] = useState(savedPolicy.maxFeeUsd);
  const [hubJoinPreference, setHubJoinPreference] = useState<HubJoinPreference>(() => hasSavedHubPreference() ? readHubJoinPreference() : '1');
  const [recoveryMode, setRecoveryMode] = useState<RecoveryTowerSetupMode>(() => inferWalletRecoveryMode(runtime));
  const [selectedJurisdictions, setSelectedJurisdictions] = useState(() => jurisdictions.map(item => item.name));
  const [termsAccepted, setTermsAccepted] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const officialRecoveryAvailable = Boolean(resolveOfficialRecoveryTowerUrl());

  useEffect(() => {
    let active = true;
    void hydrateJurisdictionPolicyDefaults(jurisdictions[0]?.name).then(defaults => {
      if (!active || savedPolicy.timestamp > 0) return;
      setSoftLimitUsd(defaults.softLimitUsd);
      setHardLimitUsd(defaults.hardLimitUsd);
      setMaxFeeUsd(defaults.maxFeeUsd);
    }).catch(cause => {
      if (active) setError(walletErrorText(cause));
    });
    return () => { active = false; };
  }, [jurisdictions, savedPolicy.timestamp]);

  const toggleJurisdiction = (name: string, enabled: boolean): void => {
    setSelectedJurisdictions(current => enabled
      ? Array.from(new Set([...current, name]))
      : current.filter(candidate => candidate !== name));
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await completeWalletProfileOnboarding(runtime, {
        displayName,
        softLimitUsd,
        hardLimitUsd,
        maxFeeUsd,
        hubJoinPreference,
        recoveryMode,
        selectedJurisdictions,
      });
      onComplete();
    } catch (cause) {
      setError(walletErrorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = termsAccepted
    && displayName.trim().length >= 2
    && softLimitUsd > 0
    && hardLimitUsd >= softLimitUsd
    && maxFeeUsd >= 0
    && selectedJurisdictions.length > 0;

  return (
    <main className="wallet-profile-onboarding onboarding" data-testid="wallet-profile-onboarding">
      <header>
        <p className="wallet-eyebrow" data-testid="app-runtime-ready">runtime ready · setup step 2 of 2</p>
        <h1>Prepare your wallet network</h1>
        <p>Publish the runtime profile, set real capacity limits, and open the first bilateral hub accounts.</p>
      </header>
      <form onSubmit={event => void submit(event)}>
        <label><span>Display name</span><input id="display-name" aria-label="Display name" value={displayName} maxLength={32} disabled={submitting} onChange={event => setDisplayName(event.target.value)} /></label>
        <fieldset>
          <legend>Jurisdictions</legend>
          {jurisdictions.map(jurisdiction => <label className="wallet-onboarding-choice" key={jurisdiction.entityId}><span><strong>{jurisdiction.name}</strong><code>{jurisdiction.entityId}</code></span><input type="checkbox" checked={selectedJurisdictions.includes(jurisdiction.name)} disabled={submitting} onChange={event => toggleJurisdiction(jurisdiction.name, event.target.checked)} /></label>)}
        </fieldset>
        <fieldset className="wallet-onboarding-policy">
          <legend>Automatic collateral policy</legend>
          <label><span>Soft limit, USD</span><input aria-label="Soft limit USD" type="number" min="1" step="1" value={softLimitUsd} disabled={submitting} onChange={event => setSoftLimitUsd(Number(event.target.value))} /></label>
          <label><span>Hard limit, USD</span><input aria-label="Hard limit USD" type="number" min="1" step="1" value={hardLimitUsd} disabled={submitting} onChange={event => setHardLimitUsd(Number(event.target.value))} /></label>
          <label><span>Maximum fee, USD</span><input aria-label="Maximum fee USD" type="number" min="0" step="1" value={maxFeeUsd} disabled={submitting} onChange={event => setMaxFeeUsd(Number(event.target.value))} /></label>
        </fieldset>
        <label><span>Initial hub join</span><select id="hub-join-select" aria-label="Initial hub join" value={hubJoinPreference} disabled={submitting} onChange={event => setHubJoinPreference(event.target.value as HubJoinPreference)}><option value="manual">Join hubs manually</option><option value="1">Auto-join 1 hub</option><option value="2">Auto-join 2 hubs</option><option value="3">Auto-join 3 hubs</option></select></label>
        <label><span>Recovery service</span><select aria-label="Recovery service" value={recoveryMode} disabled={submitting} onChange={event => setRecoveryMode(event.target.value as RecoveryTowerSetupMode)}>{officialRecoveryAvailable && <option value="official">Encrypted backup + delayed last resort</option>}{officialRecoveryAvailable && <option value="backup_only">Encrypted backup only</option>}<option value="local_only">This device only</option></select></label>
        <p className="wallet-onboarding-note">Recovery is committed before any bilateral account is opened. Recovery services never receive spend authority.</p>
        <label className="wallet-onboarding-choice"><span><strong>I accept the risks of testnet software</strong><small>I have stored my recovery phrase offline.</small></span><input type="checkbox" checked={termsAccepted} disabled={submitting} onChange={event => setTermsAccepted(event.target.checked)} /></label>
        {error && <p className="wallet-inline-error error-msg" role="alert">{error}</p>}
        <button type="submit" disabled={!canSubmit || submitting}>{submitting ? 'Starting...' : 'Start'}</button>
      </form>
    </main>
  );
};
