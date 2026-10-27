/**
 * Narration for the bank-default scenario: a bank with three customers fails, each customer
 * exits alone, collateral pays what it covers, the rest queues as on-chain debt, and the
 * queue is paid first-come as the failed bank's reserve refills. Every amount is passed in by
 * the scenario from state it has just asserted, so the words cannot drift from the frames.
 */

import { formatTokenMoney } from '../harness/helpers';
import type { NarrationEntry } from '../harness/narration';
import { CHALLENGE_WINDOW_WHY, DISPUTE_PARALLEL, SETTLEMENT_ASSET } from '../harness/story';

const usdc = (amount: bigint): string => formatTokenMoney(1, amount);

const FIFO_WHY =
  "Debts are paid first-come, not pro rata: the oldest claim is paid in full before the next one receives anything. " +
  'While any debt is open, the debtor cannot move reserve out; every outflow pays the queue first.';

export type CustomerClaim = { name: string; secured: bigint; unsecured: bigint };

export const BANK_DEFAULT_STORY = {
  register: {
    title: 'A bank and three customers join the Depository',
    what: 'Hub is a bank; Alice, Bob and Carol are its customers. Each registers as an entity on the Depository contract, controlled by its own signing board.',
    why: 'This part follows one bank failure to the end: who is paid, from what, and in which order.',
    tradfiParallel: 'Participants admitted to the settlement system before any business.',
    keyMetrics: ['Banks: 1', 'Customers: 3'],
  },
  capital: (capital: bigint): NarrationEntry => ({
    title: "Hub's capital is credited on the Depository",
    what: `Hub holds ${usdc(capital)} of test balance as reserve on the Depository. The customers hold none.`,
    why: 'A reserve is what the Depository pays a bank\'s obligations from when the bank itself does not.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: [`Hub reserve: ${usdc(capital)}`],
  }),
  accounts: (credit: bigint): NarrationEntry => ({
    title: 'Each customer opens an account with Hub',
    what: `Alice, Bob and Carol each open a bilateral account with Hub and grant Hub a ${usdc(credit)} credit line: Hub may owe each of them that much without collateral.`,
    why: 'The customer, not the bank, sets how much unsecured exposure it accepts. The limit caps its loss.',
    tradfiParallel: 'A deposit account: the depositor lends to the bank up to an amount it chooses.',
    keyMetrics: [`Credit line per customer: ${usdc(credit)}`],
  }),
  collateral: (amount: bigint): NarrationEntry => ({
    title: 'Carol asks for security: Hub posts collateral',
    what: `Hub moves its whole ${usdc(amount)} reserve into its account with Carol as collateral. Hub's reserve is now empty.`,
    why: 'Collateral sits in the Depository, locked to one account. Only that account\'s counterparty can be paid from it.',
    tradfiParallel: 'Pledged collateral held at the settlement system, segregated for one counterparty.',
    keyMetrics: [`Collateral Hub–Carol: ${usdc(amount)}`, 'Hub reserve: 0 USDC'],
  }),
  deposits: (payments: readonly { name: string; amount: bigint }[]): NarrationEntry => ({
    title: 'Hub credits its customers',
    what: `Hub pays ${payments.map((row) => `${usdc(row.amount)} to ${row.name}`).join(', ')} inside their accounts. Each payment is co-signed by both sides.`,
    why: 'Every co-signed state is a claim on Hub that its holder can take to the Depository alone.',
    tradfiParallel: 'Deposits: each balance is the bank\'s liability to its customer.',
  }),
  startingPoint: (claims: readonly CustomerClaim[]): NarrationEntry => ({
    title: 'Starting point: Hub owes three customers',
    what: claims
      .map((claim) => `${claim.name}: ${usdc(claim.secured + claim.unsecured)} (${usdc(claim.secured)} covered by collateral)`)
      .join('; ') + '. Hub\'s reserve is empty.',
    why: 'Only Carol is secured. Alice and Bob rely on credit: if Hub fails they are paid from Hub\'s reserve, and what the reserve cannot pay becomes on-chain debt.',
    tradfiParallel: 'A bank with one secured and two unsecured creditors and no liquid assets left.',
    keyMetrics: claims.map((claim) => `Hub owes ${claim.name}: ${usdc(claim.secured + claim.unsecured)}`),
    condensePrior: true,
  }),
  exits: (name: string, first: boolean): NarrationEntry => ({
    title: first ? `Hub stops responding: ${name} exits alone` : `${name} exits too`,
    what: `${name} freezes its account with Hub and drafts a dispute from the last state both signed.`,
    why: 'Exit needs no cooperation from the failed bank: the last co-signed state is the evidence.',
    tradfiParallel: 'Close-out on the last confirmed position, without the defaulting party.',
  }),
  filed: (name: string, window: string): NarrationEntry => ({
    title: `${name}'s dispute is filed: the challenge window opens`,
    what: `${name} submits the dispute to the Depository. Hub has ${window} to answer with a newer co-signed state; the demo fast-forwards the clock.`,
    why: CHALLENGE_WINDOW_WHY,
    tradfiParallel: 'A claim with a fixed contest period.',
    keyMetrics: [`Challenge window: ${window}`],
  }),
  windowCloses: (name: string): NarrationEntry => ({
    title: `${name}'s window closes: finalization submitted`,
    what: `No newer state arrived. ${name}'s runtime submits the finalization on its own.`,
    why: 'A deadline, not a negotiation, ends the dispute.',
    tradfiParallel: 'The contest period lapses and the claim becomes enforceable.',
  }),
  becameDebt: (name: string, debt: bigint, position: number, queued: bigint): NarrationEntry => ({
    title: `${name}'s claim becomes Hub's debt, number ${position} in the queue`,
    what: `The Depository applied the last co-signed state. Hub's reserve was empty, so the whole ${usdc(debt)} is booked on-chain as Hub's debt to ${name}, behind ${position === 1 ? 'nobody' : 'the earlier claims'}.`,
    why: FIFO_WHY,
    tradfiParallel: `${DISPUTE_PARALLEL} How the on-chain queue ranks in insolvency is a legal question.`,
    keyMetrics: [`Debt to ${name}: ${usdc(debt)}`, `Queue position: ${position}`, `Hub's open debt: ${usdc(queued)}`],
  }),
  securedPaid: (name: string, paid: bigint, surplus: bigint, queued: bigint): NarrationEntry => ({
    title: `${name} is paid from collateral; the surplus returns to Hub's reserve`,
    what: `The Depository paid ${name} ${usdc(paid)} from the account's collateral. The remaining ${usdc(surplus)} of collateral belonged to Hub and went to Hub's reserve, where the debt queue has the first claim on it.`,
    why: `Collateral protected ${name} fully. Hub still owes ${usdc(queued)}, so it cannot move that reserve out.`,
    tradfiParallel: DISPUTE_PARALLEL,
    keyMetrics: [`Paid to ${name}: ${usdc(paid)}`, `Hub reserve: ${usdc(surplus)}`, `Hub's open debt: ${usdc(queued)}`],
  }),
  enforce: (round: number): NarrationEntry => ({
    title: round === 1 ? 'Anyone triggers debt enforcement' : 'Debt enforcement runs again',
    what: "A call to the Depository's debt enforcement pays Hub's queue from Hub's reserve, oldest debt first. It needs no signature from Hub; the demo submits it.",
    why: 'Enforcement is permissionless and can only move money from the debtor to its creditors, in queue order.',
    tradfiParallel: 'Execution of claims against a defaulter\'s settlement account, in order of filing.',
  }),
  enforced: (paid: readonly { name: string; amount: bigint; remaining: bigint }[], reserve: bigint): NarrationEntry => ({
    title: 'The queue is paid first-come',
    what: paid
      .map((row) => `${row.name} received ${usdc(row.amount)}${row.remaining > 0n ? ` and is still owed ${usdc(row.remaining)}` : ', paid in full'}`)
      .join('; ') + `. Hub's reserve is ${usdc(reserve)}.`,
    why: FIFO_WHY,
    tradfiParallel: 'Strict priority by time of claim, not a pro rata distribution.',
    keyMetrics: paid.map((row) => `${row.name}: +${usdc(row.amount)}`),
  }),
  refill: (amount: bigint): NarrationEntry => ({
    title: 'New money reaches Hub\'s reserve',
    what: `${usdc(amount)} arrives in Hub's reserve (a test credit here; in practice fresh capital or a repaid loan).`,
    why: 'Every future inflow to the debtor\'s reserve is caught by the queue before the debtor can use it.',
    tradfiParallel: 'Recoveries flowing into the estate are applied to outstanding claims.',
    keyMetrics: [`Inflow: ${usdc(amount)}`],
  }),
  settled: (name: string, amount: bigint, free: bigint): NarrationEntry => ({
    title: `${name} is made whole; the queue is empty`,
    what: `Enforcement paid ${name} the remaining ${usdc(amount)}. Hub owes nothing on-chain, and the rest of its reserve, ${usdc(free)}, is free again.`,
    why: 'Every customer was paid in full: Carol from collateral, Alice and Bob from the queue as reserves came in. The order was set by the chain, not by Hub.',
    tradfiParallel: 'All claims satisfied in order of priority; the remainder returns to the debtor.',
    keyMetrics: [`Paid to ${name}: ${usdc(amount)}`, "Hub's open debt: 0 USDC", `Hub reserve: ${usdc(free)}`],
    endsPresentation: true,
  }),
};
