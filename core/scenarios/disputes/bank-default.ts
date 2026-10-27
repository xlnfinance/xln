/**
 * Bank default and first-come debt enforcement.
 *
 * Hub (a bank) owes three customers. Only Carol is secured by collateral; Alice and Bob
 * extended credit. Hub's reserve is empty when it stops responding, so:
 *  1) Alice and Bob exit alone; their whole claims are booked as Hub's on-chain debt, queued
 *     in finalization order;
 *  2) Carol exits and is paid from collateral; Hub's share of that collateral refills Hub's
 *     reserve, which stays locked while Hub owes;
 *  3) permissionless enforcement pays the queue oldest-first: Alice in full, Bob in part;
 *  4) a later inflow and a second enforcement pay Bob's remainder and empty the queue.
 * Every narrated amount is read back from Depository reserves or Entity debt state first.
 */

import type { RuntimeReplica } from '../../runtime/types';
import type { EntityInput } from '../../entity/types';
import type { EntityTx } from '../../types/entity-tx';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import { buildDebtEnforcementRuntimeInputFromProjection } from '../../runtime/tx/debt-enforcement-input';
import { bootScenario, DEMO_JURISDICTION_NAME, fundEntities, registerEntities } from '../harness/boot';
import {
  advanceScenarioPastDisputeTimeout,
  assert,
  commitRuntimeInput,
  converge,
  enableStrictScenario,
  findReplica,
  getProcess,
  pinScenarioJurisdictionUnix,
  processJEvents,
  syncChain,
  usd,
} from '../harness/helpers';
import { announce, tell } from '../harness/narration';
import { disputeWindowText } from '../harness/story';
import { safeStringify } from '../../protocol/serialization';
import { BANK_DEFAULT_STORY, type CustomerClaim } from './bank-default-story';

const USDC = 1;
const CAPITAL = usd(350_000);
const CREDIT = usd(500_000);
const REFILL = usd(150_000);
const DEPOSITS = { Alice: usd(200_000), Bob: usd(150_000), Carol: usd(100_000) } as const;
const DISPUTE_START_UNIX = 4_102_500_000;

type Party = { id: string; signer: string; name: string };
type Context = {
  env: RuntimeReplica;
  jadapter: JAdapter;
  process: Awaited<ReturnType<typeof getProcess>>;
  hub: Party;
};
type QueuedDebt = { creditor: string; remaining: bigint };

const PARTIES = [
  { name: 'Alice', signer: '2', position: { x: -52, y: -62, z: 0 } },
  { name: 'Bob', signer: '3', position: { x: 0, y: -74, z: 0 } },
  { name: 'Carol', signer: '4', position: { x: 52, y: -62, z: 0 } },
  { name: 'Hub', signer: '5', position: { x: 0, y: -22, z: 0 } },
];

const settleRounds = async ({ env, process }: Context, rounds: number): Promise<void> => {
  for (let round = 0; round < rounds; round++) await process(env);
  await converge(env, 12);
};

const reserveOf = (ctx: Context, party: Party): Promise<bigint> => ctx.jadapter.getReserves(party.id, USDC);

/** Hub's open on-chain debts in the Depository's first-come order. */
const hubDebts = ({ env, hub }: Context): QueuedDebt[] =>
  Array.from(findReplica(env, hub.id)[1].state.outDebtsByToken?.get(USDC)?.values() ?? [])
    .filter((debt) => debt.remainingAmount > 0n)
    .sort((left, right) => left.createdDebtIndex - right.createdDebtIndex)
    .map((debt) => ({ creditor: debt.creditor.toLowerCase(), remaining: debt.remainingAmount }));

const totalDebt = (ctx: Context): bigint => hubDebts(ctx).reduce((sum, debt) => sum + debt.remaining, 0n);

const debtTo = (ctx: Context, party: Party): bigint =>
  hubDebts(ctx).find((debt) => debt.creditor === party.id.toLowerCase())?.remaining ?? 0n;

/** What Hub owes one customer, from the customer's side: covered by collateral, and on credit. */
const claimOf = ({ env, hub }: Context, customer: Party): CustomerClaim => {
  const delta = findReplica(env, customer.id)[1].state.accounts.get(hub.id)?.state.deltas.get(USDC);
  if (!delta) throw new Error(`BANK_DEFAULT_DELTA_MISSING:${customer.name}`);
  const derived = deriveDelta(delta, isLeftEntity(customer.id, hub.id));
  return { name: customer.name, secured: derived.outCollateral, unsecured: derived.outPeerCredit };
};

const openAccounts = async (ctx: Context, customers: readonly Party[]): Promise<void> => {
  announce(ctx.env, BANK_DEFAULT_STORY.accounts(CREDIT));
  await ctx.process(ctx.env, customers.map((customer) => ({
    entityId: customer.id,
    signerId: customer.signer,
    entityTxs: [{
      type: 'openAccount' as const,
      data: {
        targetEntityId: ctx.hub.id,
        disputeConfig: defaultAccountDisputeConfigForParties(customer.id, false, ctx.hub.id, true),
        tokenId: USDC,
        creditAmount: CREDIT,
      },
    }],
  })));
  await settleRounds(ctx, 4);
};

const postCollateral = async (ctx: Context, carol: Party): Promise<void> => {
  announce(ctx.env, BANK_DEFAULT_STORY.collateral(CAPITAL));
  await ctx.process(ctx.env, [{
    entityId: ctx.hub.id,
    signerId: ctx.hub.signer,
    entityTxs: [
      { type: 'r2c', data: { counterpartyId: carol.id, tokenId: USDC, amount: CAPITAL } },
      { type: 'j_broadcast', data: {} },
    ],
  }]);
  await syncChain(ctx.env, 5);
  const collateral = findReplica(ctx.env, carol.id)[1].state.accounts.get(ctx.hub.id)?.state.deltas.get(USDC)?.collateral;
  assert(collateral === CAPITAL, `BANK_DEFAULT_COLLATERAL:${String(collateral)}`, ctx.env);
  assert((await reserveOf(ctx, ctx.hub)) === 0n, 'BANK_DEFAULT_HUB_RESERVE_NOT_EMPTY', ctx.env);
};

const payDeposits = async (ctx: Context, customers: readonly Party[]): Promise<void> => {
  const amountOf = (customer: Party): bigint => DEPOSITS[customer.name as keyof typeof DEPOSITS];
  announce(ctx.env, BANK_DEFAULT_STORY.deposits(customers.map((customer) => ({ name: customer.name, amount: amountOf(customer) }))));
  await ctx.process(ctx.env, [{
    entityId: ctx.hub.id,
    signerId: ctx.hub.signer,
    entityTxs: customers.map((customer) => ({
      type: 'directPayment' as const,
      data: {
        targetEntityId: customer.id,
        tokenId: USDC,
        amount: amountOf(customer),
        route: [ctx.hub.id, customer.id],
        deliveryMode: 'direct' as const,
        description: `bank-default deposit ${customer.name}`,
      },
    })),
  }]);
  await settleRounds(ctx, 8);
  for (const customer of customers) {
    const claim = claimOf(ctx, customer);
    assert(claim.secured + claim.unsecured === amountOf(customer), `BANK_DEFAULT_CLAIM:${customer.name}`, ctx.env);
  }
};

const finalizeAfterWindow = async (ctx: Context, customer: Party): Promise<void> => {
  const active = (): boolean =>
    Boolean(findReplica(ctx.env, customer.id)[1].state.accounts.get(ctx.hub.id)?.activeDispute) ||
    Boolean(findReplica(ctx.env, ctx.hub.id)[1].state.accounts.get(customer.id)?.activeDispute);
  for (let round = 0; round < 40 && active(); round++) {
    // The runtime clock makes the dispute-deadline hook due; its frame drafts the finalization.
    ctx.env.state.timestamp = (ctx.env.state.timestamp || 0) + 1000;
    if (round === 0) announce(ctx.env, BANK_DEFAULT_STORY.windowCloses(customer.name));
    await ctx.process(ctx.env);
    await syncChain(ctx.env, 3);
    await processJEvents(ctx.env);
    await converge(ctx.env, 6);
  }
  assert(!active(), `BANK_DEFAULT_FINALIZE_STUCK:${customer.name}`, ctx.env);
};

/** One customer exits alone: freeze, file, wait out the window, finalize. */
const exitAlone = async (ctx: Context, customer: Party, first: boolean): Promise<void> => {
  const input = (entityTxs: EntityTx[]): EntityInput[] =>
    [{ entityId: customer.id, signerId: customer.signer, entityTxs }];
  announce(ctx.env, BANK_DEFAULT_STORY.exits(customer.name, first));
  await ctx.process(ctx.env, input([{
    type: 'prepareDispute',
    data: { counterpartyEntityId: ctx.hub.id, description: `bank-default exit ${customer.name}` },
  }]));
  const frozen = findReplica(ctx.env, customer.id)[1].state.accounts.get(ctx.hub.id);
  assert(frozen?.status === 'disputed', `BANK_DEFAULT_NOT_FROZEN:${customer.name}`, ctx.env);
  // Anvil automining follows host time; pin the first dispute block so every run is identical.
  if (first) await pinScenarioJurisdictionUnix(ctx.env, ctx.jadapter, DISPUTE_START_UNIX);
  announce(ctx.env, BANK_DEFAULT_STORY.filed(customer.name, disputeWindowText(frozen.state.disputeConfig)));
  await ctx.process(ctx.env, input([{ type: 'j_broadcast', data: {} }]));
  await syncChain(ctx.env, 5);
  await processJEvents(ctx.env);
  await converge(ctx.env, 12);
  const started = findReplica(ctx.env, customer.id)[1].state.accounts.get(ctx.hub.id)?.activeDispute;
  assert(started, `BANK_DEFAULT_DISPUTE_NOT_STARTED:${customer.name}`, ctx.env);
  await advanceScenarioPastDisputeTimeout(ctx.env, ctx.jadapter, Number(started.disputeTimeout));
  await finalizeAfterWindow(ctx, customer);
};

const unsecuredExit = async (ctx: Context, customer: Party, position: number): Promise<void> => {
  const claim = claimOf(ctx, customer);
  const reserveBefore = await reserveOf(ctx, customer);
  await exitAlone(ctx, customer, position === 1);
  assert((await reserveOf(ctx, customer)) === reserveBefore, `BANK_DEFAULT_UNEXPECTED_PAYOUT:${customer.name}`, ctx.env);
  const debts = hubDebts(ctx);
  assert(debts.length === position && debts[position - 1]?.creditor === customer.id.toLowerCase(),
    `BANK_DEFAULT_QUEUE_ORDER:${customer.name}:${debts.map((debt) => debt.creditor).join(',')}`, ctx.env);
  assert(debts[position - 1]?.remaining === claim.unsecured, `BANK_DEFAULT_DEBT_AMOUNT:${customer.name}`, ctx.env);
  tell(ctx.env, BANK_DEFAULT_STORY.becameDebt(customer.name, claim.unsecured, position, totalDebt(ctx)));
};

const securedExit = async (ctx: Context, customer: Party): Promise<void> => {
  const claim = claimOf(ctx, customer);
  const [customerBefore, hubBefore] = [await reserveOf(ctx, customer), await reserveOf(ctx, ctx.hub)];
  await exitAlone(ctx, customer, false);
  const paid = (await reserveOf(ctx, customer)) - customerBefore;
  const surplus = (await reserveOf(ctx, ctx.hub)) - hubBefore;
  assert(paid === claim.secured && claim.unsecured === 0n, `BANK_DEFAULT_SECURED_PAYOUT:${paid}`, ctx.env);
  assert(surplus === CAPITAL - claim.secured, `BANK_DEFAULT_SURPLUS:${surplus}`, ctx.env);
  tell(ctx.env, BANK_DEFAULT_STORY.securedPaid(customer.name, paid, surplus, totalDebt(ctx)));
};

/** Permissionless enforcement: one J input, then wait until Hub's queue reflects it. */
const enforceDebts = async (ctx: Context, round: number): Promise<void> => {
  const before = totalDebt(ctx);
  announce(ctx.env, BANK_DEFAULT_STORY.enforce(round));
  await commitRuntimeInput(ctx.env, buildDebtEnforcementRuntimeInputFromProjection({
    entityId: ctx.hub.id,
    jurisdictionName: DEMO_JURISDICTION_NAME,
    tokenId: USDC,
    timestamp: ctx.env.state.timestamp,
  }));
  for (let attempt = 0; attempt < 20 && totalDebt(ctx) === before; attempt++) {
    await syncChain(ctx.env, 2);
    await processJEvents(ctx.env);
  }
  await converge(ctx.env, 12);
  assert(totalDebt(ctx) < before, `BANK_DEFAULT_ENFORCEMENT_NO_EFFECT:${before}`, ctx.env);
};

const firstEnforcement = async (ctx: Context, queue: readonly Party[]): Promise<void> => {
  const before = await Promise.all(queue.map((party) => reserveOf(ctx, party)));
  await enforceDebts(ctx, 1);
  const rows = await Promise.all(queue.map(async (party, index) => ({
    name: party.name,
    amount: (await reserveOf(ctx, party)) - before[index]!,
    remaining: debtTo(ctx, party),
  })));
  const [first, second] = rows;
  assert(first!.remaining === 0n && second!.amount > 0n && second!.remaining > 0n,
    `BANK_DEFAULT_FIFO:${safeStringify(rows)}`, ctx.env);
  tell(ctx.env, BANK_DEFAULT_STORY.enforced(rows, await reserveOf(ctx, ctx.hub)));
};

const refillAndSettle = async (ctx: Context, last: Party): Promise<void> => {
  announce(ctx.env, BANK_DEFAULT_STORY.refill(REFILL));
  await fundEntities(ctx.env, ctx.jadapter, [{ id: ctx.hub.id, tokenId: USDC, amount: REFILL }]);
  const owed = debtTo(ctx, last);
  const lastBefore = await reserveOf(ctx, last);
  await enforceDebts(ctx, 2);
  const paid = (await reserveOf(ctx, last)) - lastBefore;
  const free = await reserveOf(ctx, ctx.hub);
  assert(paid === owed && hubDebts(ctx).length === 0 && free === REFILL - owed, `BANK_DEFAULT_FINAL:${paid}:${free}`, ctx.env);
  tell(ctx.env, BANK_DEFAULT_STORY.settled(last.name, paid, free));
};

const setUp = async (ctx: Context, customers: readonly Party[]): Promise<void> => {
  const [alice, bob, carol] = customers as [Party, Party, Party];
  await fundEntities(ctx.env, ctx.jadapter, [{ id: ctx.hub.id, tokenId: USDC, amount: CAPITAL }]);
  await openAccounts(ctx, customers);
  await postCollateral(ctx, carol);
  await payDeposits(ctx, customers);
  tell(ctx.env, { ...BANK_DEFAULT_STORY.startingPoint([alice, bob, carol].map((customer) => claimOf(ctx, customer))), focusEntityIds: [ctx.hub.id, ...customers.map((customer) => customer.id)] });
};

export async function runBankDefault(runtimeReplica: RuntimeReplica): Promise<RuntimeReplica> {
  const process = await getProcess();
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'bank-default',
    jurisdictionName: DEMO_JURISDICTION_NAME,
    signerIds: PARTIES.map((party) => party.signer),
    runtimeReplica,
  });
  env.quietRuntimeLogs = true;
  const restoreStrict = enableStrictScenario(env, 'bank-default');
  try {
    announce(env, BANK_DEFAULT_STORY.register);
    const registered = await registerEntities(env, jadapter, PARTIES, jurisdiction) as Party[];
    const byName = (name: string): Party => {
      const party = registered.find((entry) => entry.name === name);
      if (!party) throw new Error(`BANK_DEFAULT_MISSING_ENTITY:${name}`);
      return party;
    };
    const [alice, bob, carol, hub] = ['Alice', 'Bob', 'Carol', 'Hub'].map(byName) as [Party, Party, Party, Party];
    const ctx: Context = { env, jadapter, process, hub };
    announce(env, BANK_DEFAULT_STORY.capital(CAPITAL));
    await setUp(ctx, [alice, bob, carol]);
    await unsecuredExit(ctx, alice, 1);
    await unsecuredExit(ctx, bob, 2);
    await securedExit(ctx, carol);
    await firstEnforcement(ctx, [alice, bob]);
    await refillAndSettle(ctx, bob);
    console.log('✅ bank-default passed');
    return env;
  } finally {
    restoreStrict();
  }
}
