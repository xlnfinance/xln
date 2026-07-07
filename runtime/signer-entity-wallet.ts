import type { EntityState, JurisdictionEvent } from './types';

type ExternalWalletSnapshotEvent = Extract<JurisdictionEvent, { type: 'ExternalWalletSnapshot' }>;
type ExternalWalletDeltaEvent = Extract<JurisdictionEvent, { type: 'ExternalWalletDelta' }>;

export const NATIVE_EXTERNAL_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const normalizeExternalWalletAddress = (value: unknown, label: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`j_event rejected: invalid external wallet ${label}`);
  }
  return normalized;
};

export const externalWalletBalanceKey = (tokenAddress: string): string => tokenAddress.toLowerCase();

export const externalWalletAllowanceKey = (tokenAddress: string, spender: string): string =>
  `${tokenAddress.toLowerCase()}:${spender.toLowerCase()}`;

const ensureNestedMap = <T>(map: Map<string, Map<string, T>>, key: string): Map<string, T> => {
  const existing = map.get(key);
  if (existing) return existing;
  const next = new Map<string, T>();
  map.set(key, next);
  return next;
};

export const isSignerEntityExternalWalletOwner = (state: EntityState, owner: string): boolean => {
  const normalizedOwner = normalizeSignerId(owner);
  return (state.config.validators || []).some((validatorId) => normalizeSignerId(validatorId) === normalizedOwner);
};

export const assertSignerEntityExternalWalletOwner = (state: EntityState, owner: string): void => {
  if (isSignerEntityExternalWalletOwner(state, owner)) return;
  throw new Error(
    `EXTERNAL_WALLET_OWNER_NOT_SIGNER entity=${String(state.entityId).slice(0, 12)} owner=${owner}`,
  );
};

export const ensureSignerEntityExternalWalletState = (
  state: EntityState,
): NonNullable<EntityState['externalWallet']> => {
  if (!state.externalWallet) {
    state.externalWallet = { balances: new Map(), allowances: new Map() };
  }
  return state.externalWallet;
};

export const applySignerEntityExternalWalletSnapshot = (
  state: EntityState,
  event: ExternalWalletSnapshotEvent,
  blockNumber: number,
  transactionHash: string,
): string => {
  const { owner, nativeBalance, tokenBalances, allowances } = event.data;
  const normalizedOwner = normalizeExternalWalletAddress(owner, 'owner');
  assertSignerEntityExternalWalletOwner(state, normalizedOwner);

  const wallet = ensureSignerEntityExternalWalletState(state);
  const balancesByToken = ensureNestedMap(wallet.balances, normalizedOwner);
  const allowancesBySpender = ensureNestedMap(wallet.allowances, normalizedOwner);
  const jHeight = Number(event.blockNumber ?? blockNumber);

  if (nativeBalance !== undefined) {
    balancesByToken.set(NATIVE_EXTERNAL_TOKEN_ADDRESS, {
      tokenAddress: NATIVE_EXTERNAL_TOKEN_ADDRESS,
      tokenId: 0,
      balance: BigInt(nativeBalance),
      jHeight,
      transactionHash,
    });
  }

  for (const entry of tokenBalances ?? []) {
    const tokenAddress = normalizeExternalWalletAddress(entry.tokenAddress, 'tokenAddress');
    const tokenId = typeof entry.tokenId === 'number' && Number.isInteger(entry.tokenId) && entry.tokenId >= 0
      ? entry.tokenId
      : undefined;
    balancesByToken.set(externalWalletBalanceKey(tokenAddress), {
      tokenAddress,
      ...(tokenId !== undefined ? { tokenId } : {}),
      balance: BigInt(entry.balance),
      jHeight,
      transactionHash,
    });
  }

  for (const entry of allowances ?? []) {
    const tokenAddress = normalizeExternalWalletAddress(entry.tokenAddress, 'tokenAddress');
    const spender = normalizeExternalWalletAddress(entry.spender, 'spender');
    allowancesBySpender.set(externalWalletAllowanceKey(tokenAddress, spender), {
      tokenAddress,
      spender,
      allowance: BigInt(entry.allowance),
      jHeight,
      transactionHash,
    });
  }

  return normalizedOwner;
};

export const applySignerEntityExternalWalletDelta = (
  state: EntityState,
  event: ExternalWalletDeltaEvent,
  blockNumber: number,
  transactionHash: string,
): string => {
  const { entityId, owner, tokenAddress, tokenId, balanceDelta, spender, allowance } = event.data;
  const normalizedOwner = normalizeExternalWalletAddress(owner, 'owner');
  assertSignerEntityExternalWalletOwner(state, normalizedOwner);

  const normalizedToken = normalizeExternalWalletAddress(tokenAddress, 'tokenAddress');
  const wallet = state.externalWallet;
  const balancesByToken = wallet?.balances.get(normalizedOwner);
  const allowancesBySpender = wallet?.allowances.get(normalizedOwner);
  const jHeight = Number(event.blockNumber ?? blockNumber);

  if (balanceDelta !== undefined) {
    const tokenKey = externalWalletBalanceKey(normalizedToken);
    const current = balancesByToken?.get(tokenKey);
    if (!current) {
      throw new Error(
        `EXTERNAL_WALLET_BASELINE_MISSING:balance entity=${String(entityId).slice(0, 12)} owner=${normalizedOwner} token=${normalizedToken}`,
      );
    }
    const nextBalance = current.balance + BigInt(balanceDelta);
    if (nextBalance < 0n) {
      throw new Error(
        `EXTERNAL_WALLET_BALANCE_UNDERFLOW entity=${String(entityId).slice(0, 12)} owner=${normalizedOwner} token=${normalizedToken}`,
      );
    }
    const nextTokenId = typeof tokenId === 'number' && Number.isInteger(tokenId) && tokenId >= 0
      ? tokenId
      : current.tokenId;
    balancesByToken!.set(tokenKey, {
      tokenAddress: normalizedToken,
      ...(nextTokenId !== undefined ? { tokenId: nextTokenId } : {}),
      balance: nextBalance,
      jHeight,
      transactionHash,
    });
  }

  if (allowance !== undefined || spender !== undefined) {
    const normalizedSpender = normalizeExternalWalletAddress(spender, 'spender');
    const allowanceKey = externalWalletAllowanceKey(normalizedToken, normalizedSpender);
    const current = allowancesBySpender?.get(allowanceKey);
    if (!current) {
      throw new Error(
        `EXTERNAL_WALLET_BASELINE_MISSING:allowance entity=${String(entityId).slice(0, 12)} owner=${normalizedOwner} token=${normalizedToken} spender=${normalizedSpender}`,
      );
    }
    allowancesBySpender!.set(allowanceKey, {
      tokenAddress: normalizedToken,
      spender: normalizedSpender,
      allowance: allowance !== undefined ? BigInt(allowance) : current.allowance,
      jHeight,
      transactionHash,
    });
  }

  return normalizedOwner;
};
