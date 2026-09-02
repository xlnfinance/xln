import { describe, expect, test } from 'bun:test';

import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';
import { resolveEntityPanelDeepLinkFromLocation } from '../../../frontend/packages/runtime-client/src/entity-workspace-navigation';

describe('React Entity workspace shell', () => {
  test('owns the isolated candidate route with explicit metadata', () => {
    expect(resolveOpsPage('/embed')).toEqual({ kind: 'pending', pathname: '/embed' });
    const page = resolveOpsPage('/__app/ops/entity-workspace');
    expect(page).toEqual({ kind: 'workspace', pathname: '/__app/ops/entity-workspace' });
    expect(opsPageMetadata(page)).toEqual({
      title: 'xln Entity Workspace',
      description: 'Identity-first Entity workspace navigation for xln operators.',
    });
  });

  test('derives top-level selection from canonical deep links', () => {
    expect(resolveEntityPanelDeepLinkFromLocation({ hash: '#accounts/send', search: '' }).activeTab).toBe('accounts');
    expect(resolveEntityPanelDeepLinkFromLocation({ hash: '#settings/network', search: '' }).activeTab).toBe('settings');
    expect(resolveEntityPanelDeepLinkFromLocation({ hash: '#unknown', search: '' }).activeTab).toBeUndefined();
  });

  test('uses shared navigation and a cleaned-up browser subscription without legacy imports', async () => {
    const [page, shell, accounts] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-entity-workspace.tsx').text(),
      Bun.file('frontend/packages/ui/src/entity-workspace-shell.tsx').text(),
      Bun.file('frontend/packages/ui/src/entity-workspace-accounts-panel.tsx').text(),
    ]);
    expect(page).toContain('useSyncExternalStore');
    expect(page).toContain("removeEventListener('hashchange'");
    expect(page).toContain('resolveEntityPanelDeepLinkFromLocation');
    expect(shell).toContain('ENTITY_WORKSPACE_SECTIONS.map');
    expect(shell).toContain('aria-current={section.id === activeTab');
    expect(shell).toContain('No Runtime projection attached');
    expect(shell).toContain('EntityWorkspaceAccountsPanel');
    expect(accounts).toContain('Committed frame headers only');
    expect(accounts).not.toContain('deriveDelta');
    expect(accounts).not.toContain('CreditLimit');
    for (const source of [page, shell, accounts]) {
      expect(source).not.toContain('frontend/src');
      expect(source).not.toContain('$lib');
    }
  });
});
