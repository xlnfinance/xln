import { TOKENS } from '../../config/constants';
import { buildPaymentRuntimeInput } from './command';

export type AgentPaymentRequest = Readonly<{
  commandId: string;
  entityId: string;
  signerId: string;
  targetEntityId: string;
  tokenId: number;
  /** Recipient amount in integer base units, never floating-point token quantities. */
  amount: string;
  /** Maximum total sender debit, including routing fees. */
  maxDebit: string;
}>;

/** Application-owned intent: save before sending, then retry this exact record. */
export type PreparedAgentPayment = AgentPaymentRequest &
  Readonly<{
    runtimeId: string;
    serverFingerprint: string;
    commandSequence: number;
    fromHeight: number;
    senderAmount: string;
    route: string[];
  }>;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_PAYMENT_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
};

const text = (value: unknown, pattern: RegExp, field: string): string => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`AGENT_PAYMENT_INVALID:${field}`);
  return value;
};

const integer = (value: unknown, min: number, max: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`AGENT_PAYMENT_INVALID:${field}`);
  }
  return value;
};

const entity = (value: unknown): string => text(value, /^0x[\da-fA-F]{64}$/, 'entityId').toLowerCase();
export const agentPaymentAmount = (value: unknown): string => text(value, /^[1-9]\d{0,77}$/, 'amount');

export const decodeAgentPaymentRequest = (value: unknown): AgentPaymentRequest => {
  const input = record(value);
  const amount = agentPaymentAmount(input['amount']);
  const maxDebit = agentPaymentAmount(input['maxDebit']);
  if (BigInt(maxDebit) < BigInt(amount)) throw new Error('AGENT_PAYMENT_DEBIT_CAP_EXCEEDED');
  return {
    commandId: text(input['commandId'], /^[A-Za-z0-9._:-]{16,128}$/, 'commandId'),
    entityId: entity(input['entityId']),
    signerId: text(input['signerId'], /^0x[\da-fA-F]{40}$/, 'signerId').toLowerCase(),
    targetEntityId: entity(input['targetEntityId']),
    tokenId: integer(input['tokenId'], 1, TOKENS.MAX_TOKEN_ID, 'tokenId'),
    amount,
    maxDebit,
  };
};

export const decodePreparedAgentPayment = (value: unknown): PreparedAgentPayment => {
  const input = record(value);
  const request = decodeAgentPaymentRequest(input);
  const path = input['route'];
  if (!Array.isArray(path)) throw new Error('AGENT_PAYMENT_ROUTE_REQUIRED');
  const route = path.map(entity);
  if (
    route.length < 2 ||
    route[0] !== request.entityId ||
    route.at(-1) !== request.targetEntityId ||
    new Set(route).size !== route.length
  ) {
    throw new Error('AGENT_PAYMENT_ROUTE_MISMATCH');
  }
  const senderAmount = agentPaymentAmount(input['senderAmount']);
  if (BigInt(senderAmount) < BigInt(request.amount) || BigInt(senderAmount) > BigInt(request.maxDebit)) {
    throw new Error('AGENT_PAYMENT_DEBIT_CAP_EXCEEDED');
  }
  return {
    ...request,
    route,
    senderAmount,
    runtimeId: text(input['runtimeId'], /^0x[\da-f]{40}$/, 'runtimeId'),
    serverFingerprint: text(input['serverFingerprint'], /^0x[\da-f]{64}$/, 'serverFingerprint'),
    commandSequence: integer(input['commandSequence'], 1, Number.MAX_SAFE_INTEGER, 'commandSequence'),
    fromHeight: integer(input['fromHeight'], 1, Number.MAX_SAFE_INTEGER, 'fromHeight'),
  };
};

export const agentPaymentReference = (payment: AgentPaymentRequest): string => `xln-agent:${payment.commandId}`;

/** Reconstruct the same canonical input after JSON persistence; no client-generated HTLC secret. */
export const agentPaymentInput = (payment: PreparedAgentPayment) =>
  buildPaymentRuntimeInput({
    ...payment,
    deliveryMode: 'instant',
    description: agentPaymentReference(payment),
    route: {
      path: payment.route,
      recipientAmount: BigInt(payment.amount),
      senderAmount: BigInt(payment.senderAmount),
      totalFee: BigInt(payment.senderAmount) - BigInt(payment.amount),
    },
  });
