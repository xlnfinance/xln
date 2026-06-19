import type { FrameLogEntry, RuntimeInput } from './types';

export type ActivityKind = 'onchain' | 'offchain';
export type ActivityType =
  | 'payment'
  | 'swap'
  | 'cross_swap'
  | 'htlc'
  | 'settlement'
  | 'account'
  | 'j_event'
  | 'j_batch'
  | 'system'
  | 'error';
export type ActivityDirection = 'in' | 'out' | 'neutral';
export type ActivitySource = 'runtime_input' | 'runtime_log' | 'j_input';

export type RuntimeActivityFilters = {
  entityId?: string | undefined;
  kind?: ActivityKind | 'all' | undefined;
  types?: string[] | undefined;
  query?: string | undefined;
  fromTimestamp?: number | undefined;
  toTimestamp?: number | undefined;
};

export type RuntimeActivityEvent = {
  id: string;
  runtimeId?: string | undefined;
  height: number;
  timestamp: number;
  kind: ActivityKind;
  type: ActivityType;
  source: ActivitySource;
  direction: ActivityDirection;
  title: string;
  subtitle: string;
  status: string;
  entityId?: string | undefined;
  counterpartyId?: string | undefined;
  tokenId?: number | undefined;
  amount?: string | undefined;
  quoteTokenId?: number | undefined;
  quoteAmount?: string | undefined;
  orderId?: string | undefined;
  hash?: string | undefined;
  rawType: string;
};

export type PersistedActivityJournal = {
  height: number;
  timestamp: number;
  runtimeInput?: RuntimeInput;
  logs?: FrameLogEntry[];
};

type RawRecord = Record<string, unknown>;

const ENTITY_ID_RE = /^0x[0-9a-f]{64}$/;

const normalizeId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const shortId = (value: unknown): string => {
  const normalized = normalizeId(value);
  return normalized.length >= 10 ? `${normalized.slice(0, 6)}...${normalized.slice(-4)}` : 'unknown';
};

const bigintText = (value: unknown): string | undefined => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const record = value as RawRecord;
    if (record['__xlnType'] === 'BigInt' && typeof record['value'] === 'string') return record['value'];
  }
  return undefined;
};

const numberValue = (value: unknown): number | undefined => {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const recordValue = (value: unknown): RawRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {};

const stringIncludesEntity = (value: unknown, entityId: string): boolean =>
  typeof value === 'string' && value.toLowerCase() === entityId;

const payloadMentionsEntity = (value: unknown, entityId: string, depth = 0): boolean => {
  if (!entityId || depth > 8 || value === null || value === undefined) return false;
  if (stringIncludesEntity(value, entityId)) return true;
  if (Array.isArray(value)) return value.some((item) => payloadMentionsEntity(item, entityId, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.values(value as RawRecord).some((item) => payloadMentionsEntity(item, entityId, depth + 1));
};

const routeCounterparty = (route: unknown, entityId: string, fallback: unknown): string | undefined => {
  if (Array.isArray(route)) {
    const normalizedRoute = route.map(normalizeId).filter(Boolean);
    const index = normalizedRoute.indexOf(entityId);
    if (index >= 0) return normalizedRoute[index + 1] ?? normalizedRoute[index - 1] ?? normalizeId(fallback) ?? undefined;
  }
  const normalizedFallback = normalizeId(fallback);
  return normalizedFallback || undefined;
};

const inferDirection = (sourceEntityId: string, targetEntityId: string, viewedEntityId: string): ActivityDirection => {
  if (!viewedEntityId) return 'neutral';
  if (sourceEntityId === viewedEntityId && targetEntityId !== viewedEntityId) return 'out';
  if (targetEntityId === viewedEntityId && sourceEntityId !== viewedEntityId) return 'in';
  return 'neutral';
};

const normalizeKind = (eventName: string, category?: string): ActivityKind => {
  const key = `${eventName} ${category ?? ''}`.toLowerCase();
  if (key.includes('jevent') || key.includes('j_event') || key.includes('jbatch') || key.includes('settled') || key.includes('evm')) {
    return 'onchain';
  }
  return 'offchain';
};

const normalizeType = (eventName: string): ActivityType => {
  const key = eventName.toLowerCase();
  if (key.includes('cross') && key.includes('swap')) return 'cross_swap';
  if (key.includes('swap')) return 'swap';
  if (key.includes('payment')) return 'payment';
  if (key.includes('htlc')) return 'htlc';
  if (key.includes('settle')) return 'settlement';
  if (key.includes('account')) return 'account';
  if (key.includes('jbatch') || key.includes('j_batch')) return 'j_batch';
  if (key.includes('jevent') || key.includes('j_event')) return 'j_event';
  if (key.includes('error') || key.includes('failed')) return 'error';
  return 'system';
};

const eventMatchesFilters = (event: RuntimeActivityEvent, filters: RuntimeActivityFilters): boolean => {
  const entityId = normalizeId(filters.entityId);
  if (entityId && ENTITY_ID_RE.test(entityId)) {
    const directlyMatches =
      normalizeId(event.entityId) === entityId ||
      normalizeId(event.counterpartyId) === entityId;
    if (!directlyMatches) return false;
  }
  if (filters.kind && filters.kind !== 'all' && event.kind !== filters.kind) return false;
  const types = (filters.types ?? []).map((item) => item.trim()).filter(Boolean);
  if (types.length > 0) {
    const rawType = event.rawType.toLowerCase();
    const matchesType =
      types.includes(event.type) ||
      types.includes(event.rawType) ||
      types.some((type) => type.toLowerCase() === 'htlc' && rawType.includes('htlc'));
    if (!matchesType) return false;
  }
  if (Number.isFinite(filters.fromTimestamp) && event.timestamp < Number(filters.fromTimestamp)) return false;
  if (Number.isFinite(filters.toTimestamp) && event.timestamp > Number(filters.toTimestamp)) return false;
  const query = String(filters.query || '').trim().toLowerCase();
  if (query) {
    const haystack = [
      event.title,
      event.subtitle,
      event.status,
      event.entityId,
      event.counterpartyId,
      event.amount,
      event.orderId,
      event.hash,
      event.rawType,
    ].join(' ').toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
};

export const runtimeActivityDedupeKey = (event: RuntimeActivityEvent): string => {
  const rawType = String(event.rawType || '');
  if (event.source === 'runtime_log' && rawType.startsWith('Htlc') && event.hash) {
    return [
      event.runtimeId ?? '',
      event.source,
      rawType,
      event.entityId ?? '',
      event.counterpartyId ?? '',
      event.direction,
      event.hash,
      event.amount ?? '',
      event.tokenId ?? '',
    ].join('|');
  }
  return event.id;
};

export const dedupeRuntimeActivityEvents = (input: RuntimeActivityEvent[]): RuntimeActivityEvent[] => {
  const byKey = new Map<string, RuntimeActivityEvent>();
  for (const event of input) {
    const key = runtimeActivityDedupeKey(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }

    const eventHappenedEarlier =
      event.timestamp < existing.timestamp ||
      (event.timestamp === existing.timestamp && event.height < existing.height);
    if (eventHappenedEarlier) byKey.set(key, event);
  }

  return Array.from(byKey.values()).sort((left, right) =>
    right.timestamp - left.timestamp ||
    right.height - left.height ||
    right.id.localeCompare(left.id)
  );
};

const makeEvent = (
  journal: PersistedActivityJournal,
  index: number,
  event: Omit<RuntimeActivityEvent, 'id' | 'height' | 'timestamp'>,
): RuntimeActivityEvent => ({
  id: `r${journal.height}:${event.source}:${index}:${event.rawType}`,
  height: journal.height,
  timestamp: journal.timestamp,
  ...event,
});

const eventFromDirectPayment = (
  journal: PersistedActivityJournal,
  index: number,
  inputEntityId: string,
  data: RawRecord,
  viewedEntityId: string,
): RuntimeActivityEvent => {
  const targetEntityId = normalizeId(data['targetEntityId']);
  const counterpartyId = routeCounterparty(data['route'], viewedEntityId, targetEntityId);
  const direction = inferDirection(inputEntityId, targetEntityId, viewedEntityId);
  const title = direction === 'in' ? 'Payment received' : direction === 'out' ? 'Payment sent' : 'Payment routed';
  return makeEvent(journal, index, {
    kind: 'offchain',
    type: 'payment',
    source: 'runtime_input',
    direction,
    title,
    subtitle: `${bigintText(data['amount']) ?? '0'} token ${numberValue(data['tokenId']) ?? '?'} ${direction === 'in' ? `from ${shortId(inputEntityId)}` : `to ${shortId(targetEntityId)}`}`,
    status: 'queued',
    entityId: viewedEntityId || inputEntityId,
    ...(counterpartyId ? { counterpartyId } : {}),
    tokenId: numberValue(data['tokenId']),
    amount: bigintText(data['amount']),
    rawType: 'directPayment',
  });
};

const eventFromSwap = (
  journal: PersistedActivityJournal,
  index: number,
  inputEntityId: string,
  txType: string,
  data: RawRecord,
  viewedEntityId: string,
): RuntimeActivityEvent => {
  const cross = Boolean(data['crossJurisdiction'] || data['route']);
  const orderId = String(data['offerId'] || recordValue(data['route'])['orderId'] || '').trim();
  const counterpartyId = normalizeId(data['counterpartyEntityId']);
  const action =
    txType === 'placeSwapOffer'
      ? 'placed'
      : txType === 'resolveSwap'
        ? Number(data['fillRatio'] ?? 0) > 0
          ? 'filled'
          : 'closed'
        : 'cancel requested';
  return makeEvent(journal, index, {
    kind: 'offchain',
    type: cross ? 'cross_swap' : 'swap',
    source: 'runtime_input',
    direction: viewedEntityId && viewedEntityId === inputEntityId ? 'out' : 'neutral',
    title: `${cross ? 'Cross-j swap' : 'Swap'} ${action}`,
    subtitle: txType === 'placeSwapOffer'
      ? `${bigintText(data['giveAmount']) ?? '?'} token ${numberValue(data['giveTokenId']) ?? '?'} for ${bigintText(data['wantAmount']) ?? '?'} token ${numberValue(data['wantTokenId']) ?? '?'}`
      : `Order ${orderId ? orderId.slice(0, 10) : 'unknown'} ${action}`,
    status: action,
    entityId: viewedEntityId || inputEntityId,
    ...(counterpartyId ? { counterpartyId } : {}),
    tokenId: numberValue(data['giveTokenId']),
    amount: bigintText(data['giveAmount']),
    quoteTokenId: numberValue(data['wantTokenId']),
    quoteAmount: bigintText(data['wantAmount']),
    ...(orderId ? { orderId } : {}),
    rawType: txType,
  });
};

const eventFromCrossJurisdiction = (
  journal: PersistedActivityJournal,
  index: number,
  inputEntityId: string,
  txType: string,
  data: RawRecord,
  viewedEntityId: string,
): RuntimeActivityEvent => {
  const route = recordValue(data['route']);
  const orderId = String(route['orderId'] || data['orderId'] || '').trim();
  const source = recordValue(route['source']);
  const target = recordValue(route['target']);
  const status = String(route['status'] || txType.replace(/CrossJurisdictionSwap$/, '') || 'updated');
  const sourceEntityId = normalizeId(source['entityId']);
  const targetEntityId = normalizeId(target['entityId']);
  const direction = inferDirection(sourceEntityId || inputEntityId, targetEntityId, viewedEntityId);
  return makeEvent(journal, index, {
    kind: 'offchain',
    type: 'cross_swap',
    source: 'runtime_input',
    direction,
    title: `Cross-j swap ${status}`,
    subtitle: `Order ${orderId ? orderId.slice(0, 10) : 'unknown'} moved through ${txType}`,
    status,
    entityId: viewedEntityId || inputEntityId,
    counterpartyId: direction === 'out' ? targetEntityId : sourceEntityId || undefined,
    tokenId: numberValue(source['tokenId']),
    amount: bigintText(source['amount']),
    quoteTokenId: numberValue(target['tokenId']),
    quoteAmount: bigintText(target['amount']),
    ...(orderId ? { orderId } : {}),
    rawType: txType,
  });
};

const eventFromEntityTx = (
  journal: PersistedActivityJournal,
  index: number,
  inputEntityId: string,
  tx: RawRecord,
  viewedEntityId: string,
): RuntimeActivityEvent | null => {
  const txType = String(tx['type'] || 'unknown');
  const data = recordValue(tx['data']);
  if (viewedEntityId && normalizeId(inputEntityId) !== viewedEntityId && !payloadMentionsEntity(tx, viewedEntityId)) {
    return null;
  }
  switch (txType) {
    case 'directPayment':
      return eventFromDirectPayment(journal, index, normalizeId(inputEntityId), data, viewedEntityId);
    case 'htlcPayment':
    case 'hashlockPayment': {
      const targetEntityId = normalizeId(data['targetEntityId']);
      const direction = inferDirection(normalizeId(inputEntityId), targetEntityId, viewedEntityId);
      return makeEvent(journal, index, {
        kind: 'offchain',
        type: 'payment',
        source: 'runtime_input',
        direction,
        title: direction === 'in' ? 'Payment incoming' : 'Payment started',
        subtitle: `${bigintText(data['amount']) ?? '0'} token ${numberValue(data['tokenId']) ?? '?'} ${direction === 'in' ? `from ${shortId(inputEntityId)}` : `to ${shortId(targetEntityId)}`}`,
        status: 'started',
        entityId: viewedEntityId || normalizeId(inputEntityId),
        counterpartyId: direction === 'in' ? normalizeId(inputEntityId) : targetEntityId,
        tokenId: numberValue(data['tokenId']),
        amount: bigintText(data['amount']),
        rawType: txType,
      });
    }
    case 'placeSwapOffer':
    case 'resolveSwap':
    case 'cancelSwap':
    case 'cancelSwapOffer':
    case 'proposeCancelSwap':
      return eventFromSwap(journal, index, normalizeId(inputEntityId), txType, data, viewedEntityId);
    case 'requestCrossJurisdictionSwap':
    case 'prepareCrossJurisdictionSwap':
    case 'commitCrossJurisdictionSwap':
    case 'registerCrossJurisdictionSwap':
    case 'crossJurisdictionFillNotice':
      return eventFromCrossJurisdiction(journal, index, normalizeId(inputEntityId), txType, data, viewedEntityId);
    case 'openAccount': {
      const counterpartyId = normalizeId(data['targetEntityId']);
      return makeEvent(journal, index, {
        kind: 'offchain',
        type: 'account',
        source: 'runtime_input',
        direction: 'neutral',
        title: 'Account opened',
        subtitle: `Bilateral account with ${shortId(counterpartyId)}`,
        status: 'created',
        entityId: viewedEntityId || normalizeId(inputEntityId),
        counterpartyId,
        rawType: txType,
      });
    }
    case 'j_event':
    case 'j_event_account_claim':
      return makeEvent(journal, index, {
        kind: 'onchain',
        type: 'j_event',
        source: 'runtime_input',
        direction: 'neutral',
        title: 'On-chain event observed',
        subtitle: String(data['type'] || data['eventName'] || txType),
        status: 'observed',
        entityId: viewedEntityId || normalizeId(inputEntityId),
        rawType: txType,
      });
    case 'settle_propose':
    case 'settle_update':
    case 'settle_approve':
    case 'settle_execute':
    case 'settle_reject':
    case 'settleDiffs':
    case 'createSettlement': {
      const counterpartyId = normalizeId(data['counterpartyEntityId']);
      return makeEvent(journal, index, {
        kind: 'offchain',
        type: 'settlement',
        source: 'runtime_input',
        direction: 'neutral',
        title: `Settlement ${txType.replace(/^settle_/, '')}`,
        subtitle: `Account ${shortId(counterpartyId)}`,
        status: txType,
        entityId: viewedEntityId || normalizeId(inputEntityId),
        counterpartyId,
        rawType: txType,
      });
    }
    default:
      return makeEvent(journal, index, {
        kind: normalizeKind(txType),
        type: normalizeType(txType),
        source: 'runtime_input',
        direction: 'neutral',
        title: txType,
        subtitle: `Runtime transaction committed in frame ${journal.height}`,
        status: 'committed',
        entityId: viewedEntityId || normalizeId(inputEntityId),
        rawType: txType,
      });
  }
};

const eventFromLog = (
  journal: PersistedActivityJournal,
  index: number,
  log: FrameLogEntry,
  viewedEntityId: string,
): RuntimeActivityEvent | null => {
  if (viewedEntityId && normalizeId(log.entityId) !== viewedEntityId && !payloadMentionsEntity(log.data, viewedEntityId)) {
    return null;
  }
  const message = String(log.message || 'Runtime event');
  const data = recordValue(log.data);
  const sourceEntityId = normalizeId(data['fromEntity'] ?? data['entityId'] ?? log.entityId);
  const targetEntityId = normalizeId(data['toEntity'] ?? data['targetEntityId']);
  const direction = inferDirection(sourceEntityId, targetEntityId, viewedEntityId);
  const type: ActivityType = message === 'HtlcReceived' || message === 'HtlcFinalized' || message === 'HtlcFailed'
    ? 'payment'
    : normalizeType(message);
  const kind = normalizeKind(message, log.category);
  const title =
    message === 'HtlcReceived'
      ? 'Payment received'
      : message === 'HtlcFinalized'
        ? 'Payment finalized'
        : message === 'HtlcFailed'
          ? 'Payment failed'
          : message === 'JBatchQueued'
            ? 'J-batch queued'
            : message === 'JEventReceived'
              ? 'On-chain event received'
              : message;
  const status =
    message === 'HtlcReceived'
      ? 'received'
      : message === 'HtlcFinalized'
        ? 'finalized'
        : message === 'HtlcFailed'
          ? 'failed'
          : log.level === 'error'
            ? 'error'
            : log.level === 'warn'
              ? 'warning'
              : 'recorded';
  return makeEvent(journal, index, {
    kind,
    type,
    source: 'runtime_log',
    direction,
    title,
    subtitle: `${log.category}/${log.level}${data['amount'] !== undefined ? `, ${bigintText(data['amount'])} token ${numberValue(data['tokenId']) ?? '?'}` : ''}`,
    status,
    entityId: viewedEntityId || sourceEntityId || normalizeId(log.entityId),
    counterpartyId: direction === 'in' ? sourceEntityId : targetEntityId || undefined,
    tokenId: numberValue(data['tokenId']),
    amount: bigintText(data['amount']),
    orderId: typeof data['orderId'] === 'string' ? data['orderId'] : undefined,
    hash: typeof data['hashlock'] === 'string' ? data['hashlock'] : undefined,
    rawType: message,
  });
};

export const buildRuntimeActivityEvents = (
  journal: PersistedActivityJournal,
  filters: RuntimeActivityFilters = {},
): RuntimeActivityEvent[] => {
  const viewedEntityId = normalizeId(filters.entityId);
  const events: RuntimeActivityEvent[] = [];
  let index = 0;
  const input = journal.runtimeInput;
  for (const entityInput of input?.entityInputs ?? []) {
    const inputEntityId = normalizeId(entityInput?.entityId);
    for (const tx of entityInput?.entityTxs ?? []) {
      const event = eventFromEntityTx(journal, index++, inputEntityId, tx as RawRecord, viewedEntityId);
      if (event && eventMatchesFilters(event, filters)) events.push(event);
    }
  }
  for (const jInput of input?.jInputs ?? []) {
    if (viewedEntityId && !payloadMentionsEntity(jInput, viewedEntityId)) continue;
    const event = makeEvent(journal, index++, {
      kind: 'onchain',
      type: 'j_batch',
      source: 'j_input',
      direction: 'neutral',
      title: 'J transaction batch queued',
      subtitle: `${jInput.jurisdictionName}: ${jInput.jTxs.length} txs`,
      status: 'queued',
      entityId: viewedEntityId || undefined,
      rawType: 'jInput',
    });
    if (eventMatchesFilters(event, filters)) events.push(event);
  }
  for (const log of journal.logs ?? []) {
    const event = eventFromLog(journal, index++, log, viewedEntityId);
    if (event && eventMatchesFilters(event, filters)) events.push(event);
  }
  return events.sort((left, right) => right.timestamp - left.timestamp || right.height - left.height || right.id.localeCompare(left.id));
};
