import type {
  RuntimeAdapter,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterFrameReceipt,
} from '../runtime-adapter/types';
import { assertAgentPaymentRuntime } from './agent';
import {
  agentPaymentAmount,
  agentPaymentReference,
  decodePreparedAgentPayment,
  type PreparedAgentPayment,
} from './agent-intent';

/** Local committed evidence, not a transferable payment proof or a guarantee of collateral recovery. */
export type AgentPaymentStatus = {
  status: 'unresolved' | 'in_flight' | 'settled' | 'failed';
  scannedThroughHeight: number;
  hashlock?: string;
  senderAmount?: string;
  terminalHeight?: number;
  reason?: string;
};

export const applyAgentPaymentReceipts = (
  payment: PreparedAgentPayment,
  result: AgentPaymentStatus,
  receipts: RuntimeAdapterFrameReceipt[],
): void => {
  for (const frame of receipts)
    for (const log of frame.logs) {
      const data = log.data;
      if (!data || (log.entityId ?? data['entityId']) !== payment.entityId) continue;
      if (log.message === 'HtlcInitiated' && data['description'] === agentPaymentReference(payment)) {
        if (result.hashlock) throw new Error('AGENT_PAYMENT_REFERENCE_REUSED');
        if (
          data['toEntity'] !== payment.targetEntityId ||
          data['tokenId'] !== payment.tokenId ||
          data['amount'] !== payment.amount ||
          typeof data['hashlock'] !== 'string' ||
          !/^0x[\da-f]{64}$/.test(data['hashlock'])
        ) {
          throw new Error('AGENT_PAYMENT_RECEIPT_MISMATCH');
        }
        const actualDebit = agentPaymentAmount(data['senderAmount']);
        if (BigInt(actualDebit) < BigInt(payment.amount) || BigInt(actualDebit) > BigInt(payment.senderAmount)) {
          throw new Error('AGENT_PAYMENT_RECEIPT_DEBIT_MISMATCH');
        }
        result.hashlock = data['hashlock'];
        result.senderAmount = actualDebit;
        result.status = 'in_flight';
      } else if (result.hashlock && data['hashlock'] === result.hashlock) {
        if (log.message === 'HtlcFinalized' || log.message === 'HtlcFailed') {
          if (result.terminalHeight !== undefined) throw new Error('AGENT_PAYMENT_TERMINAL_CONFLICT');
          result.status = log.message === 'HtlcFinalized' ? 'settled' : 'failed';
          result.terminalHeight = frame.height;
          if (typeof data['reason'] === 'string') result.reason = data['reason'];
        }
      }
    }
};

/** Explicit, bounded history read. Missing evidence never authorizes sending a new payment. */
export const readAgentPaymentStatus = async (adapter: RuntimeAdapter, value: unknown): Promise<AgentPaymentStatus> => {
  const payment = decodePreparedAgentPayment(value);
  assertAgentPaymentRuntime(adapter, payment);
  const head = adapter.currentHeight;
  if (head - payment.fromHeight >= 10_000)
    throw new Error('AGENT_PAYMENT_HISTORY_LIMIT:use frame-receipts for older evidence');
  const result: AgentPaymentStatus = { status: 'unresolved', scannedThroughHeight: payment.fromHeight - 1 };
  for (let fromHeight = payment.fromHeight; fromHeight <= head;) {
    const page = await adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
      fromHeight,
      toHeight: head,
      limit: 500,
      entityId: payment.entityId,
      eventNames: ['HtlcInitiated', 'HtlcFinalized', 'HtlcFailed'],
    });
    assertAgentPaymentRuntime(adapter, payment);
    if (page.toHeight < fromHeight || page.toHeight > head) throw new Error('AGENT_PAYMENT_RECEIPT_GAP');
    applyAgentPaymentReceipts(payment, result, page.receipts);
    result.scannedThroughHeight = page.toHeight;
    fromHeight = page.toHeight + 1;
  }
  return result;
};
