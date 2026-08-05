import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from '../../frontend/node_modules/react-dom/server.browser.js';

import { resolveWalletShellEntities, resolveWalletShellIdentity, WalletShell } from '../../frontend/apps/wallet/src/WalletShell';
import type { Settings } from '../../frontend/src/lib/types/ui';

describe('React wallet shell navigation', () => {
  test('keeps decorative rail indices out of accessible button names', () => {
    const settings = {
      theme: 'dark',
      liteMode: false,
      showTimeMachine: false,
      showXlnMascot: false,
    } as Settings;
    const html = renderToStaticMarkup(<WalletShell
      wallet={{
        activeRuntimeId: 'runtime-1',
        runtimes: [{
          id: 'runtime-1',
          label: 'Primary',
          createdAt: 1,
          signerCount: 1,
          unlocked: true,
          entityId: `0x${'1'.repeat(64)}`,
          signerId: `0x${'2'.repeat(40)}`,
        }],
      }}
      settings={settings}
      connected
      online
      onSelectRuntime={async () => {}}
      onSelectEntity={async () => {}}
      onLockRuntime={async () => {}}
      onTheme={() => {}}
      onLiteMode={() => {}}
      onTimeMachine={() => {}}
      onMascot={() => {}}
    />);

    expect(html.match(/<span aria-hidden="true">/g)).toHaveLength(10);
    expect(html).toContain('data-testid="wallet-nav-swap"');
    expect(html).toContain('data-testid="context-current"');
    expect(html).toContain(`data-entity-id="0x${'1'.repeat(64)}"`);
    expect(html).toContain(`data-signer-id="0x${'2'.repeat(40)}"`);
    expect(html).not.toContain('<span>08</span>Swap');
  });

  test('reports the visible account entity instead of a different vault signer', () => {
    const identity = resolveWalletShellIdentity({
      id: 'runtime-1', label: 'Primary', createdAt: 1, signerCount: 2, unlocked: true,
      entityId: 'entity-default', signerId: 'signer-default',
    }, {
      runtimeId: 'runtime-1', entityId: 'entity-visible', signerId: 'signer-visible',
    });

    expect(identity).toEqual({
      runtimeId: 'runtime-1', entityId: 'entity-visible', signerId: 'signer-visible',
    });
  });

  test('projects deterministic local entity lanes for the active runtime', () => {
    const entity = (entityId: string, runtimeId: string, jurisdiction: string, isHub = false) => ({
      entityId, runtimeId, signerId: 'signer', label: entityId, height: 1, isHub,
      jurisdiction, jurisdictionRef: `stack:${jurisdiction}`,
    });
    const entities = resolveWalletShellEntities('runtime-1', [
      entity('tron', 'runtime-1', 'Tron'),
      entity('remote', 'runtime-2', 'Testnet'),
      entity('hub', 'runtime-1', 'Testnet', true),
      entity('testnet', 'runtime-1', 'Testnet'),
    ]);

    expect(entities.map(item => item.entityId)).toEqual(['testnet', 'tron']);
  });
});
