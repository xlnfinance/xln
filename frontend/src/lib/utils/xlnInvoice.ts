export type XlnInvoiceIntent = {
  targetEntityId: string;
  tokenId: number | null;
  amount: string;
  description: string;
  recipientUserId: string;
  jurisdictionId: string;
  noteLocked: boolean;
};

export type ParsedXlnInvoice = XlnInvoiceIntent & {
  source: 'entity-query' | 'wallet-url';
  raw: string;
  canonicalUri: string;
};

const CANONICAL_WALLET_ORIGIN = 'https://xln.finance';
const ALLOWED_WALLET_ORIGINS = new Set([CANONICAL_WALLET_ORIGIN]);

const isAllowedWalletOrigin = (url: URL): boolean => {
  if (ALLOWED_WALLET_ORIGINS.has(url.origin)) return true;
  return (
    url.protocol === 'https:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  );
};

const sanitizeText = (value: string | null | undefined, maxLen: number): string => {
  const source = String(value || '').trim();
  let text = '';
  let lastWasSpace = false;
  for (const char of source) {
    const isWhitespace = char === ' ' || char === '\n' || char === '\r' || char === '\t';
    if (isWhitespace) {
      if (!lastWasSpace) text += ' ';
      lastWasSpace = true;
      continue;
    }
    text += char;
    lastWasSpace = false;
  }
  return text ? text.slice(0, maxLen) : '';
};

const isHexChar = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 70)
    || (code >= 97 && code <= 102)
  );
};

const isEntityId = (value: string): boolean => {
  if (value.length !== 66 || !value.startsWith('0x')) return false;
  for (let index = 2; index < value.length; index += 1) {
    if (!isHexChar(value[index]!)) return false;
  }
  return true;
};

const isHttpUrl = (value: string): boolean => value.startsWith('http://') || value.startsWith('https://');

const extractPayHashPayload = (rawHash: string): string => {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  if (!hash) throw new Error('Wallet link does not contain payment details');
  if (!hash.toLowerCase().startsWith('pay/')) {
    throw new Error('Wallet link does not contain payment details');
  }
  const encoded = hash.slice(4).trim();
  if (!encoded) throw new Error('Wallet link does not contain payment details');
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error('Wallet link contains an invalid payment payload');
  }
};

const parseInvoiceParams = (params: URLSearchParams, source: ParsedXlnInvoice['source'], raw: string): ParsedXlnInvoice => {
  const targetEntityId = sanitizeText(params.get('target'), 120).toLowerCase();
  if (!isEntityId(targetEntityId)) {
    throw new Error('Invoice is missing a valid recipient entity id');
  }

  const tokenRaw = sanitizeText(params.get('token'), 12);
  const parsedToken = tokenRaw ? Number(tokenRaw) : null;
  const tokenId = Number.isFinite(parsedToken) && parsedToken && parsedToken > 0 ? Math.floor(parsedToken) : null;
  const amount = sanitizeText(params.get('amount'), 64);
  const description = sanitizeText(params.get('desc'), 200);
  const recipientUserId = sanitizeText(params.get('u'), 96);
  const jurisdictionId = sanitizeText(params.get('jId'), 64);
  const noteLocked = Boolean(recipientUserId);
  const canonicalUri = buildXlnInvoiceUri({
    targetEntityId,
    tokenId,
    amount,
    description,
    recipientUserId,
    jurisdictionId,
    noteLocked,
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
  };
};

export function buildXlnInvoiceUri(intent: Partial<XlnInvoiceIntent> & { targetEntityId: string }): string {
  const targetEntityId = sanitizeText(intent.targetEntityId, 120).toLowerCase();
  const params = new URLSearchParams();
  if (intent.tokenId && Number.isFinite(intent.tokenId) && intent.tokenId > 0) {
    params.set('token', String(Math.floor(intent.tokenId)));
  }
  const amount = sanitizeText(intent.amount, 64);
  if (amount) params.set('amount', amount);
  const description = sanitizeText(intent.description, 200);
  if (description) params.set('desc', description);
  const recipientUserId = sanitizeText(intent.recipientUserId, 96);
  if (recipientUserId) params.set('u', recipientUserId);
  const jurisdictionId = sanitizeText(intent.jurisdictionId, 64);
  if (jurisdictionId) params.set('jId', jurisdictionId);
  return params.size > 0 ? `${targetEntityId}?${params.toString()}` : targetEntityId;
}

export function buildWalletPayHref(intent: Partial<XlnInvoiceIntent> & { targetEntityId: string }): string {
  const url = new URL('/app', CANONICAL_WALLET_ORIGIN);
  url.hash = `pay/${encodeURIComponent(buildXlnInvoiceUri(intent))}`;
  return url.toString();
}

export function parseXlnInvoice(rawValue: string): ParsedXlnInvoice {
  const raw = String(rawValue || '').trim();
  if (!raw) throw new Error('Invoice is empty');

  if (raw.startsWith('0x')) {
    const [entityIdPart, queryPart = ''] = raw.split('?', 2);
    if (isEntityId(entityIdPart.trim())) {
      return parseInvoiceParams(
        new URLSearchParams(`target=${entityIdPart.trim()}${queryPart ? `&${queryPart}` : ''}`),
        'entity-query',
        raw,
      );
    }
  }

  if (isHttpUrl(raw)) {
    const url = new URL(raw);
    if (!isAllowedWalletOrigin(url)) {
      throw new Error('Unsupported invoice format');
    }
    const payload = extractPayHashPayload(url.hash);
    const parsed = parseXlnInvoice(payload);
    return {
      ...parsed,
      source: 'wallet-url',
      raw,
    };
  }

  throw new Error('Unsupported invoice format');
}
