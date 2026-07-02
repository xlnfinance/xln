import type { MarketMakerCrossHealthPayload, MarketMakerHealthPayload } from './orchestrator-types';

type WrappedMarketMakerHealth = NonNullable<MarketMakerHealthPayload['marketMaker']>;

export type RawMarketMakerHealthPayload = {
  ok?: boolean;
  name?: string;
  height?: number;
  entityId?: string | null;
  runtimeId?: string | null;
  relayUrl?: string;
  apiUrl?: string;
  directWsUrl?: string;
  startupPhase?: string;
  p2p?: MarketMakerHealthPayload['p2p'];
  gossip?: MarketMakerHealthPayload['gossip'];
  enabled?: boolean;
  expectedOffersPerHub?: number;
  expectedOffersPerPair?: number;
  cross?: MarketMakerCrossHealthPayload;
  hubs?: WrappedMarketMakerHealth['hubs'];
  bootstrap?: MarketMakerHealthPayload['bootstrap'];
};

const isRawMarketMakerHealth = (
  payload: MarketMakerHealthPayload | RawMarketMakerHealthPayload,
): payload is RawMarketMakerHealthPayload =>
  !('marketMaker' in payload && payload.marketMaker) &&
  Array.isArray((payload as RawMarketMakerHealthPayload).hubs) &&
  Boolean((payload as RawMarketMakerHealthPayload).cross);

export const normalizeMarketMakerHealthPayload = (
  payload: MarketMakerHealthPayload | RawMarketMakerHealthPayload | null | undefined,
): MarketMakerHealthPayload | null => {
  if (!payload) return null;
  if (!isRawMarketMakerHealth(payload)) return payload as MarketMakerHealthPayload;
  const cross = payload.cross;
  if (!cross) return payload as MarketMakerHealthPayload;

  const wrapped: MarketMakerHealthPayload = {
    marketMaker: {
      enabled: payload.enabled === true,
      ok: payload.ok === true,
      entityId: payload.entityId ?? null,
      expectedOffersPerHub: Math.max(0, Math.floor(Number(payload.expectedOffersPerHub || 0))),
      expectedOffersPerPair: Math.max(0, Math.floor(Number(payload.expectedOffersPerPair || 0))),
      cross,
      hubs: payload.hubs ?? [],
    },
  };
  if (payload.ok !== undefined) wrapped.ok = payload.ok;
  if (payload.name !== undefined) wrapped.name = payload.name;
  if (payload.height !== undefined) wrapped.height = payload.height;
  if (payload.entityId !== undefined) wrapped.entityId = payload.entityId;
  if (payload.runtimeId !== undefined) wrapped.runtimeId = payload.runtimeId;
  if (payload.relayUrl !== undefined) wrapped.relayUrl = payload.relayUrl;
  if (payload.apiUrl !== undefined) wrapped.apiUrl = payload.apiUrl;
  if (payload.directWsUrl !== undefined) wrapped.directWsUrl = payload.directWsUrl;
  if (payload.startupPhase !== undefined) wrapped.startupPhase = payload.startupPhase;
  if (payload.p2p !== undefined) wrapped.p2p = payload.p2p;
  if (payload.gossip !== undefined) wrapped.gossip = payload.gossip;
  if (payload.bootstrap !== undefined) wrapped.bootstrap = payload.bootstrap;
  return wrapped;
};
