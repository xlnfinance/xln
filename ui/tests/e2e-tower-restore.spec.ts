import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enterStack, fundFromHub, readWalletCheckpoint, reopenStack, LOCAL_PASSWORD } from './stack';

// Bundle before opening a wallet: a raw core import makes Vite optimize new
// dependencies and reload the live page, destroying its memory-only session.
const hashModule = fileURLToPath(new URL('../../.logs/qa/browser-helpers/canonical-hash.mjs', import.meta.url));
test.beforeAll(() => {
  mkdirSync(fileURLToPath(new URL('../../.logs/qa/browser-helpers/', import.meta.url)), { recursive: true });
  execFileSync('bun', ['build', fileURLToPath(new URL('../../core/storage/canonical-hash.ts', import.meta.url)),
    '--target=browser', '--outfile', hashModule], { timeout: 60_000, stdio: 'pipe' });
});

async function journal(page: Page, height: number) {
  return page.evaluate(async height => {
    const debug = (window as Window & { __xln: { env(): import('../../core/api/public/runtime-module').RuntimeReplica; xln(): Promise<import('../../core/api/public/runtime-module').XLNModule> } }).__xln;
    const xln = await debug.xln();
    return JSON.stringify(await xln.readPersistedFrameJournal(debug.env(), height), (key, value) => key === 'runtimeSeed' ? undefined : typeof value === 'bigint' ? value.toString() : value);
  }, height);
}

async function canonicalRoot(page: Page, height: number): Promise<string> {
  const moduleUrl = `/@fs${hashModule}`;
  return page.evaluate(async ({ height, moduleUrl }) => {
    const debug = (window as Window & { __xln: { env(): import('../../core/api/public/runtime-module').RuntimeReplica; xln(): Promise<import('../../core/api/public/runtime-module').XLNModule> } }).__xln;
    const xln = await debug.xln();
    const env = debug.env();
    const canonical = await import(/* @vite-ignore */ moduleUrl);
    const frame = await xln.readPersistedFrameJournal(env, height);
    if (!frame) throw new Error('Missing recovery frame');
    const hashes = [];
    const seen = new Set<string>();
    for (const replica of env.state.eReplicas.values()) {
      if (seen.has(replica.entityId)) continue;
      seen.add(replica.entityId);
      const state = await xln.loadEntityStateFromStorageDb(env, replica.entityId, height);
      if (!state) throw new Error('Missing historical Entity');
      hashes.push(canonical.computeCanonicalEntityHash({ ...replica, state }));
    }
    return canonical.computeCanonicalRuntimeStateHash(height, frame.timestamp, hashes);
  }, { height, moduleUrl });
}

test('tower backup restores funded Account proofs on a clean device and refuses local overwrite', { tag: '@resilience' }, async ({ browser }) => {
	test.setTimeout(60_000);
	const source = await browser.newContext();
	const target = await browser.newContext();
	try {
		const page = await source.newPage();
		const wallet = await enterStack(page);
		const tower = await page.evaluate(async () => {
			const modulePath = '/src/native/backup.ts';
			const { nativeBackupAddress } = await import(modulePath);
			return nativeBackupAddress() as string;
		});
		await fundFromHub(page);
		await expect.poll(async () => (await readWalletCheckpoint(page)).accounts.every(account => !account.pending && account.mempool === 0)).toBe(true);
		await page.getByTestId('home-sovereignty').click();
		await page.getByTestId('watchtower-url').fill(tower);
		await page.getByTestId('watchtower-add').click();
		await expect(page.getByTestId('sovereignty-watchtower')).toHaveAttribute('data-covered', 'yes', { timeout: 20_000 });
		const coverage = await page.getByTestId('watchtower-coverage-backup').innerText();
		const match = coverage.match(/#([\d,]+)/);
		if (!match?.[1]) throw new Error(`Tower supplied no backup height: ${coverage}`);
		const before = await readWalletCheckpoint(page, Number(match[1].replaceAll(',', '')));
		const expectedCanonicalRoot = await canonicalRoot(page, before.frame.height);
		await test.info().attach('source-frame', { body: await journal(page, before.frame.height), contentType: 'application/json' });
		await test.info().attach('source-accounts', { body: JSON.stringify(before), contentType: 'application/json' });
		await source.close();

		const restoredPage = await target.newPage();
		await restoredPage.goto('/');
		const restore = async () => {
			await expect(restoredPage.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online');
			await restoredPage.getByRole('button', { name: /Restore a wallet/ }).click();
			await restoredPage.locator('textarea').fill(wallet.phrase);
			await restoredPage.getByTestId('restore-from-tower').check();
			await restoredPage.getByTestId('restore-tower-url').fill(tower);
			await restoredPage.getByRole('button', { name: 'Restore wallet', exact: true }).click();
		};
		await restore();
		await restoredPage.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
		await restoredPage.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
		await restoredPage.getByRole('button', { name: 'Save and open', exact: true }).click();
		await expect(restoredPage.locator('[data-testid="nav-home"]:visible, .gate-error').first()).toBeVisible({ timeout: 25_000 });
		await expect(restoredPage.locator('.gate-error')).toHaveCount(0);
		const after = await readWalletCheckpoint(restoredPage, before.frame.height);
		await test.info().attach('restored-frame', { body: await journal(restoredPage, before.frame.height), contentType: 'application/json' });
		await test.info().attach('restored-accounts', { body: JSON.stringify(after), contentType: 'application/json' });
		expect(after.runtimeId).toBe(before.runtimeId);
		expect(after.entityId).toBe(before.entityId);
		// Portable recovery creates a materialized baseline, so its WAL envelope digest
		// differs from a live frame. Compare the canonical Runtime root over every Entity.
		expect(await canonicalRoot(restoredPage, before.frame.height)).toBe(expectedCanonicalRoot);
		expect(after.accounts).toEqual(before.accounts);
		await restoredPage.reload();
		await restore();
		await expect(restoredPage.getByRole('alert')).toContainText('already has data', { timeout: 5000 });
		await expect(restoredPage.getByRole('heading', { name: 'Set a local password' })).toHaveCount(0);
		await restoredPage.reload();
		await reopenStack(restoredPage, wallet);
		expect((await readWalletCheckpoint(restoredPage, before.frame.height)).accounts).toEqual(before.accounts);
		console.log(`TOWER_RESTORE runtime=${after.runtimeId} height=${after.frame.height} root=${after.frame.postStateHash} accounts=${after.accounts.length}`);
	} finally {
		await source.close();
		await target.close();
	}
});
