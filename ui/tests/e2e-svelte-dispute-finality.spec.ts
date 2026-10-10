import { expect, test, type Page } from '@playwright/test';
import { ZeroHash } from 'ethers';
import type { RuntimeReplica } from '../../core/runtime/types';
import { safeStringify } from '../../core/protocol/serialization';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { privateChain, chainMoney, externalUsdc } from './dispute-chain';

const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };
const AMOUNT = 100_000_000n;
async function state(page: Page) {
  const owner = await page.getByTestId('context-current').getAttribute('data-entity-id');
  if (!owner) throw new Error('SVELTE_DISPUTE_OWNER_MISSING');
  return page.evaluate(entityId => {
    const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
    const entity = runtime && [...runtime.state.eReplicas.values()].find(replica => replica.state.entityId === entityId);
    const entry = entity && [...entity.state.accounts.entries()][0];
    const jurisdiction = entity?.state.config.jurisdiction;
    if (!entity || !entry || !jurisdiction) throw new Error('SVELTE_DISPUTE_ACCOUNT_MISSING');
    const [hubId, account] = entry;
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('SVELTE_DISPUTE_USDC_MISSING');
    return { entityId, signerId: entity.signerId, hubId, depository: jurisdiction.depositoryAddress,
      reserve: (entity.state.reserves.get(1) ?? 0n).toString(), collateral: delta.collateral.toString(),
      status: account.status, dispute: account.activeDispute ?? null, jNonce: account.state.jNonce,
      challengeSeconds: account.state.disputeConfig.leftResponseSeconds + account.state.disputeConfig.rightResponseSeconds };
  }, owner);
}
test.skip(!process.env['XLN_UI_DISPUTE_PRIVATE_RPC'], 'requires the isolated production wallet stand');
test('Svelte dispute returns collateral to reserve and permanently removes dispute actions', { tag: '@functional' }, async ({ page, baseURL }, info) => {
  test.setTimeout(60_000);
  const provider = privateChain(baseURL);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.clock.install();
    await page.goto('/app');
    await page.locator('#name').fill(`dispute-${crypto.randomUUID()}`);
    await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable local dispute E2E 2026!');
    // Exercise finalization with an explicitly persistent local authority lease.
    // The normal 10-minute auto-lock must not be bypassed by clock control.
    await page.getByRole('button', { name: /^Advanced Standard/ }).click();
    await page.locator('#unlock-duration').selectOption('forever');
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByTestId('tab-assets').click();
    expect(await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('xln-vaults') ?? '{}');
      return stored.runtimes[stored.activeRuntimeId].protectedSecrets.unlockUntil;
    }), 'Forever must persist an unlimited lease, not the ten-minute default').toBeNull();
    await page.getByTestId('asset-faucet-symbol').selectOption('ETH');
    await page.getByTestId('external-faucet-ETH').click();
    await page.getByTestId('asset-faucet-symbol').selectOption('USDC');
    await page.getByTestId('reserve-faucet-USDC').click();
    await expect.poll(async () => BigInt((await state(page)).reserve), WAIT).toBeGreaterThanOrEqual(AMOUNT);
    const before = await state(page);
    await page.getByTestId('asset-tab-move').click();
    await page.getByTestId('move-source-reserve').click();
    await page.getByTestId('move-target-account').click();
    await page.getByTestId('move-asset-symbol').selectOption('USDC');
    await page.getByTestId('move-amount').fill('100');
    await page.getByTestId('move-confirm').click();
    await page.getByTestId('settle-sign-broadcast').click();
    await expect.poll(async () => (await state(page)).collateral, WAIT).toBe(AMOUNT.toString());
    const funded = await state(page);
    expect(BigInt(funded.reserve)).toBe(BigInt(before.reserve) - AMOUNT);
    const contract = Depository__factory.connect(funded.depository, provider);
    const initialBlock = await provider.getBlockNumber();
    const fundedChain = await chainMoney(contract, funded.entityId, funded.hubId);
    expect(fundedChain.collateral).toBe(AMOUNT.toString());
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('dispute');
    await expect(page.getByTestId('configure-dispute-window')).toHaveAttribute('data-total-seconds', String(funded.challengeSeconds));
    await expect(page.getByTestId('configure-dispute-window')).toContainText('from the confirmed on-chain start');
    await page.getByTestId('configure-dispute-prepare').click();
    await page.getByTestId('settle-sign-broadcast').click();
    await expect.poll(async () => (await state(page)).dispute?.observedOnChain, WAIT).toBe(true);
    const started = await state(page);
    if (!started.dispute) throw new Error('SVELTE_DISPUTE_START_MISSING');
    await expect(page.getByTestId('configure-dispute-finalize')).toBeDisabled();
    const deadline = started.dispute.disputeTimeout + 1;
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await provider.send('evm_setNextBlockTimestamp', [deadline]);
    await provider.send('evm_mine', []);
    const host = await page.evaluate(() => Math.round(performance.timeOrigin + performance.now()));
    try { await page.clock.fastForward(deadline * 1000 - host); }
    finally { await page.clock.resume(); }
    await expect.poll(async () => {
      const current = await state(page);
      return [current.dispute, current.status, current.reserve, current.collateral];
    }, WAIT).toEqual([null, 'disputed', before.reserve, '0']);
    const finished = await state(page);
    const finalChain = await chainMoney(contract, finished.entityId, finished.hubId);
    expect(finalChain).toEqual({ ...fundedChain, reserve: before.reserve, collateral: '0', ondelta: '0', nonce: String(started.dispute.initialNonce + 1), disputeHash: ZeroHash, timeout: 0 });
    const finalizations = await contract.queryFilter(contract.filters.DisputeFinalized(finished.entityId, finished.hubId), initialBlock);
    expect(finalizations).toHaveLength(1);
    expect((await finalizations[0]!.getTransactionReceipt()).status).toBe(1);
    await expect(page.getByTestId('configure-dispute-closed')).toBeVisible();
    await expect(page.locator('[data-testid="configure-dispute-prepare"], [data-testid="configure-dispute-finalize"]')).toHaveCount(0);
    expect(errors).toEqual([]);
    await info.attach('svelte-dispute-finality', { body: safeStringify({ before, funded, started, finished, fundedChain, finalChain }), contentType: 'application/json' });
    const externalBefore = await externalUsdc(contract, funded.signerId, provider);
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.getByTestId('asset-tab-move').click();
    await page.getByTestId('move-source-reserve').click();
    await page.getByTestId('move-target-external').click();
    await page.getByTestId('move-asset-symbol').selectOption('USDC');
    await page.getByTestId('move-external-recipient').fill(funded.signerId);
    await page.getByTestId('move-amount').fill('100');
    await page.getByTestId('move-confirm').click();
    await page.getByTestId('settle-sign-broadcast').click();
    await expect.poll(() => externalUsdc(contract, funded.signerId, provider), WAIT).toBe(externalBefore + AMOUNT);
    await expect.poll(() => contract._reserves(funded.entityId, 1), WAIT).toBe(BigInt(before.reserve) - AMOUNT);
    await expect(page.getByTestId('external-balance-USDC')).toHaveAttribute('data-raw-amount', (externalBefore + AMOUNT).toString(), WAIT);
    await expect(page.getByTestId('reserve-balance-USDC')).toHaveAttribute('data-raw-amount', (BigInt(before.reserve) - AMOUNT).toString(), WAIT);
    await info.attach('withdrawn-dispute-proceeds', { body: safeStringify({ signerId: funded.signerId, before: externalBefore, after: await externalUsdc(contract, funded.signerId, provider) }), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('svelte-dispute-paid.png'), fullPage: true, animations: 'disabled' });
  } finally { provider.destroy(); }
});
