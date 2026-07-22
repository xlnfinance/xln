import { generateLazyEntityId } from '../entity/factory';
import type { ConsensusConfig, Env, JReplica, RuntimeInput } from '../types';

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

const requireAddress = (value: unknown, code: string): string => {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error(code);
  return address;
};

export const buildLocalRuntimeOwner = (input: {
  signerId: string;
  profileName: string;
  jurisdictionName: string;
  jurisdiction: JReplica;
}): {
  entityId: string;
  signerId: string;
  profileName: string;
  config: ConsensusConfig;
} => {
  const signerId = requireAddress(input.signerId, 'LOCAL_RUNTIME_OWNER_SIGNER_INVALID').toLowerCase();
  const profileName = String(input.profileName || '').trim();
  if (!profileName) throw new Error('LOCAL_RUNTIME_OWNER_PROFILE_NAME_REQUIRED');
  const jurisdictionName = String(input.jurisdiction.name || input.jurisdictionName || '').trim();
  if (!jurisdictionName) throw new Error('LOCAL_RUNTIME_OWNER_JURISDICTION_NAME_REQUIRED');
  const chainId = Number(input.jurisdiction.chainId ?? input.jurisdiction.jadapter?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('LOCAL_RUNTIME_OWNER_CHAIN_ID_INVALID');
  }
  const blockTimeMs = Number(input.jurisdiction.blockTimeMs ?? input.jurisdiction.blockDelayMs);
  if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) {
    throw new Error('LOCAL_RUNTIME_OWNER_BLOCK_TIME_INVALID');
  }
  const depositoryAddress = requireAddress(
    input.jurisdiction.depositoryAddress ?? input.jurisdiction.contracts?.depository,
    'LOCAL_RUNTIME_OWNER_DEPOSITORY_INVALID',
  );
  const entityProviderAddress = requireAddress(
    input.jurisdiction.entityProviderAddress ?? input.jurisdiction.contracts?.entityProvider,
    'LOCAL_RUNTIME_OWNER_ENTITY_PROVIDER_INVALID',
  );
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction: {
      address: String(input.jurisdiction.rpcs?.[0] || `jreplica://${jurisdictionName}`),
      name: jurisdictionName,
      chainId,
      blockTimeMs,
      depositoryAddress,
      entityProviderAddress,
      ...(input.jurisdiction.entityProviderDeploymentBlock === undefined
        ? {}
        : { entityProviderDeploymentBlock: input.jurisdiction.entityProviderDeploymentBlock }),
    },
  };
  return {
    entityId: generateLazyEntityId([signerId], 1n),
    signerId,
    profileName,
    config,
  };
};

const hasLocalOwnerReplica = (env: Env, entityId: string, signerId: string): boolean => {
  const targetEntityId = normalize(entityId);
  const targetSignerId = normalize(signerId);
  return Array.from(env.eReplicas.values()).some((replica) => (
    normalize(replica.entityId || replica.state.entityId) === targetEntityId
    && normalize(replica.signerId) === targetSignerId
  ));
};

export const ensureLocalRuntimeOwner = async (
  env: Env,
  owner: ReturnType<typeof buildLocalRuntimeOwner>,
  deps: {
    enqueue: (env: Env, input: RuntimeInput) => void;
    onFrameCommit: (env: Env, callback: (height: number) => void) => () => void;
    timeoutMs?: number;
  },
): Promise<{ entityId: string; created: boolean; height: number }> => {
  if (hasLocalOwnerReplica(env, owner.entityId, owner.signerId)) {
    return { entityId: owner.entityId, created: false, height: env.height };
  }
  const expectedHeight = env.height + 1;
  const timeoutMs = Math.max(1_000, Math.floor(Number(deps.timeoutMs ?? 30_000)));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = deps.onFrameCommit(env, (height) => {
      if (height < expectedHeight) return;
      if (!hasLocalOwnerReplica(env, owner.entityId, owner.signerId)) {
        finish(new Error('LOCAL_RUNTIME_OWNER_COMMIT_MISSING_REPLICA'));
        return;
      }
      finish();
    });
    const timeout = setTimeout(
      () => finish(new Error(`LOCAL_RUNTIME_OWNER_COMMIT_TIMEOUT:${timeoutMs}`)),
      timeoutMs,
    );
    deps.enqueue(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: owner.entityId,
        signerId: owner.signerId,
        data: {
          isProposer: true,
          config: owner.config,
          profileName: owner.profileName,
        },
      }],
      entityInputs: [],
    });
  });
  return { entityId: owner.entityId, created: true, height: env.height };
};
