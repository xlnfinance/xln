import type { RuntimeAdapter, RuntimeAdapterPaymentRoutesResponse } from '../runtime-adapter/types';
import {
  agentPaymentAmount,
  agentPaymentInput,
  decodeAgentPaymentRequest,
  decodePreparedAgentPayment,
  type PreparedAgentPayment,
} from './agent-intent';

export const assertAgentPaymentRuntime = (adapter: RuntimeAdapter, payment: PreparedAgentPayment): void => {
  if (
    adapter.status !== 'connected' ||
    adapter.runtimeId !== payment.runtimeId ||
    adapter.serverFingerprint !== payment.serverFingerprint
  )
    throw new Error('AGENT_PAYMENT_RUNTIME_MISMATCH');
  if (adapter.currentHeight < payment.fromHeight - 1) throw new Error('AGENT_PAYMENT_RUNTIME_ROLLED_BACK');
};

const requireOwnerLane = async (adapter: RuntimeAdapter): Promise<void> => {
  await adapter.ensureOwnerCommandLane();
  if (!adapter.commandReady || adapter.authLevel !== 'admin' || adapter.commandLaneKind !== 'owner') {
    throw new Error('AGENT_PAYMENT_OWNER_LANE_REQUIRED');
  }
};

/** Quote only. No command is enqueued; the caller must persist the returned record before send. */
export const prepareAgentPayment = async (adapter: RuntimeAdapter, value: unknown): Promise<PreparedAgentPayment> => {
  const request = decodeAgentPaymentRequest(value);
  await requireOwnerLane(adapter);
  const identity = { runtimeId: adapter.runtimeId, serverFingerprint: adapter.serverFingerprint };
  const { routes } = await adapter.read<RuntimeAdapterPaymentRoutesResponse>('payment-routes', {
    sourceEntityId: request.entityId,
    targetEntityId: request.targetEntityId,
    tokenId: request.tokenId,
    amount: request.amount,
  });
  const affordable = routes.filter(route => BigInt(agentPaymentAmount(route.senderAmount)) <= BigInt(request.maxDebit));
  const best = affordable.reduce<(typeof routes)[number] | undefined>(
    (current, route) => (!current || BigInt(route.senderAmount) < BigInt(current.senderAmount) ? route : current),
    undefined,
  );
  if (!best) throw new Error('AGENT_PAYMENT_NO_ROUTE_WITHIN_CAP');
  if (best.recipientAmount !== request.amount) throw new Error('AGENT_PAYMENT_QUOTE_AMOUNT_MISMATCH');
  const payment = decodePreparedAgentPayment({
    ...request,
    ...identity,
    commandSequence: adapter.nextCommandSequence,
    fromHeight: adapter.currentHeight + 1,
    senderAmount: best.senderAmount,
    route: best.path,
  });
  assertAgentPaymentRuntime(adapter, payment);
  return payment;
};

/** Retry this exact intent, including its original sequence. An observed command is not a paid receipt. */
export const sendAgentPayment = async (adapter: RuntimeAdapter, value: unknown) => {
  const payment = decodePreparedAgentPayment(value);
  await requireOwnerLane(adapter);
  assertAgentPaymentRuntime(adapter, payment);
  return adapter.send(agentPaymentInput(payment), {
    commandId: payment.commandId,
    commandSequence: payment.commandSequence,
  });
};
