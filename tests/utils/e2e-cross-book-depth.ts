export type ExpectedCrossBookDepth = Readonly<{
  expectedOffers: number;
  expectedBidOffers: number;
  expectedAskOffers: number;
}>;

type CrossBookPairDepth = Readonly<{
  pairId: string;
  expectedOffers?: number;
  expectedBidOffers?: number;
  expectedAskOffers?: number;
}>;

const canonicalCrossPair = (value: string): string => {
  const legs = value.replace(/^cross:/, '').split('/');
  if (legs.length !== 2 || legs.some(leg => !leg)) throw new Error(`CROSS_PAIR_ID_INVALID:${value}`);
  return legs.sort().join('/');
};

export function aggregateExpectedCrossBookDepth(pairs: CrossBookPairDepth[], pairId: string): ExpectedCrossBookDepth {
  const identity = canonicalCrossPair(pairId);
  const reciprocalPairs = pairs.filter(pair => canonicalCrossPair(pair.pairId) === identity);
  if (reciprocalPairs.length === 0) throw new Error(`CROSS_PAIR_HEALTH_MISSING:${pairId}`);
  return reciprocalPairs.reduce(
    (sum, pair) => ({
      expectedOffers: sum.expectedOffers + Number(pair.expectedOffers ?? 0),
      expectedBidOffers: sum.expectedBidOffers + Number(pair.expectedBidOffers ?? 0),
      expectedAskOffers: sum.expectedAskOffers + Number(pair.expectedAskOffers ?? 0),
    }),
    { expectedOffers: 0, expectedBidOffers: 0, expectedAskOffers: 0 },
  );
}
