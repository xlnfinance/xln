export type SwapRequestIdentityInput = Readonly<{
  frameHeight: number;
  sourceEntityId: string;
  sourceAccountHeight: number;
  sourceHubEntityId: string;
  mode: 'same' | 'cross';
  targetEntityId: string | null;
  targetAccountHeight: number | null;
  targetHubEntityId: string | null;
  giveTokenId: number;
  wantTokenId: number;
  giveAmountRaw: bigint;
  priceTicks: bigint;
  routeValue: string;
}>;

export type SwapRequestTicket = Readonly<{
  sequence: number;
  identity: string;
}>;

export const createSwapDraftIdentity = (input: Readonly<{
  frameHeight: number;
  routeValue: string;
  giveTokenId: number;
  wantTokenId: number;
  amountInput: string;
  priceTicksInput: string;
}>): string => {
  const frameHeight = positiveInteger(input.frameHeight, 'WALLET_SWAP_DRAFT_FRAME_HEIGHT_INVALID');
  const routeValue = id(input.routeValue, 'WALLET_SWAP_DRAFT_ROUTE_MISSING');
  const giveTokenId = positiveInteger(input.giveTokenId, 'WALLET_SWAP_DRAFT_GIVE_TOKEN_INVALID');
  const wantTokenId = positiveInteger(input.wantTokenId, 'WALLET_SWAP_DRAFT_WANT_TOKEN_INVALID');
  const amountInput = input.amountInput.trim();
  const priceTicksInput = input.priceTicksInput.trim();
  if (!amountInput) throw new Error('WALLET_SWAP_DRAFT_AMOUNT_MISSING');
  if (!priceTicksInput) throw new Error('WALLET_SWAP_DRAFT_PRICE_MISSING');
  return ['swap-draft-v1', frameHeight, routeValue, giveTokenId, wantTokenId, amountInput, priceTicksInput]
    .map(value => encodeURIComponent(String(value)))
    .join('|');
};

const id = (value: string | null, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) throw new Error(code);
  return normalized;
};

const positiveInteger = (value: number | null, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
};

export const createSwapRequestIdentity = (input: SwapRequestIdentityInput): string => {
  const frameHeight = positiveInteger(input.frameHeight, 'WALLET_SWAP_FRAME_HEIGHT_INVALID');
  const sourceAccountHeight = positiveInteger(input.sourceAccountHeight, 'WALLET_SWAP_SOURCE_ACCOUNT_HEIGHT_INVALID');
  const giveTokenId = positiveInteger(input.giveTokenId, 'WALLET_SWAP_GIVE_TOKEN_INVALID');
  const wantTokenId = positiveInteger(input.wantTokenId, 'WALLET_SWAP_WANT_TOKEN_INVALID');
  if (input.giveAmountRaw <= 0n) throw new Error('WALLET_SWAP_GIVE_AMOUNT_INVALID');
  if (input.priceTicks <= 0n) throw new Error('WALLET_SWAP_PRICE_TICKS_INVALID');
  const sourceEntityId = id(input.sourceEntityId, 'WALLET_SWAP_SOURCE_ENTITY_ID_MISSING');
  const sourceHubEntityId = id(input.sourceHubEntityId, 'WALLET_SWAP_SOURCE_HUB_ID_MISSING');
  const routeValue = id(input.routeValue, 'WALLET_SWAP_ROUTE_VALUE_MISSING');
  const target = input.mode === 'cross'
    ? [
        id(input.targetEntityId, 'WALLET_SWAP_TARGET_ENTITY_ID_MISSING'),
        input.targetAccountHeight === null
          ? 'account-missing'
          : positiveInteger(input.targetAccountHeight, 'WALLET_SWAP_TARGET_ACCOUNT_HEIGHT_INVALID'),
        id(input.targetHubEntityId, 'WALLET_SWAP_TARGET_HUB_ID_MISSING'),
      ]
    : ['-', '-', '-'];
  return [
    'swap-request-v1',
    frameHeight,
    sourceEntityId,
    sourceAccountHeight,
    sourceHubEntityId,
    input.mode,
    ...target,
    giveTokenId,
    wantTokenId,
    input.giveAmountRaw.toString(),
    input.priceTicks.toString(),
    routeValue,
  ].map(value => encodeURIComponent(String(value))).join('|');
};

export const createSwapRequestCoordinator = () => {
  let sequence = 0;
  let currentIdentity: string | null = null;
  return Object.freeze({
    begin: (identity: string): SwapRequestTicket => {
      const normalized = identity.trim();
      if (!normalized) throw new Error('WALLET_SWAP_REQUEST_IDENTITY_MISSING');
      currentIdentity = normalized;
      sequence += 1;
      return Object.freeze({ sequence, identity: normalized });
    },
    accepts: (ticket: SwapRequestTicket, visibleIdentity: string): boolean =>
      ticket.sequence === sequence && ticket.identity === currentIdentity && ticket.identity === visibleIdentity,
    invalidate: (): void => {
      currentIdentity = null;
      sequence += 1;
    },
  });
};

export const assertSwapConfirmationCurrent = (
  confirmationIdentity: string,
  visibleIdentity: string,
): void => {
  if (!confirmationIdentity || confirmationIdentity !== visibleIdentity) {
    throw new Error('WALLET_SWAP_CONFIRMATION_STALE');
  }
};
