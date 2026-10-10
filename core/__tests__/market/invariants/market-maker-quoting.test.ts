import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../../../account/state/delta';
import {
  ensureMarketMakerHubConnectivity,
  planMarketMakerQuoteEntityInputs,
} from '../../../orchestrator/market-maker/node/mm-node-core';
import {
  getAccountReplica,
  getBootstrapCreditAmount,
  getCreditGrantedByEntity,
  getEntityOutCapacity,
} from '../../../orchestrator/mesh/mesh-common';
import { createEmptyEnv } from '../../../runtime';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeP2P } from '../../../network/p2p/p2p';
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

/** Direct routes are open for exactly these Hubs; every other Hub is offline. */
const openDirectRoutes = (env: RuntimeReplica, openHubEntityIds: readonly string[]): void => {
  env.infrastructure.p2p = {
    prepareDirectEntityRoutes: (entityIds: readonly string[]) =>
      entityIds.every(entityId => openHubEntityIds.includes(entityId)),
  } as unknown as RuntimeP2P;
};

const requireAccount = (env: RuntimeReplica, hubEntityId: string): AccountReplica => {
  const account = getAccountReplica(env, MM, hubEntityId);
  if (!account) throw new Error(`TEST_ACCOUNT_MISSING:${hubEntityId}`);
  return account;
};

const queuedEntityTxTypes = (env: RuntimeReplica): string[] =>
  env.runtimeMempool.entityInputs.flatMap(input => (input.entityTxs ?? []).map(tx => tx.type));

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

  test('a Hub that lowered its own grant does not make the MM resend its unchanged grant', async () => {
    const hub = entity('a1');
    const env = buildQuotingEnv([{ entityId: hub, swapTakerFeeBps: 1 }]);
    openDirectRoutes(env, [hub]);
    const account = requireAccount(env, hub);
    const creditAmount = getBootstrapCreditAmount(1);
    const delta = createDefaultDelta(1);
    // MM is the left party: the Hub writes leftCreditLimit, the MM writes rightCreditLimit.
    delta.leftCreditLimit = creditAmount / 2n;
    delta.rightCreditLimit = creditAmount;
    delta.offdelta = creditAmount / 4n;
    putTestAccountDelta(account, delta);
    expect(getCreditGrantedByEntity(account, MM, 1)).toBe(creditAmount);
    expect(getCreditGrantedByEntity(account, hub, 1)).toBeLessThan(creditAmount);
    expect(getEntityOutCapacity(account, hub, 1)).toBeLessThan(creditAmount);

    const enqueued = await ensureMarketMakerHubConnectivity(env, MM, MM_SIGNER, [hub], TOKENS, { remainingTxs: 100 });

    expect(enqueued).toBe(false);
    expect(queuedEntityTxTypes(env)).toEqual([]);
  });

  test('the MM restores its own grant when that grant is below the bootstrap amount', async () => {
    const hub = entity('a1');
    const env = buildQuotingEnv([{ entityId: hub, swapTakerFeeBps: 1 }]);
    openDirectRoutes(env, [hub]);
    const delta = createDefaultDelta(1);
    delta.leftCreditLimit = getBootstrapCreditAmount(1);
    delta.rightCreditLimit = getBootstrapCreditAmount(1) / 2n;
    putTestAccountDelta(requireAccount(env, hub), delta);

    expect(await ensureMarketMakerHubConnectivity(env, MM, MM_SIGNER, [hub], TOKENS, { remainingTxs: 100 })).toBe(true);
    expect(queuedEntityTxTypes(env)).toEqual(['extendCredit']);
  });
});
