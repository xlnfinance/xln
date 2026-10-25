import { ethers } from 'ethers';

import type { JurisdictionConfig } from '../../../../entity/types';
import { buildNonceAnchorRoot, nonceViewFromStorage, type EntityNonceView } from '../../../machine/state-anchor/nonce-root';
import { resolveDepositoryAnchorBase, type DepositoryAnchorBase } from './rpc-depository-base';
import { verifyGetProofResponse, type GetProofResponse } from './rpc-state-proof';
import { depositoryEntityNonceSlot, entityProviderActionNonceSlot } from './rpc-storage-slots';

// Per-Entity replay nonces at one fenced block, proven by eth_getProof against
// the stateRoot of a header that hashes to the caller's block hash:
// - Depository entityNonces (slot 11). Its only writer (Depository.sol
//   processBatch) emits HankoBatchProcessed with the new nonce; the fold keeps
//   the highest one in jBatchState.entityNonce.
// - EntityProvider entityActionNonces (slot 5). Every per-Entity writer emits
//   EntityProviderActionExecuted/Cancelled; the fold keeps the last one in
//   entityProviderActionState.confirmedNonce.
// The Foundation is the exception: _authorizeFoundation advances the same
// slot and emits only FoundationActionExecuted, which is telemetry and never
// folded (event-catalog.ts). Its action nonce is not fold-derivable, so both
// sides record it as unproven instead of defaulting a value; an anchor start
// cannot admit the Foundation's action nonce from this root.
// Observation only: nothing here replaces the history fold.

export {
  buildNonceAnchorRoot,
  nonceViewFromFold,
  nonceViewFromStorage,
} from '../../../machine/state-anchor/nonce-root';

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

export type EntityNonceStorageAnchor = {
  blockNumber: number;
  authenticatedBlockHash: string;
  views: Map<string, EntityNonceView>;
  /** Raw proven entityActionNonces, including the Foundation's unfolded count. */
  storedActionNonces: Map<string, bigint>;
  root: string;
};

const EMPTY_CODE_HASH = ethers.keccak256('0x').toLowerCase();

const fail = (code: string, detail = ''): never => {
  throw new Error(`NONCE_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
};

const entityKey = (value: string): string => {
  const normalized = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) fail('ENTITY_INVALID', String(value));
  return normalized;
};

const proveContractSlots = async (
  send: RpcSend,
  address: string,
  stateRoot: string,
  blockNumber: number,
  slots: bigint[],
): Promise<Map<bigint, bigint>> => {
  const response = (await send('eth_getProof', [
    address,
    slots.map(slot => ethers.toBeHex(slot, 32)),
    ethers.toQuantity(blockNumber),
  ])) as GetProofResponse;
  const proven = verifyGetProofResponse(stateRoot, address, slots, response);
  // A code-less account proves every nonce zero; that is a wrong address.
  if (!proven.account || proven.account.codeHash.toLowerCase() === EMPTY_CODE_HASH) fail('CONTRACT_MISSING', address);
  return proven.storage;
};

/**
 * Raw EntityProvider entityActionNonces of each Entity in one proof. The
 * caller supplies a stateRoot already bound to its fenced block hash.
 */
export const readEntityActionNonces = async (input: {
  send: RpcSend;
  entityProviderAddress: string;
  blockNumber: number;
  stateRoot: string;
  entityIds: readonly string[];
}): Promise<Map<string, bigint>> => {
  const entityIds = input.entityIds.map(entityKey);
  if (entityIds.length === 0) fail('ENTITIES_EMPTY');
  if (new Set(entityIds).size !== entityIds.length) fail('ENTITY_DUPLICATE');
  const address = ethers.getAddress(String(input.entityProviderAddress ?? ''));
  const slots = entityIds.map(entityProviderActionNonceSlot);
  const values = await proveContractSlots(input.send, address, input.stateRoot, input.blockNumber, slots);
  return new Map(entityIds.map((entityId, index) => [
    entityId,
    values.get(slots[index] ?? fail('SLOT_MISSING', entityId)) ?? fail('SLOT_MISSING', `action:${entityId}`),
  ]));
};

/** Storage side: one proof per contract over every requested Entity's slot. */
export const readEntityNonceAnchor = async (input: {
  send: RpcSend;
  jurisdiction: Pick<JurisdictionConfig, 'depositoryAddress' | 'entityProviderAddress'>;
  blockNumber: number;
  authenticatedBlockHash: string;
  entityIds: readonly string[];
  base?: DepositoryAnchorBase;
}): Promise<EntityNonceStorageAnchor> => {
  const { send, blockNumber } = input;
  const entityIds = input.entityIds.map(entityKey);
  if (entityIds.length === 0) fail('ENTITIES_EMPTY');
  if (new Set(entityIds).size !== entityIds.length) fail('ENTITY_DUPLICATE');
  const depository = ethers.getAddress(String(input.jurisdiction.depositoryAddress ?? ''));
  const base = await resolveDepositoryAnchorBase({
    send,
    depositoryAddress: depository,
    blockNumber,
    authenticatedBlockHash: input.authenticatedBlockHash,
    base: input.base,
    fail,
  });
  const batchSlots = entityIds.map(depositoryEntityNonceSlot);
  const [batchValues, storedActionNonces] = await Promise.all([
    proveContractSlots(send, depository, base.stateRoot, blockNumber, batchSlots),
    readEntityActionNonces({
      send,
      entityProviderAddress: String(input.jurisdiction.entityProviderAddress ?? ''),
      blockNumber,
      stateRoot: base.stateRoot,
      entityIds,
    }),
  ]);
  const views = new Map<string, EntityNonceView>();
  entityIds.forEach((entityId, index) => {
    const batchNonce = batchValues.get(batchSlots[index] ?? fail('SLOT_MISSING', entityId)) ?? fail('SLOT_MISSING', `batch:${entityId}`);
    const actionNonce = storedActionNonces.get(entityId) ?? fail('SLOT_MISSING', `action:${entityId}`);
    views.set(entityId, nonceViewFromStorage(entityId, batchNonce, actionNonce));
  });
  return {
    blockNumber,
    authenticatedBlockHash: base.authenticatedBlockHash,
    views,
    storedActionNonces,
    root: buildNonceAnchorRoot(views.values()),
  };
};
