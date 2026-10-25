import type { JurisdictionConfig } from '../../../../entity/types';
import type { CertifiedBoardRecord } from '../../../../types/entity-board-registry';
import {
  buildCarriedProvenValues,
  buildDebtAnchorRoot,
  buildProvenValuesRoot,
  provenValuesBytes32,
  type DebtAnchorLeaf,
  type EntityDebtAnchorView,
  type EntityProvenValues,
  type JHistoryAnchorValues,
} from '../../../machine/state-anchor/proven-values-root';
import { buildNonceAnchorRoot, nonceViewFromStorage } from '../../../machine/state-anchor/nonce-root';
import { readCertifiedBoardAnchor } from './rpc-board-anchor';
import { readOutDebtAnchor, type OutDebtStorageAnchor, type OutDebtStorageView } from './rpc-debt-anchor';
import { readDepositoryAnchorBase } from './rpc-depository-base';
import { readEntityActionNonces } from './rpc-nonce-anchor';
import { readReserveAnchor } from './rpc-reserve-anchor';

// One root per Entity over every value the storage anchors prove at its
// certified J block: the B1 certified-board registry root, the E1 reserves,
// the D1/D2 open debt ledgers (positions, creditors, remaining amounts,
// generations, activeDebts, inActiveDebts) and the Depository batch and
// EntityProvider action replay nonces (the Foundation's action nonce excepted,
// see the nonce anchor). The history side is built from the
// Entity fold, the storage side only from eth_getProof reads under a header
// that hashes to the fenced block hash; equal roots mean equal proven values.
//
// Limits, stated rather than defaulted:
// - DebtEntry identity/provenance (debtId, createdTxHash, createdAmount,
//   paidAmount, lastUpdated*) is history-only and not in this root.
// - Creditor-side in-debts are non-enumerable: the storage side reads the
//   debtors the fold names and scans their queues for this creditor; the scan
//   is complete only together with inActiveDebts, which is in the root.
// - _tokens.length is storage-only and bounds the reserve enumeration on both
//   sides; dev-chain mintToReserve outside it stays uncovered (see E1 anchor).
// Observation only: nothing here replaces the history fold.

export {
  buildDebtAnchorRoot,
  buildEntityProvenValuesFromFold,
  buildProvenValuesRoot,
  debtViewFromLedgers,
  type EntityDebtAnchorView,
  type EntityProvenValues,
} from '../../../machine/state-anchor/proven-values-root';

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

/** The storage-side root plus the proven values it was built from. */
type StorageProvenValues = {
  values: EntityProvenValues;
  tokenCount: bigint;
  /** Hash-bound header the proofs were verified under. */
  header: { anchorHeight: number; anchorBlockHash: string; stateRoot: string };
  boardRecords: CertifiedBoardRecord[];
  reserves: Map<number, bigint>;
  debts: OutDebtStorageView;
  batchNonce: bigint;
  storedActionNonce: bigint;
};

const fail = (code: string, detail = ''): never => {
  throw new Error(`PROVEN_VALUES_${code}${detail ? `:${detail}` : ''}`);
};

/** Storage side: only proven queue words, counters and generations. */
export const debtViewFromStorage = (anchor: OutDebtStorageAnchor, entityId: string): EntityDebtAnchorView => {
  const entity = provenValuesBytes32(entityId, 'entity');
  const own = anchor.debtors.get(entity) ?? fail('DEBT_ENTITY_MISSING', entity);
  const leavesOf = (debtor: string, predicate: (creditor: string) => boolean, counterparty: (creditor: string) => string): DebtAnchorLeaf[] => {
    const view = anchor.debtors.get(debtor) ?? fail('DEBT_ENTITY_MISSING', debtor);
    const leaves: DebtAnchorLeaf[] = [];
    for (const [tokenId, queue] of view.byToken) {
      for (const entry of queue.entries) {
        if (!predicate(entry.creditor)) continue;
        const generation = view.generations.get(tokenId)?.get(entry.index) ?? fail('DEBT_GENERATION_MISSING', `${debtor}:${tokenId}:${entry.index}`);
        leaves.push({ counterparty: counterparty(entry.creditor), tokenId, index: entry.index, amount: entry.amount, generation });
      }
    }
    return leaves;
  };
  const out = leavesOf(entity, () => true, creditor => creditor);
  const inbound = [...anchor.debtors.keys()]
    .filter(debtor => debtor !== entity)
    .flatMap(debtor => leavesOf(debtor, creditor => creditor === entity, () => debtor));
  return { entityId: entity, activeDebts: own.activeDebts, inActiveDebts: own.inActiveDebts, out, in: inbound };
};

/**
 * Storage side at one fenced block: one hash-bound header and _tokens.length
 * proof shared by the reserve and debt reads, plus the EntityProvider registry.
 * `inDebtorIds` names the debtors whose queues may hold this creditor's
 * in-debts (non-enumerable on-chain); inActiveDebts in the root bounds them.
 */
export const readEntityProvenValuesFromStorage = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>;
  entityId: string;
  blockNumber: number;
  authenticatedBlockHash: string;
  inDebtorIds: readonly string[];
  heldTokenIds?: readonly number[];
}): Promise<StorageProvenValues> => {
  const entityId = provenValuesBytes32(input.entityId, 'entity');
  const base = await readDepositoryAnchorBase({
    send: input.send,
    depositoryAddress: String(input.jurisdiction.depositoryAddress ?? ''),
    blockNumber: input.blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    fail,
  });
  const board = await readCertifiedBoardAnchor({
    send: input.send,
    jurisdiction: input.jurisdiction,
    blockNumber: input.blockNumber,
    authenticatedStateRoot: base.stateRoot,
  });
  const reserves = await readReserveAnchor({
    send: input.send,
    jurisdiction: input.jurisdiction,
    blockNumber: input.blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    entityIds: [entityId],
    base,
  });
  const actionNonces = await readEntityActionNonces({
    send: input.send,
    entityProviderAddress: String(input.jurisdiction.entityProviderAddress ?? ''),
    blockNumber: input.blockNumber,
    stateRoot: base.stateRoot,
    entityIds: [entityId],
  });
  const debts = await readOutDebtAnchor({
    send: input.send,
    jurisdiction: input.jurisdiction,
    blockNumber: input.blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    debtorIds: [...new Set([entityId, ...input.inDebtorIds.map(debtor => provenValuesBytes32(debtor, 'debtor'))])],
    ...(input.heldTokenIds === undefined ? {} : { heldTokenIds: input.heldTokenIds }),
    base,
  });
  const batchNonce = reserves.batchNonces.get(entityId) ?? fail('NONCE_MISSING', `batch:${entityId}`);
  const storedActionNonce = actionNonces.get(entityId) ?? fail('NONCE_MISSING', `action:${entityId}`);
  const values = buildProvenValuesRoot({
    jurisdiction: input.jurisdiction,
    entityId,
    blockNumber: input.blockNumber,
    blockHash: base.authenticatedBlockHash,
    boardRegistryRoot: board.root,
    reserveRoot: reserves.root,
    debtRoot: buildDebtAnchorRoot(debtViewFromStorage(debts, entityId)),
    nonceRoot: buildNonceAnchorRoot([nonceViewFromStorage(entityId, batchNonce, storedActionNonce)]),
  });
  return {
    values,
    tokenCount: base.tokenCount,
    header: { anchorHeight: input.blockNumber, anchorBlockHash: base.authenticatedBlockHash, stateRoot: base.stateRoot },
    boardRecords: [...board.records.values()],
    reserves: reserves.reserves.get(entityId) ?? fail('RESERVE_ENTITY_MISSING', entityId),
    debts: debts.debtors.get(entityId) ?? fail('DEBT_ENTITY_MISSING', entityId),
    batchNonce,
    storedActionNonce,
  };
};

export type JHistoryAnchorStart =
  | { kind: 'anchor'; header: StorageProvenValues['header']; values: JHistoryAnchorValues }
  | { kind: 'history'; reason: 'DEBT_PRESENT' | 'ACTION_NONCE_UNPROVEN' };

/**
 * Producer side of a 'j_anchor' start for an Entity with no J finality: the
 * carried values come only from the storage read above, and their root must
 * equal its storage root. What the anchor cannot admit stays on full history:
 * any open debt in either direction (in-debts are non-enumerable and debt
 * identity/provenance is history-only) and the Foundation, whose action nonce
 * is not fold-derivable. Reserves outside _tokens.length are not enumerable
 * here (E1 limit); a caller must not rely on this read where they can exist.
 */
export const readJHistoryAnchorStartFromStorage = async (input: {
  send: RpcSend;
  jurisdiction: JurisdictionConfig;
  entityId: string;
  blockNumber: number;
  authenticatedBlockHash: string;
}): Promise<JHistoryAnchorStart> => {
  const read = await readEntityProvenValuesFromStorage({ ...input, inDebtorIds: [] });
  if (read.debts.activeDebts !== 0n || read.debts.inActiveDebts !== 0n) return { kind: 'history', reason: 'DEBT_PRESENT' };
  const { actionNonce } = nonceViewFromStorage(input.entityId, read.batchNonce, read.storedActionNonce);
  if (actionNonce === null) return { kind: 'history', reason: 'ACTION_NONCE_UNPROVEN' };
  const values: JHistoryAnchorValues = {
    tokenCount: read.tokenCount,
    boardRecords: read.boardRecords,
    reserves: read.reserves,
    batchNonce: read.batchNonce,
    actionNonce,
  };
  const carried = buildCarriedProvenValues({
    jurisdiction: input.jurisdiction,
    entityId: input.entityId,
    blockNumber: read.header.anchorHeight,
    blockHash: read.header.anchorBlockHash,
    values,
  });
  if (carried.root !== read.values.root) fail('ANCHOR_CARRIED_ROOT_MISMATCH', `${carried.root}:${read.values.root}`);
  return { kind: 'anchor', header: read.header, values };
};
