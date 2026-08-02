import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
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
import { shortHash, shortId } from '../../../../infra/logger';
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
  callerSide: DisputeArgumentSide;
};

export type FinalProofPayload = {
  counterentity: string;
  initialNonce: number;
  finalNonce: number;
  initialProofbodyHash: string;
  finalProofbody: ProofBodyStruct;
  starterArguments: string;
  otherArguments: string;
  sig: string;
  startedByLeft: boolean;
  cooperative: false;
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
  const counterHash = account.counterpartyDisputeProofBodyHash;
  const counterNonce = account.counterpartyDisputeProofNonce;
  const counterHanko = account.counterpartyDisputeProofHanko;
  const counterBodyRaw = counterHash
    ? account.disputeProofBodiesByHash?.[counterHash]
    : undefined;
  const callerIsLeft = account.state.leftEntity === state.entityId;
  const callerIsStarter = callerIsLeft === activeDispute.startedByLeft;
  const hasCounterProof =
    !callerIsStarter &&
    Boolean(counterHanko && counterHanko !== '0x') &&
    counterNonce !== undefined &&
    counterNonce > activeDispute.initialNonce &&
    Boolean(counterHash) &&
    isProofBodyStruct(counterBodyRaw);
  const finalNonce = hasCounterProof ? counterNonce! : activeDispute.initialNonce;
  const finalNonceSource = hasCounterProof
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
  const counterBody = hasCounterProof
    ? canonicalizeProofBodyStruct(
        counterBodyRaw as ProofBodyStruct,
        sourceState.entityId,
        counterpartyId,
        'counter',
      )
    : null;
  const shouldUseCounterProof = counterBody !== null && counterHash !== undefined;
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
    finalizeSig: hasCounterProof ? counterHanko! : '0x',
    finalProofbody: (shouldUseCounterProof ? counterBody : storedBody ?? currentBody)!,
    finalProofbodyHash: shouldUseCounterProof
      ? counterHash!
      : activeDispute.initialProofbodyHash,
    shouldUseCounterProof,
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
  if (!domain) throw new Error('DISPUTE_COUNTER_FINALIZE_DEPOSITORY_MISSING');
  const expectedHash = createDisputeProofHashWithNonce(
    account.state,
    selection.finalProofbodyHash,
    domain,
    selection.finalNonce,
  );
  if (account.counterpartyDisputeHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_COUNTER_FINALIZE_HASH_MISMATCH:${counterpartyId}:` +
      `${account.counterpartyDisputeHash}:${expectedHash}`,
    );
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
  const builtArguments = buildDisputeArgumentsForSnapshot(
    account,
    state,
    counterpartyId,
    selection.finalProofbodyHash,
    { secretsSide: selection.callerSide },
  );
  reportOptionalArgumentWarnings(env, counterpartyId, builtArguments.warnings);
  const starterArguments = selection.shouldUseCounterProof
    ? activeDispute.starterIncrementedArguments
    : activeDispute.starterInitialArguments;
  const otherArguments = activeDispute.startedByLeft
    ? builtArguments.rightArguments
    : builtArguments.leftArguments;
  assertDisputeProofBodyWithinContractLimits(
    selection.finalProofbody,
    'disputeFinalize.final',
  );
  const recomputedHash = hashProofBodyStruct(selection.finalProofbody);
  if (recomputedHash.toLowerCase() !== selection.finalProofbodyHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_FINALIZE_PROOFBODY_HASH_MISMATCH:${counterpartyId}:` +
      `${selection.finalProofbodyHash}:${recomputedHash}`,
    );
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
    initialProofbodyHash: activeDispute.initialProofbodyHash,
    finalProofbody: selection.finalProofbody,
    starterArguments,
    otherArguments,
    sig: selection.finalizeSig,
    startedByLeft: activeDispute.startedByLeft,
    cooperative: false,
  };
};
