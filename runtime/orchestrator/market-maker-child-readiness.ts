export type MarketMakerChildReadinessInput = {
  runtimeHalted: boolean;
  startupPhase: string;
  gossipReady: boolean;
  marketMakerReady: boolean;
};

export type MarketMakerChildReadiness = {
  live: boolean;
  ready: boolean;
};

export const deriveMarketMakerChildReadiness = (
  input: MarketMakerChildReadinessInput,
): MarketMakerChildReadiness => {
  const live = !input.runtimeHalted;
  return {
    live,
    ready: live
      && input.startupPhase === 'offers-ready'
      && input.gossipReady
      && input.marketMakerReady,
  };
};
