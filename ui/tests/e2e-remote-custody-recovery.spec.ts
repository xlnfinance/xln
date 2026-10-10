// Existing React remote Gate and Pay UI against a real supervised custody owner.
import { expect, test } from '@playwright/test';
import type { AggregatedHealth } from '../../core/orchestrator/orchestrator-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSelectedNativeHub, readWalletCheckpoint } from './stack';
import { readCommittedPayment } from './payment-evidence';
import { decodeRuntimeManifestEntries } from '../../core/scripts/operations/hlt/boundary/worker-boundary';
import { RemoteRuntimeAdapter } from '../../core/api/runtime-adapter/remote';
import type { RuntimeInput } from '../../core/runtime/types';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../../core/storage/types';
import { deriveDelta } from '../../core/account/utils';
import { BRAINVAULT_V1_SPEC_ID } from '../../brainvault/src/core/primitives/spec';

for (const fundingMode of ['direct', 'instant'] as const) {
  test(
    fundingMode === 'direct'
      ? 'remote custody wallet reopens after owner crash and spends recovered funds through Pay'
      : 'Instant-funded remote custody wallet reopens after owner crash and spends recovered funds through Pay',
    { tag: '@resilience' },
    async ({ page }) => {
      test.setTimeout(180_000);
      const getHealth = async () => {
        const response = await page.request.get('/api/health');
        expect(response.ok()).toBe(true);
        return (await response.json()) as AggregatedHealth;
      };
      const health = await getHealth();
      const standRoot = process.env['XLN_RDB_ROOT'];
      if (!standRoot) throw new Error('CUSTODY_STAND_ROOT_REQUIRED');
      const entries = decodeRuntimeManifestEntries(
        JSON.parse(readFileSync(join(standRoot, 'prod-mesh', 'runtime-import-manifest.json'), 'utf8')),
      );
      const engine = process.env['XLN_HLT_ENGINE'];
      if (engine !== 'ts' && engine !== 'rust') throw new Error('CUSTODY_ENGINE_SELECTION_REQUIRED');
      expect(entries.find(row => row.label === 'H1')?.engine).toBe(engine);
      const nativeHub = health.hubs?.find(row => row.name === 'H1');
      if (!nativeHub?.entityId) throw new Error('CUSTODY_OWNER_HUB_MISSING');
      await assertSelectedNativeHub(nativeHub.entityId);
      const connect = async (name: string) => {
        const entry = entries.find(row => row.label.toLowerCase() === name.toLowerCase())!;
        expect(entry).toBeTruthy();
        const runtimeId = health.hubs!.find(row => row.name === name)!.runtimeId!;
        const adapter = new RemoteRuntimeAdapter();
        await adapter.connect({ mode: 'remote', wsUrl: entry.wsUrl, authKey: entry.token, runtimeId });
        return adapter;
      };
      let h1 = await connect('H1');
      const h2 = await connect('H2');
      const send = async (adapter: RemoteRuntimeAdapter, input: RuntimeInput) => {
        await expect.poll(() => adapter.commandReady, { timeout: 30_000 }).toBe(true);
        return adapter.send(input, {
          commandId: `custody-pay-${crypto.randomUUID()}`,
          commandSequence: adapter.nextCommandSequence!,
        });
      };
      try {
        const owner = await h1.deriveBrainVault({
          specId: BRAINVAULT_V1_SPEC_ID,
          name: `react-custody-${crypto.randomUUID()}`,
          passphrase: 'Local-regression-only-42!',
          shardInput: 1,
          workers: 1,
        });
        expect(owner.created).toBe(true);
        expect(owner.height).toBeGreaterThan(0);
        const hubId = health.hubs!.find(row => row.name === 'H2')!.entityId!;
        const hub = await h2.read<StorageEntityCoreDoc & { signerId: string }>(`/entity/${hubId}`);
        const path = (entity: string, peer: string) => `/entity/${entity}/account/${peer}`;
        const left = owner.entityId.toLowerCase() < hubId.toLowerCase();
        const ownerInput = (
          entityTxs: NonNullable<RuntimeInput['entityInputs'][number]['entityTxs']>,
        ): RuntimeInput => ({
          runtimeTxs: [],
          entityInputs: [{ entityId: owner.entityId, signerId: owner.ethereumAddress, entityTxs }],
        });
        const hubInput = (entityTxs: NonNullable<RuntimeInput['entityInputs'][number]['entityTxs']>): RuntimeInput => ({
          runtimeTxs: [],
          entityInputs: [{ entityId: hubId, signerId: hub.signerId, entityTxs }],
        });
        // The owner extends real bilateral credit; H2 pays 2 USDC into that account.
        // No collateral/deposit claim: this is the existing credit-funded payment path.
        await send(
          h1,
          ownerInput([
            {
              type: 'openAccount',
              data: {
                targetEntityId: hubId,
                tokenId: 1,
                creditAmount: 100_000_000n,
                disputeConfig: { leftResponseSeconds: 3600, rightResponseSeconds: 3600 },
              },
            },
          ]),
        );
        const readPair = async () =>
          Promise.all([
            h1.read<StorageAccountDoc>(path(owner.entityId, hubId)),
            h2.read<StorageAccountDoc>(path(hubId, owner.entityId)),
          ]);
        await expect
          .poll(
            async () => {
              try {
                const pair = await readPair();
                return pair.every(a => a.currentHeight > 0 && !a.pendingFrame);
              } catch (error) {
                if ((error as { code?: string }).code === 'E_NOT_FOUND') return false;
                throw error;
              }
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        const baseline = await readPair();
        const initialDelta = deriveDelta(baseline[0].state.deltas.get(1)!, left).delta;
        const fundingData = {
          targetEntityId: owner.entityId,
          tokenId: 1,
          amount: 2_000_000n,
          route: [hubId, owner.entityId],
          description: 'native-custody-real-payment',
        };
        await send(
          h2,
          hubInput([
            fundingMode === 'direct'
              ? { type: 'directPayment', data: { ...fundingData, deliveryMode: 'direct' } }
              : {
                  type: 'htlcPayment',
                  data: { ...fundingData, deliveryMode: 'instant', maxSenderDebit: 2_000_000n },
                },
          ]),
        );
        const fundedDelta = initialDelta + (left ? 2_000_000n : -2_000_000n);
        const settled = async (expected: bigint) => {
          const pair = await readPair();
          return (
            pair.every(a => !a.pendingFrame && deriveDelta(a.state.deltas.get(1)!, left).delta === expected) &&
            pair[0].currentHeight === pair[1].currentHeight &&
            pair[0].currentFrame.accountStateRoot === pair[1].currentFrame.accountStateRoot
          );
        };
        await expect.poll(() => settled(fundedDelta), { timeout: 30_000 }).toBe(true);
        const funded = (await readPair())[0];
        const entry = entries.find(row => row.label === 'H1');
        if (!entry) throw new Error('CUSTODY_RUNTIME_MANIFEST_MISSING');
        const openCustodyUi = async (reopen: boolean) => {
          if (reopen) {
            // Reload drops only the live connection. The saved remote vault remains;
            // Continue uses Gate.unlockVault's real remote branch and prefilled URL.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(entry.wsUrl);
            await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toHaveCount(0);
          } else {
            await page.goto('/');
            await page.getByText('Advanced connection', { exact: true }).click();
            await page.getByRole('button', { name: 'Connect a remote runtime', exact: true }).click();
            await page.getByLabel('Runtime endpoint', { exact: true }).fill(entry.wsUrl);
          }
          await page.getByLabel('Access key · optional', { exact: true }).fill(entry.token);
          await page.getByRole('button', { name: 'Connect', exact: true }).click();
          await page
            .locator('button.gate-card')
            .filter({ hasText: owner.entityId.slice(0, 18) })
            .click();
          await expect(page.getByTestId('home-total')).toBeVisible({ timeout: 30_000 });
          expect((await readWalletCheckpoint(page)).entityId).toBe(owner.entityId);
        };
        await openCustodyUi(false);
        const beforeCrash = await readWalletCheckpoint(page);
        expect(deriveDelta(funded.state.deltas.get(1)!, left).outCapacity).toBeGreaterThanOrEqual(2_000_000n);
        const crash = async () => {
          const before = (await getHealth()).process!.children!.find(c => c.role === 'hub' && c.name === 'H1')!;
          expect(before.online).toBe(true);
          expect(before.pid).toBeGreaterThan(0);
          h1.disconnect();
          process.kill(Number(before.pid), 'SIGKILL');
          await expect
            .poll(
              async () => {
                const after = (await getHealth())?.process?.children?.find(c => c.role === 'hub' && c.name === 'H1');
                return Boolean(
                  after?.online &&
                  after.pid !== before.pid &&
                  Number(after.restartCount) > Number(before.restartCount || 0),
                );
              },
              { timeout: 45_000 },
            )
            .toBe(true);
          const endpoint = new URL(entry.wsUrl);
          endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
          endpoint.pathname = '/api/health';
          await expect
            .poll(
              async () => {
                try {
                  return (await page.request.get(endpoint.toString(), { timeout: 1_000 })).status();
                } catch (error) {
                  return String(error);
                }
              },
              { timeout: 30_000, message: 'Restarted custody owner must bind its real HTTP/RPC server' },
            )
            .toBe(200);
          h1 = await connect('H1');
          await expect.poll(() => h1.commandReady, { timeout: 30_000 }).toBe(true);
        };
        await crash();
        const recovered = await h1.read<StorageEntityCoreDoc & { signerId: string }>(`/entity/${owner.entityId}`);
        expect(recovered.signerId.toLowerCase()).toBe(owner.ethereumAddress.toLowerCase());
        await expect.poll(() => settled(fundedDelta), { timeout: 30_000 }).toBe(true);
        expect((await readPair())[0].currentFrame.accountStateRoot).toBe(funded.currentFrame.accountStateRoot);
        await openCustodyUi(true);
        const restored = await readWalletCheckpoint(page);
        expect(restored.runtimeId).toBe(beforeCrash.runtimeId);
        expect(restored.entityId).toBe(beforeCrash.entityId);
        expect(restored.accounts).toEqual(beforeCrash.accounts);
        // The native owner retains WAL frames and current state, not historical
        // materialized Account snapshots. Bind recovery to both canonical sources.
        const restoredFrame = await h1.read<{ height: number; frameHash: string; postStateHash: string }>(
          `frame/${beforeCrash.frame.height}`,
        );
        expect({
          height: restoredFrame.height,
          frameHash: restoredFrame.frameHash,
          postStateHash: restoredFrame.postStateHash,
        }).toEqual(beforeCrash.frame);
        const paymentFromHeight = (await readWalletCheckpoint(page)).latestHeight + 1;
        await page.getByTestId('home-pay').click();
        await page.getByTestId('pay-to').fill(hubId);
        await page.getByTestId('pay-amount').fill('1');
        await expect(page.getByTestId('pay-submit')).toBeEnabled({ timeout: 15_000 });
        const quote = page.getByTestId('pay-quote');
        await expect(quote).toHaveAttribute('data-recipient-amount', '1000000');
        const senderAmount = BigInt((await quote.getAttribute('data-sender-amount'))!);
        const fee = BigInt((await quote.getAttribute('data-fee-amount'))!);
        expect(senderAmount).toBe(1_000_000n + fee);
        expect(senderAmount).toBeLessThanOrEqual(2_000_000n);
        await page.getByTestId('pay-submit').click();
        await page.getByTestId('receipt-open').click();
        await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 30_000 });
        await expect(page.getByTestId('receipt-amount')).toHaveText('1.00 USDC');
        await page.getByTestId('receipt-done').click();
        const paidDelta = fundedDelta + (left ? -senderAmount : senderAmount);
        await expect.poll(() => settled(paidDelta), { timeout: 30_000 }).toBe(true);
        const paid = (await readPair())[0];
        expect(paid.currentHeight).toBeGreaterThan(funded.currentHeight);
        expect(paid.currentFrame.accountStateRoot).not.toBe(funded.currentFrame.accountStateRoot);
        const receipt = await readCommittedPayment(page, owner.entityId, paymentFromHeight);
        expect(receipt.amount).toBe('1000000');
        expect(receipt.senderAmount).toBe(String(senderAmount));
        await crash();
        await openCustodyUi(true);
        await expect.poll(() => settled(paidDelta), { timeout: 30_000 }).toBe(true);
        expect((await readPair())[0].currentFrame.accountStateRoot).toBe(paid.currentFrame.accountStateRoot);
        expect((await readPair())[0].currentHeight).toBe(paid.currentHeight);
        expect(await readCommittedPayment(page, owner.entityId, paymentFromHeight)).toEqual(receipt);
      } finally {
        h1.disconnect();
        h2.disconnect();
      }
    },
  );
}
