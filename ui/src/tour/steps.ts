import { FEATURE_CHAPTERS } from './chapters';
import { WALLET_LESSONS } from '@xln/frontend/lib/tutorial/curriculum';
import type { WalletView } from '../runtime/views';

export type TourContext = {
  wallet: WalletView;
  pathname: string;
  baseline: Map<string, bigint>;
  dom: { has(id: string): boolean; value(id: string): string; text(id: string): string };
};
export type TourStep = {
  id: string;
  title: string;
  instruction(ctx: TourContext): string;
  target(ctx: TourContext): string;
  example?: string;
  value?: string;
  outcome?: string;
  prerequisite?: string;
  route?(ctx: TourContext): string;
  done?(ctx: TourContext): boolean;
  enter?(ctx: TourContext): void;
};
const home = (ctx: TourContext, target: string) => (ctx.pathname === '/' ? target : 'nav-home');
const weth = (ctx: TourContext) => ctx.wallet.totals.find(token => token.tokenId === 2)?.net ?? 0n;

/** Each step watches the result of a real action. No acknowledgement pages or automatic financial actions. */
const steps: TourStep[] = [
  {
    id: 'faucet',
    title: 'Get 100 test USDC',
    instruction: ctx =>
      ctx.pathname === '/'
        ? ctx.wallet.accounts.length === 0
          ? 'Open an account with a hub first. Then request 100 test USDC.'
          : 'Get 100 test USDC below your balance. Then send a payment with no real money.'
        : 'Open Home to get your test money.',
    target: ctx => home(ctx, ctx.wallet.accounts.length === 0 ? 'home-open-account' : 'home-faucet'),
    // Starting the guide after funding must never request another payment.
    done: ctx => ctx.wallet.usd.sendCapacity > 0,
  },
  {
    id: 'pay',
    title: 'Send your first payment',
    target: ctx =>
      ctx.dom.has('receipt-open')
        ? 'receipt-open'
        : ctx.pathname !== '/pay'
          ? home(ctx, 'home-pay')
          : ctx.dom.has('pay-recipient-options') || !ctx.dom.value('pay-to').trim()
            ? 'pay-to'
            : !ctx.dom.value('pay-amount').trim()
              ? 'pay-amount'
              : 'pay-submit',
    instruction: ctx =>
      ctx.dom.has('receipt-open')
        ? 'Payment confirmed. Open its receipt when you are ready.'
        : ctx.pathname !== '/pay'
          ? 'Open Pay below your balance. Next, choose H2 and send 25 test USDC.'
          : ctx.dom.has('pay-recipient-options') || !ctx.dom.value('pay-to').trim()
            ? 'Choose a recipient from the suggestions, for example H2.'
            : !ctx.dom.value('pay-amount').trim()
              ? 'Enter 25 USDC.'
              : 'Review the amount and fee, then confirm the payment.',
    done: ctx => ctx.dom.text('receipt-kicker') === 'Paid',
  },
  {
    id: 'trade',
    title: 'Try a swap',
    target: ctx =>
      ctx.dom.has('receipt-done')
        ? 'receipt-done'
        : ctx.pathname !== '/swap'
          ? home(ctx, 'home-swap')
          : !ctx.dom.value('swap-give').trim()
            ? 'swap-give'
            : 'swap-submit',
    instruction: ctx =>
      ctx.dom.has('receipt-done')
        ? 'Payment confirmed. Close the receipt to continue.'
        : ctx.pathname !== '/swap'
          ? 'Press Swap.'
          : !ctx.dom.value('swap-give').trim()
            ? 'Enter 25 in You pay. Leave You receive empty to use the live quote; review it before signing.'
            : 'Review both amounts and the incoming credit notice, then place the order. This step completes when WETH arrives.',
    enter: ctx => ctx.baseline.set('weth', weth(ctx)),
    done: ctx => weth(ctx) > (ctx.baseline.get('weth') ?? weth(ctx)),
  },
  {
    id: 'history',
    title: 'Find your payment and swap',
    instruction: ctx => ctx.pathname === '/activity'
      ? 'Select your payment or filled swap to read its receipt. Compare the amount and status, then choose Next chapter.'
      : 'Open Activity. Select a record to see its amount, status and hashes.',
    target: ctx => ctx.pathname === '/activity' ? 'activity-row' : 'nav-activity',
    // Reading a receipt is user-paced; entering Activity must not immediately navigate away.
  },
  ...FEATURE_CHAPTERS,
  {
    id: 'finish',
    title: 'Keep practising',
    instruction: () =>
      'You have reached the end of the guide. Revisit any exercise you skipped: payments, both kinds of swap, lending, recovery and company control. Each chapter explains the result to verify. Reading a chapter does not prove its transaction completed.',
    target: () => '',
  },
];

export const TOUR_STEPS = steps.map(step => {
  const lesson = WALLET_LESSONS.find(lesson => lesson.id === step.id);
  return { ...step, example: lesson?.example, value: lesson?.value, outcome: lesson?.outcome, prerequisite: lesson?.prerequisite };
});
