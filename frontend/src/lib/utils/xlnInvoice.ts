import { appendPaymentTimestamp, parsePaymentTiming } from './paymentTiming';

export type XlnInvoiceIntent = {
  targetEntityId: string;
  tokenId: number | null;
  amount: string;
  description: string;
  recipientUserId: string;
  jurisdictionId: string;
  noteLocked: boolean;
  startedAtMs?: number;
};

export type ParsedXlnInvoice = XlnInvoiceIntent & {
  source: 'xln' | 'wallet-url';
  raw: string;
  canonicalUri: string;
};

const sanitizeText = (value: string | null | undefined, maxLen: number): string => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLen) : '';
};

const parseBoolean = (value: string | null | undefined): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const normalizeHashParams = (rawHash: string): URLSearchParams => {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const qIndex = hash.indexOf('?');
  if (qIndex >= 0) {
    const routePart = hash.slice(0, qIndex).trim().toLowerCase();
    if (routePart === 'pay') {
      return new URLSearchParams(hash.slice(qIndex + 1));
    }
  }
  return new URLSearchParams(hash);
};

const parseInvoiceParams = (params: URLSearchParams, source: ParsedXlnInvoice['source'], raw: string): ParsedXlnInvoice => {
  const targetEntityId = sanitizeText(params.get('id') || params.get('target') || params.get('entity'), 120).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/i.test(targetEntityId)) {
    throw new Error('Invoice is missing a valid recipient entity id');
  }

  const tokenRaw = sanitizeText(params.get('token') || params.get('tokenId'), 12);
  const parsedToken = tokenRaw ? Number(tokenRaw) : null;
  const tokenId = Number.isFinite(parsedToken) && parsedToken && parsedToken > 0 ? Math.floor(parsedToken) : null;
  const amount = sanitizeText(params.get('amt') || params.get('amount'), 64);
  const descriptionMeta = parsePaymentTiming(sanitizeText(params.get('desc') || params.get('description') || params.get('memo'), 200));
  const description = descriptionMeta.displayDescription;
  const recipientUserId = sanitizeText(params.get('u') || params.get('uid') || params.get('recipient_user_id'), 96);
  const jurisdictionId = sanitizeText(params.get('jId') || params.get('jurisdiction') || params.get('j'), 64);
  const tsRaw = sanitizeText(params.get('ts') || params.get('startedAtMs') || params.get('started_at_ms'), 20);
  const parsedTs = tsRaw ? Number(tsRaw) : descriptionMeta.startedAtMs;
  const startedAtMs = Number.isFinite(parsedTs) ? parsedTs : undefined;
  const noteLocked = parseBoolean(params.get('locked') || params.get('note_locked') || params.get('description_locked')) || Boolean(recipientUserId);
  const canonicalUri = buildXlnInvoiceUri({
    targetEntityId,
    tokenId,
    amount,
    description,
    recipientUserId,
    jurisdictionId,
    noteLocked,
    startedAtMs,
  });

  return {
    source,
    raw,
    canonicalUri,
    targetEntityId,
    tokenId,
    amount,
    description,
    recipientUserId,
    jurisdictionId,
    noteLocked,
    startedAtMs,
  };
};

export function buildXlnInvoiceUri(intent: Partial<XlnInvoiceIntent> & { targetEntityId: string }): string {
  const params = new URLSearchParams();
  params.set('id', sanitizeText(intent.targetEntityId, 120).toLowerCase());
  if (intent.tokenId && Number.isFinite(intent.tokenId) && intent.tokenId > 0) {
    params.set('token', String(Math.floor(intent.tokenId)));
  }
  const amount = sanitizeText(intent.amount, 64);
  if (amount) params.set('amt', amount);
  const startedAtMs = Number.isFinite(intent.startedAtMs) ? Number(intent.startedAtMs) : Date.now();
  const description = appendPaymentTimestamp(sanitizeText(intent.description, 200), startedAtMs);
  if (description) params.set('desc', description);
  params.set('ts', String(startedAtMs));
  const recipientUserId = sanitizeText(intent.recipientUserId, 96);
  if (recipientUserId) params.set('u', recipientUserId);
  const jurisdictionId = sanitizeText(intent.jurisdictionId, 64);
  if (jurisdictionId) params.set('jId', jurisdictionId);
  if (intent.noteLocked || recipientUserId) {
    params.set('locked', '1');
  }
  return `xln:?${params.toString()}`;
}

export function buildWalletPayHref(baseUrl: string | URL, intent: Partial<XlnInvoiceIntent> & { targetEntityId: string }): string {
  const url = new URL('/app', baseUrl);
  const params = new URLSearchParams();
  params.set('id', sanitizeText(intent.targetEntityId, 120).toLowerCase());
  if (intent.tokenId && Number.isFinite(intent.tokenId) && intent.tokenId > 0) {
    params.set('token', String(Math.floor(intent.tokenId)));
  }
  const amount = sanitizeText(intent.amount, 64);
  if (amount) params.set('amt', amount);
  const startedAtMs = Number.isFinite(intent.startedAtMs) ? Number(intent.startedAtMs) : Date.now();
  const description = appendPaymentTimestamp(sanitizeText(intent.description, 200), startedAtMs);
  if (description) params.set('desc', description);
  params.set('ts', String(startedAtMs));
  const recipientUserId = sanitizeText(intent.recipientUserId, 96);
  if (recipientUserId) params.set('u', recipientUserId);
  const jurisdictionId = sanitizeText(intent.jurisdictionId, 64);
  if (jurisdictionId) params.set('jId', jurisdictionId);
  if (intent.noteLocked || recipientUserId) {
    params.set('locked', '1');
  }
  url.hash = `pay?${params.toString()}`;
  return url.toString();
}

export function parseXlnInvoice(rawValue: string): ParsedXlnInvoice {
  const raw = String(rawValue || '').trim();
  if (!raw) throw new Error('Invoice is empty');

  if (raw.toLowerCase().startsWith('xln:')) {
    const body = raw.slice(4);
    if (/^0x[0-9a-f]{64}$/i.test(body.trim())) {
      return parseInvoiceParams(new URLSearchParams(`id=${body.trim()}`), 'xln', raw);
    }
    const query = body.startsWith('?') ? body.slice(1) : body;
    return parseInvoiceParams(new URLSearchParams(query), 'xln', raw);
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const params = normalizeHashParams(url.hash);
    if (!params.has('id') && !params.has('target') && !params.has('entity')) {
      throw new Error('Wallet link does not contain payment details');
    }
    return parseInvoiceParams(params, 'wallet-url', raw);
  }

  throw new Error('Unsupported invoice format');
}
