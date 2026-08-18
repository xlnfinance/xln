import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/Depository.sol/Depository';
import { ethers } from 'ethers';
import { addMessage } from '../../../frame-events';
import {
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
} from '../../../../jurisdiction/machine/batch';
import {
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../../../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromJurisdictions } from '../../../../account/consensus/helpers';
import {
  buildDisputeArgumentsForSnapshot,
  type DisputeArgumentSide,
} from '../../../dispute-arguments';
import { shortHash, shortId } from '../../../../support/logger';
import {
  canonicalizeProofBodyStruct,
  disputeLog,
  isProofBodyStruct,
  reportOptionalArgumentWarnings,
  resolveDepositoryHankoDomain,
} from './shared';

export type FinalProofSelection = {
  finalNonce: number;
  finalNonceSource: string;
  finalizeSig: string;
  finalProofbody: ProofBodyStruct;
  finalProofbodyHash: string;
  shouldUseCounterProof: boolean;
  proposerIsLeft: boolean;
  callerSide: DisputeArgumentSide;
};

export type FinalProofPayload = {
  counterentity: string;
  initialNonce: number;
  finalNonce: number;
  proposerIsLeft: boolean;
  initialProofbodyHash: string;
  finalProofbody: ProofBodyStruct;
  starterArguments: string;
  otherArguments: string;
  sig: string;
  startedByLeft: boolean;
  cooperative: false;
  submitNotBeforeTimestamp?: number;
};

type CounterProofCandidate = Readonly<{
  usable: boolean;
  blocked: boolean;
  nonce?: number;
  proposerIsLeft?: boolean;
  hash?: string;
  hanko?: string;
  body?: ProofBodyStruct;
}>;

const resolveCounterProofCandidate = (
  state: EntityState,
  account: AccountReplica,
): CounterProofCandidate => {
  const active = account.activeDispute!;
  const selectedNonce = active.selectedCounterNonce;
  if (selectedNonce !== undefined) {
    const hash = active.selectedCounterProofbodyHash;
    const proposerIsLeft = active.selectedCounterProposerIsLeft;
    const rawBody = hash ? account.disputeProofBodiesByHash?.[hash] : undefined;
    const usable =
      typeof proposerIsLeft === 'boolean' &&
      Boolean(hash) &&
      isProofBodyStruct(rawBody);
    if (!usable) {
      addMessage(state, `⏳ Selected counter-proof N${selectedNonce} body is not locally available yet`);
    }
    return {
      usable,
      blocked: !usable,
      nonce: selectedNonce,
      ...(typeof proposerIsLeft === 'boolean' ? { proposerIsLeft } : {}),
      ...(hash ? { hash } : {}),
      hanko: '0x',
      ...(isProofBodyStruct(rawBody) ? { body: rawBody } : {}),
    };
  }
  const nonce = account.counterpartyDisputeProofNonce;
  const proposerIsLeft = account.counterpartyDisputeProofProposerIsLeft;
  const hash = account.counterpartyDisputeProofBodyHash;
  const hanko = account.counterpartyDisputeProofHanko;
  const rawBody = hash ? account.disputeProofBodiesByHash?.[hash] : undefined;
  const callerIsStarter = (account.state.leftEntity === state.entityId) === active.startedByLeft;
  const usable =
    !callerIsStarter &&
    Boolean(hanko && hanko !== '0x') &&
    nonce !== undefined &&
    typeof proposerIsLeft === 'boolean' &&
    (nonce > active.initialNonce || (
      nonce === active.initialNonce && proposerIsLeft && !active.initialProposerIsLeft
    )) &&
    Boolean(hash) &&
    isProofBodyStruct(rawBody);
  return {
    usable,
    blocked: false,
    ...(nonce !== undefined ? { nonce } : {}),
    ...(typeof proposerIsLeft === 'boolean' ? { proposerIsLeft } : {}),
    ...(hash ? { hash } : {}),
    ...(hanko ? { hanko } : {}),
    ...(isProofBodyStruct(rawBody) ? { body: rawBody } : {}),
  };
};

export const selectFinalProof = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  env: EntityRuntimeContext,
): FinalProofSelection | null => {
  const activeDispute = account.activeDispute!;
  const currentProof = buildAccountProofBodyFromJurisdictions(env.state, account);
  const counter = resolveCounterProofCandidate(state, account);
  if (counter.blocked) return null;
  const finalNonce = counter.usable ? counter.nonce! : activeDispute.initialNonce;
  const proposerIsLeft = counter.usable
    ? counter.proposerIsLeft!
    : activeDispute.initialProposerIsLeft;
  const finalNonceSource = counter.usable
    ? 'counterpartyDisputeProof'
    : 'initialNonce (unilateral)';
  if (finalNonce <= 0) {
    addMessage(state, `❌ Invalid dispute finalNonce=${finalNonce} — must be > 0`);
    disputeLog.error('finalize.nonce_invalid', {
      counterparty: shortId(counterpartyId),
      finalNonce,
      finalNonceSource,
    });
    return null;
  }
  const storedBodyRaw = activeDispute.initialProofbodyHash
    ? account.disputeProofBodiesByHash?.[activeDispute.initialProofbodyHash]
    : undefined;
  const currentBody = canonicalizeProofBodyStruct(
    currentProof.proofBodyStruct,
    sourceState.entityId,
    counterpartyId,
    'current',
  );
  const storedBody = isProofBodyStruct(storedBodyRaw)
    ? canonicalizeProofBodyStruct(storedBodyRaw, sourceState.entityId, counterpartyId, 'stored')
    : null;
  const counterBody = counter.usable
    ? canonicalizeProofBodyStruct(
        counter.body!,
        sourceState.entityId,
        counterpartyId,
        'counter',
      )
    : null;
  const shouldUseCounterProof = counterBody !== null && counter.hash !== undefined;
  if (!shouldUseCounterProof && currentProof.proofBodyHash !== activeDispute.initialProofbodyHash) {
    disputeLog.warn('finalize.proof_body_hash_mismatch', {
      counterparty: shortId(counterpartyId),
      current: shortHash(currentProof.proofBodyHash),
      initial: shortHash(activeDispute.initialProofbodyHash),
    });
    if (!storedBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }
  return {
    finalNonce,
    finalNonceSource,
    finalizeSig: counter.usable ? counter.hanko! : '0x',
    finalProofbody: (shouldUseCounterProof ? counterBody : storedBody ?? currentBody)!,
    finalProofbodyHash: shouldUseCounterProof
      ? counter.hash!
      : activeDispute.initialProofbodyHash,
    shouldUseCounterProof,
    proposerIsLeft,
    callerSide: account.state.leftEntity === state.entityId ? 'left' : 'right',
  };
};

export const verifyCounterProofIdentity = (
  sourceState: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  selection: FinalProofSelection,
): void => {
  if (!selection.shouldUseCounterProof || !account.counterpartyDisputeHash) return;
  const domain = resolveDepositoryHankoDomain(sourceState);
  if (!domain) throw haltRuntimeFailure("DISPUTE_COUNTER_FINALIZE_DEPOSITORY_MISSING", 'DISPUTE_COUNTER_FINALIZE_DEPOSITORY_MISSING');
  const expectedHash = createDisputeProofHashWithNonce(
    account.state,
    selection.finalProofbodyHash,
    domain,
    selection.finalNonce,
    selection.proposerIsLeft,
  );
  if (account.counterpartyDisputeHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw haltRuntimeFailure("DISPUTE_COUNTER_FINALIZE_HASH_MISMATCH", `DISPUTE_COUNTER_FINALIZE_HASH_MISMATCH:${counterpartyId}:` +
      `${account.counterpartyDisputeHash}:${expectedHash}`);
  }
};

export const buildFinalProofPayload = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  selection: FinalProofSelection,
  env: EntityRuntimeContext,
): FinalProofPayload => {
  const activeDispute = account.activeDispute!;
  const callerIsStarter = selection.callerSide ===
    (activeDispute.startedByLeft ? 'left' : 'right');
  const builtArguments = callerIsStarter
    ? { leftArguments: '0x', rightArguments: '0x', warnings: [] }
    : buildDisputeArgumentsForSnapshot(
        account,
        state,
        counterpartyId,
        selection.finalProofbodyHash,
        { secretsSide: selection.callerSide },
      );
  reportOptionalArgumentWarnings(env, counterpartyId, builtArguments.warnings);
  const selectedCounterCommitment = selection.shouldUseCounterProof
    ? ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'bool', 'bytes32'],
        [selection.finalNonce, selection.proposerIsLeft, selection.finalProofbodyHash],
      ))
    : ethers.ZeroHash;
  // Contract parity: the starter precommits positional evidence for one exact
  // newer branch. Another valid newer bilateral proof still wins, but receives
  // empty starter-side evidence so unrelated positional arguments cannot be
  // paired with it and the starter cannot veto state progression.
  const starterArguments = selection.shouldUseCounterProof
    ? selectedCounterCommitment.toLowerCase() ===
        activeDispute.starterCounterProofCommitment.toLowerCase()
      ? activeDispute.starterCounterArguments
      : '0x'
    : activeDispute.starterInitialArguments;
  const otherArguments = callerIsStarter
    ? '0x'
    : activeDispute.startedByLeft
      ? builtArguments.rightArguments
      : builtArguments.leftArguments;
  assertDisputeProofBodyWithinContractLimits(
    selection.finalProofbody,
    'disputeFinalize.final',
  );
  const recomputedHash = hashProofBodyStruct(selection.finalProofbody);
  if (recomputedHash.toLowerCase() !== selection.finalProofbodyHash.toLowerCase()) {
    throw haltRuntimeFailure("DISPUTE_FINALIZE_PROOFBODY_HASH_MISMATCH", `DISPUTE_FINALIZE_PROOFBODY_HASH_MISMATCH:${counterpartyId}:` +
      `${selection.finalProofbodyHash}:${recomputedHash}`);
  }
  assertDisputeArgumentsWithinContractLimits(
    [starterArguments],
    'disputeFinalize.starterArguments',
  );
  assertDisputeArgumentsWithinContractLimits(
    [otherArguments],
    'disputeFinalize.otherArguments',
  );
  return {
    counterentity: counterpartyId,
    initialNonce: activeDispute.initialNonce,
    finalNonce: selection.finalNonce,
    proposerIsLeft: selection.proposerIsLeft,
    initialProofbodyHash: activeDispute.initialProofbodyHash,
    finalProofbody: selection.finalProofbody,
    starterArguments,
    otherArguments,
    sig: selection.finalizeSig,
    startedByLeft: activeDispute.startedByLeft,
    cooperative: false,
  };
};
