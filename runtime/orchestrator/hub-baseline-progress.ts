import { safeStringify } from '../protocol/serialization';
import type { HubHealthPayload } from './orchestrator-types';

type HubBaselineObservation = Readonly<{
  name: string;
  health: HubHealthPayload | null;
}>;

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * Count runtime height through deterministic J-watcher/catalog catch-up. Once
 * P2P is connected, heartbeat frames are not proof that accounts/reserves
 * converge; only causal mesh state changes keep the deadline alive.
 */
export const buildHubBaselineProgressSignature = (
  observations: readonly HubBaselineObservation[],
): string => safeStringify(observations.map(({ name, health }) => ({
  name,
  startupComplete: health?.timings?.['p2p_connect']?.completedAt !== null &&
    health?.timings?.['p2p_connect']?.completedAt !== undefined,
  phase: !health
    ? 'health'
    : health.timings?.['p2p_connect']?.completedAt === null ||
        health.timings?.['p2p_connect']?.completedAt === undefined
      ? 'startup'
      : !health.mesh?.ready
        ? 'accounts'
        : !health.bootstrapReserves?.ok
          ? 'reserves'
          : 'ready',
  startupHeight: health?.timings?.['p2p_connect']?.completedAt === null ||
      health?.timings?.['p2p_connect']?.completedAt === undefined
    ? Number(health?.height ?? 0)
    : null,
  visibleHubNames: sorted(health?.gossip?.visibleHubNames ?? []),
  meshPairs: (health?.mesh?.pairs ?? []).map(pair => ({
    counterpartyId: pair.counterpartyId,
    hasAccount: pair.hasAccount,
    ready: pair.ready,
    grantedByMe: pair.grantedByMe,
    grantedByPeer: pair.grantedByPeer,
  })),
  bootstrap: {
    step: health?.bootstrapProgress?.step ?? null,
    lastProgressAtMs: health?.bootstrapProgress?.lastProgressAtMs ?? null,
  },
  reserves: {
    ok: health?.bootstrapReserves?.ok ?? false,
    targetMet: health?.bootstrapReserves?.targetMet ?? false,
    entities: (health?.bootstrapReserves?.entities ?? []).map(entity => ({
      entityId: entity.entityId,
      ready: entity.ready,
      targetMet: entity.targetMet,
      tokens: entity.tokens.map(token => ({
        tokenId: token.tokenId,
        current: token.current,
        ready: token.ready,
        targetMet: token.targetMet,
      })),
    })),
  },
})));
