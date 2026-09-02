import type { EntityWorkspaceProfile } from '../../runtime-client/src/entity-workspace-profile';
import { formatAddress } from './entity-workspace-display';
import './entity-workspace-profile-panel.css';

type EntityWorkspaceProfilePanelProps = Readonly<{
  profile: EntityWorkspaceProfile;
}>;

const profileInitials = (name: string): string => name
  .split(/\s+/u)
  .slice(0, 2)
  .map((part) => part[0] ?? '')
  .join('')
  .toUpperCase();

type SelectedProfile = Extract<EntityWorkspaceProfile, Readonly<{ status: 'selected' }>>;

function ProfileHeader({ profile }: Readonly<{ profile: SelectedProfile }>) {
  return (
    <header>
      <span aria-hidden="true">{profileInitials(profile.name)}</span>
      <div>
        <small>Committed Entity profile</small>
        <strong data-testid="settings-profile-name">{profile.name}</strong>
        <p data-testid="settings-profile-role">{profile.isHub ? 'Hub entity' : 'User entity'}</p>
      </div>
    </header>
  );
}

function ProfileFields({ profile }: Readonly<{ profile: SelectedProfile }>) {
  return (
    <dl>
      <div><dt>Entity kind</dt><dd>{profile.entityKind || 'Not declared'}</dd></div>
      <div><dt>Sectors</dt><dd>{profile.sectors.length > 0 ? profile.sectors.join(' · ') : 'Not declared'}</dd></div>
      <div className="profile-wide-field"><dt>Bio</dt><dd>{profile.bio || 'No public bio'}</dd></div>
      <div><dt>Website</dt><dd title={profile.website}>{profile.website || 'Not published'}</dd></div>
      <div>
        <dt>Avatar reference</dt>
        <dd title={profile.avatar}>{profile.avatar ? formatAddress(profile.avatar) : 'Not published'}</dd>
      </div>
    </dl>
  );
}

export function EntityWorkspaceProfilePanel({ profile }: EntityWorkspaceProfilePanelProps) {
  if (profile.status !== 'selected') return null;
  return (
    <section className="entity-workspace-profile-panel" data-testid="settings-profile-projection">
      <ProfileHeader profile={profile} />
      <ProfileFields profile={profile} />
      <footer>
        <span>Read only</span>
        <strong>Profile edits stay on the canonical workspace</strong>
      </footer>
    </section>
  );
}
