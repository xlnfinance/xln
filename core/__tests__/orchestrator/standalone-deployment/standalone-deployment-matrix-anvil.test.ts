import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './support/standalone-deployment-support';
import { launchDeployment } from './support/standalone-deployment-process-support';
import { finish, journalMessages, readJson } from './support/standalone-deployment-transactions-support';
import { interruptAtReceipt, killNativeGroup, type ReceiptCut } from './support/standalone-deployment-matrix-barrier-support';
import { intendedOperations, poisonCatalog, verifyMatrixCompletion, verifyCompletedReruns } from './support/standalone-deployment-matrix-assertions-support';

const phases: readonly ReceiptCut[] = ['before-receipt-observation', 'after-receipt-observation'];
const cases = intendedOperations.flatMap((name, index) => phases.map(phase => ({
  operation: index + 1, name, phase,
  extraNonce: name === 'registerStablecoin' && phase === 'after-receipt-observation' ? 3 : 0,
})));

test.each(cases)(
  'native interruption $name $phase resumes eleven unique operations',
  async ({ operation, name, phase, extraNonce }) => {
    const fixture = await startStandaloneNode(0, extraNonce);
    const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
    await writeFile(fixture.catalog, poisonCatalog);
    const barrier = interruptAtReceipt(fixture, operation, phase);
    let session = launchDeployment(fixture, 'matrix-original', { rpcUrl: barrier.url });
    const proof = join(fixture.directory, `matrix-${operation}-${phase}-proof.json`);
    try {
      const cut = await barrier.wait(session);
      expect(cut.receipt).toMatchObject({ transactionHash: cut.hash, status: '0x1' });
      expect(cut.returnedToNative).toBe(phase === 'after-receipt-observation');
      const original = await readJson(join(fixture.nativeDirectory, 'result.json'));
      expect(original.status).toBe('running');
      expect(original.owner.pgid).toBe(session.pid);
      const atCut = await journalMessages(fixture);
      const confirmed = atCut.filter(message => message.type === 'TRANSACTION_CONFIRM' && message.hash === cut.hash);
      expect(confirmed).toHaveLength(phase === 'after-receipt-observation' ? 1 : 0);
      expect(atCut.filter(message => message.type === 'TRANSACTION_SEND')).toHaveLength(operation);
      expect(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))).toBe(
        BigInt(fixture.initialNonce + operation));
      const journal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
      await writeFile(proof, safeStringify({ status: 'cut-observed', operation, name, phase,
        initialNonce: fixture.initialNonce, nativeDirectory: fixture.nativeDirectory, cut, original, atCut }, 2));
      const originalExitCode = await killNativeGroup(session, original.owner.pid);
      expect(originalExitCode).not.toBe(0);
      await barrier.close();
      const sendsBeforeResume = fixture.submissions();
      session = launchDeployment(fixture, 'matrix-resumed', { mode: 'resume' });
      const result = await finish(fixture, session);
      expect(fixture.submissions() - sendsBeforeResume).toBe(11 - operation);
      expect((await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).startsWith(journal)).toBeTrue();
      const interruptedPath = join(original.invocation, 'result.json');
      const interrupted = await readJson(interruptedPath);
      expect(interrupted).toEqual({ ...original, status: 'interrupted' });
      const completion = await verifyMatrixCompletion(fixture, result, initialBalance);
      const reruns = await verifyCompletedReruns(fixture, result, interruptedPath);
      await writeFile(proof, safeStringify({ status: 'complete', operation, name, phase, initialNonce: fixture.initialNonce,
        nativeDirectory: fixture.nativeDirectory, cut, atCut, originalExitCode, original, interrupted, completion, result, reruns }, 2));
      console.log(`STANDALONE_MATRIX_EVIDENCE:${proof}:operation=${operation}:phase=${phase}:operations=11`);
    } finally {
      await session.stop();
      await barrier.close();
      await fixture.close();
    }
  },
  180_000,
);
