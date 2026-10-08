import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { EntityTx, RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { enterStack, readWalletCheckpoint, reopenStack } from './stack';
import { decodeRuntimeManifestEntries } from '../../core/scripts/operations/hlt/boundary/worker-boundary';

type DebugWindow = Window & { __xln?: { adapter(): RuntimeAdapter | null; env(): RuntimeReplica | null; xln(): Promise<XLNModule> } };

const send = (page: Page, entityId: string, counterparty: string, open: boolean) => page.evaluate(async input => {
  const adapter = (window as DebugWindow).__xln?.adapter();
  if (!adapter) throw new Error('Account adapter unavailable');
  const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: input.entityId });
  const signerId = view.activeEntity?.core.signerId;
  if (!signerId) throw new Error('Account signer unavailable');
  const tx: EntityTx = input.open
    ? { type: 'openAccount', data: { targetEntityId: input.counterparty,
      disputeConfig: { leftResponseSeconds: 3600, rightResponseSeconds: 3600 }, creditAmount: 1000000n, tokenId: 1, pinPublic: false } }
    : { type: 'extendCredit', data: { counterpartyEntityId: input.counterparty, amount: 1000000n, tokenId: 1 } };
  await adapter.send({ runtimeTxs: [], entityInputs: [{ entityId: input.entityId, signerId, entityTxs: [tx] }] });
}, { entityId, counterparty, open });

const read = (page: Page, entityId: string, other: string) => page.evaluate(async input => {
  const adapter = (window as DebugWindow).__xln?.adapter();
  if (!adapter) throw new Error('Account adapter unavailable');
  const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: input.entityId, accountsLimit: 100 });
  const account = frame.activeEntity?.accounts.items.find(row =>
    row.state.leftEntity === input.other || row.state.rightEntity === input.other);
  if (!account) return null;
  const delta = account.state.deltas.get(1);
  return { isLeft: account.state.leftEntity === input.entityId, count: account.state.subcontracts?.size ?? 0,
    statuses: [...(account.state.subcontracts?.values() ?? [])].map(clause => clause.status),
    pending: Boolean(account.pendingFrame), mempool: account.mempoolCount,
    offdelta: String(delta?.offdelta), leftHold: String(delta?.leftHold), rightHold: String(delta?.rightHold),
    leftCredit: String(delta?.leftCreditLimit), rightCredit: String(delta?.rightCreditLimit) };
}, { entityId, other });

async function openContracts(page: Page, other: string) {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-custom-contracts').click();
  await expect(page.getByTestId('custom-expert-warning')).toContainText('experts only');
  await page.getByTestId('custom-account').selectOption(other);
}

test('Custom Solidity compiles, both sign, executes once and survives reload', { tag: '@functional' }, async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  if (!a || !b) throw new Error('Two wallet pages required');
  const errors: string[] = [];
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
  try {
    const alice = await enterStack(a);
    console.log('CUSTOM_STAGE wallet-ready');
    await a.getByTestId('home-faucet').click();
    await expect(a.getByTestId('test-money-status')).toHaveText('100 USDC received');
    console.log('CUSTOM_STAGE funded');
    const bob = { entityId: await a.evaluate(async owner => {
      const adapter = (window as DebugWindow).__xln?.adapter();
      if (!adapter) throw new Error('User adapter unavailable');
      const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
      const account = view.activeEntity?.accounts.items[0];
      if (!account) throw new Error('User hub Account unavailable');
      return account.state.leftEntity === owner ? account.state.rightEntity : account.state.leftEntity;
    }, alice.entityId) };
    const manifestPath = process.env['E2E_RUNTIME_IMPORT_MANIFEST_PATH'];
    if (!manifestPath) throw new Error('Isolated stand manifest required');
    const hub = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8'))).find(entry => entry.label === 'H1');
    if (!hub) throw new Error('Real H1 owner unavailable');
    await b.goto('/');
    await b.getByRole('button', { name: 'Connect a remote runtime' }).click();
    await b.getByLabel('Runtime endpoint').fill(hub.wsUrl);
    await b.getByLabel('Access key · optional').fill(hub.token);
    await b.getByRole('button', { name: 'Connect', exact: true }).click();
    await b.getByRole('button').filter({ hasText: bob.entityId.slice(0, 18) }).click();
    await expect(b.getByTestId('home-total')).toBeVisible();
    console.log('CUSTOM_STAGE counterparty-ready');
    await expect.poll(() => read(a, alice.entityId, bob.entityId)).toMatchObject({ pending: false, mempool: 0 });
    const before = await read(a, alice.entityId, bob.entityId);
    if (!before) throw new Error('Bilateral Account missing');
    await Promise.all([openContracts(a, bob.entityId), openContracts(b, alice.entityId)]);
    await a.getByTestId('custom-compile').click();
    await expect(a.getByTestId('custom-compiled')).toContainText('0.8.25');
    console.log('CUSTOM_STAGE compiled');
    await a.getByTestId('param-tokenId').fill('1');
    await a.getByTestId('param-amount').fill('100');
    await a.getByTestId('param-payerIsLeft').setChecked(before.isLeft);
    await a.getByTestId('custom-token').selectOption('1');
    await a.getByTestId(before.isLeft ? 'custom-right-limit' : 'custom-left-limit').fill('100');
    await expect(a.getByTestId('custom-propose')).toBeEnabled();
    await a.getByTestId('custom-propose').click();
    await expect(b.getByTestId('custom-contract')).toHaveAttribute('data-status', 'proposed');
    await expect(b.getByTestId('contract-approve')).toBeDisabled();
    await b.getByTestId('contract-verify').click();
    await expect(b.getByTestId('contract-approve')).toBeEnabled();
    await b.getByTestId('contract-approve').click();
    await expect(a.getByTestId('custom-contract')).toHaveAttribute('data-status', 'active');
    console.log('CUSTOM_STAGE approved');
    await expect.poll(() => read(a, alice.entityId, bob.entityId)).toMatchObject({ count: 1,
      leftHold: before.isLeft ? '100' : '0', rightHold: before.isLeft ? '0' : '100' });
    await a.getByTestId('contract-verify').click();
    await a.getByTestId(before.isLeft ? 'right-arg-execute' : 'left-arg-execute').check();
    await expect(a.getByTestId('contract-resolve')).toBeEnabled();
    await a.getByTestId('contract-resolve').click();
    await expect(b.getByTestId('contract-confirm')).toBeVisible();
    console.log('CUSTOM_STAGE resolution-proposed');
    await b.getByTestId('contract-confirm').click();
    const offdelta = String(BigInt(before.offdelta) + (before.isLeft ? -100n : 100n));
    for (const [page, owner, other] of [[a, alice.entityId, bob.entityId], [b, bob.entityId, alice.entityId]] as const)
      await expect.poll(() => read(page, owner, other)).toMatchObject({ count: 0, offdelta, leftHold: '0', rightHold: '0', pending: false, mempool: 0 });
    const paid = await Promise.all([readWalletCheckpoint(a), readWalletCheckpoint(b)]);
    await a.reload();
    await reopenStack(a, alice);
    const restored = await Promise.all([readWalletCheckpoint(a), readWalletCheckpoint(b)]);
    expect(restored.map(value => value.accounts)).toEqual(paid.map(value => value.accounts));
    expect(errors).toEqual([]);
    console.log('CUSTOM_CONTRACT_BILATERAL_RECOVERED', JSON.stringify({ offdelta, accounts: restored.map(value => value.accounts) }));
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
