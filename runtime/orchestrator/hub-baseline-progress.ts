import { compareStableText, safeStringify } from '../protocol/serialization';
import {
  evaluateBootstrapProgressDeadline,
  type BootstrapProgressDeadlineEvaluation,
} from './bootstrap-progress-deadline';
import type { HubHealthPayload } from './orchestrator-types';

type HubBaselineObservation = Readonly<{
  name: string;
  health: HubHealthPayload | null;
}>;

const sorted = (values: readonly string[]): string[] => [...values].sort();

const buildCausalPeerMirrors = (
  owner: HubBaselineObservation,
  observations: readonly HubBaselineObservation[],
): unknown[] => {
  const ownerEntityId = String(owner.health?.entityId || '').trim().toLowerCase();
  if (!ownerEntityId) return [];
  return observations
    .filter(peer => peer.name !== owner.name)
    .flatMap(peer => (peer.health?.mesh?.pairs ?? [])
      .filter(pair => pair.counterpartyId.toLowerCase() === ownerEntityId)
      .map(pair => ({
        peer: peer.name,
        hasAccount: pair.hasAccount,
        currentHeight: pair.currentHeight,
        pendingFrameHeight: pair.pendingFrameHeight,
        pendingFrameHash: pair.pendingFrameHash,
        ready: pair.ready,
        grantedByMe: pair.grantedByMe,
        grantedByPeer: pair.grantedByPeer,
      })))
    .sort((left, right) => compareStableText(left.peer, right.peer));
};

export type HubBaselineProgressState = Readonly<Record<string, Readonly<{
  signature: string;
  lastProgressAt: number;
}>>>;

export type HubBaselineDeadlineResult = Readonly<{
  state: HubBaselineProgressState;
  evaluations: Readonly<Record<string, BootstrapProgressDeadlineEvaluation>>;
  stalledNames: readonly string[];
}>;

/**
 * Count runtime height through deterministic J-watcher/catalog catch-up. Once
 * the P2P stack starts and the runtime loop begins, heartbeat frames are not
 * proof that accounts/reserves converge; only causal mesh state changes keep
 * the deadline alive. The timing marker is a local lifecycle boundary, not a
 * claim that remote peers have already been discovered.
 */
export const buildHubBaselineProgressSignature = (
  observations: readonly HubBaselineObservation[],
): string => safeStringify([...observations]
  .sort((left, right) => compareStableText(left.name, right.name))
  .map(({ name, health }) => ({
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
    meshPairs: (health?.mesh?.pairs ?? [])
      .map(pair => ({
        counterpartyId: pair.counterpartyId,
        hasAccount: pair.hasAccount,
        currentHeight: pair.currentHeight,
        pendingFrameHeight: pair.pendingFrameHeight,
        pendingFrameHash: pair.pendingFrameHash,
        ready: pair.ready,
        grantedByMe: pair.grantedByMe,
        grantedByPeer: pair.grantedByPeer,
      }))
      .sort((left, right) => compareStableText(left.counterpartyId, right.counterpartyId)),
    reserves: {
      ok: health?.bootstrapReserves?.ok ?? false,
      targetMet: health?.bootstrapReserves?.targetMet ?? false,
      tokens: (health?.bootstrapReserves?.tokens ?? [])
        .map(token => ({
          tokenId: token.tokenId,
          current: token.current,
          ready: token.ready,
          targetMet: token.targetMet,
        }))
        .sort((left, right) => left.tokenId - right.tokenId),
      entities: (health?.bootstrapReserves?.entities ?? [])
        .map(entity => ({
          entityId: entity.entityId,
          ready: entity.ready,
          targetMet: entity.targetMet,
          tokens: entity.tokens
            .map(token => ({
              tokenId: token.tokenId,
              current: token.current,
              ready: token.ready,
              targetMet: token.targetMet,
            }))
            .sort((left, right) => left.tokenId - right.tokenId),
        }))
        .sort((left, right) => compareStableText(left.entityId, right.entityId)),
    },
  })));

export const evaluateHubBaselineDeadlines = (
  observations: readonly HubBaselineObservation[],
  previous: HubBaselineProgressState,
  now: number,
  timeoutMs: number,
): HubBaselineDeadlineResult => {
  const state: Record<string, { signature: string; lastProgressAt: number }> = {};
  const evaluations: Record<string, BootstrapProgressDeadlineEvaluation> = {};
  const stalledNames: string[] = [];
  for (const observation of [...observations]
    .sort((left, right) => compareStableText(left.name, right.name))) {
    const prior = previous[observation.name] ?? { signature: '', lastProgressAt: now };
    // Bilateral account setup is causal for both endpoints. A hub may have
    // durably sent its proposal and wait while the peer commits the mirror
    // side; count only that exact peer view, never unrelated peer activity.
    const causalSignature = safeStringify({
      local: buildHubBaselineProgressSignature([observation]),
      peerMirrors: buildCausalPeerMirrors(observation, observations),
    });
    const evaluation = evaluateBootstrapProgressDeadline(
      prior,
      causalSignature,
      now,
      timeoutMs,
    );
    state[observation.name] = {
      signature: evaluation.signature,
      lastProgressAt: evaluation.lastProgressAt,
    };
    evaluations[observation.name] = evaluation;
    const complete = observation.health?.mesh?.ready === true &&
      observation.health.bootstrapReserves?.ok === true;
    if (!complete && evaluation.stalled) stalledNames.push(observation.name);
  }
  return { state, evaluations, stalledNames };
};
