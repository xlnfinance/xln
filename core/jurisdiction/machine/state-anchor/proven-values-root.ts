import { ethers } from 'ethers';

import type { EntityState, JurisdictionConfig } from '../../../entity/types';
import type { CertifiedBoardNodeStore, CertifiedBoardRecord } from '../../../types/entity-board-registry';
import type { DebtEntry } from '../../../types/finance/debt';
import { createEmptyCertifiedBoardRegistryState, putCertifiedBoardRecord } from '../board-registry';
import { buildNonceAnchorRoot, nonceViewFromFold } from './nonce-root';
import { buildReserveAnchorRoot, projectNonZeroReserves } from './reserve-root';

// Pure proven-values root: one root per Entity over the B1 certified-board
// registry root, the E1 reserves, the D1/D2 open debt ledgers and the replay
// nonces at one certified J block. The eth_getProof storage side lives in the
// adapter (rpc-proven-values-root.ts); the history fold side and the anchor
// claim's carried values are built here, so the Entity layer never imports the
// RPC adapter. DebtEntry identity/provenance (debtId, createdTxHash,
// createdAmount, paidAmount, lastUpdated*) is history-only and not in this root.

export type DebtAnchorLeaf = { counterparty: string; tokenId: number; index: number; amount: bigint; generation: string };

export type EntityDebtAnchorView = {
  entityId: string;
  activeDebts: bigint;
  inActiveDebts: bigint;
  /** Owed by this Entity; counterparty = creditor. */
  out: DebtAnchorLeaf[];
  /** Owed to this Entity; counterparty = debtor. */
  in: DebtAnchorLeaf[];
};

export type EntityProvenValues = {
  entityId: string;
  blockNumber: number;
  blockHash: string;
  boardRegistryRoot: string;
  reserveRoot: string;
  debtRoot: string;
  nonceRoot: string;
  root: string;
};

/** Families an anchor claim carries; their canonical root is the claim's provenValuesRoot. */
export type JHistoryAnchorValues = {
  tokenCount: bigint;
  /** Complete EntityProvider registry at the anchor block, every registered entity. */
  boardRecords: readonly CertifiedBoardRecord[];
  reserves: ReadonlyMap<number, bigint>;
  batchNonce: bigint;
  /** null = not fold-derivable (Foundation); such an Entity stays on full history. */
  actionNonce: bigint | null;
};

type AnchorJurisdiction = Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>;

const PROVEN_VALUES_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('xln:j-proven-values:v1')).toLowerCase();
const DEBT_ANCHOR_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('xln:j-debt-anchor:v1')).toLowerCase();
const ABI = ethers.AbiCoder.defaultAbiCoder();

const fail = (code: string, detail = ''): never => {
  throw new Error(`PROVEN_VALUES_${code}${detail ? `:${detail}` : ''}`);
};

export const provenValuesBytes32 = (value: string, label: string): string => {
  const normalized = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) fail('BYTES32_INVALID', `${label}:${String(value)}`);
  return normalized;
};
const bytes32 = provenValuesBytes32;

const parseGeneration = (generation: string): [bigint, bigint] => {
  const match = /^(\d+):(\d+)$/.exec(generation);
  if (!match?.[1] || !match[2]) return fail('GENERATION_INVALID', generation);
  return [BigInt(match[1]), BigInt(match[2])];
};

const sortLeaves = (leaves: DebtAnchorLeaf[]): DebtAnchorLeaf[] =>
  leaves.sort((left, right) =>
    left.tokenId - right.tokenId || left.index - right.index
    || (left.counterparty < right.counterparty ? -1 : left.counterparty > right.counterparty ? 1 : 0));

const encodeLeaves = (leaves: readonly DebtAnchorLeaf[]): string =>
  ethers.keccak256(ABI.encode(
    ['tuple(bytes32,uint256,uint256,uint256,uint64,uint192)[]'],
    [leaves.map(leaf => {
      const [createdBlock, createdSeq] = parseGeneration(leaf.generation);
      return [leaf.counterparty, BigInt(leaf.tokenId), BigInt(leaf.index), leaf.amount, createdBlock, createdSeq];
    })],
  ));

export const buildDebtAnchorRoot = (view: EntityDebtAnchorView): string => {
  const out = sortLeaves([...view.out]);
  const inbound = sortLeaves([...view.in]);
  const positions = (leaves: readonly DebtAnchorLeaf[], side: string) => {
    const keys = leaves.map(leaf => `${leaf.counterparty}:${leaf.tokenId}:${leaf.index}`);
    if (new Set(keys).size !== keys.length) fail('DEBT_POSITION_DUPLICATE', `${view.entityId}:${side}`);
  };
  positions(out, 'out');
  positions(inbound, 'in');
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'bytes32', 'uint256', 'uint256', 'bytes32', 'bytes32'],
    [DEBT_ANCHOR_DOMAIN, bytes32(view.entityId, 'entity'), view.activeDebts, view.inActiveDebts, encodeLeaves(out), encodeLeaves(inbound)],
  )).toLowerCase();
};

const generationOf = (entry: DebtEntry): string => {
  if (typeof entry.createdSeq !== 'bigint' || entry.createdSeq <= 0n) fail('LOCAL_SEQ_INVALID', entry.debtId);
  return `${entry.createdAtBlock}:${entry.createdSeq.toString()}`;
};

/** History side: the Entity fold's open ledgers in anchor form. */
export const debtViewFromLedgers = (
  entityId: string,
  outDebtsByToken: ReadonlyMap<number, ReadonlyMap<string, DebtEntry>> | undefined,
  inDebtsByToken: ReadonlyMap<number, ReadonlyMap<string, DebtEntry>> | undefined,
): EntityDebtAnchorView => {
  const out: DebtAnchorLeaf[] = [];
  const inbound: DebtAnchorLeaf[] = [];
  for (const [tokenId, bucket] of outDebtsByToken ?? []) {
    for (const entry of bucket.values()) {
      out.push({ counterparty: bytes32(entry.creditor, 'creditor'), tokenId, index: entry.createdDebtIndex, amount: entry.remainingAmount, generation: generationOf(entry) });
    }
  }
  for (const [tokenId, bucket] of inDebtsByToken ?? []) {
    for (const entry of bucket.values()) {
      inbound.push({ counterparty: bytes32(entry.debtor, 'debtor'), tokenId, index: entry.createdDebtIndex, amount: entry.remainingAmount, generation: generationOf(entry) });
    }
  }
  return { entityId: bytes32(entityId, 'entity'), activeDebts: BigInt(out.length), inActiveDebts: BigInt(inbound.length), out, in: inbound };
};

export const buildProvenValuesRoot = (input: {
  jurisdiction: AnchorJurisdiction;
  entityId: string;
  blockNumber: number;
  blockHash: string;
  boardRegistryRoot: string;
  reserveRoot: string;
  debtRoot: string;
  nonceRoot: string;
}): EntityProvenValues => {
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber <= 0) fail('BLOCK_INVALID', String(input.blockNumber));
  const chainId = BigInt(input.jurisdiction.chainId ?? fail('CHAIN_MISSING'));
  const depository = ethers.getAddress(String(input.jurisdiction.depositoryAddress ?? ''));
  const entityProvider = ethers.getAddress(String(input.jurisdiction.entityProviderAddress ?? ''));
  const values = {
    entityId: bytes32(input.entityId, 'entity'),
    blockNumber: input.blockNumber,
    blockHash: bytes32(input.blockHash, 'blockHash'),
    boardRegistryRoot: bytes32(input.boardRegistryRoot, 'boardRegistryRoot'),
    reserveRoot: bytes32(input.reserveRoot, 'reserveRoot'),
    debtRoot: bytes32(input.debtRoot, 'debtRoot'),
    nonceRoot: bytes32(input.nonceRoot, 'nonceRoot'),
  };
  const root = ethers.keccak256(ABI.encode(
    ['bytes32', 'uint256', 'address', 'address', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    [PROVEN_VALUES_DOMAIN, chainId, depository, entityProvider, values.entityId, BigInt(values.blockNumber),
      values.blockHash, values.boardRegistryRoot, values.reserveRoot, values.debtRoot, values.nonceRoot],
  )).toLowerCase();
  return { ...values, root };
};

/** History side at the Entity's own certified J anchor. tokenCount comes from the proven Depository base. */
export const buildEntityProvenValuesFromFold = (
  state: Pick<EntityState, 'entityId' | 'reserves' | 'outDebtsByToken' | 'inDebtsByToken' | 'certifiedBoardState' | 'jBatchState' | 'entityProviderActionState'>,
  jurisdiction: AnchorJurisdiction,
  tokenCount: bigint,
): EntityProvenValues => {
  const registry = state.certifiedBoardState ?? fail('BOARD_REGISTRY_MISSING', state.entityId);
  const entityId = bytes32(state.entityId, 'entity');
  return buildProvenValuesRoot({
    jurisdiction,
    entityId,
    blockNumber: registry.finalizedJHeight,
    blockHash: registry.finalizedJBlockHash,
    boardRegistryRoot: registry.boardRegistryRoot,
    reserveRoot: buildReserveAnchorRoot(tokenCount, new Map([[entityId, projectNonZeroReserves(state.reserves)]])),
    debtRoot: buildDebtAnchorRoot(debtViewFromLedgers(entityId, state.outDebtsByToken, state.inDebtsByToken)),
    nonceRoot: buildNonceAnchorRoot([nonceViewFromFold(state)]),
  });
};

/**
 * Board registry built from an anchor claim's carried records: the same
 * putCertifiedBoardRecord chain from the empty registry root that the
 * storage reader and the anchor writer use.
 */
export const buildCarriedBoardRegistry = (
  jurisdiction: JurisdictionConfig,
  records: readonly CertifiedBoardRecord[],
): { root: string; nodes: CertifiedBoardNodeStore } => {
  const empty = createEmptyCertifiedBoardRegistryState(jurisdiction);
  const nodes: CertifiedBoardNodeStore = new Map();
  let root = empty.boardRegistryRoot;
  for (const record of records) {
    if (record.stackKey !== empty.stackKey) fail('BOARD_STACK_MISMATCH', record.entityId);
    const put = putCertifiedBoardRecord(nodes, root, record);
    for (const [hash, node] of put.newNodes) nodes.set(hash, node);
    root = put.root;
  }
  return { root, nodes };
};

/**
 * Root over the values an anchor claim carries, before anything is written.
 * Debts are never carried (identity/provenance is history-only), so the debt
 * leaf is the empty ledger; an Entity with debts cannot start from an anchor.
 */
export const buildCarriedProvenValues = (input: {
  jurisdiction: JurisdictionConfig;
  entityId: string;
  blockNumber: number;
  blockHash: string;
  values: JHistoryAnchorValues;
}): EntityProvenValues => {
  const entityId = bytes32(input.entityId, 'entity');
  const { values } = input;
  return buildProvenValuesRoot({
    jurisdiction: input.jurisdiction,
    entityId,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    boardRegistryRoot: buildCarriedBoardRegistry(input.jurisdiction, values.boardRecords).root,
    reserveRoot: buildReserveAnchorRoot(values.tokenCount, new Map([[entityId, projectNonZeroReserves(values.reserves)]])),
    debtRoot: buildDebtAnchorRoot(debtViewFromLedgers(entityId, undefined, undefined)),
    nonceRoot: buildNonceAnchorRoot([{ entityId, batchNonce: values.batchNonce, actionNonce: values.actionNonce }]),
  });
};
