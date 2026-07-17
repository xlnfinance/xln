import type {
  AccountInput,
  AccountMachine,
  AccountTx,
  EntityInput,
  EntityState,
  HankoString,
  HashToSign,
  HashType,
  JInput,
  ProposedEntityFrame,
} from '../../types';
import { compareCanonicalText } from '../../orderbook/swap-execution';
import { normalizeSignatureMap } from '../../protocol/signatures';
import {
  accountInputAck,
  accountInputBoardReseal,
  accountInputDisputeSeal,
  accountInputProposal,
} from '../../account/consensus/flush';
import { serializeTaggedJson } from '../../protocol/serialization';
import {
  cloneIsolatedAccountInput,
  cloneIsolatedAccountTx,
} from '../../protocol/account-input-clone';

export type HankoWitnessEntry = {
  hanko: HankoString;
  type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch' | 'entityProviderAction';
  entityHeight: number;
  createdAt: number;
};

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

export const normalizeProposedFrameCollectedSigs = (frame?: ProposedEntityFrame): void => {
  if (!frame?.collectedSigs) return;
  const normalized = normalizeSignatureMap(frame.collectedSigs);
  if (normalized) frame.collectedSigs = normalized;
};

export const isWitnessHashType = (type: HashType): type is HankoWitnessEntry['type'] =>
  type !== 'entityFrame' && type !== 'entityOutput';

/**
 * Return the consensus payload before post-commit quorum witnesses are
 * attached. These exact Hanko fields are self-authenticating and cannot be
 * included in a digest signed by the same quorum without creating a cycle.
 */
export const cloneAccountInputWithoutPostCommitHankos = (input: AccountInput): AccountInput => {
  const unsigned = cloneIsolatedAccountInput(input);
  const ack = accountInputAck(unsigned);
  if (ack) {
    delete ack.frameHanko;
    if (ack.disputeSeal) delete ack.disputeSeal.hanko;
  }
  const proposal = accountInputProposal(unsigned);
  if (proposal) {
    delete proposal.frameHanko;
    if (proposal.disputeSeal) delete proposal.disputeSeal.hanko;
  }
  const disputeSeal = accountInputDisputeSeal(unsigned);
  if (disputeSeal) delete disputeSeal.hanko;
  const reseal = accountInputBoardReseal(unsigned);
  if (reseal) delete reseal.frameHanko;
  return unsigned;
};

export const cloneAccountTxWithoutPostCommitHankos = (tx: AccountTx): AccountTx => {
  const unsigned = cloneIsolatedAccountTx(tx);
  if (unsigned.type === 'settle_transition' && unsigned.data.kind === 'seal') {
    delete unsigned.data.settlementHanko;
    delete unsigned.data.postProof.hanko;
  }
  return unsigned;
};

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
    // This field was sealed by an earlier committed Entity frame. The Hanko
    // signs the exact secondary hash, not every later frame that merely keeps
    // the cached ACK/proposal in state. Requiring the old witness to acquire
    // the current height makes any unrelated next frame fail after restore.
    return existing;
  }
  const entry = getTypedWitness(witness, hash, type, entityHeight);
  if (entry) return entry.hanko;
  throw new Error(`HANKO_DRAFT_UNSEALED:hash=${hash}:type=${type}:entityHeight=${entityHeight}`);
};

const getOutboundAccount = (state: EntityState | undefined, input: AccountInput): AccountMachine | undefined =>
  state?.accounts.get(input.toEntityId);

const getAckFrameHash = (state: EntityState | undefined, input: AccountInput): string | undefined => {
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

const sealDispute = (
  seal: ReturnType<typeof accountInputDisputeSeal>,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): HankoString | undefined => {
  if (!seal) return undefined;
  seal.hanko = requireDraftWitness(witness, seal.hash, 'dispute', entityHeight, seal.hanko);
  return seal.hanko;
};

const sealAccountInput = (
  input: AccountInput,
  state: EntityState | undefined,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): number => {
  let sealed = 0;
  const account = getOutboundAccount(state, input);
  const reseal = accountInputBoardReseal(input);
  if (reseal) {
    reseal.frameHanko = requireDraftWitness(
      witness,
      reseal.frameHash,
      'accountFrame',
      entityHeight,
      reseal.frameHanko,
    );
    if (account) account.currentFrameHanko = reseal.frameHanko;
    sealed += 1;
  }
  const ack = accountInputAck(input);
  if (ack) {
    const ackHash = getAckFrameHash(state, input);
    if (!ackHash && !ack.frameHanko) {
      throw new Error(`ACK_FRAME_HASH_UNRESOLVED:counterparty=${input.toEntityId}:height=${ack.height}`);
    }
    if (ackHash) {
      ack.frameHanko = requireDraftWitness(witness, ackHash, 'accountFrame', entityHeight, ack.frameHanko);
      if (account) account.currentFrameHanko = ack.frameHanko;
      sealed += 1;
    }
  }

  // A frame_ack first acknowledges the committed current frame and then opens
  // the next pending proposal. Preserve that semantic order: currentFrameHanko
  // must end on the new proposal exactly as proposeAccountFrame did before the
  // multisig two-phase sealing path existed.
  const proposal = accountInputProposal(input);
  if (proposal?.frame.stateHash) {
    proposal.frameHanko = requireDraftWitness(
      witness,
      proposal.frame.stateHash,
      'accountFrame',
      entityHeight,
      proposal.frameHanko,
    );
    if (account) account.currentFrameHanko = proposal.frameHanko;
    sealed += 1;
  }

  const seals = [ack?.disputeSeal, proposal?.disputeSeal, accountInputDisputeSeal(input)];
  for (const seal of seals) {
    const hanko = sealDispute(seal, witness, entityHeight);
    if (!hanko) continue;
    if (account) account.currentDisputeProofHanko = hanko;
    sealed += 1;
  }

  return sealed;
};

const sealSettlementAccountTx = (
  tx: AccountTx,
  account: AccountMachine,
  state: EntityState,
  witness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): number => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'seal') return 0;
  const localIsLeft = state.entityId.toLowerCase() === account.leftEntity.toLowerCase();
  if (!localIsLeft && state.entityId.toLowerCase() !== account.rightEntity.toLowerCase()) {
    throw new Error(`SETTLEMENT_SEAL_LOCAL_ENTITY_MISMATCH:${state.entityId}`);
  }
  let sealed = 0;
  const workspace = account.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_SEAL_WORKSPACE_MISSING');
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
    sealed += 1;
  }
  tx.data.postProof.hanko = requireDraftWitness(
    witness,
    tx.data.postProof.disputeHash,
    'dispute',
    entityHeight,
    tx.data.postProof.hanko,
  );
  return sealed + 1;
};

/**
 * A settlement seal is created while replaying an Entity frame, but its Hanko
 * exists only after that frame reaches board quorum. Feeding the unsigned
 * draft into bilateral Account consensus in the same frame would consume it
 * as an invalid transaction before the commit path can attach the witness.
 */
export const accountTxAwaitsPostCommitHanko = (
  tx: AccountTx,
  account: AccountMachine,
  state: EntityState,
): boolean => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'seal') return false;
  if (!tx.data.postProof.hanko) return true;
  const workspace = account.settlementWorkspace;
  if (!workspace) return false;
  const localIsLeft = state.entityId.toLowerCase() === account.leftEntity.toLowerCase();
  if (!localIsLeft && state.entityId.toLowerCase() !== account.rightEntity.toLowerCase()) return false;
  const localIsExecutor = workspace.executorIsLeft === localIsLeft;
  return !localIsExecutor && !tx.data.settlementHanko;
};

export const attachHankoWitnessToOutputs = (
  outputs: EntityInput[],
  jOutputs: JInput[],
  hankoWitness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
  state?: EntityState,
): number => {
  let attachedCount = 0;

  for (const output of outputs) {
    const txs = Array.isArray(output.entityTxs) ? output.entityTxs : [];
    for (const tx of txs) {
      if (tx.type !== 'accountInput') continue;
      const accountInput = tx.data;
      if (!accountInput) continue;
      attachedCount += sealAccountInput(accountInput, state, hankoWitness, entityHeight);
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
    }
  }

  return attachedCount;
};

export const sealHankoWitnessInState = (
  state: EntityState,
  hankoWitness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): number => {
  let sealed = 0;
  for (const account of state.accounts.values()) {
    for (const tx of account.mempool) {
      sealed += sealSettlementAccountTx(tx, account, state, hankoWitness, entityHeight);
    }
    // Seal the reusable ACK cache first. A bundled pending frame_ack is newer
    // and must leave currentFrameHanko on its proposal, not on the old ACK.
    if (account.lastOutboundFrameAck) {
      sealed += sealAccountInput(account.lastOutboundFrameAck.response, state, hankoWitness, entityHeight);
    }
    if (account.pendingAccountInput) {
      sealed += sealAccountInput(account.pendingAccountInput, state, hankoWitness, entityHeight);
    }
    // Settlement witnesses are sealed only into an exact AccountTx `seal`
    // above. Mutating the workspace directly here would bypass bilateral
    // Account ordering and let an Entity frame appear approved before its peer
    // has committed the same authorization.
  }
  return sealed;
};

export type HankoOutputBinding = {
  output: number;
  tx: number;
  routedEntity: string;
  routedSigner: string;
  from: string;
  to: string;
  kind: string;
  type: HankoWitnessEntry['type'];
  hash: string;
};

export const buildHankoOutputBindings = (
  outputs: readonly EntityInput[],
  jOutputs: readonly JInput[],
  state: EntityState,
): HankoOutputBinding[] => {
  const bindings: HankoOutputBinding[] = [];
  outputs.forEach((output, outputIndex) => {
    (output.entityTxs ?? []).forEach((tx, txIndex) => {
      if (tx.type !== 'accountInput') return;
      const input = tx.data;
      const add = (type: HankoWitnessEntry['type'], hash: string) => bindings.push({
        output: outputIndex,
        tx: txIndex,
        routedEntity: output.entityId.toLowerCase(),
        routedSigner: output.signerId.toLowerCase(),
        from: input.fromEntityId.toLowerCase(),
        to: input.toEntityId.toLowerCase(),
        kind: input.kind,
        type,
        hash,
      });
      const proposal = accountInputProposal(input);
      if (proposal?.frame.stateHash) add('accountFrame', proposal.frame.stateHash);
      const reseal = accountInputBoardReseal(input);
      if (reseal?.frameHash) add('accountFrame', reseal.frameHash);
      const ackHash = getAckFrameHash(state, input);
      if (accountInputAck(input) && !ackHash) {
        throw new Error(`ACK_FRAME_HASH_UNRESOLVED:counterparty=${input.toEntityId}`);
      }
      if (ackHash) add('accountFrame', ackHash);
      for (const seal of [accountInputAck(input)?.disputeSeal, proposal?.disputeSeal, accountInputDisputeSeal(input)]) {
        if (seal?.hash) add('dispute', seal.hash);
      }
    });
  });
  jOutputs.forEach((jInput, outputIndex) => {
    jInput.jTxs.forEach((jTx, txIndex) => {
      if (jTx.type === 'batch' && jTx.data?.batchHash) {
        bindings.push({
          output: outputs.length + outputIndex,
          tx: txIndex,
          routedEntity: state.entityId.toLowerCase(),
          routedSigner: state.entityId.toLowerCase(),
          from: state.entityId.toLowerCase(),
          to: jInput.jurisdictionName,
          kind: 'jBatch',
          type: 'jBatch',
          hash: jTx.data.batchHash,
        });
      }
      if (
        jTx.type === 'entityProviderTransfer' ||
        jTx.type === 'entityProviderReleaseControlShares' ||
        jTx.type === 'entityProviderCancelAction'
      ) {
        bindings.push({
          output: outputs.length + outputIndex,
          tx: txIndex,
          routedEntity: state.entityId.toLowerCase(),
          routedSigner: state.entityId.toLowerCase(),
          from: state.entityId.toLowerCase(),
          to: jInput.jurisdictionName,
          kind: jTx.type,
          type: 'entityProviderAction',
          hash: jTx.data.intent.actionHash,
        });
      }
    });
  });
  return bindings;
};

export const getHankoOutputBindingMismatch = (
  expected: readonly HankoOutputBinding[],
  received: readonly HankoOutputBinding[],
): string | null => serializeTaggedJson(expected) === serializeTaggedJson(received)
  ? null
  : `expected=${serializeTaggedJson(expected)} received=${serializeTaggedJson(received)}`;

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
