import type { JAdapter } from '../../../jurisdiction/adapter/types';
import { assertJStackAddressMatch } from '../../../jurisdiction/adapter/operations/stack-binding';
import {
  getJurisdictionIdentityRef,
  isJurisdictionStackRef,
} from '../../../jurisdiction/machine/jurisdiction-runtime';
import { requireJurisdictionChainId } from '../../../jurisdiction/machine/jurisdiction-stack';
import { getActiveJAdapter, getEntityJAdapter } from '../../../runtime';
import { attachLiveJAdapter, getLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { normalizeJurisdictionDisplayName } from '../hub-visible-profiles';

const normalizeJurisdictionName = (value: unknown): string =>
  normalizeJurisdictionDisplayName(value).trim().toLowerCase();

const resolveJReplicaForJurisdictionName = (
  env: RuntimeReplica,
  jurisdictionName: string,
): { name: string; replica: JReplica } | null => {
  return resolveJReplicaForJurisdictionIdentity(env, { name: jurisdictionName });
};

const resolveJReplicaForJurisdictionIdentity = (
  env: RuntimeReplica,
  jurisdiction: unknown,
): { name: string; replica: JReplica } | null => {
  const explicitRef = isJurisdictionStackRef(jurisdiction) ? String(jurisdiction).trim().toLowerCase() : '';
  const targetRef = explicitRef || getJurisdictionIdentityRef(jurisdiction);
  const targetName = normalizeJurisdictionName(typeof jurisdiction === 'string'
    ? jurisdiction
    : (jurisdiction as { name?: unknown; jurisdictionName?: unknown } | null | undefined)?.name ||
      (jurisdiction as { jurisdictionName?: unknown } | null | undefined)?.jurisdictionName);
  if (!targetRef && !targetName) return null;
  for (const [name, replica] of env.state.jReplicas?.entries?.() || []) {
    const candidate = { ...replica, name: replica?.name || name };
    if (targetRef) {
      if (getJurisdictionIdentityRef(candidate) === targetRef) return { name, replica };
      continue;
    }
    if (targetName && normalizeJurisdictionName(candidate.name || name) === targetName) {
      return { name, replica };
    }
  }
  return null;
};

export const hasLiveJAdapterForJurisdiction = (env: RuntimeReplica, jurisdictionName: string): boolean =>
  Boolean(getLiveJAdapter(env, resolveJReplicaForJurisdictionName(env, jurisdictionName)?.name ?? ''));

const assertHubJAdapterBinding = (
  name: string,
  replica: JReplica,
  jadapter: JAdapter,
  rpcUrl: string,
): void => {
  const expectedRpc = replica.rpcs?.length === 1
    ? new URL(replica.rpcs[0]!).toString()
    : '';
  const actualRpc = new URL(rpcUrl).toString();
  const actualChainId = requireJurisdictionChainId(jadapter.chainId, 'HUB_JADAPTER_CHAIN_ID_INVALID');
  if (Number(replica.chainId) !== actualChainId || expectedRpc !== actualRpc) {
    throw new Error(
      `HUB_JADAPTER_IDENTITY_MISMATCH:${name}:` +
      `chain=${String(replica.chainId)}/${actualChainId}:rpc=${expectedRpc || 'missing'}/${actualRpc}`,
    );
  }
  const bindings = [
    ['account', replica.contracts?.account, jadapter.addresses.account],
    ['depository', replica.contracts?.depository, jadapter.addresses.depository],
    ['entity_provider', replica.contracts?.entityProvider, jadapter.addresses.entityProvider],
    ['delta_transformer', replica.contracts?.deltaTransformer, jadapter.addresses.deltaTransformer],
  ] as const;
  for (const [contract, expected, actual] of bindings) {
    assertJStackAddressMatch(`${name}:${contract}`, expected, actual);
  }
};

export const attachValidatedJurisdictionAdapter = (env: RuntimeReplica, jadapter: JAdapter, rpcUrl: string): void => {
  const activeName = env.activeJurisdiction || Array.from(env.state.jReplicas?.keys?.() || [])[0];
  if (!activeName) throw new Error('HUB_JURISDICTION_REPLICA_MISSING:active');
  const replica = env.state.jReplicas?.get(activeName);
  if (!replica) throw new Error(`HUB_JURISDICTION_REPLICA_MISSING:${activeName}`);
  assertHubJAdapterBinding(activeName, replica, jadapter, rpcUrl);
  attachLiveJAdapter(env, activeName, jadapter);
};

export const requireJAdapterForDebugReserve = (
  env: RuntimeReplica,
  entityId: string,
  jurisdictionRef: string,
): JAdapter => {
  const explicitJurisdiction = String(jurisdictionRef || '').trim();
  if (explicitJurisdiction) {
    if (!isJurisdictionStackRef(explicitJurisdiction)) {
      throw new Error(`DEBUG_RESERVE_JURISDICTION_REF_INVALID: entity=${entityId} jurisdiction=${explicitJurisdiction}`);
    }
    const resolved = resolveJReplicaForJurisdictionIdentity(env, explicitJurisdiction);
    const adapter = resolved ? getLiveJAdapter(env, resolved.name) : undefined;
    if (!adapter) {
      throw new Error(`DEBUG_RESERVE_JURISDICTION_UNAVAILABLE: entity=${entityId} jurisdiction=${explicitJurisdiction}`);
    }
    return adapter;
  }
  let entityAdapter: JAdapter | null = null;
  try {
    entityAdapter = getEntityJAdapter(env, entityId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('ENTITY_JURISDICTION_MISSING')) throw error;
  }
  if (entityAdapter) return entityAdapter;
  const activeAdapter = getActiveJAdapter(env);
  if (!activeAdapter) {
    throw new Error(`DEBUG_RESERVE_JADAPTER_MISSING: entity=${entityId}`);
  }
  return activeAdapter;
};
