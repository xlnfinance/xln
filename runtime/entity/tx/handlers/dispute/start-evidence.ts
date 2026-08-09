import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { ethers } from 'ethers';
import { addMessage } from '../../../frame-events';
import {
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
  sanitizeOptionalDisputeStarterArgumentPair,
} from '../../../../jurisdiction/machine/batch';
import { hashProofBodyStruct } from '../../../../protocol/dispute/proof-builder';
import {
  requireDisputeArgumentSnapshot,
  type DisputeArgumentSide,
} from '../../../../protocol/dispute/arguments';
import { buildDisputeArgumentsForSnapshot } from '../../../dispute-arguments';
import { shortHash, shortId } from '../../../../infra/logger';
import {
  canonicalizeProofBodyStruct,
  disputeLog,
  reportOptionalArgumentWarnings,
  requireProofBodyStruct,
} from './shared';

export type StartEvidence = {
  initialProofbody: ProofBodyStruct;
  proofBodyHash: string;
  counterpartyHanko: string;
  storedDisputeHash?: string;
  signedNonce: number;
  proposerIsLeft: boolean;
  nonceSource: string;
  jNonce: number;
  starterInitialArguments: string;
  starterCounterArguments: string;
  starterCounterProofCommitment: string;
};

export const resolveStoredDisputeStartNonce = (
  account: AccountReplica,
  proofBodyHash: string,
): { signedNonce: number; nonceSource: string } => {
  let signedNonce = account.disputeProofNoncesByHash?.[proofBodyHash]
    ?? account.proofHeader.nextProofNonce;
  let nonceSource = account.disputeProofNoncesByHash?.[proofBodyHash] !== undefined
    ? 'hashMap'
    : 'proofHeader';
  if (
    account.counterpartyDisputeProofNonce !== undefined &&
    account.counterpartyDisputeProofNonce > signedNonce
  ) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig(fresher)';
  } else if (
    account.disputeProofNoncesByHash?.[proofBodyHash] === undefined &&
    account.counterpartyDisputeProofNonce !== undefined
  ) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig';
  }
  return { signedNonce, nonceSource };
};

export const selectCounterDisputeSnapshots = (
  account: AccountReplica,
  starterSide: DisputeArgumentSide,
  signedNonce: number,
  initialProposerIsLeft: boolean,
  counterpartyId: string,
) => {
  const counterHash = account.currentDisputeProofBodyHash;
  const counterNonce = account.currentDisputeProofNonce;
  const counterProposerIsLeft = account.currentDisputeProofProposerIsLeft;
  if (
    !counterHash ||
    counterNonce === undefined ||
    typeof counterProposerIsLeft !== 'boolean'
  ) return [];
  const outranksInitial =
    counterNonce > signedNonce ||
    (
      counterNonce === signedNonce &&
      counterProposerIsLeft &&
      !initialProposerIsLeft
    );
  if (!outranksInitial) return [];
  const snapshot = account.disputeArgumentSnapshotsByHash?.[counterHash];
  if (!snapshot) {
    throw new Error(`DISPUTE_START_COUNTER_ARGUMENT_SNAPSHOT_MISSING:${counterpartyId}:${counterHash}`);
  }
  if (
    snapshot.side !== starterSide ||
    snapshot.nonce !== counterNonce ||
    snapshot.proposerIsLeft !== counterProposerIsLeft
  ) {
    throw new Error(`DISPUTE_START_COUNTER_ARGUMENT_SNAPSHOT_MISMATCH:${counterpartyId}:${counterHash}`);
  }
  return [snapshot];
};

export const loadStartProof = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
): Omit<
  StartEvidence,
  | 'signedNonce'
  | 'nonceSource'
  | 'jNonce'
  | 'starterInitialArguments'
  | 'starterCounterArguments'
  | 'starterCounterProofCommitment'
> | null => {
  const counterpartyHanko = account.counterpartyDisputeProofHanko;
  if (!counterpartyHanko || counterpartyHanko === '0x' || counterpartyHanko.length <= 2) {
    addMessage(state, '❌ Missing counterparty dispute hanko - cannot start dispute');
    disputeLog.error('start.hanko_missing', { counterparty: shortId(counterpartyId) });
    return null;
  }
  disputeLog.debug('start.hanko_loaded', {
    counterparty: shortId(counterpartyId),
    length: counterpartyHanko.length,
    prefix: shortHash(counterpartyHanko, 18),
    sigBytes: Math.max(counterpartyHanko.length - 2, 0) / 2,
  });
  const proofBodyHash = account.counterpartyDisputeProofBodyHash;
  const proposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  if (typeof proposerIsLeft !== 'boolean') {
    throw new Error(`DISPUTE_START_PROPOSER_ROLE_MISSING:${counterpartyId}`);
  }
  if (!proofBodyHash) {
    addMessage(
      state,
      '❌ Missing stored counterparty proofBodyHash - cannot start dispute safely',
    );
    disputeLog.error('start.proof_body_hash_missing', { counterparty: shortId(counterpartyId) });
    return null;
  }
  const initialProofbody = canonicalizeProofBodyStruct(
    requireProofBodyStruct(
      account.disputeProofBodiesByHash?.[proofBodyHash],
      sourceState.entityId,
      counterpartyId,
      'disputeStart.initial',
    ),
    sourceState.entityId,
    counterpartyId,
    'disputeStart.initial',
  );
  assertDisputeProofBodyWithinContractLimits(initialProofbody, 'disputeStart.initial');
  const revealedHash = hashProofBodyStruct(initialProofbody);
  if (revealedHash.toLowerCase() !== proofBodyHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_START_PROOFBODY_HASH_MISMATCH:${counterpartyId}:${proofBodyHash}:${revealedHash}`,
    );
  }
  requireDisputeArgumentSnapshot(account, proofBodyHash, 'disputeStart.initial');
  return {
    initialProofbody,
    proofBodyHash,
    counterpartyHanko,
    proposerIsLeft,
    ...(account.counterpartyDisputeHash
      ? { storedDisputeHash: account.counterpartyDisputeHash }
      : {}),
  };
};

export const resolveStartNonce = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  proofBodyHash: string,
): Pick<StartEvidence, 'signedNonce' | 'nonceSource' | 'jNonce'> | null => {
  const { signedNonce, nonceSource } = resolveStoredDisputeStartNonce(account, proofBodyHash);
  if (signedNonce <= 0) {
    addMessage(state, `❌ Invalid dispute signedNonce=${signedNonce} — must be > 0`);
    disputeLog.error('start.signed_nonce_invalid', {
      counterparty: shortId(counterpartyId),
      signedNonce,
      nonceSource,
    });
    return null;
  }
  const jNonce = Number(account.state.jNonce ?? 0);
  disputeLog.debug('start.nonce', {
    counterparty: shortId(counterpartyId),
    signedNonce,
    nonceSource,
    jNonce,
  });
  if (signedNonce <= jNonce) {
    addMessage(
      state,
      `❌ Stale dispute proof nonce ${signedNonce} (on-chain=${jNonce}) - reopen required`,
    );
    disputeLog.warn('start.nonce_stale', {
      counterparty: shortId(counterpartyId),
      signedNonce,
      jNonce,
    });
    return null;
  }
  return { signedNonce, nonceSource, jNonce };
};

export const buildStarterArguments = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  proofBodyHash: string,
  signedNonce: number,
  overrideInitial: string | undefined,
  env: EntityRuntimeContext,
): Pick<
  StartEvidence,
  | 'starterInitialArguments'
  | 'starterCounterArguments'
  | 'starterCounterProofCommitment'
> => {
  const starterIsLeft = account.state.leftEntity === state.entityId;
  const starterSide: DisputeArgumentSide = starterIsLeft ? 'left' : 'right';
  const initial = buildDisputeArgumentsForSnapshot(
    account,
    state,
    counterpartyId,
    proofBodyHash,
    { secretsSide: starterSide },
  );
  const rawInitial =
    overrideInitial && overrideInitial !== '0x'
      ? overrideInitial
      : starterIsLeft
        ? initial.leftArguments
        : initial.rightArguments;
  const initialProposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  if (typeof initialProposerIsLeft !== 'boolean') {
    throw new Error(`DISPUTE_START_PROPOSER_ROLE_MISSING:${counterpartyId}`);
  }
  const candidates = selectCounterDisputeSnapshots(
    account,
    starterSide,
    signedNonce,
    initialProposerIsLeft,
    counterpartyId,
  );
  const warnings = [...initial.warnings];
  let rawCounter = '0x';
  let starterCounterProofCommitment = ethers.ZeroHash;
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const counter = buildDisputeArgumentsForSnapshot(
      account,
      state,
      counterpartyId,
      candidate.proofbodyHash,
      { secretsSide: starterSide },
    );
    rawCounter = starterIsLeft
      ? counter.leftArguments
      : counter.rightArguments;
    starterCounterProofCommitment = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'bool', 'bytes32'],
        [candidate.nonce, candidate.proposerIsLeft, candidate.proofbodyHash],
      ),
    );
    warnings.push(...counter.warnings);
  }
  const sanitized = sanitizeOptionalDisputeStarterArgumentPair(
    rawInitial,
    rawCounter,
    'disputeStart.starterArguments',
  );
  warnings.push(...sanitized.warnings);
  reportOptionalArgumentWarnings(env, counterpartyId, warnings);
  assertDisputeArgumentsWithinContractLimits(
    [sanitized.initial, sanitized.counter],
    'disputeStart.starterArguments',
  );
  return {
    starterInitialArguments: sanitized.initial,
    starterCounterArguments: sanitized.counter,
    starterCounterProofCommitment,
  };
};
