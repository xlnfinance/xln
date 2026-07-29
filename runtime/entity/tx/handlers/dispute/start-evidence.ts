import type {
  AccountReplica,
  EntityState,
  RuntimeState,
} from '../../../../types';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { addMessage } from '../../../frame-events';
import {
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
  sanitizeOptionalDisputeStarterArgumentPair,
} from '../../../../jurisdiction/batch';
import { hashProofBodyStruct } from '../../../../protocol/dispute/proof-builder';
import {
  buildDisputeArgumentsForSnapshot,
  requireDisputeArgumentSnapshot,
  type DisputeArgumentSide,
} from '../../../../protocol/dispute/arguments';
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
  nonceSource: string;
  jNonce: number;
  starterInitialArguments: string;
  starterIncrementedArguments: string;
};

export const loadStartProof = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
): Omit<StartEvidence, 'signedNonce' | 'nonceSource' | 'jNonce' | 'starterInitialArguments' | 'starterIncrementedArguments'> | null => {
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
  let signedNonce = account.proofHeader.nextProofNonce;
  let nonceSource = 'proofHeader';
  const mappedNonce = account.disputeProofNoncesByHash?.[proofBodyHash];
  if (mappedNonce !== undefined) {
    signedNonce = mappedNonce;
    nonceSource = 'hashMap';
  } else if (account.counterpartyDisputeProofNonce !== undefined) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig';
  }
  if (
    account.counterpartyDisputeProofNonce !== undefined &&
    account.counterpartyDisputeProofNonce > signedNonce
  ) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig(fresher)';
  }
  if (signedNonce <= 0) {
    addMessage(state, `❌ Invalid dispute signedNonce=${signedNonce} — must be > 0`);
    disputeLog.error('start.signed_nonce_invalid', {
      counterparty: shortId(counterpartyId),
      signedNonce,
      nonceSource,
    });
    return null;
  }
  const jNonce = Number(account.jNonce ?? 0);
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
  env: RuntimeState,
): Pick<StartEvidence, 'starterInitialArguments' | 'starterIncrementedArguments'> => {
  const starterIsLeft = account.leftEntity === state.entityId;
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
  const candidates = Object.values(account.disputeArgumentSnapshotsByHash ?? {})
    .filter(snapshot => snapshot.side === starterSide && snapshot.nonce > signedNonce)
    .sort((left, right) => left.nonce - right.nonce);
  if (candidates.length > 1) {
    throw new Error(
      `DISPUTE_START_IMPOSSIBLE_MULTIPLE_INCREMENTED_SNAPSHOTS:${counterpartyId}:` +
      candidates.map(snapshot => `${snapshot.nonce}:${snapshot.proofbodyHash}`).join(','),
    );
  }
  const warnings = [...initial.warnings];
  let rawIncremented = '0x';
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const incremented = buildDisputeArgumentsForSnapshot(
      account,
      state,
      counterpartyId,
      candidate.proofbodyHash,
      { secretsSide: starterSide },
    );
    rawIncremented = starterIsLeft
      ? incremented.leftArguments
      : incremented.rightArguments;
    warnings.push(...incremented.warnings);
  }
  const sanitized = sanitizeOptionalDisputeStarterArgumentPair(
    rawInitial,
    rawIncremented,
    'disputeStart.starterArguments',
  );
  warnings.push(...sanitized.warnings);
  reportOptionalArgumentWarnings(env, counterpartyId, warnings);
  assertDisputeArgumentsWithinContractLimits(
    [sanitized.initial, sanitized.incremented],
    'disputeStart.starterArguments',
  );
  return {
    starterInitialArguments: sanitized.initial,
    starterIncrementedArguments: sanitized.incremented,
  };
};
