import { expect, test } from '@playwright/test';
import { ZeroHash } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { safeStringify } from '../../core/protocol/serialization';
import type { RuntimeAdapterViewFrame } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import {
  AMOUNT,
  WAIT,
  readState,
  readDisputeJournal,
  fundCollateral,
  manageDispute,
  broadcast,
  finishSubmission,
} from './dispute-wallet';
import { createUnsecuredClaim } from './dispute-shortfall';
import { decodeUint512, decodeUint768 } from '../../core/protocol/crypto/abi-money';
import { privateChain, chainMoney, externalUsdc } from './dispute-chain';
import { enterStack, reopenStack } from './stack';

type DebugWindow = Window & { __xln?: { adapter: () => RuntimeAdapter | null } };
// The signed dispute window is waited out by moving a private chain's clock,
// so this needs a stand nobody else shares: its own anvil on a leased local
// port with the wallet served two ports above it. The local production smoke
// wallet gate provides both endpoints and owns the chain for the entire test.
test.skip(
  !process.env['XLN_UI_DISPUTE_PRIVATE_RPC'] || !process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'],
  'needs a private dispute stand: XLN_UI_DISPUTE_PRIVATE_RPC and XLN_UI_DISPUTE_PRIVATE_ORIGIN',
);

for (const shortfall of [false, true])
  test(
    shortfall
      ? 'P5 UI dispute pays 200 of a 250 USDC claim and preserves 50 USDC of unsecured debt'
      : 'P4 UI dispute prevents early finalization, then releases exactly 100 USDC after its signed window',
    { tag: '@functional' },
    async ({ page, baseURL }, testInfo) => {
      const paid = shortfall ? 200_000_000n : AMOUNT;
      const netText = shortfall ? '250.00' : '100.00';
      test.setTimeout(60_000);
      const provider = privateChain(baseURL);
      const errors: string[] = [];
      let diagnosticHub: string | undefined;
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') console.log(`DISPUTE_BROWSER_ERROR ${message.text()}`);
      });
      try {
        await page.clock.install();
        const wallet = await enterStack(page);
        await page.getByTestId('account-row').first().click();
        const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
        if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Dispute hub Account unavailable');
        if (shortfall) await createUnsecuredClaim(page, hubId, provider);
        else await fundCollateral(page, hubId);
        diagnosticHub = hubId;
        const funded = await readState(page, hubId);
        const contract = Depository__factory.connect(funded.depository, provider);
        const initialBlock = await provider.getBlockNumber();
        const fundedChain = await chainMoney(contract, wallet.entityId, hubId);
        expect(fundedChain.reserve).toBe('0');
        expect(fundedChain.collateral).toBe(AMOUNT.toString());
        expect(fundedChain.ondelta).toBe(funded.ondelta);
        expect(funded.ownValue).toBe((shortfall ? 250_000_000n : AMOUNT).toString());
        if (shortfall) expect(fundedChain.peerReserve).toBe(AMOUNT.toString());
        if (shortfall) await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
        else {
          await page.getByTestId('wallet-tutorial').click();
          await page.getByTestId('tour-chapter').selectOption('dispute');
        }
        await manageDispute(page);
        await page.getByTestId('dispute-prepare').click();
        await page.getByTestId('dispute-prepare-confirm').click();
        await broadcast(page, 'Dispute start');
        await expect.poll(async () => (await readState(page, hubId)).dispute?.observedOnChain, WAIT).toBe(true);
        const started = await readState(page, hubId);
        const active = started.dispute;
        if (!active) throw new Error('Observed dispute disappeared');
        expect(active.startedByLeft).toBe(wallet.entityId < hubId);
        const starts = await contract.queryFilter(
          contract.filters.DisputeStarted(wallet.entityId, hubId),
          initialBlock,
        );
        expect(starts).toHaveLength(1);
        const start = starts[0];
        if (!start) throw new Error('DisputeStarted receipt unavailable');
        expect((await start.getTransactionReceipt()).gasUsed).toBeLessThanOrEqual(5_000_000n);
        expect(start.args.proofbodyHash).toBe(active.initialProofbodyHash);
        expect(Number(start.args.nonce)).toBe(active.initialNonce);
        expect(Number(start.args.disputeTimeout)).toBe(active.disputeTimeout);
        // The receipt must use the bilateral windows committed before the dispute.
        const leftWindow = BigInt(funded.disputeConfig.leftResponseSeconds);
        const rightWindow = BigInt(funded.disputeConfig.rightResponseSeconds);
        expect(start.args.leftResponseSeconds).toBe(leftWindow);
        expect(start.args.rightResponseSeconds).toBe(rightWindow);
        expect(start.args.disputeTimeout).toBe(start.args.disputeStartTimestamp + leftWindow + rightWindow);
        expect(active.observedBlockNumber).toBe(start.blockNumber);
        expect((await start.getTransactionReceipt()).status).toBe(1);
        const startedChain = await chainMoney(contract, wallet.entityId, hubId);
        expect(startedChain.disputeHash).not.toBe(ZeroHash);
        expect(startedChain.reserve).toBe(fundedChain.reserve);
        await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
        await expect(page.getByTestId('account-dispute-state')).toContainText('on-chain', WAIT);
        await manageDispute(page);
        await expect(page.getByTestId('dispute-finalize')).toBeDisabled();
        await expect(page.getByTestId('dispute-finalize')).toHaveText('Waiting for challenge window');
        const rejected = await readState(page, hubId);
        expect(rejected.dispute).toEqual(active);
        expect(rejected.batch).toEqual(started.batch);
        expect(rejected.reserve).toBe(started.reserve);
        expect(rejected.accountRoot).toBe(started.accountRoot);
        expect(await chainMoney(contract, wallet.entityId, hubId)).toEqual(startedChain);
        expect(
          await contract.queryFilter(contract.filters.DisputeFinalized(wallet.entityId, hubId), initialBlock),
        ).toHaveLength(0);
        const rejectedJournal = await readDisputeJournal(page, started.height, hubId);
        expect(rejectedJournal.finalizeInputs).toHaveLength(0);
        expect(rejectedJournal.submissions).toHaveLength(0);
        await testInfo.attach('early-finalize-prevention', {
          body: safeStringify({ started, rejected, startedChain, acceptedWal: rejectedJournal }),
          contentType: 'application/json',
        });
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
        // The real host clock is performance.timeOrigin + performance.now(), not Date.
        // Advancing elapsed time runs the existing deadline hook; its canonical output
        // finalizes the UI-started dispute without another financial input from the test.
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
        const deadline = active.disputeTimeout + 1;
        await provider.send('evm_setNextBlockTimestamp', [deadline]);
        await provider.send('evm_mine', []);
        const block = await provider.getBlock('latest');
        if (!block) throw new Error('Private deadline block unavailable');
        expect(block.timestamp).toBeGreaterThan(active.disputeTimeout);
        const beforeClock = await page.evaluate(() => ({
          date: Date.now(),
          host: Math.round(performance.timeOrigin + performance.now()),
        }));
        let afterClock: typeof beforeClock;
        try {
          await page.clock.fastForward(deadline * 1000 - beforeClock.host);
          afterClock = await page.evaluate(() => ({
            date: Date.now(),
            host: Math.round(performance.timeOrigin + performance.now()),
          }));
          expect(afterClock.host).toBeGreaterThanOrEqual(deadline * 1000);
        } finally {
          await page.clock.resume();
        }
        await expect
          .poll(
            async () =>
              (await readDisputeJournal(page, rejected.height, hubId)).deadlineWakes.filter(
                wake => wake.timestamp >= deadline * 1000,
              ).length,
            WAIT,
          )
          .toBe(1);
        await finishSubmission(page, hubId);
        await expect
          .poll(async () => {
            const s = await readState(page, hubId);
            return [s.dispute, s.status, s.reserve, s.collateral, s.offdelta, s.pending, s.mempool, s.batch];
          }, WAIT)
          .toEqual([
            null,
            'disputed',
            paid.toString(),
            '0',
            '0',
            false,
            0,
            { operations: 0, sent: false, finalizations: 0 },
          ]);
        const finished = await readState(page, hubId);
        const finalChain = await chainMoney(contract, wallet.entityId, hubId);
        const finalizations = await contract.queryFilter(
          contract.filters.DisputeFinalized(wallet.entityId, hubId),
          initialBlock,
        );
        expect(finalizations).toHaveLength(1);
        const finalization = finalizations[0];
        if (!finalization) throw new Error('DisputeFinalized receipt unavailable');
        const receipt = await finalization.getTransactionReceipt();
        expect(receipt.status).toBe(1);
        expect(receipt.gasUsed).toBeLessThanOrEqual(5_000_000n);
        expect(finalization.args.finalProofbodyHash).toBe(active.initialProofbodyHash);
        expect(finalization.args.nonce).toBe(BigInt(active.initialNonce));
        const payout = await contract.queryFilter(
          contract.filters.ReserveUpdated(wallet.entityId, 1),
          receipt.blockNumber,
          receipt.blockNumber,
        );
        expect(
          payout.filter(event => event.transactionHash === receipt.hash).map(event => event.args.newBalance),
        ).toEqual(shortfall ? [AMOUNT, paid] : [AMOUNT]);
        expect(finalChain).toEqual({
          ...startedChain,
          reserve: paid.toString(),
          peerReserve: shortfall ? '0' : startedChain.peerReserve,
          collateral: '0',
          ondelta: '0',
          nonce: String(active.initialNonce + 1),
          disputeHash: ZeroHash,
          timeout: 0,
        });
        expect(BigInt(finalChain.reserve) + BigInt(finalChain.peerReserve) + BigInt(finalChain.collateral)).toBe(
          BigInt(fundedChain.reserve) + BigInt(fundedChain.peerReserve) + BigInt(fundedChain.collateral),
        );
        const debts = await contract.queryFilter(
          contract.filters.DebtCreated(hubId, wallet.entityId, 1),
          receipt.blockNumber,
          receipt.blockNumber,
        );
        expect(debts).toHaveLength(shortfall ? 1 : 0);
        if (shortfall) {
          const debt = debts[0];
          if (!debt) throw new Error('Unsecured debt receipt missing');
          expect(debt.transactionHash).toBe(receipt.hash);
          expect(decodeUint512(debt.args.amount)).toBe(50_000_000n);
          const stored = await contract._debts(hubId, 1, debt.args.debtIndex);
          expect(stored.creditor).toBe(wallet.entityId);
          expect(decodeUint512(stored.amount)).toBe(50_000_000n);
          expect(decodeUint768(await contract.debtOutstanding(hubId, 1))).toBe(50_000_000n);
        }
        expect(finished.jNonce).toBe(active.initialNonce + 1);
        const accepted = await readDisputeJournal(page, rejected.height, hubId);
        // The wake executes its approved collective actions in the same signed Entity
        // frame. Its committed batch and actual receipt prove that internal execution.
        expect(accepted.finalizeInputs).toHaveLength(0);
        const wakes = accepted.deadlineWakes.filter(wake => wake.timestamp >= deadline * 1000);
        expect(wakes).toHaveLength(1);
        const wake = wakes[0];
        if (!wake) throw new Error('Finalization wake unavailable');
        const sourceBatch = await page.evaluate(
          async ({ entityId, height }) => {
            const debug = (window as DebugWindow).__xln;
            const adapter = debug?.adapter();
            if (!adapter) throw new Error('Finalization source reader unavailable');
            const core = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core']>(
              `entity/${entityId}`,
              { atHeight: height },
            );
            const sent = core.jBatchState?.sentBatch;
            if (!sent) throw new Error(`FINALIZATION_SOURCE_BATCH_MISSING:${height}`);
            return { batchHash: sent.batchHash, entityNonce: sent.entityNonce };
          },
          { entityId: wallet.entityId, height: wake.height },
        );
        const submitted = accepted.submissions.filter(item => item.txHash === receipt.hash);
        expect(submitted).toHaveLength(1);
        expect(submitted.map(item => ({ batchHash: item.batchHash, entityNonce: item.entityNonce }))).toEqual([
          sourceBatch,
        ]);
        expect(submitted.every(item => item.timestamp >= deadline * 1000 && item.height >= wake.height)).toBe(true);
        const processed = await contract.queryFilter(
          contract.filters.HankoBatchProcessed(wallet.entityId, sourceBatch.batchHash),
          receipt.blockNumber,
          receipt.blockNumber,
        );
        expect(processed.map(event => ({ txHash: event.transactionHash, nonce: event.args.nonce }))).toEqual([
          { txHash: receipt.hash, nonce: BigInt(sourceBatch.entityNonce) },
        ]);
        expect(finished.incomingDebt).toBe(shortfall ? '50000000' : '0');
        await expect(page.getByTestId('token-net-USDC')).toHaveText(netText);
        await expect(page.getByTestId('home-send-capacity')).toContainText('Available to pay: $0.00');
        await expect(page.getByTestId('home-reserve').locator('strong')).toHaveText(shortfall ? '$200.00' : '$100.00');
        await expect(page.getByTestId('home-risk').locator('strong')).toHaveText(shortfall ? '$50.00' : '$0.00');
        await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
        await expect(page.getByTestId('account-status')).toHaveText('Closed after dispute');
        await expect(page.getByTestId('account-dispute-state')).toHaveText(
          'Dispute finalized. This account is permanently closed.',
        );
        await expect(page.getByTestId('account-dispute')).toHaveCount(0);
        await manageDispute(page);
        await expect(page.getByTestId('dispute-closed')).toHaveText(
          'Dispute finalized. This account is permanently closed.',
        );
        await expect(
          page.locator(
            '[data-testid="dispute-prepare"], [data-testid="dispute-prepare-confirm"], [data-testid="dispute-finalize"]',
          ),
        ).toHaveCount(0);
        expect(errors, 'no uncaught browser errors').toEqual([]);
        await testInfo.attach('dispute-finality', {
          body: safeStringify({
            mode: 'canonical-auto-after-ui-start-and-early-prevention',
            beforeClock,
            afterClock,
            funded,
            fundedChain,
            started,
            startTx: start.transactionHash,
            deadlineBlock: { number: block.number, hash: block.hash, timestamp: block.timestamp },
            finished,
            finalChain,
            finalTx: receipt.hash,
            sourceBatch,
            accepted,
          }),
          contentType: 'application/json',
        });
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByTestId('nav-home').locator('visible=true').first().click();
        await expect(page.getByTestId('token-net-USDC')).toHaveText(netText);
        await expect(page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`)).toContainText(
          'Closed after dispute',
        );
        await expect(page.getByRole('region', { name: 'Test money faucet' })).toContainText('closed after a dispute');
        const externalBefore = await externalUsdc(contract, funded.signerId, provider);
        await page.getByTestId('home-move').click();
        await page.getByTestId('move-from-reserve').click();
        await page.getByTestId('move-to-external').click();
        await page.getByTestId('move-external-recipient').fill(funded.signerId);
        await page.getByTestId('move-amount').fill(shortfall ? '200' : '100');
        await page.getByTestId('move-now').click();
        await expect.poll(() => externalUsdc(contract, funded.signerId, provider), WAIT).toBe(externalBefore + paid);
        await expect.poll(() => contract._reserves(wallet.entityId, 1), WAIT).toBe(0n);
        await expect.poll(async () => (await readState(page, hubId)).reserve, WAIT).toBe('0');
        if (shortfall) {
          // The relay uses real wall time for authenticated handshakes. Restore Date
          // after the private deadline jump before creating a fresh network session.
          await page.clock.setSystemTime(Date.now());
          await page.reload();
          await reopenStack(page, wallet);
          const restored = await readState(page, hubId);
          expect([restored.status, restored.reserve, restored.incomingDebt, restored.dispute]).toEqual([
            'disputed',
            '0',
            '50000000',
            null,
          ]);
          await expect(page.getByTestId('home-risk').locator('strong')).toHaveText('$50.00');
          expect(decodeUint768(await contract.debtOutstanding(hubId, 1))).toBe(50_000_000n);
          expect(await externalUsdc(contract, funded.signerId, provider)).toBe(externalBefore + paid);
        }
        await testInfo.attach('withdrawn-dispute-proceeds', {
          body: safeStringify({
            signerId: funded.signerId,
            before: externalBefore,
            after: await externalUsdc(contract, funded.signerId, provider),
          }),
          contentType: 'application/json',
        });
        await page.screenshot({
          path: testInfo.outputPath('dispute-paid.png'),
          fullPage: true,
          animations: 'disabled',
        });
      } catch (error) {
        if (diagnosticHub) {
          try {
            const state = await readState(page, diagnosticHub);
            const contract = Depository__factory.connect(state.depository, provider);
            const money = await chainMoney(contract, state.entityId, diagnosticHub);
            const starts = await contract.queryFilter(contract.filters.DisputeStarted(state.entityId, diagnosticHub));
            await testInfo.attach('first-red-state', {
              body: safeStringify({ state, money, starts, browserErrors: errors }),
              contentType: 'application/json',
            });
          } catch (diagnosticError) {
            throw new AggregateError(
              [error, diagnosticError],
              'Dispute failed and first-red snapshot could not be read',
            );
          }
        }
        throw error;
      } finally {
        provider.destroy();
      }
    },
  );
