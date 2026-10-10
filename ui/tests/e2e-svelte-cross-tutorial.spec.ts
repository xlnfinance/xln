import { expect, test, type Page } from '@playwright/test';
import { formatUnits, parseUnits } from 'ethers';
import { deriveDelta } from '../../core/account/utils';
import type { RuntimeReplica } from '../../core/runtime/types';

async function crossEvidence(page: Page, sourceEntityId: string) {
  const evidence = await page.evaluate(sourceId => {
    const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
    if (!runtime) throw new Error('CROSS_TUTORIAL_RUNTIME_MISSING');
    const entities = [...runtime.state.eReplicas.values()];
    const source = entities.find(entity => entity.entityId === sourceId);
    const route = [...(source?.state.crossJurisdictionSwaps?.values() ?? [])].find(order => order.source.entityId === sourceId);
    if (!source || !route) return null;
    const target = entities.find(entity => entity.entityId === route.target.counterpartyEntityId);
    const sourceAccount = source.state.accounts.get(route.source.counterpartyEntityId);
    const targetAccount = target?.state.accounts.get(route.target.entityId);
    const sourceDelta = sourceAccount?.state.deltas.get(route.source.tokenId);
    const targetDelta = targetAccount?.state.deltas.get(route.target.tokenId);
    if (!sourceAccount || !targetAccount || !sourceDelta || !targetDelta) throw new Error('CROSS_TUTORIAL_ACCOUNT_MISSING');
    return {
      orderId: route.orderId, status: route.status, targetEntityId: route.target.counterpartyEntityId,
      filledSource: route.filledSourceAmount, filledTarget: route.filledTargetAmount,
      sourceProof: route.sourceCloseProof, targetProof: route.targetCloseProof,
      sourceDelta, targetDelta,
      sourceIsLeft: sourceAccount.state.leftEntity === sourceId,
      targetIsLeft: targetAccount.state.leftEntity === route.target.counterpartyEntityId,
    };
  }, sourceEntityId);
  if (!evidence) return null;
  const source = deriveDelta(evidence.sourceDelta, evidence.sourceIsLeft);
  const target = deriveDelta(evidence.targetDelta, evidence.targetIsLeft);
  return { ...evidence, sourceOwned: source.outCollateral + source.outPeerCredit - source.inOwnCredit, targetOwned: target.outCollateral + target.outPeerCredit - target.inOwnCredit };
}

test('Svelte cross tutorial uses a visible quote and proves delivery with a persistent completed row', { tag: '@functional' }, async ({ page }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app');
  const name = `cross-guide-${crypto.randomUUID()}`;
  await page.locator('#name').fill(name);
  await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable cross tutorial E2E 2026!');
  await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const sourceId = await page.getByTestId('context-current').getAttribute('data-entity-id');
  if (!sourceId) throw new Error('CROSS_TUTORIAL_SOURCE_MISSING');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
  await expect(page.getByTestId('account-preview').first()).toContainText('100');
  await page.getByTestId('wallet-tutorial').click();
  await page.getByTestId('tour-chapter').selectOption('cross');
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'cross');
  await page.getByTestId('swap-ticket-to-network').selectOption({ label: `${name} (Tron)` });
  await page.getByTestId('swap-ticket-to-token').selectOption('3');
  await page.getByTestId('swap-ticket-amount').fill('25');
  await expect(page.getByTestId('swap-ticket-use-market')).toBeEnabled();
  await page.getByTestId('swap-ticket-use-market').click();
  await expect(page.getByTestId('swap-ticket-submit')).toBeEnabled();
  const quoted = parseUnits((await page.getByTestId('swap-min-net-receive').innerText()).replace(' USDT', '').trim(), 6);
  expect(quoted).toBeGreaterThan(0n);
  await page.getByTestId('swap-ticket-submit').click();
  await expect.poll(async () => (await crossEvidence(page, sourceId))?.status).toBe('settled');
  const evidence = await crossEvidence(page, sourceId);
  if (!evidence?.filledSource || !evidence.filledTarget) throw new Error('CROSS_TUTORIAL_FILL_MISSING');
  expect(evidence.sourceProof).toEqual(evidence.targetProof);
  expect(evidence.sourceProof?.cumulativeSourceAmount).toBe(evidence.filledSource);
  expect(evidence.sourceProof?.cumulativeTargetAmount).toBe(evidence.filledTarget);
  expect(evidence.sourceOwned).toBe(100_000_000n - evidence.filledSource);
  expect(evidence.targetOwned).toBe(evidence.filledTarget);
  expect(evidence.filledTarget).toBeGreaterThanOrEqual(quoted);
  const row = page.getByTestId('cross-swap-order').filter({ hasText: 'Testnet → Tron' });
  await expect(row).toHaveAttribute('data-status', 'settled');
  await expect(row.getByTestId('cross-swap-delivery')).toContainText(`${formatUnits(evidence.filledTarget, 6)} USDT`);
  await expect(page.locator('dialog[open], [aria-modal="true"]')).toHaveCount(0);
  await page.getByTestId('swap-ticket-amount').fill('12');
  await expect(page.getByTestId('swap-ticket-amount')).toBeFocused();
  await page.getByTestId('context-current').click();
  await page.getByTestId('context-entity-row').filter({ hasText: name }).and(page.locator(`[data-entity-id="${evidence.targetEntityId}"]`)).click();
  await expect(page.getByTestId('jurisdiction-banner')).toContainText('Tron');
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'cross');
  await expect(page.getByTestId('account-preview').first()).toContainText(formatUnits(evidence.filledTarget, 6));
  await expect(page.getByTestId('cross-swap-order')).toHaveAttribute('data-status', 'settled');
  await page.screenshot({ path: info.outputPath('cross-tutorial-delivered.png'), fullPage: true });
  expect(errors).toEqual([]);
});
