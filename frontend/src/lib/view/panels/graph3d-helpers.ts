export type ReserveMapLike = Map<string | number, bigint> | Record<string, unknown> | undefined;
export type GraphDerivedAccountData = {
  delta: number;
  ownCreditLimit: number;
  peerCreditLimit: number;
  collateral: number;
};

export type GraphDualConnectionAccountInfo = {
  left: string;
  right: string;
  leftEntity: string;
  rightEntity: string;
};

export type GraphScenarioStep = {
  timestamp: number;
  title: string;
  description: string;
  actions: string[];
};

const BANK_NAMES: string[] = [];
const SP500_TICKERS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
  'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS',
  'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'TMO', 'MRK',
  'WMT', 'PG', 'KO', 'PEP', 'COST', 'HD', 'MCD', 'NKE',
  'XOM', 'CVX', 'BA', 'CAT', 'GE', 'MMM',
  'DIS', 'NFLX', 'CMCSA', 'T', 'VZ',
  'INTC', 'CSCO', 'ORCL', 'CRM', 'AMD'
];
const FED_NAMES = new Map([
  ['federal_reserve', 'Federal Reserve'],
  ['ecb', 'European Central Bank'],
  ['boc', 'Bank of China'],
  ['boj', 'Bank of Japan'],
  ['boe', 'Bank of England'],
  ['snb', 'Swiss National Bank'],
  ['rbi', 'Reserve Bank of India'],
  ['cbr', 'Central Bank of Russia'],
  ['bundesbank', 'Bundesbank']
]);
const FED_FLAGS = new Map([
  ['federal_reserve', ''],
  ['ecb', ''],
  ['boc', ''],
  ['boj', ''],
  ['boe', ''],
  ['snb', ''],
  ['rbi', ''],
  ['cbr', ''],
  ['bundesbank', '']
]);
const AHB_NAMES: Map<string, string> = new Map([
  ['2', 'Alice'],
  ['3', 'Hub'],
  ['4', 'Bob'],
]);

export function graphReserveValues(reserves: ReserveMapLike): bigint[] {
  if (!reserves) return [];
  if (reserves instanceof Map) return Array.from(reserves.values());
  if (typeof reserves === 'object') {
    return Object.values(reserves).map((value: unknown) => {
      if (typeof value === 'string') return BigInt(value.replace(/n$/, ''));
      return BigInt(value as bigint);
    });
  }
  return [];
}

export function graphTotalReserves(replica: { state?: { reserves?: ReserveMapLike } } | null | undefined): bigint {
  let total = 0n;
  for (const amount of graphReserveValues(replica?.state?.reserves)) {
    total += amount;
  }
  return total;
}

export function graphReserveValue(reserves: ReserveMapLike, key: string): bigint {
  if (!reserves) return 0n;
  if (reserves instanceof Map) {
    return reserves.get(key) || reserves.get(Number(key)) || 0n;
  }
  if (typeof reserves === 'object') {
    const value = reserves[key];
    if (value === undefined || value === null) return 0n;
    if (typeof value === 'string') return BigInt(value.replace(/n$/, ''));
    return BigInt(value as bigint);
  }
  return 0n;
}

export function formatGraphMempoolTxLabel(tx: any, blockHeight?: number): string {
  if (!tx) return 'batch';
  if (tx.type === 'batch' && tx.data?.batch) {
    const batch = tx.data.batch;
    const parts: string[] = [];
    const reserveToReserveCount = batch.reserveToReserve?.length || 0;
    if (reserveToReserveCount > 0) parts.push(`${reserveToReserveCount}R2R`);
    const reserveToCollateralCount = batch.reserveToCollateral?.length || 0;
    if (reserveToCollateralCount > 0) parts.push(`+${reserveToCollateralCount}R2C`);
    const settlements = batch.settlements || [];
    let withdrawals = 0;
    let deposits = 0;
    for (const settle of settlements) {
      for (const diff of settle.diffs || []) {
        if (diff.collateralDiff < 0) withdrawals++;
        if (diff.collateralDiff > 0) deposits++;
      }
    }
    if (withdrawals > 0) parts.push(`-${withdrawals}W`);
    if (deposits > 0) parts.push(`+${deposits}D`);
    const summary = parts.join(' ') || 'empty';
    const fromEntity = tx.entityId?.slice(-1) || '?';
    return `E${fromEntity}: ${summary}`;
  }
  const blockPrefix = blockHeight !== undefined ? `#${blockHeight} ` : '';
  const type = (tx.type || 'tx').toUpperCase();
  const from = tx.from?.slice(-1) || '?';
  const to = tx.to?.slice(-1) || '?';
  const amount = tx.amount ? `$${Number(tx.amount / (10n ** 18n) / 1_000_000n)}M` : '';
  return `${blockPrefix}${type}: ${from}→${to} ${amount}`.trim();
}

export function formatGraphFinancialAmount(amount: bigint, decimals: number = 18): string {
  if (amount === 0n) return '0';
  const isNegative = amount < 0n;
  const absoluteAmount = isNegative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const wholePart = absoluteAmount / divisor;
  const fractionalPart = absoluteAmount % divisor;
  if (fractionalPart === 0n) {
    return `${isNegative ? '-' : ''}${wholePart.toLocaleString()}`;
  }
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmed = fractionalStr.replace(/0+$/, '');
  const formatted = trimmed.slice(0, 4);
  return `${isNegative ? '-' : ''}${wholePart.toLocaleString()}.${formatted}`;
}

export function formatGraphReserveBadge(totalReserves: bigint): string {
  const reserveValue = Number(totalReserves) / 1e18;
  if (reserveValue >= 1000000) {
    const millions = reserveValue / 1000000;
    return ` $${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (reserveValue >= 1000) return ` $${(reserveValue / 1000).toFixed(0)}K`;
  if (reserveValue > 0) return ` $${reserveValue.toFixed(0)}`;
  return ' $0';
}

export function formatGraphEntityReserveBalances(input: {
  reserves: ReserveMapLike;
  selectedTokenId: number;
  getTokenSymbol: (tokenId: number) => string;
}): string {
  if (!input.reserves) return '  Reserves loading...';
  const entries = input.reserves instanceof Map
    ? Array.from(input.reserves.entries())
    : Object.entries(input.reserves).map(([tokenId, amount]) => [tokenId, typeof amount === 'string' ? BigInt(amount.replace(/n$/, '')) : BigInt(amount as bigint)] as const);
  if (entries.length === 0) return '  No token reserves';
  const balanceLines: string[] = [];
  for (const [tokenIdKey, amount] of entries) {
    const tokenId = Number(tokenIdKey);
    if (Number.isNaN(tokenId)) continue;
    const formattedAmount = (Number(amount) / 1000).toFixed(2);
    const marker = tokenId === input.selectedTokenId ? '▸ ' : '  ';
    balanceLines.push(`${marker}${input.getTokenSymbol(tokenId)}: ${formattedAmount}k`);
  }
  return balanceLines.join('\n') || '  No token reserves';
}

export function getGraphEntityFlag(signerId: string | null | undefined): string {
  const normalized = String(signerId || '').toLowerCase();
  for (const [key, flag] of FED_FLAGS) {
    if (normalized.includes(key)) return flag;
  }
  return '';
}

export function formatGraphEntityShortName(input: {
  entityId: string;
  runtimeShortId?: string | null | undefined;
  signerId?: string | null | undefined;
}): string {
  const shortId = input.runtimeShortId || '';
  if (shortId && AHB_NAMES.has(shortId)) {
    return `${AHB_NAMES.get(shortId)!} (${input.entityId})`;
  }
  const signerId = String(input.signerId || '');
  if (signerId) {
    for (const ticker of SP500_TICKERS) {
      if (signerId.includes(ticker)) return `${ticker} (${input.entityId})`;
    }
    const normalized = signerId.toLowerCase();
    for (const [key, name] of FED_NAMES) {
      if (normalized.includes(key)) return `${name} (${input.entityId})`;
    }
    const hash = input.entityId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const fallbackBank = BANK_NAMES.length > 0 ? BANK_NAMES[hash % BANK_NAMES.length] : 'Bank';
    return `${fallbackBank || 'Bank'} (${input.entityId})`;
  }
  return input.entityId;
}

export function formatGraphDualConnectionAccountInfo(input: {
  leftId: string;
  rightId: string;
  accountData: { deltas?: Map<number, unknown> } | null | undefined;
  selectedTokenId: number;
  getAccountTokenDelta: (accountData: unknown, tokenId: number) => unknown | null;
  deriveEntry: (tokenDelta: unknown, isLeft: boolean) => GraphDerivedAccountData;
  getEntityShortName: (entityId: string) => string;
}): GraphDualConnectionAccountInfo {
  const leftEntity = input.getEntityShortName(input.leftId);
  const rightEntity = input.getEntityShortName(input.rightId);
  if (!input.accountData) {
    return { left: 'No account', right: 'No account', leftEntity, rightEntity };
  }
  const deltas = input.accountData.deltas;
  const availableTokens = deltas instanceof Map
    ? Array.from(deltas.keys()).sort((a, b) => a - b)
    : [];
  if (availableTokens.length === 0) {
    return { left: 'No tokens', right: 'No tokens', leftEntity, rightEntity };
  }
  let tokenDelta = input.getAccountTokenDelta(input.accountData, input.selectedTokenId);
  let displayTokenId = input.selectedTokenId;
  if (!tokenDelta && availableTokens.length > 0) {
    displayTokenId = availableTokens[0]!;
    tokenDelta = input.getAccountTokenDelta(input.accountData, displayTokenId);
  }
  if (!tokenDelta) {
    throw new Error(`FINTECH-SAFETY: Token ${displayTokenId} not found despite being in availableTokens`);
  }
  const leftDerived = input.deriveEntry(tokenDelta, true);
  const rightDerived = input.deriveEntry(tokenDelta, false);
  const leftCollateral = formatGraphFinancialAmount(BigInt(Math.floor(leftDerived.collateral)));
  const leftNet = formatGraphFinancialAmount(BigInt(Math.floor(leftDerived.delta)));
  const leftPeerCredit = formatGraphFinancialAmount(BigInt(Math.floor(leftDerived.peerCreditLimit)));
  const leftOwnCredit = formatGraphFinancialAmount(BigInt(Math.floor(leftDerived.ownCreditLimit)));
  const rightCollateral = formatGraphFinancialAmount(BigInt(Math.floor(rightDerived.collateral)));
  const rightNet = formatGraphFinancialAmount(BigInt(Math.floor(rightDerived.delta)));
  const rightPeerCredit = formatGraphFinancialAmount(BigInt(Math.floor(rightDerived.peerCreditLimit)));
  const rightOwnCredit = formatGraphFinancialAmount(BigInt(Math.floor(rightDerived.ownCreditLimit)));
  return {
    left: `Their Credit: ${leftPeerCredit}\nCollateral: ${leftCollateral}\nOur Credit: ${leftOwnCredit}\nNet: ${leftNet}`,
    right: `Our Credit: ${rightOwnCredit}\nCollateral: ${rightCollateral}\nTheir Credit: ${rightPeerCredit}\nNet: ${rightNet}`,
    leftEntity,
    rightEntity,
  };
}

export function parseGraphScenarioSteps(text: string): GraphScenarioStep[] {
  const parsed: GraphScenarioStep[] = [];
  const sections = String(text || '').split('===').filter(section => section.trim());
  for (const section of sections) {
    const lines = section.trim().split('\n');
    let timestamp = 0;
    let title = '';
    let description = '';
    const actions: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('t=')) timestamp = Number.parseInt(trimmed.slice(2), 10);
      else if (trimmed.startsWith('title:')) title = trimmed.slice(6).trim();
      else if (trimmed.startsWith('description:')) description = trimmed.slice(12).trim();
      else if (trimmed && !trimmed.startsWith('#') && !trimmed.match(/^[A-Z]/)) {
        actions.push(trimmed);
      }
    }
    if (title) {
      parsed.push({ timestamp, title, description, actions });
    }
  }
  return parsed;
}
