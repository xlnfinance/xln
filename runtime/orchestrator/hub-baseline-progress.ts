import { safeStringify } from '../protocol/serialization';
import type { HubHealthPayload } from './orchestrator-types';

type HubBaselineObservation = Readonly<{
  name: string;
  health: HubHealthPayload | null;
}>;

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * Only count runtime height while gossip is still forming. Once every profile
 * is visible, heartbeat frames are not proof that accounts/reserves converge.
 */
export const buildHubBaselineProgressSignature = (
  observations: readonly HubBaselineObservation[],
): string => safeStringify(observations.map(({ name, health }) => ({
  name,
  phase: !health
    ? 'health'
    : !health.gossip?.ready
      ? 'gossip'
      : !health.mesh?.ready
        ? 'accounts'
        : !health.bootstrapReserves?.ok
          ? 'reserves'
          : 'ready',
  startupHeight: health?.gossip?.ready ? null : Number(health?.height ?? 0),
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
