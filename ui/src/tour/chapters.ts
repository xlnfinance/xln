import { WALLET_LESSONS } from '@xln/frontend/lib/tutorial/curriculum';
import type { TourContext, TourStep } from './steps';

const accountRoute = (ctx: TourContext) =>
  ctx.wallet.accounts[0] ? `/accounts/${ctx.wallet.accounts[0].counterpartyId}` : '/';
const routes: Record<string, { path: string | ((ctx: TourContext) => string); target: string }> = {
  jurisdiction: { path: '/', target: 'jurisdiction-banner' },
  cross: { path: '/swap', target: 'swap-cross-mode' },
  receive: { path: '/receive', target: 'receive-amount' },
  hubs: { path: '/', target: 'home-open-account' },
  limits: { path: accountRoute, target: 'account-extend-credit' },
  move: { path: '/move', target: 'move-from-reserve' },
  withdraw: { path: '/move', target: 'move-from-reserve' },
  lending: { path: '/lend', target: 'lend-amount' },
  borrow: { path: '/lend', target: 'lend-side-borrow' },
  repay: { path: '/lend', target: 'lending-state' },
  protection: { path: '/sovereignty', target: 'sovereignty-watchtower' },
  recovery: { path: '/sovereignty', target: 'sovereignty-watchtower' },
  company: { path: '/ownership', target: 'entity-formation' },
  shares: { path: '/ownership', target: 'shares' },
  governance: { path: '/ownership', target: 'takeover' },
  dispute: { path: accountRoute, target: 'account-dispute' },
};

/** Exploration chapters remain user-paced; opening a screen never claims its financial operation succeeded. */
export const FEATURE_CHAPTERS: TourStep[] = WALLET_LESSONS.slice(4).map(lesson => {
  const destination = routes[lesson.id]!;
  return {
    id: lesson.id,
    title: lesson.title,
    example: lesson.example,
    instruction: () => lesson.id === 'cross'
      ? `Choose Across networks. ${lesson.exercise} Use Clear to complete delivery, or Cancel rest for an unmatched remainder.`
      : lesson.exercise,
    target: () => destination.target,
    route: ctx => (typeof destination.path === 'function' ? destination.path(ctx) : destination.path),
  };
});
