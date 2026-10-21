import { useState } from 'react';
import { disablePush, enablePush, pushDeviceAvailable, readPushWakeRegistrationRecords } from '../runtime/push';
import { runtimeIdForSeed } from '../runtime/keys';
import { useApp } from '../runtime/store';

export function PushNotifications({ seed, towers }: { seed: string | null | undefined; towers: string[] }) {
  const entityId = useApp(state => state.activeEntityId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const records = seed && entityId ? readPushWakeRegistrationRecords(runtimeIdForSeed(seed), entityId) : [];
  const act = async (enable: boolean): Promise<void> => {
    if (!seed || !entityId) return;
    setBusy(true);
    setNotice('');
    setFailed(false);
    try {
      if (enable) await enablePush(seed, entityId, towers);
      else await disablePush(seed, records);
      setNotice(enable ? 'Registration accepted. Delivery has not yet been tested.' : 'Tower registrations removed.');
    } catch (error) {
      setFailed(true);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details style={{ marginTop: 18 }} data-testid="push-notifications">
      <summary className="caps">Dispute notifications</summary>
      <p className="note">
        Get a reminder to open your wallet when an account is challenged. Notifications do not answer a dispute for you.
      </p>
      {!pushDeviceAvailable() && (
        <p className="note">
          This device has no notification provider. Browser notifications require a configured Web Push public key.
        </p>
      )}
      <p className="note">{records.length} locally recorded tower registrations</p>
      <button
        type="button"
        className="btn quiet"
        disabled={busy || !seed || !towers.length || !pushDeviceAvailable()}
        onClick={() => void act(true)}
      >
        Enable notifications
      </button>
      {records.length > 0 && (
        <button type="button" className="btn quiet" disabled={busy || !seed} onClick={() => void act(false)}>
          Remove registrations
        </button>
      )}
      {notice && (
        <p className="note" role={failed ? 'alert' : 'status'}>
          {notice}
        </p>
      )}
      {records.map(record => (
        <details key={`${record.towerUrl}:${record.tokenHash}`}>
          <summary>{record.towerUrl}</summary>
          <p className="note mono" style={{ overflowWrap: 'anywhere' }}>
            {record.tokenHash}
          </p>
        </details>
      ))}
    </details>
  );
}
