import { useEffect } from 'react';
import { getEmbeddedEnv } from './adapter';
import { backupToTowers, readRecovery } from './recovery';
import { useApp } from './store';
import { peekXLN } from './xln-loader';

/** Backup lifetime follows the unlocked wallet, not the screen the user happens to view. */
export function useRecoverySync(): void {
  const vaultId = useApp(state => state.activeVaultId);
  const seed = useApp(state => vaultId ? state.sessionSeeds[vaultId] : undefined);
  useEffect(() => {
    if (!vaultId || !seed) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let savedKey = '';
    let lastError = '';
    const sync = async (): Promise<void> => {
      try {
        const config = readRecovery(vaultId);
        const height = useApp.getState().height;
        const key = `${height}:${config.towers.join(',')}`;
        const xln = peekXLN();
        const env = getEmbeddedEnv();
        if (config.mode === 'tower' && xln && env && height > 0 && key !== savedKey) {
          const results = await backupToTowers(xln, env, seed, config.towers);
          const errors = results.filter(row => row.error).map(row => `${row.url}: ${row.error}`);
          if (errors.length) throw new Error(errors.join(' · '));
          savedKey = key;
          lastError = '';
          window.dispatchEvent(new Event('xln-recovery-updated'));
        }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (!stopped && message !== lastError) useApp.getState().toast(`Backup failed: ${message}`, 'danger', 'automatic-backup');
        lastError = message;
      } finally {
        if (!stopped) timer = setTimeout(() => void sync(), lastError ? 60_000 : 5_000);
      }
    };
    timer = setTimeout(() => void sync(), 2_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [vaultId, seed]);
}
