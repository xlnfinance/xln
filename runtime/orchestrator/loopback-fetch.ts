type LoopbackFetchInit = RequestInit & {
  tls?: {
    rejectUnauthorized?: boolean;
  };
};

const isLoopbackHttps = (input: string | URL | Request): boolean => {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
};

/** Disable certificate verification only for this one loopback request. */
export const fetchLoopback = (
  input: string | URL | Request,
  init: LoopbackFetchInit = {},
): Promise<Response> => fetch(input, isLoopbackHttps(input)
  ? {
      ...init,
      tls: {
        ...init.tls,
        rejectUnauthorized: false,
      },
    }
  : init);
