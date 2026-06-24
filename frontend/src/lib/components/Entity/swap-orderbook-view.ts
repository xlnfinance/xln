export type SwapOrderbookLevelClickDetail = {
  side: 'bid' | 'ask';
  priceTicks: string;
  size: string;
  accountIds: string[];
  displayPrice?: string;
};

export type SwapOrderbookPairOption = {
  value: string;
  label: string;
  mode: 'same' | 'cross';
  pairId: string;
  baseTokenId: number;
  quoteTokenId: number;
  sourceTokenId: number;
  targetTokenId: number;
  routeValue: string;
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceJurisdictionRef: string;
  targetJurisdictionRef: string;
};
