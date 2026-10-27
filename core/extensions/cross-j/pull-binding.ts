import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import { deriveCrossJurisdictionPullId } from './index';

/** Both Accounts must lock the same ladder under route-derived IDs. Otherwise
 * a source hub can collect one leg while supplying an unspendable target leg.
 * The ladder derives from routeHash, so hashing it back into routeHash is circular.
 */
export const crossJurisdictionPullBindingError = (route: CrossJurisdictionSwapRoute): string | null => {
  const { sourcePull, targetPull } = route;
  if (!sourcePull || !targetPull) return 'Cross-j opening pulls missing';
  for (const [leg, pull] of [['source', sourcePull], ['target', targetPull]] as const) {
    if (!/^0x[0-9a-f]{64}$/.test(pull.fullHash) || !/^0x[0-9a-f]{64}$/.test(pull.partialRoot)) {
      return 'Invalid pull hashladder commitment';
    }
    if (pull.pullId !== deriveCrossJurisdictionPullId(route, leg)) return 'Cross-j pull ID does not match route';
  }
  return sourcePull.fullHash === targetPull.fullHash && sourcePull.partialRoot === targetPull.partialRoot
    ? null : 'Cross-j pull ladders do not match';
};
