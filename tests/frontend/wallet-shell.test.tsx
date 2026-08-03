import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from '../../frontend/node_modules/react-dom/server.browser.js';

import { WalletLoading } from '../../frontend/apps/wallet/src/WalletBootScreens';
import { WalletSettings, WalletShell } from '../../frontend/apps/wallet/src/WalletShell';
import type { WalletViewSnapshot } from '../../frontend/apps/wallet/src/wallet-view-store';
import type { Settings } from '../../frontend/src/lib/types/ui';

const wallet: WalletViewSnapshot = {
  activeRuntimeId: '0x1234567890abcdef',
  runtimes: [{
    id: '0x1234567890abcdef',
    label: 'Primary',
    createdAt: 1,
    signerCount: 2,
    unlocked: true,
  }],
};

const settings = {
  theme: 'dark',
  liteMode: false,
  showTimeMachine: false,
  showXlnMascot: false,
} as Settings;

const noAction = async (): Promise<void> => undefined;

test('loading surface exposes the preserved behavior id and current boot evidence', () => {
  const html = renderToStaticMarkup(<WalletLoading phase="loading-vault" />);
  expect(html).toContain('data-testid="app-loading-screen"');
  expect(html).toContain('Opening the protected vault');
  expect(html).toContain('aria-busy="true"');
});

test('ready shell has navigation, connection evidence, runtime selection, and no placeholder panels', () => {
  const html = renderToStaticMarkup(
    <WalletShell
      wallet={wallet}
      settings={settings}
      connected
      online
      onSelectRuntime={noAction}
      onLockRuntime={noAction}
      onTheme={() => undefined}
      onLiteMode={() => undefined}
      onTimeMachine={() => undefined}
      onMascot={() => undefined}
    />,
  );
  expect(html).toContain('data-testid="app-runtime-ready"');
  expect(html).toContain('aria-label="Wallet navigation"');
  expect(html).toContain('Active runtime');
  expect(html).toContain('Runtime state');
  expect(html).not.toContain('coming soon');
});

test('settings controls render from the canonical settings snapshot', () => {
  const html = renderToStaticMarkup(
    <WalletSettings
      settings={settings}
      onTheme={() => undefined}
      onLiteMode={() => undefined}
      onTimeMachine={() => undefined}
      onMascot={() => undefined}
    />,
  );
  expect(html).toContain('display preferences');
  expect(html).toContain('Lite mode');
  expect(html).toContain('Time machine');
});
