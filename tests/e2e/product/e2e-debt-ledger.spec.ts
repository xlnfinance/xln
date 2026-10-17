import { expect, test, type Page } from '../../global-setup.mts';
import { JsonRpcProvider } from 'ethers';
import { Depository__factory } from '../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL } from '../../utils/e2e-baseline';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { connectRuntimeToHub } from '../../utils/e2e-connect';
import { enqueueEntityTxs } from '../../utils/runtime/e2e-runtime-input';
import { clickFaucet } from '../../../ui/tests/move-wallet';
import { decodeUint512 } from '../../../core/protocol/crypto/abi-money';
import { safeStringify } from '../../../core/protocol/serialization';
import { RemoteRuntimeAdapter } from '../../../core/api/runtime-adapter/remote';
import type { RuntimeImportManifest } from '../../../core/orchestrator/replica-import/runtime-import-manifest';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../../core/api/public/runtime-module';
import { deriveDelta } from '../../../core/account/utils';

type DebtRow = {
  debtId: string;
  direction: 'out' | 'in';
  status: string;
  createdAmount: string;
  paidAmount: string;
  remainingAmount: string;
};
type DebtWindow = Window & { __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> } };
type EntityView = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core'];
type AccountView = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
const AMOUNT = 150_000_000n;
const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };

async function readBrowser(page: Page, entityId: string, hubId: string) {
  return page.evaluate(
    async ({ entityId, hubId }) => {
      const debug = (window as DebtWindow).__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('DEBT_WALLET_ADAPTER_MISSING');
      const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
      const active = frame.activeEntity;
      if (!active || frame.activeEntityId !== entityId) throw new Error('DEBT_ENTITY_OWNER_MISMATCH');
      const account = await adapter.read<AccountView>(`/entity/${entityId}/account/${hubId}`, {
        atHeight: frame.height,
      });
      const delta = account.state.deltas.get(1);
      const jurisdiction = active.core.config.jurisdiction;
      if (!delta || !jurisdiction) throw new Error('DEBT_ACCOUNT_DOMAIN_MISSING');
      const rows: DebtRow[] = [];
      for (const [direction, ledger] of [
        ['out', active.core.outDebtsByToken],
        ['in', active.core.inDebtsByToken],
      ] as const) {
        for (const row of ledger?.get(1)?.values() ?? []) {
          if (row.counterparty.toLowerCase() !== hubId) continue;
          rows.push({
            debtId: row.debtId,
            direction,
            status: row.status,
            createdAmount: String(row.createdAmount),
            paidAmount: String(row.paidAmount),
            remainingAmount: String(row.remainingAmount),
          });
        }
      }
      const batch = active.core.jBatchState;
      return {
        height: frame.height,
        accountHeight: account.currentHeight,
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
        delta: (await debug.xln()).deriveDelta(delta, entityId < hubId).delta.toString(),
        reserve: String(active.core.reserves.get(1) ?? 0n),
        collateral: String(delta.collateral),
        status: account.status,
        dispute: account.activeDispute ?? null,
        disputeConfig: account.state.disputeConfig,
        depository: jurisdiction.depositoryAddress,
        entityNonce: batch?.entityNonce ?? 0,
        draftStarts: batch?.batch.disputeStarts.length ?? 0,
        sent: Boolean(batch?.sentBatch),
        debts: rows,
      };
    },
    { entityId, hubId },
  );
}

function debtRows(core: EntityView, counterparty: string): DebtRow[] {
  const rows: DebtRow[] = [];
  for (const [direction, ledger] of [
    ['out', core.outDebtsByToken],
    ['in', core.inDebtsByToken],
  ] as const) {
    for (const row of ledger?.get(1)?.values() ?? []) {
      if (row.counterparty.toLowerCase() !== counterparty) continue;
      rows.push({
        debtId: row.debtId,
        direction,
        status: row.status,
        createdAmount: String(row.createdAmount),
        paidAmount: String(row.paidAmount),
        remainingAmount: String(row.remainingAmount),
      });
    }
  }
  return rows;
}

async function connectHubReader(page: Page, runtimeId: string, hubId: string, label: string) {
  const response = await page.request.get(`${APP_BASE_URL}/api/runtime-import?access=admin&allowPartial=1`);
  expect(response.ok()).toBe(true);
  const body: { manifest: RuntimeImportManifest } = await response.json();
  const entry = body.manifest.entries.find(row => row.label === label);
  if (!entry) throw new Error('DEBT_HUB_IMPORT_OWNER_MISMATCH');
  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({ mode: 'remote', wsUrl: entry.wsUrl, authKey: entry.token, runtimeId });
  const core = await adapter.read<EntityView>(`/entity/${hubId}`);
  expect(core.entityId.toLowerCase()).toBe(hubId);
  return adapter;
}

test(
  'browser dispute with sovereign Hub creates exactly one mirrored debt on both owners',
  { tag: '@resilience' },
  async ({ page }, testInfo) => {
    test.setTimeout(55_000);
    const evidence: Record<string, unknown> = {};
    const provider = new JsonRpcProvider(`${API_BASE_URL}/rpc`, 31337, { staticNetwork: true, cacheTimeout: -1 });
    let hub: RemoteRuntimeAdapter | undefined;
    try {
      const health = await ensureE2EBaseline(page, { requireHubMesh: true, requireMarketMaker: false, minHubCount: 3 });
      // React already opened H1 with its normal windows. Open a fresh H3 Account
      // so this scenario's explicitly signed 5+5-second fixture is actually used.
      const selectedHub = health.hubs?.find(row => row.name === 'H3');
      if (!selectedHub?.entityId || !selectedHub.runtimeId || !selectedHub.name) throw new Error('DEBT_HUB_MISSING');
      const hubId = selectedHub.entityId.toLowerCase();
      await gotoApp(page, { appBaseUrl: APP_BASE_URL });
      const alice = await createWalletIdentity(page, 'alice', selectDemoMnemonic('alice'));
      hub = await connectHubReader(page, selectedHub.runtimeId, hubId, selectedHub.name);
      await connectRuntimeToHub(page, alice, hubId, {
        disputeConfig: { leftResponseSeconds: 5, rightResponseSeconds: 5 },
      });
      const hubPath = `/entity/${hubId}`;
      const accountPath = `${hubPath}/account/${alice.entityId}`;
      const hubCore = await hub.read<EntityView>(hubPath);
      if (!hubCore.signerId) throw new Error('DEBT_HUB_SIGNER_MISSING');
      const beforeHub = await hub.read<AccountView>(accountPath);
      const commandSequence = hub.nextCommandSequence;
      if (typeof commandSequence !== 'number') throw new Error('DEBT_HUB_COMMAND_SEQUENCE_MISSING');
      await hub.send(
        {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: hubId,
              signerId: hubCore.signerId,
              entityTxs: [
                {
                  type: 'extendCredit',
                  data: { counterpartyEntityId: alice.entityId, tokenId: 1, amount: 1_000_000_000n },
                },
              ],
            },
          ],
        },
        { commandId: `debt-credit-${crypto.randomUUID()}`, commandSequence },
      );
      const hubReader = hub;
      await expect
        .poll(async () => (await hubReader.read<AccountView>(accountPath)).currentHeight, WAIT)
        .toBeGreaterThan(beforeHub.currentHeight);
      const before = await readBrowser(page, alice.entityId, hubId);
      evidence.before = before;
      expect(before.disputeConfig).toEqual({ leftResponseSeconds: 5, rightResponseSeconds: 5 });
      expect(beforeHub.state.disputeConfig).toEqual(before.disputeConfig);
      expect(before.reserve).toBe('0');
      expect(before.collateral).toBe('0');
      await enqueueEntityTxs(page, alice.entityId, alice.signerId, [
        {
          type: 'directPayment',
          data: {
            targetEntityId: hubId,
            tokenId: 1,
            amount: AMOUNT,
            route: [alice.entityId, hubId],
            deliveryMode: 'direct',
            description: 'debt-browser-to-sovereign-hub',
          },
        },
      ]);
      const expectedDelta = (alice.entityId < hubId ? -AMOUNT : AMOUNT).toString();
      await expect
        .poll(async () => {
          const state = await readBrowser(page, alice.entityId, hubId);
          return { delta: state.delta, pending: state.pending, mempool: state.mempool };
        }, WAIT)
        .toEqual({ delta: expectedDelta, pending: false, mempool: 0 });
      const paid = await readBrowser(page, alice.entityId, hubId);
      expect(paid.accountHeight).toBeGreaterThan(before.accountHeight);
      await expect
        .poll(async () => {
          const account = await hubReader.read<AccountView>(accountPath);
          const delta = account.state.deltas.get(1);
          if (!delta) throw new Error('DEBT_HUB_DELTA_MISSING');
          return deriveDelta(delta, hubId < alice.entityId).delta.toString();
        }, WAIT)
        .toBe(expectedDelta);
      evidence.paid = paid;
      console.log('DEBT_STAGE payment-150-committed-both-owners');

      // The only faucet here buys transaction gas; the debtor's token reserve stays zero.
      await page.getByTestId('nav-manage').locator('visible=true').first().click();
      await page.getByTestId('manage-assets').click();
      await clickFaucet(page, 'gas', expect);
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
      await page.getByTestId('account-manage').click();
      await page.getByTestId('manage-tab-dispute').click();
      await page.getByTestId('dispute-prepare').click();
      await page.getByTestId('dispute-prepare-confirm').click();
      await expect.poll(async () => (await readBrowser(page, alice.entityId, hubId)).draftStarts, WAIT).toBe(1);
      const drafted = await readBrowser(page, alice.entityId, hubId);
      expect(drafted.delta).toBe(expectedDelta);
      expect(drafted.reserve).toBe('0');
      expect(drafted.dispute).toMatchObject({ observedOnChain: false, disputeTimeout: 0 });
      expect(drafted.sent).toBe(false);
      evidence.drafted = drafted;
      const contract = Depository__factory.connect(paid.depository, provider);
      const fromBlock = await provider.getBlockNumber();
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await expect(page.getByTestId('pending-batch')).toContainText('Dispute start', WAIT);
      await page.getByTestId('batch-broadcast').click();
      await expect
        .poll(async () => Boolean((await readBrowser(page, alice.entityId, hubId)).dispute?.observedOnChain), WAIT)
        .toBe(true);
      const started = await readBrowser(page, alice.entityId, hubId);
      if (!started.dispute) throw new Error('DEBT_DISPUTE_NOT_OBSERVED');
      const starts = await contract.queryFilter(contract.filters.DisputeStarted(alice.entityId, hubId), fromBlock);
      expect(starts).toHaveLength(1);
      const start = starts[0];
      if (!start) throw new Error('DEBT_DISPUTE_RECEIPT_MISSING');
      expect((await start.getTransactionReceipt()).status).toBe(1);
      expect(start.args.leftResponseSeconds).toBe(BigInt(paid.disputeConfig.leftResponseSeconds));
      expect(start.args.rightResponseSeconds).toBe(BigInt(paid.disputeConfig.rightResponseSeconds));
      expect(start.args.disputeTimeout).toBe(BigInt(started.dispute.disputeTimeout));
      const batches = await contract.queryFilter(contract.filters.HankoBatchProcessed(alice.entityId), fromBlock);
      expect(batches.filter(row => row.args.nonce === BigInt(paid.entityNonce + 1))).toHaveLength(1);
      console.log('DEBT_STAGE dispute-start-receipt');
      evidence.started = { ...started, txHash: start.transactionHash, blockHash: start.blockHash };
      await page.getByTestId('nav-activity').locator('visible=true').first().click();
      await page.screenshot({ path: testInfo.outputPath('dispute-active-history.png'), fullPage: true });

      // This runner owns its private chain. Preserve the actual signed window, never shorten it.
      const latest = await provider.getBlock('latest');
      if (!latest) throw new Error('DEBT_CHAIN_HEAD_MISSING');
      if (latest.timestamp < started.dispute.disputeTimeout)
        await provider.send('evm_setNextBlockTimestamp', [started.dispute.disputeTimeout]);
      await provider.send('evm_mine', []);
      await expect
        .poll(async () => {
          const state = await readBrowser(page, alice.entityId, hubId);
          return { dispute: state.dispute, status: state.status };
        }, WAIT)
        .toEqual({ dispute: null, status: 'disputed' });
      console.log('DEBT_STAGE dispute-finalized');
      const readBoth = async () => [
        (await readBrowser(page, alice.entityId, hubId)).debts,
        debtRows(await hubReader.read<EntityView>(hubPath), alice.entityId),
      ];
      await expect.poll(async () => (await readBoth()).map(rows => rows.length), WAIT).toEqual([1, 1]);
      const mirrored = await readBoth();
      for (const [index, rows] of mirrored.entries()) {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          direction: index === 0 ? 'out' : 'in',
          createdAmount: AMOUNT.toString(),
          remainingAmount: AMOUNT.toString(),
          paidAmount: '0',
        });
      }
      const [aliceRows, hubRows] = mirrored;
      if (!aliceRows?.[0] || !hubRows?.[0]) throw new Error('DEBT_MIRROR_MISSING');
      expect(aliceRows[0].debtId).toBe(hubRows[0].debtId);
      const finalHub = await hubReader.read<AccountView>(accountPath);
      expect(finalHub.activeDispute).toBeUndefined();
      expect(finalHub.status).toBe('disputed');
      console.log('DEBT_STAGE mirrored-150-debt-confirmed');
      const created = await contract.queryFilter(contract.filters.DebtCreated(alice.entityId, hubId, 1), fromBlock);
      expect(created).toHaveLength(1);
      const debt = created[0];
      if (!debt) throw new Error('DEBT_CREATED_RECEIPT_MISSING');
      expect(decodeUint512(debt.args.amount)).toBe(AMOUNT);
      const finalized = (await contract.queryFilter(contract.filters.DisputeFinalized(), fromBlock)).filter(
        row =>
          (row.args.sender.toLowerCase() === alice.entityId && row.args.counterentity.toLowerCase() === hubId) ||
          (row.args.sender.toLowerCase() === hubId && row.args.counterentity.toLowerCase() === alice.entityId),
      );
      expect(finalized).toHaveLength(1);
      const finalization = finalized[0];
      if (!finalization) throw new Error('DEBT_FINALIZATION_RECEIPT_MISSING');
      expect(debt.transactionHash).toBe(finalization.transactionHash);
      expect((await debt.getTransactionReceipt()).status).toBe(1);
      evidence.chainDebt = {
        debtor: debt.args.debtor,
        creditor: debt.args.creditor,
        tokenId: debt.args.tokenId,
        amount: decodeUint512(debt.args.amount),
        debtIndex: debt.args.debtIndex,
        transactionHash: debt.transactionHash,
        blockHash: debt.blockHash,
        nonce: finalization.args.nonce,
        finalProofbodyHash: finalization.args.finalProofbodyHash,
      };
      evidence.mirrored = mirrored;
      const final = await readBrowser(page, alice.entityId, hubId);
      expect(final.reserve).toBe('0');
      expect(final.collateral).toBe('0');
      evidence.final = final;
      await page.screenshot({ path: testInfo.outputPath('dispute-finalized-history.png'), fullPage: true });
      await page.getByTestId('nav-manage').locator('visible=true').first().click();
      await page.getByTestId('manage-assets').click();
      const summary = page.getByTestId('debt-group-out-USDC');
      await expect(summary).toContainText('You owe');
      await expect(summary).toContainText('150.00');
      await expect(summary).toContainText('USDC');
      await provider.send('evm_mine', []);
      await expect.poll(readBoth, WAIT).toEqual(mirrored);
    } finally {
      await testInfo.attach('mirrored-debt-evidence', {
        body: safeStringify(evidence),
        contentType: 'application/json',
      });
      hub?.disconnect();
      provider.destroy();
    }
  },
);
