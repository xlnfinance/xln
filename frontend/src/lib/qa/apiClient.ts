export const QA_TOKEN_STORAGE_KEY = 'xln-qa-token';

const canUseSessionStorage = (): boolean =>
  typeof sessionStorage !== 'undefined';

export const readQaToken = (): string => {
  if (!canUseSessionStorage()) return '';
  return String(sessionStorage.getItem(QA_TOKEN_STORAGE_KEY) || '').trim();
};

export const writeQaToken = (token: string): void => {
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

export const qaFetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
  fetch(input, {
    ...init,
    headers: qaHeaders(init.headers),
  });

export const fetchQaBlobUrl = async (url: string): Promise<string> => {
  const response = await qaFetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`QA_ARTIFACT_HTTP_${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
};
