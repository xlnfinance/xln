/**
 * Install the engine as the Account layer's executor for one Runtime.
 *
 * The driver stages and compares; this replaces. Every Account operation an
 * Entity input performs is executed by the Rust engine, and the TypeScript
 * replica is rebuilt from the engine's own post-state row. TypeScript keeps
 * exactly two jobs at the Account layer: naming the operation, and signing
 * the hashes the engine says are new.
 *
 * Off unless `XLN_RSCORE_AUTHORITY_CUTOVER=1` alongside the authority driver.
 */
import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import type { RuntimeReplica } from '../../runtime/types';
import type { AccountInput, AccountReplica } from '../../types/account';
import type { HandleAccountInputResult, ProposeAccountFrameResult } from '../../account/consensus/types';
import type {
  AccountAuthorityEntityOperation,
  AccountAuthorityEntityStageProvider,
} from '../authority/entity-stage';
import {
  authorityDriverEnabled,
  runAuthorityCutoverOperation,
  type AuthorityCutoverOperation,
} from '../authority-driver';
import { noteRawAccountInput } from '../authority-wave';
import type { RscoreAccountMaterializerBinding } from '../checkpoint/account-materializer';
import {
  cutoverAccountAdmissionResult,
  cutoverAccountInputResult,
  cutoverAccountProposalResult,
  type CutoverWaveResult,
} from './execute';

const halt = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_CUTOVER_${code}:${JSON.stringify(detail)}`);
};

export const authorityCutoverEnabled = (): boolean =>
  typeof process !== 'undefined'
  && process.env?.['XLN_RSCORE_AUTHORITY_CUTOVER'] === '1'
  && process.env?.['XLN_RSCORE_AUTHORITY'] === '1';

const bindingFor = (
  env: RuntimeReplica,
  ownerEntityId: string,
): RscoreAccountMaterializerBinding => {
  const replica = getEntityReplicaById(env, ownerEntityId);
  const signerId = String(replica?.signerId ?? '').trim().toLowerCase();
  if (signerId.length === 0) halt('SIGNER_UNKNOWN', { owner: ownerEntityId });
  return { sessionOwnerEntityId: ownerEntityId, expectedSignerId: signerId };
};

const accountIdOf = (account: AccountReplica): string =>
  String(account.proofHeader?.toEntity ?? '').trim().toLowerCase();

const peerOf = (input: AccountInput, accountId: string): string =>
  input.kind === 'enqueue' || input.kind === 'external_finality'
    ? accountId
    : String(input.fromEntityId ?? accountId).trim().toLowerCase();

/**
 * Every operation carries the same parent identity, so the engine's stage is
 * bound to the Entity input that authorized it rather than to whichever frame
 * happened to be open.
 */
const parentFields = (
  operation: AccountAuthorityEntityOperation,
): Pick<
  AuthorityCutoverOperation,
  'ownerEntityId' | 'occurrence' | 'appliedInput' | 'deferProposal'
> & Readonly<{
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  requiredEntityTxIndex?: number;
}> => ({
  ownerEntityId: operation.ownerEntityId,
  occurrence: operation.occurrence,
  appliedInput: operation.canonicalEntityInput,
  deferProposal: operation.deferProposal,
  ...(operation.trustedLocalRuntimeProtocol === undefined
    ? {}
    : { trustedLocalRuntimeProtocol: operation.trustedLocalRuntimeProtocol }),
  ...(operation.requiredEntityTxIndex === undefined
    ? {}
    : { requiredEntityTxIndex: operation.requiredEntityTxIndex }),
});

const requireResult = (
  value: CutoverWaveResult | null,
  ownerEntityId: string,
  accountId: string,
): CutoverWaveResult =>
  value ?? halt('OPERATION_DECLINED', { owner: ownerEntityId, account: accountId });

const executeInput = async (
  env: RuntimeReplica,
  operation: Extract<AccountAuthorityEntityOperation, { kind: 'applyAccountInput' }>,
): Promise<HandleAccountInputResult> => {
  const { request } = operation;
  const accountId = accountIdOf(request.account);
  if (request.input.kind === 'external_finality') {
    return halt('INPUT_OUTSIDE_PROFILE', { account: accountId, kind: request.input.kind });
  }
  if (request.collectorFrameId.length === 0) {
    return halt('COLLECTOR_FRAME_MISSING', { account: accountId });
  }
  // The engine is handed the raw input through the same collector the parity
  // driver uses; nothing else may build the wave.
  const recorded = noteRawAccountInput(request.collectorFrameId, request.account, request.input);
  if (recorded === null) {
    return halt('INPUT_NOT_RECORDED', { account: accountId, kind: request.input.kind });
  }
  const binding = bindingFor(env, operation.ownerEntityId);
  const result = requireResult(
    await runAuthorityCutoverOperation(env, {
      ...parentFields(operation),
      kind: 'applyAccountInput',
      accountId,
      collectorFrameId: request.collectorFrameId,
      timestamp: request.entityTimestamp,
      jHeight: request.finalizedJHeight,
      entityTimestamp: request.entityTimestamp,
      finalizedJHeight: request.finalizedJHeight,
    }),
    operation.ownerEntityId,
    accountId,
  );
  const common = { binding, account: request.account, accountId };
  if (request.input.kind === 'enqueue') return cutoverAccountAdmissionResult(common, result);
  return cutoverAccountInputResult(
    { ...common, fromEntityId: peerOf(request.input, accountId), operationIndex: 0 },
    result,
  );
};

const executeProposal = async (
  env: RuntimeReplica,
  operation: Extract<AccountAuthorityEntityOperation, { kind: 'proposeAccountFrame' }>,
): Promise<ProposeAccountFrameResult> => {
  const { request } = operation;
  const accountId = accountIdOf(request.account);
  if (!request.selectionIsWholeMempool) {
    return halt('PROPOSAL_SUBSET_UNSUPPORTED', { account: accountId });
  }
  const binding = bindingFor(env, operation.ownerEntityId);
  const result = requireResult(
    await runAuthorityCutoverOperation(env, {
      ...parentFields(operation),
      kind: 'proposeAccountFrame',
      accountId,
      collectorFrameId: request.collectorFrameId,
      timestamp: request.timestamp,
      jHeight: request.jHeight,
      entityTimestamp: request.entityTimestamp,
      finalizedJHeight: request.finalizedJHeight,
    }),
    operation.ownerEntityId,
    accountId,
  );
  return cutoverAccountProposalResult({ binding, account: request.account, accountId }, result);
};

export const createAuthorityCutoverProvider = (
  env: RuntimeReplica,
): AccountAuthorityEntityStageProvider => ({
  beginEntityStage: () => halt('STAGE_BEGIN_UNREACHABLE'),
  executeAccountOperation: async operation =>
    operation.kind === 'applyAccountInput'
      ? executeInput(env, operation)
      : executeProposal(env, operation),
});

/** Idempotent: one Runtime installs one executor, before its first frame. */
export const installAuthorityCutover = (env: RuntimeReplica): void => {
  if (!authorityCutoverEnabled() || !authorityDriverEnabled(env)) return;
  if (env.accountAuthorityExecutionMode !== undefined) return;
  env.accountAuthorityExecutionMode = 'cutover';
  env.accountAuthorityEntityStageProvider = createAuthorityCutoverProvider(env);
};
