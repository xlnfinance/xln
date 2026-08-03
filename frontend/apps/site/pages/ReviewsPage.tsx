import { useState } from 'react';

import './reviews.css';

const PROMPTS = [
  'Explain xln to a 5-year-old',
  "Why Lightning failed but xln won't",
  'xln vs all rollups in one tweet',
  'The RCPAN invariant for mathematicians',
  'Convince a bank CEO to pilot xln',
] as const;

const REVIEWS = {
  'sonnet-4': [
    "Lightning's inbound liquidity wall isn't a bug—it's mathematics. xln solves it with programmable credit. This is the obvious-in-retrospect solution everyone missed.",
    "RCPAN = banking's netting + Lightning's proofs. The synthesis was always there. Someone just had to build it.",
    'Read Depository.sol. The enforceDebts() FIFO queue is brutally simple. Collateral seizure in 20 lines. This is how finance should work.',
    'Bilateral consensus without a 7-day fraud period: both parties sign, and either can submit the account on dispute.',
    'The J/E/A architecture is Cosmos IBC done right. One protocol, any chain. Depositories are universal adapters.',
  ],
  'gpt-4': [
    'Initially skeptical. Then I read the invariant. −Lₗ ≤ Δ ≤ C + Lᵣ unifies everything.',
    "Entity certification, bilateral accounts, and on-chain fallback form a coherent trust boundary.",
    'The unicast vs broadcast framing is technically correct. O(1) per-hop vs O(n) global state. The internet proved it.',
    'Banks have credit but not programs. Crypto has programs but not credit. xln combines both.',
    'Collateral is allocated in order, losses stay bounded, and the failure does not cascade.',
  ],
  'gemini-2': [
    'The RCPAN invariant explains partial collateral without hiding custody risk. The math is explicit.',
    'Double-entry accounting with cryptographic proofs is a stronger primitive than another global ledger.',
    'Compared with Lightning, xln has credit limits. Compared with banks, xln has proofs and collateral bounds.',
    'Threshold verification is direct and auditable without exotic cryptography.',
    'Instant settlement and bounded risk are a serious alternative to shared sequencer architectures.',
  ],
  'claude-opus': [
    "The striking part is the synthesis: banking plus payment-channel proofs becomes RCPAN.",
    'Bilateral consensus needs both private keys; financial authority stays bounded by collateral and credit.',
    'The deterministic Runtime → Entity → Account flow resembles a clean game engine with effects at the shell.',
    'The primary risk is adoption, not whether the architecture is internally legible.',
    'Remove hidden trust, bound risk, and make settlement programmable: xln addresses all three.',
  ],
} as const;

export default function ReviewsPage() {
  const [selected, setSelected] = useState(0);
  return (
    <div className="reviews-page">
      <header><p className="eyebrow">Independent model reads</p><h1>AI Reviews of xln</h1><p>What happens when frontier models read the architecture, contracts, and runtime?</p></header>
      <nav className="review-prompts" aria-label="Review prompts">
        {PROMPTS.map((prompt, index) => (
          <button type="button" className={selected === index ? 'active' : undefined} onClick={() => setSelected(index)} key={prompt}>
            <span>P{index + 1}</span>{prompt}
          </button>
        ))}
      </nav>
      <section className="review-grid" aria-live="polite">
        {Object.entries(REVIEWS).map(([model, reviews]) => (
          <article key={model}><h2>{model}</h2><blockquote>{reviews[selected]}</blockquote></article>
        ))}
      </section>
      <p className="review-disclaimer">Responses are shown as model output, not product endorsements. Prompts are available in the homepage expert-perspectives section.</p>
    </div>
  );
}
