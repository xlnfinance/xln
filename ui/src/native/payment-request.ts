import type { TokenDecimals } from '@xln/core/account/tx/units';
import { parseXlnInvoice } from '@xln/frontend/lib/utils/xlnInvoice';
import { parseAmount } from '../runtime/format';
import { nativeAmountText } from './amount';
import { getJurisdictionStackId } from '@xln/core/jurisdiction/machine/jurisdiction-stack';
import type { StackJurisdiction } from '../runtime/hosted';

/** Catalog labels identify a network only when chain AND depository match. */
export function nativeInvoiceJurisdictionKeys(stackId: string, catalog: readonly StackJurisdiction[]): string[] {
  if (!stackId) return [];
  return catalog.filter(entry => getJurisdictionStackId({ chainId: entry.chainId,
    depositoryAddress: entry.contracts.depository }) === stackId).map(entry => entry.key);
}

type RequestContext = {
  defaultToken: number;
  assets: readonly { id: number; decimals: TokenDecimals }[];
  jurisdictions: readonly string[];
  decimalSeparator: unknown;
};

/** Decode the web wallet's invoice without granting spending authority. */
export function nativePaymentRequest(raw: unknown, context: RequestContext) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Invalid payment QR code.');
  const invoice = parseXlnInvoice(raw);
  if (invoice.jurisdictionId && !context.jurisdictions.includes(invoice.jurisdictionId))
    throw new Error('This invoice belongs to another network.');
  const token = invoice.tokenId ?? context.defaultToken;
  const asset = context.assets.find(asset => asset.id === token);
  if (!asset) throw new Error('The invoice asset is unavailable in this wallet.');
  if (invoice.amount && parseAmount(nativeAmountText(invoice.amount, '.'), asset.decimals) <= 0n)
    throw new Error('Amount must be greater than zero.');
  if (context.decimalSeparator !== '.' && context.decimalSeparator !== ',')
    throw new Error('Unsupported decimal separator.');
  // Match PaymentPanel's custody attribution. This note is bound to the quote;
  // dropping uid would send to the custody entity without crediting its user.
  const description = [invoice.description, invoice.recipientUserId ? `uid:${invoice.recipientUserId}` : '']
    .filter(Boolean).join(' | ');
  return {
    raw: invoice.canonicalUri,
    recipient: invoice.targetEntityId,
    token,
    tokenLocked: invoice.tokenId !== null,
    amount: invoice.amount.replace('.', context.decimalSeparator),
    description,
  };
}
