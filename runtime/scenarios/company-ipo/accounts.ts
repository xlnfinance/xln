/**
 * Opens the ordinary company/investor Accounts and moves real Depository
 * reserves into bilateral collateral. No special company Account exists: the
 * same payment and swap machinery serves people, hubs, and board Entities.
 */

import type { RuntimeReplica } from '../../runtime/types';
import type { EntityTx } from '../../types/entity-tx';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { accountStateDomainFromJurisdiction } from '../../account/commitment/state-root';
import { deriveAccountWatchSeed } from '../../protocol/identity/account-watch-seed';
import { fundEntities } from '../harness/boot';
import { findReplica, syncChain } from '../harness/helpers';
import { executeCompanyAction } from './governance';
import {
  CONTROL_SUPPLY,
  DIVIDEND_SUPPLY,
  USDT,
  USDT_UNIT,
  type CompanyActor,
  type CompanyScenarioActors,
  type CompanyShareTokens,
} from './model';

const accountOpenTx = (env: RuntimeReplica, actor: CompanyActor, hub: CompanyActor): EntityTx => {
  if (!actor.config.jurisdiction) throw new Error(`COMPANY_JURISDICTION_MISSING:${actor.id}`);
  if (!env.runtimeSeed) throw new Error('COMPANY_RUNTIME_SEED_MISSING');
  return {
    type: 'openAccount',
    data: {
      targetEntityId: hub.id,
      disputeConfig: defaultAccountDisputeConfigForParties(actor.id, false, hub.id, true),
      accountDomain: accountStateDomainFromJurisdiction(actor.config.jurisdiction),
      watchSeed: deriveAccountWatchSeed({
        runtimeSeed: env.runtimeSeed,
        runtimeId: env.runtimeId ?? null,
        entityId: actor.id,
        counterpartyId: hub.id,
      }),
    },
  };
};

const creditTxs = (
  counterparty: CompanyActor,
  tokenAmounts: ReadonlyArray<readonly [number, bigint]>,
): EntityTx[] => tokenAmounts.map(([tokenId, amount]) => ({
  type: 'extendCredit',
  data: { counterpartyEntityId: counterparty.id, tokenId, amount },
}));

const assertAccount = (env: RuntimeReplica, actor: CompanyActor, hub: CompanyActor): void => {
  const actorAccount = findReplica(env, actor.id)[1].state.accounts.get(hub.id);
  const hubAccount = findReplica(env, hub.id)[1].state.accounts.get(actor.id);
  if (!actorAccount || !hubAccount) throw new Error(`COMPANY_ACCOUNT_MISSING:${actor.id}:${hub.id}`);
};

const fundCollateral = async (
  env: RuntimeReplica,
  actor: CompanyActor,
  hub: CompanyActor,
  tokenAmounts: ReadonlyArray<readonly [number, bigint]>,
): Promise<void> => {
  await executeCompanyAction(env, actor, [
    ...creditTxs(hub, tokenAmounts),
    ...tokenAmounts.map(([tokenId, amount]) => ({
      type: 'r2c' as const,
      data: { counterpartyId: hub.id, tokenId, amount },
    })),
    { type: 'j_broadcast', data: {} },
  ]);
  await syncChain(env, 10);
};

export const prepareCompanyAccounts = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): Promise<void> => {
  for (const actor of [actors.soloCompany, actors.boardCompany, actors.investor]) {
    await executeCompanyAction(env, actor, [accountOpenTx(env, actor, actors.hub)]);
    assertAccount(env, actor, actors.hub);
  }
  const usdtFunding = 1_000n * USDT_UNIT;
  await fundEntities(env, actors.jadapter, [
    { id: actors.soloCompany.id, tokenId: USDT, amount: usdtFunding },
    { id: actors.investor.id, tokenId: USDT, amount: usdtFunding },
  ]);
  const shareCapacity = [
    [shares.controlTokenId, CONTROL_SUPPLY] as const,
    [shares.dividendTokenId, DIVIDEND_SUPPLY] as const,
  ];
  await fundCollateral(env, actors.boardCompany, actors.hub, shareCapacity);
  await fundCollateral(env, actors.investor, actors.hub, [[USDT, usdtFunding]]);
  await fundCollateral(env, actors.soloCompany, actors.hub, [[USDT, 100n * USDT_UNIT]]);
  // The hub temporarily intermediates the two bilateral legs. Each recipient
  // grants it only the asset it may owe on that Account; maker collateral
  // remains separately held on the seller's own side.
  await executeCompanyAction(env, actors.boardCompany, creditTxs(actors.hub, [[USDT, usdtFunding]]));
  await executeCompanyAction(env, actors.investor, creditTxs(actors.hub, shareCapacity));
  await executeCompanyAction(env, actors.hub, [
    ...creditTxs(actors.boardCompany, [...shareCapacity, [USDT, usdtFunding]]),
    ...creditTxs(actors.investor, [...shareCapacity, [USDT, usdtFunding]]),
    ...creditTxs(actors.soloCompany, [[USDT, usdtFunding]]),
  ]);
};

export const proveOrdinaryCompanyPayment = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
): Promise<void> => {
  await executeCompanyAction(env, actors.soloCompany, [{
    type: 'directPayment',
    data: {
      targetEntityId: actors.hub.id,
      tokenId: USDT,
      amount: 5n * USDT_UNIT,
      route: [actors.soloCompany.id, actors.hub.id],
      deliveryMode: 'direct',
      description: 'company-operating-payment',
    },
  }]);
  const delta = findReplica(env, actors.soloCompany.id)[1]
    .state.accounts.get(actors.hub.id)?.state.deltas.get(USDT)?.offdelta;
  if (delta === undefined || delta === 0n) throw new Error('COMPANY_ORDINARY_PAYMENT_NOT_COMMITTED');
};
