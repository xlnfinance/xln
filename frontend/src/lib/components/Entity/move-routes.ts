export type MoveEndpoint = 'external' | 'reserve' | 'account';

export type MoveRouteKey = `${MoveEndpoint}->${MoveEndpoint}`;

export const MOVE_ENDPOINT_LABEL: Record<MoveEndpoint, string> = {
  external: 'External',
  reserve: 'Reserve',
  account: 'Account',
};

export const MOVE_ENDPOINTS: MoveEndpoint[] = ['external', 'reserve', 'account'];

export function getMoveRouteKey(from: MoveEndpoint, to: MoveEndpoint): MoveRouteKey {
  return `${from}->${to}`;
}

export function isMoveRouteSupported(from: MoveEndpoint, to: MoveEndpoint): boolean {
  switch (getMoveRouteKey(from, to)) {
    case 'external->external':
    case 'external->reserve':
    case 'external->account':
    case 'reserve->external':
    case 'reserve->reserve':
    case 'reserve->account':
    case 'account->external':
    case 'account->reserve':
    case 'account->account':
      return true;
    default:
      return false;
  }
}

export function canAddMoveRouteToDraft(from: MoveEndpoint, to: MoveEndpoint): boolean {
  return isMoveRouteSupported(from, to) && getMoveRouteKey(from, to) !== 'external->external';
}

export function routeRequiresExplicitExternalAllowance(from: MoveEndpoint, to: MoveEndpoint): boolean {
  const routeKey = getMoveRouteKey(from, to);
  return routeKey === 'external->reserve' || routeKey === 'external->account';
}

export function isExternalTransferMoveRoute(from: MoveEndpoint, to: MoveEndpoint): boolean {
  return getMoveRouteKey(from, to) === 'external->external';
}

export function isImmediateMoveExecutionRoute(from: MoveEndpoint, to: MoveEndpoint): boolean {
  return isExternalTransferMoveRoute(from, to);
}

export function getMovePrimaryActionLabel(from: MoveEndpoint, to: MoveEndpoint): string {
  return isExternalTransferMoveRoute(from, to) ? 'Send Direct' : 'Add to Batch';
}

export function moveNeedsExternalRecipient(_from: MoveEndpoint, to: MoveEndpoint): boolean {
  return to === 'external';
}

export function moveNeedsReserveRecipient(_from: MoveEndpoint, to: MoveEndpoint): boolean {
  return to === 'reserve';
}

export function buildMoveArrowPath(
  start: { x: number; y: number } | null,
  end: { x: number; y: number } | null,
): string {
  if (!start || !end) return '';
  const distance = Math.abs(end.x - start.x);
  const curve = Math.max(22, Math.min(68, distance * 0.2));
  const control1X = start.x + curve;
  const control2X = end.x - curve;
  return `M ${start.x} ${start.y} C ${control1X} ${start.y} ${control2X} ${end.y} ${end.x} ${end.y}`;
}

export type MoveRouteTextContext = {
  targetEntityLabel: string;
  targetHubLabel: string;
  reserveRecipientLabel: string;
  hasRemoteReserveRecipient: boolean;
};

export function buildMoveRouteSteps(
  from: MoveEndpoint,
  to: MoveEndpoint,
  context: MoveRouteTextContext,
): string[] {
  switch (getMoveRouteKey(from, to)) {
    case 'external->reserve':
      return context.hasRemoteReserveRecipient
        ? [
          '1. Approve Depository from your wallet if needed',
          '2. Deposit from your wallet into reserve',
          `3. Forward reserve to ${context.reserveRecipientLabel}`,
        ]
        : [
          '1. Approve Depository from your wallet if needed',
          '2. Deposit from your wallet into reserve',
        ];
    case 'reserve->reserve':
      return [`1. Send reserve batch to ${context.reserveRecipientLabel}`];
    case 'reserve->account':
      return [`1. Fund ${context.targetEntityLabel} through ${context.targetHubLabel}`];
    case 'account->reserve':
      return context.hasRemoteReserveRecipient
        ? [
          '1. Settle funds back into your reserve',
          `2. Forward reserve to ${context.reserveRecipientLabel}`,
        ]
        : ['1. Settle funds back into your reserve'];
    case 'reserve->external':
      return ['1. Withdraw reserve to recipient wallet'];
    case 'external->external':
      return ['1. Send directly from wallet to wallet'];
    case 'external->account':
      return [
        '1. Approve Depository from your wallet if needed',
        '2. Deposit from your wallet into reserve',
        `3. Fund ${context.targetEntityLabel} through ${context.targetHubLabel}`,
      ];
    case 'account->external':
      return [
        '1. Settle funds back into your reserve',
        '2. Withdraw reserve to recipient wallet',
      ];
    case 'account->account':
      return [
        '1. Settle funds back into your reserve',
        `2. Fund ${context.targetEntityLabel} through ${context.targetHubLabel}`,
      ];
    default:
      return ['Route not available'];
  }
}
