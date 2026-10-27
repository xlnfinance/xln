import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import type { AccountTx } from '../../../core/types/account';
import { inputs, makeAccount, route } from './cross-j';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const address = (byte: string): string => `0x${byte.repeat(20)}`;

/**
 * A peer swap_offer whose cross-J route is not its own canonical form.
 * `claimedHashChanged` alters only the claimed routeHash; `hashedFieldChanged`
 * keeps the claimed (and pull-bound) hash but changes a hashed route field,
 * which Rust used to accept because it compared the binding with the claim.
 * Malformed routes must reject before canonicalization, including fields such
 * as updatedAt that are not bound by the hash. Neither engine may retain them.
 */
export const executeCrossJRouteHashAccountSemanticVector = async () => {
  const prepared = route();
  const missingUpdatedAt = { ...prepared };
  Reflect.deleteProperty(missingUpdatedAt, 'updatedAt');
  const base = inputs(prepared);
  const tampered = (crossJurisdiction: typeof prepared): Extract<AccountTx, { type: 'swap_offer' }> => ({
    ...base.swapOffer,
    data: { ...base.swapOffer.data, crossJurisdiction },
  });
  const offers = {
    claimedHashChanged: tampered({ ...prepared, routeHash: `0x${'ee'.repeat(32)}` }),
    hashedFieldChanged: tampered({ ...prepared, targetSignerId: entity('55') }),
    missingUpdatedAt: tampered(missingUpdatedAt),
    unknownField: tampered({ ...prepared, ...{ unknownField: true } }),
    malformedNestedField: tampered({ ...prepared, sourceDisputeConfig: { ...prepared.sourceDisputeConfig, leftResponseSeconds: -1 } }),
  } as const;
  const cases = [];
  for (const [name, offer] of Object.entries(offers)) {
    const account = makeAccount(entity('11'), entity('22'), 1, 31_337, address('88'));
    const locked = await applyAccountTxToMutableReplica(account, base.sourceLock, false, 1_000, 10);
    if (!locked.ok) throw new Error(`CROSS_J_ROUTE_HASH_VECTOR_LOCK_REJECTED:${locked.rejection.message}`);
    const accountStateRoot = computeAccountStateRootCold(account.state);
    const result = await applyAccountTxToMutableReplica(account, offer, true, 1_000, 10);
    if (result.ok) throw new Error(`CROSS_J_ROUTE_HASH_VECTOR_ACCEPTED:${name}`);
    if (computeAccountStateRootCold(account.state) !== accountStateRoot) {
      throw new Error(`CROSS_J_ROUTE_HASH_VECTOR_MUTATED:${name}`);
    }
    cases.push({ name, input: name, accountStateRoot, rejectionCode: result.rejection.code, rejection: result.rejection.message });
  }
  return {
    version: 1,
    canonicalSource: 'TypeScript applyAccountTxToMutableReplica',
    inputs: { sourceLock: base.sourceLock, ...offers },
    cases,
  };
};
