import { Transaction } from 'ethers';
import { observeRpc } from './standalone-deployment-rpc-support';
import { journalMessages, type Fixture, type Session } from './standalone-deployment-transactions-support';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';

export type ReceiptCut = 'before-receipt-observation' | 'after-receipt-observation';

export const interruptAtReceipt = (fixture: Fixture, operation: number, phase: ReceiptCut) => {
  let hash = '';
  let receipt: unknown;
  let returned = false;
  let held = false;
  let nextRequest = '';
  let release = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const observer = observeRpc(fixture, {
    before: async request => {
      if (request.method === 'eth_sendRawTransaction') {
        const transaction = Transaction.from(request.params[0]);
        if (transaction.nonce === fixture.initialNonce + operation - 1) hash = transaction.hash!;
      }
      if (phase !== 'after-receipt-observation' || !returned || held) return;
      const confirmed = (await journalMessages(fixture)).some(message =>
        message.type === 'TRANSACTION_CONFIRM' && message.hash === hash);
      if (!confirmed) return;
      // This later client request follows delivery and consumption of the real
      // receipt. Journal confirmation is recorded as the stronger observed stage.
      held = true;
      nextRequest = request.method;
      await barrier;
    },
    after: async (request, result) => {
      if (request.method !== 'eth_getTransactionReceipt' || request.params[0] !== hash || !result) return;
      receipt = result;
      if (phase === 'after-receipt-observation') { returned = true; return; }
      held = true;
      // The actual upstream receipt is retained, never fabricated or forwarded
      // to the native caller before this cut.
      await barrier;
    },
  });
  return {
    url: observer.url,
    wait: async (session: Session) => {
      await until(async () => held || session.outcome() !== undefined, `matrix-${operation}-${phase}`);
      if (!held) throw new Error(await session.log());
      return { hash, receipt, returnedToNative: returned, journalConfirmed: returned, nextRequest };
    },
    close: async () => { await observer.close(); release(); },
  };
};

export const killNativeGroup = async (session: Session, nativePid: number): Promise<number> => {
  if (nativePid === session.pid) throw new Error('MATRIX_NATIVE_CHILD_NOT_IDENTIFIED');
  process.kill(-session.pid, 'SIGKILL');
  const code = await session.exited;
  await until(async () => {
    try { process.kill(nativePid, 0); return false; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
      throw error;
    }
  }, 'matrix-native-child-stopped');
  return code;
};
