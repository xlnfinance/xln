import type { JurisdictionEvent } from './types';
import { safeStringify } from './serialization-utils';

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

const normalizeSide = (value: unknown): 'left' | 'right' | null => {
  if (value === 'left' || value === 'right') return value;
  return null;
};

const normalizeMetadata = (raw: Record<string, unknown>) => {
  const out: Pick<JurisdictionEvent, 'blockNumber' | 'blockHash' | 'transactionHash'> = {};
  if (raw.blockNumber !== undefined) {
    const n = normalizeInt(raw.blockNumber);
    if (n !== null) out.blockNumber = n;
  }
  if (typeof raw.blockHash === 'string' && raw.blockHash.trim()) out.blockHash = raw.blockHash;
  if (typeof raw.transactionHash === 'string' && raw.transactionHash.trim()) out.transactionHash = raw.transactionHash;
  return out;
};

export function normalizeJurisdictionEvent(value: unknown): JurisdictionEvent | null {
  const raw = toRecord(value);
  if (!raw) return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  const data = toRecord(raw.data);
  if (!type || !data) return null;
  const meta = normalizeMetadata(raw);

  if (type === 'ReserveUpdated') {
    const entity = normalizeEntity(data.entity);
    const tokenId = normalizeInt(data.tokenId);
    const newBalance = normalizeBigNumberish(data.newBalance);
    if (!entity || tokenId === null || newBalance === null) return null;
    return { ...meta, type, data: { entity, tokenId, newBalance } };
  }

  if (type === 'SecretRevealed') {
    if (typeof data.hashlock !== 'string' || typeof data.revealer !== 'string' || typeof data.secret !== 'string') {
      return null;
    }
    return {
      ...meta,
      type,
      data: {
        hashlock: data.hashlock,
        revealer: data.revealer.toLowerCase(),
        secret: data.secret,
      },
    };
  }

  if (type === 'AccountSettled') {
    const leftEntity = normalizeEntity(data.leftEntity);
    const rightEntity = normalizeEntity(data.rightEntity);
    const counterpartyEntityId = normalizeEntity(data.counterpartyEntityId);
    const tokenId = normalizeInt(data.tokenId);
    const ownReserve = normalizeBigNumberish(data.ownReserve);
    const counterpartyReserve = normalizeBigNumberish(data.counterpartyReserve);
    const collateral = normalizeBigNumberish(data.collateral);
    const ondelta = normalizeBigNumberish(data.ondelta);
    const nonce = normalizeInt(data.nonce);
    const side = normalizeSide(data.side);
    if (
      !leftEntity ||
      !rightEntity ||
      !counterpartyEntityId ||
      tokenId === null ||
      ownReserve === null ||
      counterpartyReserve === null ||
      collateral === null ||
      ondelta === null ||
      nonce === null ||
      !side
    ) {
      return null;
    }
    return {
      ...meta,
      type,
      data: {
        leftEntity,
        rightEntity,
        counterpartyEntityId,
        tokenId,
        ownReserve,
        counterpartyReserve,
        collateral,
        ondelta,
        nonce,
        side,
      },
    };
  }

  if (type === 'DisputeStarted') {
    if (
      typeof data.sender !== 'string' ||
      typeof data.counterentity !== 'string' ||
      typeof data.nonce !== 'string' ||
      typeof data.proofbodyHash !== 'string'
    ) {
      return null;
    }
    const initialArguments = typeof data.initialArguments === 'string' ? data.initialArguments : '0x';
    return {
      ...meta,
      type,
      data: {
        sender: data.sender.toLowerCase(),
        counterentity: data.counterentity.toLowerCase(),
        nonce: data.nonce,
        proofbodyHash: data.proofbodyHash,
        initialArguments,
      },
    };
  }

  if (type === 'DisputeFinalized') {
    if (
      typeof data.sender !== 'string' ||
      typeof data.counterentity !== 'string' ||
      typeof data.initialNonce !== 'string' ||
      typeof data.initialProofbodyHash !== 'string' ||
      typeof data.finalProofbodyHash !== 'string'
    ) {
      return null;
    }
    return {
      ...meta,
      type,
      data: {
        sender: data.sender.toLowerCase(),
        counterentity: data.counterentity.toLowerCase(),
        initialNonce: data.initialNonce,
        initialProofbodyHash: data.initialProofbodyHash,
        finalProofbodyHash: data.finalProofbodyHash,
      },
    };
  }

  if (type === 'DebtCreated') {
    const debtor = normalizeEntity(data.debtor);
    const creditor = normalizeEntity(data.creditor);
    const tokenId = normalizeInt(data.tokenId);
    const amount = normalizeBigNumberish(data.amount);
    const debtIndex = normalizeInt(data.debtIndex);
    if (!debtor || !creditor || tokenId === null || amount === null || debtIndex === null) return null;
    return { ...meta, type, data: { debtor, creditor, tokenId, amount, debtIndex } };
  }

  if (type === 'DebtEnforced') {
    const debtor = normalizeEntity(data.debtor);
    const creditor = normalizeEntity(data.creditor);
    const tokenId = normalizeInt(data.tokenId);
    const amountPaid = normalizeBigNumberish(data.amountPaid);
    const remainingAmount = normalizeBigNumberish(data.remainingAmount);
    const newDebtIndex = normalizeInt(data.newDebtIndex);
    if (!debtor || !creditor || tokenId === null || amountPaid === null || remainingAmount === null || newDebtIndex === null) {
      return null;
    }
    return { ...meta, type, data: { debtor, creditor, tokenId, amountPaid, remainingAmount, newDebtIndex } };
  }

  if (type === 'HankoBatchProcessed') {
    const entityId = normalizeEntity(data.entityId);
    const nonce = normalizeInt(data.nonce);
    if (!entityId || typeof data.hankoHash !== 'string' || nonce === null || typeof data.success !== 'boolean') return null;
    return {
      ...meta,
      type,
      data: { entityId, hankoHash: data.hankoHash, nonce, success: data.success },
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
    const leftReserve = d.side === 'left' ? String(d.ownReserve) : String(d.counterpartyReserve);
    const rightReserve = d.side === 'left' ? String(d.counterpartyReserve) : String(d.ownReserve);
    return `AccountSettled:${leftEntity}:${rightEntity}:${tokenId}:${leftReserve}:${rightReserve}:${collateral}:${ondelta}:${nonce}`;
  }
  return `${event.type}:${safeStringify(event.data)}`;
}
