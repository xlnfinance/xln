import { compareStableText } from '../protocol/serialization';
import type { JurisdictionEvent } from '../types';
import {
  decodeFields,
  defineEventNormalizer,
  normalizeAddress,
  normalizeBigNumberish,
  normalizeEntity,
  normalizeInt,
  toRecord,
  type JurisdictionEventNormalizer,
} from './event-normalization-primitives';

type TokenBalance = {
  tokenAddress: string;
  tokenId?: number;
  balance: string;
};

const tokenBalances = (value: unknown): TokenBalance[] | null => {
  const balances: TokenBalance[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = toRecord(raw);
    if (!entry) return null;
    const decoded = decodeFields(entry, {
      tokenAddress: normalizeAddress,
      balance: normalizeBigNumberish,
    });
    if (!decoded) return null;
    const tokenId = normalizeInt(entry['tokenId']);
    balances.push({ ...decoded, ...(tokenId !== null ? { tokenId } : {}) });
  }
  return balances.sort((left, right) =>
    compareStableText(left.tokenAddress, right.tokenAddress) ||
    (left.tokenId ?? -1) - (right.tokenId ?? -1) ||
    compareStableText(left.balance, right.balance));
};

type Allowance = {
  tokenAddress: string;
  spender: string;
  allowance: string;
};

const allowances = (value: unknown): Allowance[] | null => {
  const normalized: Allowance[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = toRecord(raw);
    if (!entry) return null;
    const decoded = decodeFields(entry, {
      tokenAddress: normalizeAddress,
      spender: normalizeAddress,
      allowance: normalizeBigNumberish,
    });
    if (!decoded) return null;
    normalized.push(decoded);
  }
  return normalized.sort((left, right) =>
    compareStableText(left.tokenAddress, right.tokenAddress) ||
    compareStableText(left.spender, right.spender) ||
    compareStableText(left.allowance, right.allowance));
};

const walletSnapshot = defineEventNormalizer('ExternalWalletSnapshot', data => {
  const base = decodeFields(data, {
    entityId: normalizeEntity,
    owner: normalizeAddress,
    tokenBalances,
    allowances,
  });
  const nativeBalance = data['nativeBalance'] === undefined
    ? null
    : normalizeBigNumberish(data['nativeBalance']);
  if (!base || (data['nativeBalance'] !== undefined && nativeBalance === null)) {
    return null;
  }
  return {
    entityId: base.entityId,
    owner: base.owner,
    ...(nativeBalance !== null ? { nativeBalance } : {}),
    ...(base.tokenBalances.length ? { tokenBalances: base.tokenBalances } : {}),
    ...(base.allowances.length ? { allowances: base.allowances } : {}),
  };
});

const walletDelta = defineEventNormalizer('ExternalWalletDelta', data => {
  const base = decodeFields(data, {
    entityId: normalizeEntity,
    owner: normalizeAddress,
    tokenAddress: normalizeAddress,
  });
  if (!base) return null;
  const tokenId = normalizeInt(data['tokenId']);
  const balanceDelta = data['balanceDelta'] === undefined
    ? null
    : normalizeBigNumberish(data['balanceDelta']);
  const spender = data['spender'] === undefined
    ? null
    : normalizeAddress(data['spender']);
  const allowance = data['allowance'] === undefined
    ? null
    : normalizeBigNumberish(data['allowance']);
  const hasBalance = data['balanceDelta'] !== undefined;
  const hasAllowance =
    data['allowance'] !== undefined || data['spender'] !== undefined;
  if (
    (hasBalance && balanceDelta === null) ||
    (hasAllowance && (!spender || allowance === null)) ||
    (!hasBalance && !hasAllowance)
  ) {
    return null;
  }
  return {
    ...base,
    ...(tokenId !== null ? { tokenId } : {}),
    ...(balanceDelta !== null ? { balanceDelta } : {}),
    ...(spender && allowance !== null ? { spender, allowance } : {}),
  };
});

export const walletEventNormalizers: Readonly<
  Pick<
    Record<JurisdictionEvent['type'], JurisdictionEventNormalizer>,
    'ExternalWalletSnapshot' | 'ExternalWalletDelta'
  >
> = {
  ExternalWalletSnapshot: walletSnapshot,
  ExternalWalletDelta: walletDelta,
};
