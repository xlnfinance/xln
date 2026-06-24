import { isAddress } from 'ethers';

import { parsePositiveAssetAmount } from './entity-asset-values';
import {
  canAddMoveRouteToDraft,
  getMoveRouteKey,
  isMoveRouteSupported,
  moveNeedsExternalRecipient,
  moveNeedsReserveRecipient,
  type MoveEndpoint,
} from './move-routes';

export type MoveValidationMode = 'draft' | 'broadcast';

export type MoveValidationAsset = {
  decimals: number;
} | null;

export type MoveValidationContext = {
  mode: MoveValidationMode;
  from: MoveEndpoint;
  to: MoveEndpoint;
  amountInput: string;
  executing: boolean;
  activeIsLive: boolean;
  awaitingCounterparty: boolean;
  hasSentBatch: boolean;
  sourceAccountId: string;
  targetEntityId: string;
  targetHubId: string;
  selfEntityId: string;
  selfExternalAddress: string;
  reserveRecipientEntityId: string;
  externalRecipient: string;
  reserveToken: MoveValidationAsset;
  externalToken: MoveValidationAsset;
  sourceAvailableBalance: bigint | null | undefined;
  allowanceRequired: boolean;
  allowanceLoading: boolean;
  allowanceError: string | null;
  allowanceRaw: bigint | null;
};

function validationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function getMoveValidationErrorForContext(context: MoveValidationContext): string | null {
  const routeKey = getMoveRouteKey(context.from, context.to);
  if (!isMoveRouteSupported(context.from, context.to)) {
    return 'Selected route is not available';
  }
  if (context.executing) return 'Move already in progress';
  if (!context.activeIsLive && routeKey !== 'external->external') {
    return context.mode === 'draft'
      ? 'Switch to LIVE mode to add this route to batch'
      : 'Switch to LIVE mode to submit this route';
  }
  if ((context.from === 'account' || context.to === 'account') && context.awaitingCounterparty) {
    return 'Wait for the current account settlement to finish';
  }
  if (!context.amountInput.trim()) return 'Enter amount first';
  if (context.mode === 'draft' && context.hasSentBatch) {
    return 'Wait for current batch confirmation or clear it before adding a new move';
  }
  if (context.mode === 'draft' && !canAddMoveRouteToDraft(context.from, context.to)) {
    return 'Add to batch is not available for this route';
  }

  const sourceAccountId = String(context.sourceAccountId || '').trim();
  const targetEntityId = String(context.targetEntityId || '').trim().toLowerCase();
  const targetHubId = String(context.targetHubId || '').trim().toLowerCase();
  const selfEntityId = String(context.selfEntityId || '').trim().toLowerCase();
  const selfExternalAddress = String(context.selfExternalAddress || '').trim().toLowerCase();
  const reserveRecipient = String(context.reserveRecipientEntityId || '').trim().toLowerCase();
  const externalRecipient = String(context.externalRecipient || '').trim().toLowerCase();

  if (context.from === 'account' && !sourceAccountId) return 'Select source account';
  if (context.to === 'account' && (!targetEntityId || !targetHubId)) return 'Select recipient and counterparty';
  if (moveNeedsReserveRecipient(context.from, context.to) && !reserveRecipient) return 'Select recipient entity';
  if (moveNeedsExternalRecipient(context.from, context.to) && !externalRecipient) return 'Enter recipient EOA';
  if (moveNeedsExternalRecipient(context.from, context.to) && !isAddress(externalRecipient)) {
    return 'Recipient must be a valid EOA address';
  }
  if (
    context.from === 'account' &&
    context.to === 'account' &&
    sourceAccountId &&
    targetEntityId === selfEntityId &&
    targetHubId === sourceAccountId.toLowerCase()
  ) {
    return 'Cannot transfer to same account';
  }
  if (context.from === 'reserve' && context.to === 'reserve' && reserveRecipient === selfEntityId) {
    return 'Reserve → Reserve to self is meaningless';
  }
  if (context.from === 'external' && context.to === 'external' && externalRecipient === selfExternalAddress) {
    return 'External → External to self is meaningless';
  }

  const token = context.from === 'external' && context.to === 'external'
    ? context.externalToken
    : context.reserveToken;
  if (context.from === 'external' && context.to === 'external') {
    if (!context.externalToken) return 'Select external asset first';
  } else if (!context.reserveToken) {
    return 'Select reserve-compatible asset first';
  }

  let parsedAmount: bigint;
  try {
    parsedAmount = parsePositiveAssetAmount(
      context.amountInput,
      token as { decimals: number },
      context.sourceAvailableBalance ?? undefined,
    );
  } catch (error) {
    return validationErrorMessage(error, 'Invalid move amount');
  }
  if (context.mode === 'draft' && context.allowanceRequired) {
    if (context.allowanceLoading) return 'Checking ERC20 allowance';
    if (context.allowanceError) return context.allowanceError;
    if (context.allowanceRaw === null || context.allowanceRaw < parsedAmount) {
      return 'Allow ERC20 before adding to batch';
    }
  }
  return null;
}
