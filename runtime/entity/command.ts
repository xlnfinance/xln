import { getSignerAddress, signAccountFrame, verifyAccountSignature } from '../account/crypto';
import { deriveAccountWatchSeed, normalizeAccountWatchSeed } from '../account/watch-seed';
import {
  accountStateDomainFromJurisdiction,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../account/state-root';
import { LIMITS } from '../constants';
import {
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/board-registry';
import { validatePersistedValidatorEncryptionManifest } from '../protocol/htlc/validator-encryption';
import { requireCommittedDirectPaymentRoute } from '../protocol/payments/route';
import type {
  EntityCommandNonceState,
  EntityState,
  EntityTx,
  Env,
  SignedEntityCommandV2,
} from '../types';
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
import { encodeBoard, hashBoard } from './factory';
import {
  assertIndividualEntityCommandTxs,
  buildCollectiveEntityProposalTx,
  isCollectiveEntityActionTx,
  isIndividualEntityCommandTx,
  resolveCanonicalEntityBoardShares,
} from './authorization';

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

export const resolveEntityCommandBoard = (
  env: Env,
  state: EntityState,
): ResolvedEntityCommandBoard => {
  const canonicalShares = resolveCanonicalEntityBoardShares(state.config);
  const aliases = new Set<string>();
  const manifest = state.profileEncryptionManifest
    ? validatePersistedValidatorEncryptionManifest(state.entityId, state.config, state.profileEncryptionManifest)
    : null;
  const attestations = new Map(
    (manifest?.attestations ?? []).map(attestation => [
      canonicalEntityCommandSignerId(attestation.signerId),
      attestation,
    ]),
  );
  const members = state.config.validators.map((rawSignerId): ResolvedBoardMember => {
    const signerId = canonicalEntityCommandSignerId(rawSignerId);
    if (aliases.has(signerId)) throw new Error(`ENTITY_COMMAND_BOARD_DUPLICATE_ALIAS:${signerId}`);
    aliases.add(signerId);
    const resolvedSigner = attestations.get(signerId)?.signer ?? getSignerAddress(env, signerId);
    if (!resolvedSigner) throw new Error(`ENTITY_COMMAND_BOARD_SIGNER_UNAVAILABLE:${signerId}`);
    const signer = canonicalEntityCommandAddress(resolvedSigner, 'ENTITY_COMMAND_BOARD_SIGNER_INVALID');
    if (/^0x[0-9a-f]{40}$/.test(signerId) && signer !== signerId) {
      throw new Error(`ENTITY_COMMAND_BOARD_EOA_ALIAS_MISMATCH:${signerId}:${signer}`);
    }
    return { signerId, signer, share: canonicalShares.bySigner.get(signerId)! };
  });
  if (attestations.size > 0 && attestations.size !== members.length) {
    throw new Error(`ENTITY_COMMAND_BOARD_MANIFEST_SIZE_INVALID:${attestations.size}:${members.length}`);
  }
  const resolvedConfig = {
    mode: state.config.mode,
    threshold: state.config.threshold,
    validators: members.map(member => member.signer),
    shares: Object.fromEntries(members.map(member => [member.signer, member.share])),
  };
  const boardHash = hashBoard(encodeBoard(resolvedConfig)).toLowerCase();
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
export const resolveEntityCommandAuthor = (
  env: Env,
  state: EntityState,
  rawSignerId: string,
  board: ResolvedEntityCommandBoard = resolveEntityCommandBoard(env, state),
): ResolvedEntityCommandAuthor => {
  const signerId = canonicalEntityCommandSignerId(rawSignerId);
  const author = board.members.find(member => member.signerId === signerId);
  if (!author) throw new Error(`ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD:${signerId}`);
  return { boardHash: board.boardHash, boardEpoch: board.boardEpoch, signerId, signer: author.signer };
};

export const getEntityCommandStackKey = (state: EntityState): string =>
  state.config.jurisdiction
    ? getCertifiedBoardStackKey(state.config.jurisdiction)
    : UNREGISTERED_ENTITY_COMMAND_STACK_KEY;

const canonicalCommandNonceState = (
  state: EntityState,
  currentBoardHash: string,
  currentBoardEpoch: number,
): EntityCommandNonceState => {
  const stored = state.entityCommandNonces;
  if (!stored) return { version: 2, boardHash: currentBoardHash, boardEpoch: currentBoardEpoch, bySigner: new Map() };
  if (stored.version !== 2 || !(stored.bySigner instanceof Map)) {
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
    return { version: 2, boardHash: currentBoardHash, boardEpoch: currentBoardEpoch, bySigner: new Map() };
  }
  return { version: 2, boardHash: currentBoardHash, boardEpoch: currentBoardEpoch, bySigner };
};

export const normalizeEntityCommandNonceBoard = (
  env: Env,
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

export type EntityCommandDisposition = 'next' | 'retry';

/** Classify only against the bounded latest slot for this board member. */
export const getEntityCommandDisposition = (
  state: EntityState,
  command: SignedEntityCommandV2,
): EntityCommandDisposition => {
  const nonceState = canonicalCommandNonceState(state, command.boardHash, command.boardEpoch);
  const latest = nonceState.bySigner.get(command.authorSignerId);
  if (!latest) {
    if (command.nonce !== 1n) {
      throw new Error(`ENTITY_COMMAND_NONCE_MISMATCH:${command.nonce.toString()}:1`);
    }
    return 'next';
  }
  const commandHash = hashEntityCommand(command);
  if (command.nonce === latest.nonce) {
    if (commandHash !== latest.commandHash) {
      throw new Error(`ENTITY_COMMAND_NONCE_EQUIVOCATION:${command.authorSignerId}:${command.nonce.toString()}`);
    }
    return 'retry';
  }
  if (command.nonce < latest.nonce) {
    throw new Error(
      `ENTITY_COMMAND_NONCE_STALE:${command.authorSignerId}:${command.nonce.toString()}:${latest.nonce.toString()}`,
    );
  }
  const expectedNonce = latest.nonce + 1n;
  if (command.nonce !== expectedNonce) {
    throw new Error(`ENTITY_COMMAND_NONCE_MISMATCH:${command.nonce.toString()}:${expectedNonce.toString()}`);
  }
  return 'next';
};

export const assertSignedEntityCommand = (
  env: Env,
  state: EntityState,
  value: unknown,
): SignedEntityCommandV2 => {
  const command = normalizeSignedEntityCommand(value);
  const entityId = canonicalEntityCommandEntityId(state.entityId);
  if (command.entityId !== entityId) {
    throw new Error(`ENTITY_COMMAND_ENTITY_MISMATCH:${command.entityId}:${entityId}`);
  }
  const stackKey = getEntityCommandStackKey(state);
  if (command.stackKey !== stackKey) {
    throw new Error(`ENTITY_COMMAND_STACK_MISMATCH:${command.stackKey}:${stackKey}`);
  }
  const board = resolveEntityCommandBoard(env, state);
  if (command.boardHash !== board.boardHash) {
    throw new Error(`ENTITY_COMMAND_BOARD_MISMATCH:${command.boardHash}:${board.boardHash}`);
  }
  if (command.boardEpoch !== board.boardEpoch) {
    throw new Error(`ENTITY_COMMAND_EPOCH_MISMATCH:${command.boardEpoch}:${board.boardEpoch}`);
  }
  const author = resolveEntityCommandAuthor(env, state, command.authorSignerId, board);
  if (command.authorSigner !== author.signer) {
    throw new Error(`ENTITY_COMMAND_AUTHOR_EOA_MISMATCH:${command.authorSigner}:${author.signer}`);
  }
  assertEntityCommandAuthorBindings(command.authorSignerId, command.txs);
  assertIndividualEntityCommandTxs(command.txs);
  if (!verifyAccountSignature(env, author.signer, hashEntityCommand(command), command.signature)) {
    throw new Error(`ENTITY_COMMAND_SIGNATURE_MISMATCH:${author.signerId}:${author.signer}`);
  }
  getEntityCommandDisposition(state, command);
  return command;
};

export const advanceEntityCommandNonce = (
  state: EntityState,
  command: SignedEntityCommandV2,
): EntityState => {
  const disposition = getEntityCommandDisposition(state, command);
  if (disposition === 'retry') return state;
  const nonceState = canonicalCommandNonceState(state, command.boardHash, command.boardEpoch);
  const bySigner = new Map(nonceState.bySigner);
  bySigner.set(command.authorSignerId, {
    nonce: command.nonce,
    commandHash: hashEntityCommand(command),
  });
  return {
    ...state,
    entityCommandNonces: {
      version: 2,
      boardHash: command.boardHash,
      boardEpoch: command.boardEpoch,
      bySigner,
    },
  };
};

export const buildSignedEntityCommand = (
  env: Env,
  state: EntityState,
  authorSignerId: string,
  txs: EntityTx[],
): SignedEntityCommandV2 => {
  assertEntityCommandTxs(txs);
  const board = resolveEntityCommandBoard(env, state);
  const author = resolveEntityCommandAuthor(env, state, authorSignerId, board);
  const signerId = author.signerId;
  assertEntityCommandAuthorBindings(signerId, txs);
  assertIndividualEntityCommandTxs(txs);
  const unsigned: EntityCommandBody = {
    version: 2,
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
  env: Env,
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
  const watchSeed = tx.data.watchSeed === undefined
    ? deriveAccountWatchSeed({
        runtimeSeed: env.runtimeSeed ?? '',
        runtimeId: env.runtimeId ?? null,
        entityId: state.entityId,
        counterpartyId,
        timestamp: env.timestamp,
      })
    : normalizeAccountWatchSeed(tx.data.watchSeed, 'OPEN_ACCOUNT');
  return { ...tx, data: { ...tx.data, accountDomain: committedDomain, watchSeed } };
};

/**
 * Local runtime custody may sign only for the exact replica key it owns.
 * Protocol transactions remain on their dedicated authorization lanes.
 */
export const prepareLocallyAuthoredEntityTxs = (
  env: Env,
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
      const command = assertSignedEntityCommand(env, cursor, tx.data);
      if (getEntityCommandDisposition(cursor, command) === 'retry') continue;
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
