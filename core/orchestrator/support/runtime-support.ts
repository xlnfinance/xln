import { execFileSync } from 'node:child_process';
import { resolveRequestClientIp } from '../../api/server/network/relay-direct';
import { canonicalizeRuntimeWsAudience } from '../../network/p2p/ws-protocol';
import type { RelayStore } from '../../network/relay/store';
import { resolveConfiguredRelayAudience } from '../mesh/relay-audience';
import { deriveManagedEntityIdentity } from '../daemon-control';
import { resolveOrchestratorSocketType, type HubChild, type HubHealthPayload, type OrchestratorWebSocket } from '../orchestrator-types';

export const readOrchestratorCodeFingerprint = (): {
  gitHead: string;
  gitBranch: string;
  dirty: boolean;
  codeHash: string | null;
  computedAt: number;
} => {
  const readGitValue = (gitArgs: string[]): string => {
    try {
      return execFileSync('git', gitArgs, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      throw new Error(
        `ORCHESTRATOR_GIT_FINGERPRINT_FAILED:command=${gitArgs.join(' ')}:` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const gitHead = readGitValue(['rev-parse', 'HEAD']);
  const gitBranch = readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = readGitValue(['status', '--porcelain']).length > 0;
  return {
    gitHead,
    gitBranch,
    dirty,
    codeHash: gitHead ? `${gitHead}${dirty ? '-dirty' : ''}` : null,
    computedAt: Date.now(),
  };
};

export const resolveOrchestratorRelayUpgradeData = (
  request: Request,
  url: URL,
  peerAddress: string | null,
  configuredAudiences: ReadonlySet<string>,
): OrchestratorWebSocket['data'] | null => {
  const type = resolveOrchestratorSocketType(url.searchParams.get('protocol'));
  const audience = type === 'relay'
    ? resolveConfiguredRelayAudience({
      requestUrl: request.url,
      origin: request.headers.get('origin'),
      configuredAudiences,
    })
    : canonicalizeRuntimeWsAudience(request.url);
  if (!audience) return null;
  return { type, audience, clientIp: resolveRequestClientIp(request, peerAddress) };
};

export type NativeH1ReserveTarget = Readonly<{
  tokenId: number;
  symbol: string;
  decimals: number;
  expectedMin: bigint;
}>;

export type NativeH1MeshPair = Readonly<{
  counterpartyId: string;
  counterpartyName: string;
  hasAccount: boolean;
  currentHeight: number;
  pendingFrameHeight: number | null;
  pendingFrameHash: null;
  grantedByMe: string;
  grantedByPeer: string;
  ready: boolean;
}>;

export const projectNativeH1ReserveHealth = (
  health: HubHealthPayload,
  hubChildren: readonly HubChild[],
  relayStore: Pick<RelayStore, 'gossipProfiles'>,
  reserveTargets: readonly NativeH1ReserveTarget[],
  meshPairs: ReadonlyMap<string, NativeH1MeshPair>,
  requiredTokenCount: number,
): HubHealthPayload => {
  const expectedHubs = hubChildren.map(child => ({
    name: child.name,
    entityId: deriveManagedEntityIdentity({
      name: child.name,
      seed: child.seed,
      signerLabel: child.signerLabel,
    }).entityId,
  }));
  const visibleHubs = expectedHubs.filter(hub => relayStore.gossipProfiles.has(hub.entityId));
  const pairs = hubChildren.slice(1).map(child => {
    const id = deriveManagedEntityIdentity({
      name: child.name,
      seed: child.seed,
      signerLabel: child.signerLabel,
    }).entityId;
    return meshPairs.get(id) ?? {
      counterpartyId: id,
      counterpartyName: child.name,
      hasAccount: false,
      currentHeight: 0,
      pendingFrameHeight: null,
      pendingFrameHash: null,
      grantedByMe: '0',
      grantedByPeer: '0',
      ready: false,
    };
  });
  const common = {
    ...health,
    gossip: {
      ready: visibleHubs.length === expectedHubs.length,
      visibleHubNames: visibleHubs.map(hub => hub.name),
      visibleHubIds: visibleHubs.map(hub => hub.entityId),
    },
    mesh: {
      ready: pairs.length === Math.max(0, hubChildren.length - 1) && pairs.every(pair => pair.ready),
      pairs,
    },
  };
  if (reserveTargets.length === 0) return common;
  const currentByToken = new Map(
    (health.bootstrapReserves?.tokens ?? []).map(token => {
      const tokenId = Number(token.tokenId);
      const current = String(token.current || '');
      if (!Number.isSafeInteger(tokenId) || tokenId < 1 || !/^\d+$/.test(current)) {
        throw new Error(`RUST_HUB_RESERVE_PROJECTION_INVALID:${String(token.tokenId)}:${current}`);
      }
      return [tokenId, BigInt(current)] as const;
    }),
  );
  const tokens = reserveTargets.map(target => {
    const current = currentByToken.get(target.tokenId) ?? 0n;
    return {
      tokenId: target.tokenId,
      symbol: target.symbol,
      decimals: target.decimals,
      current: current.toString(),
      expectedMin: target.expectedMin.toString(),
      ready: current > 0n,
      operational: current > 0n,
      targetMet: current >= target.expectedMin,
    };
  });
  return {
    ...common,
    bootstrapReserves: {
      ok: tokens.length >= requiredTokenCount && tokens.every(token => token.operational),
      targetMet: tokens.length >= requiredTokenCount && tokens.every(token => token.targetMet),
      tokens,
    },
  };
};
