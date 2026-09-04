import type { AccountInput, AccountReplica, AccountTx } from '../../../types/account';
import type { EntityOutput, EntityState, HashToSign, HashType, EntityFrame } from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { HankoString } from '../../../types/hanko';
import { compareCanonicalText } from '../../../orderbook/swap-execution';
import { normalizeSignatureMap } from '../../auth/signatures';
import {
  accountInputAck,
  accountInputBoardHankoRefresh,
  accountInputDisputeHanko,
  accountInputProposal,
} from '../../../account/consensus/flush';
import {
  cloneIsolatedAccountInput,
  cloneIsolatedAccountTx,
} from '../../../protocol/state/account-input-clone';
import {
  requireCertifiedAccountAckFrame,
  requireCertifiedAccountFrameProposal,
} from '../../../account/consensus/frame/phase-views';
import { getEntityAccountForWrite } from '../../state/persistent-account-map';

export type HankoWitnessEntry = {
  hanko: HankoString;
  type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch' | 'entityProviderAction';
  entityHeight: number;
  createdAt: number;
};

export type AccountHankoWitnessState = Pick<EntityState, 'entityId' | 'accounts'>;

export type AccountHankoWitnessRequirement = Readonly<{
  hash: string;
  type: Extract<HankoWitnessEntry['type'], 'accountFrame' | 'dispute' | 'settlement'>;
}>;

const requireReachableWitness = (
  witness: Map<string, HankoWitnessEntry>,
  hash: string,
  type: HankoWitnessEntry['type'],
): void => {
  const entry = witness.get(hash);
  if (!entry) throw new Error(`HANKO_WITNESS_REACHABLE_MISSING:${type}:${hash}`);
  if (entry.type !== type) {
    throw new Error(`HANKO_WITNESS_REACHABLE_TYPE_MISMATCH:${hash}:${type}:${entry.type}`);
  }
};

/**
 * Quorum witnesses are staging material, not historical authority. Account,
 * settlement and dispute Hankos are embedded into their exact committed
 * payloads before this runs. Only external writes that must be reconstructed
 * after a crash, plus the newest routable profile certificate, remain live.
 */
export const pruneHankoWitnessToReachableState = (
  state: EntityState,
  witness: Map<string, HankoWitnessEntry>,
): number => {
  const reachable = new Set<string>();
  const sentBatchHash = state.jBatchState?.sentBatch?.batchHash;
  if (sentBatchHash) {
    requireReachableWitness(witness, sentBatchHash, 'jBatch');
    reachable.add(sentBatchHash);
  }
  const pendingActionHash = state.entityProviderActionState?.pending?.actionHash;
  if (pendingActionHash) {
    requireReachableWitness(witness, pendingActionHash, 'entityProviderAction');
    reachable.add(pendingActionHash);
  }

  const newestProfile = [...witness.entries()]
    .filter(([, entry]) => entry.type === 'profile')
    .sort(([leftHash, left], [rightHash, right]) =>
      right.entityHeight - left.entityHeight ||
      right.createdAt - left.createdAt ||
      compareCanonicalText(leftHash, rightHash)
    )[0];
  if (newestProfile) reachable.add(newestProfile[0]);

  let removed = 0;
  for (const hash of witness.keys()) {
    if (reachable.has(hash)) continue;
    witness.delete(hash);
    removed += 1;
  }
  return removed;
};

export const normalizeProposedFrameCollectedSigs = (frame?: EntityFrame): void => {
  if (!frame?.collectedSigs) return;
  const normalized = normalizeSignatureMap(frame.collectedSigs);
  if (normalized) frame.collectedSigs = normalized;
};

export const isWitnessHashType = (type: HashType): type is HankoWitnessEntry['type'] =>
  type !== 'entityFrame' && type !== 'entityOutput';

const getTypedWitness = (
  witness: Map<string, HankoWitnessEntry>,
  hash: string,
  type: HankoWitnessEntry['type'],
  entityHeight: number,
): HankoWitnessEntry | undefined => {
  const entry = witness.get(hash);
  if (!entry) return undefined;
  if (entry.type !== type || entry.entityHeight !== entityHeight) {
    throw new Error(
      `HANKO_WITNESS_BINDING_MISMATCH:hash=${hash}:expected=${type}@${entityHeight}:` +
      `received=${entry.type}@${entry.entityHeight}`,
    );
  }
  return entry;
};

const requireDraftWitness = (
  witness: Map<string, HankoWitnessEntry>,
  hash: string,
  type: HankoWitnessEntry['type'],
  entityHeight: number,
  existing: HankoString | undefined,
): HankoString => {
  if (existing) {
    const entry = witness.get(hash);
    if (!entry) return existing;
    if (entry.type !== type || entry.entityHeight > entityHeight) {
      throw new Error(
        `HANKO_WITNESS_BINDING_MISMATCH:hash=${hash}:expected=${type}@<=${entityHeight}:` +
        `received=${entry.type}@${entry.entityHeight}`,
      );
    }
    if (entry.hanko !== existing) {
      throw new Error(
        `HANKO_WITNESS_VALUE_MISMATCH:hash=${hash}:type=${type}:entityHeight=${entry.entityHeight}`,
      );
    }
    // This field was attached by an earlier committed Entity frame. The Hanko
    // signs the exact secondary hash, not every later frame that merely keeps
    // the cached ACK/proposal in state. Requiring the old witness to acquire
    // the current height makes any unrelated next frame fail after restore.
    return existing;
  }
  const entry = getTypedWitness(witness, hash, type, entityHeight);
  if (entry) return entry.hanko;
  throw new Error(`HANKO_DRAFT_WITNESS_MISSING:hash=${hash}:type=${type}:entityHeight=${entityHeight}`);
};

const getOutboundAccount = (
  state: AccountHankoWitnessState | undefined,
  input: AccountInput,
): AccountReplica | undefined =>
  state?.accounts.get(input.toEntityId);

const getAckFrameHash = (
  state: AccountHankoWitnessState | undefined,
  input: AccountInput,
): string | undefined => {
  const ack = accountInputAck(input);
  if (!ack) return undefined;
  if (typeof ack.frameHash !== 'string' || ack.frameHash.trim().length === 0) {
    throw new Error(`ACK_FRAME_HASH_MISSING:counterparty=${input.toEntityId}:height=${ack.height}`);
  }
  const account = getOutboundAccount(state, input);
  if (
    account &&
    Number(account.currentFrame.height) === Number(ack.height) &&
    account.currentFrame.stateHash.toLowerCase() !== ack.frameHash.toLowerCase()
  ) {
    throw new Error(
      `ACK_FRAME_HASH_MISMATCH:counterparty=${input.toEntityId}:height=${ack.height}:` +
      `wire=${ack.frameHash}:local=${account.currentFrame.stateHash}`,
    );
  }
  return ack.frameHash;
};

const attachDisputeHanko = (
  disputeHanko: ReturnType<typeof accountInputDisputeHanko>,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): HankoString | undefined => {
  if (!disputeHanko) return undefined;
  disputeHanko.hanko = requireDraftWitness(witness, disputeHanko.hash, 'dispute', entityHeight, disputeHanko.hanko);
  return disputeHanko.hanko;
};

const attachAccountInputHankos = (
  input: AccountInput,
  state: AccountHankoWitnessState | undefined,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
  persistAccountWitness: boolean,
  writableAccount?: AccountReplica,
): number => {
  let attached = 0;
  const accountForWrite = persistAccountWitness ? writableAccount : undefined;
  if (persistAccountWitness && !accountForWrite) {
    throw new Error(`HANKO_ATTACHMENT_WRITABLE_ACCOUNT_REQUIRED:${input.toEntityId}`);
  }
  const boardHankoRefresh = accountInputBoardHankoRefresh(input);
  if (boardHankoRefresh) {
    boardHankoRefresh.frameHanko = requireDraftWitness(
      witness,
      boardHankoRefresh.frameHash,
      'accountFrame',
      entityHeight,
      boardHankoRefresh.frameHanko,
    );
    if (accountForWrite) accountForWrite.currentFrameHanko = boardHankoRefresh.frameHanko;
    attached += 1;
  }
  const ack = accountInputAck(input);
  if (ack) {
    const ackHash = getAckFrameHash(state, input);
    if (!ackHash && !ack.frameHanko) {
      throw new Error(`ACK_FRAME_HASH_UNRESOLVED:counterparty=${input.toEntityId}:height=${ack.height}`);
    }
    if (ackHash) {
      ack.frameHanko = requireDraftWitness(witness, ackHash, 'accountFrame', entityHeight, ack.frameHanko);
      if (accountForWrite) accountForWrite.currentFrameHanko = ack.frameHanko;
      attached += 1;
    }
  }

  // A ack_frame first acknowledges the committed current frame and then opens
  // the next pending proposal. Preserve that semantic order: currentFrameHanko
  // must end on the new proposal exactly as proposeAccountFrame did before the
  // multisig two-phase Hanko attachment path existed.
  const proposal = accountInputProposal(input);
  if (proposal?.frame.stateHash) {
    proposal.frameHanko = requireDraftWitness(
      witness,
      proposal.frame.stateHash,
      'accountFrame',
      entityHeight,
      proposal.frameHanko,
    );
    if (accountForWrite) accountForWrite.currentFrameHanko = proposal.frameHanko;
    attached += 1;
  }

  const disputeHankos = [ack?.disputeHanko, proposal?.disputeHanko, accountInputDisputeHanko(input)];
  for (const disputeHanko of disputeHankos) {
    const hanko = attachDisputeHanko(disputeHanko, witness, entityHeight);
    if (!hanko) continue;
    if (accountForWrite) accountForWrite.currentDisputeProofHanko = hanko;
    attached += 1;
  }

  if (ack) requireCertifiedAccountAckFrame(ack);
  if (proposal) requireCertifiedAccountFrameProposal(proposal);

  return attached;
};

const attachSettlementAccountTxHankos = (
  tx: AccountTx,
  account: AccountReplica,
  state: AccountHankoWitnessState,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): number => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'hanko') return 0;
  const localIsLeft = state.entityId.toLowerCase() === account.state.leftEntity.toLowerCase();
  if (!localIsLeft && state.entityId.toLowerCase() !== account.state.rightEntity.toLowerCase()) {
    throw new Error(`SETTLEMENT_HANKO_LOCAL_ENTITY_MISMATCH:${state.entityId}`);
  }
  let attached = 0;
  const workspace = account.state.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_HANKO_WORKSPACE_MISSING');
  const localIsExecutor = workspace.executorIsLeft === localIsLeft;
  if (localIsExecutor) {
    if (tx.data.settlementHanko !== undefined) throw new Error('SETTLEMENT_EXECUTOR_HANKO_FORBIDDEN');
  } else {
    tx.data.settlementHanko = requireDraftWitness(
      witness,
      tx.data.settlementHash,
      'settlement',
      entityHeight,
      tx.data.settlementHanko,
    );
    attached += 1;
  }
  tx.data.postProof.hanko = requireDraftWitness(
    witness,
    tx.data.postProof.disputeHash,
    'dispute',
    entityHeight,
    tx.data.postProof.hanko,
  );
  return attached + 1;
};

const attachSettlementAccountMempoolHankos = (
  account: AccountReplica,
  state: AccountHankoWitnessState,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): number => {
  if (!account.mempool.some(
    tx => tx.type === 'settle_transition' && tx.data.kind === 'hanko',
  )) return 0;
  let attached = 0;
  account.mempool = account.mempool.map(tx => {
    if (tx.type !== 'settle_transition' || tx.data.kind !== 'hanko') return tx;
    // Persistent projection may freeze the array and its bounded values. Fork
    // only the touched tx; post-commit Hankos are excluded from its leaf hash.
    const writableTx = cloneIsolatedAccountTx(tx);
    attached += attachSettlementAccountTxHankos(writableTx, account, state, witness, entityHeight);
    return writableTx;
  });
  return attached;
};

/**
 * A settlement Hanko is created while replaying an Entity frame, but its Hanko
 * exists only after that frame reaches board quorum. Feeding the unsigned
 * draft into bilateral Account consensus in the same frame would consume it
 * as an invalid transaction before the commit path can attach the witness.
 */
export const accountTxAwaitsPostCommitHanko = (
  tx: AccountTx,
  account: AccountReplica,
  state: Pick<AccountHankoWitnessState, 'entityId'>,
): boolean => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'hanko') return false;
  if (!tx.data.postProof.hanko) return true;
  const workspace = account.state.settlementWorkspace;
  if (!workspace) return false;
  const localIsLeft = state.entityId.toLowerCase() === account.state.leftEntity.toLowerCase();
  if (!localIsLeft && state.entityId.toLowerCase() !== account.state.rightEntity.toLowerCase()) return false;
  const localIsExecutor = workspace.executorIsLeft === localIsLeft;
  return !localIsExecutor && !tx.data.settlementHanko;
};

export const attachHankoWitnessToOutputs = (
  outputs: EntityOutput[],
  jOutputs: JInput[],
  hankoWitness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
  state?: AccountHankoWitnessState,
): number => {
  let attachedCount = 0;

  for (const output of outputs) {
    const txs = Array.isArray(output.entityTxs) ? output.entityTxs : [];
    for (const tx of txs) {
      if (tx.type !== 'accountInput') continue;
      const accountInput = tx.data;
      if (!accountInput) continue;
      // Account consensus may expose the same certified payload through a
      // attached persistent Account value and an outbound Entity output. Hanko
      // attachment is post-commit witness material, so mutate an isolated
      // bounded protocol copy instead of writing through the readonly alias.
      const hankoAttachedInput = cloneIsolatedAccountInput(accountInput);
      const boardHankoRefresh = accountInputBoardHankoRefresh(hankoAttachedInput);
      const persistBoardRefresh = boardHankoRefresh !== undefined && state !== undefined;
      const writableAccount = boardHankoRefresh && state
        ? getEntityAccountForWrite(state.accounts, hankoAttachedInput.toEntityId)
        : undefined;
      attachedCount += attachAccountInputHankos(
        hankoAttachedInput,
        state,
        hankoWitness,
        entityHeight,
        persistBoardRefresh,
        writableAccount,
      );
      tx.data = hankoAttachedInput;
    }
  }

  for (const jInput of jOutputs) {
    for (const jTx of jInput.jTxs) {
      if (jTx.type === 'batch' && jTx.data?.batchHash) {
        jTx.data.hankoSignature = requireDraftWitness(
          hankoWitness,
          jTx.data.batchHash,
          'jBatch',
          entityHeight,
          jTx.data.hankoSignature,
        );
        attachedCount++;
      }
      if (
        jTx.type === 'entityProviderTransfer' ||
        jTx.type === 'entityProviderReleaseControlShares' ||
        jTx.type === 'entityProviderCancelAction'
      ) {
        jTx.data.hankoSignature = requireDraftWitness(
          hankoWitness,
          jTx.data.intent.actionHash,
          'entityProviderAction',
          entityHeight,
          jTx.data.hankoSignature,
        );
        attachedCount++;
      }
      if (jTx.type === 'entityProviderProposeControlBoard') {
        const ownVote = jTx.data.supporterVotes.find(
          (vote) => vote.entityId === jTx.entityId,
        );
        if (!ownVote || ownVote.hankoSignature) {
          throw new Error(`CONTROL_BOARD_PROPOSAL_OWN_VOTE_INVALID:${jTx.entityId}`);
        }
        ownVote.hankoSignature = requireDraftWitness(
          hankoWitness,
          jTx.data.proposalHash,
          'entityProviderAction',
          entityHeight,
          ownVote.hankoSignature,
        );
        attachedCount++;
      }
    }
  }

  return attachedCount;
};

export const attachHankoWitnessesToState = (
  state: AccountHankoWitnessState,
  hankoWitness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
  touchedAccountIds: readonly string[],
): number => {
  let attached = 0;
  for (const accountId of [...new Set(touchedAccountIds.map(value => value.toLowerCase()))].sort()) {
    // Witness attachment changes the Account envelope, even when the Account
    // transition itself was read-only. Claim its Entity-frame shell explicitly:
    // mutating the committed Patricia leaf would either throw (frozen base) or
    // change bytes behind the already cached leaf hash.
    const account = getEntityAccountForWrite(state.accounts, accountId);
    if (!account) throw new Error(`HANKO_ATTACHMENT_TOUCHED_ACCOUNT_MISSING:${accountId}`);
    attached += attachSettlementAccountMempoolHankos(account, state, hankoWitness, entityHeight);
    // Attach the reusable ACK cache first. A bundled pending ack_frame is newer
    // and must leave currentFrameHanko on its proposal, not on the old ACK.
    if (account.lastOutboundAckFrame) {
      attached += attachAccountInputHankos(
        account.lastOutboundAckFrame.response,
        state,
        hankoWitness,
        entityHeight,
        true,
        account,
      );
    }
    if (account.pendingAccountInput) {
      attached += attachAccountInputHankos(
        account.pendingAccountInput,
        state,
        hankoWitness,
        entityHeight,
        true,
        account,
      );
    }
    // Settlement witnesses are attached only into an exact AccountTx `hanko`
    // above. Mutating the workspace directly here would bypass bilateral
    // Account ordering and let an Entity frame appear approved before its peer
    // has committed the same authorization.
  }
  return attached;
};

const addAccountHankoRequirement = (
  requirements: Map<string, AccountHankoWitnessRequirement['type']>,
  hash: string | undefined,
  type: AccountHankoWitnessRequirement['type'],
): void => {
  if (!hash) return;
  const existing = requirements.get(hash);
  if (existing !== undefined && existing !== type) {
    throw new Error(`ACCOUNT_HANKO_WITNESS_TYPE_CONFLICT:${hash}:${existing}:${type}`);
  }
  requirements.set(hash, type);
};

const addAccountInputWitnessRequirements = (
  requirements: Map<string, AccountHankoWitnessRequirement['type']>,
  input: AccountInput,
): void => {
  const boardHankoRefresh = accountInputBoardHankoRefresh(input);
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  addAccountHankoRequirement(requirements, boardHankoRefresh?.frameHash, 'accountFrame');
  addAccountHankoRequirement(requirements, ack?.frameHash, 'accountFrame');
  addAccountHankoRequirement(requirements, proposal?.frame.stateHash, 'accountFrame');
  for (const dispute of [
    boardHankoRefresh?.disputeHanko,
    ack?.disputeHanko,
    proposal?.disputeHanko,
    accountInputDisputeHanko(input),
  ]) addAccountHankoRequirement(requirements, dispute?.hash, 'dispute');
};

/** Exact post-commit witnesses referenced by one resident Account envelope. */
export const accountHankoWitnessRequirements = (
  account: AccountReplica,
): readonly AccountHankoWitnessRequirement[] => {
  const requirements = new Map<string, AccountHankoWitnessRequirement['type']>();
  if (account.lastOutboundAckFrame) {
    addAccountInputWitnessRequirements(requirements, account.lastOutboundAckFrame.response);
  }
  if (account.pendingAccountInput) {
    addAccountInputWitnessRequirements(requirements, account.pendingAccountInput);
  }
  for (const tx of account.mempool) {
    if (tx.type !== 'settle_transition' || tx.data.kind !== 'hanko') continue;
    addAccountHankoRequirement(requirements, tx.data.postProof.disputeHash, 'dispute');
    addAccountHankoRequirement(requirements, tx.data.settlementHash, 'settlement');
  }
  return [...requirements].map(([hash, type]) => ({ hash, type }));
};

export const buildEntityHashesToSign = (
  entityId: string,
  height: number,
  frameHash: string,
  collectedHashes: Array<{ hash: string; type: HashType | string; context: string }> = [],
): HashToSign[] => {
  const seenHashes = new Map<string, { type: string; context: string }>([[frameHash, {
    type: 'entityFrame',
    context: `entity:${entityId.slice(-4)}:frame:${height}`,
  }]]);
  const additionalHashes = collectedHashes
    .map((hashInfo) => {
      const seen = seenHashes.get(hashInfo.hash);
      if (seen) {
        throw new Error(
          `SECONDARY_HASH_DUPLICATE:hash=${hashInfo.hash}:first=${seen.type}:${seen.context}:` +
          `duplicate=${hashInfo.type}:${hashInfo.context}`,
        );
      }
      seenHashes.set(hashInfo.hash, { type: hashInfo.type, context: hashInfo.context });
      return hashInfo;
    })
    .map((hashInfo) => ({
      hash: hashInfo.hash,
      type: hashInfo.type as HashType,
      context: hashInfo.context,
    }))
    .sort((a, b) => compareCanonicalText(a.hash, b.hash));
  return [{
    hash: frameHash,
    type: 'entityFrame',
    context: `entity:${entityId.slice(-4)}:frame:${height}`,
  }, ...additionalHashes];
};

export const getEntityHashManifestMismatch = (
  expected: readonly HashToSign[],
  received: readonly HashToSign[] | undefined,
): string | null => {
  if (!received) return 'manifest missing';
  if (received.length !== expected.length) {
    return `length ${received.length} != ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const local = expected[index]!;
    const remote = received[index]!;
    if (local.hash !== remote.hash || local.type !== remote.type || local.context !== remote.context) {
      return `entry ${index} differs`;
    }
  }
  return null;
};
