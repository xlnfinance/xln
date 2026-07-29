import type { BookState, OrderbookExtState } from '../orderbook';
import { structuredCloneOrThrow } from '../protocol/structured-clone';
import { EntityCandidateMap } from './candidate-map';

const cloneBook = (book: BookState): BookState =>
  structuredCloneOrThrow(book, 'ENTITY_ORDERBOOK_BOOK_CLONE_FAILED');

const clonePairs = (pairs: string[]): string[] => [...pairs];

const cloneReferral = (
  referral: OrderbookExtState['referrals'] extends Map<string, infer Value>
    ? Value
    : never,
) => ({ ...referral });

export const createEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: new EntityCandidateMap(source.books, cloneBook, false),
  orderPairs: new EntityCandidateMap(source.orderPairs, clonePairs, false),
  referrals: new EntityCandidateMap(source.referrals, cloneReferral, false),
  hubProfile: structuredCloneOrThrow(
    source.hubProfile,
    'ENTITY_ORDERBOOK_PROFILE_CLONE_FAILED',
  ),
});

export const snapshotEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: source.books instanceof EntityCandidateMap
    ? source.books.snapshot()
    : source.books,
  orderPairs: source.orderPairs instanceof EntityCandidateMap
    ? source.orderPairs.snapshot()
    : source.orderPairs,
  referrals: source.referrals instanceof EntityCandidateMap
    ? source.referrals.snapshot()
    : source.referrals,
  hubProfile: source.hubProfile,
});

export const commitEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: source.books instanceof EntityCandidateMap
    ? source.books.commit()
    : source.books,
  orderPairs: source.orderPairs instanceof EntityCandidateMap
    ? source.orderPairs.commit()
    : source.orderPairs,
  referrals: source.referrals instanceof EntityCandidateMap
    ? source.referrals.commit()
    : source.referrals,
  hubProfile: source.hubProfile,
});
