import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { finish, readJson, sends, waitForSends } from './standalone-deployment-transactions-support';
import { policyConfig } from './standalone-deployment-policy-config';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';
import { pendingFeeRpc } from './standalone-deployment-fee-mine-support';

test.each(['replacement', 'original'] as const)(
  'native fee bump preserves all hashes when the %s wins',
  async winner => {
    const fixture = await startStandaloneNode(0);
    const config = await policyConfig();
    const observer = pendingFeeRpc(fixture);
    const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
    await fixture.provider.send('evm_setAutomine', [false]);
    let session = launchDeployment(fixture, 'fee-original', { config: config.path, rpcUrl: observer.url });
    try {
      const [first] = await waitForSends(fixture, session, 1);
      const original = await fixture.provider.getTransaction(first.transaction.hash);
      await until(async () => {
        if (session.outcome() !== undefined) throw new Error(await session.log());
        if ((await sends(fixture)).length >= 2) return true;
        await observer.mineEmptyBlock();
        await Bun.sleep(100);
        return false;
      }, 'native-live-fee-bump');
      const history = await sends(fixture);
      const replacement = await fixture.provider.getTransaction(history[1].transaction.hash);
      expect(replacement!.nonce).toBe(original!.nonce);
      expect(replacement!.maxFeePerGas!).toBeGreaterThan(original!.maxFeePerGas!);
      expect(replacement!.maxPriorityFeePerGas!).toBeGreaterThan(original!.maxPriorityFeePerGas!);
      if (winner === 'original') {
        const originalRaw = observer.originalRaw();
        expect(originalRaw).not.toBe('');
        await fixture.provider.send('anvil_dropTransaction', [replacement!.hash]);
        // Re-propagate exactly the earlier native-signed transaction. No new
        // signature, nonce or financial action is invented by this controller.
        expect(await fixture.provider.send('eth_sendRawTransaction', [originalRaw])).toBe(original!.hash);
      }
      await fixture.provider.send('evm_setAutomine', [true]);
      await fixture.provider.send('anvil_mine', ['0x1']);
      const result = await finish(fixture, session);
      const seal = await readJson(join(fixture.nativeDirectory, 'manifest.json.execution.json'));
      expect(seal.policy.native.config.timeBeforeBumpingFees).toBe(1000);
      expect(result.expenses.broadcasts).toBeGreaterThanOrEqual(12);
      expect(initialBalance - (await fixture.provider.getBalance(fixture.signer.address))).toBe(
        BigInt(result.expenses.attemptTransactionFeesWei),
      );
      expect(result.expenses.balance.deltaWei).toBe(result.expenses.attemptTransactionFeesWei);
      expect(result.expenses.balance.unaccountedDeltaWei).toBe('0');
      const audit = await readJson(join(fixture.nativeDirectory, 'manifest.json.transactions.json'));
      expect(audit.filter((tx: any) => tx.status === 'SUCCESS')).toHaveLength(11);
      expect(new Set(audit.filter((tx: any) => tx.status === 'SUCCESS').map((tx: any) => tx.futureId)).size).toBe(11);
      const losingHash = winner === 'original' ? replacement!.hash : first.transaction.hash;
      const winningHash = winner === 'original' ? first.transaction.hash : replacement!.hash;
      expect(audit.find((tx: any) => tx.txHash === losingHash).status).toBe('DROPPED');
      expect(audit.find((tx: any) => tx.txHash === winningHash).status).toBe('SUCCESS');
      expect(result.expenses.receipts.find((tx: any) => tx.transactionHash === losingHash).journalStatus).toBe(
        'DROPPED',
      );
      const before = fixture.submissions();
      session = launchDeployment(fixture, 'fee-completed', { mode: 'resume', config: config.path });
      expect(await session.exited).toBe(0);
      expect(fixture.submissions()).toBe(before);
      await writeFile(
        join(fixture.directory, 'fee-bump-proof.json'),
        safeStringify(
          {
            winner,
            probePolicy: seal.policy.native,
            productionDefaultBumpMs: 180000,
            controllerExactRawRepropagations: observer.repropagations(),
            controllerEmptyBlocks: observer.emptyBlocks(),
            sends: await sends(fixture),
            expenses: result.expenses,
          },
          2,
        ),
      );
      console.log(`STANDALONE_FEE_BUMP_EVIDENCE:${fixture.directory}/fee-bump-proof.json`);
    } finally {
      await session.stop();
      await observer.close();
      await config.close();
      await fixture.close();
    }
  },
  60_000,
);
