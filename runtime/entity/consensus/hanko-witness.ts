import type { EntityInput, HankoString, HashToSign, HashType, JInput, ProposedEntityFrame } from '../../types';
import { compareCanonicalText } from '../../swap-execution';
import { normalizeSignatureMap } from '../../protocol/signatures';
import { accountInputAck, accountInputDisputeSeal, accountInputProposal } from '../../account/consensus/flush';

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

export const attachHankoWitnessToOutputs = (
  outputs: EntityInput[],
  jOutputs: JInput[],
  hankoWitness: Map<string, HankoWitnessEntry>,
  entityHeight: number,
): number => {
  let attachedCount = 0;

  for (const output of outputs) {
    const txs = Array.isArray(output.entityTxs) ? output.entityTxs : [];
    for (const tx of txs) {
      if (tx.type !== 'accountInput') continue;
      const accountInput = tx.data;
      if (!accountInput) continue;

      const proposal = accountInputProposal(accountInput);
      if (proposal?.frame.stateHash) {
        const frameHankoEntry = hankoWitness.get(proposal.frame.stateHash);
        if (frameHankoEntry) {
          proposal.frameHanko = frameHankoEntry.hanko;
          attachedCount++;
        }
      }

      const seals = [accountInputAck(accountInput)?.disputeSeal, proposal?.disputeSeal, accountInputDisputeSeal(accountInput)];
      for (const seal of seals) {
        if (!seal) continue;
        const disputeHankoEntry = hankoWitness.get(seal.hash);
        if (disputeHankoEntry) {
          seal.hanko = disputeHankoEntry.hanko;
          attachedCount++;
        }
      }

      if (accountInput.kind === 'settle' && accountInput.settleAction.type === 'approve' && accountInput.settleAction.hanko) {
        for (const entry of hankoWitness.values()) {
          if (entry.type === 'settlement' && entry.entityHeight === entityHeight) {
            accountInput.settleAction.hanko = entry.hanko;
            attachedCount++;
            break;
          }
        }
      }
    }
  }

  for (const jInput of jOutputs) {
    for (const jTx of jInput.jTxs) {
      if (jTx.type !== 'batch' || !jTx.data?.batchHash) continue;
      const batchHankoEntry = hankoWitness.get(jTx.data.batchHash);
      if (!batchHankoEntry) continue;
      jTx.data.hankoSignature = batchHankoEntry.hanko;
      attachedCount++;
    }
  }

  return attachedCount;
};

export const buildEntityHashesToSign = (
  entityId: string,
  height: number,
  frameHash: string,
  collectedHashes: Array<{ hash: string; type: HashType | string; context: string }> = [],
): HashToSign[] => {
  const seenHashes = new Set<string>([frameHash]);
  const additionalHashes = collectedHashes
    .filter((hashInfo) => {
      if (seenHashes.has(hashInfo.hash)) return false;
      seenHashes.add(hashInfo.hash);
      return true;
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
