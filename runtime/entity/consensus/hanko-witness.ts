import type {
  AccountInput,
  AccountMachine,
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
import { accountInputAck, accountInputDisputeSeal, accountInputProposal } from '../../account/consensus/flush';
import { serializeTaggedJson } from '../../protocol/serialization';

export type HankoWitnessEntry = {
  hanko: HankoString;
  type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch';
  entityHeight: number;
  createdAt: number;
};

export const normalizeProposedFrameCollectedSigs = (frame?: ProposedEntityFrame): void => {
  if (!frame?.collectedSigs) return;
  const normalized = normalizeSignatureMap(frame.collectedSigs);
  if (normalized) frame.collectedSigs = normalized;
};

export const isWitnessHashType = (type: HashType): type is HankoWitnessEntry['type'] => type !== 'entityFrame';

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
  const entry = getTypedWitness(witness, hash, type, entityHeight);
  if (entry) return entry.hanko;
  if (existing) return existing;
  throw new Error(`HANKO_DRAFT_UNSEALED:hash=${hash}:type=${type}:entityHeight=${entityHeight}`);
};

const getOutboundAccount = (state: EntityState | undefined, input: AccountInput): AccountMachine | undefined =>
  state?.accounts.get(input.toEntityId);

const getAckFrameHash = (state: EntityState | undefined, input: AccountInput): string | undefined => {
  const ack = accountInputAck(input);
  if (!ack) return undefined;
  const account = getOutboundAccount(state, input);
  if (!account || Number(account.currentFrame.height) !== Number(ack.height)) return undefined;
  return account.currentFrame.stateHash;
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

  if (input.kind === 'settle' && input.settleAction.type === 'approve') {
    const settlementHash = input.settleAction.settlementHash;
    if (!settlementHash && !input.settleAction.hanko) {
      throw new Error(`SETTLEMENT_HASH_UNRESOLVED:counterparty=${input.toEntityId}`);
    }
    if (settlementHash) {
      input.settleAction.hanko = requireDraftWitness(
        witness,
        settlementHash,
        'settlement',
        entityHeight,
        input.settleAction.hanko,
      );
      sealed += 1;
    }
  }
  return sealed;
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
      if (jTx.type !== 'batch' || !jTx.data?.batchHash) continue;
      const batchHankoEntry = requireDraftWitness(
        hankoWitness,
        jTx.data.batchHash,
        'jBatch',
        entityHeight,
        jTx.data.hankoSignature,
      );
      jTx.data.hankoSignature = batchHankoEntry;
      attachedCount++;
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
    // Seal the reusable ACK cache first. A bundled pending frame_ack is newer
    // and must leave currentFrameHanko on its proposal, not on the old ACK.
    if (account.lastOutboundFrameAck) {
      sealed += sealAccountInput(account.lastOutboundFrameAck.response, state, hankoWitness, entityHeight);
    }
    if (account.pendingAccountInput) {
      sealed += sealAccountInput(account.pendingAccountInput, state, hankoWitness, entityHeight);
    }
    const workspace = account.settlementWorkspace;
    if (workspace?.settlementHash) {
      const hanko = requireDraftWitness(
        hankoWitness,
        workspace.settlementHash,
        'settlement',
        entityHeight,
        state.entityId === account.leftEntity ? workspace.leftHanko : workspace.rightHanko,
      );
      if (state.entityId === account.leftEntity) workspace.leftHanko = hanko;
      else workspace.rightHanko = hanko;
      sealed += 1;
    }
    const postSettlement = workspace?.postSettlementDisputeProof;
    if (postSettlement?.disputeHash) {
      const hanko = requireDraftWitness(
        hankoWitness,
        postSettlement.disputeHash,
        'dispute',
        entityHeight,
        state.entityId === account.leftEntity ? postSettlement.leftHanko : postSettlement.rightHanko,
      );
      if (state.entityId === account.leftEntity) postSettlement.leftHanko = hanko;
      else postSettlement.rightHanko = hanko;
      sealed += 1;
    }
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
      const ackHash = getAckFrameHash(state, input);
      if (accountInputAck(input) && !ackHash) {
        throw new Error(`ACK_FRAME_HASH_UNRESOLVED:counterparty=${input.toEntityId}`);
      }
      if (ackHash) add('accountFrame', ackHash);
      for (const seal of [accountInputAck(input)?.disputeSeal, proposal?.disputeSeal, accountInputDisputeSeal(input)]) {
        if (seal?.hash) add('dispute', seal.hash);
      }
      if (input.kind === 'settle' && input.settleAction.type === 'approve') {
        if (!input.settleAction.settlementHash) throw new Error(`SETTLEMENT_HASH_UNRESOLVED:counterparty=${input.toEntityId}`);
        add('settlement', input.settleAction.settlementHash);
      }
    });
  });
  jOutputs.forEach((jInput, outputIndex) => {
    jInput.jTxs.forEach((jTx, txIndex) => {
      if (jTx.type !== 'batch' || !jTx.data?.batchHash) return;
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
