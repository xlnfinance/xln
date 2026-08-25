import type {
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
  /**
   * Execute one Account operation authoritatively. Present only for cutover:
   * observation mode has nothing to execute, because TypeScript still does.
   */
  executeAccountOperation?(
    input: AccountAuthorityEntityOperation,
  ): Promise<HandleAccountInputResult | ProposeAccountFrameResult>;
}>;

/**
 * One Account operation, with the Entity input that authorizes it.
 *
 * The engine opens its stage on the first operation and grows it one
 * operation at a time, so every call carries the same parent identity: the
 * canonical Entity input, where it occurred, and how the Entity is treating
 * it. Nothing here is derived from module state.
 */
export type AccountAuthorityEntityOperation = Readonly<{
  ownerEntityId: string;
  canonicalEntityInput: EntityInput;
  occurrence: AccountAuthorityEntityOccurrence;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
}> & (
  | Readonly<{ kind: 'applyAccountInput'; request: AccountAuthorityInputRequest }>
  | Readonly<{ kind: 'proposeAccountFrame'; request: AccountAuthorityProposalRequest }>
);

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
  console.error(`RSCORE_ACCOUNT_EXECUTION ${JSON.stringify(executionLedger)}`);
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

  const execute = async (
    operation: AccountAuthorityEntityOperation,
  ): Promise<HandleAccountInputResult | ProposeAccountFrameResult | null> => {
    if (options.mode !== 'cutover') return null;
    const run = options.provider.executeAccountOperation;
    if (run === undefined) {
      throw new Error(`ACCOUNT_AUTHORITY_CUTOVER_EXECUTOR_REQUIRED:${ownerEntityId}`);
    }
    const result = await run.call(options.provider, operation);
    authoritativeExecutions += 1;
    executionLedger.authoritativeOperations += 1;
    return result;
  };

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
      const result = await execute({ ...parentOf(), kind: 'applyAccountInput', request });
      return result === null ? null : (result as HandleAccountInputResult);
    },
    async executeAccountProposal(request) {
      const result = await execute({ ...parentOf(), kind: 'proposeAccountFrame', request });
      return result === null ? null : (result as ProposeAccountFrameResult);
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
