import { ethers } from 'ethers';

import { LIMITS } from '../constants';
import { encodeCanonicalEntityConsensusValue } from './consensus/state-root';
import type { EntityTx, SignedEntityCommandV2 } from '../types';
import { canonicalEntityBoardSignerId, isEntityProtocolTx } from './authorization';

export const ENTITY_COMMAND_DOMAIN = 'xln:entity-command:v2' as const;
export const UNREGISTERED_ENTITY_COMMAND_STACK_KEY = ethers.id(
  'xln:entity-command:unregistered-stack:v1',
).toLowerCase();
export const MAX_ENTITY_COMMAND_BYTES = LIMITS.MAX_FRAME_SIZE_BYTES;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

export type EntityCommandBody = Omit<SignedEntityCommandV2, 'signature'>;

export const canonicalEntityCommandSignerId = (value: unknown): string =>
  canonicalEntityBoardSignerId(value, 'ENTITY_COMMAND_AUTHOR_SIGNER_ID_REQUIRED');

export const canonicalEntityCommandAddress = (value: unknown, code: string): string => {
  const address = String(value ?? '').trim().toLowerCase();
  if (!ADDRESS.test(address)) throw new Error(`${code}:${address || 'missing'}`);
  return address;
};

export const canonicalEntityCommandBytes32 = (value: unknown, code: string): string => {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!BYTES32.test(hash)) throw new Error(`${code}:${hash || 'missing'}`);
  return hash;
};

export const canonicalEntityCommandEntityId = (value: unknown): string =>
  canonicalEntityCommandBytes32(value, 'ENTITY_COMMAND_ENTITY_ID_INVALID');

export const canonicalEntityCommandBoardEpoch = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ENTITY_COMMAND_BOARD_EPOCH_INVALID:${String(value)}`);
  }
  return value;
};

/** User commands cannot smuggle protocol messages under an author signature. */
export const isEntityCommandForbiddenTx = (tx: EntityTx): boolean =>
  isEntityProtocolTx(tx);

export function assertEntityCommandTxs(txs: unknown): asserts txs is EntityTx[] {
  if (!Array.isArray(txs) || txs.length === 0 || txs.length > LIMITS.MEMPOOL_SIZE) {
    throw new Error(`ENTITY_COMMAND_TX_COUNT_INVALID:${Array.isArray(txs) ? txs.length : 'not-array'}`);
  }
  for (const tx of txs) {
    if (!tx || typeof tx !== 'object' || typeof (tx as { type?: unknown }).type !== 'string') {
      throw new Error('ENTITY_COMMAND_TX_INVALID');
    }
    if (isEntityCommandForbiddenTx(tx as EntityTx)) {
      throw new Error(`ENTITY_COMMAND_PROTOCOL_TX_FORBIDDEN:${String((tx as { type: unknown }).type)}`);
    }
  }
  const byteLength = new TextEncoder().encode(encodeCanonicalEntityConsensusValue({
    version: ENTITY_COMMAND_DOMAIN,
    txs,
  })).byteLength;
  if (byteLength > MAX_ENTITY_COMMAND_BYTES) {
    throw new Error(`ENTITY_COMMAND_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_COMMAND_BYTES}`);
  }
}

/**
 * Fields that claim an individual board identity must equal the command
 * author. Frame quorum authorizes collective effects; it cannot turn one
 * member's signature into another member's chat/governance identity.
 */
export const assertEntityCommandAuthorBindings = (
  authorSignerId: string,
  txs: EntityTx[],
): void => {
  const author = canonicalEntityCommandSignerId(authorSignerId);
  const assertBound = (field: string, value: unknown): void => {
    const claimed = String(value ?? '').trim().toLowerCase();
    if (claimed !== author) {
      throw new Error(`ENTITY_COMMAND_AUTHOR_FIELD_MISMATCH:${field}:${claimed || 'missing'}:${author}`);
    }
  };
  for (const tx of txs) {
    if (tx.type === 'chat') assertBound('chat.from', tx.data.from);
    if (tx.type === 'htlcOnionAdvance') {
      assertBound('htlcOnionAdvance.proposerSignerId', tx.data.proposerSignerId);
    }
    if (tx.type === 'materializeCrossJurisdictionSwap') {
      assertBound('materializeCrossJurisdictionSwap.proposerSignerId', tx.data.proposerSignerId);
    }
    if (tx.type === 'materializeCrossJurisdictionClear') {
      assertBound('materializeCrossJurisdictionClear.proposerSignerId', tx.data.proposerSignerId);
    }
    if (tx.type === 'propose') assertBound('propose.proposer', tx.data.proposer);
    if (tx.type === 'vote') assertBound('vote.voter', tx.data.voter);
  }
};

export const hashEntityCommandTxs = (txs: EntityTx[]): string => {
  assertEntityCommandTxs(txs);
  return ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    version: ENTITY_COMMAND_DOMAIN,
    txs,
  }))).toLowerCase();
};

export const normalizeEntityCommandBody = (command: EntityCommandBody): EntityCommandBody => {
  if (command.version !== 2) throw new Error(`ENTITY_COMMAND_VERSION_INVALID:${String(command.version)}`);
  if (typeof command.nonce !== 'bigint' || command.nonce < 1n) {
    throw new Error(`ENTITY_COMMAND_NONCE_INVALID:${String(command.nonce)}`);
  }
  assertEntityCommandTxs(command.txs);
  const body: EntityCommandBody = {
    version: 2,
    entityId: canonicalEntityCommandEntityId(command.entityId),
    stackKey: canonicalEntityCommandBytes32(command.stackKey, 'ENTITY_COMMAND_STACK_KEY_INVALID'),
    boardHash: canonicalEntityCommandBytes32(command.boardHash, 'ENTITY_COMMAND_BOARD_HASH_INVALID'),
    boardEpoch: canonicalEntityCommandBoardEpoch(command.boardEpoch),
    authorSignerId: canonicalEntityCommandSignerId(command.authorSignerId),
    authorSigner: canonicalEntityCommandAddress(command.authorSigner, 'ENTITY_COMMAND_AUTHOR_SIGNER_INVALID'),
    nonce: command.nonce,
    txsHash: canonicalEntityCommandBytes32(command.txsHash, 'ENTITY_COMMAND_TXS_HASH_INVALID'),
    txs: structuredClone(command.txs),
  };
  const computedTxsHash = hashEntityCommandTxs(body.txs);
  if (body.txsHash !== computedTxsHash) {
    throw new Error(`ENTITY_COMMAND_TXS_HASH_MISMATCH:${body.txsHash}:${computedTxsHash}`);
  }
  return body;
};

export const hashEntityCommand = (command: EntityCommandBody): string => {
  const body = normalizeEntityCommandBody(command);
  return ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: ENTITY_COMMAND_DOMAIN,
    version: body.version,
    entityId: body.entityId,
    stackKey: body.stackKey,
    boardHash: body.boardHash,
    boardEpoch: body.boardEpoch,
    authorSignerId: body.authorSignerId,
    authorSigner: body.authorSigner,
    nonce: body.nonce,
    txsHash: body.txsHash,
  }))).toLowerCase();
};

const exactCommandKeys = new Set([
  'version', 'entityId', 'stackKey', 'boardHash', 'boardEpoch', 'authorSignerId',
  'authorSigner', 'nonce', 'txsHash', 'txs', 'signature',
]);

export const normalizeSignedEntityCommand = (value: unknown): SignedEntityCommandV2 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ENTITY_COMMAND_INVALID');
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  const unexpected = keys.find(key => !exactCommandKeys.has(key));
  if (unexpected || keys.length !== exactCommandKeys.size) {
    throw new Error(`ENTITY_COMMAND_FIELDS_INVALID:${unexpected ?? `count=${keys.length}`}`);
  }
  assertEntityCommandTxs(raw['txs']);
  const body = normalizeEntityCommandBody({
    version: raw['version'] as 2,
    entityId: String(raw['entityId'] ?? ''),
    stackKey: String(raw['stackKey'] ?? ''),
    boardHash: String(raw['boardHash'] ?? ''),
    boardEpoch: raw['boardEpoch'] as number,
    authorSignerId: String(raw['authorSignerId'] ?? ''),
    authorSigner: String(raw['authorSigner'] ?? ''),
    nonce: raw['nonce'] as bigint,
    txsHash: String(raw['txsHash'] ?? ''),
    txs: raw['txs'],
  });
  const signature = String(raw['signature'] ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new Error('ENTITY_COMMAND_SIGNATURE_INVALID');
  return { ...body, signature };
};

export const signedEntityCommandTx = (command: SignedEntityCommandV2): EntityTx => ({
  type: 'entityCommand',
  data: command,
});

/** Exact retries are idempotent; same author/board/nonce with other bytes is equivocation. */
export const mergeEntityCommandTransactions = (txs: EntityTx[]): EntityTx[] => {
  const commands = new Map<string, string>();
  const merged: EntityTx[] = [];
  for (const tx of txs) {
    if (tx.type !== 'entityCommand') {
      merged.push(tx);
      continue;
    }
    const command = normalizeSignedEntityCommand(tx.data);
    const slot = encodeCanonicalEntityConsensusValue({
      entityId: command.entityId,
      stackKey: command.stackKey,
      boardHash: command.boardHash,
      boardEpoch: command.boardEpoch,
      authorSignerId: command.authorSignerId,
      nonce: command.nonce,
    });
    const identity = encodeCanonicalEntityConsensusValue(command);
    const prior = commands.get(slot);
    if (prior === identity) continue;
    if (prior !== undefined) {
      throw new Error(
        `ENTITY_COMMAND_NONCE_EQUIVOCATION:${command.authorSignerId}:${command.nonce.toString()}`,
      );
    }
    commands.set(slot, identity);
    merged.push({ type: 'entityCommand', data: command });
  }
  return merged;
};
