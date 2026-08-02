import { isLoopbackCustodyPeer } from './session-admission';

export type CustodyMutationRejection = {
  status: 403 | 415;
  code: 'CUSTODY_ORIGIN_FORBIDDEN' | 'CUSTODY_FETCH_SITE_FORBIDDEN' | 'CUSTODY_JSON_REQUIRED';
};

const externalRequestOrigin = (request: Request, directAddress: string): string => {
  const url = new URL(request.url);
  const forwardedProto = isLoopbackCustodyPeer(directAddress)
    ? request.headers.get('x-forwarded-proto')?.trim().toLowerCase()
    : undefined;
  return forwardedProto === 'http' || forwardedProto === 'https'
    ? `${forwardedProto}://${url.host}`
    : url.origin;
};

export const rejectUnsafeCustodyMutation = (
  request: Request,
  directAddress = '',
): CustodyMutationRejection | null => {
  if (request.headers.get('origin') !== externalRequestOrigin(request, directAddress)) {
    return { status: 403, code: 'CUSTODY_ORIGIN_FORBIDDEN' };
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return { status: 403, code: 'CUSTODY_FETCH_SITE_FORBIDDEN' };
  }
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return { status: 415, code: 'CUSTODY_JSON_REQUIRED' };
  }
  return null;
};
