import {
  resolveCrossJurisdictionRuntimeTopology,
  type CrossJurisdictionRuntimeTopology,
} from '../extensions/cross-j/boundary';
import { normalizeRuntimeId } from '../network/p2p/runtime-id';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import { hasLocalSignerForEntitySigner } from './loop-identity';
import type { RuntimeReplica } from './types';

type OwnerRole = 'user' | 'hub';
type Owner = Readonly<{ entityId: string; signerId: string }>;

export type CrossJTopologyDeps = {
  hasLocalSignerForEntitySigner(
    env: RuntimeReplica,
    entityId: string,
    signerId: string,
  ): boolean;
  resolveRuntimeId(entityId: string, signerId: string): string | null;
};

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

const ownerPair = (route: CrossJurisdictionSwapRoute, role: OwnerRole): readonly [Owner, Owner] => {
  const pair: readonly [Owner, Owner] = role === 'user'
    ? [
        { entityId: route.source.entityId, signerId: route.sourceSignerId || '' },
        { entityId: route.target.counterpartyEntityId, signerId: route.targetSignerId || '' },
      ]
    : [
        { entityId: route.source.counterpartyEntityId, signerId: route.sourceHubSignerId || '' },
        { entityId: route.target.entityId, signerId: route.targetHubSignerId || '' },
      ];
  if (pair.some(owner => !normalize(owner.entityId) || !normalize(owner.signerId))) {
    throw new Error(`CROSS_J_RUNTIME_TOPOLOGY_INVALID:${route.orderId}:${role.toUpperCase()}_OWNER_MISSING`);
  }
  if (normalize(pair[0].entityId) === normalize(pair[1].entityId)) {
    throw new Error(`CROSS_J_RUNTIME_TOPOLOGY_INVALID:${route.orderId}:${role.toUpperCase()}_SIBLINGS_NOT_DISTINCT`);
  }
  return pair;
};

const defaultLocalOwnerDeps = { hasLocalSignerForEntitySigner };

export const assertCrossJLocalOwnerCohort = (
  env: RuntimeReplica,
  route: CrossJurisdictionSwapRoute,
  role: OwnerRole,
  deps: Pick<CrossJTopologyDeps, 'hasLocalSignerForEntitySigner'>,
): void => {
  for (const [index, owner] of ownerPair(route, role).entries()) {
    if (!deps.hasLocalSignerForEntitySigner(env, owner.entityId, owner.signerId)) {
      throw new Error(
        `CROSS_J_RUNTIME_TOPOLOGY_INVALID:${route.orderId}:` +
        `${role.toUpperCase()}_SIBLING_${index}_NOT_LOCAL`,
      );
    }
  }
};

export const assertInboundCrossJRuntimeTopology = (
  env: RuntimeReplica,
  route: CrossJurisdictionSwapRoute,
  authenticatedUserRuntimeId: string,
  deps: CrossJTopologyDeps,
): void => {
  assertCrossJLocalOwnerCohort(env, route, 'hub', deps);
  const topology = requireCrossJRuntimeTopology(route, deps.resolveRuntimeId);
  const localRuntimeId = normalizeRuntimeId(env.runtimeId);
  const userRuntimeId = normalizeRuntimeId(authenticatedUserRuntimeId);
  if (topology.hubRuntimeId !== localRuntimeId || topology.userRuntimeId !== userRuntimeId) {
    throw new Error(`CROSS_J_RUNTIME_TOPOLOGY_INVALID:${route.orderId}:OWNER_RUNTIME_MISMATCH`);
  }
};

export const requireCrossJRuntimeTopology = (
  route: CrossJurisdictionSwapRoute,
  resolveRuntimeId: CrossJTopologyDeps['resolveRuntimeId'],
): CrossJurisdictionRuntimeTopology => {
  const topology = resolveCrossJurisdictionRuntimeTopology(route, resolveRuntimeId);
  if (!topology) {
    throw new Error(`CROSS_J_RUNTIME_TOPOLOGY_INVALID:${route.orderId}:OWNER_RUNTIME_MISMATCH`);
  }
  return topology;
};

export const assertCrossJLocalCohorts = (
  env: RuntimeReplica,
  deps: Pick<CrossJTopologyDeps, 'hasLocalSignerForEntitySigner'> = defaultLocalOwnerDeps,
): void => {
  for (const replica of env.state.eReplicas.values()) {
    if (!deps.hasLocalSignerForEntitySigner(env, replica.entityId, replica.signerId)) continue;
    for (const route of replica.state.crossJurisdictionSwaps?.values() ?? []) {
      for (const role of ['user', 'hub'] as const) {
        const pair = ownerPair(route, role);
        const local = pair.map(owner =>
          deps.hasLocalSignerForEntitySigner(env, owner.entityId, owner.signerId));
        if (!local.some(Boolean)) continue;
        if (!local.every(Boolean)) {
          throw new Error(`CROSS_J_LOCAL_SIBLING_MISSING:${route.orderId}:${role}`);
        }
        if (ownerPair(route, role === 'user' ? 'hub' : 'user').some(owner =>
          deps.hasLocalSignerForEntitySigner(env, owner.entityId, owner.signerId))) {
          throw new Error(`CROSS_J_OWNER_RUNTIME_COLLISION:${route.orderId}`);
        }
      }
    }
  }
};
