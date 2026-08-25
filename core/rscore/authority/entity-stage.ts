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
}>;

export interface AccountAuthorityEntityStage extends AccountAuthorityEntityStageCapability {
  readonly mode: AccountAuthorityExecutionMode;
  readonly ownerEntityId: string;
  bindCanonicalInput(input: EntityInput): void;
  typeScriptExecutionCounts(): TypeScriptAccountExecutionCounts;
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
  if (mode !== undefined && migrationRecorderEnabled) {
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

  const counts = (): TypeScriptAccountExecutionCounts => ({
    applyAccountInput,
    proposeAccountFrame,
  });

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
      if (kind === 'applyAccountInput') applyAccountInput += 1;
      else proposeAccountFrame += 1;
      if (options.mode === 'cutover') assertNoTypeScriptAccountExecution(stage);
    },
    typeScriptExecutionCounts: counts,
    async discard() {
      if (discarded) throw new Error('ACCOUNT_AUTHORITY_ENTITY_STAGE_DISCARD_DUPLICATE');
      discarded = true;
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
