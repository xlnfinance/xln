import { ethers } from 'ethers';

import type { JurisdictionConfig } from '../../../../entity/types';
import type { DebtEntry } from '../../../../types/finance/debt';
import { resolveDepositoryAnchorBase, type DepositoryAnchorBase } from './rpc-depository-base';
import { readVerifiedGetProof } from './rpc-state-proof';
import {
  depositoryActiveDebtsSlot,
  depositoryDebtEntrySlot,
  depositoryDebtIndexSlot,
  depositoryDebtOutstandingSlot,
  depositoryDebtQueueSlot,
  depositoryInActiveDebtsSlot,
} from './rpc-storage-slots';

// Out-debt (D2) observation: the open debts an Entity owes, read from
// Depository storage at one block and proven by eth_getProof against the
// stateRoot of a header that hashes to the caller's fenced block hash.
//
// What storage can and cannot vouch for, stated rather than defaulted:
// - Live queue entries [_debtIndex, length) give creditor, remaining amount and
//   the queue position. An open Entity DebtEntry keeps createdDebtIndex equal to
//   that position (partial enforcement leaves the cursor in place), so the
//   comparison key is (tokenId, createdDebtIndex).
// - debtOutstanding[debtor][token] (Uint768) and activeDebts[debtor] are
//   cross-checked against the sum and count of the open entries.
// - Each entry stores its generation (createdBlock, createdSeq). A reset queue
//   reuses index 0, so creditor/amount/position alone accept a retired debt in
//   place of a recreated one; (createdBlock, createdSeq) must equal the fold's
//   (createdAtBlock, createdSeq). debtSeq is global and strictly increasing, so
//   two same-block recreates at one position still differ in createdSeq. This
//   selects the live generation; it does not authenticate createdTxHash.
// - debtId, createdAmount, paidAmount, createdTxHash and lastUpdated* are
//   history-only. This anchor never reconstructs them; the history fold stays
//   the only source of DebtEntry identity and provenance.
// - Creditor-side in-debts have no creditor-keyed queue. inActiveDebts[creditor]
//   counts them; each supplied in-entry must also be the debtor's live queue
//   entry at its position (creditor, remaining amount, generation). Count plus
//   unique proven positions makes the open in-ledger complete; in-entry identity
//   and provenance stay history-only like out-entries.
// - Token ids are enumerated over [0, _tokens.length) plus every token the
//   compared ledgers hold. Dispute finalization books a shortfall on any
//   proof-body tokenId, listed or not, so an unlisted out-debt is a real state,
//   not an error. activeDebts[debtor] counts open debts across ALL tokens, so a
//   stored debt on a token neither listed nor held locally still fails closed
//   as ACTIVE_COUNT_MISMATCH.

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

export type OutDebtStorageEntry = { index: number; creditor: string; amount: bigint };

export type OutDebtStorageView = {
  activeDebts: bigint;
  /** inActiveDebts[entity]: live entries owed TO this Entity, all debtors and tokens. */
  inActiveDebts: bigint;
  byToken: Map<number, { cursor: bigint; length: bigint; outstanding: bigint; entries: OutDebtStorageEntry[] }>;
  /** Stored generation of each live entry: tokenId -> queue index -> `createdBlock:createdSeq`. */
  generations: Map<number, Map<number, string>>;
};

export type OutDebtStorageAnchor = {
  blockNumber: number;
  stateRoot: string;
  tokenCount: bigint;
  debtors: Map<string, OutDebtStorageView>;
};

const DEFAULT_SLOTS_PER_PROOF = 256;
const EMPTY_CODE_HASH = ethers.keccak256('0x').toLowerCase();
const WORD = 1n << 256n;

const fail = (code: string, detail = ''): never => {
  throw new Error(`DEBT_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
};

const entityKey = (entityId: string): string => {
  const normalized = String(entityId).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) fail('ENTITY_INVALID', String(entityId));
  return normalized;
};

const safeIndex = (value: bigint, label: string): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('INDEX_INVALID', `${label}:${value.toString()}`);
  return Number(value);
};

/**
 * Projects an Entity out-debt ledger to the storage-comparable view: per token,
 * the open entries keyed by queue position. Rejects any entry the fold should
 * never hold (wrong direction, debtor, bucket, status or a non-positive amount)
 * and duplicate positions.
 */
export const projectOutDebts = (
  entityId: string,
  outDebtsByToken: ReadonlyMap<number, ReadonlyMap<string, DebtEntry>> | undefined,
): Map<number, OutDebtStorageEntry[]> => {
  const debtor = entityKey(entityId);
  const projected = new Map<number, OutDebtStorageEntry[]>();
  for (const [tokenId, bucket] of outDebtsByToken ?? []) {
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) fail('TOKEN_INVALID', String(tokenId));
    const entries: OutDebtStorageEntry[] = [];
    for (const entry of bucket.values()) {
      if (entry.direction !== 'out' || entry.status !== 'open' || entry.tokenId !== tokenId
        || String(entry.debtor).toLowerCase() !== debtor) {
        fail('LOCAL_ENTRY_INVALID', entry.debtId);
      }
      if (entry.remainingAmount <= 0n) fail('LOCAL_AMOUNT_INVALID', entry.debtId);
      if (!Number.isSafeInteger(entry.createdDebtIndex) || entry.createdDebtIndex < 0) fail('LOCAL_INDEX_INVALID', entry.debtId);
      if (!Number.isSafeInteger(entry.createdAtBlock) || entry.createdAtBlock < 0) fail('LOCAL_BLOCK_INVALID', entry.debtId);
      entries.push({ index: entry.createdDebtIndex, creditor: entityKey(entry.creditor), amount: entry.remainingAmount });
    }
    entries.sort((left, right) => left.index - right.index);
    if (new Set(entries.map(entry => entry.index)).size !== entries.length) fail('LOCAL_INDEX_DUPLICATE', String(tokenId));
    if (entries.length > 0) projected.set(tokenId, entries);
  }
  return projected;
};

/** One open creditor-side in-entry, as the debtor's queue must hold it. */
type InDebtClaim = { debtor: string; tokenId: number; index: number; amount: bigint; generation: string };

/**
 * Projects a creditor's in-debt ledger to queue claims. Rejects any entry the
 * fold should never hold and two entries claiming one debtor queue position.
 */
const projectInDebts = (
  entityId: string,
  inDebtsByToken: ReadonlyMap<number, ReadonlyMap<string, DebtEntry>> | undefined,
): InDebtClaim[] => {
  const creditor = entityKey(entityId);
  const claims: InDebtClaim[] = [];
  for (const [tokenId, bucket] of inDebtsByToken ?? []) {
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) fail('TOKEN_INVALID', String(tokenId));
    for (const entry of bucket.values()) {
      if (entry.direction !== 'in' || entry.status !== 'open' || entry.tokenId !== tokenId
        || String(entry.creditor).toLowerCase() !== creditor) {
        fail('LOCAL_IN_ENTRY_INVALID', entry.debtId);
      }
      if (entry.remainingAmount <= 0n) fail('LOCAL_AMOUNT_INVALID', entry.debtId);
      if (!Number.isSafeInteger(entry.createdDebtIndex) || entry.createdDebtIndex < 0) fail('LOCAL_INDEX_INVALID', entry.debtId);
      if (typeof entry.createdSeq !== 'bigint' || entry.createdSeq <= 0n) fail('LOCAL_SEQ_INVALID', entry.debtId);
      claims.push({
        debtor: entityKey(entry.debtor),
        tokenId,
        index: entry.createdDebtIndex,
        amount: entry.remainingAmount,
        generation: `${entry.createdAtBlock}:${entry.createdSeq.toString()}`,
      });
    }
  }
  claims.sort((left, right) => (left.debtor < right.debtor ? -1 : left.debtor > right.debtor ? 1 : left.tokenId - right.tokenId || left.index - right.index));
  const positions = claims.map(claim => `${claim.debtor}:${claim.tokenId}:${claim.index}`);
  if (new Set(positions).size !== positions.length) fail('LOCAL_IN_INDEX_DUPLICATE', creditor);
  return claims;
};

const describeInDebts = (claims: readonly InDebtClaim[]): string =>
  claims.map(claim => `${claim.debtor}:${claim.tokenId}:${claim.index}:${claim.amount.toString()}@${claim.generation}`).join(',');

export const readOutDebtAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'depositoryAddress'>;
  blockNumber: number;
  authenticatedBlockHash: string;
  debtorIds: readonly string[];
  /** Token ids held by the compared ledgers; proven even when unlisted. */
  heldTokenIds?: readonly number[];
  /** Header stateRoot and _tokens.length already proven at this block (one audit height). */
  base?: DepositoryAnchorBase;
  slotsPerProof?: number;
}): Promise<OutDebtStorageAnchor> => {
  const { send, blockNumber } = input;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail('BLOCK_INVALID', String(blockNumber));
  const address = ethers.getAddress(String(input.jurisdiction.depositoryAddress ?? ''));
  const debtorIds = input.debtorIds.map(entityKey);
  if (new Set(debtorIds).size !== debtorIds.length) fail('ENTITY_DUPLICATE');
  const perProof = input.slotsPerProof ?? DEFAULT_SLOTS_PER_PROOF;
  if (!Number.isSafeInteger(perProof) || perProof < 1) fail('SLOTS_PER_PROOF_INVALID', String(perProof));
  const { stateRoot, tokenCount } = await resolveDepositoryAnchorBase({
    send,
    depositoryAddress: address,
    blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    base: input.base,
    fail,
  });

  // One proof per chunk; every requested slot must come back proven.
  const prove = async (slots: readonly bigint[]): Promise<Map<bigint, bigint>> => {
    const values = new Map<bigint, bigint>();
    for (let start = 0; start < slots.length; start += perProof) {
      const chunk = slots.slice(start, start + perProof);
      const proven = await readVerifiedGetProof(send, stateRoot, address, chunk, blockNumber);
      if (!proven.account || proven.account.codeHash.toLowerCase() === EMPTY_CODE_HASH) fail('CONTRACT_MISSING', address);
      for (const slot of chunk) values.set(slot, proven.storage.get(slot) ?? fail('SLOT_MISSING', ethers.toBeHex(slot, 32)));
    }
    return values;
  };
  const at = (values: ReadonlyMap<bigint, bigint>, slot: bigint): bigint =>
    values.get(slot) ?? fail('SLOT_MISSING', ethers.toBeHex(slot, 32));

  const tokenIds = Array.from({ length: Number(tokenCount) }, (_, tokenId) => BigInt(tokenId));
  for (const tokenId of new Set(input.heldTokenIds ?? [])) {
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) fail('TOKEN_INVALID', String(tokenId));
    if (BigInt(tokenId) >= tokenCount) tokenIds.push(BigInt(tokenId));
  }

  // Pass 1: per debtor the active count, and per token the queue length, cursor and aggregate.
  const headSlots: bigint[] = [];
  for (const debtor of debtorIds) {
    headSlots.push(depositoryActiveDebtsSlot(debtor), depositoryInActiveDebtsSlot(debtor));
    for (const tokenId of tokenIds) {
      headSlots.push(
        depositoryDebtQueueSlot(debtor, tokenId),
        depositoryDebtIndexSlot(debtor, tokenId),
        depositoryDebtOutstandingSlot(debtor, tokenId, 0n),
        depositoryDebtOutstandingSlot(debtor, tokenId, 1n),
        depositoryDebtOutstandingSlot(debtor, tokenId, 2n),
      );
    }
  }
  const head = await prove(headSlots);

  // Pass 2: the live entries [cursor, length) of every non-empty queue.
  const debtors = new Map<string, OutDebtStorageView>();
  const entrySlots: bigint[] = [];
  for (const debtor of debtorIds) {
    const view: OutDebtStorageView = {
      activeDebts: at(head, depositoryActiveDebtsSlot(debtor)),
      inActiveDebts: at(head, depositoryInActiveDebtsSlot(debtor)),
      byToken: new Map(),
      generations: new Map(),
    };
    for (const tokenId of tokenIds) {
      const length = at(head, depositoryDebtQueueSlot(debtor, tokenId));
      const cursor = at(head, depositoryDebtIndexSlot(debtor, tokenId));
      const outstanding = (at(head, depositoryDebtOutstandingSlot(debtor, tokenId, 0n)) * WORD
        + at(head, depositoryDebtOutstandingSlot(debtor, tokenId, 1n))) * WORD
        + at(head, depositoryDebtOutstandingSlot(debtor, tokenId, 2n));
      if (length === 0n && cursor === 0n && outstanding === 0n) continue;
      if (cursor > length) fail('CURSOR_INVALID', `${debtor}:${tokenId}:${cursor}:${length}`);
      safeIndex(length, `${debtor}:${tokenId}:length`);
      view.byToken.set(Number(tokenId), { cursor, length, outstanding, entries: [] });
      for (let index = cursor; index < length; index += 1n) {
        entrySlots.push(
          depositoryDebtEntrySlot(debtor, tokenId, index, 0n),
          depositoryDebtEntrySlot(debtor, tokenId, index, 1n),
          depositoryDebtEntrySlot(debtor, tokenId, index, 2n),
          depositoryDebtEntrySlot(debtor, tokenId, index, 3n),
        );
      }
    }
    debtors.set(debtor, view);
  }
  const entryValues = entrySlots.length > 0 ? await prove(entrySlots) : new Map<bigint, bigint>();
  for (const [debtor, view] of debtors) {
    for (const [tokenId, queue] of view.byToken) {
      for (let index = queue.cursor; index < queue.length; index += 1n) {
        const token = BigInt(tokenId);
        const amount = at(entryValues, depositoryDebtEntrySlot(debtor, token, index, 1n)) * WORD
          + at(entryValues, depositoryDebtEntrySlot(debtor, token, index, 2n));
        // enforceDebts skips zero entries inside the live range; they are not debts.
        if (amount === 0n) continue;
        const creditor = ethers.toBeHex(at(entryValues, depositoryDebtEntrySlot(debtor, token, index, 0n)), 32).toLowerCase();
        const generationWord = at(entryValues, depositoryDebtEntrySlot(debtor, token, index, 3n));
        const createdBlock = safeIndex(generationWord & ((1n << 64n) - 1n), `${debtor}:${tokenId}:${index}:createdBlock`);
        const createdSeq = generationWord >> 64n;
        const position = safeIndex(index, `${debtor}:${tokenId}:entry`);
        queue.entries.push({ index: position, creditor, amount });
        const generations = view.generations.get(tokenId) ?? new Map<number, string>();
        generations.set(position, `${createdBlock}:${createdSeq.toString()}`);
        view.generations.set(tokenId, generations);
      }
    }
  }
  return { blockNumber, stateRoot, tokenCount, debtors };
};

const describeEntries = (entries: readonly OutDebtStorageEntry[]): string =>
  entries.map(entry => `${entry.index}:${entry.creditor}:${entry.amount.toString()}`).join(',');

const describeGenerations = (generations: ReadonlyMap<number, ReadonlyMap<number, string>>): string =>
  [...generations].sort(([left], [right]) => left - right)
    .map(([tokenId, byIndex]) => `${tokenId}=[${[...byIndex].sort(([left], [right]) => left - right).map(([index, generation]) => `${index}@${generation}`).join(',')}]`)
    .join(';');

/** Canonical text of a projected out-debt ledger; equal text means equal ledgers. */
export const describeOutDebts = (ledger: ReadonlyMap<number, readonly OutDebtStorageEntry[]>): string =>
  [...ledger].sort(([left], [right]) => left - right).map(([tokenId, entries]) => `${tokenId}=[${describeEntries(entries)}]`).join(';');

/**
 * Fail-closed equality between each Entity's open out-debts finalized at one J
 * block and Depository storage at that block: the same live entries per token,
 * each aggregate equal to the sum of its entries, and activeDebts equal to the
 * open count. When an Entity also supplies its creditor-side `inDebtsByToken`,
 * its open in-entry count must equal inActiveDebts[entity]. Replicas of one
 * Entity must agree. Observation only: the fold is not replaced and no
 * DebtEntry field is derived from storage.
 */
export const assertEntityOutDebtsMatchAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'depositoryAddress'>;
  blockNumber: number;
  authenticatedBlockHash: string;
  entities: ReadonlyArray<{
    entityId: string;
    outDebtsByToken: ReadonlyMap<number, ReadonlyMap<string, DebtEntry>> | undefined;
    inDebtsByToken?: ReadonlyMap<number, ReadonlyMap<string, DebtEntry>> | undefined;
  }>;
  base?: DepositoryAnchorBase;
  slotsPerProof?: number;
}): Promise<OutDebtStorageAnchor> => {
  const local = new Map<string, Map<number, OutDebtStorageEntry[]>>();
  const localIn = new Map<string, bigint>();
  const localInEntries = new Map<string, InDebtClaim[]>();
  const localGenerations = new Map<string, Map<number, Map<number, string>>>();
  for (const entity of input.entities) {
    const entityId = entityKey(entity.entityId);
    const projected = projectOutDebts(entityId, entity.outDebtsByToken);
    const existing = local.get(entityId);
    if (existing && describeOutDebts(existing) !== describeOutDebts(projected)) {
      fail('REPLICA_DIVERGENCE', `${input.blockNumber}:${entityId}`);
    }
    local.set(entityId, projected);
    const generations = new Map<number, Map<number, string>>();
    for (const [tokenId, bucket] of entity.outDebtsByToken ?? []) {
      generations.set(tokenId, new Map([...bucket.values()].map(entry => {
        if (typeof entry.createdSeq !== 'bigint' || entry.createdSeq <= 0n) fail('LOCAL_SEQ_INVALID', entry.debtId);
        return [entry.createdDebtIndex, `${entry.createdAtBlock}:${entry.createdSeq.toString()}`];
      })));
    }
    const existingGenerations = localGenerations.get(entityId);
    if (existingGenerations && describeGenerations(existingGenerations) !== describeGenerations(generations)) {
      fail('REPLICA_DIVERGENCE', `${input.blockNumber}:${entityId}:generation`);
    }
    localGenerations.set(entityId, generations);
    if (!('inDebtsByToken' in entity)) continue;
    let inCount = 0n;
    for (const ledger of entity.inDebtsByToken?.values() ?? []) inCount += BigInt(ledger.size);
    const existingIn = localIn.get(entityId);
    if (existingIn !== undefined && existingIn !== inCount) fail('REPLICA_DIVERGENCE', `${input.blockNumber}:${entityId}:in`);
    localIn.set(entityId, inCount);
    const claims = projectInDebts(entityId, entity.inDebtsByToken);
    const existingClaims = localInEntries.get(entityId);
    if (existingClaims && describeInDebts(existingClaims) !== describeInDebts(claims)) {
      fail('REPLICA_DIVERGENCE', `${input.blockNumber}:${entityId}:in-entries`);
    }
    localInEntries.set(entityId, claims);
  }
  // In-entries are proven against their debtors' queues, so those debtors are read too.
  const allClaims = [...localInEntries.values()].flat();
  const anchor = await readOutDebtAnchor({
    send: input.send,
    jurisdiction: input.jurisdiction,
    blockNumber: input.blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    debtorIds: [...new Set([...local.keys(), ...allClaims.map(claim => claim.debtor)])],
    heldTokenIds: [...[...local.values()].flatMap(ledger => [...ledger.keys()]), ...allClaims.map(claim => claim.tokenId)],
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.slotsPerProof === undefined ? {} : { slotsPerProof: input.slotsPerProof }),
  });
  for (const [entityId, ledger] of local) {
    const view = anchor.debtors.get(entityId) ?? fail('ENTITY_MISSING', entityId);
    const stored = new Map<number, OutDebtStorageEntry[]>();
    let openCount = 0n;
    for (const [tokenId, queue] of view.byToken) {
      const sum = queue.entries.reduce((total, entry) => total + entry.amount, 0n);
      if (sum !== queue.outstanding) {
        fail('OUTSTANDING_MISMATCH', `${input.blockNumber}:${entityId}:${tokenId}:entries=${sum.toString()}:aggregate=${queue.outstanding.toString()}`);
      }
      openCount += BigInt(queue.entries.length);
      if (queue.entries.length > 0) stored.set(tokenId, queue.entries);
    }
    if (openCount !== view.activeDebts) {
      fail('ACTIVE_COUNT_MISMATCH', `${input.blockNumber}:${entityId}:entries=${openCount.toString()}:active=${view.activeDebts.toString()}`);
    }
    const inCount = localIn.get(entityId);
    if (inCount !== undefined && inCount !== view.inActiveDebts) {
      fail('IN_ACTIVE_COUNT_MISMATCH', `${input.blockNumber}:${entityId}:entries=${inCount.toString()}:active=${view.inActiveDebts.toString()}`);
    }
    if (describeOutDebts(ledger) !== describeOutDebts(stored)) {
      fail('MISMATCH', `${input.blockNumber}:${entityId}:local=${describeOutDebts(ledger)}:storage=${describeOutDebts(stored)}`);
    }
    // Same tokens, positions, creditors and amounts: now each entry's generation.
    for (const [tokenId, generations] of localGenerations.get(entityId) ?? []) {
      for (const [index, generation] of generations) {
        const storedGeneration = view.generations.get(tokenId)?.get(index);
        if (storedGeneration !== generation) {
          fail('GENERATION_MISMATCH', `${input.blockNumber}:${entityId}:${tokenId}:${index}:local=${generation}:storage=${String(storedGeneration)}`);
        }
      }
    }
  }
  // Each open in-entry is the debtor's live queue entry at its position: same
  // creditor, remaining amount and generation. With unique positions and the
  // in-count equal to inActiveDebts, the creditor's open in-ledger is complete.
  for (const [entityId, claims] of localInEntries) {
    for (const claim of claims) {
      const view = anchor.debtors.get(claim.debtor) ?? fail('ENTITY_MISSING', claim.debtor);
      const stored = view.byToken.get(claim.tokenId)?.entries.find(entry => entry.index === claim.index);
      const storedGeneration = view.generations.get(claim.tokenId)?.get(claim.index);
      if (!stored || stored.creditor !== entityId || stored.amount !== claim.amount || storedGeneration !== claim.generation) {
        fail('IN_ENTRY_MISMATCH', `${input.blockNumber}:${entityId}:${describeInDebts([claim])}:storage=` +
          `${stored ? `${stored.creditor}:${stored.amount.toString()}` : 'none'}@${String(storedGeneration)}`);
      }
    }
  }
  return anchor;
};
