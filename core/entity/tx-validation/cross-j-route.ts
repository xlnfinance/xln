/** Entity-transaction gate for the canonical cross-j route decoder. */

import { requireBoundaryRecord } from '../../protocol/boundary/boundary-primitives';
import { assertCrossJurisdictionSwapRoute } from '../../extensions/cross-j/route-shape';

const REQUIRED_ROUTE_TX_TYPES = new Set([
  'registerCrossJurisdictionSwap', 'prepareCrossJurisdictionSwap',
  'admitCrossJurisdictionBookOrder', 'crossJurisdictionBookOrderRemoved',
]);
const OPTIONAL_ROUTE_TX_TYPES = new Set([
  'requestCrossJurisdictionClear', 'removeCrossJurisdictionBookOrder',
]);

export const validateCrossJurisdictionRouteEntityTx = (
  type: string,
  data: unknown,
  code: string,
): void => {
  if (!REQUIRED_ROUTE_TX_TYPES.has(type) && !OPTIONAL_ROUTE_TX_TYPES.has(type)) return;
  const record = requireBoundaryRecord(data, code);
  if (record['route'] === undefined) {
    if (REQUIRED_ROUTE_TX_TYPES.has(type)) throw new Error(`${code}_ROUTE_REQUIRED`);
    return;
  }
  assertCrossJurisdictionSwapRoute(record['route'], `${code}_ROUTE`);
};
