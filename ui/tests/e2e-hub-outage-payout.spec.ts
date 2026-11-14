import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { safeStringify } from '../../core/protocol/serialization';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { chainMoney, externalUsdc, privateChain } from './dispute-chain';
import { finishSubmission, fundCollateral, manageDispute, readState } from './dispute-wallet';
import {
  outageTargets,
  probe,
  proveDown,
  replaceRpcFromAlert,
  rpcBody,
  since,
  startDisputeFromWallet,
  stopTargets,
  walletNetworks,
  type OutageTarget,
} from './hub-outage';
import { LOCAL_PASSWORD, enterStack } from './stack';

// Owner payout drill in real elapsed time. `start` runs inside the private
// stand: it funds a fully secured Account through the live Hub, stops the Hub,
// its API/RPC gateway and tower, and starts the dispute from React. The chain
// keeps running from its own state; nothing is time-travelled. `finish` runs
// after the Account's signed window against that chain, with every named
// service still down, from the same browser profile.
const caseDir = process.env['XLN_OUTAGE_CASE_DIR'];
const phase = process.env['XLN_OUTAGE_PHASE'];
test.skip(
  !caseDir || (phase !== 'start' && phase !== 'finish'),
  'needs XLN_OUTAGE_CASE_DIR and XLN_OUTAGE_PHASE=start|finish',
);

type OutageCase = {
  baseURL: string;
  apiOrigin: string;
  towerOrigin: string;
  rpc: string;
  network: string;
  wallet: { entityId: string; runtimeId: string; vaultId: string };
  hubId: string;
  externalAddress: string;
  targets: OutageTarget[];
  funded: Awaited<ReturnType<typeof readState>>;
  start: { txHash: string; blockNumber: number; blockTimestamp: number; disputeTimeout: number; windowSeconds: number };
  shutdownWallClockMs: number;
  exitClickWallClockMs: number;
};
const casePath = () => join(caseDir!, 'case.json');
const openProfile = (baseURL: string): Promise<BrowserContext> =>
  chromium.launchPersistentContext(join(caseDir!, 'profile'), { baseURL, viewport: { width: 1280, height: 860 } });
const firstPage = async (context: BrowserContext): Promise<Page> => context.pages()[0] ?? context.newPage();

test(
  'P1 start: fully secured Account starts its real-time exit while Hub, API/RPC gateway and tower are down',
  { tag: '@resilience' },
  async ({ baseURL }, testInfo) => {
    test.skip(phase !== 'start');
    test.setTimeout(300_000);
    if (existsSync(casePath())) throw new Error(`OUTAGE_CASE_EXISTS:${casePath()}`);
    const provider = privateChain(baseURL);
    const apiOrigin = process.env['XLN_UI_STACK_ORIGIN']!;
    const towerOrigin = process.env['UI_E2E_TOWER_URL']!;
    const rpc = process.env['XLN_UI_DISPUTE_PRIVATE_RPC']!;
    const context = await openProfile(baseURL!);
    try {
      const page = await firstPage(context);
      const phrase = (await import('ethers')).HDNodeWallet.createRandom().mnemonic!.phrase;
      writeFileSync(join(caseDir!, 'wallet-phrase.secret'), `${phrase}\n`, { mode: 0o600 });
      const wallet = await enterStack(page, phrase);
      await page.getByTestId('account-row').first().click();
      const hubId = new URL(page.url()).pathname.split('/accounts/')[1]!;
      await fundCollateral(page, hubId);
      const funded = await readState(page, hubId);
      expect([funded.status, funded.pending, funded.mempool, BigInt(funded.ownValue)]).toEqual([
        'active',
        false,
        0,
        BigInt(funded.collateral),
      ]);
      const contract = Depository__factory.connect(funded.depository, provider);
      const fundedChain = await chainMoney(contract, wallet.entityId, hubId);
      const networks = await walletNetworks(page);
      const network = networks?.[0]?.name;
      if (!network) throw new Error('OUTAGE_WALLET_NETWORK_UNKNOWN');
      const targets = await outageTargets(page, hubId, apiOrigin, towerOrigin);
      const shutdownAt = performance.now();
      const shutdownWallClockMs = Date.now();
      const signals = await stopTargets(targets);
      const down = await proveDown(targets, apiOrigin, towerOrigin, provider);
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      const alert = await replaceRpcFromAlert(page, network, rpc);
      const exitClickWallClockMs = Date.now();
      const clickAt = await startDisputeFromWallet(page, hubId, manageDispute);
      await expect
        .poll(
          async () => (await contract.queryFilter(contract.filters.DisputeStarted(wallet.entityId, hubId), 0)).length,
          { timeout: 90_000, intervals: [500, 1_000] },
        )
        .toBe(1);
      const [started] = await contract.queryFilter(contract.filters.DisputeStarted(wallet.entityId, hubId), 0);
      const receipt = await started!.getTransactionReceipt();
      const block = (await provider.getBlock(receipt.blockNumber))!;
      expect(receipt.status).toBe(1);
      const outage: OutageCase & Record<string, unknown> = {
        baseURL: baseURL!,
        apiOrigin,
        towerOrigin,
        rpc,
        network,
        networks,
        wallet: { entityId: wallet.entityId, runtimeId: wallet.runtimeId, vaultId: wallet.vaultId },
        hubId,
        externalAddress: funded.signerId,
        targets,
        signals,
        down,
        alert,
        funded,
        fundedChain,
        externalUsdcBefore: await externalUsdc(contract, funded.signerId, provider),
        externalGasBeforeWei: await provider.getBalance(funded.signerId),
        start: {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          blockTimestamp: block.timestamp,
          disputeTimeout: Number(started!.args.disputeTimeout),
          gasUsed: receipt.gasUsed,
          windowSeconds: Number(started!.args.leftResponseSeconds + started!.args.rightResponseSeconds),
          observedMs: { fromShutdown: since(shutdownAt), fromExitClick: since(clickAt) },
        },
        startedChain: await chainMoney(contract, wallet.entityId, hubId),
        shutdownWallClockMs,
        exitClickWallClockMs,
      };
      writeFileSync(casePath(), safeStringify(outage, 2));
      await testInfo.attach('outage-case', { body: safeStringify(outage), contentType: 'application/json' });
    } finally {
      await context.close();
      provider.destroy();
    }
  },
);

test(
  'P1 finish: after the signed window the owner receives the collateral at its external address, services still down',
  { tag: '@resilience' },
  async ({ baseURL }, testInfo) => {
    test.skip(phase !== 'finish');
    test.setTimeout(300_000);
    const outage = JSON.parse(readFileSync(casePath(), 'utf8')) as OutageCase;
    if (baseURL !== outage.baseURL) throw new Error(`OUTAGE_ORIGIN_CHANGED:${baseURL}:${outage.baseURL}`);
    const provider = privateChain(baseURL);
    const evidence: Record<string, unknown> = { case: casePath() };
    const save = () => writeFileSync(join(caseDir!, 'finish.json'), safeStringify(evidence, 2));
    const context = await openProfile(baseURL!);
    try {
      // Nothing that was stopped may have come back to help.
      evidence['stillDown'] = await Promise.all(
        outage.targets.flatMap(target =>
          target.ports.map(async port => ({ port, result: await probe(`http://127.0.0.1:${port}/`) })),
        ),
      );
      evidence['walletRpcGateway'] = await probe(`${baseURL}/rpc`, rpcBody);
      expect(
        (evidence['stillDown'] as Array<{ result: string }>).every(row => row.result.startsWith('unreachable')),
      ).toBe(true);
      const latest = (await provider.getBlock('latest'))!;
      evidence['chainAtFinish'] = {
        number: latest.number,
        timestamp: latest.timestamp,
        disputeTimeout: outage.start.disputeTimeout,
      };
      if (latest.timestamp <= outage.start.disputeTimeout)
        throw new Error(`OUTAGE_NOT_YET_DUE:${latest.timestamp}:${outage.start.disputeTimeout}`);
      const contract = Depository__factory.connect(outage.funded.depository, provider);
      const page = await firstPage(context);
      const reopenAt = performance.now();
      await page.goto('/');
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30_000 });
      await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      evidence['reopenAlert'] = await replaceRpcFromAlert(page, outage.network, outage.rpc);
      evidence['reopenMs'] = since(reopenAt);
      save();
      await finishSubmission(page, outage.hubId);
      await expect
        .poll(
          async () => {
            const s = await readState(page, outage.hubId);
            return [s.dispute, s.status, s.reserve, s.collateral];
          },
          { timeout: 120_000, intervals: [500, 1_000] },
        )
        .toEqual([null, 'disputed', outage.funded.collateral, '0']);
      const [finalized] = await contract.queryFilter(
        contract.filters.DisputeFinalized(outage.wallet.entityId, outage.hubId),
        outage.start.blockNumber,
      );
      const finalReceipt = await finalized!.getTransactionReceipt();
      evidence['finalize'] = {
        txHash: finalReceipt.hash,
        status: finalReceipt.status,
        gasUsed: finalReceipt.gasUsed,
        blockNumber: finalReceipt.blockNumber,
        blockTimestamp: (await provider.getBlock(finalReceipt.blockNumber))!.timestamp,
        reopenToFinalizedMs: since(reopenAt),
      };
      save();
      const usdcBefore = await externalUsdc(contract, outage.externalAddress, provider);
      const gasBefore = await provider.getBalance(outage.externalAddress);
      const moveAt = performance.now();
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await page.getByTestId('home-move').click();
      await page.getByTestId('move-from-reserve').click();
      await page.getByTestId('move-to-external').click();
      await page.getByTestId('move-external-recipient').fill(outage.externalAddress);
      await page.getByTestId('move-amount').fill(String(Number(BigInt(outage.funded.collateral)) / 1e6));
      await page.getByTestId('move-now').click();
      await expect
        .poll(() => externalUsdc(contract, outage.externalAddress, provider), {
          timeout: 60_000,
          intervals: [250, 500],
        })
        .toBe(usdcBefore + BigInt(outage.funded.collateral));
      const spendable = (await provider.getBlock('latest'))!;
      Object.assign(evidence, {
        payout: {
          externalUsdcDelta: (await externalUsdc(contract, outage.externalAddress, provider)) - usdcBefore,
          externalGasDeltaWei: (await provider.getBalance(outage.externalAddress)) - gasBefore,
          moveToSpendableMs: since(moveAt),
          spendableBlock: { number: spendable.number, timestamp: spendable.timestamp },
          wallClock: {
            shutdownToSpendableMs: Date.now() - outage.shutdownWallClockMs,
            exitClickToSpendableMs: Date.now() - outage.exitClickWallClockMs,
          },
        },
        finalChain: await chainMoney(contract, outage.wallet.entityId, outage.hubId),
      });
      save();
      await testInfo.attach('outage-payout', { body: safeStringify(evidence), contentType: 'application/json' });
    } finally {
      save();
      await context.close();
      provider.destroy();
    }
  },
);
