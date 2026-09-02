import {
  ENTITY_WORKSPACE_SECTIONS,
  type ViewTab,
} from '../../runtime-client/src/entity-workspace-navigation';
import type { EntityWorkspaceContext } from '../../runtime-client/src/entity-workspace-context';
import { formatAddress } from './entity-workspace-display';
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
    nextBoundary: 'Account projections and transaction controls remain on the canonical workspace.',
  },
  ownership: {
    eyebrow: 'Authority',
    title: 'Ownership',
    summary: 'Signer thresholds and Entity control must come from committed Runtime evidence.',
    nextBoundary: 'Ownership evidence remains on the canonical workspace.',
  },
  settings: {
    eyebrow: 'Configuration',
    title: 'Settings',
    summary: 'Wallet, consensus, recovery, display, network, and data controls stay explicit.',
    nextBoundary: 'Settings reads and commands remain on the canonical workspace.',
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

function ProjectionBoundary({ context, emptyMessage }: Readonly<{ context: EntityWorkspaceContext; emptyMessage: string }>) {
  if (context.status === 'selected') {
    return <div className="entity-workspace-boundary" role="status"><span>Committed projection</span><strong>Entity context attached</strong><p>Height {context.height} · {context.accountCount} accounts. Section panels remain on the canonical workspace.</p></div>;
  }
  return <div className="entity-workspace-boundary" role="status"><span>Integration boundary</span><strong>No Runtime projection attached</strong><p>{emptyMessage}</p></div>;
}

function EntityWorkspaceStage({ activeTab, context }: Readonly<{ activeTab: ViewTab; context: EntityWorkspaceContext }>) {
  const copy = SECTION_COPY[activeTab];
  return (
    <section className="entity-workspace-stage" data-testid="entity-workspace-stage">
      <header>
        <span>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{copy.summary}</p>
      </header>
      <ProjectionBoundary context={context} emptyMessage={copy.nextBoundary} />
      <footer><span>Read state</span><strong>{context.status === 'selected' ? copy.nextBoundary : 'Unavailable — no identity selected'}</strong></footer>
    </section>
  );
}

export function EntityWorkspaceShell({ activeTab, context }: Readonly<{ activeTab: ViewTab; context: EntityWorkspaceContext }>) {
  return (
    <section className="entity-workspace" data-active-tab={activeTab} data-testid="entity-workspace-shell">
      <header className="entity-workspace-header">
        <div>
          <p>operator / entity</p>
          <h1>Entity workspace</h1>
          <span>Identity first. One canonical route for every workspace section.</span>
        </div>
        <div className="entity-workspace-mode"><i aria-hidden="true" /><span>React shell</span><strong>{context.status === 'selected' ? 'Context ready' : 'Read boundary'}</strong></div>
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
      <EntityWorkspaceStage activeTab={activeTab} context={context} />
      <p className="entity-workspace-footnote">No inferred state · no hidden fallback · Svelte remains canonical</p>
    </section>
  );
}
