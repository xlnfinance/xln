import { useSyncExternalStore } from 'react';

import { resolveEntityPanelDeepLinkFromLocation } from '../../../packages/runtime-client/src/entity-workspace-navigation';
import { emptyEntityWorkspaceContext } from '../../../packages/runtime-client/src/entity-workspace-context';
import { EntityWorkspaceShell } from '../../../packages/ui/src/entity-workspace-shell';
import { OpsShell } from './ops-shell';

const subscribeToHash = (onStoreChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onStoreChange);
  return () => window.removeEventListener('hashchange', onStoreChange);
};

const readHash = (): string => window.location.hash;

export function OpsEntityWorkspacePage() {
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => '');
  const activeTab = resolveEntityPanelDeepLinkFromLocation({ hash, search: '' }).activeTab ?? 'assets';
  return (
    <OpsShell activePath="/embed">
      <EntityWorkspaceShell activeTab={activeTab} context={emptyEntityWorkspaceContext()} />
    </OpsShell>
  );
}
