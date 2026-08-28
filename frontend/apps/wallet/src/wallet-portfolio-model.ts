import { normalizeEntityIdForRuntimeView } from '../../../packages/runtime-client/src/runtime-view-model';

export type WalletPortfolioDelta = Readonly<{
  tokenId: number;
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowance: bigint;
  rightAllowance: bigint;
  leftHold: bigint;
  rightHold: bigint;
}>;

type WalletDerivedDelta = Readonly<{
  collateral: bigint;
  outCapacity: bigint;
  inCapacity: bigint;
  ownCreditLimit: bigint;
  peerCreditLimit: bigint;
}>;

export type WalletPortfolioMath = Readonly<{
  deriveDelta: (delta: WalletPortfolioDelta, isLeft: boolean) => WalletDerivedDelta;
  formatTokenAmount: (tokenId: number, amount: bigint) => string;
  getTokenInfo: (tokenId: number) => Readonly<{ symbol: string; name: string }>;
  isLeftEntity: (entityId: string, counterpartyId: string) => boolean;
}>;

export type WalletPortfolioEntity = Readonly<{
  entityId: string;
  label: string;
  height: number;
  isHub: boolean;
}>;

export type WalletPortfolioPosition = Readonly<{
  tokenId: number;
  symbol: string;
  spendable: bigint;
  spendableLabel: string;
  inboundCapacity: bigint;
  inboundCapacityLabel: string;
  collateral: bigint;
  collateralLabel: string;
  ownCreditLimit: bigint;
  ownCreditLimitLabel: string;
  peerCreditLimit: bigint;
  peerCreditLimitLabel: string;
}>;

export type WalletPortfolioAccount = Readonly<{
  counterpartyId: string;
  counterpartyLabel: string;
  positions: readonly WalletPortfolioPosition[];
}>;

export type WalletPortfolioAsset = Readonly<{
  tokenId: number;
  symbol: string;
  reserve: bigint;
  reserveLabel: string;
  accountSpendable: bigint;
  accountSpendableLabel: string;
  accountInboundCapacity: bigint;
  accountInboundCapacityLabel: string;
  accountCount: number;
}>;

export type WalletPortfolioProjection = Readonly<{
  height: number;
  entities: readonly WalletPortfolioEntity[];
  activeEntityId: string;
  activeEntityLabel: string;
  assets: readonly WalletPortfolioAsset[];
  accounts: readonly WalletPortfolioAccount[];
  accountsPage: number;
  accountsPageCount: number;
  accountsTotal: number;
}>;

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_INVALID`);
  return value.trim();
};

const requireInteger = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}_INVALID`);
  return Number(value);
};

const optionalInteger = (value: unknown, fallback: number, label: string): number =>
  value === undefined ? fallback : requireInteger(value, label);

const requireBigInt = (value: unknown, label: string): bigint => {
  if (typeof value !== 'bigint') throw new Error(`${label}_INVALID`);
  return value;
};

const requireMap = (value: unknown, label: string): ReadonlyMap<unknown, unknown> => {
  if (!(value instanceof Map)) throw new Error(`${label}_INVALID`);
  return value;
};

const normalizeRequiredEntityId = (value: unknown, label: string): string => {
  const normalized = normalizeEntityIdForRuntimeView(requireString(value, label));
  if (!normalized) throw new Error(`${label}_INVALID`);
  return normalized;
};

const decodeDelta = (value: unknown, tokenId: number): WalletPortfolioDelta => {
  const root = requireRecord(value, 'WALLET_PORTFOLIO_DELTA');
  const payloadTokenId = requireInteger(root['tokenId'], 'WALLET_PORTFOLIO_DELTA_TOKEN', 1);
  if (payloadTokenId !== tokenId) throw new Error('WALLET_PORTFOLIO_DELTA_TOKEN_MISMATCH');
  return {
    tokenId,
    collateral: requireBigInt(root['collateral'], 'WALLET_PORTFOLIO_DELTA_COLLATERAL'),
    ondelta: requireBigInt(root['ondelta'], 'WALLET_PORTFOLIO_DELTA_ONDELTA'),
    offdelta: requireBigInt(root['offdelta'], 'WALLET_PORTFOLIO_DELTA_OFFDELTA'),
    leftCreditLimit: requireBigInt(root['leftCreditLimit'], 'WALLET_PORTFOLIO_DELTA_LEFT_CREDIT'),
    rightCreditLimit: requireBigInt(root['rightCreditLimit'], 'WALLET_PORTFOLIO_DELTA_RIGHT_CREDIT'),
    leftAllowance: requireBigInt(root['leftAllowance'], 'WALLET_PORTFOLIO_DELTA_LEFT_ALLOWANCE'),
    rightAllowance: requireBigInt(root['rightAllowance'], 'WALLET_PORTFOLIO_DELTA_RIGHT_ALLOWANCE'),
    leftHold: requireBigInt(root['leftHold'], 'WALLET_PORTFOLIO_DELTA_LEFT_HOLD'),
    rightHold: requireBigInt(root['rightHold'], 'WALLET_PORTFOLIO_DELTA_RIGHT_HOLD'),
  };
};

const decodeEntity = (value: unknown): WalletPortfolioEntity => {
  const root = requireRecord(value, 'WALLET_PORTFOLIO_ENTITY');
  return {
    entityId: normalizeRequiredEntityId(root['entityId'], 'WALLET_PORTFOLIO_ENTITY_ID'),
    label: requireString(root['label'], 'WALLET_PORTFOLIO_ENTITY_LABEL'),
    height: requireInteger(root['height'], 'WALLET_PORTFOLIO_ENTITY_HEIGHT'),
    isHub: root['isHub'] === true,
  };
};

const decodePosition = (
  tokenIdValue: unknown,
  deltaValue: unknown,
  isLeft: boolean,
  math: WalletPortfolioMath,
): WalletPortfolioPosition => {
  const tokenId = requireInteger(tokenIdValue, 'WALLET_PORTFOLIO_TOKEN_ID', 1);
  const derived = math.deriveDelta(decodeDelta(deltaValue, tokenId), isLeft);
  const token = math.getTokenInfo(tokenId);
  return {
    tokenId,
    symbol: token.symbol,
    spendable: derived.outCapacity,
    spendableLabel: math.formatTokenAmount(tokenId, derived.outCapacity),
    inboundCapacity: derived.inCapacity,
    inboundCapacityLabel: math.formatTokenAmount(tokenId, derived.inCapacity),
    collateral: derived.collateral,
    collateralLabel: math.formatTokenAmount(tokenId, derived.collateral),
    ownCreditLimit: derived.ownCreditLimit,
    ownCreditLimitLabel: math.formatTokenAmount(tokenId, derived.ownCreditLimit),
    peerCreditLimit: derived.peerCreditLimit,
    peerCreditLimitLabel: math.formatTokenAmount(tokenId, derived.peerCreditLimit),
  };
};

const decodeAccount = (
  value: unknown,
  activeEntityId: string,
  entityLabels: ReadonlyMap<string, string>,
  math: WalletPortfolioMath,
): WalletPortfolioAccount => {
  const root = requireRecord(value, 'WALLET_PORTFOLIO_ACCOUNT');
  const state = requireRecord(root['state'], 'WALLET_PORTFOLIO_ACCOUNT_STATE');
  const leftEntity = normalizeRequiredEntityId(state['leftEntity'], 'WALLET_PORTFOLIO_ACCOUNT_LEFT');
  const rightEntity = normalizeRequiredEntityId(state['rightEntity'], 'WALLET_PORTFOLIO_ACCOUNT_RIGHT');
  if (activeEntityId !== leftEntity && activeEntityId !== rightEntity) {
    throw new Error('WALLET_PORTFOLIO_ACCOUNT_PERSPECTIVE_MISMATCH');
  }
  const counterpartyId = activeEntityId === leftEntity ? rightEntity : leftEntity;
  const isLeft = math.isLeftEntity(activeEntityId, counterpartyId);
  if (isLeft !== (activeEntityId === leftEntity)) {
    throw new Error('WALLET_PORTFOLIO_ACCOUNT_ROLE_MISMATCH');
  }
  const deltas = requireMap(state['deltas'], 'WALLET_PORTFOLIO_ACCOUNT_DELTAS');
  const positions = [...deltas.entries()]
    .map(([tokenId, delta]) => decodePosition(tokenId, delta, isLeft, math))
    .sort((left, right) => left.tokenId - right.tokenId);
  return {
    counterpartyId,
    counterpartyLabel: entityLabels.get(counterpartyId) ?? counterpartyId,
    positions,
  };
};

type AssetAccumulator = {
  reserve: bigint;
  accountSpendable: bigint;
  accountInboundCapacity: bigint;
  accountIds: Set<string>;
};

const accumulateAssets = (
  reserves: ReadonlyMap<unknown, unknown>,
  accounts: readonly WalletPortfolioAccount[],
  math: WalletPortfolioMath,
): readonly WalletPortfolioAsset[] => {
  const totals = new Map<number, AssetAccumulator>();
  const read = (tokenId: number): AssetAccumulator => {
    const current = totals.get(tokenId) ?? {
      reserve: 0n,
      accountSpendable: 0n,
      accountInboundCapacity: 0n,
      accountIds: new Set<string>(),
    };
    totals.set(tokenId, current);
    return current;
  };
  for (const [tokenIdValue, reserveValue] of reserves.entries()) {
    const tokenId = requireInteger(tokenIdValue, 'WALLET_PORTFOLIO_RESERVE_TOKEN', 1);
    read(tokenId).reserve = requireBigInt(reserveValue, 'WALLET_PORTFOLIO_RESERVE_AMOUNT');
  }
  for (const account of accounts) {
    for (const position of account.positions) {
      const total = read(position.tokenId);
      total.accountSpendable += position.spendable;
      total.accountInboundCapacity += position.inboundCapacity;
      total.accountIds.add(account.counterpartyId);
    }
  }
  return [...totals.entries()].sort(([left], [right]) => left - right).map(([tokenId, total]) => ({
    tokenId,
    symbol: math.getTokenInfo(tokenId).symbol,
    reserve: total.reserve,
    reserveLabel: math.formatTokenAmount(tokenId, total.reserve),
    accountSpendable: total.accountSpendable,
    accountSpendableLabel: math.formatTokenAmount(tokenId, total.accountSpendable),
    accountInboundCapacity: total.accountInboundCapacity,
    accountInboundCapacityLabel: math.formatTokenAmount(tokenId, total.accountInboundCapacity),
    accountCount: total.accountIds.size,
  }));
};

export const decodeWalletPortfolioProjection = (
  payload: unknown,
  math: WalletPortfolioMath,
): WalletPortfolioProjection => {
  const root = requireRecord(payload, 'WALLET_PORTFOLIO_FRAME');
  const height = requireInteger(root['height'], 'WALLET_PORTFOLIO_HEIGHT');
  const entitiesRaw = root['entities'];
  if (!Array.isArray(entitiesRaw)) throw new Error('WALLET_PORTFOLIO_ENTITIES_INVALID');
  const entities = entitiesRaw.map(decodeEntity);
  if (root['activeEntityId'] === null && root['activeEntity'] === null) {
    return {
      height,
      entities,
      activeEntityId: '',
      activeEntityLabel: '',
      assets: [],
      accounts: [],
      accountsPage: 0,
      accountsPageCount: 0,
      accountsTotal: 0,
    };
  }
  const entityLabels = new Map(entities.map((entity) => [entity.entityId, entity.label]));
  const activeEntityId = normalizeRequiredEntityId(root['activeEntityId'], 'WALLET_PORTFOLIO_ACTIVE_ID');
  const active = requireRecord(root['activeEntity'], 'WALLET_PORTFOLIO_ACTIVE_ENTITY');
  const core = requireRecord(active['core'], 'WALLET_PORTFOLIO_ACTIVE_CORE');
  const coreEntityId = normalizeRequiredEntityId(core['entityId'], 'WALLET_PORTFOLIO_CORE_ID');
  if (coreEntityId !== activeEntityId) throw new Error('WALLET_PORTFOLIO_ACTIVE_ID_MISMATCH');
  const page = requireRecord(active['accounts'], 'WALLET_PORTFOLIO_ACCOUNTS_PAGE');
  const items = page['items'];
  if (!Array.isArray(items)) throw new Error('WALLET_PORTFOLIO_ACCOUNT_ITEMS_INVALID');
  const accounts = items.map((account) => decodeAccount(account, activeEntityId, entityLabels, math));
  const reserves = requireMap(core['reserves'], 'WALLET_PORTFOLIO_RESERVES');
  return {
    height,
    entities,
    activeEntityId,
    activeEntityLabel: entityLabels.get(activeEntityId) ?? activeEntityId,
    assets: accumulateAssets(reserves, accounts, math),
    accounts,
    accountsPage: optionalInteger(page['pageIndex'], 0, 'WALLET_PORTFOLIO_ACCOUNT_PAGE'),
    accountsPageCount: optionalInteger(page['pageCount'], items.length > 0 ? 1 : 0, 'WALLET_PORTFOLIO_ACCOUNT_PAGE_COUNT'),
    accountsTotal: optionalInteger(page['totalItems'], items.length, 'WALLET_PORTFOLIO_ACCOUNT_TOTAL'),
  };
};
