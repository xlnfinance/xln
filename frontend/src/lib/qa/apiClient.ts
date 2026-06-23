export const QA_TOKEN_STORAGE_KEY = 'xln-qa-token';

type QaCachedResponse = {
  etag: string;
  body: string;
  headers: [string, string][];
};

const qaResponseCache = new Map<string, QaCachedResponse>();

const canUseSessionStorage = (): boolean =>
  typeof sessionStorage !== 'undefined';

export const readQaToken = (): string => {
  if (!canUseSessionStorage()) return '';
  return String(sessionStorage.getItem(QA_TOKEN_STORAGE_KEY) || '').trim();
};

export const writeQaToken = (token: string): void => {
  qaResponseCache.clear();
  if (!canUseSessionStorage()) return;
  const clean = token.trim();
  if (clean) sessionStorage.setItem(QA_TOKEN_STORAGE_KEY, clean);
  else sessionStorage.removeItem(QA_TOKEN_STORAGE_KEY);
};

export const clearQaToken = (): void => writeQaToken('');

export const consumeQaTokenFromUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const token = String(url.searchParams.get('qaToken') || url.searchParams.get('qa_token') || '').trim();
  if (!token) return readQaToken();
  writeQaToken(token);
  url.searchParams.delete('qaToken');
  url.searchParams.delete('qa_token');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return token;
};

export const qaHeaders = (headers?: HeadersInit): Headers => {
  const next = new Headers(headers);
  const token = readQaToken();
  if (token) next.set('authorization', `Bearer ${token}`);
  return next;
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const requestMethod = (input: RequestInfo | URL, init: RequestInit): string => {
  if (init.method) return String(init.method).toUpperCase();
  if (typeof input === 'object' && 'method' in input && input.method) return String(input.method).toUpperCase();
  return 'GET';
};

const isQaJsonCacheable = (url: string, method: string, init: RequestInit): boolean => {
  if (method !== 'GET' || init.body) return false;
  let path = url;
  try {
    path = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).pathname;
  } catch {
    path = url.split('?')[0] || url;
  }
  return path.startsWith('/api/qa/') && path !== '/api/qa/artifact' && path !== '/api/qa/story-image';
};

const cacheKeyFor = (url: string): string => `${readQaToken()}\n${url}`;

const responseFromCachedBody = (cached: QaCachedResponse, etag: string): Response => {
  const headers = new Headers(cached.headers);
  headers.set('etag', etag);
  headers.set('x-xln-qa-cache', 'hit');
  return new Response(cached.body, {
    status: 200,
    headers,
  });
};

const responseWithCachedBody = async (response: Response, cacheKey: string): Promise<Response> => {
  const etag = response.headers.get('etag');
  if (!response.ok || !etag) return response;
  const body = await response.text();
  qaResponseCache.set(cacheKey, {
    etag,
    body,
    headers: Array.from(response.headers.entries()),
  });
  const headers = new Headers(response.headers);
  headers.set('x-xln-qa-cache', 'miss');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const qaFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  const headers = qaHeaders(init.headers);
  const cacheable = isQaJsonCacheable(url, method, init);
  const cacheKey = cacheKeyFor(url);
  const cached = cacheable ? qaResponseCache.get(cacheKey) : undefined;
  if (cached) headers.set('if-none-match', cached.etag);

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (!cacheable) return response;
  if (response.status === 304 && cached) {
    return responseFromCachedBody(cached, response.headers.get('etag') || cached.etag);
  }
  return await responseWithCachedBody(response, cacheKey);
};

export const fetchQaBlobUrl = async (url: string): Promise<string> => {
  const response = await qaFetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`QA_ARTIFACT_HTTP_${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
};
