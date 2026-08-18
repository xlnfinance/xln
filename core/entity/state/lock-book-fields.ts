import type { LockBookEntry } from '../types';
import type { AssertNever, FieldGap } from '../../types/hash-coverage/coverage';

export const HASHABLE_LOCK_BOOK_ENTRY_FIELDS = [
  'lockId',
  'accountId',
  'tokenId',
  'amount',
  'hashlock',
  'timelock',
  'direction',
  'createdAt',
] as const satisfies readonly (keyof LockBookEntry)[];

export type LockBookFieldCoverage = AssertNever<
  FieldGap<LockBookEntry, typeof HASHABLE_LOCK_BOOK_ENTRY_FIELDS>
>;
