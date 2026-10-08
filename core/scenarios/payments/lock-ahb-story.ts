/**
 * Narration for the hash-locked payments presentation (Part 2). Setup wording is shared with
 * Part 1; what is specific here is the conditional payment: a lock, a secret, an expiry.
 * Amounts the run measures are passed in, never restated as literals.
 */

import { formatTokenMoney } from '../harness/helpers';
import type { NarrationEntry } from '../harness/narration';
import { FINALITY_MODEL, HTLC_PARALLEL, finalityBadges } from '../harness/story';

const usdc = (amount: bigint): string => formatTokenMoney(1, amount);

export const LOCK_SETUP = {
  fundBoth: {
    title: 'Hub sends Alice and Bob their test balances',
    what: `Hub queues two on-chain transfers in one batch: ${usdc(3_000_000n * 10n ** 6n)} to Alice and ${usdc(2_000_000n * 10n ** 6n)} to Bob.`,
    why: 'In this demo the test balances come from Hub. In a deployment each bank deposits its own funds; no hub injects capital.',
    tradfiParallel: 'Two gross transfers in one submission.',
    keyMetrics: ['Queued: 2 transfers'],
  },
  summary: (collateral: bigint, credit: bigint): NarrationEntry => ({
    title: 'Starting point: the same three banks as Part 1',
    what: `On a local test chain, Alice, Hub and Bob hold test balances on the Depository. Alice's account with Hub holds ${usdc(collateral)} of her collateral; Bob has given Hub a ${usdc(credit)} credit line.`,
    why: 'This part changes one thing: every payment is conditional on a secret, so it either completes on every hop or on none of them.',
    tradfiParallel: 'The same correspondent set-up as Part 1.',
    keyMetrics: [`Collateral, Alice–Hub: ${usdc(collateral)}`, `Credit, Bob → Hub: ${usdc(credit)}`],
    condensePrior: true,
  }),
};

export const LOCK_PAYMENTS = {
  lock: (amount: bigint, senderLock: bigint): NarrationEntry => ({
    title: `Payment 1 of 2: Alice locks ${usdc(senderLock)} to Hub`,
    what: `Alice pays Bob ${usdc(amount)} as a hash-locked payment. She locks ${usdc(senderLock)} in her account with Hub (the payment plus Hub's fee). Hub can claim it only with a secret that only Bob can decrypt from the payment's routing data.`,
    why: 'Every hop is locked to the same hash. Either the secret travels back and every hop completes, or the locks expire and are refunded.',
    tradfiParallel: HTLC_PARALLEL,
  }),
  forward: {
    title: 'Hub locks the payment onward to Bob',
    what: "Hub co-signs Alice's lock and offers Bob a matching lock under the same hash, with an earlier expiry.",
    why: "Hub's outgoing lock is matched by the incoming lock it holds. Its risk is timing: it must claim Alice's lock with the secret before that lock expires.",
    tradfiParallel: 'A correspondent passing a conditional payment on against matching cover.',
  },
  settled: (amount: bigint, fee: bigint): NarrationEntry => ({
    title: 'Payment 1 complete: the secret travelled back',
    what: `Bob decrypted the secret and used it to claim his lock; Hub then used the same secret to claim Alice's. ${usdc(amount)} moved from Alice to Bob, and Hub kept a ${usdc(fee)} fee.`,
    why: 'Revealing the secret completes each hop in turn, from payee back to payer.',
    tradfiParallel: FINALITY_MODEL,
  }),
  finality: (amount: bigint): NarrationEntry => ({
    title: 'How final is payment 1?',
    what: FINALITY_MODEL,
    why: 'The hash lock decides whether the payment happens; it does not make Hub\'s debt to Bob any more secured than in Part 1.',
    tradfiParallel: 'Conditionality is not settlement: Bob still holds an unsecured claim on Hub for what collateral does not cover.',
    badges: finalityBadges(`Enforceable at the Depository up to collateral: Alice's lock in full; Bob's ${usdc(amount)} is an unsecured claim on Hub.`),
  }),
  second: (amount: bigint): NarrationEntry => ({
    title: `Payment 2 of 2: another ${usdc(amount)}`,
    what: `Alice pays Bob another ${usdc(amount)} the same way: one lock per hop, one secret.`,
    why: 'Each conditional payment costs a few signatures per account, not an on-chain transaction.',
    tradfiParallel: HTLC_PARALLEL,
  }),
  reverse: (amount: bigint): NarrationEntry => ({
    title: `Bob pays Alice ${usdc(amount)} back`,
    what: `Bob pays Alice ${usdc(amount)} through Hub, hash-locked the same way, over the same two accounts.`,
    why: 'Each account keeps one net position, so payments in opposite directions offset inside it.',
    tradfiParallel: 'Bilateral netting by construction.',
  }),
  net: (aliceNet: bigint, bobNet: bigint, gross: bigint): NarrationEntry => ({
    title: 'Net positions after three payments',
    what: `${usdc(gross)} of payments leave one net position per account: Alice has paid Hub ${usdc(aliceNet)} net, inside her collateral, and Hub owes Bob ${usdc(bobNet)} net.`,
    why: 'Only net positions would ever need settling. There is no multilateral netting across accounts, and collateral stays locked per counterparty.',
    tradfiParallel: 'Continuous bilateral netting, pair by pair.',
    keyMetrics: [`Gross bilateral flow: ${usdc(gross)}`, `Unsecured exposure, Bob → Hub: ${usdc(bobNet)}`, 'Moved on-chain: 0 USDC'],
  }),
};

export const LOCK_REBALANCE = {
  policy: (softLimit: bigint, maxFee: bigint): NarrationEntry => ({
    title: 'Bob records a collateral policy',
    what: `Bob records, in his own runtime, that he wants at least ${usdc(softLimit)} of collateral in his account with Hub and will pay up to ${usdc(maxFee)} for a top-up. The policy stays private to Bob.`,
    why: 'The bank carrying the exposure decides how much of it must be collateralised.',
    tradfiParallel: 'An internal collateral threshold, comparable to one agreed in a credit support annex.',
    keyMetrics: [`Collateral wanted: ${usdc(softLimit)}`],
  }),
  post: (amount: bigint): NarrationEntry => ({
    title: `Hub posts ${usdc(amount)} of collateral`,
    what: `Hub moves ${usdc(amount)} from its own reserve into collateral for its account with Bob, in an on-chain batch. In this demo Hub does it directly; the request path from Bob's policy is not exercised here.`,
    why: 'Moving its own reserve into collateral needs only Hub\'s signature: it can only improve Bob\'s position.',
    tradfiParallel: 'Posting collateral from a bank\'s own settlement account.',
    keyMetrics: [`Instruction, reserve → collateral: ${usdc(amount)}`],
  }),
  covered: (collateral: bigint, unsecured: bigint): NarrationEntry => ({
    title: "Bob's claim on Hub is collateralised",
    what: `The block is final: the Hub–Bob account holds ${usdc(collateral)} of collateral against Hub's debt to Bob.`,
    why: 'Credit lines stay open, so new payments can create unsecured exposure again until the next top-up.',
    tradfiParallel: 'Collateral posted once an exposure passes the agreed threshold.',
    keyMetrics: [`Collateral, Hub–Bob: ${usdc(collateral)}`, `Unsecured exposure, Bob → Hub: ${usdc(unsecured)}`],
  }),
};

export const LOCK_ROUTES = {
  charlie: (credit: bigint): NarrationEntry => ({
    title: 'Charlie joins through Hub',
    what: `A new bank, Charlie, opens an account with Hub, and both sides grant each other ${usdc(credit)} of credit. Charlie holds no reserve on the Depository.`,
    why: 'Joining the network is one bilateral account. Nothing changes for Alice or Bob.',
    tradfiParallel: 'A respondent bank opening a correspondent account on credit terms.',
  }),
  hub2: {
    title: 'A second hub joins',
    what: 'Hub 2 opens accounts with Hub and with Bob, with 100,000 USDC credit lines each way, creating a longer route from Alice to Bob.',
    why: 'A payment can cross several intermediaries. Each hop is a separate bilateral account with its own limits.',
    tradfiParallel: 'A chain of correspondent banks.',
  },
  threeHop: (amount: bigint): NarrationEntry => ({
    title: 'A three-hop hash-locked payment',
    what: `Alice pays Bob ${usdc(amount)} over three hops: Alice → Hub → Hub 2 → Bob. Every hop is locked to the same hash; the secret, which only Bob can decrypt, releases them one by one, from Bob back to Alice.`,
    why: 'Each intermediary decrypts only its own layer of the route: the next hop and the amount to forward, not who paid or who is paid. The same hash appears on every hop, so intermediaries that collude can link them.',
    tradfiParallel: HTLC_PARALLEL,
    keyMetrics: ['Route: Alice → Hub → Hub 2 → Bob', `Amount: ${usdc(amount)}`],
  }),
  threeHopDone: (amount: bigint): NarrationEntry => ({
    title: 'Three-hop payment complete',
    what: `The secret travelled back over all three hops. Bob received ${usdc(amount)}; Hub and Hub 2 each kept a routing fee, and no lock is left open.`,
    why: 'No hop completed before the one after it: an intermediary claims its incoming lock only with the secret that has already paid its outgoing one.',
    tradfiParallel: HTLC_PARALLEL,
    keyMetrics: ['Locks left open: 0'],
  }),
  offline: (amount: bigint): NarrationEntry => ({
    title: 'Hub drops offline for a moment',
    what: `Alice sends Hub ${usdc(amount)} while Hub is unreachable for one step. The message waits; when Hub reconnects, both sign the update.`,
    why: 'Inputs queue while a party is offline, and both sides converge on the same signed state when it returns.',
    tradfiParallel: 'Store-and-forward messaging: an instruction waits for the counterparty instead of being dropped.',
  }),
};
