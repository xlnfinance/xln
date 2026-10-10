import { expect, test } from '@playwright/test';
import type { RuntimeAdapterViewFrame } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { enterStack } from './stack';

test('hub opening excludes foreign stacks and rejects their pasted IDs', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  await enterStack(page);
  const foreignId = await page.evaluate(async () => {
    const debug = (window as Window & { __xln?: {
      adapter(): RuntimeAdapter | null;
      store: { getState(): { activeEntityId: string | null } };
    } }).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Active wallet unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const ownChain = frame.activeEntity?.core.config.jurisdiction?.chainId;
    const foreign = frame.entities.find(entity => entity.isHub && entity.jurisdiction?.chainId !== ownChain);
    if (!foreign) throw new Error('Foreign-chain hub fixture missing');
    return foreign.entityId;
  });
  await page.getByTestId('home-open-account').click();
  const sheet = page.getByRole('dialog', { name: 'Open account' });
  await expect(sheet.locator('.picker-option').filter({ hasText: 'on Tron' })).toHaveCount(0);
  await expect(sheet.locator('.picker-option').filter({ hasText: 'on Testnet' }).first()).toBeVisible();
  await sheet.getByPlaceholder('or paste an entity id, 0x…').fill(foreignId);
  await expect(sheet.getByRole('alert')).toContainText('same jurisdiction and contract stack');
  await expect(sheet.getByRole('button', { name: 'Propose account', exact: true })).toBeDisabled();
});
