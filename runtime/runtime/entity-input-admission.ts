import { entityInputHasCrossJurisdictionIntraRuntimeTx } from '../extensions/cross-j/boundary';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import { safeStringify } from '../protocol/serialization';
import type { EntityReplica } from '../entity/types';
import type { RoutedEntityInput, RuntimeState, RuntimeTx } from './types';
import { RuntimeEntityInputApplyError } from './entity-input-contract';

export const assertRuntimeEntityIngress: (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => asserts condition = (
  condition,
  code,
  message,
  details,
) => {
  if (condition) return;
  const detailText = details ? ` ${safeStringify(details)}` : '';
  throw new Error(`${code}: ${message}${detailText}`);
};

export const collectAppliedAccountSenderHints = (
  input: RoutedEntityInput,
): string[] => {
  const localEntityId = String(input.entityId || '').toLowerCase();
  const hints = new Set<string>();
  for (const tx of getEffectiveEntityInputTxs(input)) {
    if (tx.type !== 'accountInput') continue;
    const data = tx.data as {
      fromEntityId?: unknown;
      toEntityId?: unknown;
    };
    const fromEntityId =
      typeof data.fromEntityId === 'string'
        ? data.fromEntityId.toLowerCase()
        : '';
    const toEntityId =
      typeof data.toEntityId === 'string'
        ? data.toEntityId.toLowerCase()
        : '';
    if (
      fromEntityId &&
      toEntityId === localEntityId &&
      fromEntityId !== localEntityId
    ) {
      hints.add(fromEntityId);
    }
  }
  return [...hints];
};

export const assertExternalEntityInputAllowed = (
  entityInput: RoutedEntityInput,
): void => {
  if (
    entityInput.localRuntimeProtocol === 'cross-j' ||
    (entityInput.entityTxs ?? []).some(tx => tx.type === 'runtimeOutput')
  ) {
    throw new Error(
      `RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN:entity=${entityInput.entityId}`,
    );
  }
  if (
    !entityInput.from ||
    !entityInputHasCrossJurisdictionIntraRuntimeTx(entityInput)
  ) {
    return;
  }
  assertRuntimeEntityIngress(
    false,
    'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN',
    'Cross-j Entity inputs are runtime-private and cannot arrive remotely',
    {
      entityId: entityInput.entityId,
      from: entityInput.from,
      txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
    },
  );
};

const importedReplicaKeys = (
  runtimeTxs: readonly RuntimeTx[],
): Set<string> =>
  new Set(
    runtimeTxs.flatMap(tx =>
      tx.type === 'importReplica'
        ? [
            `${tx.entityId.trim().toLowerCase()}:${tx.signerId
              .trim()
              .toLowerCase()}`,
          ]
        : [],
    ),
  );

const replicaKeysForEntity = (
  env: RuntimeState,
  entityId: string,
  imports: ReadonlySet<string>,
): string[] => {
  const prefix = `${entityId}:`;
  return [...env.eReplicas.keys(), ...imports].filter(key =>
    key.startsWith(prefix),
  );
};

/**
 * Prove every external Entity target before Runtime mutates.
 *
 * Imports in the same Runtime frame are included in the projected replica
 * set. The reducer resolves the concrete replica again after imports apply.
 */
export const validateExternalEntityInputTargets = (
  env: RuntimeState,
  inputs: readonly RoutedEntityInput[],
  runtimeTxs: readonly RuntimeTx[],
): void => {
  const imports = importedReplicaKeys(runtimeTxs);
  for (const input of inputs) {
    try {
      assertExternalEntityInputAllowed(input);
      const entityId = input.entityId.trim().toLowerCase();
      const signerId = input.signerId.trim().toLowerCase();
      const replicaKey = `${entityId}:${signerId}`;
      if (env.eReplicas.has(replicaKey) || imports.has(replicaKey)) continue;
      const siblingKeys = replicaKeysForEntity(env, entityId, imports);
      const mayRetargetEmptyProtocolInput =
        siblingKeys.length === 1 && (input.entityTxs?.length ?? 0) === 0;
      assertRuntimeEntityIngress(
        mayRetargetEmptyProtocolInput,
        siblingKeys.length === 0
          ? 'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET'
          : 'RUNTIME_REPLICA_NOT_FOUND',
        'Entity input target replica missing from projected Runtime frame',
        { entityId, signerId, siblingKeys },
      );
    } catch (error) {
      throw new RuntimeEntityInputApplyError(
        input,
        false,
        error,
        'unroutable-ingress',
      );
    }
  }
};

export const findEntityReplicaKey = (
  env: RuntimeState,
  entityId: string,
  signerId?: string | null,
): string | null => {
  const entityNorm = String(entityId || '').toLowerCase();
  const signerNorm = signerId ? String(signerId).toLowerCase() : null;
  if (signerNorm) {
    const directKey = `${entityNorm}:${signerNorm}`;
    if (env.eReplicas.has(directKey)) return directKey;
  }
  for (const key of env.eReplicas.keys()) {
    const [repEntityId, repSignerId] = String(key).split(':');
    if (!repEntityId || repEntityId.toLowerCase() !== entityNorm) continue;
    if (!signerNorm || repSignerId?.toLowerCase() === signerNorm) return key;
  }
  return null;
};

const findEntityReplicaKeys = (
  env: RuntimeState,
  entityId: string,
): string[] => {
  const entityNorm = String(entityId || '').toLowerCase();
  return Array.from(env.eReplicas.keys()).filter(key => {
    const [repEntityId] = String(key).split(':');
    return Boolean(repEntityId && repEntityId.toLowerCase() === entityNorm);
  });
};

export const resolveEntityInputReplica = (
  env: RuntimeState,
  entityInput: RoutedEntityInput,
): { signerId: string; replicaKey: string; replica: EntityReplica } => {
  const entityId = entityInput.entityId.trim().toLowerCase();
  const signerId = entityInput.signerId.trim().toLowerCase();
  assertRuntimeEntityIngress(
    signerId.length > 0,
    'RUNTIME_SIGNER_MISSING',
    'Entity input missing mandatory signerId',
    { entityId: entityInput.entityId, providedSignerId: entityInput.signerId },
  );

  let replicaKey = `${entityId}:${signerId}`;
  let replica = env.eReplicas.get(replicaKey);
  const txTypes = (entityInput.entityTxs || []).map(tx => tx.type);
  const localReplicaKeys =
    replica || txTypes.length > 0
      ? []
      : findEntityReplicaKeys(env, entityId);
  if (!replica && txTypes.length > 0) {
    const details = { entityId, signerId: entityInput.signerId, txTypes };
    env.error(
      'network',
      'REJECT_ENTITY_INPUT_UNKNOWN_ENTITY',
      details,
      entityId,
    );
    assertRuntimeEntityIngress(
      false,
      'RUNTIME_REPLICA_NOT_FOUND',
      'Entity input target replica missing for exact canonical key',
      details,
    );
  }
  if (!replica && localReplicaKeys.length === 1 && txTypes.length === 0) {
    replicaKey = localReplicaKeys[0]!;
    replica = env.eReplicas.get(replicaKey);
    env.warn(
      'network',
      'ENTITY_INPUT_SIGNER_HINT_RETARGETED',
      {
        entityId: entityInput.entityId,
        inputSignerId: entityInput.signerId,
        resolvedReplicaKey: replicaKey,
        txTypes,
      },
      entityInput.entityId,
    );
  }
  if (!replica) {
    const details = {
      entityId: entityInput.entityId,
      resolvedSignerId: signerId,
      inputSignerId: entityInput.signerId,
      knownReplicas: localReplicaKeys,
    };
    env.error(
      'network',
      'REJECT_ENTITY_INPUT_REPLICA_NOT_FOUND',
      details,
      entityInput.entityId,
    );
    assertRuntimeEntityIngress(
      false,
      'RUNTIME_REPLICA_NOT_FOUND',
      'Entity input target replica missing for exact signerId',
      details,
    );
  }
  return { signerId, replicaKey, replica };
};
