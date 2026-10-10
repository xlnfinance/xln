import { PushNotifications } from './PushNotifications';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DisputeProtection } from './DisputeProtection';
import { Icon } from './Icons';
import { getEmbeddedEnv } from '../runtime/adapter';
import { peekXLN } from '../runtime/xln-loader';
import { useApp } from '../runtime/store';
import { timeAgo } from '../runtime/format';
import {
  backupToTowers,
  defaultTowerUrl,
  normalizeTowerUrl,
  readRecovery,
  readTowerCoverage,
  recoveryLookupKey,
  saveRecovery,
  towerHealth,
  type RecoveryMode,
  type TowerCoverage,
} from '../runtime/recovery';

export function Watchtower({ accountCount }: { accountCount: number }) {
  const activeVaultId = useApp(s => s.activeVaultId);
  const sessionSeeds = useApp(s => s.sessionSeeds);
  const height = useApp(s => s.height);
  const toast = useApp(s => s.toast);
  const seed = activeVaultId ? sessionSeeds[activeVaultId] : undefined;

  const [config, setConfig] = useState(() => readRecovery(activeVaultId));
  const [draftUrl, setDraftUrl] = useState('');
  const [coverage, setCoverage] = useState<TowerCoverage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setConfig(readRecovery(activeVaultId)), [activeVaultId]);

  const xln = peekXLN();
  const env = getEmbeddedEnv();
  const lookupKey = useMemo(
    () => (xln && env && seed ? recoveryLookupKey(xln, String(env.runtimeId), seed) : ''),
    [xln, env, seed],
  );

  const refresh = useCallback(
    async (towers: string[]): Promise<void> => {
      if (!lookupKey || towers.length === 0) {
        setCoverage([]);
        return;
      }
      setCoverage(await Promise.all(towers.map(url => readTowerCoverage(url, lookupKey))));
    },
    [lookupKey],
  );

  useEffect(() => {
    void refresh(config.towers);
  }, [config.towers, refresh]);

  /** The wallet-level service also runs while this panel is closed or unmounted. */
  useEffect(() => {
    const updated = (): void => { void refresh(config.towers); };
    window.addEventListener('xln-recovery-updated', updated);
    return () => window.removeEventListener('xln-recovery-updated', updated);
  }, [config.towers, refresh]);

  const protecting = coverage.filter(row => row.protecting);
  const covered = protecting.length > 0;

  const setMode = async (mode: RecoveryMode): Promise<void> => {
    if (!activeVaultId) return;
    setError(null);
    if (mode === 'tower' && config.towers.length === 0) {
      setError('Add a tower first, then this wallet can back up to it.');
      return;
    }
    setConfig(saveRecovery(activeVaultId, { ...config, mode }));
  };

  const addTower = async (): Promise<void> => {
    if (!activeVaultId) return;
    setBusy(true);
    setError(null);
    try {
      const url = normalizeTowerUrl(draftUrl);
      if (config.towers.includes(url)) throw new Error('That tower is already on the list.');
      // Refuse to list an address that has not answered as a tower: a row that
      // says "protecting you" must never be a typo the person cannot see.
      const health = await towerHealth(url);
      const next = saveRecovery(activeVaultId, { mode: 'tower', towers: [...config.towers, url] });
      setConfig(next);
      setDraftUrl('');
      toast(`Tower ${health.towerId} added`);
      if (xln && env && seed) {
        const results = await backupToTowers(xln, env, seed, next.towers);
        const failed = results.filter(result => result.error);
        if (failed.length > 0) setError(failed.map(result => `${result.url}: ${result.error}`).join(' · '));
      }
      await refresh(next.towers);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setBusy(false);
    }
  };

  const removeTower = async (url: string): Promise<void> => {
    if (!activeVaultId) return;
    const towers = config.towers.filter(entry => entry !== url);
    setConfig(saveRecovery(activeVaultId, { mode: towers.length === 0 ? 'local' : config.mode, towers }));
    setError(null);
    await refresh(towers);
  };

  const backupNow = async (): Promise<void> => {
    if (!xln || !env || !seed) return;
    setBusy(true);
    setError(null);
    try {
      const results = await backupToTowers(xln, env, seed, config.towers);
      const failed = results.filter(result => result.error);
      if (failed.length > 0) setError(failed.map(result => `${result.url}: ${result.error}`).join(' · '));
      else toast(`Backed up frame #${height.toLocaleString('en-US')}`);
      await refresh(config.towers);
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : String(backupError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="sovereignty-watchtower" data-covered={covered ? 'yes' : 'no'}>
      <h3 className="caps">Watchtower</h3>
      <div className="kv" style={{ marginTop: 8 }}>
        <span className="k">Encrypted backups</span>
        <span className={`v state ${covered ? 'st-settled' : 'st-pending'}`} data-testid="watchtower-state">
          {covered ? `${protecting.length} tower${protecting.length === 1 ? '' : 's'}` : 'not backed up'}
        </span>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        A tower keeps an encrypted copy of your latest signed pages. It sees a random-looking name, the size and the
        ciphertext; the key that opens it never leaves this device. Anyone can run one, including you.
      </p>

      <div className="chips" style={{ marginTop: 12 }} role="radiogroup" aria-label="Recovery mode">
        <button
          type="button"
          className={config.mode === 'tower' ? 'active' : ''}
          onClick={() => void setMode('tower')}
          data-testid="watchtower-mode-tower"
        >
          Back up to a tower
        </button>
        <button
          type="button"
          className={config.mode === 'local' ? 'active' : ''}
          onClick={() => void setMode('local')}
          data-testid="watchtower-mode-local"
        >
          This device only
        </button>
      </div>

      {config.towers.map((url, index) => {
        const row = coverage.find(entry => entry.url === url);
        return (
          <div key={url} className={`row${index === 0 ? ' first' : ''}`} data-testid="watchtower-row" data-tower={url}>
            <span className="rt">
              <span className="tx">
                <span className="t mono">{url}</span>
                <span className="s">
                  {row?.error
                    ? `not reachable · ${row.error}`
                    : row?.protecting
                      ? `holding your frame #${row.height.toLocaleString('en-US')} · ${Math.max(1, Math.round(row.storedBytes / 1024)).toLocaleString('en-US')} KB${row.storedAt > 0 ? ` · ${timeAgo(row.storedAt)}` : ''}`
                      : 'nothing stored yet'}
                </span>
              </span>
              <span className="r">
                <button
                  type="button"
                  className="btn quiet sm"
                  onClick={() => void removeTower(url)}
                  data-testid="watchtower-remove"
                  aria-label={`Remove ${url}`}
                >
                  <Icon name="trash" size={14} />
                  Remove
                </button>
              </span>
            </span>
          </div>
        );
      })}

      <div className="field" style={{ marginTop: 12 }}>
        <span className="field-label">Add a tower</span>
        <div className="field-row">
          <input
            className="input mono"
            value={draftUrl}
            onChange={event => setDraftUrl(event.target.value)}
            placeholder={defaultTowerUrl() || 'https://tower.example.com'}
            spellCheck={false}
            autoComplete="off"
            data-testid="watchtower-url"
          />
          <button
            type="button"
            className="btn"
            onClick={() => void addTower()}
            disabled={busy || !draftUrl.trim() || !activeVaultId}
            data-testid="watchtower-add"
          >
            <Icon name="plus" size={15} />
            Add
          </button>
        </div>
      </div>

      {error ? (
        <p className="note st-dispute" data-testid="watchtower-error">
          {error}
        </p>
      ) : null}

      <h3 className="caps" style={{ marginTop: 16 }}>
        What is covered
      </h3>
      <div className="kv" data-testid="watchtower-coverage-backup">
        <span className="k">Your signed pages, off this device</span>
        <span className={`v ${covered ? 'st-settled' : 'st-pending'}`}>
          {covered
            ? `frame #${Math.max(...protecting.map(row => row.height)).toLocaleString('en-US')}`
            : 'not backed up'}
        </span>
      </div>
      <div className="kv" data-testid="watchtower-coverage-accounts">
        <span className="k">Accounts in the selected entity</span>
        <span className="v num">{accountCount.toLocaleString('en-US')}</span>
      </div>
      <DisputeProtection towers={config.towers} seed={seed} />
      <PushNotifications towers={config.towers} seed={seed} />
      <button
        type="button"
        className="btn quiet"
        style={{ marginTop: 12 }}
        onClick={() => void backupNow()}
        disabled={busy || config.towers.length === 0 || !seed}
        data-testid="watchtower-backup-now"
      >
        <Icon name="shield" size={15} />
        {busy ? 'Working…' : 'Back up now'}
      </button>
    </div>
  );
}
