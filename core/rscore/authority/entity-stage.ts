import type {
  AccountAuthorityInputRequest,
  AccountAuthorityProposalRequest,
} from '../../account/consensus/context';
import type {
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from '../../account/consensus/types';
import type { AccountTxBatch, AccountInput } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import type {
  AccountAuthorityFrameBeginRequest,
  AccountAuthorityFrameBooksRequest,
  AccountAuthorityCommittedHankosRequest,
  AccountAuthorityFrameOutboundRequest,
  AccountAuthorityEntityStageCapability,
  EntityRuntimeContext,
} from '../../entity/runtime-context';
import { accountInputApplied } from '../../account/consensus/result';
import { requirePersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { inboundArrivals } from '../round/inbound';
import { safeStringify } from '../../protocol/serialization';
import { countOp, OP_COUNTERS_ENABLED } from '../../support/performance/op-counters';
import { getPerfMs } from '../../support/time';
import type { AccountEnvelopeUpdate } from '../../account/envelope/entity-update';
import { acceptsExternalAccountInput } from '../../account/consensus/dispute/policy';

const countFrameApplyPhase = (name: string, startedAt: number): void => {
  if (!OP_COUNTERS_ENABLED) return;
  countOp(`entity.phase.frameApply.authority.${name}`, 0, Math.round((getPerfMs() - startedAt) * 1_000));
};

type TypeScriptAccountExecutionCounts = Readonly<{
  applyAccountInput: number;
  proposeAccountFrame: number;
}>;

export type AccountAuthorityEntityOccurrence =
  | Readonly<{ kind: 'runtime-input'; inputIndex: number }>
  | Readonly<{ kind: 'local-event'; ordinal: number }>;

export type AccountAuthorityEntityStageProvider = Readonly<{
  executeAccountInboundBatch(
    input: AccountAuthorityEntityBatchInbound,
  ): Promise<readonly ((request: AccountAuthorityInputRequest) => HandleAccountInputResult)[]>;
  executeAccountOutboundBatch(
    input: AccountAuthorityEntityBatchOutbound,
  ): Promise<AccountAuthorityPreparedOutbound>;
  discardEntityFrameAttempt(input: Readonly<{
    ownerEntityId: string;
    ownerSignerId: string;
    occurrence: AccountAuthorityEntityOccurrence;
  }>): Promise<void>;
  executeEntityBooksBatch(input: Readonly<{
    ownerEntityId: string;
    ownerSignerId: string;
    request: AccountAuthorityFrameBooksRequest;
  }>): Promise<void>;
  installCommittedAccountHankos?(
    input: AccountAuthorityCommittedHankosRequest & Readonly<{ ownerSignerId: string }>,
  ): Promise<void>;
}>;

type AccountAuthorityPreparedOutbound = Readonly<{
  proposals: readonly Readonly<{
    accountId: string;
    result: ProposeAccountFrameResult;
  }>[];
  generatedAdmissions: readonly Readonly<{
    accountId: string;
    input: AccountTxBatch;
    result: HandleAccountInputResult;
  }>[];
}>;

/** Entity-owned fields a peer is never allowed to choose at Account genesis. */
type AccountAuthorityInboundGenesisPolicy = Readonly<{
  expectedDomain: AccountAuthorityInputRequest['account']['state']['domain'];
  shadowPolicyRoot: string;
  shadowPolicyRows: readonly (readonly [number, unknown])[];
  deltaTransformer: string;
  publicPinned: false;
}>;

type AccountAuthorityInboundBatchRequest = AccountAuthorityInputRequest & Readonly<{
  accountId: string;
  genesisPolicy?: AccountAuthorityInboundGenesisPolicy;
}>;

type AccountAuthorityEntityParent = Readonly<{
  ownerEntityId: string;
  ownerSignerId: string;
  unsupportedEntityTxTypes: readonly EntityTx['type'][];
  occurrence: AccountAuthorityEntityOccurrence;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}>;

export type AccountAuthorityEntityBatchInbound = AccountAuthorityEntityParent & Readonly<{
  expectedAccountsRoot: string;
  entityState: AccountAuthorityFrameBeginRequest['entityState'];
  entityContext: AccountAuthorityFrameBeginRequest['entityContext'];
  requests: readonly AccountAuthorityInboundBatchRequest[];
}>;

export type AccountAuthorityEntityBatchOutbound = AccountAuthorityEntityParent & Readonly<{
  entityState: AccountAuthorityFrameOutboundRequest['entityState'];
  entityHeight: AccountAuthorityFrameOutboundRequest['entityHeight'];
  accountForWrite(accountId: string): AccountAuthorityInputRequest['account'] | undefined;
  admissions: readonly AccountAuthorityInputRequest[];
  proposals: readonly AccountAuthorityProposalRequest[];
  envelopeUpdates: readonly Readonly<{
    accountId: string;
    update: AccountEnvelopeUpdate;
  }>[];
  materializeAccountIds: readonly string[];
}>;

interface AccountAuthorityEntityStage extends AccountAuthorityEntityStageCapability {
  readonly ownerEntityId: string;
  readonly ownerSignerId: string;
  typeScriptExecutionCounts(): TypeScriptAccountExecutionCounts;
  authoritativeExecutionCount(): number;
  discard(): Promise<void>;
}

export type AccountAuthorityEntityStageOptions = Readonly<{
  ownerEntityId: string;
  ownerSignerId: string;
  provider: AccountAuthorityEntityStageProvider;
  occurrence: AccountAuthorityEntityOccurrence;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}>;

export type AccountAuthorityEntityStageConfiguration = Readonly<{
  accountAuthorityExecutionMode?: 'cutover' | undefined;
  accountAuthorityEntityStageProvider?: AccountAuthorityEntityStageProvider | undefined;
}>;

export type AccountAuthorityEntityTransition = Readonly<{
  ownerEntityId: string;
  ownerSignerId: string;
  occurrence?: AccountAuthorityEntityOccurrence | undefined;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}>;

export const resolveAccountAuthorityEntityStageOptions = (
  configuration: AccountAuthorityEntityStageConfiguration,
  transition: AccountAuthorityEntityTransition,
  _migrationRecorderEnabled: boolean,
): AccountAuthorityEntityStageOptions | null => {
  const mode = configuration.accountAuthorityExecutionMode;
  const provider = configuration.accountAuthorityEntityStageProvider;
  if (mode !== undefined && provider === undefined) {
    throw new Error(`ACCOUNT_AUTHORITY_ENTITY_STAGE_PROVIDER_REQUIRED:${mode}`);
  }
  if (mode === undefined && provider !== undefined) {
    throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_MODE_REQUIRED');
  }
  if (mode === undefined || provider === undefined) return null;
  const occurrence = transition.occurrence;
  if (occurrence === undefined) {
    throw new Error(`ACCOUNT_AUTHORITY_ENTITY_OCCURRENCE_REQUIRED:${mode}`);
  }
  return {
    ownerEntityId: transition.ownerEntityId,
    ownerSignerId: transition.ownerSignerId,
    provider,
    occurrence,
    ...(transition.trustedLocalRuntimeProtocol === undefined
      ? {}
      : { trustedLocalRuntimeProtocol: transition.trustedLocalRuntimeProtocol }),
    deferProposal: transition.deferProposal,
    ...(transition.requiredEntityTxIndex === undefined
      ? {}
      : { requiredEntityTxIndex: transition.requiredEntityTxIndex }),
  };
};

/**
 * Process-wide tally of who executed the Account layer.
 *
 * A cutover is only a cutover if TypeScript stopped executing, and the only
 * proof of that is a count nobody can argue with.
 */
const executionLedger = {
  typescriptApplyAccountInput: 0,
  typescriptProposeAccountFrame: 0,
  authoritativeOperations: 0,
};

export const accountAuthorityExecutionLedger = (): Readonly<typeof executionLedger> =>
  ({ ...executionLedger });

export const printAccountAuthorityExecutionLedger = (): void => {
  console.error(`RSCORE_ACCOUNT_EXECUTION ${safeStringify(executionLedger)}`);
};

const normalizeEntityId = (value: string): string => value.trim().toLowerCase();

const assertOccurrence = (occurrence: AccountAuthorityEntityOccurrence): void => {
  const value = occurrence.kind === 'runtime-input'
    ? occurrence.inputIndex
    : occurrence.ordinal;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ACCOUNT_AUTHORITY_ENTITY_OCCURRENCE_INVALID:${occurrence.kind}:${value}`);
  }
};

const assertNoTypeScriptAccountExecution = (
  scope: Pick<AccountAuthorityEntityStage, 'ownerEntityId' | 'typeScriptExecutionCounts'>,
): void => {
  const counts = scope.typeScriptExecutionCounts();
  if (counts.applyAccountInput === 0 && counts.proposeAccountFrame === 0) return;
  throw new Error(
    `ACCOUNT_AUTHORITY_CUTOVER_TS_EXECUTION:${scope.ownerEntityId}:` +
    `apply=${counts.applyAccountInput}:propose=${counts.proposeAccountFrame}`,
  );
};

class AccountAuthorityEntityStageImpl implements AccountAuthorityEntityStage {
  readonly ownerEntityId: string;
  readonly ownerSignerId: string;
  private readonly options: AccountAuthorityEntityStageOptions;
  private readonly occurrence: AccountAuthorityEntityOccurrence;
  private unsupportedEntityTxTypes: EntityTx['type'][] | null = null;
  private discarded = false;
  private applyAccountInputCount = 0;
  private proposeAccountFrameCount = 0;
  private authoritativeExecutions = 0;
  private frameOpened = false;
  private frameOutboundPrepared = false;
  private frameBooksExecuted = false;
  private inboundRequests: AccountAuthorityInboundBatchRequest[] = [];
  private inboundResults: HandleAccountInputResult[] = [];
  private inboundCursor = 0;
  private admissionRequests: AccountAuthorityInputRequest[] = [];
  private envelopeUpdates: Array<Readonly<{
    accountId: string;
    update: AccountEnvelopeUpdate;
  }>> = [];
  private preparedProposalIds: string[] = [];
  private proposalResults: ProposeAccountFrameResult[] = [];
  private proposalCursor = 0;
  private generatedAdmissions: AccountAuthorityPreparedOutbound['generatedAdmissions'] = [];
  private generatedAdmissionCursor = 0;

  private async discardOpenFrameAttempt(): Promise<void> {
    if (!this.frameOpened) return;
    await this.options.provider.discardEntityFrameAttempt({
      ownerEntityId: this.ownerEntityId,
      ownerSignerId: this.ownerSignerId,
      occurrence: this.occurrence,
    });
    this.frameOpened = false;
  }

  constructor(options: AccountAuthorityEntityStageOptions) {
    assertOccurrence(options.occurrence);
    this.options = options;
    this.ownerEntityId = normalizeEntityId(options.ownerEntityId);
    this.ownerSignerId = normalizeEntityId(options.ownerSignerId);
    this.occurrence = options.occurrence.kind === 'runtime-input'
      ? { kind: 'runtime-input', inputIndex: options.occurrence.inputIndex }
      : { kind: 'local-event', ordinal: options.occurrence.ordinal };
  }

  private parentOf(): AccountAuthorityEntityParent {
    if (this.discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
    if (this.unsupportedEntityTxTypes === null) {
      throw new Error(`ACCOUNT_AUTHORITY_ENTITY_FRAME_REQUIRED:${this.ownerEntityId}`);
    }
    return {
      ownerEntityId: this.ownerEntityId,
      ownerSignerId: this.ownerSignerId,
      unsupportedEntityTxTypes: this.unsupportedEntityTxTypes,
      occurrence: this.occurrence,
      ...(this.options.trustedLocalRuntimeProtocol === undefined
        ? {}
        : { trustedLocalRuntimeProtocol: this.options.trustedLocalRuntimeProtocol }),
      deferProposal: this.options.deferProposal,
      ...(this.options.requiredEntityTxIndex === undefined
        ? {}
        : { requiredEntityTxIndex: this.options.requiredEntityTxIndex }),
    };
  }

  async beginEntityAccountFrame(request: AccountAuthorityFrameBeginRequest): Promise<void> {
    if (normalizeEntityId(request.ownerEntityId) !== this.ownerEntityId) {
      throw new Error(`ACCOUNT_AUTHORITY_FRAME_OWNER_MISMATCH:${this.ownerEntityId}:${request.ownerEntityId}`);
    }
    await this.discardOpenFrameAttempt();
    this.unsupportedEntityTxTypes = [...new Set(request.entityTxs
      .map(tx => tx.type)
      .filter(type => type !== 'accountInput'))].sort();
    // Entity fitting may reject one transaction after an isolated apply and
    // rebuild the proposal. A retry is a new attempt against the same parent
    // head, not a third Account phase. Rust reconciles its held path-copy
    // candidate from expectedAccountsRoot before applying this batch.
    this.frameOpened = true;
    this.frameOutboundPrepared = false;
    this.frameBooksExecuted = false;
    this.inboundRequests = [];
    this.inboundResults = [];
    this.inboundCursor = 0;
    this.admissionRequests = [];
    this.envelopeUpdates = [];
    this.preparedProposalIds = [];
    this.proposalResults = [];
    this.proposalCursor = 0;
    this.generatedAdmissions = [];
    this.generatedAdmissionCursor = 0;
    const prepareStartedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const newAccounts = new Map<string, AccountAuthorityInputRequest['account']>();
    this.inboundRequests = inboundArrivals(request.entityTxs).flatMap(arrival => {
      const accountId = normalizeEntityId(arrival.accountId);
      const existing = request.accountForWrite(accountId) ?? newAccounts.get(accountId);
      if (existing !== undefined) {
        // Entity owns the frozen-input drop before Account consensus. Do not
        // speculatively execute an arrival which its parent will never consume.
        if (!acceptsExternalAccountInput(existing)) return [];
        return [{
          collectorFrameId: String(request.ownerEntityId),
          accountId,
          account: existing,
          input: arrival.input,
          entityTimestamp: request.entityTimestamp,
          finalizedJHeight: request.finalizedJHeight,
        }];
      }
      const created = request.createInboundAccount(arrival.input);
      const actualAccountId = normalizeEntityId(created.account.proofHeader.toEntity);
      if (actualAccountId !== accountId) {
        throw new Error(`ACCOUNT_AUTHORITY_INBOUND_CREATE_ACCOUNT_MISMATCH:${accountId}:${actualAccountId}`);
      }
      if (created.account.publicPinned === true) {
        throw new Error(`ACCOUNT_AUTHORITY_INBOUND_CREATE_PUBLIC_PINNED:${accountId}`);
      }
      newAccounts.set(accountId, created.account);
      return [{
        collectorFrameId: String(request.ownerEntityId),
        accountId,
        account: created.account,
        input: arrival.input,
        entityTimestamp: request.entityTimestamp,
        finalizedJHeight: request.finalizedJHeight,
        genesisPolicy: {
          expectedDomain: created.account.state.domain,
          shadowPolicyRoot: requirePersistentAccountStateMap(
            created.account.shadow.rebalance.policy,
            'rebalanceShadowPolicy',
          ).rootHash(),
          shadowPolicyRows: [...requirePersistentAccountStateMap(
            created.account.shadow.rebalance.policy,
            'rebalanceShadowPolicy',
          ).entries()],
          deltaTransformer: created.deltaTransformer,
          publicPinned: false,
        },
      }];
    });
    countFrameApplyPhase('inbound.prepare', prepareStartedAt);
    const run = this.options.provider.executeAccountInboundBatch;
    const providerStartedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const materializers = [...await run.call(this.options.provider, {
      ...this.parentOf(),
      expectedAccountsRoot: request.expectedAccountsRoot,
      entityState: request.entityState,
      entityContext: request.entityContext,
      requests: this.inboundRequests,
    })];
    countFrameApplyPhase('inbound.provider', providerStartedAt);
    if (materializers.length !== this.inboundRequests.length) {
      throw new Error(
        `ACCOUNT_AUTHORITY_INBOUND_RESULT_ARITY:${this.inboundRequests.length}:${materializers.length}`,
      );
    }
    const materializeStartedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    this.inboundResults = materializers.map((materializeResult, index) => {
      const expected = this.inboundRequests[index];
      if (expected === undefined) throw new Error(`ACCOUNT_AUTHORITY_INBOUND_REQUEST_MISSING:${index}`);
      return materializeResult(expected);
    });
    countFrameApplyPhase('inbound.materialize', materializeStartedAt);
    this.authoritativeExecutions += this.inboundRequests.length;
    executionLedger.authoritativeOperations += this.inboundRequests.length;
  }

  async executeEntityBooks(request: AccountAuthorityFrameBooksRequest): Promise<void> {
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (this.frameBooksExecuted) throw new Error(`ACCOUNT_AUTHORITY_BOOKS_DUPLICATE:${this.ownerEntityId}`);
    if (this.frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_BOOKS_AFTER_OUTBOUND:${this.ownerEntityId}`);
    this.frameBooksExecuted = true;
    await this.options.provider.executeEntityBooksBatch({
      ownerEntityId: this.ownerEntityId,
      ownerSignerId: this.ownerSignerId,
      request,
    });
  }

  recordAccountEnvelopeUpdate(accountId: string, update: AccountEnvelopeUpdate): void {
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (this.frameOutboundPrepared) {
      throw new Error(`ACCOUNT_AUTHORITY_ENVELOPE_UPDATE_AFTER_OUTBOUND:${this.ownerEntityId}`);
    }
    this.envelopeUpdates.push({ accountId: normalizeEntityId(accountId), update });
  }

  async prepareEntityAccountOutbound(request: AccountAuthorityFrameOutboundRequest): Promise<void> {
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (this.frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_OUTBOUND_DUPLICATE:${this.ownerEntityId}`);
    if (this.inboundCursor !== this.inboundRequests.length) {
      throw new Error(`ACCOUNT_AUTHORITY_INBOUND_UNCONSUMED:${this.inboundCursor}:${this.inboundRequests.length}`);
    }
    if (!this.frameBooksExecuted) throw new Error(`ACCOUNT_AUTHORITY_BOOKS_NOT_EXECUTED:${this.ownerEntityId}`);
    this.frameOutboundPrepared = true;
    const prepareStartedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const proposalIds = [...new Set(request.proposalAccountIds.map(normalizeEntityId))]
      .filter(accountId => request.accounts.has(accountId));
    const proposals = proposalIds.map(accountId => {
      const account = request.accountForWrite(accountId);
      if (account === undefined) throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_ACCOUNT_MISSING:${accountId}`);
      return {
        collectorFrameId: this.ownerEntityId,
        account,
        timestamp: request.timestamp,
        jHeight: request.jHeight,
        entityTimestamp: request.timestamp,
        finalizedJHeight: request.jHeight,
        selectionIsWholeMempool: true,
      };
    });
    const run = this.options.provider.executeAccountOutboundBatch;
    const materializeAccountIds = [...new Set(this.inboundRequests.map(request =>
      normalizeEntityId(request.account.proofHeader.toEntity)))];
    countFrameApplyPhase('outbound.prepare', prepareStartedAt);
    const providerStartedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const prepared = await run.call(this.options.provider, {
      ...this.parentOf(),
      entityState: request.entityState,
      entityHeight: request.entityHeight,
      accountForWrite: request.accountForWrite,
      admissions: this.admissionRequests,
      proposals,
      envelopeUpdates: this.envelopeUpdates,
      materializeAccountIds,
    });
    countFrameApplyPhase('outbound.provider', providerStartedAt);
    const materializeStartedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    this.preparedProposalIds = prepared.proposals.map(row => normalizeEntityId(row.accountId));
    this.proposalResults = prepared.proposals.map(row => row.result);
    this.generatedAdmissions = [...prepared.generatedAdmissions];
    if (this.preparedProposalIds.length !== new Set(this.preparedProposalIds).size) {
      throw new Error('ACCOUNT_AUTHORITY_PROPOSAL_RESULT_DUPLICATE');
    }
    const originalProposalIds = new Set(proposalIds);
    const retainedOriginalOrder = this.preparedProposalIds.filter(accountId =>
      originalProposalIds.has(accountId));
    const retainedSet = new Set(retainedOriginalOrder);
    const expectedRetainedOrder = proposalIds.filter(accountId => retainedSet.has(accountId));
    if (safeStringify(retainedOriginalOrder) !== safeStringify(expectedRetainedOrder)) {
      throw new Error(
        `ACCOUNT_AUTHORITY_PROPOSAL_ORDER_MISMATCH:${safeStringify(expectedRetainedOrder)}:${safeStringify(retainedOriginalOrder)}`,
      );
    }
    const executed = this.admissionRequests.length
      + this.generatedAdmissions.length
      + this.proposalResults.length;
    countFrameApplyPhase('outbound.materialize', materializeStartedAt);
    this.authoritativeExecutions += executed;
    executionLedger.authoritativeOperations += executed;
  }

  hasPreparedAccountProposal(accountId: string): boolean {
    return this.preparedProposalIds.includes(normalizeEntityId(accountId));
  }

  hasPreparedAccountInput(accountId: string, input: AccountInput): boolean {
    const normalized = normalizeEntityId(accountId);
    // Serialize the needle at most once, and only if no arrival is the very
    // object the Entity is holding. The frame hands the engine the same
    // `entityTx.data` references it later dispatches, so the scan is normally
    // a pointer compare over a queue that can be hundreds of arrivals long.
    let serializedInput: string | undefined;
    for (let index = this.inboundCursor; index < this.inboundRequests.length; index += 1) {
      const request = this.inboundRequests[index];
      if (request === undefined) continue;
      if (request.accountId !== normalized) continue;
      if (request.input === input) return true;
      serializedInput ??= safeStringify(input);
      if (safeStringify(request.input) === serializedInput) return true;
    }
    return false;
  }

  preparedInboundGenesis(accountId: string, input: AccountInput): AccountAuthorityInputRequest['account'] | null {
    const normalized = normalizeEntityId(accountId);
    let serializedInput: string | undefined;
    for (let index = this.inboundCursor; index < this.inboundRequests.length; index += 1) {
      const request = this.inboundRequests[index];
      if (request?.genesisPolicy === undefined || request.accountId !== normalized) continue;
      if (request.input === input) return request.account;
      serializedInput ??= safeStringify(input);
      if (safeStringify(request.input) === serializedInput) return request.account;
    }
    return null;
  }

  finishEntityAccountFrame(): void {
    if (!this.frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_OUTBOUND_NOT_PREPARED:${this.ownerEntityId}`);
    if (this.proposalCursor !== this.proposalResults.length) {
      throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_UNCONSUMED:${this.proposalCursor}:${this.proposalResults.length}`);
    }
    if (this.generatedAdmissionCursor !== this.generatedAdmissions.length) {
      throw new Error(
        `ACCOUNT_AUTHORITY_GENERATED_ADMISSION_UNCONSUMED:${this.generatedAdmissionCursor}:${this.generatedAdmissions.length}`,
      );
    }
    this.frameOpened = false;
  }

  async installCommittedAccountHankos(request: AccountAuthorityCommittedHankosRequest): Promise<void> {
    if (normalizeEntityId(request.ownerEntityId) !== this.ownerEntityId) {
      throw new Error(
        `ACCOUNT_AUTHORITY_COMMITTED_HANKO_OWNER_MISMATCH:${this.ownerEntityId}:${request.ownerEntityId}`,
      );
    }
    await this.options.provider.installCommittedAccountHankos?.({
      ...request,
      ownerSignerId: this.ownerSignerId,
    });
  }

  async beforeTypeScriptAccountExecution(
    kind: 'applyAccountInput' | 'proposeAccountFrame',
    _accountId: string,
  ): Promise<void> {
    if (this.discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
    if (this.unsupportedEntityTxTypes === null) {
      throw new Error(`ACCOUNT_AUTHORITY_ENTITY_FRAME_REQUIRED:${this.ownerEntityId}`);
    }
    if (kind === 'applyAccountInput') {
      this.applyAccountInputCount += 1;
      executionLedger.typescriptApplyAccountInput += 1;
    } else {
      this.proposeAccountFrameCount += 1;
      executionLedger.typescriptProposeAccountFrame += 1;
    }
    assertNoTypeScriptAccountExecution(this);
  }

  async executeAccountInput(request: AccountAuthorityInputRequest): Promise<HandleAccountInputResult | null> {
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (request.input.kind === 'enqueue') {
      if (this.frameOutboundPrepared) {
        const prepared = this.generatedAdmissions[this.generatedAdmissionCursor];
        const actualAccount = normalizeEntityId(request.account.proofHeader.toEntity);
        const sameInput = prepared?.input === request.input
          || (prepared !== undefined && safeStringify(prepared.input) === safeStringify(request.input));
        if (
          prepared === undefined
          || normalizeEntityId(prepared.accountId) !== actualAccount
          || !sameInput
        ) {
          throw new Error(
            `ACCOUNT_AUTHORITY_GENERATED_ADMISSION_MISMATCH:${prepared?.accountId ?? 'none'}:${actualAccount}`,
          );
        }
        this.generatedAdmissionCursor += 1;
        return prepared.result;
      }
      this.admissionRequests.push(request);
      return accountInputApplied({ events: [], admittedAccountTxCount: request.input.txs.length });
    }
    const expected = this.inboundRequests[this.inboundCursor];
    const result = this.inboundResults[this.inboundCursor];
    if (expected === undefined || result === undefined) {
      throw new Error(`ACCOUNT_AUTHORITY_INBOUND_UNPREPARED:${request.account.proofHeader.toEntity}`);
    }
    const expectedAccount = expected.accountId;
    const actualAccount = normalizeEntityId(request.account.proofHeader.toEntity);
    // Identity is the common case and is exactly as strong as comparing the
    // canonical bytes: both sides hold the same `entityTx.data`. A frame that
    // rebuilt its inputs still gets the full byte comparison.
    const sameInput = expected.input === request.input
      || safeStringify(expected.input) === safeStringify(request.input);
    if (expectedAccount !== actualAccount || !sameInput) {
      throw new Error(`ACCOUNT_AUTHORITY_INBOUND_ORDER_MISMATCH:${expectedAccount}:${actualAccount}`);
    }
    this.inboundRequests[this.inboundCursor] = { ...expected, account: request.account };
    this.inboundCursor += 1;
    return this.restoreCollisionQueueEvent(result, actualAccount);
  }

  private restoreCollisionQueueEvent(
    result: HandleAccountInputResult,
    accountId: string,
  ): HandleAccountInputResult {
    const collision = result.ok && result.events.some(event =>
      event.startsWith('📤 LEFT-WINS: Ignored RIGHT'));
    // A collision is exceptional. Scanning every admission for every ordinary
    // inbound result made this path quadratic in a busy Entity frame even
    // though the scan can only affect the collision-only diagnostic below.
    if (!collision) return result;
    const alreadyQueued = this.admissionRequests
      .filter(entry => normalizeEntityId(entry.account.proofHeader.toEntity) === accountId)
      .reduce((count, entry) => count + (entry.input.kind === 'enqueue' ? entry.input.txs.length : 0), 0);
    if (alreadyQueued === 0) return result;
    const warningPrefix = '⚠️ LEFT has ';
    const warningSuffix = " pending txs while waiting for RIGHT's ACK";
    const warningIndexes = result.events.flatMap((event, index) =>
      event.startsWith(warningPrefix) ? [index] : []);
    if (warningIndexes.length > 1) {
      throw new Error(`ACCOUNT_AUTHORITY_COLLISION_QUEUE_WARNING_DUPLICATE:${accountId}`);
    }
    const warningIndex = warningIndexes[0];
    if (warningIndex !== undefined) {
      const warning = result.events[warningIndex] ?? '';
      if (!warning.endsWith(warningSuffix)) {
        throw new Error(`ACCOUNT_AUTHORITY_COLLISION_QUEUE_WARNING_INVALID:${accountId}`);
      }
      const engineQueued = Number(warning.slice(warningPrefix.length, -warningSuffix.length));
      const total = engineQueued + alreadyQueued;
      if (!Number.isSafeInteger(engineQueued) || engineQueued < 1 || !Number.isSafeInteger(total)) {
        throw new Error(`ACCOUNT_AUTHORITY_COLLISION_QUEUE_COUNT_INVALID:${accountId}`);
      }
      return {
        ...result,
        events: result.events.map((event, index) => index === warningIndex
          ? `${warningPrefix}${total}${warningSuffix}`
          : event),
      };
    }
    return {
      ...result,
      events: [
        ...result.events,
        `${warningPrefix}${alreadyQueued}${warningSuffix}`,
      ],
    };
  }

  async executeAccountProposal(
    request: AccountAuthorityProposalRequest,
  ): Promise<ProposeAccountFrameResult | null> {
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (!this.frameOutboundPrepared) throw new Error('ACCOUNT_AUTHORITY_PROPOSAL_BEFORE_OUTBOUND');
    // Rust consumes the whole resident mempool and returns its rejected rows.
    // A caller-selected subset would make Rust sign different bytes from the
    // canonical TypeScript proposal window, so this is a protocol violation,
    // not an eligibility miss that may fall back to TypeScript.
    if (!request.selectionIsWholeMempool) {
      throw new Error('ACCOUNT_AUTHORITY_PROPOSAL_SUBSET_UNSUPPORTED');
    }
    const expectedId = this.preparedProposalIds[this.proposalCursor];
    const actualId = normalizeEntityId(request.account.proofHeader.toEntity);
    const result = this.proposalResults[this.proposalCursor];
    if (expectedId === undefined || result === undefined || expectedId !== actualId) {
      throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_ORDER_MISMATCH:${safeStringify({
        cursor: this.proposalCursor,
        expectedId: expectedId ?? null,
        actualId,
        preparedProposalIds: this.preparedProposalIds,
        mempool: request.account.mempool.map(tx => tx.type),
        currentHeight: request.account.currentHeight,
        pendingFrame: request.account.pendingFrame?.height ?? null,
      })}`);
    }
    this.proposalCursor += 1;
    return result;
  }

  typeScriptExecutionCounts(): TypeScriptAccountExecutionCounts {
    return {
      applyAccountInput: this.applyAccountInputCount,
      proposeAccountFrame: this.proposeAccountFrameCount,
    };
  }

  authoritativeExecutionCount(): number {
    return this.authoritativeExecutions;
  }

  async discard(): Promise<void> {
    if (this.discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARD_DUPLICATE');
    await this.discardOpenFrameAttempt();
    this.discarded = true;
  }
}

const createAccountAuthorityEntityStage = (
  options: AccountAuthorityEntityStageOptions,
): AccountAuthorityEntityStage => new AccountAuthorityEntityStageImpl(options);

type AccountAuthorityStageHost = EntityRuntimeContext & {
  accountAuthorityEntityStage?: AccountAuthorityEntityStageCapability | undefined;
};

/** Install exactly for one Entity transition and clear even when cleanup fails. */
export const runAccountAuthorityEntityStage = async <T>(
  env: AccountAuthorityStageHost,
  options: AccountAuthorityEntityStageOptions | null,
  apply: () => Promise<T>,
): Promise<T> => {
  if (env.accountAuthorityEntityStage !== undefined) {
    throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_LEAKED');
  }
  if (options === null) return apply();
  const stage = createAccountAuthorityEntityStage(options);
  env.accountAuthorityEntityStage = stage;
  let outcome: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;
  try {
    outcome = { ok: true, value: await apply() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let cleanup: Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>;
  try {
    await stage.discard();
    cleanup = { ok: true };
  } catch (error) {
    cleanup = { ok: false, error };
  } finally {
    delete env.accountAuthorityEntityStage;
  }
  if (!outcome.ok && !cleanup.ok) {
    throw new AggregateError(
      [outcome.error, cleanup.error],
      'ACCOUNT_AUTHORITY_ENTITY_STAGE_APPLY_DISCARD_FAILED',
    );
  }
  if (!outcome.ok) throw outcome.error;
  if (!cleanup.ok) throw cleanup.error;
  return outcome.value;
};
