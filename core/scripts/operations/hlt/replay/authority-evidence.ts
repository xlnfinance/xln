import type { AccountTx } from '../../../../types/account';
import type { EntityTx } from '../../../../types/entity-tx';
import type { PersistedFrameJournal } from '../../../../storage/types';
import {
  buildHltEntityEffectEvidence,
  type HltEntityEffectEvidence,
} from './entity-effect-evidence';

export type HltAuthorityExpectations = Readonly<{
  runtimeFrames: readonly Readonly<{
    height: number;
    timestamp: number;
    postStateHash: string;
    runtimeStateHash: string | null;
  }>[];
  effects: readonly Readonly<{
    runtimeHeight: number;
    outputCount: number;
    orderedOutputDigest: string;
  }>[];
  /** Ordered Entity economic effects projected from the Runtime WAL frame logs. */
  entityEffects: readonly HltEntityEffectEvidence[];
}>;

export type HltAuthorityEvidence = Readonly<{
  expectations: HltAuthorityExpectations;
}>;

const nestedEntityTxs = (tx: EntityTx): readonly EntityTx[] => {
  if (tx.type === 'entityCommand') return tx.data.txs;
  if (tx.type === 'runtimeOutput') return tx.data.entityTxs;
  return [];
};

const assertAccountFeaturePolicy = (tx: AccountTx): void => {
  if (
    tx.type.startsWith('lending_') || tx.type.startsWith('cross_') ||
    tx.type === 'reserve_to_collateral'
  ) throw new Error(`HLT_AUTHORITY_FEATURE_POLICY_ACCOUNT_TX_FORBIDDEN:${tx.type}`);
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction !== undefined) {
    throw new Error('HLT_AUTHORITY_FEATURE_POLICY_CROSS_J_SWAP_FORBIDDEN');
  }
};

const assertEntityFeaturePolicy = (tx: EntityTx): void => {
  if (
    tx.type === 'disputeStart' || tx.type === 'disputeFinalize' ||
    tx.type === 'crossPullClose' || tx.type.startsWith('crossJurisdiction') ||
    tx.type.startsWith('lending') || tx.type === 'runtimeOutput'
  ) throw new Error(`HLT_AUTHORITY_FEATURE_POLICY_ENTITY_TX_FORBIDDEN:${tx.type}`);
  if (tx.type === 'accountInput' && (tx.data.kind === 'frame' || tx.data.kind === 'ack_frame')) {
    for (const accountTx of tx.data.proposal.frame.accountTxs) assertAccountFeaturePolicy(accountTx);
  }
  for (const nested of nestedEntityTxs(tx)) assertEntityFeaturePolicy(nested);
};

const assertFeaturePolicy = (frames: readonly PersistedFrameJournal[]): void => {
  for (const frame of frames) {
    for (const input of frame.runtimeInput.entityInputs) {
      for (const tx of input.entityTxs ?? []) assertEntityFeaturePolicy(tx);
      for (const tx of input.proposedFrame?.txs ?? []) assertEntityFeaturePolicy(tx);
    }
  }
};

export const buildHltAuthorityEvidence = (
  frames: readonly PersistedFrameJournal[],
): HltAuthorityEvidence => {
  assertFeaturePolicy(frames);
  return {
    expectations: {
      runtimeFrames: frames.map(frame => ({
        height: frame.height,
        timestamp: frame.timestamp,
        postStateHash: frame.postStateHash,
        runtimeStateHash: frame.runtimeStateHash ?? null,
      })),
      effects: frames.map(frame => ({
        runtimeHeight: frame.height,
        outputCount: frame.runtimeOutputCount,
        orderedOutputDigest: frame.runtimeOutputsDigest,
      })),
      entityEffects: frames.map(frame => buildHltEntityEffectEvidence(frame.height, frame.logs)),
    },
  };
};

export const assertCompleteHltAuthorityEvidence = (evidence: HltAuthorityEvidence): void => {
  const { runtimeFrames, effects, entityEffects } = evidence.expectations;
  if (runtimeFrames.length === 0) throw new Error('HLT_AUTHORITY_EVIDENCE_RUNTIME_FRAMES_EMPTY');
  if (effects.length !== runtimeFrames.length || entityEffects.length !== runtimeFrames.length) {
    throw new Error(
      `HLT_AUTHORITY_EVIDENCE_FRAME_COUNT_MISMATCH:` +
      `runtime=${runtimeFrames.length}:effects=${effects.length}:entityEffects=${entityEffects.length}`,
    );
  }
  const missingRoot = runtimeFrames.find(frame => frame.runtimeStateHash === null);
  if (missingRoot) throw new Error(`HLT_AUTHORITY_EVIDENCE_RUNTIME_ROOT_MISSING:${missingRoot.height}`);
};
