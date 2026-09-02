import {
  ENTITY_WORKSPACE_SECTIONS,
  type SettingsSubview,
  type ViewTab,
} from '../../runtime-client/src/entity-workspace-navigation';
import type { EntityWorkspaceAccounts } from '../../runtime-client/src/entity-workspace-accounts';
import type {
  EntityWorkspaceContext,
  EntityWorkspaceReadState,
} from '../../runtime-client/src/entity-workspace-context';
import type { EntityWorkspaceOwnership } from '../../runtime-client/src/entity-workspace-ownership';
import type { EntityWorkspaceProfile } from '../../runtime-client/src/entity-workspace-profile';
import { EntityWorkspaceAccountsPanel } from './entity-workspace-accounts-panel';
import { formatAddress } from './entity-workspace-display';
import { EntityWorkspaceProfilePanel } from './entity-workspace-profile-panel';
import './entity-workspace-shell.css';

type SectionCopy = Readonly<{
  eyebrow: string;
  title: string;
  summary: string;
  nextBoundary: string;
}>;

const SECTION_COPY: Readonly<Record<ViewTab, SectionCopy>> = {
  assets: {
    eyebrow: 'Balance sheet',
    title: 'Assets',
    summary: 'Reserve positions and movement begin with an exact Entity identity.',
    nextBoundary: 'Asset projection and movement controls remain on the canonical workspace.',
  },
  accounts: {
    eyebrow: 'Bilateral state',
    title: 'Accounts',
    summary: 'Peer balances, credit, payments, and swaps stay scoped to one selected Entity.',
    nextBoundary: 'Payments, swaps, credit, and Account lifecycle commands remain on the canonical workspace.',
  },
  ownership: {
    eyebrow: 'Authority',
    title: 'Ownership',
    summary: 'Signer thresholds and Entity control must come from committed Runtime evidence.',
    nextBoundary: 'Share issuance and board actions remain on the canonical workspace.',
  },
  settings: {
    eyebrow: 'Configuration',
    title: 'Settings',
    summary: 'Wallet, consensus, recovery, display, network, and data controls stay explicit.',
    nextBoundary: 'Profile edits and all Settings commands remain on the canonical workspace.',
  },
};

const contextEntityLabel = (context: EntityWorkspaceContext): string =>
  context.entityName || formatAddress(context.entityId || '') || 'Not selected';

function EntityContextStrip({ context }: Readonly<{ context: EntityWorkspaceContext }>) {
  return (
    <dl className="entity-workspace-context" aria-label="Entity workspace context">
      <div><dt>Runtime</dt><dd>{formatAddress(context.runtimeId || '') || 'Not attached'}</dd></div>
      <div><dt>Jurisdiction</dt><dd>{context.jurisdictionName || 'Unassigned'}</dd></div>
      <div><dt>Entity</dt><dd>{contextEntityLabel(context)}</dd></div>
    </dl>
  );
}

type ProjectionBoundaryProps = Readonly<{
  context: EntityWorkspaceContext;
  emptyMessage: string;
  onRefresh: () => void;
  readState: EntityWorkspaceReadState;
}>;

function ProjectionBoundary({ context, emptyMessage, onRefresh, readState }: ProjectionBoundaryProps) {
  if (readState.status === 'error') {
    return (
      <div className="entity-workspace-boundary" data-tone="error" role="alert">
        <span>Runtime read failed</span>
        <strong>Entity context unavailable</strong>
        <p>{readState.message}</p>
        <button onClick={onRefresh} type="button">Retry read</button>
      </div>
    );
  }
  if (readState.status === 'connecting' || readState.status === 'loading') {
    return (
      <div className="entity-workspace-boundary" role="status">
        <span>{readState.status === 'connecting' ? 'Runtime connection' : 'Committed read'}</span>
        <strong>{readState.status === 'connecting' ? 'Connecting to Runtime' : 'Reading Entity context'}</strong>
        <p>{readState.message}</p>
      </div>
    );
  }
  if (readState.status === 'ready' && context.status === 'selected') {
    return (
      <div className="entity-workspace-boundary" role="status">
        <span>Committed projection</span>
        <strong>Entity context attached</strong>
        <p>Height {context.height} · {context.accountCount} accounts. Section panels remain on the canonical workspace.</p>
      </div>
    );
  }
  if (readState.status === 'ready') {
    return (
      <div className="entity-workspace-boundary" role="status">
        <span>Runtime connected</span>
        <strong>No active Entity selected</strong>
        <p>Committed height {context.height}. Select an Entity in the canonical workspace before opening this preview.</p>
      </div>
    );
  }
  return (
    <div className="entity-workspace-boundary" role="status">
      <span>Integration boundary</span>
      <strong>No Runtime projection attached</strong>
      <p>{readState.message || emptyMessage}</p>
    </div>
  );
}

type EntityWorkspaceStageProps = Omit<ProjectionBoundaryProps, 'emptyMessage'> & Readonly<{ activeTab: ViewTab }>;

function OwnershipProjection({ ownership }: Readonly<{ ownership: EntityWorkspaceOwnership }>) {
  if (ownership.status !== 'selected') return null;
  return (
    <section className="entity-workspace-board" data-testid="ownership-board-projection">
      <header>
        <span>Committed board</span>
        <strong>{ownership.mode === 'proposer-based' ? 'Proposer based' : 'Gossip based'}</strong>
        <p>Threshold <b data-testid="ownership-threshold">{ownership.threshold.toString()}</b> of <b data-testid="ownership-total-shares">{ownership.totalShares.toString()}</b> voting shares</p>
      </header>
      <div className="entity-workspace-board-members">
        <div><span>Validators</span><strong data-testid="ownership-member-count">{ownership.members.length}</strong></div>
        <ol>
          {ownership.members.map((member, index) => (
            <li data-attached={member.isAttachedSigner || undefined} key={member.signerId}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{formatAddress(member.signerId)}</strong>
              <em>{member.shares.toString()} {member.shares === 1n ? 'share' : 'shares'}</em>
            </li>
          ))}
        </ol>
      </div>
      <footer>
        <span>Attached signer</span>
        <strong>{ownership.attachedSignerId
          ? ownership.members.some((member) => member.isAttachedSigner) ? 'Board member' : 'Observer'
          : 'Not exposed'}</strong>
      </footer>
    </section>
  );
}

type EntityWorkspaceStageWithOwnershipProps = EntityWorkspaceStageProps & Readonly<{
  accounts: EntityWorkspaceAccounts;
  onSelectAccountsPage: (page: number) => void;
  ownership: EntityWorkspaceOwnership;
  profile: EntityWorkspaceProfile;
  settingsSubview: SettingsSubview;
}>;

const readFooterLabel = (
  copy: SectionCopy,
  context: EntityWorkspaceContext,
  readState: EntityWorkspaceReadState,
): string => {
  if (readState.status === 'error') return 'Runtime read failed';
  if (readState.status === 'connecting' || readState.status === 'loading') return readState.message;
  if (readState.status === 'ready' && context.status === 'selected') return copy.nextBoundary;
  if (readState.status === 'ready') return 'Runtime attached — no Entity selected';
  return 'Unavailable — no remote Runtime selected';
};

function EntityWorkspaceStage({ accounts, activeTab, context, onRefresh, onSelectAccountsPage, ownership, profile, readState, settingsSubview }: EntityWorkspaceStageWithOwnershipProps) {
  const copy = SECTION_COPY[activeTab];
  return (
    <section className="entity-workspace-stage" data-testid="entity-workspace-stage">
      <header>
        <span>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{copy.summary}</p>
      </header>
      {readState.status === 'ready' && context.status === 'selected' && activeTab === 'accounts'
        ? <EntityWorkspaceAccountsPanel accounts={accounts} onSelectPage={onSelectAccountsPage} />
        : activeTab === 'ownership' && readState.status === 'ready' && context.status === 'selected'
          ? <OwnershipProjection ownership={ownership} />
          : activeTab === 'settings' && readState.status === 'ready' && context.status === 'selected' && (settingsSubview === 'wallet' || settingsSubview === 'entity')
            ? <EntityWorkspaceProfilePanel profile={profile} />
          : <ProjectionBoundary
            context={context}
            emptyMessage={copy.nextBoundary}
            onRefresh={onRefresh}
            readState={readState}
          />}
      <footer><span>Read state</span><strong>{readFooterLabel(copy, context, readState)}</strong></footer>
    </section>
  );
}

type EntityWorkspaceShellProps = Readonly<{
  accounts: EntityWorkspaceAccounts;
  activeTab: ViewTab;
  context: EntityWorkspaceContext;
  onRefresh: () => void;
  onSelectAccountsPage: (page: number) => void;
  ownership: EntityWorkspaceOwnership;
  profile: EntityWorkspaceProfile;
  readState: EntityWorkspaceReadState;
  settingsSubview: SettingsSubview;
}>;

const readModeLabel = (
  context: EntityWorkspaceContext,
  readState: EntityWorkspaceReadState,
): string => {
  if (readState.status === 'error') return 'Read failed';
  if (readState.status === 'connecting') return 'Connecting';
  if (readState.status === 'loading') return 'Reading';
  if (readState.status === 'ready') return context.status === 'selected' ? 'Context ready' : 'Runtime ready';
  return 'Read boundary';
};

export function EntityWorkspaceShell({ accounts, activeTab, context, onRefresh, onSelectAccountsPage, ownership, profile, readState, settingsSubview }: EntityWorkspaceShellProps) {
  return (
    <section
      className="entity-workspace"
      data-active-tab={activeTab}
      data-read-status={readState.status}
      data-testid="entity-workspace-shell"
    >
      <header className="entity-workspace-header">
        <div>
          <p>operator / entity</p>
          <h1>Entity workspace</h1>
          <span>Identity first. One canonical route for every workspace section.</span>
        </div>
        <div className="entity-workspace-mode">
          <i aria-hidden="true" />
          <span>React shell</span>
          <strong>{readModeLabel(context, readState)}</strong>
        </div>
      </header>
      <EntityContextStrip context={context} />
      <nav className="entity-workspace-tabs" aria-label="Entity workspace sections">
        {ENTITY_WORKSPACE_SECTIONS.map((section, index) => (
          <a
            aria-current={section.id === activeTab ? 'page' : undefined}
            data-testid={`entity-workspace-tab-${section.id}`}
            href={`#${section.id}`}
            key={section.id}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{section.label}</strong>
          </a>
        ))}
      </nav>
      <EntityWorkspaceStage
        accounts={accounts}
        activeTab={activeTab}
        context={context}
        onRefresh={onRefresh}
        onSelectAccountsPage={onSelectAccountsPage}
        ownership={ownership}
        profile={profile}
        readState={readState}
        settingsSubview={settingsSubview}
      />
      <p className="entity-workspace-footnote">No inferred state · no hidden fallback · Svelte remains canonical</p>
    </section>
  );
}
