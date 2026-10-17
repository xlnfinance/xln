import { getJurisdictionStackId, parseJurisdictionStackIdentity } from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';

type MoveCounterparty = { counterpartyId: string; label: string };
type TargetSelection = {
  self: string;
  recipient: string;
  accounts: MoveCounterparty[];
  summaries: RuntimeAdapterEntitySummary[];
  jurisdiction: { chainId?: unknown; depositoryAddress?: unknown } | undefined;
};

/** Discovery selects a destination, never signing authority or a sender's spendable Account. */
export function moveTargetCounterparties(selection: TargetSelection): MoveCounterparty[] {
  const recipient = selection.recipient.trim().toLowerCase() || selection.self;
  if (recipient === selection.self) return selection.accounts;
  const stack = getJurisdictionStackId(selection.jurisdiction);
  if (!parseJurisdictionStackIdentity(stack)) return [];
  return selection.summaries
    .filter(
      summary => summary.entityId.toLowerCase() !== recipient && getJurisdictionStackId(summary.jurisdiction) === stack,
    )
    .map(summary => ({ counterpartyId: summary.entityId.toLowerCase(), label: summary.label }));
}
