import type { ParsedXlnInvoice } from '$lib/utils/xlnInvoice';
import { isFullEntityId } from '../../../frontend/src/lib/components/Entity/workspace/entity-panel-options';

/** Names are discovery hints, never the identity of a picked recipient. */
export function resolvePayRecipient(
  text: string,
  pickedEntityId: string | null,
  known: readonly { entityId: string; label: string }[],
): { target: string; ambiguous: boolean } {
  if (pickedEntityId) return { target: pickedEntityId.toLowerCase(), ambiguous: false };
  const query = text.trim().toLowerCase();
  if (isFullEntityId(query)) return { target: query, ambiguous: false };
  const matches = new Set(
    known.filter(entry => query && entry.label.toLowerCase() === query).map(entry => entry.entityId),
  );
  return { target: matches.size === 1 ? [...matches][0]! : '', ambiguous: matches.size > 1 };
}

/** Keep the PaymentPanel invoice attribution and note-lock semantics. */
export function invoiceNote(invoice: ParsedXlnInvoice, activeJurisdiction?: string): { description: string; locked: boolean } {
  // Token ids and the recipient are meaningful only inside the active jurisdiction.
  if (invoice.jurisdictionId && invoice.jurisdictionId !== activeJurisdiction) {
    throw new Error('Invoice jurisdiction does not match the active jurisdiction');
  }
  const parts: string[] = [];
  if (invoice.description) parts.push(invoice.description);
  if (invoice.recipientUserId) parts.push(`uid:${invoice.recipientUserId}`);
  return {
    description: parts.join(' | '),
    locked: invoice.noteLocked || Boolean(invoice.description) || Boolean(invoice.recipientUserId),
  };
}
