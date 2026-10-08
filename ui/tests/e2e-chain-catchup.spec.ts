import { expect, test } from '@playwright/test';
import type { RuntimeReplica } from '../../core/api/public/runtime-module';
import { enterStack } from './stack';

test('fresh Entity imports during RPC catch-up retain a contiguous chain prefix', { tag: '@resilience' }, async ({ page, request }) => {
	test.setTimeout(90_000);
	const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
		const response = await request.post('/rpc', { data: { jsonrpc: '2.0', id: 1, method, params } });
		expect(response.ok()).toBe(true);
		const body = await response.json();
		expect(body.error).toBeUndefined();
		return body.result;
	};
	// Several authenticated pages must finish while the wallet imports its
	// entities. A short fresh chain did not expose the missing-prefix deadlock.
	const head = Number(BigInt(String(await rpc('eth_blockNumber'))));
	if (head < 1_024) {
		expect(await rpc('eth_chainId'), 'mining is restricted to the local dev chain').toBe('0x7a69');
		await rpc('anvil_mine', [`0x${(1_024 - head).toString(16)}`]);
	}
	const target = Number(BigInt(String(await rpc('eth_blockNumber'))));
	expect(target).toBeGreaterThanOrEqual(1_024);
	const started = performance.now();
	await enterStack(page);
	expect(performance.now() - started, 'fresh wallet opens within its chain-scan budget').toBeLessThan(60_000);
	// Only the primary chain (31337) is under test; the second chain's replica builds its history
	// a few seconds later and must not fail this read before its own scan starts.
	const readPrimary = () =>
		page.evaluate(() => {
			const debug = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln;
			const env = debug?.env();
			if (!env) throw new Error('CATCHUP_RUNTIME_MISSING');
			return [...env.state.eReplicas.values()]
				.filter(replica => replica.state.config.jurisdiction?.chainId === 31_337)
				.map(replica => {
					const history = replica.jHistory;
					if (!history) return { contiguous: -1, scanned: -1 };
					let contiguous = Number(replica.state.lastFinalizedJHeight);
					while (history.blockHashes.has(contiguous + 1)) contiguous += 1;
					return { contiguous, scanned: history.scannedThroughHeight };
				});
		});
	await expect
		.poll(async () => (await readPrimary()).every(history => history.contiguous >= target), { timeout: 15_000 })
		.toBe(true);
	const histories = await readPrimary();
	expect(histories.length).toBeGreaterThan(0);
	for (const history of histories) {
		expect(history.contiguous).toBeGreaterThanOrEqual(target);
		expect(history.contiguous).toBe(history.scanned);
	}
	await test.info().attach('catchup-prefix', { body: JSON.stringify({ target, histories }), contentType: 'application/json' });
});
