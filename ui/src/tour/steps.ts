import type { WalletView } from '../runtime/views';

export type TourContext = {
  wallet: WalletView;
  pathname: string;
  baseline: Map<string, number>;
  /** Test ids the user clicked while the current step was open. */
  clicked: ReadonlySet<string>;
  dom: { has(id: string): boolean; value(id: string): string; text(id: string): string };
};

/**
 * One highlighted interface detail. An action step completes when the wallet
 * observes the result of what the user did (`done`); a detail step only points
 * at something worth reading and the user dismisses it with Next. The guide
 * never presses, types or pays on the user's behalf.
 */
export type TourStep = {
  id: string;
  chapter: TourChapter;
  title: string;
  instruction(ctx: TourContext): string;
  target(ctx: TourContext): string;
  done?(ctx: TourContext): boolean;
  detail?: boolean;
  enter?(ctx: TourContext): void;
};

export type TourChapter = 'Money in' | 'Payments' | 'Trading' | 'Your account' | 'Exit rights' | 'Safety' | 'History' | 'Done';

const onHome = (ctx: TourContext) => ctx.pathname === '/';
const home = (ctx: TourContext, target: string) => (onHome(ctx) ? target : 'nav-home');
const onAccount = (ctx: TourContext) => ctx.pathname.startsWith('/accounts/');
/** The hub account opens from Home; any other screen first goes back there. */
const account = (ctx: TourContext, target: string) => (onAccount(ctx) ? target : home(ctx, 'account-row'));
const weth = (ctx: TourContext) => ctx.wallet.totals.find(token => token.tokenId === 2)?.net ?? 0n;
const creditTarget = (ctx: TourContext) =>
  ctx.dom.has('receive-spectrum-confirm') ? 'receive-spectrum-confirm' : 'swap-submit';

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'faucet',
    chapter: 'Money in',
    title: 'Get 100 test USDC',
    instruction: ctx =>
      onHome(ctx)
        ? 'Press the highlighted button. H1, your hub, credits you test money in about a second.'
        : 'Open Home to get your test money.',
    target: ctx => home(ctx, 'home-faucet'),
    // Starting the guide after funding must never request another payment.
    done: ctx => ctx.wallet.usd.sendCapacity > 0,
  },
  {
    id: 'balance',
    chapter: 'Money in',
    title: 'Credit, not a deposit',
    detail: true,
    instruction: () =>
      'Violet is credit: H1 owes you this money and nothing is locked on-chain yet. Green would be collateral, enforceable whatever H1 does. One dollar is the same bar length everywhere.',
    target: ctx => home(ctx, 'home-balance-breakdown'),
  },
  {
    id: 'pay',
    chapter: 'Payments',
    title: 'Send your first payment',
    target: ctx =>
      ctx.pathname !== '/pay'
        ? home(ctx, 'home-pay')
        : ctx.dom.has('pay-recipient-options') || !ctx.dom.value('pay-to').trim()
          ? 'pay-to'
          : !ctx.dom.value('pay-amount').trim()
            ? 'pay-amount'
            : 'pay-submit',
    instruction: ctx =>
      ctx.pathname !== '/pay'
        ? 'Press Pay.'
        : ctx.dom.has('pay-recipient-options') || !ctx.dom.value('pay-to').trim()
          ? 'Choose a recipient from the suggestions, for example H2.'
          : !ctx.dom.value('pay-amount').trim()
            ? 'Enter 25 USDC.'
            : 'The route runs through H1 to H2: no chain, no waiting. Check the fee, then confirm.',
    done: ctx => ctx.dom.text('receipt-kicker') === 'Paid',
  },
  {
    id: 'receipt',
    chapter: 'Payments',
    title: 'Proof, not a promise',
    instruction: () =>
      'Every account on the route signed a new frame. The receipt keeps the hashlock that settled it. Close it to continue.',
    target: () => 'receipt-done',
    done: ctx => !ctx.dom.has('receipt-done'),
  },
  {
    id: 'receive',
    chapter: 'Payments',
    title: 'Ask to be paid',
    target: ctx =>
      ctx.pathname !== '/receive'
        ? home(ctx, 'home-receive')
        : !ctx.dom.value('receive-amount').trim()
          ? 'receive-amount'
          : 'receive-copy-link',
    instruction: ctx =>
      ctx.pathname !== '/receive'
        ? 'Press Receive.'
        : !ctx.dom.value('receive-amount').trim()
          ? 'Enter an amount to request, for example 10.'
          : 'Copy the payment link. It opens any xln wallet with the amount filled in; the QR code carries the same link.',
    done: ctx => ctx.clicked.has('receive-copy-link'),
  },
  {
    id: 'trade',
    chapter: 'Trading',
    title: 'Swap on the order book',
    target: ctx =>
      ctx.pathname !== '/swap'
        ? home(ctx, 'home-swap')
        : !ctx.dom.value('swap-give').trim()
          ? 'orderbook'
          : creditTarget(ctx),
    instruction: ctx =>
      ctx.pathname !== '/swap'
        ? 'Press Swap.'
        : !ctx.dom.value('swap-give').trim()
          ? 'Choose a sell price in the order book to buy WETH. The book lives on your account with H1.'
          : ctx.dom.has('receive-spectrum-confirm')
            ? 'Decide how you hold the WETH you receive. Accept test credit, then confirm its limit.'
            : 'Review both amounts and place the order. This step completes when WETH arrives.',
    enter: ctx => ctx.baseline.set('weth', Number(weth(ctx))),
    done: ctx => Number(weth(ctx)) > (ctx.baseline.get('weth') ?? Number(weth(ctx))),
  },
  {
    id: 'account',
    chapter: 'Your account',
    title: 'Open your hub account',
    instruction: ctx =>
      onHome(ctx)
        ? 'Everything you did ran through one bilateral account with H1. Open it.'
        : 'Open Home, then your H1 account.',
    target: ctx => home(ctx, 'account-row'),
    done: onAccount,
  },
  {
    id: 'lane',
    chapter: 'Your account',
    title: 'Both sides, one bar',
    detail: true,
    instruction: () =>
      'Left of the notch is what you can send, right is what you can receive. The notch is the balance you both signed; the credit lines are each side’s cap on risk.',
    target: ctx => account(ctx, 'account-lane-USDC'),
  },
  {
    id: 'cover',
    chapter: 'Your account',
    title: 'Turn credit into collateral',
    target: ctx =>
      !onAccount(ctx)
        ? account(ctx, 'account-cover')
        : !ctx.dom.has('collateral-request')
          ? 'account-cover'
          : !ctx.dom.value('collateral-amount').trim()
            ? 'collateral-cover-promise'
            : 'collateral-request',
    instruction: ctx =>
      !ctx.dom.has('collateral-request')
        ? 'H1 owes you money with nothing behind it. Press Cover it to ask H1 to lock collateral on-chain.'
        : !ctx.dom.value('collateral-amount').trim()
          ? 'Fill in exactly what H1 owes you.'
          : 'Send the request. The small fee pays H1’s on-chain cost; watch violet turn green.',
    enter: ctx => ctx.baseline.set('secured', ctx.wallet.usd.secured),
    done: ctx =>
      ctx.wallet.usd.secured > (ctx.baseline.get('secured') ?? ctx.wallet.usd.secured) ||
      (ctx.wallet.usd.risk === 0 && ctx.wallet.usd.secured > 0),
  },
  {
    id: 'dispute',
    chapter: 'Exit rights',
    title: 'Leave without permission',
    instruction: () => 'Open Dispute to see how you would exit this account on your own. You will not start one.',
    target: ctx => account(ctx, 'account-dispute'),
    done: ctx => ctx.dom.has('dispute-prepare'),
  },
  {
    id: 'dispute-close',
    chapter: 'Exit rights',
    title: 'The chain is the referee',
    instruction: () =>
      'A dispute takes your last co-signed frame on-chain. H1 can only answer with a newer frame you both signed, and collateral pays out. No need to exit now: close this.',
    target: () => 'sheet-close',
    done: ctx => !ctx.dom.has('dispute-prepare'),
  },
  {
    id: 'security',
    chapter: 'Safety',
    title: 'Security and recovery',
    instruction: ctx => (onHome(ctx) ? 'Open Security and recovery.' : 'Open Home, then the shield in the corner.'),
    target: ctx => (ctx.pathname === '/sovereignty' ? 'sovereignty-hero' : home(ctx, 'home-sovereignty')),
    done: ctx => ctx.pathname === '/sovereignty',
  },
  {
    id: 'evidence',
    chapter: 'Safety',
    title: 'Keep your proofs',
    instruction: () =>
      'Save the evidence bundle: every frame both sides signed. Any xln runtime can open a dispute from it, even if this device is lost.',
    target: ctx => (ctx.pathname === '/sovereignty' ? 'evidence-export' : home(ctx, 'home-sovereignty')),
    done: ctx => ctx.clicked.has('evidence-export'),
  },
  {
    id: 'history',
    chapter: 'History',
    title: 'Everything in one ledger',
    instruction: () => 'Open Activity.',
    target: () => 'nav-activity',
    done: ctx => ctx.pathname === '/activity',
  },
  {
    id: 'proof',
    chapter: 'History',
    title: 'Open a receipt',
    instruction: () => 'Select your payment. Its receipt shows the frame, the route and the hash you can export.',
    target: ctx => (ctx.pathname === '/activity' ? 'activity-row' : 'nav-activity'),
    done: ctx => ctx.clicked.has('activity-row'),
  },
  {
    id: 'finish',
    chapter: 'Done',
    title: 'You’ve seen all of xln',
    instruction: () =>
      'Credit and collateral, instant payments, order-book swaps, exit by dispute, portable proofs. Replay any chapter from Settings.',
    target: () => '',
  },
];

export const TOUR_CHAPTERS: Array<{ chapter: TourChapter; index: number }> = TOUR_STEPS.reduce<
  Array<{ chapter: TourChapter; index: number }>
>((chapters, step, index) => {
  if (step.chapter !== 'Done' && !chapters.some(entry => entry.chapter === step.chapter))
    chapters.push({ chapter: step.chapter, index });
  return chapters;
}, []);
