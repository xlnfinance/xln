import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import { getKnownTokenIds } from '../../../../account/utils';
import { withCanonicalCrossJurisdictionRouteHash } from '../../../../extensions/cross-j';
import {
  FailureDispositionError,
  rejectFailure,
} from '../../../../protocol/errors/failure-taxonomy';

/**
 * Registration and book admission price both legs through the static token
 * catalog. An unknown id from a peer route is that peer's input: reject it
 * before anything is stored, never wedge the hub on every replay.
 */
export const assertCrossJurisdictionRouteTokensKnown = (route: CrossJurisdictionSwapRoute): void => {
  const knownTokenIds = getKnownTokenIds();
  for (const tokenId of [route.source.tokenId, route.target.tokenId]) {
    if (!knownTokenIds.includes(Number(tokenId))) {
      throw rejectFailure(
        'CROSS_J_TOKEN_METADATA_UNAVAILABLE',
        `CROSS_J_TOKEN_METADATA_UNAVAILABLE:${route.orderId}:${String(tokenId)}`,
      );
    }
  }
};

/**
 * Canonicalize a route a sibling Entity sent. A hash or risk-policy mismatch
 * there is the sender's input (typed reject of its runtimeOutput); the same
 * check on a route this Entity stored stays a halt at its own call sites.
 */
export const canonicalPeerCrossJurisdictionRoute = (
  route: CrossJurisdictionSwapRoute,
  code: string,
): CrossJurisdictionSwapRoute => {
  try {
    return withCanonicalCrossJurisdictionRouteHash(route);
  } catch (error) {
    if (error instanceof FailureDispositionError) {
      throw rejectFailure(code, `${code}:${route.orderId}:${error.code}`);
    }
    throw error;
  }
};
