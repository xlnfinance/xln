import { ethers } from 'ethers';

import type { JurisdictionConfig } from '../../../../entity/types';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardStackKey,
  putCertifiedBoardRecord,
} from '../../../machine/board-registry';
import type {
  CertifiedBoardPatriciaNode,
  CertifiedBoardRecord,
  CertifiedBoardRegistryState,
} from '../../../../types/entity-board-registry';
import { readHashBoundStateRoot } from './rpc-header-hash';
import { verifyGetProofResponse, type GetProofResponse } from './rpc-state-proof';
import {
  entityProviderBoardEpochSlot,
  entityProviderFieldSlot,
  entityProviderNextNumberSlot,
} from './rpc-storage-slots';

// Rebuilds the certified-board registry from EntityProvider storage at one
// block, proven by eth_getProof against a caller-authenticated stateRoot. The
// result must equal the history fold of FoundationBootstrapped/EntityRegistered/
// BoardActivated up to the same block; the real-chain L1 asserts that equality.

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

export type CertifiedBoardStorageAnchor = {
  blockNumber: number;
  stateRoot: string;
  nextNumber: bigint;
  root: string;
  records: Map<string, CertifiedBoardRecord>;
  newNodes: Map<string, CertifiedBoardPatriciaNode>;
};

const DEFAULT_ENTITIES_PER_PROOF = 64;
const DEFAULT_CONCURRENCY = 4;
const EMPTY_CODE_HASH = ethers.keccak256('0x').toLowerCase();

const fail = (code: string, detail = ''): never => {
  throw new Error(`BOARD_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
};

const safeNumber = (value: bigint, code: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code, value.toString());
  return Number(value);
};

const entitySlots = (entityId: string): [bigint, bigint, bigint, bigint] => [
  entityProviderFieldSlot(entityId, 'currentBoardHash'),
  entityProviderFieldSlot(entityId, 'previousBoardHash'),
  entityProviderFieldSlot(entityId, 'previousBoardValidUntil'),
  entityProviderBoardEpochSlot(entityId),
];

const slotValue = (values: ReadonlyMap<bigint, bigint>, slot: bigint): bigint =>
  values.get(slot) ?? fail('SLOT_MISSING', ethers.toBeHex(slot, 32));

export const readCertifiedBoardAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>;
  blockNumber: number;
  authenticatedStateRoot: string;
  entitiesPerProof?: number;
  concurrency?: number;
}): Promise<CertifiedBoardStorageAnchor> => {
  const { send, jurisdiction, blockNumber } = input;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail('BLOCK_INVALID', String(blockNumber));
  const address = ethers.getAddress(String(jurisdiction.entityProviderAddress ?? ''));
  const stateRoot = String(input.authenticatedStateRoot).toLowerCase();
  const blockTag = ethers.toQuantity(blockNumber);
  const prove = async (slots: bigint[]): Promise<Map<bigint, bigint>> => {
    const response = (await send('eth_getProof', [
      address,
      slots.map(slot => ethers.toBeHex(slot, 32)),
      blockTag,
    ])) as GetProofResponse;
    const proven = verifyGetProofResponse(stateRoot, address, slots, response);
    // An absent or code-less account would prove every slot zero, i.e. an empty
    // registry; that is a wrong address, not an empty EntityProvider.
    if (!proven.account || proven.account.codeHash.toLowerCase() === EMPTY_CODE_HASH) {
      fail('CONTRACT_MISSING', address);
    }
    return proven.storage;
  };

  const nextNumber = slotValue(await prove([entityProviderNextNumberSlot()]), entityProviderNextNumberSlot());
  // The constructor initializes nextNumber = 1; zero means a non-EntityProvider.
  if (nextNumber < 1n) fail('NEXT_NUMBER_INVALID', nextNumber.toString());
  const entityCount = safeNumber(nextNumber - 1n, 'NEXT_NUMBER_INVALID');
  const entityIds = Array.from({ length: entityCount }, (_, index) => ethers.toBeHex(BigInt(index + 1), 32).toLowerCase());

  const perProof = input.entitiesPerProof ?? DEFAULT_ENTITIES_PER_PROOF;
  const chunks: string[][] = [];
  for (let start = 0; start < entityIds.length; start += perProof) chunks.push(entityIds.slice(start, start + perProof));
  const chunkValues = new Array<Map<bigint, bigint>>(chunks.length);
  let nextChunk = 0;
  const worker = async (): Promise<void> => {
    while (nextChunk < chunks.length) {
      const index = nextChunk;
      nextChunk += 1;
      const chunk = chunks[index] ?? fail('CHUNK_MISSING', String(index));
      chunkValues[index] = await prove(chunk.flatMap(entitySlots));
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, chunks.length) }, worker));

  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  const records = new Map<string, CertifiedBoardRecord>();
  const newNodes = new Map<string, CertifiedBoardPatriciaNode>();
  let root = EMPTY_CERTIFIED_BOARD_ROOT;
  chunks.forEach((chunk, chunkIndex) => {
    const values = chunkValues[chunkIndex] ?? fail('CHUNK_MISSING', String(chunkIndex));
    for (const entityId of chunk) {
      const [current, previous, previousValidUntil, epochSlot] = entitySlots(entityId);
      const boardEpoch = slotValue(values, epochSlot);
      const record: CertifiedBoardRecord = {
        stackKey,
        entityId,
        boardHash: ethers.toBeHex(slotValue(values, current), 32).toLowerCase(),
        boardEpoch: safeNumber(boardEpoch, 'BOARD_EPOCH_INVALID'),
        previousBoardHash: ethers.toBeHex(slotValue(values, previous), 32).toLowerCase(),
        previousBoardValidUntil: safeNumber(slotValue(values, previousValidUntil), 'PREVIOUS_VALID_UNTIL_INVALID'),
        // Only activateBoard increments boardEpochs; before that the leaf
        // carries its creation event, and entity #1 is the Foundation.
        source: boardEpoch > 0n ? 'BoardActivated' : entityId === entityIds[0] ? 'FoundationBootstrapped' : 'EntityRegistered',
      };
      records.set(entityId, record);
      const put = putCertifiedBoardRecord(newNodes, root, record);
      for (const [hash, node] of put.newNodes) newNodes.set(hash, node);
      root = put.root;
    }
  });
  return { blockNumber, stateRoot, nextNumber, root, records, newNodes };
};

/**
 * Fail-closed equality between an Entity's finalized certified-board registry
 * and EntityProvider storage at the same block. The caller supplies the fenced
 * authenticated block hash; the registry must claim exactly that block, and the
 * stateRoot is taken only from a header that hashes to it. Observation only:
 * the fold is not replaced.
 */
export const assertCertifiedBoardRegistryMatchesAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>;
  registry: CertifiedBoardRegistryState;
  authenticatedBlockHash: string;
  entitiesPerProof?: number;
  concurrency?: number;
}): Promise<CertifiedBoardStorageAnchor> => {
  const { registry } = input;
  const stackKey = getCertifiedBoardStackKey(input.jurisdiction);
  if (registry.stackKey !== stackKey) fail('STACK_MISMATCH', `${registry.stackKey}:${stackKey}`);
  if (registry.finalizedJBlockHash.toLowerCase() !== String(input.authenticatedBlockHash).toLowerCase()) {
    fail('BLOCK_HASH_MISMATCH', `${registry.finalizedJHeight}:${registry.finalizedJBlockHash}:${input.authenticatedBlockHash}`);
  }
  const stateRoot = await readHashBoundStateRoot(input.send, registry.finalizedJHeight, input.authenticatedBlockHash);
  const anchor = await readCertifiedBoardAnchor({
    send: input.send,
    jurisdiction: input.jurisdiction,
    blockNumber: registry.finalizedJHeight,
    authenticatedStateRoot: stateRoot,
    ...(input.entitiesPerProof === undefined ? {} : { entitiesPerProof: input.entitiesPerProof }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
  });
  if (anchor.root !== registry.boardRegistryRoot) {
    fail('ROOT_MISMATCH', `${registry.finalizedJHeight}:${registry.boardRegistryRoot}:${anchor.root}`);
  }
  return anchor;
};
