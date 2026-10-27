import { RuntimeAdapterError } from '../errors';
import { normalizeEntityId } from '../../../storage/keys';
import { compactAccountDocForView } from './compact-view';
import { envHeight, findReplica, readAtHeight, type RuntimeAdapterResolveContext } from './context';
import type { RuntimeAdapterReadQuery } from '../types';

/** One committed-read lease binds policy, account and loan evidence together.
 * This is an inspection projection; underwriting remains an external service. */
export function readLendingEvidence(
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  query?: RuntimeAdapterReadQuery,
) {
  if (readAtHeight(query) !== null)
    throw new RuntimeAdapterError('E_BAD_QUERY', 'lending evidence is a current committed read');
  const borrower = normalizeEntityId(query?.accountId ?? '');
  if (!borrower) throw new RuntimeAdapterError('E_BAD_QUERY', 'borrower accountId is required');
  const replica = findReplica(ctx.env, entityId);
  if (!replica) throw new RuntimeAdapterError('E_NOT_FOUND', 'bank entity unavailable');
  const { state } = replica;
  const account = state.accounts.get(borrower);
  if (!account) throw new RuntimeAdapterError('E_NOT_FOUND', 'borrower account unavailable');
  return {
    atHeight: envHeight(ctx.env),
    signerId: replica.signerId,
    isHub: state.profile?.isHub === true,
    account: compactAccountDocForView(account),
    book: {
      loans: [...(state.lending?.loans.values() ?? [])].filter(row => row.borrowerEntityId === borrower),
      facilities: [...(state.lending?.facilities?.values() ?? [])].filter(row => row.borrowerEntityId === borrower),
      terms: [...(state.lending?.terms?.values() ?? [])],
    },
  };
}
