import { ethers } from 'ethers';

import type { EntityState } from '../../../entity/types';

// Pure nonce anchor root (Depository entityNonces + EntityProvider
// entityActionNonces). The Foundation's action nonce also counts
// FoundationActionExecuted, which is telemetry and never folded, so both sides
// record it as unproven instead of defaulting a value (see the adapter
// rpc-nonce-anchor.ts reader).

export type EntityNonceView = {
  entityId: string;
  batchNonce: bigint;
  /** null only for the Foundation, whose slot also counts unfolded Foundation actions. */
  actionNonce: bigint | null;
};

const FOUNDATION_ENTITY_ID = ethers.toBeHex(1n, 32).toLowerCase();
const NONCE_ANCHOR_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('xln:j-nonce-anchor:v1')).toLowerCase();
const ABI = ethers.AbiCoder.defaultAbiCoder();

const fail = (code: string, detail = ''): never => {
  throw new Error(`NONCE_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
};

const entityKey = (value: string): string => {
  const normalized = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) fail('ENTITY_INVALID', String(value));
  return normalized;
};

export const buildNonceAnchorRoot = (views: Iterable<EntityNonceView>): string => {
  const leaves = [...views].map(view => ({ ...view, entityId: entityKey(view.entityId) }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0));
  if (new Set(leaves.map(leaf => leaf.entityId)).size !== leaves.length) fail('ENTITY_DUPLICATE');
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'tuple(bytes32,uint256,bool,uint256)[]'],
    [NONCE_ANCHOR_DOMAIN, leaves.map(leaf => {
      if ((leaf.entityId === FOUNDATION_ENTITY_ID) !== (leaf.actionNonce === null)) fail('FOUNDATION_SCOPE', leaf.entityId);
      return [leaf.entityId, leaf.batchNonce, leaf.actionNonce !== null, leaf.actionNonce ?? 0n];
    })],
  )).toLowerCase();
};

/** History side: the Entity fold's nonces in anchor form. */
export const nonceViewFromFold = (
  state: Pick<EntityState, 'entityId' | 'jBatchState' | 'entityProviderActionState'>,
): EntityNonceView => {
  const entityId = entityKey(state.entityId);
  const batchNonce = state.jBatchState?.entityNonce ?? 0;
  if (!Number.isSafeInteger(batchNonce) || batchNonce < 0) fail('LOCAL_BATCH_NONCE_INVALID', `${entityId}:${String(batchNonce)}`);
  const confirmed = state.entityProviderActionState?.confirmedNonce ?? 0n;
  if (typeof confirmed !== 'bigint' || confirmed < 0n) fail('LOCAL_ACTION_NONCE_INVALID', entityId);
  return { entityId, batchNonce: BigInt(batchNonce), actionNonce: entityId === FOUNDATION_ENTITY_ID ? null : confirmed };
};

/** Storage side in anchor form; the Foundation's raw action nonce is not admitted. */
export const nonceViewFromStorage = (entityId: string, batchNonce: bigint, storedActionNonce: bigint): EntityNonceView => {
  const entity = entityKey(entityId);
  return { entityId: entity, batchNonce, actionNonce: entity === FOUNDATION_ENTITY_ID ? null : storedActionNonce };
};
