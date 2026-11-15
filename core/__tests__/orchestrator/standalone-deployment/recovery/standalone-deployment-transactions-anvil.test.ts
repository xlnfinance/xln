import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';
import { startStandaloneNode } from '../support/standalone-deployment-support';
import { launchDeployment } from '../support/standalone-deployment-process-support';
import { finish, readJson, sends, waitForSends } from '../support/standalone-deployment-transactions-support';
import { observeRpc } from '../support/standalone-deployment-rpc-support';
import { until } from '../../stack-manager-recovery/stack-manager-resume-support';

test.each(['pending', 'dropped'] as const)(
  'native %s recovery preserves the original nonce and eleven intended operations',
  async kind => {
    const fixture = await startStandaloneNode(0);
    const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
    const observer = observeRpc(fixture);
    await fixture.provider.send('evm_setAutomine', [false]);
    let session = launchDeployment(fixture, `${kind}-original`, { rpcUrl: observer.url });
    try {
      const [first] = await waitForSends(fixture, session, 1);
      const originalTransaction = await fixture.provider.getTransaction(first.transaction.hash);
      expect(originalTransaction).not.toBeNull();
      expect(originalTransaction!.blockNumber).toBeNull();
      expect(originalTransaction!.nonce).toBe(fixture.initialNonce);
      await session.stop();
      const original = await readJson(join(fixture.nativeDirectory, 'result.json'));
      if (kind === 'dropped') {
        await fixture.provider.send('anvil_dropTransaction', [first.transaction.hash]);
        expect(await fixture.provider.getTransaction(first.transaction.hash)).toBeNull();
      }
      const previousReads = observer.receiptReads(first.transaction.hash);
      session = launchDeployment(fixture, `${kind}-resumed`, { mode: 'resume', rpcUrl: observer.url });
      if (kind === 'dropped') {
        const history = await waitForSends(fixture, session, 2);
        const replacement = await fixture.provider.getTransaction(history[1].transaction.hash);
        expect(replacement!.nonce).toBe(originalTransaction!.nonce);
        expect(replacement!.maxFeePerGas!).toBeGreaterThan(originalTransaction!.maxFeePerGas!);
      } else
        await until(
          async () => observer.receiptReads(first.transaction.hash) > previousReads,
          'pending-observed-after-resume',
        );
      await fixture.provider.send('evm_setAutomine', [true]);
      await fixture.provider.send('anvil_mine', ['0x1']);
      const result = await finish(fixture, session);
      expect(result.expenses.broadcasts).toBe(kind === 'pending' ? 11 : 12);
      expect(initialBalance - (await fixture.provider.getBalance(fixture.signer.address))).toBe(
        BigInt(result.expenses.attemptTransactionFeesWei),
      );
      expect(result.expenses.balance.deltaWei).toBe(result.expenses.attemptTransactionFeesWei);
      expect(result.expenses.balance.unaccountedDeltaWei).toBe('0');
      expect((await readJson(join(original.invocation, 'result.json'))).status).toBe('interrupted');
      const beforeRerun = fixture.submissions();
      session = launchDeployment(fixture, `${kind}-completed`, { mode: 'resume' });
      expect(await session.exited).toBe(0);
      expect(fixture.submissions()).toBe(beforeRerun);
      await writeFile(
        join(fixture.directory, `${kind}-proof.json`),
        safeStringify(
          {
            kind,
            initialNonce: fixture.initialNonce,
            originalTransaction: originalTransaction!.hash,
            sends: await sends(fixture),
            expenses: result.expenses,
          },
          2,
        ),
      );
      console.log(`STANDALONE_TRANSACTION_EVIDENCE:${fixture.directory}/${kind}-proof.json`);
    } finally {
      await session.stop();
      await observer.close();
      await fixture.close();
    }
  },
  180_000,
);
