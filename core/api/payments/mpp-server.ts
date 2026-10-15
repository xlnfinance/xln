import { Method, type Receipt } from 'mppx';
import type { RuntimeAdapter, RuntimeAdapterFrameReceiptResponse } from '../runtime-adapter/types';
import { requireXlnMppCurrency, xlnMppCommandId, xlnMppMethod, type XlnMppRequest } from './mpp-method';

type XlnMppServerOptions = { adapter: RuntimeAdapter; recipient: string; currency: string };

/** Verify only the merchant's own committed receipt. Never trust a payer's success assertion. */
const readXlnMppReceipt = async (
  options: XlnMppServerOptions,
  realm: string,
  request: XlnMppRequest,
  hashlock: string,
): Promise<Receipt.Receipt> => {
  if (request.recipient.toLowerCase() !== options.recipient.toLowerCase() || request.currency !== options.currency) {
    throw new Error('MPP_XLN_MERCHANT_MISMATCH');
  }
  const { adapter } = options;
  const tokenId = await requireXlnMppCurrency(adapter, options.recipient, options.currency);
  const runtimeId = adapter.runtimeId;
  const head = adapter.currentHeight;
  if (head - request.fromHeight >= 10_000) throw new Error('MPP_XLN_RECEIPT_HISTORY_LIMIT');
  const reference = `xln-agent:${xlnMppCommandId(realm, request)}`;
  for (let fromHeight = request.fromHeight; fromHeight <= head;) {
    const page = await adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
      fromHeight,
      toHeight: head,
      limit: 500,
      entityId: options.recipient,
      eventNames: ['HtlcReceived'],
    });
    if (adapter.runtimeId !== runtimeId || page.toHeight < fromHeight || page.toHeight > head) {
      throw new Error('MPP_XLN_RECEIPT_RANGE_INVALID');
    }
    for (const frame of page.receipts)
      for (const log of frame.logs) {
        const data = log.data;
        if (
          log.message === 'HtlcReceived' &&
          data &&
          (log.entityId ?? data['entityId']) === options.recipient.toLowerCase() &&
          data['hashlock'] === hashlock &&
          data['description'] === reference &&
          data['tokenId'] === tokenId &&
          data['amount'] === request.amount
        ) {
          return {
            method: 'xln',
            status: 'success',
            reference: hashlock,
            timestamp: new Date(frame.timestamp).toISOString(),
          };
        }
      }
    fromHeight = page.toHeight + 1;
  }
  throw new Error('MPP_XLN_PAYMENT_NOT_RECEIVED');
};

/** Invoice access is repeatable for the same order; the application owns fulfilment idempotency. */
export const xlnMppServer = (options: XlnMppServerOptions) =>
  Method.toServer(xlnMppMethod, {
    // HMAC proves issuance, not permission for another same-priced order.
    // Bind every invoice field, including its original receipt scan boundary.
    stableBinding: request => request,
    broadcast: ({ credential }) =>
      readXlnMppReceipt(options, credential.challenge.realm, credential.challenge.request, credential.payload.hashlock),
  });
