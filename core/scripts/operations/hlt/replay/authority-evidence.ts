import type { AccountTx } from '../../../../types/account';
import type { EntityTx } from '../../../../types/entity-tx';
import type { PersistedFrameJournal } from '../../../../storage/types';
import {
  buildHltEntityEffectEvidence,
  type HltEntityEffectEvidence,
} from './entity-effect-evidence';
import {
  buildHltEntityFrameEventEvidence,
  type HltEntityFrameEventEvidence,
} from './entity-frame-event-evidence';

const MIN_EXACT_REPLAY_FRAMES = 1_000;

export type HltAuthorityExpectations = Readonly<{
  runtimeFrames: readonly Readonly<{
    height: number;
    timestamp: number;
    postStateHash: string;
    canonicalStateHash: string | null;
  }>[];
  effects: readonly Readonly<{
    runtimeHeight: number;
    outputCount: number;
    orderedOutputDigest: string;
  }>[];
  /** Ordered Entity economic effects projected from the Runtime WAL frame logs. */
  entityEffects: readonly HltEntityEffectEvidence[];
  /** Exact ordered events from the signed EntityFrames carried by Runtime input. */
  entityFrameEvents: readonly HltEntityFrameEventEvidence[];
}>;

export type HltAuthorityEvidence = Readonly<{
  expectations: HltAuthorityExpectations;
}>;

const nestedEntityTxs = (tx: EntityTx): readonly EntityTx[] => {
  if (tx.type === 'entityCommand') return tx.data.txs;
  if (tx.type === 'runtimeOutput') return tx.data.entityTxs;
  return [];
};

type MixedCoverage = {
  payments: number;
  sameChainSwapOffers: number;
  disputePrepare: number;
  disputeFinalizeCommand: number;
  disputeStartedEvent: number;
  disputeFinalizedEvent: number;
};

const assertAccountScope = (tx: AccountTx, coverage: MixedCoverage): void => {
  if (
    tx.type.startsWith('lending_') || tx.type.startsWith('cross_') ||
    tx.type === 'reserve_to_collateral'
  ) throw new Error(`HLT_AUTHORITY_SCOPE_ACCOUNT_TX_FORBIDDEN:${tx.type}`);
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction !== undefined) {
    throw new Error('HLT_AUTHORITY_SCOPE_CROSS_J_SWAP_FORBIDDEN');
  }
  if (tx.type === 'swap_offer') coverage.sameChainSwapOffers += 1;
};

const assertEntityScope = (tx: EntityTx, coverage: MixedCoverage): void => {
  if (
    tx.type === 'crossPullClose' || tx.type.startsWith('crossJurisdiction') ||
    tx.type.startsWith('lending')
  ) throw new Error(`HLT_AUTHORITY_SCOPE_ENTITY_TX_FORBIDDEN:${tx.type}`);
  if (tx.type === 'directPayment' || tx.type === 'htlcPayment') coverage.payments += 1;
  if (tx.type === 'prepareDispute') coverage.disputePrepare += 1;
  if (tx.type === 'disputeFinalize') coverage.disputeFinalizeCommand += 1;
  if (tx.type === 'j_event') {
    for (const block of tx.data.blocks) {
      for (const event of block.events) {
        if (event.type === 'DisputeStarted') coverage.disputeStartedEvent += 1;
        if (event.type === 'DisputeFinalized') coverage.disputeFinalizedEvent += 1;
      }
    }
  }
  if (tx.type === 'accountInput' && tx.data.kind === 'ack_frame') {
    for (const accountTx of tx.data.proposal.frame.accountTxs) assertAccountScope(accountTx, coverage);
  }
  for (const nested of nestedEntityTxs(tx)) assertEntityScope(nested, coverage);
};

const inspectCanonicalScope = (frames: readonly PersistedFrameJournal[]): MixedCoverage => {
  const coverage: MixedCoverage = {
    payments: 0,
    sameChainSwapOffers: 0,
    disputePrepare: 0,
    disputeFinalizeCommand: 0,
    disputeStartedEvent: 0,
    disputeFinalizedEvent: 0,
  };
  for (const frame of frames) {
    for (const input of frame.runtimeInput.entityInputs) {
      for (const tx of input.entityTxs ?? []) assertEntityScope(tx, coverage);
      for (const tx of input.proposedFrame?.txs ?? []) assertEntityScope(tx, coverage);
    }
  }
  return coverage;
};

export const buildHltAuthorityEvidence = (
  frames: readonly PersistedFrameJournal[],
): HltAuthorityEvidence => {
  inspectCanonicalScope(frames);
  return {
    expectations: {
      runtimeFrames: frames.map(frame => ({
        height: frame.height,
        timestamp: frame.timestamp,
        postStateHash: frame.postStateHash,
        canonicalStateHash: frame.canonicalStateHash ?? null,
      })),
      effects: frames.map(frame => ({
        runtimeHeight: frame.height,
        outputCount: frame.runtimeOutputCount,
        orderedOutputDigest: frame.runtimeOutputsDigest,
      })),
      entityEffects: frames.map(frame => buildHltEntityEffectEvidence(frame.height, frame.logs)),
      entityFrameEvents: frames.map(buildHltEntityFrameEventEvidence),
    },
  };
};

export const assertCompleteHltAuthorityEvidence = (evidence: HltAuthorityEvidence): void => {
  const { runtimeFrames, effects, entityEffects, entityFrameEvents } = evidence.expectations;
  if (runtimeFrames.length < MIN_EXACT_REPLAY_FRAMES) {
    throw new Error(`HLT_AUTHORITY_EVIDENCE_RUNTIME_FRAMES_MINIMUM:${runtimeFrames.length}:${MIN_EXACT_REPLAY_FRAMES}`);
  }
  if (
    effects.length !== runtimeFrames.length || entityEffects.length !== runtimeFrames.length ||
    entityFrameEvents.length !== runtimeFrames.length
  ) {
    throw new Error(
      `HLT_AUTHORITY_EVIDENCE_FRAME_COUNT_MISMATCH:` +
      `runtime=${runtimeFrames.length}:effects=${effects.length}:entityEffects=${entityEffects.length}:` +
      `entityFrameEvents=${entityFrameEvents.length}`,
    );
  }
  const missingRoot = runtimeFrames.find(frame => frame.canonicalStateHash === null);
  if (missingRoot) throw new Error(`HLT_AUTHORITY_EVIDENCE_RUNTIME_ROOT_MISSING:${missingRoot.height}`);
  for (let index = 1; index < runtimeFrames.length; index += 1) {
    const previous = runtimeFrames[index - 1];
    const current = runtimeFrames[index];
    if (previous === undefined || current === undefined) {
      throw new Error(`HLT_AUTHORITY_EVIDENCE_RUNTIME_FRAME_INDEX:${index}`);
    }
    if (current.height !== previous.height + 1) {
      throw new Error(`HLT_AUTHORITY_EVIDENCE_RUNTIME_FRAME_GAP:${previous.height}:${current.height}`);
    }
  }
};

export const assertCanonicalMixedCoverage = (frames: readonly PersistedFrameJournal[]): void => {
  const coverage = inspectCanonicalScope(frames);
  for (const [field, count] of Object.entries(coverage)) {
    if (count < 1) throw new Error(`HLT_AUTHORITY_EVIDENCE_MIXED_COVERAGE_MISSING:${field}`);
  }
};
