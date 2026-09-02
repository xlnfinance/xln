import { useSyncExternalStore } from 'react';

import { resolveEntityPanelDeepLinkFromLocation } from '../../../packages/runtime-client/src/entity-workspace-navigation';
import { EntityWorkspaceShell } from '../../../packages/ui/src/entity-workspace-shell';
import { opsEntityWorkspaceSource } from './ops-entity-workspace-runtime';
import { OpsShell } from './ops-shell';

const subscribeToHash = (onStoreChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onStoreChange);
  return () => window.removeEventListener('hashchange', onStoreChange);
};

const readHash = (): string => window.location.hash;

export function OpsEntityWorkspacePage() {
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => '');
  const snapshot = useSyncExternalStore(
    opsEntityWorkspaceSource.subscribe,
    opsEntityWorkspaceSource.getSnapshot,
    opsEntityWorkspaceSource.getSnapshot,
  );
  const activeTab = resolveEntityPanelDeepLinkFromLocation({ hash, search: '' }).activeTab ?? 'assets';
  return (
    <OpsShell activePath="/embed">
      <EntityWorkspaceShell
        accounts={snapshot.accounts}
        activeTab={activeTab}
        context={snapshot.context}
        onRefresh={() => { void opsEntityWorkspaceSource.refresh(); }}
        onSelectAccountsPage={opsEntityWorkspaceSource.selectAccountsPage}
        ownership={snapshot.ownership}
        readState={snapshot.readState}
      />
    </OpsShell>
  );
}
