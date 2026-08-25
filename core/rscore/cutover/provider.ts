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
import type { HandleAccountInputResult, ProposeAccountFrameResult } from '../../account/consensus/types';
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

const rowFor = (wave: CutoverWaveResult['wave'], accountId: string) =>
  wave.postAccounts.find(row => row.accountId === accountId) ?? null;

const executeInboundBatch = async (
  env: RuntimeReplica,
  batch: AccountAuthorityEntityBatchInbound,
): Promise<readonly ((request: AccountAuthorityEntityBatchInbound['requests'][number]) => HandleAccountInputResult)[]> => {
  const binding = bindingFor(env, batch.ownerEntityId);
  const requests = batch.requests.map((request, operationIndex) => {
    const accountId = accountIdOf(request.account);
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
    {
      entityTimestamp: clock.entityTimestamp,
      finalizedJHeight: clock.finalizedJHeight,
    },
    requests.map(({ accountId, input }) => ({ accountId, input })),
  );
  const full = requireResult(wave === null ? null : { wave, row: null }, batch.ownerEntityId, 'batch');
  const waveIndex = indexInboundWave(full.wave);
  const lastOperationByAccount = new Map<string, number>();
  for (const { accountId, operationIndex } of requests) {
    lastOperationByAccount.set(accountId, operationIndex);
  }
  return requests.map(({ accountId, input, operationIndex }) => actualRequest => {
    const slice = inboundSlice(full.wave, accountId, operationIndex, waveIndex);
    return cutoverAccountInputResult(
      {
        binding,
        account: actualRequest.account,
        accountId,
        fromEntityId: peerOf(input, accountId),
        operationIndex,
      },
      { wave: slice, row: rowFor(slice, accountId) },
      lastOperationByAccount.get(accountId) === operationIndex,
    );
  });
};

const executeOutboundBatch = async (
  env: RuntimeReplica,
  batch: AccountAuthorityEntityBatchOutbound,
): Promise<readonly ProposeAccountFrameResult[]> => {
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
    timestamp,
    jHeight,
  });
  const full = requireResult(wave === null ? null : { wave, row: null }, batch.ownerEntityId, 'batch');
  if (full.wave.admissions.length !== admits.length) {
    return halt('OUTBOUND_ADMISSION_ARITY', {
      expected: admits.length,
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
  const proposalIds = new Set(proposals.map(row => row.accountId));
  for (const [accountId, { account }] of grouped) {
    if (proposalIds.has(accountId)) continue;
    const row = rowFor(full.wave, accountId);
    if (row === null) return halt('OUTBOUND_POST_ACCOUNT_MISSING', { account: accountId });
    materializeCutoverAccount(
      { binding, account, accountId },
      row,
    );
  }
  return proposals.map(({ request, accountId }) =>
    cutoverAccountProposalResult(
      { binding, account: request.account, accountId },
      { wave: full.wave, row: rowFor(full.wave, accountId) },
    ));
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
