import type { JurisdictionEvent } from '../types';
import { compareStableText, safeStringify } from '../protocol/serialization';

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
  const out: Pick<JurisdictionEvent, 'blockNumber' | 'blockHash' | 'transactionHash' | 'logIndex' | 'eventIndex'> = {};
  if (raw['blockNumber'] !== undefined) {
    const n = normalizeInt(raw['blockNumber']);
    if (n !== null) out.blockNumber = n;
  }
  if (typeof raw['blockHash'] === 'string' && raw['blockHash'].trim()) out.blockHash = raw['blockHash'];
  if (typeof raw['transactionHash'] === 'string' && raw['transactionHash'].trim()) out.transactionHash = raw['transactionHash'];
  if (raw['logIndex'] !== undefined) {
    const n = normalizeInt(raw['logIndex']);
    if (n !== null && n >= 0) out.logIndex = n;
  }
  if (raw['eventIndex'] !== undefined) {
    const n = normalizeInt(raw['eventIndex']);
    if (n !== null && n >= 0) out.eventIndex = n;
  }
  return out;
};

export function normalizeJurisdictionEvent(value: unknown): JurisdictionEvent | null {
  const raw = toRecord(value);
  if (!raw) return null;
  const type = typeof raw['type'] === 'string' ? raw['type'] : '';
  const data = toRecord(raw['data']);
  if (!type || !data) return null;
  const meta = normalizeMetadata(raw);

  if (type === 'FoundationBootstrapped') {
    const recipient = normalizeAddress(data['recipient']);
    const boardHash = typeof data['boardHash'] === 'string' ? data['boardHash'].trim().toLowerCase() : '';
    const controlTokenId = normalizeBigNumberish(data['controlTokenId']);
    const dividendTokenId = normalizeBigNumberish(data['dividendTokenId']);
    if (!recipient || !/^0x[0-9a-f]{64}$/.test(boardHash) || controlTokenId === null || dividendTokenId === null) {
      return null;
    }
    return { ...meta, type, data: { recipient, boardHash, controlTokenId, dividendTokenId } };
  }

  if (type === 'EntityRegistered') {
    const entityId = normalizeEntity(data['entityId']);
    const entityNumber = normalizeBigNumberish(data['entityNumber']);
    const boardHash = typeof data['boardHash'] === 'string' ? data['boardHash'].trim().toLowerCase() : '';
    if (!entityId || !/^0x[0-9a-f]{64}$/.test(entityId) || entityNumber === null || !/^0x[0-9a-f]{64}$/.test(boardHash)) {
      return null;
    }
    return { ...meta, type, data: { entityId, entityNumber, boardHash } };
  }

  if (type === 'BoardActivated') {
    const entityId = normalizeEntity(data['entityId']);
    const previousBoardHash = typeof data['previousBoardHash'] === 'string'
      ? data['previousBoardHash'].trim().toLowerCase()
      : '';
    const newBoardHash = typeof data['newBoardHash'] === 'string' ? data['newBoardHash'].trim().toLowerCase() : '';
    const previousBoardValidUntil = normalizeBigNumberish(data['previousBoardValidUntil']);
    if (
      !entityId ||
      !/^0x[0-9a-f]{64}$/.test(entityId) ||
      !/^0x[0-9a-f]{64}$/.test(previousBoardHash) ||
      !/^0x[0-9a-f]{64}$/.test(newBoardHash) ||
      previousBoardValidUntil === null ||
      BigInt(previousBoardValidUntil) <= 0n
    ) {
      return null;
    }
    return { ...meta, type, data: { entityId, previousBoardHash, newBoardHash, previousBoardValidUntil } };
  }

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
    const disputeTimeout = normalizeInt(data['disputeTimeout']);
    if (
      !sender ||
      !counterentity ||
      nonce === null ||
      disputeTimeout === null ||
      disputeTimeout <= 0 ||
      typeof data['proofbodyHash'] !== 'string'
    ) {
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
        disputeTimeout,
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
    const batchHash = typeof data['batchHash'] === 'string' ? data['batchHash'].trim().toLowerCase() : '';
    const nonce = normalizeInt(data['nonce']);
    if (
      !entityId ||
      !/^0x[0-9a-f]{64}$/.test(entityId) ||
      !/^0x[0-9a-f]{64}$/.test(batchHash) ||
      nonce === null ||
      nonce < 1
    ) return null;
    return {
      ...meta,
      type,
      data: { entityId, batchHash, nonce },
    };
  }

  if (type === 'EntityProviderActionExecuted') {
    const entityId = normalizeEntity(data['entityId']);
    const actionNonce = normalizeBigNumberish(data['actionNonce']);
    const actionHash = typeof data['actionHash'] === 'string'
      ? data['actionHash'].trim().toLowerCase()
      : '';
    const actionKind = normalizeInt(data['actionKind']);
    if (
      !entityId ||
      !/^0x[0-9a-f]{64}$/.test(entityId) ||
      actionNonce === null ||
      BigInt(actionNonce) < 1n ||
      BigInt(actionNonce) > (1n << 256n) - 1n ||
      !/^0x[0-9a-f]{64}$/.test(actionHash) ||
      (actionKind !== 0 && actionKind !== 1)
    ) return null;
    return { ...meta, type, data: { entityId, actionNonce, actionHash, actionKind } };
  }

  if (type === 'EntityProviderActionCancelled') {
    const entityId = normalizeEntity(data['entityId']);
    const actionNonce = normalizeBigNumberish(data['actionNonce']);
    const cancelledActionHash = typeof data['cancelledActionHash'] === 'string'
      ? data['cancelledActionHash'].trim().toLowerCase()
      : '';
    const cancelledActionKind = normalizeInt(data['cancelledActionKind']);
    const cancelHash = typeof data['cancelHash'] === 'string'
      ? data['cancelHash'].trim().toLowerCase()
      : '';
    if (
      !entityId ||
      !/^0x[0-9a-f]{64}$/.test(entityId) ||
      actionNonce === null ||
      BigInt(actionNonce) < 1n ||
      BigInt(actionNonce) > (1n << 256n) - 1n ||
      !/^0x[0-9a-f]{64}$/.test(cancelledActionHash) ||
      (cancelledActionKind !== 0 && cancelledActionKind !== 1) ||
      !/^0x[0-9a-f]{64}$/.test(cancelHash)
    ) return null;
    return {
      ...meta,
      type,
      data: { entityId, actionNonce, cancelledActionHash, cancelledActionKind, cancelHash },
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

const canonicalJurisdictionEventPayloadKey = (event: JurisdictionEvent): string => {
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
};

export function canonicalJurisdictionEventKey(event: JurisdictionEvent): string {
  return safeStringify([
    event.blockNumber ?? null,
    event.blockHash?.toLowerCase() ?? null,
    event.transactionHash?.toLowerCase() ?? null,
    event.logIndex ?? null,
    event.eventIndex ?? null,
    canonicalJurisdictionEventPayloadKey(event),
  ]);
}

const compareOptionalIndex = (left: number | undefined, right: number | undefined): number => {
  if (left !== undefined && right !== undefined) return left - right;
  if (left !== undefined) return -1;
  if (right !== undefined) return 1;
  return 0;
};

/**
 * EVM execution order is consensus data. Payload sorting is only a deterministic
 * fallback for synthetic events that have no chain log position.
 */
export function compareCanonicalJurisdictionEvents(
  left: JurisdictionEvent,
  right: JurisdictionEvent,
): number {
  return compareOptionalIndex(left.blockNumber, right.blockNumber)
    || compareOptionalIndex(left.logIndex, right.logIndex)
    || compareOptionalIndex(left.eventIndex, right.eventIndex)
    || compareStableText(left.transactionHash?.toLowerCase() ?? '', right.transactionHash?.toLowerCase() ?? '')
    || compareStableText(canonicalJurisdictionEventPayloadKey(left), canonicalJurisdictionEventPayloadKey(right));
}
