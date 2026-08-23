import { getSignerAddress, signAccountFrame, verifyAccountSignature } from '../../account/crypto';
import { deriveAccountWatchSeed, normalizeAccountWatchSeed } from '../../protocol/identity/account-watch-seed';
import { canonicalAccountDisputeConfig } from '../../account/config/dispute-config';
import {
  accountStateDomainFromJurisdiction,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../../account/commitment/state-root';
import { LIMITS } from '../../config/constants';
import {
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveObserverCertifiedBoardRecord,
} from '../../jurisdiction/machine/board-registry';
import { requireCommittedDirectPaymentRoute } from '../../protocol/payments/route';
import type { EntityCommandNonceState, EntityTx, SignedEntityCommandV1 } from '../../types/entity-tx';
import type { EntityState } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import { EntityCommandRejectionError, MalformedEntityFrameInputError } from '../tx/processing/invariant-errors';
import { entityLog } from '../consensus/entity-log';
import {
  assertEntityCommandTxs,
  assertEntityCommandAuthorBindings,
  canonicalEntityCommandAddress,
  canonicalEntityCommandBoardEpoch,
  canonicalEntityCommandBytes32,
  canonicalEntityCommandEntityId,
  canonicalEntityCommandSignerId,
  hashEntityCommand,
  hashEntityCommandTxs,
  isEntityCommandForbiddenTx,
  mergeEntityCommandTransactions,
  normalizeSignedEntityCommand,
  signedEntityCommandTx,
  type EntityCommandBody,
  UNREGISTERED_ENTITY_COMMAND_STACK_KEY,
} from './command-codec';
import { encodeBoard, hashBoard } from '../factory';
import { RecencyMemo } from '../../support/recency-memo';
import {
  assertIndividualEntityCommandTxs,
  buildCollectiveEntityProposalTx,
  isCollectiveEntityActionTx,
  isIndividualEntityCommandTx,
  resolveCanonicalEntityBoardShares,
} from '../auth/authorization';

type ResolvedBoardMember = Readonly<{
  signerId: string;
  signer: string;
  share: bigint;
}>;

type ResolvedEntityCommandBoard = Readonly<{
  boardHash: string;
  boardEpoch: number;
  members: readonly ResolvedBoardMember[];
}>;

type ResolvedEntityCommandAuthor = Readonly<{
  boardHash: string;
  boardEpoch: number;
  signerId: string;
  signer: string;
}>;

const resolveEntityBoardMembers = (
  env: EntityRuntimeContext,
  state: EntityState,
): Readonly<{ boardHash: string; members: readonly ResolvedBoardMember[] }> => {
  const canonicalShares = resolveCanonicalEntityBoardShares(state.config);
  const aliases = new Set<string>();
  const members = state.config.validators.map((rawSignerId): ResolvedBoardMember => {
    const signerId = canonicalEntityCommandSignerId(rawSignerId);
    if (aliases.has(signerId)) throw new Error(`ENTITY_COMMAND_BOARD_DUPLICATE_ALIAS:${signerId}`);
    aliases.add(signerId);
    const resolvedSigner = getSignerAddress(env, signerId);
    if (!resolvedSigner) throw new Error(`ENTITY_COMMAND_BOARD_SIGNER_UNAVAILABLE:${signerId}`);
    const signer = canonicalEntityCommandAddress(resolvedSigner, 'ENTITY_COMMAND_BOARD_SIGNER_INVALID');
    if (/^0x[0-9a-f]{40}$/.test(signerId) && signer !== signerId) {
      throw new Error(`ENTITY_COMMAND_BOARD_EOA_ALIAS_MISMATCH:${signerId}:${signer}`);
    }
    return { signerId, signer, share: canonicalShares.bySigner.get(signerId)! };
  });
  // ABI-encoding and hashing the board is a function of the resolved
  // members only; it ran several times per frame on every user Runtime.
  const boardKey = `${state.config.mode}|${state.config.threshold}|${
    members.map(member => `${member.signer}:${member.share}`).join(',')}`;
  let boardHash = resolvedBoardHashes.get(boardKey);
  if (boardHash === undefined) {
    boardHash = hashBoard(encodeBoard({
      mode: state.config.mode,
      threshold: state.config.threshold,
      validators: members.map(member => member.signer),
      shares: Object.fromEntries(members.map(member => [member.signer, member.share])),
    })).toLowerCase();
    resolvedBoardHashes.set(boardKey, boardHash);
  }
  return { boardHash, members };
};
const resolvedBoardHashes = new RecencyMemo<string, string>(1_024);

export const resolveEntityCommandBoard = (
  env: EntityRuntimeContext,
  state: EntityState,
): ResolvedEntityCommandBoard => {
  const { boardHash, members } = resolveEntityBoardMembers(env, state);
  const entityId = canonicalEntityCommandEntityId(state.entityId);
  const boardEpoch = (() => {
    if (entityId === boardHash) return 0;
    const record = resolveObserverCertifiedBoardRecord(
      state,
      getCertifiedBoardNodeStore(env),
      entityId,
    );
    if (!record) throw new Error(`ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED:${entityId}`);
    if (record.boardHash !== boardHash) {
      throw new Error(`ENTITY_COMMAND_CERTIFIED_BOARD_CONFIG_MISMATCH:${record.boardHash}:${boardHash}`);
    }
    return canonicalEntityCommandBoardEpoch(record.boardEpoch);
  })();
  return {
    boardHash,
    boardEpoch,
    members,
  };
};

/**
 * Current eligibility policy is deliberately isolated here. The command
 * domain always binds the exact current boardHash + boardEpoch, while a future certified
 * participant registry can broaden authors without changing the codec,
 * nonce fence, or validator replay path.
 */
const resolveEntityCommandAuthor = (
  env: EntityRuntimeContext,
  state: EntityState,
  rawSignerId: string,
  board: ResolvedEntityCommandBoard = resolveEntityCommandBoard(env, state),
): ResolvedEntityCommandAuthor => {
  const signerId = canonicalEntityCommandSignerId(rawSignerId);
  const author = board.members.find(member => member.signerId === signerId);
  if (!author) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD:${signerId}`,
    );
  }
  return { boardHash: board.boardHash, boardEpoch: board.boardEpoch, signerId, signer: author.signer };
};

const getEntityCommandStackKey = (state: EntityState): string =>
  state.config.jurisdiction
    ? getCertifiedBoardStackKey(state.config.jurisdiction)
    : UNREGISTERED_ENTITY_COMMAND_STACK_KEY;

const canonicalCommandNonceState = (
  state: EntityState,
  currentBoardHash: string,
  currentBoardEpoch: number,
): EntityCommandNonceState => {
  const stored = state.entityCommandNonces;
  if (!stored) return { version: 1, boardHash: currentBoardHash, boardEpoch: currentBoardEpoch, bySigner: new Map() };
  if (stored.version !== 1 || !(stored.bySigner instanceof Map)) {
    throw new Error('ENTITY_COMMAND_NONCE_STATE_INVALID');
  }
  const storedBoardHash = canonicalEntityCommandBytes32(
    stored.boardHash,
    'ENTITY_COMMAND_NONCE_STATE_BOARD_HASH_INVALID',
  );
  const storedBoardEpoch = canonicalEntityCommandBoardEpoch(stored.boardEpoch);
  const isCurrentBoard = storedBoardHash === currentBoardHash && storedBoardEpoch === currentBoardEpoch;
  const maxSignerSlots = isCurrentBoard ? state.config.validators.length : LIMITS.MAX_VALIDATORS;
  if (stored.bySigner.size > maxSignerSlots) {
    throw new Error(`ENTITY_COMMAND_NONCE_STATE_OVERSIZED:${stored.bySigner.size}`);
  }
  const currentAliases = new Set(state.config.validators.map(canonicalEntityCommandSignerId));
  const bySigner = new Map<string, { nonce: bigint; commandHash: string }>();
  for (const [rawSignerId, record] of stored.bySigner) {
    const signerId = canonicalEntityCommandSignerId(rawSignerId);
    if (isCurrentBoard && !currentAliases.has(signerId)) {
      throw new Error(`ENTITY_COMMAND_NONCE_STATE_UNKNOWN_SIGNER:${signerId}`);
    }
    if (bySigner.has(signerId)) throw new Error(`ENTITY_COMMAND_NONCE_STATE_DUPLICATE_SIGNER:${signerId}`);
    if (
      !record ||
      typeof record !== 'object' ||
      Object.keys(record).sort().join(',') !== 'commandHash,nonce' ||
      typeof record.nonce !== 'bigint' ||
      record.nonce < 1n
    ) {
      throw new Error(`ENTITY_COMMAND_NONCE_STATE_VALUE_INVALID:${signerId}`);
    }
    const commandHash = canonicalEntityCommandBytes32(
      record.commandHash,
      'ENTITY_COMMAND_NONCE_STATE_HASH_INVALID',
    );
    bySigner.set(signerId, { nonce: record.nonce, commandHash });
  }
  if (!isCurrentBoard) {
    // A certified board rotation changes the nonce namespace. The old bounded
    // fence is fully validated above before being deterministically discarded.
    return { version: 1, boardHash: currentBoardHash, boardEpoch: currentBoardEpoch, bySigner: new Map() };
  }
  return { version: 1, boardHash: currentBoardHash, boardEpoch: currentBoardEpoch, bySigner };
};

export const normalizeEntityCommandNonceBoard = (
  env: EntityRuntimeContext,
  state: EntityState,
): EntityState => {
  if (!state.entityCommandNonces) return state;
  const board = resolveEntityCommandBoard(env, state);
  const normalized = canonicalCommandNonceState(state, board.boardHash, board.boardEpoch);
  if (
    state.entityCommandNonces.boardHash === normalized.boardHash &&
    state.entityCommandNonces.boardEpoch === normalized.boardEpoch
  ) return state;
  return { ...state, entityCommandNonces: normalized };
};

export const nextEntityCommandNonce = (
  state: EntityState,
  boardHash: string,
  boardEpoch: number,
  authorSignerId: string,
): bigint => {
  const signerId = canonicalEntityCommandSignerId(authorSignerId);
  const canonicalBoardHash = canonicalEntityCommandBytes32(boardHash, 'ENTITY_COMMAND_BOARD_HASH_INVALID');
  const canonicalBoardEpoch = canonicalEntityCommandBoardEpoch(boardEpoch);
  return (
    canonicalCommandNonceState(state, canonicalBoardHash, canonicalBoardEpoch).bySigner.get(signerId)?.nonce ?? 0n
  ) + 1n;
};

export type EntityCommandDisposition = 'next' | 'retry' | 'cancel';

/** Classify only against the bounded latest slot for this board member. */
export const getEntityCommandDisposition = (
  state: EntityState,
  command: SignedEntityCommandV1,
): EntityCommandDisposition => {
  const nonceState = canonicalCommandNonceState(state, command.boardHash, command.boardEpoch);
  const latest = nonceState.bySigner.get(command.authorSignerId);
  if (!latest) {
    if (command.nonce !== 1n) {
      throw new EntityCommandRejectionError(
        `ENTITY_COMMAND_NONCE_MISMATCH:${command.nonce.toString()}:1`,
      );
    }
    return 'next';
  }
  const commandHash = hashEntityCommand(command);
  // Entity-command nonces only grow. A nonce that is not strictly the next
  // expected one is a cancel: the committed slot already stands, and whatever
  // bytes arrive for an old (or same, rewritten) slot are dropped without
  // error — the sender's authoritative state is the certified chain, not this
  // delivery. Only an exact byte retry is acknowledged as idempotent. A gap
  // above the frontier stays a loud mismatch: it means a signed command went
  // missing between two committed nonces.
  if (command.nonce === latest.nonce) {
    return commandHash === latest.commandHash ? 'retry' : 'cancel';
  }
  if (command.nonce < latest.nonce) return 'cancel';
  const expectedNonce = latest.nonce + 1n;
  if (command.nonce !== expectedNonce) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_NONCE_MISMATCH:${command.nonce.toString()}:${expectedNonce.toString()}`,
    );
  }
  return 'next';
};

export const assertSignedEntityCommand = (
  env: EntityRuntimeContext,
  state: EntityState,
  value: unknown,
): SignedEntityCommandV1 => {
  const command = normalizeSignedEntityCommand(value);
  const entityId = canonicalEntityCommandEntityId(state.entityId);
  if (command.entityId !== entityId) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_ENTITY_MISMATCH:${command.entityId}:${entityId}`,
    );
  }
  const stackKey = getEntityCommandStackKey(state);
  if (command.stackKey !== stackKey) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_STACK_MISMATCH:${command.stackKey}:${stackKey}`,
    );
  }
  const board = resolveEntityCommandBoard(env, state);
  if (command.boardHash !== board.boardHash) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_BOARD_MISMATCH:${command.boardHash}:${board.boardHash}`,
    );
  }
  if (command.boardEpoch !== board.boardEpoch) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_EPOCH_MISMATCH:${command.boardEpoch}:${board.boardEpoch}`,
    );
  }
  const author = resolveEntityCommandAuthor(env, state, command.authorSignerId, board);
  if (command.authorSigner !== author.signer) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_AUTHOR_EOA_MISMATCH:${command.authorSigner}:${author.signer}`,
    );
  }
  assertEntityCommandAuthorBindings(command.authorSignerId, command.txs);
  assertIndividualEntityCommandTxs(command.txs);
  if (!verifyAccountSignature(env, author.signer, hashEntityCommand(command), command.signature)) {
    throw new EntityCommandRejectionError(
      `ENTITY_COMMAND_SIGNATURE_MISMATCH:${author.signerId}:${author.signer}`,
    );
  }
  getEntityCommandDisposition(state, command);
  return command;
};

export const advanceEntityCommandNonce = (
  state: EntityState,
  command: SignedEntityCommandV1,
): EntityState => {
  const disposition = getEntityCommandDisposition(state, command);
  if (disposition !== 'next') return state;
  const nonceState = canonicalCommandNonceState(state, command.boardHash, command.boardEpoch);
  const bySigner = new Map(nonceState.bySigner);
  bySigner.set(command.authorSignerId, {
    nonce: command.nonce,
    commandHash: hashEntityCommand(command),
  });
  return {
    ...state,
    entityCommandNonces: {
      version: 1,
      boardHash: command.boardHash,
      boardEpoch: command.boardEpoch,
      bySigner,
    },
  };
};

export const buildSignedEntityCommand = (
  env: EntityRuntimeContext,
  state: EntityState,
  authorSignerId: string,
  txs: EntityTx[],
): SignedEntityCommandV1 => {
  assertEntityCommandTxs(txs);
  const board = resolveEntityCommandBoard(env, state);
  const author = resolveEntityCommandAuthor(env, state, authorSignerId, board);
  const signerId = author.signerId;
  assertEntityCommandAuthorBindings(signerId, txs);
  assertIndividualEntityCommandTxs(txs);
  const unsigned: EntityCommandBody = {
    version: 1,
    entityId: canonicalEntityCommandEntityId(state.entityId),
    stackKey: getEntityCommandStackKey(state),
    boardHash: author.boardHash,
    boardEpoch: author.boardEpoch,
    authorSignerId: signerId,
    authorSigner: author.signer,
    nonce: nextEntityCommandNonce(state, author.boardHash, author.boardEpoch, signerId),
    txsHash: hashEntityCommandTxs(txs),
    txs: structuredClone(txs),
  };
  return {
    ...unsigned,
    signature: signAccountFrame(env, signerId, hashEntityCommand(unsigned)).toLowerCase(),
  };
};

const materializeLocallyAuthoredEntityTx = (
  env: EntityRuntimeContext,
  state: EntityState,
  tx: EntityTx,
): EntityTx => {
  if (tx.type === 'directPayment') {
    const route = requireCommittedDirectPaymentRoute({
      sourceEntityId: state.entityId,
      targetEntityId: tx.data.targetEntityId,
      route: tx.data.route,
    });
    return { ...tx, data: { ...tx.data, route } };
  }
  if (tx.type !== 'openAccount') return tx;
  const jurisdiction = state.config?.jurisdiction;
  if (!jurisdiction) throw new Error(`OPEN_ACCOUNT_SOURCE_JURISDICTION_REQUIRED:${state.entityId}`);
  const committedDomain = accountStateDomainFromJurisdiction(jurisdiction);
  if (
    tx.data.accountDomain !== undefined &&
    !sameAccountStateDomain(normalizeAccountStateDomain(tx.data.accountDomain), committedDomain)
  ) {
    throw new Error('OPEN_ACCOUNT_DOMAIN_MISMATCH');
  }
  const counterpartyId = String(tx.data.targetEntityId ?? '').trim().toLowerCase();
  if (tx.data.disputeConfig === undefined) throw new Error('OPEN_ACCOUNT_DISPUTE_CONFIG_REQUIRED');
  const disputeConfig = canonicalAccountDisputeConfig(tx.data.disputeConfig);
  const watchSeed = tx.data.watchSeed === undefined
    ? deriveAccountWatchSeed({
        runtimeSeed: env.runtimeSeed ?? '',
        runtimeId: env.runtimeId ?? null,
        entityId: state.entityId,
        counterpartyId,
      })
    : normalizeAccountWatchSeed(tx.data.watchSeed, 'OPEN_ACCOUNT');
  return { ...tx, data: { ...tx.data, disputeConfig, accountDomain: committedDomain, watchSeed } };
};

/**
 * Local runtime custody may sign only for the exact replica key it owns.
 * Protocol transactions remain on their dedicated authorization lanes.
 */
export const prepareLocallyAuthoredEntityTxs = (
  env: EntityRuntimeContext,
  state: EntityState,
  authorSignerId: string,
  txs: EntityTx[],
): EntityTx[] => {
  let cursor = state;
  let userRun: EntityTx[] = [];
  let userRunKind: 'individual' | 'collective' | null = null;
  const prepared: EntityTx[] = [];
  const flushUserRun = (): void => {
    if (userRun.length === 0) return;
    const commandTxs = userRunKind === 'collective'
      ? [buildCollectiveEntityProposalTx(authorSignerId, userRun)]
      : userRun;
    const command = buildSignedEntityCommand(env, cursor, authorSignerId, commandTxs);
    prepared.push(signedEntityCommandTx(command));
    cursor = advanceEntityCommandNonce(cursor, command);
    userRun = [];
    userRunKind = null;
  };
  const materializedTxs = txs.map(tx => materializeLocallyAuthoredEntityTx(env, state, tx));
  for (const tx of mergeEntityCommandTransactions(materializedTxs)) {
    if (tx.type === 'entityCommand') {
      flushUserRun();
      let command: SignedEntityCommandV1;
      try {
        command = assertSignedEntityCommand(env, cursor, tx.data);
      } catch (error) {
        // A wrapped command already sitting in this replica's mempool can go
        // stale relative to `cursor` (e.g. a different-content command
        // committed elsewhere at the same nonce). Unlike the commit-time path
        // (applyNestedEntityTx / buildEntityProposalEvictingRejected), nothing
        // upstream of this call evicts the stale mempool entry — without this
        // catch the throw propagates past admission.ts before mempool is ever
        // reassigned, so the same stale entry re-throws every future
        // admission cycle forever.
        if (error instanceof MalformedEntityFrameInputError) {
          entityLog.warn('admission.stale_command_evicted', {
            entity: canonicalEntityCommandEntityId(state.entityId),
            error: error.message,
          });
          continue;
        }
        throw error;
      }
      if (getEntityCommandDisposition(cursor, command) !== 'next') continue;
      prepared.push({ type: 'entityCommand', data: command });
      cursor = advanceEntityCommandNonce(cursor, command);
      continue;
    }
    if (isEntityCommandForbiddenTx(tx)) {
      flushUserRun();
      prepared.push(tx);
      continue;
    }
    const kind = isIndividualEntityCommandTx(tx)
      ? 'individual'
      : isCollectiveEntityActionTx(tx)
        ? 'collective'
        : null;
    if (!kind) throw new Error(`ENTITY_TX_AUTHORIZATION_CLASS_MISSING:${tx.type}`);
    if (userRunKind !== null && userRunKind !== kind) flushUserRun();
    userRunKind = kind;
    userRun.push(tx);
  }
  flushUserRun();
  return prepared;
};
