import { expect, test } from '@playwright/test';
import { ZeroHash } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { computeAccountKey } from '../../core/jurisdiction/adapter/events/contract-codec';
import { safeStringify } from '../../core/protocol/serialization';
import { privateChain, chainMoney } from './dispute-chain';
import { AMOUNT, WAIT, fundCollateral, readState } from './dispute-wallet';
import { signedDisputePage, startStaleDispute } from './dispute-stale';
import { enterStack, fundFromHub, reopenStack } from './stack';

test.skip(!process.env['XLN_UI_DISPUTE_PRIVATE_RPC'], 'requires the private dispute stand');

test(
  'P6 appointed tower counters a stale signed state while the React wallet is offline and finalizes its full collateral',
  { tag: '@resilience' },
  async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(60_000);
    const provider = privateChain(baseURL);
    try {
      const wallet = await enterStack(page);
      await page.getByTestId('account-row').first().click();
      const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
      if (!hubId) throw new Error('P6_HUB_ACCOUNT_MISSING');
      await fundCollateral(page, hubId);
      await page.getByTestId('home-pay').click();
      await page.getByTestId('pay-to').fill('H1');
      await page.getByTestId('pay-amount').fill('25');
      await expect(page.getByTestId('pay-submit')).toBeEnabled(WAIT);
      await page.getByTestId('pay-submit').click();
      await page.getByTestId('receipt-open').click();
      await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', WAIT);
      await page.getByTestId('receipt-done').click();
      await expect.poll(async () => (await readState(page, hubId)).ownValue, WAIT).toBe('75000000');
      const stale = await signedDisputePage(page, hubId);
      await fundFromHub(page, '25');
      await expect
        .poll(async () => {
          const s = await readState(page, hubId);
          return [s.ownValue, s.pending, s.mempool];
        }, WAIT)
        .toEqual([AMOUNT.toString(), false, 0]);
      const latest = await signedDisputePage(page, hubId);
      expect(latest.peerNonce).toBeGreaterThan(stale.nonce);
      expect(latest.hash).not.toBe(stale.hash);
      const before = await readState(page, hubId);
      const contract = Depository__factory.connect(before.depository, provider);
      const tower = process.env['UI_E2E_TOWER_URL'];
      if (!tower) throw new Error('P6_TOWER_URL_MISSING');
      const healthResponse = await fetch(`${tower}/api/tower/healthz`);
      expect(healthResponse.ok).toBe(true);
      const health = (await healthResponse.json()) as { signerAddress: string; sweep: { enabled: boolean } };
      expect(health.sweep.enabled).toBe(true);
      await page.getByTestId('home-sovereignty').click();
      await page.getByTestId('watchtower-url').fill(tower);
      await page.getByTestId('watchtower-add').click();
      await expect(page.getByTestId('sovereignty-watchtower')).toHaveAttribute('data-covered', 'yes', WAIT);
      await page.getByTestId('protection-appoint').click();
      await expect(page.getByTestId('protection-state')).toContainText('1 account appointment receipts received', WAIT);
      await expect(page.getByRole('alert')).toHaveCount(0);
      const ownerNonce = await provider.getTransactionCount(before.signerId);
      await page.close();

      const start = await startStaleDispute(provider, before.depository, hubId, stale);
      const key = computeAccountKey(wallet.entityId, hubId);
      const started = await contract._accounts(key);
      expect(started.disputeHash).not.toBe(ZeroHash);
      expect(started.disputeCounterNonce).toBe(0n);
      const window = Number(stale.body.leftResponseSeconds) + Number(stale.body.rightResponseSeconds);
      const lastResortSeconds = Math.ceil(window * 0.2);
      await provider.send('evm_setNextBlockTimestamp', [Number(started.disputeTimeout) - lastResortSeconds + 1]);
      await provider.send('evm_mine', []);
      await expect
        .poll(async () => (await contract._accounts(key)).disputeCounterNonce, WAIT)
        .toBe(BigInt(latest.peerNonce));
      const counters = await contract.queryFilter(
        contract.filters.CounterDisputeRegistered(wallet.entityId, hubId),
        start.blockNumber,
      );
      expect(counters).toHaveLength(1);
      const counter = counters[0]!;
      expect(counter.args.nonce).toBe(BigInt(latest.peerNonce));
      expect(counter.args.proofbodyHash).toBe(latest.hash);
      const counterReceipt = await provider.getTransactionReceipt(counter.transactionHash);
      expect(counterReceipt?.from.toLowerCase()).toBe(health.signerAddress.toLowerCase());
      expect(counterReceipt?.gasUsed).toBeLessThanOrEqual(5_000_000n);
      await provider.send('evm_setNextBlockTimestamp', [Number(started.disputeTimeout) + 1]);
      await provider.send('evm_mine', []);
      await expect
        .poll(async () => (await chainMoney(contract, wallet.entityId, hubId)).reserve, WAIT)
        .toBe(AMOUNT.toString());
      const final = await chainMoney(contract, wallet.entityId, hubId);
      expect([final.disputeHash, final.collateral]).toEqual([ZeroHash, '0']);
      expect(await provider.getTransactionCount(before.signerId)).toBe(ownerNonce);
      const finalizations = await contract.queryFilter(
        contract.filters.DisputeFinalized(wallet.entityId, hubId),
        start.blockNumber,
      );
      expect(finalizations).toHaveLength(1);
      const finalReceipt = await provider.getTransactionReceipt(finalizations[0]!.transactionHash);
      expect(finalReceipt?.from.toLowerCase()).toBe(health.signerAddress.toLowerCase());
      expect(finalReceipt?.gasUsed).toBeLessThanOrEqual(5_000_000n);

      const returned = await context.newPage();
      await returned.goto('/');
      await reopenStack(returned, wallet);
      await expect
        .poll(async () => {
          const s = await readState(returned, hubId);
          return [s.status, s.reserve, s.dispute];
        }, WAIT)
        .toEqual(['disputed', AMOUNT.toString(), null]);
      await expect(returned.getByTestId('home-reserve').locator('strong')).toHaveText('$100.00');
      await expect(returned.getByTestId('home-risk').locator('strong')).toHaveText('$0.00');
      await testInfo.attach('p6-offline-defence', {
        body: safeStringify({
          oldNonce: stale.nonce,
          newNonce: latest.peerNonce,
          ownerNonce,
          tower: health.signerAddress,
          start: { hash: start.hash, gas: start.gasUsed },
          counter: { hash: counterReceipt?.hash, gas: counterReceipt?.gasUsed },
          finalize: { hash: finalReceipt?.hash, gas: finalReceipt?.gasUsed },
          final,
        }),
        contentType: 'application/json',
      });
    } finally {
      provider.destroy();
    }
  },
);
