import { expect, test } from '@playwright/test';
import type { RuntimeReplica } from '../../core/api/public/runtime-module';
import { readWalletCheckpoint } from './stack';

// Capture compact scan evidence without recording every historical RPC payload.
test.use({ trace: 'off', video: 'off' });

test('test wallet preserves its funded Runtime and Account heads without a password', { tag: '@resilience' }, async ({ page }, info) => {
		test.setTimeout(60_000);
		page.on('console', message => {
			if (message.type() === 'error') console.error('DEMO_BROWSER_ERROR', message.text());
		});
		console.log('DEMO_STAGE navigate');
		await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10_000 });
		console.log('DEMO_STAGE start');
		const startedAt = Date.now();
		await page.getByTestId('gate-learn').click({ timeout: 10_000 });
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
		console.log('DEMO_STAGE syncing');
		try {
			await expect(page.getByTestId('home-total')).toBeVisible({ timeout: 55_000 });
			console.log('DEMO_HOME_ELAPSED_MS', Date.now() - startedAt);
			await page.getByTestId('home-faucet').click();
			await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
			await expect(page.getByTestId('token-net-USDC')).toContainText('100');
			await expect(page).toHaveURL(/\/$/);
			console.log('DEMO_FUNDED_ELAPSED_MS', Date.now() - startedAt);
			await expect.poll(async () => {
				const checkpoint = await readWalletCheckpoint(page);
				return checkpoint.accounts.length > 0 && checkpoint.accounts.every(account => !account.pending && account.mempool === 0);
			}).toBe(true);
			const before = await readWalletCheckpoint(page);
			const balance = await page.getByTestId('home-total').innerText();
			await page.reload({ waitUntil: 'domcontentloaded' });
			await page.getByRole('button', { name: 'Continue', exact: true }).click();
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
			await expect(page.getByTestId('home-total')).toHaveText(balance);
			const restored = await readWalletCheckpoint(page, before.frame.height);
			expect(restored.runtimeId).toBe(before.runtimeId);
			expect(restored.entityId).toBe(before.entityId);
			expect(restored.frame).toEqual(before.frame);
			expect(restored.accounts).toEqual(before.accounts);
		} finally {
			const evidence = await page.evaluate(() => {
				const debug = (
					window as Window & {
						__xln?: {
							env(): RuntimeReplica | null;
						};
					}
				).__xln;
				const env = debug?.env();
				if (!debug || !env) return { runtimeAvailable: false };
				const statuses = [...env.state.eReplicas].map(([key, replica]) => ({
					key,
					height: replica.state.height,
					finalized: replica.state.lastFinalizedJHeight,
					scanned: replica.jHistory?.scannedThroughHeight,
					headerCount: replica.jHistory?.blockHashes.size,
					pending: replica.mempool.length,
					accounts: [...replica.state.accounts].map(([peer, account]) => ({
						peer,
						height: account.currentHeight,
						pendingHeight: account.pendingFrame?.height,
						mempool: account.mempool.length,
						credit: [...account.state.deltas].map(([token, delta]) => ({
							token,
							left: delta.leftCreditLimit.toString(),
							right: delta.rightCreditLimit.toString(),
						})),
					})),
					certified: replica.jPrefixRound?.certificate?.selected.scannedThroughHeight,
				}));
				return {
					height: env.state.height,
					statuses,
					readers: env.infrastructure?.activeCommittedReaders,
					writers: env.infrastructure?.queuedFrameWriters,
					writerTicket: env.infrastructure?.frameWriterTicket,
					writersCompleted: env.infrastructure?.completedFrameWriters,
					processing: Boolean(env.infrastructure?.processingPromise),
					inputs: env.runtimeMempool?.entityInputs.map(input => ({
						entity: input.entityId,
						signer: input.signerId,
						txs: input.entityTxs.map(tx => tx.type),
					})),
				};
			});
			await info.attach('chain-sync-status', { body: JSON.stringify(evidence), contentType: 'application/json' });
			console.log('DEMO_CHAIN_SYNC_STATUS', JSON.stringify(evidence));
		}
});
