import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { safeStringify } from '../../core/protocol/serialization';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { chainMoney, externalUsdc, privateChain } from './dispute-chain';
import { AMOUNT, WAIT, faucet, fundCollateral, manageDispute, readState } from './dispute-wallet';
import { LOCAL_PASSWORD, enterStack } from './stack';
import {
  outageTargets,
  probe,
  proveDown,
  replaceRpcFromAlert,
  replaceRpcFromSettings,
  rpcBody,
  since,
  stopTargets,
  walletNetworks,
} from './hub-outage';

// Owner drill: a fully collateral-backed, co-signed user-Hub Account must exit
// while its Hub, the API that serves the wallet's published `/rpc` gateway and
// the watchtower are stopped. Only the settlement chain itself stays up. The
// chain clock is never moved: every deadline here is real elapsed time.
test.skip(
  !process.env['XLN_UI_DISPUTE_PRIVATE_RPC'] || !process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'],
  'needs a private dispute stand: XLN_UI_DISPUTE_PRIVATE_RPC and XLN_UI_DISPUTE_PRIVATE_ORIGIN',
);

test(
  'O1 fully secured user-Hub Account starts its unilateral exit, and own reserve reaches the external address, while Hub, API/RPC gateway and tower are down',
  { tag: '@resilience' },
  async ({ page, baseURL }, testInfo) => {
    test.setTimeout(300_000);
    const provider = privateChain(baseURL);
    const apiOrigin = process.env['XLN_UI_STACK_ORIGIN'];
    const towerOrigin = process.env['UI_E2E_TOWER_URL'];
    if (!apiOrigin || !towerOrigin) throw new Error('OUTAGE_STAND_ENDPOINTS_MISSING');
    const evidence: Record<string, unknown> = {
      baseURL,
      apiOrigin,
      towerOrigin,
      rpc: process.env['XLN_UI_DISPUTE_PRIVATE_RPC'],
    };
    // Persist after every stage: a test timeout must not lose the first-red evidence.
    const save = () => writeFileSync(testInfo.outputPath('hub-outage-exit.json'), safeStringify(evidence, 2));
    const attach = () =>
      testInfo.attach('hub-outage-exit', { body: safeStringify(evidence), contentType: 'application/json' });
    try {
      const wallet = await enterStack(page);
      await page.getByTestId('account-row').first().click();
      const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
      if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('OUTAGE_HUB_ACCOUNT_UNAVAILABLE');
      await fundCollateral(page, hubId);
      // Control A: a separate own reserve, exited without any Account dispute.
      await page.getByTestId('nav-manage').locator('visible=true').first().click();
      await page.getByTestId('manage-assets').click();
      await faucet(page, 'reserve', '100');
      await expect.poll(async () => (await readState(page, hubId)).reserve, WAIT).toBe(AMOUNT.toString());
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      const funded = await readState(page, hubId);
      const contract = Depository__factory.connect(funded.depository, provider);
      const fundedChain = await chainMoney(contract, wallet.entityId, hubId);
      const external = funded.signerId;
      const walletRpc = await walletNetworks(page);
      Object.assign(evidence, {
        wallet: { entityId: wallet.entityId, runtimeId: wallet.runtimeId },
        hubId,
        funded,
        fundedChain,
        externalAddress: external,
        externalUsdcBefore: await externalUsdc(contract, external, provider),
        externalGasBefore: await provider.getBalance(external),
        walletRpc,
      });
      // Preconditions: fully collateral-backed, co-signed, idle Account.
      expect(fundedChain.collateral).toBe(funded.collateral);
      expect(BigInt(funded.ownValue)).toBe(BigInt(funded.collateral));
      expect([funded.status, funded.pending, funded.mempool, funded.reserve]).toEqual([
        'active',
        false,
        0,
        AMOUNT.toString(),
      ]);
      expect(funded.accountHeight).toBeGreaterThan(0);

      const targets = await outageTargets(page, hubId, apiOrigin, towerOrigin);
      evidence['targets'] = targets;

      // Stop the API first so its supervisor cannot restart the Hub.
      const shutdownAt = performance.now();
      evidence['shutdownWallClock'] = new Date().toISOString();
      const signals = await stopTargets(targets);
      const down = {
        ...(await proveDown(targets, apiOrigin, towerOrigin, provider)),
        signals,
        walletRpcGateway: await probe(`${baseURL}/rpc`, rpcBody),
        provenDownMs: since(shutdownAt),
      };
      evidence['down'] = down;
      save();
      expect(down.alive).toEqual([false, false, false]);
      expect(down.ports.every(row => row.result.startsWith('unreachable'))).toBe(true);
      expect(down.apiHealth.startsWith('unreachable')).toBe(true);
      expect(down.towerHealth.startsWith('unreachable')).toBe(true);

      // The published RPC was the stopped API's gateway. The owner points the
      // wallet at an RPC that is still alive, from Settings, before exiting.
      const independentRpc = process.env['XLN_UI_DISPUTE_PRIVATE_RPC']!;
      const network = walletRpc?.[0]?.name;
      if (!network) throw new Error('OUTAGE_WALLET_NETWORK_UNKNOWN');
      const secondaryNetwork = walletRpc?.[1]?.name;
      const secondaryRpc = process.env['XLN_UI_DISPUTE_PRIVATE_SECONDARY_RPC'];
      if (!secondaryNetwork || !secondaryRpc) throw new Error('OUTAGE_SECONDARY_RPC_MISSING');
      const rpcSwitchAt = performance.now();
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      evidence['blockedAlert'] = await replaceRpcFromAlert(page, network, independentRpc);
      await replaceRpcFromSettings(page, secondaryNetwork, secondaryRpc);
      evidence['rpcSwitch'] = { network, independentRpc, ms: since(rpcSwitchAt), fromShutdown: since(shutdownAt) };
      save();

      // The user's exit click, entirely from the owning React wallet.
      await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click(WAIT);
      await manageDispute(page);
      const clickAt = performance.now();
      await page.getByTestId('dispute-prepare').click();
      await page.getByTestId('dispute-prepare-confirm').click();
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await expect(page.getByTestId('pending-batch')).toContainText('Dispute start', WAIT);
      await page.getByTestId('batch-broadcast').click();
      evidence['broadcastClickMs'] = { fromShutdown: since(shutdownAt), fromExitClick: since(clickAt) };
      save();
      const initialBlock = 0;
      // Invariant: the signed dispute start is mined through infrastructure that
      // is still alive. Real wall time only; no chain or page clock is moved.
      await expect
        .poll(
          async () => {
            const starts = await contract.queryFilter(
              contract.filters.DisputeStarted(wallet.entityId, hubId),
              initialBlock,
            );
            if (starts.length > 0) return starts.length;
            evidence['lastWalletState'] = await readState(page, hubId);
            return 0;
          },
          { timeout: 90_000, intervals: [500, 1_000] },
        )
        .toBe(1);
      const [start] = await contract.queryFilter(contract.filters.DisputeStarted(wallet.entityId, hubId), initialBlock);
      const receipt = await start!.getTransactionReceipt();
      const block = await provider.getBlock(receipt.blockNumber);
      Object.assign(evidence, {
        start: {
          txHash: receipt.hash,
          status: receipt.status,
          gasUsed: receipt.gasUsed,
          blockNumber: receipt.blockNumber,
          blockTimestamp: block?.timestamp,
          nonce: start!.args.nonce,
          disputeTimeout: start!.args.disputeTimeout,
          leftResponseSeconds: start!.args.leftResponseSeconds,
          rightResponseSeconds: start!.args.rightResponseSeconds,
          observedMs: { fromShutdown: since(shutdownAt), fromExitClick: since(clickAt) },
        },
        startedChain: await chainMoney(contract, wallet.entityId, hubId),
      });
      expect(receipt.status).toBe(1);
      save();

      // Control A, still with every named service down: own reserve -> external address.
      const usdcBefore = await externalUsdc(contract, external, provider);
      const gasBefore = await provider.getBalance(external);
      const moveAt = performance.now();
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await page.getByTestId('home-move').click();
      await page.getByTestId('move-from-reserve').click();
      await page.getByTestId('move-to-external').click();
      await page.getByTestId('move-external-recipient').fill(external);
      await page.getByTestId('move-amount').fill('100');
      await page.getByTestId('move-now').click();
      await expect
        .poll(() => externalUsdc(contract, external, provider), { timeout: 60_000, intervals: [250, 500] })
        .toBe(usdcBefore + AMOUNT);
      const spendableMs = { fromMoveClick: since(moveAt), fromShutdown: since(shutdownAt) };
      const transfers = await contract.queryFilter(
        contract.filters.ReserveUpdated(wallet.entityId, 1),
        receipt.blockNumber + 1,
      );
      const moveReceipt = transfers.length ? await transfers.at(-1)!.getTransactionReceipt() : null;
      evidence['controlA'] = {
        kind: 'own J-reserve to external (no Account dispute; NOT the Account exit)',
        externalUsdcDelta: (await externalUsdc(contract, external, provider)) - usdcBefore,
        externalGasDeltaWei: (await provider.getBalance(external)) - gasBefore,
        tx: moveReceipt?.hash,
        status: moveReceipt?.status,
        gasUsed: moveReceipt?.gasUsed,
        reserveAfter: await contract._reserves(wallet.entityId, 1),
        spendableMs,
      };
      expect(await contract._reserves(wallet.entityId, 1)).toBe(0n);
      save();

      // Over a 25 h window the owner will reopen the wallet; every named service stays down.
      const reloadAt = performance.now();
      await page.reload();
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30_000 });
      await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      const reloadAlert = await replaceRpcFromAlert(page, network, independentRpc);
      await replaceRpcFromSettings(page, secondaryNetwork, secondaryRpc);
      const reopened = await readState(page, hubId);
      evidence['reload'] = { alert: reloadAlert, ms: since(reloadAt), state: reopened };
      expect([reopened.status, reopened.dispute?.observedOnChain, reopened.reserve, reopened.collateral]).toEqual([
        'disputed',
        true,
        '0',
        funded.collateral,
      ]);
    } finally {
      evidence['browserToasts'] = await page
        .locator('[role="status"], [role="alert"]')
        .allInnerTexts()
        .catch(() => []);
      save();
      await attach();
      provider.destroy();
    }
  },
);
