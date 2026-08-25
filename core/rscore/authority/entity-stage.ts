import type {
  AccountAuthorityFrameBeginRequest,
  AccountAuthorityFrameOutboundRequest,
  AccountAuthorityInputRequest,
  AccountAuthorityProposalRequest,
} from '../../account/consensus/context';
import type {
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from '../../account/consensus/types';
import type { AccountInput } from '../../types/account';
import type { EntityInput } from '../../entity/types';
import type {
  AccountAuthorityEntityStageCapability,
  EntityRuntimeContext,
} from '../../entity/runtime-context';
import { cloneIsolatedEntityInput } from '../../entity/state/input-clone';
import { accountInputApplied } from '../../account/consensus/result';
import { inboundArrivals } from '../round/inbound';
import { safeStringify } from '../../protocol/serialization';

type AccountAuthorityExecutionMode = 'pre-ts-observe' | 'cutover';

type TypeScriptAccountExecutionCounts = Readonly<{
  applyAccountInput: number;
  proposeAccountFrame: number;
}>;

export type AccountAuthorityEntityOccurrence =
  | Readonly<{ kind: 'runtime-input'; inputIndex: number }>
  | Readonly<{ kind: 'local-event'; ordinal: number }>;

export type AccountAuthorityEntityStageBegin = Readonly<{
  ownerEntityId: string;
  canonicalEntityInput: EntityInput;
  occurrence: AccountAuthorityEntityOccurrence;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
  firstOperation: Readonly<{
    kind: 'applyAccountInput' | 'proposeAccountFrame';
    accountId: string;
  }>;
}>;

type AccountAuthorityEntitySavepoint = Readonly<{
  discard(): Promise<void>;
}>;

/**
 * Runtime-injected bridge. Production leaves it absent until the Rust result
 * ABI can replace TypeScript execution; tests can exercise lifecycle without
 * pretending that a financial cutover already exists.
 */
export type AccountAuthorityEntityStageProvider = Readonly<{
  beginEntityStage(input: AccountAuthorityEntityStageBegin): Promise<AccountAuthorityEntitySavepoint>;
  executeAccountInboundBatch?(
    input: AccountAuthorityEntityBatchInbound,
  ): Promise<readonly ((request: AccountAuthorityInputRequest) => HandleAccountInputResult)[]>;
  executeAccountOutboundBatch?(
    input: AccountAuthorityEntityBatchOutbound,
  ): Promise<readonly ProposeAccountFrameResult[]>;
}>;

type AccountAuthorityEntityParent = Readonly<{
  ownerEntityId: string;
  canonicalEntityInput: EntityInput;
  occurrence: AccountAuthorityEntityOccurrence;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}>;

export type AccountAuthorityEntityBatchInbound = AccountAuthorityEntityParent & Readonly<{
  requests: readonly AccountAuthorityInputRequest[];
}>;

export type AccountAuthorityEntityBatchOutbound = AccountAuthorityEntityParent & Readonly<{
  admissions: readonly AccountAuthorityInputRequest[];
  proposals: readonly AccountAuthorityProposalRequest[];
  materializeAccounts: readonly Readonly<{
    accountId: string;
    account: AccountAuthorityInputRequest['account'];
  }>[];
}>;

export interface AccountAuthorityEntityStage extends AccountAuthorityEntityStageCapability {
  readonly mode: AccountAuthorityExecutionMode;
  readonly ownerEntityId: string;
  bindCanonicalInput(input: EntityInput): void;
  typeScriptExecutionCounts(): TypeScriptAccountExecutionCounts;
  authoritativeExecutionCount(): number;
  discard(): Promise<void>;
}

export type AccountAuthorityEntityStageOptions = Readonly<{
  mode: AccountAuthorityExecutionMode;
  ownerEntityId: string;
  provider: AccountAuthorityEntityStageProvider;
  occurrence: AccountAuthorityEntityOccurrence;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}>;

export type AccountAuthorityEntityStageConfiguration = Readonly<{
  accountAuthorityExecutionMode?: AccountAuthorityExecutionMode | undefined;
  accountAuthorityEntityStageProvider?: AccountAuthorityEntityStageProvider | undefined;
}>;

export type AccountAuthorityEntityTransition = Readonly<{
  ownerEntityId: string;
  occurrence?: AccountAuthorityEntityOccurrence | undefined;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}>;

export const resolveAccountAuthorityEntityStageOptions = (
  configuration: AccountAuthorityEntityStageConfiguration,
  transition: AccountAuthorityEntityTransition,
  migrationRecorderEnabled: boolean,
): AccountAuthorityEntityStageOptions | null => {
  const mode = configuration.accountAuthorityExecutionMode;
  const provider = configuration.accountAuthorityEntityStageProvider;
  // Observation and the parity recorder are two answers to the same
  // question and must not both run. Cutover is the opposite case: the
  // recorder is how the engine receives the raw inputs it executes.
  if (mode === 'pre-ts-observe' && migrationRecorderEnabled) {
    throw new Error(`ACCOUNT_AUTHORITY_MODE_CONFLICT:${mode}:post-ts-migration`);
  }
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
    mode,
    ownerEntityId: transition.ownerEntityId,
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
  readonly mode: AccountAuthorityExecutionMode;
  readonly ownerEntityId: string;
  private readonly options: AccountAuthorityEntityStageOptions;
  private readonly occurrence: AccountAuthorityEntityOccurrence;
  private canonicalEntityInput: EntityInput | null = null;
  private beginPromise: Promise<AccountAuthorityEntitySavepoint> | null = null;
  private savepoint: AccountAuthorityEntitySavepoint | null = null;
  private beginFailed = false;
  private discarded = false;
  private applyAccountInputCount = 0;
  private proposeAccountFrameCount = 0;
  private authoritativeExecutions = 0;
  private frameOpened = false;
  private frameOutboundPrepared = false;
  private inboundRequests: AccountAuthorityInputRequest[] = [];
  private inboundResults: HandleAccountInputResult[] = [];
  private inboundCursor = 0;
  private admissionRequests: AccountAuthorityInputRequest[] = [];
  private preparedProposalIds: string[] = [];
  private proposalResults: ProposeAccountFrameResult[] = [];
  private proposalCursor = 0;

  constructor(options: AccountAuthorityEntityStageOptions) {
    assertOccurrence(options.occurrence);
    this.options = options;
    this.mode = options.mode;
    this.ownerEntityId = normalizeEntityId(options.ownerEntityId);
    this.occurrence = options.occurrence.kind === 'runtime-input'
      ? { kind: 'runtime-input', inputIndex: options.occurrence.inputIndex }
      : { kind: 'local-event', ordinal: options.occurrence.ordinal };
  }

  private parentOf(): AccountAuthorityEntityParent {
    if (this.discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
    if (this.canonicalEntityInput === null) {
      throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_REQUIRED:${this.ownerEntityId}`);
    }
    return {
      ownerEntityId: this.ownerEntityId,
      canonicalEntityInput: cloneIsolatedEntityInput(this.canonicalEntityInput),
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

  private requireBatchProvider<K extends 'executeAccountInboundBatch' | 'executeAccountOutboundBatch'>(
    key: K,
  ): NonNullable<AccountAuthorityEntityStageProvider[K]> {
    const value = this.options.provider[key];
    if (value === undefined) {
      throw new Error(`ACCOUNT_AUTHORITY_BATCH_EXECUTOR_REQUIRED:${key}:${this.ownerEntityId}`);
    }
    return value as NonNullable<AccountAuthorityEntityStageProvider[K]>;
  }

  bindCanonicalInput(input: EntityInput): void {
    if (this.discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
    if (this.canonicalEntityInput !== null) {
      throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_ALREADY_BOUND:${this.ownerEntityId}`);
    }
    if (normalizeEntityId(input.entityId) !== this.ownerEntityId) {
      throw new Error(
        `ACCOUNT_AUTHORITY_CANONICAL_INPUT_OWNER_MISMATCH:${this.ownerEntityId}:${input.entityId}`,
      );
    }
    this.canonicalEntityInput = cloneIsolatedEntityInput(input);
  }

  async beginEntityAccountFrame(request: AccountAuthorityFrameBeginRequest): Promise<void> {
    if (this.mode !== 'cutover') return;
    if (this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_DUPLICATE:${this.ownerEntityId}`);
    if (normalizeEntityId(request.ownerEntityId) !== this.ownerEntityId) {
      throw new Error(`ACCOUNT_AUTHORITY_FRAME_OWNER_MISMATCH:${this.ownerEntityId}:${request.ownerEntityId}`);
    }
    this.frameOpened = true;
    this.inboundRequests = inboundArrivals(request.entityTxs).map(arrival => {
      const accountId = normalizeEntityId(arrival.accountId);
      const account = request.accountForWrite(accountId);
      if (account === undefined) {
        throw new Error(`ACCOUNT_AUTHORITY_INBOUND_ACCOUNT_MISSING:${accountId}`);
      }
      return {
        collectorFrameId: String(request.ownerEntityId),
        account,
        input: arrival.input,
        entityTimestamp: request.entityTimestamp,
        finalizedJHeight: request.finalizedJHeight,
      };
    });
    const run = this.requireBatchProvider('executeAccountInboundBatch');
    const materializers = [...await run.call(this.options.provider, {
      ...this.parentOf(),
      requests: this.inboundRequests,
    })];
    if (materializers.length !== this.inboundRequests.length) {
      throw new Error(
        `ACCOUNT_AUTHORITY_INBOUND_RESULT_ARITY:${this.inboundRequests.length}:${materializers.length}`,
      );
    }
    this.inboundResults = materializers.map((materializeResult, index) => {
      const expected = this.inboundRequests[index];
      if (expected === undefined) throw new Error(`ACCOUNT_AUTHORITY_INBOUND_REQUEST_MISSING:${index}`);
      return materializeResult(expected);
    });
    this.authoritativeExecutions += this.inboundRequests.length;
    executionLedger.authoritativeOperations += this.inboundRequests.length;
  }

  async prepareEntityAccountOutbound(request: AccountAuthorityFrameOutboundRequest): Promise<void> {
    if (this.mode !== 'cutover') return;
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (this.frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_OUTBOUND_DUPLICATE:${this.ownerEntityId}`);
    if (this.inboundCursor !== this.inboundRequests.length) {
      throw new Error(`ACCOUNT_AUTHORITY_INBOUND_UNCONSUMED:${this.inboundCursor}:${this.inboundRequests.length}`);
    }
    this.frameOutboundPrepared = true;
    const proposalIds = [...new Set(request.proposalAccountIds.map(normalizeEntityId))]
      .filter(accountId => request.accounts.has(accountId))
      .toSorted();
    const proposals = proposalIds.map(accountId => {
      const account = request.accounts.get(accountId);
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
    const run = this.requireBatchProvider('executeAccountOutboundBatch');
    const materializeById = new Map(this.inboundRequests.map(request => {
      const accountId = normalizeEntityId(request.account.proofHeader.toEntity);
      return [accountId, { accountId, account: request.account }] as const;
    }));
    this.proposalResults = [...await run.call(this.options.provider, {
      ...this.parentOf(),
      admissions: this.admissionRequests,
      proposals,
      materializeAccounts: [...materializeById.values()].toSorted((left, right) =>
        left.accountId.localeCompare(right.accountId),
      ),
    })];
    this.preparedProposalIds = proposalIds;
    if (this.proposalResults.length !== proposals.length) {
      throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_RESULT_ARITY:${proposals.length}:${this.proposalResults.length}`);
    }
    const executed = this.admissionRequests.length + proposals.length;
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
      if (normalizeEntityId(request.account.proofHeader.toEntity) !== normalized) continue;
      if (request.input === input) return true;
      serializedInput ??= safeStringify(input);
      if (safeStringify(request.input) === serializedInput) return true;
    }
    return false;
  }

  finishEntityAccountFrame(): void {
    if (this.mode !== 'cutover') return;
    if (!this.frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_OUTBOUND_NOT_PREPARED:${this.ownerEntityId}`);
    if (this.proposalCursor !== this.proposalResults.length) {
      throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_UNCONSUMED:${this.proposalCursor}:${this.proposalResults.length}`);
    }
  }

  async beforeTypeScriptAccountExecution(
    kind: 'applyAccountInput' | 'proposeAccountFrame',
    accountId: string,
  ): Promise<void> {
    if (this.discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
    if (this.canonicalEntityInput === null) {
      throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_REQUIRED:${this.ownerEntityId}`);
    }
    if (this.beginPromise === null) this.openObservationStage(kind, accountId);
    await this.beginPromise;
    if (kind === 'applyAccountInput') {
      this.applyAccountInputCount += 1;
      executionLedger.typescriptApplyAccountInput += 1;
    } else {
      this.proposeAccountFrameCount += 1;
      executionLedger.typescriptProposeAccountFrame += 1;
    }
    if (this.mode === 'cutover') assertNoTypeScriptAccountExecution(this);
  }

  private openObservationStage(
    kind: 'applyAccountInput' | 'proposeAccountFrame',
    accountId: string,
  ): void {
    if (this.canonicalEntityInput === null) {
      throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_REQUIRED:${this.ownerEntityId}`);
    }
    this.beginPromise = this.options.provider.beginEntityStage({
      ...this.parentOf(),
      firstOperation: { kind, accountId: normalizeEntityId(accountId) },
    }).then(opened => {
      this.savepoint = opened;
      return opened;
    }, error => {
      this.beginFailed = true;
      throw error;
    });
  }

  async executeAccountInput(request: AccountAuthorityInputRequest): Promise<HandleAccountInputResult | null> {
    if (this.mode !== 'cutover') return null;
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (request.input.kind === 'enqueue') {
      if (this.frameOutboundPrepared) throw new Error('ACCOUNT_AUTHORITY_ADMISSION_AFTER_OUTBOUND');
      this.admissionRequests.push(request);
      return accountInputApplied({ events: [], admittedAccountTxCount: request.input.txs.length });
    }
    const expected = this.inboundRequests[this.inboundCursor];
    const result = this.inboundResults[this.inboundCursor];
    if (expected === undefined || result === undefined) {
      throw new Error(`ACCOUNT_AUTHORITY_INBOUND_UNPREPARED:${request.account.proofHeader.toEntity}`);
    }
    const expectedAccount = normalizeEntityId(expected.account.proofHeader.toEntity);
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
    if (alreadyQueued === 0 || result.events.some(event => event.startsWith('⚠️ LEFT has '))) {
      return result;
    }
    return {
      ...result,
      events: [
        ...result.events,
        `⚠️ LEFT has ${alreadyQueued} pending txs while waiting for RIGHT's ACK`,
      ],
    };
  }

  async executeAccountProposal(
    request: AccountAuthorityProposalRequest,
  ): Promise<ProposeAccountFrameResult | null> {
    if (this.mode !== 'cutover') return null;
    if (!this.frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${this.ownerEntityId}`);
    if (!this.frameOutboundPrepared) throw new Error('ACCOUNT_AUTHORITY_PROPOSAL_BEFORE_OUTBOUND');
    const expectedId = this.preparedProposalIds[this.proposalCursor];
    const actualId = normalizeEntityId(request.account.proofHeader.toEntity);
    const result = this.proposalResults[this.proposalCursor];
    if (expectedId === undefined || result === undefined || expectedId !== actualId) {
      throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_ORDER_MISMATCH:${expectedId ?? 'none'}:${actualId}`);
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
    this.discarded = true;
    if (this.mode === 'cutover' || this.beginPromise === null || this.beginFailed) return;
    await this.beginPromise;
    if (this.savepoint === null) {
      throw new Error(`ACCOUNT_AUTHORITY_ENTITY_SAVEPOINT_MISSING:${this.ownerEntityId}`);
    }
    await this.savepoint.discard();
  }
}

export const createAccountAuthorityEntityStage = (
  options: AccountAuthorityEntityStageOptions,
): AccountAuthorityEntityStage => new AccountAuthorityEntityStageImpl(options);

type AccountAuthorityStageHost = EntityRuntimeContext & {
  accountAuthorityEntityStage?: AccountAuthorityEntityStage | undefined;
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
