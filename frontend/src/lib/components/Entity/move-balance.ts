import type { MoveEndpoint } from './move-routes';

export type MoveBalanceRow = {
  externalBalance: bigint;
  reserveBalance: bigint;
  accountBalance: bigint;
} | null;

export type MoveReserveToken = { tokenId: number } | null;
export type MoveExternalToken = { balance: bigint } | null;

export function getMoveMaxAmountForEndpoint(input: {
  from: MoveEndpoint;
  reserveToken: MoveReserveToken;
  externalToken: MoveExternalToken;
  sourceAccountId: string;
  reserveBalance: (tokenId: number) => bigint;
  draftReserveDelta: (tokenId: number) => bigint;
  outgoingDebt: (tokenId: number) => bigint;
  accountSpendable: (sourceAccountId: string, tokenId: number) => bigint;
}): bigint | null {
  switch (input.from) {
    case 'external':
      return input.externalToken?.balance ?? 0n;
    case 'reserve': {
      if (!input.reserveToken) return 0n;
      const tokenId = input.reserveToken.tokenId;
      const effective = input.reserveBalance(tokenId) + input.draftReserveDelta(tokenId);
      const debt = input.outgoingDebt(tokenId);
      return effective > debt ? effective - debt : 0n;
    }
    case 'account':
      return input.reserveToken && input.sourceAccountId
        ? input.accountSpendable(input.sourceAccountId, input.reserveToken.tokenId)
        : 0n;
    default:
      return null;
  }
}

export function getPreferredMoveSourceAccountId(input: {
  current: string;
  workspaceAccountIds: readonly string[];
  tokenId: number;
  requestedAmount: bigint;
  accountSpendable: (sourceAccountId: string, tokenId: number) => bigint;
}): string {
  const current = String(input.current || '').trim();
  const currentAvailable = current ? input.accountSpendable(current, input.tokenId) : 0n;
  if (current && input.workspaceAccountIds.includes(current)) {
    if (input.requestedAmount > 0n && currentAvailable >= input.requestedAmount) return current;
    if (input.requestedAmount <= 0n && currentAvailable > 0n) return current;
  }
  return (
    (input.requestedAmount > 0n
      ? input.workspaceAccountIds.find((id) => input.accountSpendable(id, input.tokenId) >= input.requestedAmount)
      : '')
    || input.workspaceAccountIds.find((id) => input.accountSpendable(id, input.tokenId) > 0n)
    || current
    || input.workspaceAccountIds[0]
    || ''
  );
}

export function computeMoveSourceAvailableBalanceForEndpoint(input: {
  from: MoveEndpoint;
  row: MoveBalanceRow;
  liveTransferToken: MoveReserveToken;
  externalToken: MoveExternalToken;
  reserveBalance: (tokenId: number) => bigint;
  draftReserveDelta: (tokenId: number) => bigint;
  outgoingDebt: (tokenId: number) => bigint;
  sourceAccountId: string;
  accountSpendable: (sourceAccountId: string, tokenId: number) => bigint;
}): bigint {
  switch (input.from) {
    case 'external':
      return input.row?.externalBalance ?? input.externalToken?.balance ?? 0n;
    case 'reserve': {
      if (!input.liveTransferToken) return input.row?.reserveBalance ?? 0n;
      const tokenId = input.liveTransferToken.tokenId;
      const baseReserve = input.row?.reserveBalance ?? input.reserveBalance(tokenId);
      const effective = baseReserve + input.draftReserveDelta(tokenId);
      const debt = input.outgoingDebt(tokenId);
      return effective > debt ? effective - debt : 0n;
    }
    case 'account':
      return input.liveTransferToken && input.sourceAccountId
        ? input.accountSpendable(input.sourceAccountId, input.liveTransferToken.tokenId)
        : input.row?.accountBalance ?? 0n;
    default:
      return 0n;
  }
}

export function choosePreferredMoveAssetSymbol(input: {
  candidates: readonly { symbol: string }[];
  preferredSymbol?: string;
  availableBalance: (symbol: string) => bigint | null | undefined;
}): string {
  const preferredSymbol = String(input.preferredSymbol || 'USDC').trim().toUpperCase();
  const preferred = input.candidates.find((token) => String(token.symbol || '').trim().toUpperCase() === preferredSymbol);
  if (preferred) return preferred.symbol;
  const withBalance = input.candidates.find((token) => (input.availableBalance(token.symbol) ?? 0n) > 0n);
  return withBalance?.symbol ?? input.candidates[0]?.symbol ?? '';
}
