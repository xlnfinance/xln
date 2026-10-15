import { describe, expect, test } from 'bun:test';
import {
  decodeAgentPaymentRequest,
  decodePreparedAgentPayment,
  agentPaymentInput,
  agentPaymentReference,
} from '../../../api/payments/agent-intent';
import { applyAgentPaymentReceipts, type AgentPaymentStatus } from '../../../api/payments/agent-status';
import type { RuntimeAdapterFrameReceipt } from '../../../api/runtime-adapter/types';
import { buildHtlcFinalizedEventPayload } from '../../../protocol/htlc/events';
import { safeStringify } from '../../../protocol/serialization';

const source = `0x${'11'.repeat(32)}`;
const hub = `0x${'22'.repeat(32)}`;
const recipient = `0x${'33'.repeat(32)}`;
const hashlock = `0x${'44'.repeat(32)}`;
const request = {
  commandId: 'agent-order-000001',
  entityId: source,
  signerId: `0x${'55'.repeat(20)}`,
  targetEntityId: recipient,
  tokenId: 1,
  amount: '9007199254740993',
  maxDebit: '9007199254741000',
};
const payment = decodePreparedAgentPayment({
  ...request,
  runtimeId: `0x${'66'.repeat(20)}`,
  serverFingerprint: `0x${'77'.repeat(32)}`,
  commandSequence: 3,
  fromHeight: 10,
  senderAmount: request.maxDebit,
  route: [source, hub, recipient],
});
const receipt = (height: number, message: string, data: Record<string, unknown>): RuntimeAdapterFrameReceipt => ({
  height,
  timestamp: height * 1000,
  logs: [{ id: height, timestamp: height * 1000, level: 'info', category: 'runtime', message, entityId: source, data }],
});
const initiated = receipt(10, 'HtlcInitiated', {
  entityId: source,
  toEntity: recipient,
  tokenId: 1,
  amount: payment.amount,
  senderAmount: payment.senderAmount,
  hashlock,
  description: agentPaymentReference(payment),
});
const finalized = receipt(
  510,
  'HtlcFinalized',
  buildHtlcFinalizedEventPayload({
    entityId: source,
    toEntity: hub,
    tokenId: 1,
    amount: BigInt(payment.senderAmount),
    hashlock,
    finalizedAtMs: 510_000,
    secret: `0x${'88'.repeat(32)}`,
  }),
);
const unresolved = (): AgentPaymentStatus => ({ status: 'unresolved', scannedThroughHeight: 9 });

describe('agent payment boundaries', () => {
  test('JSON persistence reconstructs the exact payment, debit cap and operation reference', () => {
    const restored = decodePreparedAgentPayment(JSON.parse(safeStringify(payment)));
    expect(safeStringify(agentPaymentInput(restored))).toBe(safeStringify(agentPaymentInput(payment)));
    expect(agentPaymentInput(restored).entityInputs[0]?.entityTxs[0]).toEqual({
      type: 'htlcPayment',
      data: {
        targetEntityId: recipient,
        tokenId: 1,
        amount: 9007199254740993n,
        maxSenderDebit: 9007199254741000n,
        route: [source, hub, recipient],
        deliveryMode: 'instant',
        description: 'xln-agent:agent-order-000001',
      },
    });
  });

  test.each(['1.1', '-1', '1e6', '001', '0', 9007199254740993])('rejects noncanonical amount %p', amount => {
    expect(() => decodeAgentPaymentRequest({ ...request, amount })).toThrow('AGENT_PAYMENT_INVALID:amount');
  });

  test('rejects an unaffordable payment and a changed recipient before send', () => {
    expect(() => decodePreparedAgentPayment({ ...payment, senderAmount: '9007199254741001' })).toThrow(
      'DEBIT_CAP_EXCEEDED',
    );
    expect(() => decodePreparedAgentPayment({ ...payment, targetEntityId: hub })).toThrow('ROUTE_MISMATCH');
    expect(() => decodePreparedAgentPayment({ ...payment, route: [source, hub, source, recipient] })).toThrow(
      'ROUTE_MISMATCH',
    );
    expect(() => decodePreparedAgentPayment({ ...payment, commandSequence: 3.5 })).toThrow('commandSequence');
  });

  test('no terminal evidence remains unresolved; an unrelated payment is not success', () => {
    const state = unresolved();
    applyAgentPaymentReceipts(payment, state, [finalized]);
    expect(state.status).toBe('unresolved');
    applyAgentPaymentReceipts(payment, state, [initiated]);
    expect(state.status).toBe('in_flight');
    const unrelated = receipt(20, 'HtlcFinalized', { hashlock: `0x${'99'.repeat(32)}` });
    applyAgentPaymentReceipts(payment, state, [unrelated]);
    expect(state.status).toBe('in_flight');
  });

  test('correlates routed finality across pages by hashlock, without leaking the secret', () => {
    const state = unresolved();
    applyAgentPaymentReceipts(payment, state, [initiated]);
    applyAgentPaymentReceipts(payment, state, [finalized]);
    expect(state).toEqual({
      status: 'settled',
      scannedThroughHeight: 9,
      hashlock,
      senderAmount: payment.senderAmount,
      terminalHeight: 510,
    });
    expect(safeStringify(state)).not.toContain('secret');
  });

  test('accepts a cheaper executed quote but rejects excess debit', () => {
    const cheaper = structuredClone(initiated);
    cheaper.logs[0]!.data!['senderAmount'] = payment.amount;
    const state = unresolved();
    applyAgentPaymentReceipts(payment, state, [cheaper]);
    expect(state.senderAmount).toBe(payment.amount);
    cheaper.logs[0]!.data!['senderAmount'] = '9007199254741001';
    expect(() => applyAgentPaymentReceipts(payment, unresolved(), [cheaper])).toThrow('RECEIPT_DEBIT_MISMATCH');
  });

  test('fails loudly on ambiguous reference reuse, mismatched terms, or conflicting finality', () => {
    const wrong = structuredClone(initiated);
    wrong.logs[0]!.data!['amount'] = '1';
    expect(() => applyAgentPaymentReceipts(payment, unresolved(), [wrong])).toThrow('RECEIPT_MISMATCH');
    expect(() => applyAgentPaymentReceipts(payment, unresolved(), [initiated, initiated])).toThrow('REFERENCE_REUSED');
    expect(() => applyAgentPaymentReceipts(payment, unresolved(), [initiated, finalized, finalized])).toThrow(
      'TERMINAL_CONFLICT',
    );
  });

  test('only an explicit failure for the matching hashlock is failed', () => {
    const state = unresolved();
    applyAgentPaymentReceipts(payment, state, [initiated, receipt(20, 'HtlcFailed', { hashlock, reason: 'timeout' })]);
    expect(state).toMatchObject({ status: 'failed', reason: 'timeout', terminalHeight: 20 });
  });
});
