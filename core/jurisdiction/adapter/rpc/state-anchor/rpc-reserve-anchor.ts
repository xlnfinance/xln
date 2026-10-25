import { ethers } from 'ethers';

import type { JurisdictionConfig } from '../../../../entity/types';
import { buildReserveAnchorRoot, projectNonZeroReserves } from '../../../machine/state-anchor/reserve-root';
import { resolveDepositoryAnchorBase, type DepositoryAnchorBase } from './rpc-depository-base';
import { verifyGetProofResponse, type GetProofResponse } from './rpc-state-proof';
import { depositoryEntityNonceSlot, depositoryReserveSlot } from './rpc-storage-slots';

// Reads Depository._reserves for a set of entities at one block, proven by
// eth_getProof against the stateRoot of a header that hashes to the caller's
// fenced block hash. Every reserve write in Account.sol emits ReserveUpdated
// with the stored balance, so the Entity fold of those events must equal this
// view; the real-chain L1 asserts that equality.
//
// Two representation limits, both explicit rather than defaulted:
// - Storage cannot tell a never-touched reserve from a drained one, while the
//   Entity fold keeps a drained token as an explicit 0n. The anchor view holds
//   non-zero balances only; compare history through projectNonZeroReserves.
// - Token ids are enumerated over [0, _tokens.length). Depository.mintToReserve
//   (local dev admin only) does not bound tokenId, so on a dev chain a reserve
//   outside that range is not covered by this anchor.
// The same proofs also carry each listed Entity's entityNonces word, so the
// nonce anchor needs no extra Depository proof; it is not in the reserve root.

export { buildReserveAnchorRoot, projectNonZeroReserves } from '../../../machine/state-anchor/reserve-root';

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

export type ReserveStorageAnchor = {
  blockNumber: number;
  stateRoot: string;
  tokenCount: bigint;
  reserves: Map<string, Map<number, bigint>>;
  /** Depository entityNonces of each listed Entity, proven in the same chunks. */
  batchNonces: Map<string, bigint>;
  root: string;
};

const DEFAULT_SLOTS_PER_PROOF = 256;
const DEFAULT_CONCURRENCY = 4;
const EMPTY_CODE_HASH = ethers.keccak256('0x').toLowerCase();

const fail = (code: string, detail = ''): never => {
  throw new Error(`RESERVE_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
};

const entityKey = (entityId: string): string => {
  const normalized = String(entityId).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) fail('ENTITY_INVALID', String(entityId));
  return normalized;
};

export const readReserveAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'depositoryAddress'>;
  blockNumber: number;
  authenticatedBlockHash: string;
  entityIds: readonly string[];
  /** Header stateRoot and _tokens.length already proven at this block (one audit height). */
  base?: DepositoryAnchorBase;
  slotsPerProof?: number;
  concurrency?: number;
}): Promise<ReserveStorageAnchor> => {
  const { send, blockNumber } = input;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail('BLOCK_INVALID', String(blockNumber));
  const address = ethers.getAddress(String(input.jurisdiction.depositoryAddress ?? ''));
  const entityIds = input.entityIds.map(entityKey);
  if (new Set(entityIds).size !== entityIds.length) fail('ENTITY_DUPLICATE');
  const { stateRoot, tokenCount } = await resolveDepositoryAnchorBase({
    send,
    depositoryAddress: address,
    blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    base: input.base,
    fail,
  });
  const blockTag = ethers.toQuantity(blockNumber);
  const prove = async (slots: bigint[]): Promise<Map<bigint, bigint>> => {
    const response = (await send('eth_getProof', [
      address,
      slots.map(slot => ethers.toBeHex(slot, 32)),
      blockTag,
    ])) as GetProofResponse;
    const proven = verifyGetProofResponse(stateRoot, address, slots, response);
    // A code-less account proves every reserve zero; that is a wrong address.
    if (!proven.account || proven.account.codeHash.toLowerCase() === EMPTY_CODE_HASH) {
      fail('CONTRACT_MISSING', address);
    }
    return proven.storage;
  };

  // tokenId null marks the Entity's entityNonces cell.
  const cells: Array<{ entityId: string; tokenId: number | null; slot: bigint }> = [];
  for (const entityId of entityIds) {
    cells.push({ entityId, tokenId: null, slot: depositoryEntityNonceSlot(entityId) });
    for (let tokenId = 0; tokenId < Number(tokenCount); tokenId += 1) {
      cells.push({ entityId, tokenId, slot: depositoryReserveSlot(entityId, BigInt(tokenId)) });
    }
  }
  const perProof = input.slotsPerProof ?? DEFAULT_SLOTS_PER_PROOF;
  if (!Number.isSafeInteger(perProof) || perProof < 1) fail('SLOTS_PER_PROOF_INVALID', String(perProof));
  const chunks: Array<typeof cells> = [];
  for (let start = 0; start < cells.length; start += perProof) chunks.push(cells.slice(start, start + perProof));
  const chunkValues = new Array<Map<bigint, bigint>>(chunks.length);
  let nextChunk = 0;
  const worker = async (): Promise<void> => {
    while (nextChunk < chunks.length) {
      const index = nextChunk;
      nextChunk += 1;
      const chunk = chunks[index] ?? fail('CHUNK_MISSING', String(index));
      chunkValues[index] = await prove(chunk.map(cell => cell.slot));
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, chunks.length) }, worker));

  const reserves = new Map<string, Map<number, bigint>>(entityIds.map(entityId => [entityId, new Map()]));
  const batchNonces = new Map<string, bigint>();
  chunks.forEach((chunk, index) => {
    const values = chunkValues[index] ?? fail('CHUNK_MISSING', String(index));
    for (const cell of chunk) {
      const value = values.get(cell.slot) ?? fail('SLOT_MISSING', ethers.toBeHex(cell.slot, 32));
      if (cell.tokenId === null) batchNonces.set(cell.entityId, value);
      else if (value !== 0n) (reserves.get(cell.entityId) ?? fail('ENTITY_MISSING', cell.entityId)).set(cell.tokenId, value);
    }
  });
  return { blockNumber, stateRoot, tokenCount, reserves, batchNonces, root: buildReserveAnchorRoot(tokenCount, reserves) };
};

const describeReserves = (reserves: ReadonlyMap<number, bigint>): string =>
  [...reserves].sort(([left], [right]) => left - right).map(([tokenId, balance]) => `${tokenId}=${balance.toString()}`).join(',');

/**
 * Fail-closed equality between Entity reserves finalized at one J block and
 * Depository storage at that block. The caller supplies the fenced
 * authenticated block hash; the stateRoot comes only from a header that hashes
 * to it. Replicas of one Entity must agree. Observation only: the fold is not
 * replaced.
 */
export const assertEntityReservesMatchAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'depositoryAddress'>;
  blockNumber: number;
  authenticatedBlockHash: string;
  entities: ReadonlyArray<{ entityId: string; reserves: ReadonlyMap<number, bigint> }>;
  base?: DepositoryAnchorBase;
  slotsPerProof?: number;
  concurrency?: number;
}): Promise<ReserveStorageAnchor> => {
  const local = new Map<string, Map<number, bigint>>();
  for (const entity of input.entities) {
    const entityId = entityKey(entity.entityId);
    const projected = projectNonZeroReserves(entity.reserves);
    const existing = local.get(entityId);
    if (existing && describeReserves(existing) !== describeReserves(projected)) {
      fail('REPLICA_DIVERGENCE', `${input.blockNumber}:${entityId}`);
    }
    local.set(entityId, projected);
  }
  const anchor = await readReserveAnchor({
    send: input.send,
    jurisdiction: input.jurisdiction,
    blockNumber: input.blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    entityIds: [...local.keys()],
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.slotsPerProof === undefined ? {} : { slotsPerProof: input.slotsPerProof }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
  });
  for (const [entityId, reserves] of local) {
    const stored = anchor.reserves.get(entityId) ?? fail('ENTITY_MISSING', entityId);
    if (describeReserves(reserves) !== describeReserves(stored)) {
      fail('MISMATCH', `${input.blockNumber}:${entityId}:local=${describeReserves(reserves)}:storage=${describeReserves(stored)}`);
    }
  }
  const localRoot = buildReserveAnchorRoot(anchor.tokenCount, local);
  if (localRoot !== anchor.root) fail('ROOT_MISMATCH', `${input.blockNumber}:${localRoot}:${anchor.root}`);
  return anchor;
};
