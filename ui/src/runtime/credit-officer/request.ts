import { getJson, postJson } from '../http';
import { decodeCreditRequest, type CreditRequest } from '@xln/core/orchestrator/credit-officer/proof';

function solve(request: CreditRequest, bits: number): Promise<CreditRequest> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./proof.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Credit proof timed out'));
    }, 60_000);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onerror = event => {
      finish();
      reject(new Error(event.message));
    };
    worker.onmessage = (event: MessageEvent<{ request?: unknown; error?: string }>) => {
      finish();
      try {
        if (event.data.error) throw new Error(event.data.error);
        resolve(decodeCreditRequest(event.data.request));
      } catch (cause) {
        reject(cause);
      }
    };
    worker.postMessage({ request, bits });
  });
}

/** Disabled officers leave manual bank governance available. Enabled but
 * unreachable officers fail visibly; a failed proof never submits a draw. */
export async function requestCreditFacility(
  input: {
    hubEntityId: string;
    borrowerEntityId: string;
    tokenId: number;
    amount: bigint;
    termId: '1h' | '1d' | '1m';
  },
  notice: (text: string) => void,
): Promise<boolean> {
  const status = await getJson('/api/credit-officer/status', {});
  if (status['enabled'] === false) return false;
  const params = { ...input, amount: input.amount.toString(), tokenId: String(input.tokenId) };
  const challenge = await getJson('/api/credit-officer/challenge', params);
  if (typeof challenge['day'] !== 'string' || typeof challenge['bits'] !== 'number')
    throw new Error('Invalid credit challenge');
  notice('Computing proof of work for this borrowing request…');
  const proof = await solve(
    decodeCreditRequest({ ...input, amount: input.amount.toString(), day: challenge['day'], nonce: '0' }),
    challenge['bits'],
  );
  notice('Credit officer is checking committed account history…');
  const decision = await postJson('/api/credit-officer/approve', proof);
  if (decision['approved'] !== true) throw new Error(`Credit officer denied: ${String(decision['reason'])}`);
  notice('Credit officer submitted approval. Waiting for bank commitment…');
  return true;
}
