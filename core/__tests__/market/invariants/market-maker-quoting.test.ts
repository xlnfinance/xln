import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../../../account/state/delta';
import { planMarketMakerQuoteEntityInputs } from '../../../orchestrator/market-maker/node/mm-node-core';
import { getBootstrapCreditAmount } from '../../../orchestrator/mesh/mesh-common';
import { createEmptyEnv } from '../../../runtime';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { AccountReplica } from '../../../types/account';
import { addr, entity, makeAccount, putTestAccountDelta } from '../../helpers/cross-j';

const MM = entity('11');
const MM_SIGNER = addr('11');
const TOKENS = [1, 2, 3];

type HubFixture = Readonly<{ entityId: string; swapTakerFeeBps?: number }>;

const fundedAccount = (hubEntityId: string): AccountReplica => {
  const account = makeAccount(MM, hubEntityId);
  account.currentHeight = 1;
  for (const tokenId of TOKENS) {
    const delta = createDefaultDelta(tokenId);
    delta.leftCreditLimit = getBootstrapCreditAmount(tokenId);
    delta.rightCreditLimit = getBootstrapCreditAmount(tokenId);
    putTestAccountDelta(account, delta);
  }
  return account;
};

/** One MM Entity with a committed, mutually credited Account per Hub. */
const buildQuotingEnv = (hubs: readonly HubFixture[]): RuntimeReplica => {
  const env = createEmptyEnv('market-maker-quoting');
  env.quietRuntimeLogs = true;
  env.state.eReplicas.set(`${MM}:${MM_SIGNER}`, {
    entityId: MM,
    signerId: MM_SIGNER,
    mempool: [],
    state: {
      entityId: MM,
      profile: { isHub: false },
      accounts: new Map(hubs.map(hub => [hub.entityId, fundedAccount(hub.entityId)])),
    },
  } as unknown as EntityReplica);
  env.gossip = {
    getProfiles: () => hubs.map(hub => ({
      name: `Hub ${hub.entityId.slice(-4)}`,
      entityId: hub.entityId,
      metadata: {
        isHub: true,
        ...(hub.swapTakerFeeBps === undefined ? {} : { swapTakerFeeBps: hub.swapTakerFeeBps }),
      },
    })),
  } as RuntimeReplica['gossip'];
  return env;
};

const plannedOfferHubs = (env: RuntimeReplica, hubEntityIds: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  const inputs = planMarketMakerQuoteEntityInputs(
    env, MM, MM_SIGNER, hubEntityIds, TOKENS, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0,
  );
  for (const tx of inputs.flatMap(input => input.entityTxs ?? [])) {
    if (tx.type !== 'placeSwapOffer') continue;
    counts.set(tx.data.counterpartyEntityId, (counts.get(tx.data.counterpartyEntityId) ?? 0) + 1);
  }
  return counts;
};

describe('market maker quote planning', () => {
  test('a Hub whose advertised swap fee is missing or above the MM cap is skipped, never fatal', () => {
    const fair = entity('a1');
    const missing = entity('b1');
    const confiscatory = entity('c1');
    const invalid = entity('d1');
    const env = buildQuotingEnv([
      { entityId: fair, swapTakerFeeBps: 1 },
      { entityId: missing },
      { entityId: confiscatory, swapTakerFeeBps: 9_999 },
      { entityId: invalid, swapTakerFeeBps: 10_000 },
    ]);

    const counts = plannedOfferHubs(env, [fair, missing, confiscatory, invalid]);

    expect([...counts.keys()]).toEqual([fair]);
    expect(counts.get(fair)).toBe(20);
  });

  test('accepted Hub fee is signed exactly into every offer authorization', () => {
    const hub = entity('a1');
    const env = buildQuotingEnv([{ entityId: hub, swapTakerFeeBps: 1 }]);
    const inputs = planMarketMakerQuoteEntityInputs(
      env, MM, MM_SIGNER, [hub], TOKENS, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0,
    );
    const offers = inputs.flatMap(input => input.entityTxs ?? []).flatMap(tx =>
      tx.type === 'placeSwapOffer' ? [tx.data] : []);
    expect(offers).toHaveLength(20);
    for (const offer of offers) {
      expect(offer.maxFee).toBe(offer.wantAmount / 10_000n);
      expect(offer.minNetReceive).toBe(offer.wantAmount - offer.maxFee);
    }
  });
});
