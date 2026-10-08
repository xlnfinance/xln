/**
 * Narration for the Alice–Hub–Bob presentation (Part 1). The scenario owns the protocol
 * steps; this file owns what is said about them, so every claim can be reviewed in one place.
 * Amounts that the run measures are passed in, never restated as literals.
 */

import { formatTokenMoney } from '../harness/helpers';
import type { NarrationEntry } from '../harness/narration';
import {
  CHALLENGE_WINDOW_WHY,
  DISPUTE_PARALLEL,
  FINALITY_MODEL,
  SETTLEMENT_ASSET,
  finalityBadges,
} from '../harness/story';

type StoryEntry = NarrationEntry;

const usdc = (amount: bigint): string => formatTokenMoney(1, amount);
const ONE = 10n ** 6n;
const whole = (amount: number): bigint => BigInt(amount) * ONE;

export const AHB_SETUP = {
  deploy: {
    title: 'The Depository is deployed',
    what: 'A Depository contract is deployed on a local test chain (an EVM). It will hold each bank\'s reserves and the collateral of every bilateral account, and it enforces disputes.',
    why: 'The Depository is the only shared ledger here. Payments happen in bilateral accounts; the chain is used for funding, collateral and enforcement.',
    tradfiParallel: 'The settlement system the banks hold accounts in, run as a contract instead of an operator ledger.',
    keyMetrics: ['Banks registered: 0'],
  },
  banks: {
    title: 'Three banks register',
    what: 'Alice, Hub and Bob register on the Depository. Each bank is controlled by its own signing key.',
    why: 'Registration gives each bank an identity whose signatures the contract can verify.',
    tradfiParallel: 'Opening accounts in the settlement system before doing business.',
    keyMetrics: ['Banks: 3'],
  },
  testBalances: (amount: bigint): StoryEntry => ({
    title: 'Test balances credited on the Depository',
    what: `Hub's reserve on the Depository is credited with ${usdc(amount)} of a USDC test token.`,
    why: 'A reserve is a balance held on the Depository itself. It funds collateral and on-chain transfers.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: [`Hub reserve: ${usdc(amount)}`],
  }),
  toAlice: {
    title: 'Hub sends Alice her test balance',
    what: `Hub queues an on-chain transfer of ${usdc(whole(3_000_000))} to Alice's reserve. It waits in Hub's outgoing batch.`,
    why: 'In this demo the test balances come from Hub. In a deployment each bank deposits its own funds; no hub injects capital.',
    tradfiParallel: 'A transfer instruction queued before submission.',
    keyMetrics: ['Queued: 1 transfer'],
  },
  toBob: {
    title: 'Hub sends Bob his test balance',
    what: `Hub adds ${usdc(whole(2_000_000))} for Bob and submits both transfers to the chain in one transaction.`,
    why: 'Each transfer in the batch is applied in full and on its own; the batch only shares the transaction.',
    tradfiParallel: 'Two gross transfers in one submission.',
    keyMetrics: ['Queued: 2 transfers'],
  },
  funded: {
    title: 'Transfers executed on-chain',
    what: 'The block is final: Alice holds 3,000,000 USDC and Bob 2,000,000 USDC of reserves. Hub keeps 5,000,000 USDC.',
    why: 'These reserves now belong to Alice and Bob, not to Hub.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: ['Hub: 5,000,000 USDC', 'Alice: 3,000,000 USDC', 'Bob: 2,000,000 USDC'],
  },
  aliceToBob: {
    title: 'Alice pays Bob directly on-chain',
    what: `Alice transfers ${usdc(whole(500_000))} from her reserve to Bob's on the Depository.`,
    why: 'Any two participants can transfer reserves on-chain: gross, and final when the block is final. The bilateral accounts that follow avoid doing this for every payment.',
    tradfiParallel: 'A gross transfer between two settlement accounts, as in an RTGS.',
    keyMetrics: [`Alice → Bob: ${usdc(whole(500_000))}`],
  },
  reservesReady: {
    title: 'Reserves in place',
    what: 'Hub 5,000,000 · Alice 2,500,000 · Bob 2,500,000 USDC. The total is unchanged at 10,000,000 USDC.',
    why: 'Everything so far was on-chain. Next, two bilateral accounts take payments off-chain.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: ['Total reserves: 10,000,000 USDC'],
  },
  openAliceHub: {
    title: 'Alice opens an account with Hub',
    what: 'Alice and Hub open a bilateral account. Both keep an identical copy of its state, and every change is a frame both of them sign.',
    why: 'The account involves only the two banks that carry its risk; nothing about it is registered network-wide.',
    tradfiParallel: 'A correspondent relationship backed by one jointly signed record instead of two ledgers to reconcile.',
  },
  openBobHub: {
    title: 'Bob opens an account with Hub',
    what: 'Bob opens his own account with Hub. Alice and Bob have no account with each other; Hub connects them.',
    why: "Each bank's exposure stays inside its own account with Hub.",
    tradfiParallel: 'Two respondent banks using the same correspondent.',
  },
  summary: {
    title: 'Starting point: three banks, two accounts',
    what: 'On a local test chain, Alice, Hub and Bob are registered on the Depository with test balances: Hub 5,000,000 · Alice 2,500,000 · Bob 2,500,000 USDC. Alice and Bob each have one bilateral account with Hub, still empty.',
    why: 'Reserves sit on the Depository and belong to each bank. An account is a record both banks sign; its balance changes off-chain, frame by frame.',
    tradfiParallel: 'Two respondent banks with one correspondent, Hub — but each relationship is one jointly signed record, not two ledgers to reconcile.',
    keyMetrics: ['Reserves: 10,000,000 USDC', 'Accounts: 2', 'Collateral: 0 USDC'],
    condensePrior: true,
  },
} satisfies Record<string, StoryEntry | ((...args: never[]) => StoryEntry)>;

export const AHB_ACCOUNTS = {
  postCollateral: (amount: bigint): StoryEntry => ({
    title: `Alice posts ${usdc(amount)} of collateral`,
    what: `Alice instructs the Depository to move ${usdc(amount)} from her reserve into collateral for her account with Hub. The instruction goes on-chain in a batch.`,
    why: 'Collateral lets Alice pay Hub without Hub having to trust her: whatever she owes Hub in the account is covered on the Depository.',
    tradfiParallel: "Collateral locked per counterparty plays the nostro's role, but in a neutral contract.",
    keyMetrics: [`Collateral instruction: ${usdc(amount)}`],
  }),
  awaitingBlock: (delayMs?: number): StoryEntry => ({
    title: 'Waiting for the next block',
    what: delayMs === undefined
      ? 'The batch waits for the next block on the test chain.'
      : `The batch waits for the next block (about ${delayMs} ms on this test chain).`,
    why: 'Until the block is final nothing has moved, so the account cannot count the collateral yet.',
    tradfiParallel: 'An instruction submitted to the settlement system but not yet settled.',
  }),
  collateralRecorded: (amount: bigint, reserveBefore: bigint, reserveAfter: bigint): StoryEntry => ({
    title: 'Collateral recorded on the Depository',
    what: `The block is final. Alice's reserve falls from ${usdc(reserveBefore)} to ${usdc(reserveAfter)} and her account with Hub holds ${usdc(amount)} of collateral. Both banks sign the account frame that records it.`,
    why: `Alice can now pay Hub up to ${usdc(amount)} off-chain, fully covered by collateral.`,
    tradfiParallel: 'Pledged collateral, held by the contract rather than by Hub.',
    keyMetrics: [`Alice reserve: ${usdc(reserveAfter)}`, `Collateral, Alice–Hub: ${usdc(amount)}`],
  }),
  creditLine: (limit: bigint): StoryEntry => ({
    title: `Bob gives Hub a ${usdc(limit)} credit line`,
    what: `Bob sets a ${usdc(limit)} limit on what Hub may owe him in their account. Nothing is deposited; Bob and Hub both sign the new limit.`,
    why: `Only the receiving bank sets this limit, and it can lower it at any time: a lower limit blocks new exposure but never erases debt already incurred. The most Hub can ever owe Bob unsecured is Bob's own limit. Intraday credit here comes from the receiving bank, not from the central bank.`,
    tradfiParallel: 'A bilateral credit limit on a correspondent, set by the bank that carries the risk.',
    keyMetrics: [`Credit, Bob → Hub: ${usdc(limit)}`, `Hub may owe Bob: up to ${usdc(limit)}`],
  }),
};

export const AHB_PAYMENTS = {
  first: (amount: bigint, senderLock: bigint): StoryEntry => ({
    title: `Payment 1 of 2: Alice → Hub → Bob, ${usdc(amount)}`,
    what: `Alice pays Bob ${usdc(amount)} through Hub. She proposes the first hop, a new frame of her account with Hub, and signs it. She sends ${usdc(senderLock)}: the payment plus a ${usdc(senderLock - amount)} routing fee for Hub.`,
    why: 'Two accounts change, Alice–Hub and Hub–Bob, each by a frame both of its banks sign. Nothing is sent to the chain.',
    tradfiParallel: "A payment through one correspondent. Alice's leg is covered by her collateral; Bob's leg is a claim on Hub within the credit line Bob granted.",
  }),
  forward: {
    title: 'Hub forwards the payment to Bob',
    what: "Hub co-signs Alice's frame and proposes the matching frame in its account with Bob.",
    why: 'Hub passes the payment on only against the payment it already holds from Alice.',
    tradfiParallel: 'A correspondent paying out against cover it has received.',
  },
  firstDone: (amount: bigint, senderLock: bigint): StoryEntry => ({
    title: 'Payment 1 complete',
    what: `Hub now owes Bob ${usdc(amount)} in their account. Alice has paid Hub ${usdc(senderLock)} in hers, inside her collateral.`,
    why: "Alice's leg is covered by her collateral. Bob's leg is an unsecured claim on Hub, inside the credit line he chose.",
    tradfiParallel: 'A correspondent payment: covered on one side, a credit exposure on the other.',
    keyMetrics: [`Alice paid Hub, collateralised: ${usdc(senderLock)}`, `Hub owes Bob, unsecured: ${usdc(amount)}`],
  }),
  firstFinality: (amount: bigint): StoryEntry => ({
    title: 'How final is payment 1?',
    what: FINALITY_MODEL,
    why: 'Bilateral finality is immediate. Settlement in the asset is bounded by collateral until the next on-chain settlement.',
    tradfiParallel: 'In an RTGS a payment settles in the settlement asset at once. Here the banks choose how much of each exposure is collateralised.',
    badges: finalityBadges(`Enforceable at the Depository up to the account's collateral: Alice's leg in full; Bob's ${usdc(amount)} is an unsecured claim on Hub.`),
  }),
  second: (amount: bigint): StoryEntry => ({
    title: `Payment 2 of 2: another ${usdc(amount)}`,
    what: `Same route, same rules: Alice pays Bob another ${usdc(amount)} through Hub.`,
    why: 'A payment costs a few signatures per account, not an on-chain transaction.',
    tradfiParallel: 'Repeated correspondent payments with no booking in the settlement system per payment.',
  }),
  bothDone: (total: bigint, exposure: bigint, limit: bigint, gross: bigint): StoryEntry => ({
    title: `Payments complete: ${usdc(total)} from Alice to Bob`,
    what: `Alice's collateral covers everything she has paid Hub. Hub now owes Bob ${usdc(exposure)} with nothing posted against it.`,
    why: `Bob carries ${usdc(exposure)} of unsecured exposure to Hub, within the ${usdc(limit)} limit he set. Rebalancing will collateralise it.`,
    tradfiParallel: 'An unsecured interbank exposure inside an agreed limit.',
    keyMetrics: [`Unsecured exposure, Bob → Hub: ${usdc(exposure)}`, `Gross bilateral flow: ${usdc(gross)}`, 'Moved on-chain: 0 USDC'],
  }),
  hubDefault: (collateral: bigint, paidToHub: bigint, exposure: bigint, limit: bigint): StoryEntry => ({
    title: 'If Hub failed now',
    what: `Alice's ${usdc(collateral)} of collateral sits in the Depository, not on Hub's books: Hub can claim only the ${usdc(paidToHub)} she has actually paid it. Bob would file the last co-signed state with the Depository. After the challenge window he is paid from Hub's remaining reserve; any shortfall is booked on-chain as Hub's debt to Bob.`,
    why: `Debts are repaid first-come, not pro rata, from Hub's reserve on the Depository, and Hub cannot move reserves out while it owes. Bob's loss can never exceed the ${usdc(limit)} line he chose; today his exposure is ${usdc(exposure)}.`,
    tradfiParallel: 'Close-out against a failed correspondent. On-chain, unpaid claims queue first-come against its reserves; how that interacts with insolvency law depends on the jurisdiction.',
    keyMetrics: [`Bob's exposure: ${usdc(exposure)}`, `Bob's maximum loss: ${usdc(limit)}`],
  }),
  reverse: (amount: bigint): StoryEntry => ({
    title: `Bob pays Alice ${usdc(amount)} back`,
    what: `Bob pays Alice ${usdc(amount)} through Hub, over the same two accounts in the opposite direction.`,
    why: 'Each account keeps one net position, so payments in opposite directions offset inside it.',
    tradfiParallel: 'Bilateral netting by construction.',
  }),
  netPosition: (net: bigint, aliceNet: bigint, bobNet: bigint, gross: bigint): StoryEntry => ({
    title: `Net position: ${usdc(net)} from Alice to Bob`,
    what: `Three payments, ${usdc(gross)} gross, leave one net position per account: Alice has paid Hub ${usdc(aliceNet)} net, inside her collateral, and Hub owes Bob ${usdc(bobNet)} net. Nothing has moved on-chain.`,
    why: 'Gross flows stay inside the accounts; only net positions would ever need settling. The saving is bilateral only: there is no multilateral netting across accounts, and collateral is locked per counterparty instead of pooled.',
    tradfiParallel: 'Continuous bilateral netting. Unlike a multilateral net settlement system, positions offset only within each pair of banks.',
    keyMetrics: [`Gross bilateral flow: ${usdc(gross)}`, `Net, Alice → Bob: ${usdc(net)}`, 'Moved on-chain: 0 USDC'],
  }),
};

export const AHB_REBALANCE = {
  release: (amount: bigint, aliceNet: bigint): StoryEntry => ({
    title: "Rebalancing 1 of 2: settle Alice's net position against her collateral",
    what: `Alice has paid Hub ${usdc(aliceNet)} net, all inside her collateral. Alice and Hub co-sign a settlement: ${usdc(amount)} of the account's collateral moves to Hub's reserve.`,
    why: 'Hub is paid on-chain for what it is owed; the collateral that stays in the account is Alice\'s, apart from Hub\'s routing fees.',
    tradfiParallel: 'Settling the net position against pledged collateral: the obligation is discharged from the collateral, not by a new payment.',
    keyMetrics: [`Proposed, collateral → Hub reserve: ${usdc(amount)}`],
  }),
  released: (amount: bigint, collateralLeft: bigint, hubShareLeft: bigint): StoryEntry => ({
    title: `Settled on-chain: Hub's reserve +${usdc(amount)}`,
    what: `The Depository moved ${usdc(amount)} from the Alice–Hub collateral to Hub's reserve. The account keeps ${usdc(collateralLeft)} of collateral${hubShareLeft > 0n ? `, of which only Hub's ${usdc(hubShareLeft)} of routing fees is not Alice's` : ', all of it Alice\'s'}.`,
    why: 'One on-chain transaction settles what Alice paid Hub, net, since the account opened.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: [`Collateral, Alice–Hub: ${usdc(collateralLeft)}`, `Hub reserve: +${usdc(amount)}`],
  }),
  collateralise: (amount: bigint): StoryEntry => ({
    title: 'Rebalancing 2 of 2: Hub collateralises its debt to Bob',
    what: `Hub and Bob co-sign a settlement: Hub moves ${usdc(amount)} from its reserve into collateral for their account.`,
    why: `Hub's ${usdc(amount)} debt to Bob becomes covered on the Depository, so Bob no longer relies on credit for it.`,
    tradfiParallel: 'Hub collateralises its debt to Bob, as a bank posts collateral against an exposure that has grown.',
    keyMetrics: [`Proposed, Hub reserve → collateral: ${usdc(amount)}`],
  }),
  rebalanced: (amount: bigint, aliceCollateral: bigint, unsecured: bigint, gross: bigint): StoryEntry => ({
    title: 'Rebalanced: no uncollateralised balances right now',
    what: `Hub–Bob holds ${usdc(amount)} of collateral against Hub's debt to Bob, and Alice–Hub holds ${usdc(aliceCollateral)} of collateral. Two on-chain settlements of ${usdc(amount)} each did it.`,
    why: 'Credit lines stay open, so new payments can create unsecured exposure again until the next rebalance. The on-chain cost follows net positions and collateral policy, not the number of payments.',
    tradfiParallel: 'Collateral follows exposure; the payments themselves never touched the chain.',
    keyMetrics: [`Gross bilateral flow: ${usdc(gross)}`, 'On-chain settlements: 2', `Unsecured exposure: ${usdc(unsecured)}`],
  }),
};

export const AHB_STRESS_STORY = {
  aliceCredit: (limit: bigint): StoryEntry => ({
    title: 'Alice gives Hub a credit line too',
    what: `Alice grants Hub a ${usdc(limit)} credit line, so Hub can also pay her without posting collateral first.`,
    why: 'With credit lines open, new payments can create unsecured exposure again.',
    tradfiParallel: 'A second bilateral limit, set by the bank that would carry the risk.',
    keyMetrics: [`Credit, Alice → Hub: ${usdc(limit)}`],
  }),
  simultaneous: (aliceToHub: bigint, hubToAlice: bigint): StoryEntry => ({
    title: 'Both banks pay at the same instant',
    what: `Alice pays Hub ${usdc(aliceToHub)} and Hub pays Alice ${usdc(hubToAlice)} at the same moment. Each proposes a new frame of the same account.`,
    why: `A fixed rule decides which frame goes first (the bank with the lower identifier); the other is re-proposed on top of it. Both payments apply exactly once: net ${usdc(aliceToHub - hubToAlice)} from Alice to Hub.`,
    tradfiParallel: 'Deterministic sequencing of simultaneous instructions: nothing is lost or applied twice.',
  }),
  worstCase: (collateral: bigint, owed: bigint): StoryEntry => ({
    title: 'Stress test: what if Hub really fails?',
    what: `The demo now resizes the Hub–Bob account into a worst case: ${usdc(collateral)} of collateral against a ${usdc(owed)} debt from Hub to Bob. Both banks sign the change.`,
    why: 'This shows what the contract does when collateral does not cover a claim.',
    tradfiParallel: 'A default scenario with partial collateral.',
  }),
  worstCaseReady: (collateral: bigint, unsecured: bigint): StoryEntry => ({
    title: 'Worst case in place',
    what: `Hub owes Bob ${usdc(collateral + unsecured)}: ${usdc(collateral)} is covered by the account's collateral, ${usdc(unsecured)} is unsecured, inside the credit line Bob granted.`,
    why: 'If Hub fails now, collateral pays first, then Hub\'s reserve; anything left becomes an on-chain debt.',
    tradfiParallel: 'A partially collateralised exposure to a correspondent.',
    keyMetrics: [`Bob's collateral share: ${usdc(collateral)}`, `Unsecured, Hub → Bob: ${usdc(unsecured)}`],
  }),
  drain: (reserve: bigint): StoryEntry => ({
    title: "Hub's reserve is emptied",
    what: `For the test, Hub transfers its whole remaining reserve (${usdc(reserve)}) to Alice on-chain. Nothing is left to pay unsecured claims from.`,
    why: 'A failing bank may have spent or lost its reserves; this is that case.',
    tradfiParallel: 'A defaulting correspondent with no liquid assets left at the settlement system.',
    keyMetrics: ['Hub reserve: 0 USDC'],
  }),
  bobExits: {
    title: 'Hub stops responding: Bob exits alone',
    what: 'Bob freezes his account with Hub and drafts a dispute from the last state both banks signed.',
    why: 'Exit needs no cooperation from Hub: the last co-signed state is the evidence.',
    tradfiParallel: 'Close-out on the last confirmed position, without the defaulting party.',
  },
  filed: (who: string, window: string): StoryEntry => ({
    title: `${who}'s dispute is filed: the challenge window opens`,
    what: `${who} submits the dispute to the Depository. Hub has ${window} to answer with a newer co-signed state; finalizing earlier is refused. The demo fast-forwards the clock.`,
    why: CHALLENGE_WINDOW_WHY,
    tradfiParallel: 'A claim with a fixed contest period.',
    keyMetrics: [`Challenge window: ${window}`],
  }),
  bobPaid: (collateral: bigint, debt: bigint): StoryEntry => ({
    title: "Bob is paid from collateral; the shortfall becomes Hub's debt",
    what: `The window closed with no answer. The Depository applied the last co-signed state: Bob received the ${usdc(collateral)} of collateral. Hub's reserve was empty, so the remaining ${usdc(debt)} is booked on-chain as Hub's debt to Bob.`,
    why: "Debts are repaid first-come, not pro rata, from Hub's reserve on the Depository, and Hub cannot move any reserve out while it owes. Bob's loss can never exceed the credit line he granted.",
    tradfiParallel: `${DISPUTE_PARALLEL} How the on-chain debt queue ranks against insolvency law is a legal question.`,
    keyMetrics: [`Paid from collateral: ${usdc(collateral)}`, `Hub's debt to Bob: ${usdc(debt)}`],
  }),
  aliceExits: {
    title: 'Alice exits too',
    what: 'Alice also freezes her account with Hub and files her last co-signed state with the Depository.',
    why: "Alice's collateral sits in the Depository, not on Hub's books, so she can recover her share without Hub.",
    tradfiParallel: 'Recovering pledged collateral from a failed counterparty without its cooperation.',
  },
  aliceRecovered: (returned: bigint, hubShare: bigint): StoryEntry => ({
    title: 'Alice recovers her collateral',
    what: `After the window, the Depository paid ${usdc(returned)} into Alice's reserve: her share of the account's collateral under the last co-signed state. Hub's own ${usdc(hubShare)} share went to Hub's reserve, where it is held for Hub's debt to Bob: Hub cannot move it out, and anyone can trigger the repayment.`,
    why: 'Collateral protected Alice exactly as far as it reached; the failed hub could not keep it.',
    tradfiParallel: DISPUTE_PARALLEL,
    keyMetrics: [`Returned to Alice: ${usdc(returned)}`, `Hub's share: ${usdc(hubShare)}`],
    endsPresentation: true,
  }),
};
