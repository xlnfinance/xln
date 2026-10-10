import { useState } from 'react';
import { useApp } from '../../runtime/store';
import { sendEntityTxs } from '../../runtime/tx';
import { useWallet } from '../../runtime/views';

export function Profile() {
  const toast = useApp(s => s.toast);
  const entityId = useApp(s => s.activeEntityId);
  const wallet = useWallet(entityId);
  const [profileName, setProfileName] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [profileWebsite, setProfileWebsite] = useState('');
  const [publishing, setPublishing] = useState(false);

  /** The profile is signed state other entities read, so this is a committed tx, not a local label. */
  const publishProfile = async (): Promise<void> => {
    if (!wallet.entityId || !wallet.signerId) return;
    setPublishing(true);
    try {
      await sendEntityTxs(wallet.entityId, wallet.signerId, [
        {
          type: 'profile-update',
          data: {
            profile: {
              entityId: wallet.entityId,
              name: profileName.trim(),
              bio: profileBio.trim(),
              website: profileWebsite.trim(),
            },
          },
        },
      ]);
      toast('Profile published');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <>
      <div className="sect">
        <h3 className="caps">Identity</h3>
        <span className="faint">what other entities see</span>
      </div>
      <div className="setting first" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div>
          <div className="t">Published name</div>
          <div className="s">
            Your signed profile is shared with your counterparties. Publish a name they can recognize.
          </div>
        </div>
        <div className="field-row">
          <input
            aria-label="Published name"
            className="input"
            value={profileName}
            placeholder={wallet.name}
            onChange={event => setProfileName(event.target.value)}
            data-testid="profile-name"
          />
          <button
            type="button"
            className="btn sm"
            disabled={publishing || !profileName.trim() || profileName.trim() === wallet.name}
            onClick={() => void publishProfile()}
            data-testid="profile-publish"
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
        <input
          aria-label="Website"
          className="input"
          value={profileWebsite}
          placeholder="website · optional"
          onChange={event => setProfileWebsite(event.target.value)}
          data-testid="profile-website"
        />
        <textarea
          aria-label="About you"
          className="input"
          rows={2}
          value={profileBio}
          placeholder="a line about you · optional"
          onChange={event => setProfileBio(event.target.value)}
          data-testid="profile-bio"
        />
      </div>
    </>
  );
}
