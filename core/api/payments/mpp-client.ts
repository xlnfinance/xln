import { Credential, Method, type Store } from 'mppx';
import type { RuntimeAdapter } from '../runtime-adapter/types';
import { prepareAgentPayment, sendAgentPayment } from './agent';
import { decodePreparedAgentPayment, type PreparedAgentPayment } from './agent-intent';
import { readAgentPaymentStatus } from './agent-status';
import { requireXlnMppCurrency, xlnMppCommandId, xlnMppMethod } from './mpp-method';

type StoredMppPayment = { currency: string; payment: PreparedAgentPayment };

type XlnMppClientOptions = {
  adapter: RuntimeAdapter;
  entityId: string;
  signerId: string;
  /** Trusted host pins, not values suggested by an LLM or copied from a challenge. */
  realm: string;
  recipient: string;
  currency: string;
  maxDebit: string;
  /** Durable and atomic in production. Serialize use of the Runtime owner's command lane. */
  intents: Store.AtomicStore<Record<string, StoredMppPayment>>;
};

const waitForPayment = async (adapter: RuntimeAdapter, payment: PreparedAgentPayment): Promise<string> => {
  const deadline = performance.now() + 30_000;
  await sendAgentPayment(adapter, payment);
  while (performance.now() < deadline) {
    const status = await readAgentPaymentStatus(adapter, payment);
    if (status.status === 'settled' && status.hashlock) return status.hashlock;
    if (status.status === 'failed') throw new Error(`MPP_XLN_PAYMENT_FAILED:${status.reason ?? 'unknown'}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('MPP_XLN_PAYMENT_UNRESOLVED:retry the same order; do not create a new payment');
};

/** Register with Mppx.create({ methods: [xlnMppClient(options)], polyfill: false }). */
export const xlnMppClient = (options: XlnMppClientOptions) =>
  Method.toClient(xlnMppMethod, {
    async createCredential({ challenge }) {
      const request = xlnMppMethod.schema.request.parse(challenge.request);
      if (
        challenge.realm !== options.realm ||
        request.recipient.toLowerCase() !== options.recipient.toLowerCase() ||
        request.currency !== options.currency
      )
        throw new Error('MPP_XLN_OFFER_NOT_AUTHORIZED');
      const tokenId = await requireXlnMppCurrency(options.adapter, options.entityId, request.currency);
      const commandId = xlnMppCommandId(challenge.realm, request);
      let stored = await options.intents.get(commandId);
      if (!stored) {
        const prepared = await prepareAgentPayment(options.adapter, {
          commandId,
          tokenId,
          entityId: options.entityId,
          signerId: options.signerId,
          targetEntityId: request.recipient,
          amount: request.amount,
          maxDebit: options.maxDebit,
        });
        const created = { currency: request.currency, payment: prepared };
        stored = await options.intents.update(commandId, current =>
          current ? { op: 'noop', result: current } : { op: 'set', value: created, result: created },
        );
      }
      const payment = decodePreparedAgentPayment(stored.payment);
      if (
        stored.currency !== request.currency ||
        payment.commandId !== commandId ||
        payment.entityId !== options.entityId.toLowerCase() ||
        payment.targetEntityId !== request.recipient.toLowerCase() ||
        payment.tokenId !== tokenId ||
        payment.amount !== request.amount ||
        BigInt(payment.senderAmount) > BigInt(options.maxDebit)
      ) {
        throw new Error('MPP_XLN_SAVED_ORDER_MISMATCH');
      }
      const hashlock = await waitForPayment(options.adapter, payment);
      return Credential.serialize({ challenge, payload: { hashlock } });
    },
  });
