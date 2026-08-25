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
import type { EntityInput } from '../../entity/types';
import type {
  AccountAuthorityEntityStageCapability,
  EntityRuntimeContext,
} from '../../entity/runtime-context';
import { cloneIsolatedEntityInput } from '../../entity/state/input-clone';
import { accountInputApplied } from '../../account/consensus/result';
import { inboundArrivals } from '../round/inbound';
import { safeStringify } from '../../protocol/serialization';

export type AccountAuthorityExecutionMode = 'pre-ts-observe' | 'cutover';

export type TypeScriptAccountExecutionCounts = Readonly<{
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

export type AccountAuthorityEntitySavepoint = Readonly<{
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

export const resetAccountAuthorityExecutionLedgerForTests = (): void => {
  executionLedger.typescriptApplyAccountInput = 0;
  executionLedger.typescriptProposeAccountFrame = 0;
  executionLedger.authoritativeOperations = 0;
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

export const assertNoTypeScriptAccountExecution = (
  scope: Pick<AccountAuthorityEntityStage, 'ownerEntityId' | 'typeScriptExecutionCounts'>,
): void => {
  const counts = scope.typeScriptExecutionCounts();
  if (counts.applyAccountInput === 0 && counts.proposeAccountFrame === 0) return;
  throw new Error(
    `ACCOUNT_AUTHORITY_CUTOVER_TS_EXECUTION:${scope.ownerEntityId}:` +
    `apply=${counts.applyAccountInput}:propose=${counts.proposeAccountFrame}`,
  );
};

export const createAccountAuthorityEntityStage = (
  options: AccountAuthorityEntityStageOptions,
): AccountAuthorityEntityStage => {
  assertOccurrence(options.occurrence);
  const occurrence: AccountAuthorityEntityOccurrence = options.occurrence.kind === 'runtime-input'
    ? { kind: 'runtime-input', inputIndex: options.occurrence.inputIndex }
    : { kind: 'local-event', ordinal: options.occurrence.ordinal };
  const ownerEntityId = normalizeEntityId(options.ownerEntityId);
  let canonicalEntityInput: EntityInput | null = null;
  let beginPromise: Promise<AccountAuthorityEntitySavepoint> | null = null;
  let savepoint: AccountAuthorityEntitySavepoint | null = null;
  let beginFailed = false;
  let discarded = false;
  let applyAccountInput = 0;
  let proposeAccountFrame = 0;
  let authoritativeExecutions = 0;
  let frameOpened = false;
  let frameOutboundPrepared = false;
  let inboundRequests: AccountAuthorityInputRequest[] = [];
  let inboundResults: HandleAccountInputResult[] = [];
  let inboundCursor = 0;
  let admissionRequests: AccountAuthorityInputRequest[] = [];
  let preparedProposalIds: string[] = [];
  let proposalResults: ProposeAccountFrameResult[] = [];
  let proposalCursor = 0;

  const counts = (): TypeScriptAccountExecutionCounts => ({
    applyAccountInput,
    proposeAccountFrame,
  });

  const parentOf = (): Readonly<{
    ownerEntityId: string;
    canonicalEntityInput: EntityInput;
    occurrence: AccountAuthorityEntityOccurrence;
    trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
    deferProposal: boolean;
    requiredEntityTxIndex?: number;
  }> => {
    if (discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
    if (canonicalEntityInput === null) {
      throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_REQUIRED:${ownerEntityId}`);
    }
    return {
      ownerEntityId,
      canonicalEntityInput: cloneIsolatedEntityInput(canonicalEntityInput),
      occurrence,
      ...(options.trustedLocalRuntimeProtocol === undefined
        ? {}
        : { trustedLocalRuntimeProtocol: options.trustedLocalRuntimeProtocol }),
      deferProposal: options.deferProposal,
      ...(options.requiredEntityTxIndex === undefined
        ? {}
        : { requiredEntityTxIndex: options.requiredEntityTxIndex }),
    };
  };

  const requireBatchProvider = <K extends 'executeAccountInboundBatch' | 'executeAccountOutboundBatch'>(
    key: K,
  ): NonNullable<AccountAuthorityEntityStageProvider[K]> => {
    const value = options.provider[key];
    if (value === undefined) {
      throw new Error(`ACCOUNT_AUTHORITY_BATCH_EXECUTOR_REQUIRED:${key}:${ownerEntityId}`);
    }
    return value as NonNullable<AccountAuthorityEntityStageProvider[K]>;
  };

  const normalizeAccountId = (value: string): string => value.trim().toLowerCase();

  const stage: AccountAuthorityEntityStage = {
    mode: options.mode,
    ownerEntityId,
    bindCanonicalInput(input) {
      if (discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
      if (canonicalEntityInput !== null) {
        throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_ALREADY_BOUND:${ownerEntityId}`);
      }
      if (normalizeEntityId(input.entityId) !== ownerEntityId) {
        throw new Error(
          `ACCOUNT_AUTHORITY_CANONICAL_INPUT_OWNER_MISMATCH:${ownerEntityId}:${input.entityId}`,
        );
      }
      canonicalEntityInput = cloneIsolatedEntityInput(input);
    },
    async beginEntityAccountFrame(request: AccountAuthorityFrameBeginRequest) {
      if (options.mode !== 'cutover') return;
      if (frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_DUPLICATE:${ownerEntityId}`);
      if (normalizeAccountId(request.ownerEntityId) !== ownerEntityId) {
        throw new Error(`ACCOUNT_AUTHORITY_FRAME_OWNER_MISMATCH:${ownerEntityId}:${request.ownerEntityId}`);
      }
      frameOpened = true;
      inboundRequests = inboundArrivals(request.entityTxs).map(arrival => {
        const accountId = normalizeAccountId(arrival.accountId);
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
      const run = requireBatchProvider('executeAccountInboundBatch');
      const materializers = [...await run.call(options.provider, {
        ...parentOf(),
        requests: inboundRequests,
      })];
      if (materializers.length !== inboundRequests.length) {
        throw new Error(
          `ACCOUNT_AUTHORITY_INBOUND_RESULT_ARITY:${inboundRequests.length}:${materializers.length}`,
        );
      }
      inboundResults = materializers.map((materializeResult, index) => {
        const expected = inboundRequests[index];
        if (expected === undefined) throw new Error(`ACCOUNT_AUTHORITY_INBOUND_REQUEST_MISSING:${index}`);
        return materializeResult(expected);
      });
      authoritativeExecutions += inboundRequests.length;
      executionLedger.authoritativeOperations += inboundRequests.length;
    },
    async prepareEntityAccountOutbound(request: AccountAuthorityFrameOutboundRequest) {
      if (options.mode !== 'cutover') return;
      if (!frameOpened) throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${ownerEntityId}`);
      if (frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_OUTBOUND_DUPLICATE:${ownerEntityId}`);
      if (inboundCursor !== inboundRequests.length) {
        throw new Error(`ACCOUNT_AUTHORITY_INBOUND_UNCONSUMED:${inboundCursor}:${inboundRequests.length}`);
      }
      frameOutboundPrepared = true;
      const admittedIds = new Set(admissionRequests.map(entry =>
        normalizeAccountId(entry.account.proofHeader.toEntity)));
      const proposalIds = [...new Set(request.proposalAccountIds.map(normalizeAccountId))]
        .filter(accountId => {
          const account = request.accounts.get(accountId);
          return account !== undefined
            && account.pendingFrame === undefined
            && (account.mempool.length > 0 || admittedIds.has(accountId));
        })
        .sort();
      const proposals = proposalIds.map(accountId => {
        const account = request.accounts.get(accountId);
        if (account === undefined) throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_ACCOUNT_MISSING:${accountId}`);
        return {
          collectorFrameId: ownerEntityId,
          account,
          timestamp: request.timestamp,
          jHeight: request.jHeight,
          entityTimestamp: request.timestamp,
          finalizedJHeight: request.jHeight,
          selectionIsWholeMempool: true,
        };
      });
      const run = requireBatchProvider('executeAccountOutboundBatch');
      proposalResults = [...await run.call(options.provider, {
        ...parentOf(),
        admissions: admissionRequests,
        proposals,
      })];
      preparedProposalIds = proposalIds;
      if (proposalResults.length !== proposals.length) {
        throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_RESULT_ARITY:${proposals.length}:${proposalResults.length}`);
      }
      authoritativeExecutions += admissionRequests.length + proposals.length;
      executionLedger.authoritativeOperations += admissionRequests.length + proposals.length;
    },
    hasPreparedAccountProposal(accountId: string) {
      return preparedProposalIds.includes(normalizeAccountId(accountId));
    },
    hasPreparedAccountInput(accountId, input) {
      const normalized = normalizeAccountId(accountId);
      return inboundRequests.slice(inboundCursor).some(request =>
        normalizeAccountId(request.account.proofHeader.toEntity) === normalized
        && safeStringify(request.input) === safeStringify(input));
    },
    finishEntityAccountFrame() {
      if (options.mode !== 'cutover') return;
      if (!frameOutboundPrepared) throw new Error(`ACCOUNT_AUTHORITY_OUTBOUND_NOT_PREPARED:${ownerEntityId}`);
      if (proposalCursor !== proposalResults.length) {
        throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_UNCONSUMED:${proposalCursor}:${proposalResults.length}`);
      }
    },
    async beforeTypeScriptAccountExecution(kind, accountId) {
      if (discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARDED');
      if (canonicalEntityInput === null) {
        throw new Error(`ACCOUNT_AUTHORITY_CANONICAL_INPUT_REQUIRED:${ownerEntityId}`);
      }
      if (beginPromise === null) {
        beginPromise = options.provider.beginEntityStage({
          ownerEntityId,
          canonicalEntityInput: cloneIsolatedEntityInput(canonicalEntityInput),
          occurrence,
          ...(options.trustedLocalRuntimeProtocol === undefined
            ? {}
            : { trustedLocalRuntimeProtocol: options.trustedLocalRuntimeProtocol }),
          deferProposal: options.deferProposal,
          ...(options.requiredEntityTxIndex === undefined
            ? {}
            : { requiredEntityTxIndex: options.requiredEntityTxIndex }),
          firstOperation: {
            kind,
            accountId: normalizeEntityId(accountId),
          },
        }).then(opened => {
          savepoint = opened;
          return opened;
        }, error => {
          beginFailed = true;
          throw error;
        });
      }
      await beginPromise;
      if (kind === 'applyAccountInput') {
        applyAccountInput += 1;
        executionLedger.typescriptApplyAccountInput += 1;
      } else {
        proposeAccountFrame += 1;
        executionLedger.typescriptProposeAccountFrame += 1;
      }
      if (options.mode === 'cutover') assertNoTypeScriptAccountExecution(stage);
    },
    async executeAccountInput(request) {
      if (options.mode === 'cutover' && frameOpened) {
        if (request.input.kind === 'enqueue') {
          if (frameOutboundPrepared) throw new Error('ACCOUNT_AUTHORITY_ADMISSION_AFTER_OUTBOUND');
          admissionRequests.push(request);
          return accountInputApplied({
            events: [],
            admittedAccountTxCount: request.input.txs.length,
          });
        }
        const expected = inboundRequests[inboundCursor];
        const result = inboundResults[inboundCursor];
        if (expected === undefined || result === undefined) {
          throw new Error(`ACCOUNT_AUTHORITY_INBOUND_UNPREPARED:${request.account.proofHeader.toEntity}`);
        }
        const expectedAccount = normalizeAccountId(expected.account.proofHeader.toEntity);
        const actualAccount = normalizeAccountId(request.account.proofHeader.toEntity);
        if (expectedAccount !== actualAccount || safeStringify(expected.input) !== safeStringify(request.input)) {
          throw new Error(`ACCOUNT_AUTHORITY_INBOUND_ORDER_MISMATCH:${expectedAccount}:${actualAccount}`);
        }
        inboundRequests[inboundCursor] = { ...expected, account: request.account };
        inboundCursor += 1;
        // The two-call architecture applies peer rows in Rust before Entity
        // follow-ups are admitted. The canonical TS event, however, reports
        // how many earlier follow-ups in this same Entity frame were waiting
        // when a losing collision arrived. Reattach that orchestration fact;
        // it changes no Account verdict or state, but Entity hashes the event.
        const collision = result.ok && result.events.some(event =>
          event.startsWith('📤 LEFT-WINS: Ignored RIGHT'));
        const alreadyQueued = admissionRequests
          .filter(entry => normalizeAccountId(entry.account.proofHeader.toEntity) === actualAccount)
          .reduce((count, entry) => count + (entry.input.kind === 'enqueue' ? entry.input.txs.length : 0), 0);
        if (
          collision
          && alreadyQueued > 0
          && !result.events.some(event => event.startsWith('⚠️ LEFT has '))
        ) {
          return {
            ...result,
            events: [
              ...result.events,
              `⚠️ LEFT has ${alreadyQueued} pending txs while waiting for RIGHT's ACK`,
            ],
          };
        }
        return result;
      }
      if (options.mode === 'cutover') {
        throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${ownerEntityId}`);
      }
      return null;
    },
    async executeAccountProposal(request) {
      if (options.mode === 'cutover' && frameOpened) {
        if (!frameOutboundPrepared) throw new Error('ACCOUNT_AUTHORITY_PROPOSAL_BEFORE_OUTBOUND');
        const expectedId = preparedProposalIds[proposalCursor];
        const actualId = normalizeAccountId(request.account.proofHeader.toEntity);
        const result = proposalResults[proposalCursor];
        if (expectedId === undefined || result === undefined || expectedId !== actualId) {
          throw new Error(`ACCOUNT_AUTHORITY_PROPOSAL_ORDER_MISMATCH:${expectedId ?? 'none'}:${actualId}`);
        }
        proposalCursor += 1;
        return result;
      }
      if (options.mode === 'cutover') {
        throw new Error(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${ownerEntityId}`);
      }
      return null;
    },
    typeScriptExecutionCounts: counts,
    authoritativeExecutionCount: () => authoritativeExecutions,
    async discard() {
      if (discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARD_DUPLICATE');
      discarded = true;
      // Cutover stages are not probes: the engine's stage is accepted or
      // discarded with the Entity input itself, by the runtime that decided.
      if (options.mode === 'cutover') return;
      if (beginPromise === null || beginFailed) return;
      await beginPromise;
      if (savepoint === null) {
        throw new Error(`ACCOUNT_AUTHORITY_ENTITY_SAVEPOINT_MISSING:${ownerEntityId}`);
      }
      await savepoint.discard();
    },
  };
  return stage;
};

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
