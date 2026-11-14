# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e-svelte-cross-tutorial.spec.ts >> Svelte cross tutorial uses a visible quote and proves delivery with a persistent completed row
- Location: ui/tests/e2e-svelte-cross-tutorial.spec.ts:35:0

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Create or restore a personal wallet', exact: true })

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - text: The server is configured with a public base URL of /ui/ - did you mean to visit
  - link "/ui/app" [ref=e2] [cursor=pointer]:
    - /url: /ui/app
  - text: instead?
```

# Test source

```ts
  1  | import { expect, test, type Page } from '@playwright/test';
  2  | import { formatUnits, parseUnits } from 'ethers';
  3  | import { deriveDelta } from '../../core/account/utils';
  4  | import type { RuntimeReplica } from '../../core/runtime/types';
  5  | 
  6  | async function crossEvidence(page: Page, sourceEntityId: string) {
  7  |   const evidence = await page.evaluate(sourceId => {
  8  |     const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
  9  |     if (!runtime) throw new Error('CROSS_TUTORIAL_RUNTIME_MISSING');
  10 |     const entities = [...runtime.state.eReplicas.values()];
  11 |     const source = entities.find(entity => entity.entityId === sourceId);
  12 |     const route = [...(source?.state.crossJurisdictionSwaps?.values() ?? [])].find(order => order.source.entityId === sourceId);
  13 |     if (!source || !route) return null;
  14 |     const target = entities.find(entity => entity.entityId === route.target.counterpartyEntityId);
  15 |     const sourceAccount = source.state.accounts.get(route.source.counterpartyEntityId);
  16 |     const targetAccount = target?.state.accounts.get(route.target.entityId);
  17 |     const sourceDelta = sourceAccount?.state.deltas.get(route.source.tokenId);
  18 |     const targetDelta = targetAccount?.state.deltas.get(route.target.tokenId);
  19 |     if (!sourceAccount || !targetAccount || !sourceDelta || !targetDelta) throw new Error('CROSS_TUTORIAL_ACCOUNT_MISSING');
  20 |     return {
  21 |       orderId: route.orderId, status: route.status, targetEntityId: route.target.counterpartyEntityId,
  22 |       filledSource: route.filledSourceAmount, filledTarget: route.filledTargetAmount,
  23 |       sourceProof: route.sourceCloseProof, targetProof: route.targetCloseProof,
  24 |       sourceDelta, targetDelta,
  25 |       sourceIsLeft: sourceAccount.state.leftEntity === sourceId,
  26 |       targetIsLeft: targetAccount.state.leftEntity === route.target.counterpartyEntityId,
  27 |     };
  28 |   }, sourceEntityId);
  29 |   if (!evidence) return null;
  30 |   const source = deriveDelta(evidence.sourceDelta, evidence.sourceIsLeft);
  31 |   const target = deriveDelta(evidence.targetDelta, evidence.targetIsLeft);
  32 |   return { ...evidence, sourceOwned: source.outCollateral + source.outPeerCredit - source.inOwnCredit, targetOwned: target.outCollateral + target.outPeerCredit - target.inOwnCredit };
  33 | }
  34 | 
  35 | test('Svelte cross tutorial uses a visible quote and proves delivery with a persistent completed row', { tag: '@functional' }, async ({ page }, info) => {
  36 |   test.setTimeout(60_000);
  37 |   const errors: string[] = [];
  38 |   page.on('pageerror', error => errors.push(error.message));
  39 |   await page.goto('/app');
> 40 |   await page.getByRole('button', { name: 'Create or restore a personal wallet', exact: true }).click();
     |                                                                                               ^ Error: click: Test timeout of 60000ms exceeded.
  41 |   const name = `cross-guide-${crypto.randomUUID()}`;
  42 |   await page.locator('#name').fill(name);
  43 |   await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable cross tutorial E2E 2026!');
  44 |   await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
  45 |   await page.getByRole('button', { name: 'Start', exact: true }).click();
  46 |   const sourceId = await page.getByTestId('context-current').getAttribute('data-entity-id');
  47 |   if (!sourceId) throw new Error('CROSS_TUTORIAL_SOURCE_MISSING');
  48 |   await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  49 |   await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
  50 |   await expect(page.getByTestId('account-preview').first()).toContainText('100');
  51 |   await page.getByTestId('wallet-tutorial').click();
  52 |   await page.getByTestId('tour-chapter').selectOption('cross');
  53 |   await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'cross');
  54 |   const targetOption = page.getByTestId('swap-ticket-to-network').locator('option').filter({ hasText: /\(Tron\)$/ });
  55 |   await expect(targetOption).toHaveCount(1);
  56 |   const targetId = await targetOption.getAttribute('value');
  57 |   if (!targetId) throw new Error('CROSS_TUTORIAL_TARGET_MISSING');
  58 |   await page.getByTestId('swap-ticket-to-network').selectOption(targetId);
  59 |   await page.getByTestId('swap-ticket-to-token').selectOption('3');
  60 |   await page.getByTestId('swap-ticket-amount').fill('25');
  61 |   await expect(page.getByTestId('swap-ticket-use-market')).toBeEnabled();
  62 |   await page.getByTestId('swap-ticket-use-market').click();
  63 |   await expect(page.getByTestId('swap-ticket-submit')).toBeEnabled();
  64 |   const quoted = parseUnits((await page.getByTestId('swap-min-net-receive').innerText()).replace(' USDT', '').trim(), 6);
  65 |   expect(quoted).toBeGreaterThan(0n);
  66 |   await page.getByTestId('swap-ticket-submit').click();
  67 |   await expect.poll(async () => (await crossEvidence(page, sourceId))?.status).toBe('settled');
  68 |   const evidence = await crossEvidence(page, sourceId);
  69 |   if (!evidence?.filledSource || !evidence.filledTarget) throw new Error('CROSS_TUTORIAL_FILL_MISSING');
  70 |   expect(evidence.sourceProof).toEqual(evidence.targetProof);
  71 |   expect(evidence.sourceProof?.cumulativeSourceAmount).toBe(evidence.filledSource);
  72 |   expect(evidence.sourceProof?.cumulativeTargetAmount).toBe(evidence.filledTarget);
  73 |   expect(evidence.sourceOwned).toBe(100_000_000n - evidence.filledSource);
  74 |   expect(evidence.targetOwned).toBe(evidence.filledTarget);
  75 |   expect(evidence.filledTarget).toBeGreaterThanOrEqual(quoted);
  76 |   const row = page.getByTestId('cross-swap-order').filter({ hasText: 'Testnet → Tron' });
  77 |   await expect(row).toHaveAttribute('data-status', 'settled');
  78 |   await expect(row.getByTestId('cross-swap-delivery')).toContainText(`${formatUnits(evidence.filledTarget, 6)} USDT`);
  79 |   await expect(page.locator('dialog[open], [aria-modal="true"]')).toHaveCount(0);
  80 |   await page.getByTestId('swap-ticket-amount').fill('12');
  81 |   await expect(page.getByTestId('swap-ticket-amount')).toBeFocused();
  82 |   await page.getByTestId('context-current').click();
  83 |   await page.getByTestId('context-entity-row').and(page.locator(`[data-entity-id="${evidence.targetEntityId}"]`)).click();
  84 |   await expect(page.getByTestId('jurisdiction-banner')).toContainText('Tron');
  85 |   await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'cross');
  86 |   await expect(page.getByTestId('account-preview').first()).toContainText(formatUnits(evidence.filledTarget, 6));
  87 |   await expect(page.getByTestId('cross-swap-order')).toHaveAttribute('data-status', 'settled');
  88 |   await page.screenshot({ path: info.outputPath('cross-tutorial-delivered.png'), fullPage: true });
  89 |   expect(errors).toEqual([]);
  90 | });
  91 | 
```