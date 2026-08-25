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
} from '../authority-driver';
import type { RscoreAccountMaterializerBinding } from '../checkpoint/account-materializer';
import { authorityCutoverEnabled } from './enabled';
import {
  cutoverAccountAdmissionResult,
  cutoverAccountInputResult,
  cutoverAccountProposalResult,
  type CutoverWaveResult,
} from './execute';

const halt = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_CUTOVER_${code}:${JSON.stringify(detail)}`);
};

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
  const { input } = request;
  if (input.kind !== 'enqueue' && input.kind !== 'frame' && input.kind !== 'ack' && input.kind !== 'frame_ack') {
    return halt('INPUT_OUTSIDE_PROFILE', { account: accountId, kind: input.kind });
  }
  const binding = bindingFor(env, operation.ownerEntityId);
  const common = { binding, account: request.account, accountId };
  if (input.kind === 'enqueue') {
    const result = requireResult(
      await runAuthorityCutoverOperation(env, {
        kind: 'admitAccountTxs',
        ownerEntityId: operation.ownerEntityId,
        accountId,
        txs: input.txs,
        timestamp: request.entityTimestamp,
        jHeight: request.finalizedJHeight,
      }),
      operation.ownerEntityId,
      accountId,
    );
    return cutoverAccountAdmissionResult(common, result);
  }
  const result = requireResult(
    await runAuthorityCutoverOperation(env, {
      kind: 'applyAccountInput',
      ownerEntityId: operation.ownerEntityId,
      accountId,
      input,
      entityTimestamp: request.entityTimestamp,
      finalizedJHeight: request.finalizedJHeight,
    }),
    operation.ownerEntityId,
    accountId,
  );
  return cutoverAccountInputResult(
    { ...common, fromEntityId: peerOf(input, accountId), operationIndex: 0 },
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
      kind: 'proposeAccountFrame',
      ownerEntityId: operation.ownerEntityId,
      accountId,
      timestamp: request.timestamp,
      jHeight: request.jHeight,
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
