/**
 * Install the engine as the Account layer's executor for one Runtime.
 *
 * The driver stages and compares; this replaces. One Entity frame enters the
 * Rust engine twice: all peer arrivals in one inbound batch, then all local
 * admissions and proposals in one outbound batch. TypeScript materializes the
 * returned state and signs only the hashes the engine says are new.
 *
 * Off unless `XLN_RSCORE_AUTHORITY_CUTOVER=1` alongside the authority driver.
 */
import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import type { RuntimeReplica } from '../../runtime/types';
import type { AccountInput, AccountReplica, AccountTx } from '../../types/account';
import type { HandleAccountInputResult } from '../../account/consensus/types';
import type { AccountAuthorityInputRequest } from '../../account/consensus/context';
import { accountInputApplied } from '../../account/consensus/result';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import { safeStringify } from '../../protocol/serialization';
import type {
  AccountAuthorityEntityBatchInbound,
  AccountAuthorityEntityBatchOutbound,
  AccountAuthorityEntityStageProvider,
} from '../authority/entity-stage';
import {
  authorityDriverEnabled,
  runAuthorityCutoverInboundBatch,
  runAuthorityCutoverOutboundBatch,
} from '../authority-driver';
import type { RscoreAccountMaterializerBinding } from '../checkpoint/account-materializer';
import { authorityCutoverEnabled } from './enabled';
import {
  cutoverAccountInputResult,
  cutoverAccountProposalResult,
  materializeCutoverAccount,
  type CutoverWaveResult,
} from './execute';
import { inboundSlice, indexInboundWave } from '../round/inbound';

const halt = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_CUTOVER_${code}:${safeStringify(detail)}`);
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

const executeInboundBatch = async (
  env: RuntimeReplica,
  batch: AccountAuthorityEntityBatchInbound,
): Promise<readonly ((request: AccountAuthorityInputRequest) => HandleAccountInputResult)[]> => {
  const binding = bindingFor(env, batch.ownerEntityId);
  const requests = batch.requests.map((request, operationIndex) => {
    const accountId = request.accountId;
    const materializedAccountId = accountIdOf(request.account);
    if (materializedAccountId !== accountId) {
      return halt('INBOUND_ACCOUNT_BINDING', {
        expected: accountId,
        actual: materializedAccountId,
      });
    }
    const input = request.input;
    if (input.kind !== 'frame' && input.kind !== 'ack' && input.kind !== 'frame_ack') {
      return halt('INBOUND_BATCH_KIND', { account: accountId, kind: input.kind });
    }
    return { request, accountId, input, operationIndex };
  });
  const clock = requests[0]?.request ?? {
    entityTimestamp: env.state.timestamp,
    finalizedJHeight: 0,
  };
  const wave = await runAuthorityCutoverInboundBatch(
    env,
    batch.ownerEntityId,
    batch.expectedAccountsRoot,
    {
      entityTimestamp: clock.entityTimestamp,
      finalizedJHeight: clock.finalizedJHeight,
    },
    requests.map(({ request, accountId, input }) => ({
      accountId,
      input,
      ...(request.genesisPolicy === undefined
        ? {}
        : { genesisPolicy: request.genesisPolicy }),
    })),
  );
  const full = requireResult(wave === null ? null : { wave, row: null }, batch.ownerEntityId, 'batch');
  const waveIndex = indexInboundWave(full.wave);
  const genesisIds = new Set(requests
    .filter(({ request }) => request.genesisPolicy !== undefined)
    .map(({ accountId }) => accountId));
  const postIds = new Set(full.wave.createdAccounts.map(row => row.accountId));
  if (
    postIds.size !== full.wave.createdAccounts.length
    || genesisIds.size !== postIds.size
    || [...genesisIds].some(accountId => !postIds.has(accountId))
  ) {
    return halt('INBOUND_GENESIS_POST_ACCOUNT_SET', {
      expected: [...genesisIds].toSorted(),
      actual: [...postIds].toSorted(),
    });
  }
  const effectPriors = new Map<number, AccountReplica>();
  for (const { request, accountId, operationIndex } of requests) {
    if (request.genesisPolicy === undefined) continue;
    const row = full.wave.createdAccounts.find(created => created.accountId === accountId)
      ?? halt('INBOUND_GENESIS_POST_ACCOUNT_MISSING', { account: accountId });
    effectPriors.set(operationIndex, forkAccountReplicaShell(request.account));
    materializeCutoverAccount({ binding, account: request.account, accountId }, row);
  }
  return requests.map(({ accountId, input, operationIndex }) => actualRequest => {
    const slice = inboundSlice(full.wave, accountId, operationIndex, waveIndex);
    return cutoverAccountInputResult(
      {
        binding,
        account: effectPriors.get(operationIndex) ?? actualRequest.account,
        accountId,
        fromEntityId: peerOf(input, accountId),
        operationIndex,
      },
      { wave: slice, row: null },
      false,
    );
  });
};

const executeOutboundBatch = async (
  env: RuntimeReplica,
  batch: AccountAuthorityEntityBatchOutbound,
) => {
  const binding = bindingFor(env, batch.ownerEntityId);
  const grouped = new Map<string, { account: AccountReplica; txs: AccountTx[] }>();
  for (const request of batch.admissions) {
    if (request.input.kind !== 'enqueue') {
      return halt('OUTBOUND_BATCH_INPUT_KIND', { kind: request.input.kind });
    }
    const accountId = accountIdOf(request.account);
    const existing = grouped.get(accountId);
    if (existing) existing.txs.push(...request.input.txs);
    else grouped.set(accountId, { account: request.account, txs: [...request.input.txs] });
  }
  const admits = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountId, value]) => ({ accountId, txs: value.txs }));
  const proposals = batch.proposals.map(request => ({
    request,
    accountId: accountIdOf(request.account),
  }));
  const timestamp = proposals[0]?.request.timestamp
    ?? batch.admissions[0]?.entityTimestamp
    ?? env.state.timestamp;
  const jHeight = proposals[0]?.request.jHeight
    ?? batch.admissions[0]?.finalizedJHeight
    ?? 0;
  const wave = await runAuthorityCutoverOutboundBatch(env, {
    ownerEntityId: batch.ownerEntityId,
    admits,
    propose: proposals.map(row => row.accountId),
    materialize: batch.materializeAccounts.map(row => row.accountId),
    failedHtlcRoutes: batch.failedHtlcRoutes,
    timestamp,
    jHeight,
    checkpointDue: env.accountAuthorityCheckpointDue === true,
  });
  const full = requireResult(wave === null ? null : { wave, row: null }, batch.ownerEntityId, 'batch');
  const postAccountById = new Map(full.wave.postAccounts.map(row => [row.accountId, row]));
  if (postAccountById.size !== full.wave.postAccounts.length) {
    return halt('OUTBOUND_POST_ACCOUNT_DUPLICATE');
  }
  if (new Set(full.wave.proposals.map(row => row.accountId)).size !== full.wave.proposals.length) {
    return halt('OUTBOUND_PROPOSAL_DUPLICATE');
  }
  const resolutions = full.wave.proposals.flatMap(proposal =>
    proposal.failedHtlcLocks.flatMap(failed =>
      failed.upstreamResolution === null ? [] : [failed.upstreamResolution]));
  if (full.wave.admissions.length !== admits.length + resolutions.length) {
    return halt('OUTBOUND_ADMISSION_ARITY', {
      expected: admits.length + resolutions.length,
      actual: full.wave.admissions.length,
    });
  }
  for (const [index, admit] of admits.entries()) {
    const result = full.wave.admissions[index];
    if (
      result === undefined
      || result.operationIndex !== index
      || result.accountId !== admit.accountId
      || result.verdict.kind !== 'admitted'
      || result.verdict.count !== admit.txs.length
    ) {
      return halt('OUTBOUND_ADMISSION_MISMATCH', {
        index,
        account: admit.accountId,
        expected: admit.txs.length,
        actual: result ?? null,
      });
    }
  }
  for (const [offset, resolution] of resolutions.entries()) {
    const index = admits.length + offset;
    const result = full.wave.admissions[index];
    if (
      result === undefined
      || result.operationIndex !== index
      || result.accountId !== resolution.accountId
      || result.verdict.kind !== 'admitted'
      || result.verdict.count !== 1
    ) {
      return halt('OUTBOUND_GENERATED_ADMISSION_MISMATCH', {
        index,
        resolution,
        actual: result ?? null,
      });
    }
  }
  const accountById = (accountId: string): AccountReplica =>
    batch.accounts.get(accountId)
    ?? batch.accounts.get(accountId.toLowerCase())
    ?? halt('OUTBOUND_ACCOUNT_MISSING', { account: accountId });
  const proposalPriors = full.wave.proposals.map(proposal =>
    forkAccountReplicaShell(accountById(proposal.accountId)));
  for (const [accountId, row] of postAccountById) {
    const account = accountById(accountId);
    materializeCutoverAccount(
      { binding, account, accountId },
      row,
    );
  }
  const preparedProposals = full.wave.proposals.map((proposal, index) => {
    const accountId = proposal.accountId;
    const prior = proposalPriors[index]
      ?? halt('OUTBOUND_PROPOSAL_PRIOR_MISSING', { account: accountId });
    return {
      accountId,
      result: cutoverAccountProposalResult(
      { binding, account: prior, accountId },
      { wave: full.wave, row: postAccountById.get(accountId) ?? null },
      proposal,
      false,
      ),
    };
  });
  return {
    proposals: preparedProposals,
    generatedAdmissions: resolutions.map(resolution => ({
      accountId: resolution.accountId,
      input: {
        kind: 'enqueue' as const,
        txs: [{
          type: 'htlc_resolve' as const,
          data: {
            lockId: resolution.lockId,
            outcome: 'error' as const,
            reason: resolution.reason,
          },
        }],
      },
      result: accountInputApplied({ events: [], admittedAccountTxCount: 1 }),
    })),
  };
};

const createAuthorityCutoverProvider = (
  env: RuntimeReplica,
): AccountAuthorityEntityStageProvider => ({
  beginEntityStage: () => halt('STAGE_BEGIN_UNREACHABLE'),
  executeAccountInboundBatch: batch => executeInboundBatch(env, batch),
  executeAccountOutboundBatch: batch => executeOutboundBatch(env, batch),
});

/** Idempotent: one Runtime installs one executor, before its first frame. */
export const installAuthorityCutover = (env: RuntimeReplica): void => {
  if (!authorityCutoverEnabled() || !authorityDriverEnabled(env)) return;
  if (env.accountAuthorityExecutionMode !== undefined) return;
  env.accountAuthorityExecutionMode = 'cutover';
  env.accountAuthorityEntityStageProvider = createAuthorityCutoverProvider(env);
};
