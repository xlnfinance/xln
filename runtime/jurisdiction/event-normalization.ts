import type { JurisdictionEvent } from '../types';
import { compareStableText, safeStringify } from '../serialization-utils';

const BIGINT_WRAPPER_RE = /^BigInt\((-?\d+)\)$/;

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const normalizeEntity = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
};

const normalizeAddress = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) return null;
  return trimmed;
};

const normalizeBigNumberish = (value: unknown): string | null => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const wrapped = BIGINT_WRAPPER_RE.exec(trimmed);
    if (wrapped) return BigInt(wrapped[1]!).toString();
    if (/^-?\d+$/.test(trimmed)) return BigInt(trimmed).toString();
  }
  return null;
};

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    return value;
  }
  const asBigint = normalizeBigNumberish(value);
  if (asBigint === null) return null;
  const n = Number(asBigint);
  if (!Number.isSafeInteger(n)) return null;
  return n;
};

const normalizeMetadata = (raw: Record<string, unknown>) => {
  const out: Pick<JurisdictionEvent, 'blockNumber' | 'blockHash' | 'transactionHash'> = {};
  if (raw['blockNumber'] !== undefined) {
    const n = normalizeInt(raw['blockNumber']);
    if (n !== null) out.blockNumber = n;
  }
  if (typeof raw['blockHash'] === 'string' && raw['blockHash'].trim()) out.blockHash = raw['blockHash'];
  if (typeof raw['transactionHash'] === 'string' && raw['transactionHash'].trim()) out.transactionHash = raw['transactionHash'];
  return out;
};

export function normalizeJurisdictionEvent(value: unknown): JurisdictionEvent | null {
  const raw = toRecord(value);
  if (!raw) return null;
  const type = typeof raw['type'] === 'string' ? raw['type'] : '';
  const data = toRecord(raw['data']);
  if (!type || !data) return null;
  const meta = normalizeMetadata(raw);

  if (type === 'ReserveUpdated') {
    const entity = normalizeEntity(data['entity']);
    const tokenId = normalizeInt(data['tokenId']);
    const newBalance = normalizeBigNumberish(data['newBalance']);
    if (!entity || tokenId === null || newBalance === null) return null;
    return { ...meta, type, data: { entity, tokenId, newBalance } };
  }

  if (type === 'ExternalWalletSnapshot') {
    const entityId = normalizeEntity(data['entityId']);
    const owner = normalizeAddress(data['owner']);
    if (!entityId || !owner) return null;
    const nativeBalance = data['nativeBalance'] === undefined
      ? null
      : normalizeBigNumberish(data['nativeBalance']);
    if (data['nativeBalance'] !== undefined && nativeBalance === null) return null;
    const tokenBalancesRaw = Array.isArray(data['tokenBalances']) ? data['tokenBalances'] : [];
    const tokenBalances: Array<{ tokenAddress: string; tokenId?: number; balance: string }> = [];
    for (const rawEntry of tokenBalancesRaw) {
      const entry = toRecord(rawEntry);
      if (!entry) return null;
      const tokenAddress = normalizeAddress(entry['tokenAddress']);
      const balance = normalizeBigNumberish(entry['balance']);
      const tokenId = normalizeInt(entry['tokenId']);
      if (!tokenAddress || balance === null) return null;
      tokenBalances.push({
        tokenAddress,
        ...(tokenId !== null ? { tokenId } : {}),
        balance,
      });
    }
    const allowancesRaw = Array.isArray(data['allowances']) ? data['allowances'] : [];
    const allowances: Array<{ tokenAddress: string; spender: string; allowance: string }> = [];
    for (const rawEntry of allowancesRaw) {
      const entry = toRecord(rawEntry);
      if (!entry) return null;
      const tokenAddress = normalizeAddress(entry['tokenAddress']);
      const spender = normalizeAddress(entry['spender']);
      const allowance = normalizeBigNumberish(entry['allowance']);
      if (!tokenAddress || !spender || allowance === null) return null;
      allowances.push({ tokenAddress, spender, allowance });
    }
    tokenBalances.sort((left, right) =>
      compareStableText(left.tokenAddress, right.tokenAddress) ||
      (left.tokenId ?? -1) - (right.tokenId ?? -1) ||
      compareStableText(left.balance, right.balance)
    );
    allowances.sort((left, right) =>
      compareStableText(left.tokenAddress, right.tokenAddress) ||
      compareStableText(left.spender, right.spender) ||
      compareStableText(left.allowance, right.allowance)
    );
    return {
      ...meta,
      type,
      data: {
        entityId,
        owner,
        ...(nativeBalance !== null ? { nativeBalance } : {}),
        ...(tokenBalances.length > 0 ? { tokenBalances } : {}),
        ...(allowances.length > 0 ? { allowances } : {}),
      },
    };
  }

  if (type === 'ExternalWalletDelta') {
    const entityId = normalizeEntity(data['entityId']);
    const owner = normalizeAddress(data['owner']);
    const tokenAddress = normalizeAddress(data['tokenAddress']);
    const tokenId = normalizeInt(data['tokenId']);
    const balanceDelta = data['balanceDelta'] === undefined
      ? null
      : normalizeBigNumberish(data['balanceDelta']);
    const spender = data['spender'] === undefined ? null : normalizeAddress(data['spender']);
    const allowance = data['allowance'] === undefined ? null : normalizeBigNumberish(data['allowance']);
    if (!entityId || !owner || !tokenAddress) return null;
    const hasBalanceDelta = data['balanceDelta'] !== undefined;
    const hasAllowance = data['allowance'] !== undefined || data['spender'] !== undefined;
    if (hasBalanceDelta && balanceDelta === null) return null;
    if (hasAllowance && (!spender || allowance === null)) return null;
    if (!hasBalanceDelta && !hasAllowance) return null;
    return {
      ...meta,
      type,
      data: {
        entityId,
        owner,
        tokenAddress,
        ...(tokenId !== null ? { tokenId } : {}),
        ...(hasBalanceDelta ? { balanceDelta: balanceDelta! } : {}),
        ...(hasAllowance ? { spender: spender!, allowance: allowance! } : {}),
      },
    };
  }

  if (type === 'SecretRevealed') {
    if (typeof data['hashlock'] !== 'string' || typeof data['revealer'] !== 'string' || typeof data['secret'] !== 'string') {
      return null;
    }
    return {
      ...meta,
      type,
      data: {
        hashlock: data['hashlock'],
        revealer: data['revealer'].toLowerCase(),
        secret: data['secret'],
      },
    };
  }

  if (type === 'AccountSettled') {
    const leftEntity = normalizeEntity(data['leftEntity']);
    const rightEntity = normalizeEntity(data['rightEntity']);
    const tokenId = normalizeInt(data['tokenId']);
    const leftReserve = normalizeBigNumberish(data['leftReserve']);
    const rightReserve = normalizeBigNumberish(data['rightReserve']);
    const collateral = normalizeBigNumberish(data['collateral']);
    const ondelta = normalizeBigNumberish(data['ondelta']);
    const nonce = normalizeInt(data['nonce']);
    if (
      !leftEntity ||
      !rightEntity ||
      tokenId === null ||
      leftReserve === null ||
      rightReserve === null ||
      collateral === null ||
      ondelta === null ||
      nonce === null
    ) {
      return null;
    }
    return {
      ...meta,
      type,
      data: {
        leftEntity,
        rightEntity,
        tokenId,
        leftReserve,
        rightReserve,
        collateral,
        ondelta,
        nonce,
      },
    };
  }

  if (type === 'DisputeStarted') {
    const sender = normalizeEntity(data['sender']);
    const counterentity = normalizeEntity(data['counterentity']);
    const nonce = normalizeBigNumberish(data['nonce']);
    if (!sender || !counterentity || nonce === null || typeof data['proofbodyHash'] !== 'string') {
      return null;
    }
    const watchSeed = typeof data['watchSeed'] === 'string' ? data['watchSeed'] : '0x';
    const starterInitialArguments = typeof data['starterInitialArguments'] === 'string'
      ? data['starterInitialArguments']
      : '0x';
    const starterIncrementedArguments = typeof data['starterIncrementedArguments'] === 'string'
      ? data['starterIncrementedArguments']
      : '0x';
    const batchNonce = normalizeInt(data['batchNonce']);
    return {
      ...meta,
      type: 'DisputeStarted',
      data: {
        sender,
        counterentity,
        nonce,
        proofbodyHash: data['proofbodyHash'],
        watchSeed,
        starterInitialArguments,
        starterIncrementedArguments,
        ...(batchNonce !== null ? { batchNonce } : {}),
      },
    };
  }

  if (type === 'DisputeFinalized') {
    const sender = normalizeEntity(data['sender']);
    const counterentity = normalizeEntity(data['counterentity']);
    const initialNonce = normalizeBigNumberish(data['initialNonce']);
    if (
      !sender ||
      !counterentity ||
      initialNonce === null ||
      typeof data['initialProofbodyHash'] !== 'string' ||
      typeof data['finalProofbodyHash'] !== 'string'
    ) {
      return null;
    }
    const batchNonce = normalizeInt(data['batchNonce']);
    return {
      ...meta,
      type,
      data: {
        sender,
        counterentity,
        initialNonce,
        initialProofbodyHash: data['initialProofbodyHash'],
        finalProofbodyHash: data['finalProofbodyHash'],
        ...(batchNonce !== null ? { batchNonce } : {}),
      },
    };
  }

  if (type === 'DebtCreated') {
    const debtor = normalizeEntity(data['debtor']);
    const creditor = normalizeEntity(data['creditor']);
    const tokenId = normalizeInt(data['tokenId']);
    const amount = normalizeBigNumberish(data['amount']);
    const debtIndex = normalizeInt(data['debtIndex']);
    if (!debtor || !creditor || tokenId === null || amount === null || debtIndex === null) return null;
    return { ...meta, type, data: { debtor, creditor, tokenId, amount, debtIndex } };
  }

  if (type === 'DebtEnforced') {
    const debtor = normalizeEntity(data['debtor']);
    const creditor = normalizeEntity(data['creditor']);
    const tokenId = normalizeInt(data['tokenId']);
    const amountPaid = normalizeBigNumberish(data['amountPaid']);
    const remainingAmount = normalizeBigNumberish(data['remainingAmount']);
    const newDebtIndex = normalizeInt(data['newDebtIndex']);
    if (!debtor || !creditor || tokenId === null || amountPaid === null || remainingAmount === null || newDebtIndex === null) {
      return null;
    }
    return { ...meta, type, data: { debtor, creditor, tokenId, amountPaid, remainingAmount, newDebtIndex } };
  }

  if (type === 'DebtForgiven') {
    const debtor = normalizeEntity(data['debtor']);
    const creditor = normalizeEntity(data['creditor']);
    const tokenId = normalizeInt(data['tokenId']);
    const amountForgiven = normalizeBigNumberish(data['amountForgiven']);
    const debtIndex = normalizeInt(data['debtIndex']);
    if (!debtor || !creditor || tokenId === null || amountForgiven === null || debtIndex === null) {
      return null;
    }
    return { ...meta, type, data: { debtor, creditor, tokenId, amountForgiven, debtIndex } };
  }

  if (type === 'HankoBatchProcessed') {
    const entityId = normalizeEntity(data['entityId']);
    const nonce = normalizeInt(data['nonce']);
    if (!entityId || typeof data['hankoHash'] !== 'string' || nonce === null || typeof data['success'] !== 'boolean') return null;
    return {
      ...meta,
      type,
      data: { entityId, hankoHash: data['hankoHash'], nonce, success: data['success'] },
    };
  }

  return null;
}

export function normalizeJurisdictionEvents(value: unknown): JurisdictionEvent[] {
  if (!Array.isArray(value)) return [];
  const out: JurisdictionEvent[] = [];
  for (const item of value) {
    const normalized = normalizeJurisdictionEvent(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function canonicalJurisdictionEventKey(event: JurisdictionEvent): string {
  if (event.type === 'AccountSettled') {
    const d = event.data;
    const leftEntity = String(d.leftEntity).toLowerCase();
    const rightEntity = String(d.rightEntity).toLowerCase();
    const tokenId = Number(d.tokenId);
    const collateral = String(d.collateral);
    const ondelta = String(d.ondelta);
    const nonce = Number(d.nonce);
    const leftReserve = String(d.leftReserve);
    const rightReserve = String(d.rightReserve);
    return `AccountSettled:${leftEntity}:${rightEntity}:${tokenId}:${leftReserve}:${rightReserve}:${collateral}:${ondelta}:${nonce}`;
  }
  return `${event.type}:${safeStringify(event.data)}`;
}
