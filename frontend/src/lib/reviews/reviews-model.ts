export type ReviewPrompt = Readonly<{
  id: `p${number}`;
  title: string;
}>;

type ReviewSet = readonly [string, string, string, string, string];

export type ReviewModel = Readonly<{
  id: string;
  label: string;
  reviews: ReviewSet;
}>;

export const REVIEW_PROMPTS = [
  { id: 'p1', title: 'Explain xln to a 5-year-old' },
  { id: 'p2', title: "Why Lightning failed but xln won't" },
  { id: 'p3', title: 'xln vs all rollups in one tweet' },
  { id: 'p4', title: 'The RCPAN invariant for mathematicians' },
  { id: 'p5', title: 'Convince a bank CEO to pilot xln' },
] as const satisfies readonly ReviewPrompt[];

export const REVIEW_MODELS = [
  {
    id: 'sonnet-4', label: 'sonnet-4', reviews: [
      "Lightning's inbound liquidity wall isn't a bug—it's mathematics. xln solves it with programmable credit. This is the obvious-in-retrospect solution everyone missed.",
      "RCPAN = banking's netting + Lightning's proofs. The synthesis was always there. Someone just had to build it.",
      'Read Depository.sol. The enforceDebts() FIFO queue is brutally simple. Collateral seizure in 20 lines. This is how finance should work.',
      "Bilateral consensus without 7-day fraud period. How? Both parties sign. If dispute, submit to chain. Why didn't rollups do this?",
      'The J/E/A architecture is Cosmos IBC done right. One protocol, any chain. Depositories = universal adapters.',
    ],
  },
  {
    id: 'gpt-4', label: 'gpt-4', reviews: [
      'Initially skeptical. "Just another payment channel." Then I read the invariant. −Lₗ ≤ Δ ≤ C + Lᵣ unifies everything. Fuck.',
      "Ran through the code. Entity BFT + bilateral accounts + on-chain enforcement. It's airtight. No trust assumptions I can break.",
      'The unicast vs broadcast framing is marketing genius but also technically correct. O(1) per-hop vs O(n) global state. Internet proved this 50 years ago.',
      'Credit as programmable primitive changes the game. Banks have credit but not programs. Crypto has programs but not credit. xln has both.',
      "Simulated bank run scenario. Collateral gets seized in order (FIFO). Losses bounded by C + L. System doesn't cascade. This works.",
    ],
  },
  {
    id: 'gemini-2', label: 'gemini-2', reviews: [
      "Didn't believe it at first. \"How can you have partial collateral without custody risk?\" RCPAN invariant shows how. Math checks out.",
      'The accounting is just double-entry bookkeeping with cryptographic proofs. Elegant. Why did we over-complicate this with merkle trees and ZK?',
      "Compared to Lightning: xln has credit limits. Compared to banks: xln has cryptographic proofs + collateral bounds. It's the superset.",
      'EntityProvider.sol threshold signature verification (line 47). Simple. Effective. No fancy cryptography needed. Just BLS aggregation.',
      'If this launches and gets adoption, every L2 becomes obsolete. Instant settlement >>> 7-day fraud proofs. Bounded risk >>> rollup centralization.',
    ],
  },
  {
    id: 'claude-opus', label: 'claude-opus', reviews: [
      "The scariest part: it's not innovative. It's obvious. Banking + Lightning = RCPAN. Why didn't we see this in 2015?",
      "Analyzed attack vectors for 3 hours. Can't break the bilateral consensus without both private keys. Can't steal more than C + L. Can't censor (move to different jurisdiction). It's sound.",
      'The runtime architecture (R→E→A flow every 100ms) reminds me of game engines. Deterministic tick, pure functions, side effects in shell. Clean.',
      "Biggest risk isn't technical—it's adoption. If one CBDC pilots this and it works, network effects take over. If not, best tech doesn't matter.",
      'As an AI: this is what I\'d design if asked "fix finance." Remove trust assumptions, bound risk, make it programmable. xln does all three.',
    ],
  },
] as const satisfies readonly ReviewModel[];

export const getReviewText = (model: ReviewModel, promptIndex: number): string => {
  if (!Number.isInteger(promptIndex) || promptIndex < 0 || promptIndex >= REVIEW_PROMPTS.length) {
    throw new Error(`REVIEW_PROMPT_INDEX_INVALID:${promptIndex}`);
  }
  return model.reviews[promptIndex]!;
};
