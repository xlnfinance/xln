import type { CrossJurisdictionBookStatus, CrossJurisdictionSwapStatus } from '../../types/cross-jurisdiction';
import {
  CROSS_JURISDICTION_BOOK_STATUSES,
  CROSS_JURISDICTION_SWAP_STATUSES,
} from '../../types/hash-coverage/cross-j-nested';

const matchCatalog = <T extends string>(
  value: unknown,
  catalog: readonly T[],
  code: string,
): T => {
  for (const entry of catalog) {
    if (value === entry) return entry;
  }
  throw new Error(`${code}:${String(value)}`);
};

export const requireCrossJurisdictionSwapStatus = (
  value: unknown,
  code = 'CROSS_J_ROUTE_STATUS_INVALID',
): CrossJurisdictionSwapStatus => matchCatalog(value, CROSS_JURISDICTION_SWAP_STATUSES, code);

export const requireCrossJurisdictionBookStatus = (
  value: unknown,
  code = 'CROSS_J_BOOK_STATUS_INVALID',
): CrossJurisdictionBookStatus => matchCatalog(value, CROSS_JURISDICTION_BOOK_STATUSES, code);
