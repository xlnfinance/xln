import type { HandleAccountInputResult } from '../../account/consensus/types';
import { replaceAccountReplica } from '../../account/state/candidate-overlay';
import { rememberEngineAccountLeaf } from '../cutover/leaf-registry';
import { hydrateAccountDocFromStorage } from '../../storage/read/projections';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
} from '../../storage/schema/schema-state-docs';
import type { RuntimeReplica } from '../../runtime/types';
import type { AccountPeerInput } from '../../types/account';
import type { AccountJClaimNode } from '../../types/finance/account-j-claims';
import type {
  AccountAuthorityEntityBatchInbound,
  AccountAuthorityEntityBatchOutbound,
  AccountAuthorityEntityOccurrence,
  AccountAuthorityEntityStageProvider,
} from '../authority/entity-stage';
import type { AccountAuthorityInputRequest } from '../../account/consensus/context';
import { safeStringify } from '../../protocol/serialization';
import { TsAccountWorkerCoordinator } from './coordinator';
import type { TsAccountWorkerEffect, TsAccountWorkerPostAccount } from './protocol';

const normalize = (value: string): string => value.trim().toLowerCase();

const enumerableJClaimNodes = (
  env: RuntimeReplica,
): ReadonlyMap<string, AccountJClaimNode> | undefined => {
  const store = env.infrastructure?.accountJClaimNodes;
  if (store === undefined) return undefined;
  if (!(Symbol.iterator in Object(store))) {
    throw new Error('TS_ACCOUNT_WORKER_PROVIDER_JCLAIM_STORE_NOT_ENUMERABLE');
  }
  return store as ReadonlyMap<string, AccountJClaimNode>;
};

const peerInput = (request: AccountAuthorityInputRequest): AccountPeerInput => {
  const input = request.input;
  if (input.kind === 'enqueue' || input.kind === 'external_finality') {
    throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_INBOUND_KIND:${input.kind}`);
  }
  return input;
};

const occurrenceFrameId = (
  ownerEntityId: string,
  occurrence: AccountAuthorityEntityOccurrence,
): string => occurrence.kind === 'runtime-input'
  ? `${ownerEntityId}:runtime-input:${occurrence.inputIndex}`
  : `${ownerEntityId}:local-event:${occurrence.ordinal}`;

const inboundEffect = (
  effect: TsAccountWorkerEffect | undefined,
  accountId: string,
  order: number,
): HandleAccountInputResult => {
  if (effect?.phase !== 'inbound' || effect.order !== order || effect.accountId !== accountId) {
    throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_INBOUND_ORDER:${order}:${accountId}`);
  }
  return effect.result;
};

const replacePostAccount = (
  ownerEntityId: string,
  batch: AccountAuthorityEntityBatchOutbound,
  row: TsAccountWorkerPostAccount,
): void => {
  const accountId = normalize(row.accountId);
  const validated = assertStorageAccountDocBinding(
    validateStorageAccountDocValue(row.account),
    ownerEntityId,
    accountId,
    'ts-account-worker-post',
  );
  const prepared = hydrateAccountDocFromStorage(validated);
  const live = batch.accountForWrite(accountId);
  if (live === undefined) throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_POST_ACCOUNT_MISSING:${accountId}`);
  replaceAccountReplica(live, prepared);
  rememberEngineAccountLeaf(ownerEntityId, accountId, row.entityAccountLeaf);
};

export class TsAccountWorkerAuthority {
  readonly #env: RuntimeReplica;
  readonly #workerCount: number;
  readonly #coordinators = new Map<string, Promise<TsAccountWorkerCoordinator>>();
  readonly provider: AccountAuthorityEntityStageProvider;

  constructor(env: RuntimeReplica, workerCount: number) {
    if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 64) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_COUNT:${workerCount}`);
    }
    this.#env = env;
    this.#workerCount = workerCount;
    this.provider = {
      beginEntityStage: () => Promise.reject(new Error('TS_ACCOUNT_WORKER_PROVIDER_OBSERVE_UNSUPPORTED')),
      executeAccountInboundBatch: batch => this.#executeInbound(batch),
      executeAccountOutboundBatch: batch => this.#executeOutbound(batch),
    };
  }

  async #coordinator(batch: AccountAuthorityEntityBatchInbound): Promise<TsAccountWorkerCoordinator> {
    const ownerEntityId = normalize(batch.ownerEntityId);
    let pending = this.#coordinators.get(ownerEntityId);
    if (pending === undefined) {
      const jClaimNodes = enumerableJClaimNodes(this.#env);
      pending = TsAccountWorkerCoordinator.create({
        ownerEntityId,
        workerCount: this.#workerCount,
        accounts: batch.entityState.accounts,
        jReplicas: this.#env.state.jReplicas,
        ...(jClaimNodes === undefined ? {} : { jClaimNodes }),
      });
      this.#coordinators.set(ownerEntityId, pending);
    }
    return pending;
  }

  async #executeInbound(
    batch: AccountAuthorityEntityBatchInbound,
  ): Promise<readonly ((request: AccountAuthorityInputRequest) => HandleAccountInputResult)[]> {
    if (batch.requests.some(request => request.genesisPolicy !== undefined)) {
      throw new Error('TS_ACCOUNT_WORKER_PROVIDER_INBOUND_GENESIS_UNSUPPORTED');
    }
    const coordinator = await this.#coordinator(batch);
    const frameId = occurrenceFrameId(batch.ownerEntityId, batch.occurrence);
    const result = await coordinator.applyAccountInputs({
      frameId,
      expectedAccountsRoot: batch.expectedAccountsRoot,
      entityTimestamp: batch.requests[0]?.entityTimestamp ?? batch.entityState.timestamp,
      finalizedJHeight: batch.requests[0]?.finalizedJHeight ?? batch.entityState.lastFinalizedJHeight,
      inputs: batch.requests.map(request => ({ accountId: request.accountId, input: peerInput(request) })),
    });
    if (result.accountsRoot === batch.expectedAccountsRoot && batch.requests.length > 0) {
      // A duplicate may legitimately retain the root; effects still prove exact arity/order below.
    }
    return batch.requests.map((request, order) => {
      const accountId = normalize(request.accountId);
      const prepared = inboundEffect(result.effects[order], accountId, order);
      return actual => {
        if (normalize(actual.account.proofHeader.toEntity) !== accountId
          || safeStringify(actual.input) !== safeStringify(request.input)) {
          throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_INBOUND_BINDING:${order}:${accountId}`);
        }
        return prepared;
      };
    });
  }

  async #executeOutbound(batch: AccountAuthorityEntityBatchOutbound) {
    const ownerEntityId = normalize(batch.ownerEntityId);
    const coordinator = await this.#coordinators.get(ownerEntityId);
    if (coordinator === undefined) throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_COORDINATOR_MISSING:${ownerEntityId}`);
    const frameId = occurrenceFrameId(ownerEntityId, batch.occurrence);
    const result = await coordinator.proposeAccountFrames({
      frameId,
      timestamp: batch.proposals[0]?.timestamp
        ?? batch.admissions[0]?.entityTimestamp
        ?? batch.entityState.timestamp,
      jHeight: batch.proposals[0]?.jHeight
        ?? batch.admissions[0]?.finalizedJHeight
        ?? batch.entityState.lastFinalizedJHeight,
      txs: batch.admissions.map(request => {
        if (request.input.kind !== 'enqueue') {
          throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_KIND:${request.input.kind}`);
        }
        return { accountId: normalize(request.account.proofHeader.toEntity), txs: request.input.txs };
      }),
      proposalAccountIds: batch.proposals.map(request => normalize(request.account.proofHeader.toEntity)),
      checkpointDue: false,
    });
    for (const row of result.postAccounts ?? []) replacePostAccount(ownerEntityId, batch, row);
    const accountRoot = batch.entityState.accounts.rootHash();
    if (accountRoot !== result.accountsRoot) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ROOT_MISMATCH:${result.accountsRoot}:${accountRoot}`);
    }
    const admissions = result.effects.slice(0, batch.admissions.length);
    const proposals = result.effects.slice(batch.admissions.length);
    const preparedAdmissions = admissions.map((effect, order) => {
      const request = batch.admissions[order];
      if (request === undefined || effect?.phase !== 'outbound-enqueue') {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_ORDER:${order}`);
      }
      return effect.result;
    });
    const preparedProposals = proposals.map((effect, order) => {
      const request = batch.proposals[order];
      const accountId = request && normalize(request.account.proofHeader.toEntity);
      if (accountId === undefined || effect?.phase !== 'outbound-proposal' || effect.accountId !== accountId) {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_PROPOSAL_ORDER:${order}:${accountId ?? 'missing'}`);
      }
      return { accountId, result: effect.result };
    });
    if (preparedAdmissions.some(result => !result.ok)) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_REJECTED:${safeStringify(preparedAdmissions)}`);
    }
    return { proposals: preparedProposals, generatedAdmissions: [] };
  }

  async close(): Promise<void> {
    const coordinators = await Promise.all(this.#coordinators.values());
    for (const coordinator of coordinators) coordinator.close();
    this.#coordinators.clear();
  }
}
