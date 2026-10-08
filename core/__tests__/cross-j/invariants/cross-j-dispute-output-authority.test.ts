import { expect, test } from 'bun:test';
import { assertRuntimeOutputAuthorization } from '../../../entity/auth/authorization';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityTx } from '../../../types/entity-tx';
import { addr, entity, jref, makeJurisdiction, makeState } from '../../helpers/cross-j';

const users = [entity('11'), entity('22'), entity('33'), entity('44')] as const;
const signers = [addr('11'), addr('22'), addr('33'), addr('44')] as const;
const sourceJ = makeJurisdiction('source', 31337, 'a1', 'a2');
const targetJ = makeJurisdiction('target', 31338, 'b1', 'b2');
const route: CrossJurisdictionSwapRoute = {
  orderId: 'counterproof-authority', makerEntityId: users[0], hubEntityId: users[1],
  source: { entityId: users[0], counterpartyEntityId: users[1], jurisdiction: jref(sourceJ), tokenId: 1, amount: 10n },
  target: { entityId: users[2], counterpartyEntityId: users[3], jurisdiction: jref(targetJ), tokenId: 1, amount: 20n },
  sourceSignerId: signers[0], sourceHubSignerId: signers[1], targetHubSignerId: signers[2], targetSignerId: signers[3],
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  status: 'resting', createdAt: 1, updatedAt: 1,
};

// Each observer may notify only its same-role sibling on the other leg,
// binding the observed counterparty to its own Account, never a caller's claim.
for (const [source, target, observed] of [[0, 3, 1], [1, 2, 0], [3, 0, 2], [2, 1, 3]] as const) {
  test(`crossJurisdictionForceSiblingDispute binds observer ${source} to sibling ${target}`, () => {
    const state = makeState(users[target], signers[target], target < 2 ? sourceJ : targetJ);
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    const tx: EntityTx = { type: 'crossJurisdictionForceSiblingDispute', data: {
      routeId: route.orderId, observedCounterpartyEntityId: users[observed], observedAt: 123,
    } };
    const check = (sender: string, signer: string, nested: EntityTx) =>
      assertRuntimeOutputAuthorization(sender, signer, users[target], [nested], state);
    expect(() => check(users[source], signers[source], tx)).not.toThrow();
    expect(() => check(users[source], addr('ff'), tx)).toThrow('SOURCE_SIGNER_MISMATCH');
    expect(() => check(users[observed], signers[observed], tx)).toThrow('SEMANTIC_TARGET_MISMATCH');
    expect(() => check(users[source], signers[source], { ...tx,
      data: { ...tx.data, observedCounterpartyEntityId: users[target] },
    })).toThrow('SIBLING_DISPUTE_OBSERVED_MISMATCH');
  });
}
