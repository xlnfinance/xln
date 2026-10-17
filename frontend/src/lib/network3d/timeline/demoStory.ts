/**
 * The presenter's story: the shipped demo trails in the order they build the argument, from a
 * single payment to unilateral exit. The lobby lists these chapters and each presentation
 * offers the next one at its last step, so both read the order from here.
 */

export type DemoChapter = {
  /** Shipped trail slug: `/demo-trails/<trail>.json`. */
  trail: string;
  title: string;
  /** One line: what the audience will see. */
  see: string;
};

export const DEMO_STORY: readonly DemoChapter[] = [
  {
    trail: 'ahb',
    title: 'Payments through a hub',
    see: 'Alice pays Bob through Hub over two bilateral accounts: collateral covers one leg, a credit limit the other. How final each payment is, how rebalancing works, and what happens when Hub fails.',
  },
  {
    trail: 'lock-ahb',
    title: 'Hash-locked multi-hop payments',
    see: 'One secret ties a payment across several accounts: every hop completes, from payee back to payer, or every lock expires and is refunded.',
  },
  {
    trail: 'swap',
    title: 'FX through a dealer',
    see: 'A dealer matches WETH/USDC orders. Each customer\'s two currency legs change together in its own account with the dealer, and a silent customer is closed out on-chain.',
  },
  {
    trail: 'settle',
    title: 'Netting and on-chain settlement',
    see: 'Two banks pay each other inside their account, then negotiate one settlement: both sign it, and only the net amount moves on the Depository.',
  },
  {
    trail: 'dispute-lifecycle',
    title: 'Unilateral exit and finality',
    see: 'A bank exits alone with the last co-signed state. After the challenge window, its claim is paid from the counterparty\'s reserve.',
  },
];

export type DemoChapterPosition = {
  index: number;
  count: number;
  chapter: DemoChapter;
  next: DemoChapter | null;
};

/** Where a trail sits in the story, or null when it is not a chapter. */
export const demoChapterPosition = (trail: string): DemoChapterPosition | null => {
  const index = DEMO_STORY.findIndex((chapter) => chapter.trail === trail);
  if (index < 0) return null;
  return { index, count: DEMO_STORY.length, chapter: DEMO_STORY[index]!, next: DEMO_STORY[index + 1] ?? null };
};

/** The presentation URL of a chapter. */
export const demoChapterHref = (trail: string): string =>
  `/embed?trail=${encodeURIComponent(trail)}&present=1`;
