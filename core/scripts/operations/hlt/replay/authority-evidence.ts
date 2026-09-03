import type { AccountTx } from '../../../../types/account';
import type { EntityInput } from '../../../../entity/types';
import type { EntityTx } from '../../../../types/entity-tx';
import type { PersistedFrameJournal } from '../../../../storage/types';
import type { RoutedEntityInput } from '../../../../runtime/types';
import type { HltEntityEffectEvidence } from './entity-effect-evidence';
import type { HltEntityFrameEventEvidence } from './entity-frame-event-evidence';
import { HLT_AUTHORITY_MIN_RUNTIME_FRAMES } from '../authority-evidence-policy';

// Production framing coalesces a busy second into a handful of Runtime
// frames, so exactness is measured in admitted bilateral Account inputs. The
// real-frame floor exercises a long dirty WAL tail after the explicit
// parity base checkpoint without replacing production checkpoint cadence.
const MIN_EXACT_REPLAY_ACCOUNT_INPUTS = 10_000;

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
}>;

export type HltAuthorityEvidence = Readonly<{
  expectations: HltAuthorityExpectations;
}>;

export type HltLocalContinuationEvidence = Readonly<{
  runtimeHeight: number;
  inputs: readonly RoutedEntityInput[];
}>;

/** Replay-only facts observed at the TS Runtime output-plan seam. */
export type HltTsParityExpectations = HltAuthorityExpectations & Readonly<{
  /** Ordered Entity economic effects observed from the replayed transition. */
  entityEffects: readonly HltEntityEffectEvidence[];
  /** Exact ordered events from signed EntityFrames emitted by the replay. */
  entityFrameEvents: readonly HltEntityFrameEventEvidence[];
  localContinuations: readonly HltLocalContinuationEvidence[];
}>;

const nestedEntityTxs = (tx: EntityTx): readonly EntityTx[] => {
  if (tx.type === 'entityCommand') return tx.data.txs;
  if (tx.type === 'runtimeOutput') return tx.data.entityTxs;
  return [];
};

type MixedCoverage = {
  payments: number;
  accountInputs: number;
  directEntityPayments: number;
  extendCreditCommands: number;
  scheduledWakes: number;
  jBroadcastCommands: number;
  directAccountPayments: number;
  sameChainSwapOffers: number;
  sameChainSwapResolves: number;
  sameChainSwapCancels: number;
  rebalancePolicies: number;
  disputePrepare: number;
  disputeFinalizeCommand: number;
  disputeStartedEvent: number;
  disputeFinalizedEvent: number;
  settleCommands: number;
  settleUpdates: number;
  settleRejects: number;
  settleTransitions: number;
  jEventClaims: number;
  accountSettledEvent: number;
  collateralRequests: number;
};

const countDisputeEvent = (eventType: string, coverage: MixedCoverage): void => {
  if (eventType === 'DisputeStarted') coverage.disputeStartedEvent += 1;
  if (eventType === 'DisputeFinalized') coverage.disputeFinalizedEvent += 1;
  if (eventType === 'AccountSettled') coverage.accountSettledEvent += 1;
};

const inspectJPrefixScope = (input: EntityInput, coverage: MixedCoverage): void => {
  for (const attestation of input.jPrefixAttestations?.values() ?? []) {
    for (const block of attestation.blocks) {
      for (const event of block.events) countDisputeEvent(event.type, coverage);
    }
  }
};

const assertAccountScope = (tx: AccountTx, coverage: MixedCoverage): void => {
  if (
    tx.type.startsWith('lending_') || tx.type.startsWith('cross_') ||
    false
  ) throw new Error(`HLT_AUTHORITY_SCOPE_ACCOUNT_TX_FORBIDDEN:${tx.type}`);
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction !== undefined) {
    throw new Error('HLT_AUTHORITY_SCOPE_CROSS_J_SWAP_FORBIDDEN');
  }
  if (tx.type === 'swap_offer') coverage.sameChainSwapOffers += 1;
  if (tx.type === 'swap_resolve') coverage.sameChainSwapResolves += 1;
  if (tx.type === 'swap_cancel_request') coverage.sameChainSwapCancels += 1;
  if (tx.type === 'direct_payment') coverage.directAccountPayments += 1;
  if (tx.type === 'rebalance_policy') coverage.rebalancePolicies += 1;
  if (tx.type === 'settle_transition') coverage.settleTransitions += 1;
  if (tx.type === 'j_event_claim') coverage.jEventClaims += 1;
  if (tx.type === 'request_collateral') coverage.collateralRequests += 1;
};

const assertEntityScope = (tx: EntityTx, coverage: MixedCoverage): void => {
  if (
    tx.type === 'crossPullClose' || tx.type.startsWith('crossJurisdiction') ||
    tx.type.startsWith('lending')
  ) throw new Error(`HLT_AUTHORITY_SCOPE_ENTITY_TX_FORBIDDEN:${tx.type}`);
  if (tx.type === 'directPayment' || tx.type === 'htlcPayment') coverage.payments += 1;
  if (tx.type === 'accountInput') coverage.accountInputs += 1;
  if (tx.type === 'directPayment') coverage.directEntityPayments += 1;
  if (tx.type === 'extendCredit') coverage.extendCreditCommands += 1;
  if (tx.type === 'scheduledWake') coverage.scheduledWakes += 1;
  if (tx.type === 'j_broadcast') coverage.jBroadcastCommands += 1;
  if (tx.type === 'prepareDispute') coverage.disputePrepare += 1;
  if (tx.type === 'disputeFinalize') coverage.disputeFinalizeCommand += 1;
  if (tx.type === 'settle_propose' || tx.type === 'settle_execute') coverage.settleCommands += 1;
  if (tx.type === 'settle_update') coverage.settleUpdates += 1;
  if (tx.type === 'settle_reject') coverage.settleRejects += 1;
  if (tx.type === 'j_event') {
    for (const block of tx.data.blocks) {
      for (const event of block.events) countDisputeEvent(event.type, coverage);
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
    accountInputs: 0,
    directEntityPayments: 0,
    extendCreditCommands: 0,
    scheduledWakes: 0,
    jBroadcastCommands: 0,
    directAccountPayments: 0,
    sameChainSwapOffers: 0,
    sameChainSwapResolves: 0,
    sameChainSwapCancels: 0,
    rebalancePolicies: 0,
    disputePrepare: 0,
    disputeFinalizeCommand: 0,
    disputeStartedEvent: 0,
    disputeFinalizedEvent: 0,
    settleCommands: 0,
    settleUpdates: 0,
    settleRejects: 0,
    settleTransitions: 0,
    jEventClaims: 0,
    accountSettledEvent: 0,
    collateralRequests: 0,
  };
  for (const frame of frames) {
    for (const input of frame.runtimeInput.entityInputs) {
      inspectJPrefixScope(input, coverage);
      for (const tx of input.entityTxs ?? []) assertEntityScope(tx, coverage);
      for (const tx of input.proposedFrame?.txs ?? []) assertEntityScope(tx, coverage);
    }
    for (const output of frame.runtimeOutputs ?? []) {
      for (const tx of output.entityTxs ?? []) assertEntityScope(tx, coverage);
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
    },
  };
};

export const assertCompleteHltAuthorityEvidence = (evidence: HltAuthorityEvidence): void => {
  const { runtimeFrames, effects } = evidence.expectations;
  if (runtimeFrames.length < HLT_AUTHORITY_MIN_RUNTIME_FRAMES) {
    throw new Error(
      `HLT_AUTHORITY_EVIDENCE_RUNTIME_FRAMES_MINIMUM:${runtimeFrames.length}:` +
      String(HLT_AUTHORITY_MIN_RUNTIME_FRAMES),
    );
  }
  if (
    effects.length !== runtimeFrames.length
  ) {
    throw new Error(
      `HLT_AUTHORITY_EVIDENCE_FRAME_COUNT_MISMATCH:` +
      `runtime=${runtimeFrames.length}:effects=${effects.length}`,
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
  if (coverage.accountInputs < MIN_EXACT_REPLAY_ACCOUNT_INPUTS) {
    throw new Error(
      `HLT_AUTHORITY_EVIDENCE_ACCOUNT_INPUTS_MINIMUM:${coverage.accountInputs}:${MIN_EXACT_REPLAY_ACCOUNT_INPUTS}`,
    );
  }
};
