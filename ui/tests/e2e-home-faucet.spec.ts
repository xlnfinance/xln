import { expect, test } from '@playwright/test';
import { enterStack, readWalletCheckpoint, reopenStack } from './stack';

test(
  'one Home click receives 100 USDC without leaving Home; funds survive reload',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const wallet = await enterStack(page);
    // Observe idle persistence on the real two-chain stand before the economic action.
    await page.waitForTimeout(2_000);
    const baseline = await page.evaluate(() => {
      const env = (window as Window & { __xln: {
        env(): import('../../core/api/public/runtime-module').RuntimeReplica;
      } }).__xln.env();
      return { height: env.state.height, histories: [...env.state.eReplicas.values()].map(replica => {
        if (!replica.jHistory) throw new Error(`Idle baseline has no J history: ${replica.entityId}`);
        return { entityId: replica.entityId, jurisdictionRef: replica.jHistory.jurisdictionRef,
          scannedThroughHeight: replica.jHistory.scannedThroughHeight, tipBlockHash: replica.jHistory.tipBlockHash };
      }) };
    });
    const idleBefore = await readWalletCheckpoint(page, baseline.height);
    await page.waitForTimeout(8_000);
    const idleAfter = await readWalletCheckpoint(page);
    const idleFrames = idleAfter.frame.height - baseline.height;
    console.log(`IDLE: ${idleFrames} Runtime frames / 8 seconds`);
    const idleJournal = await page.evaluate(async ({ from, to }) => {
      const debug = (window as Window & { __xln: {
        env(): import('../../core/api/public/runtime-module').RuntimeReplica;
        xln(): Promise<import('../../core/api/public/runtime-module').XLNModule>;
      } }).__xln;
      const xln = await debug.xln();
      const frames = [];
      for (let height = from + 1; height <= to; height++) {
        const frame = await xln.readPersistedFrameJournal(debug.env(), height);
        if (!frame) throw new Error(`Idle WAL frame missing: ${height}`);
        if (frame.runtimeInput.entityInputs.length !== 0) throw new Error(`Idle Entity input at R${height}`);
        const observations = frame.runtimeInput.runtimeTxs.map(tx => {
          if (tx.type !== 'observeJRange') throw new Error(`Unexpected idle RuntimeTx: ${tx.type}`);
          return tx.data;
        });
        frames.push({ height, timestamp: frame.timestamp, observations });
      }
      return frames;
    }, { from: baseline.height, to: idleAfter.frame.height });
    await test.info().attach('idle-runtime-journal', { body: JSON.stringify({ baseline, frames: idleJournal }), contentType: 'application/json' });
    // Watchers persist every authenticated advance, including multiple polls
    // per chain. The invariant is nonredundant evidence, not a wall-clock cap.
    const tips = new Map(baseline.histories.map(history => [`${history.entityId}:${history.jurisdictionRef}`, history]));
    for (const frame of idleJournal) {
      expect(frame.observations.length).toBeGreaterThan(0);
      for (const observation of frame.observations) {
        const key = `${observation.entityId}:${observation.jurisdictionRef}`;
        const previous = tips.get(key);
        if (!previous) throw new Error(`Idle observation has no baseline: ${key}`);
        expect(observation.blocks).toEqual([]);
        expect(observation.scannedThroughHeight).toBeGreaterThan(previous.scannedThroughHeight);
        expect(observation.tipBlockHash).not.toBe(previous.tipBlockHash);
        tips.set(key, observation);
      }
    }
    expect(idleAfter.accounts).toEqual(idleBefore.accounts);
    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 30_000 });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('token-net-USDC')).toContainText('100');
    await expect(page.getByText('liveness', { exact: true })).toHaveCount(0);
    await expect(page.getByText('proposeAccountsNow', { exact: true })).toHaveCount(0);
    const funded = await readWalletCheckpoint(page);
    await page.screenshot({ path: 'tests/test-results/home-funded.png', fullPage: true });
    await page.reload();
    await reopenStack(page, wallet);
    await expect(page.getByTestId('token-net-USDC')).toContainText('100');
    const restored = await readWalletCheckpoint(page);
    expect(restored.accounts.map(a => a.balances)).toEqual(funded.accounts.map(a => a.balances));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'tests/test-results/home-mobile.png', fullPage: true });
  },
);
