import { useState } from 'react';

import {
  getReviewText,
  REVIEW_MODELS,
  REVIEW_PROMPTS,
} from '$lib/reviews/reviews-model';
import { SiteFooter, SiteShell } from './site-shell';

type PromptSelectorProps = Readonly<{
  selectedPrompt: number;
  onSelect: (index: number) => void;
}>;

function PromptSelector({ selectedPrompt, onSelect }: PromptSelectorProps) {
  return (
    <nav className="review-prompts" aria-label="Review prompts">
      <span>Question index</span>
      {REVIEW_PROMPTS.map((prompt, index) => <button aria-controls="review-transcript" aria-pressed={selectedPrompt === index} className={selectedPrompt === index ? 'is-active' : undefined} key={prompt.id} onClick={() => onSelect(index)} type="button"><b>{String(index + 1).padStart(2, '0')}</b><span>{prompt.title}</span></button>)}
    </nav>
  );
}

function ReviewTranscript({ selectedPrompt }: Readonly<{ selectedPrompt: number }>) {
  return (
    <div className="review-transcript" id="review-transcript" key={selectedPrompt} aria-live="polite" aria-atomic="true">
      {REVIEW_MODELS.map((model, index) => <article key={model.id}><header><span>{String(index + 1).padStart(2, '0')}</span><strong>{model.label}</strong></header><blockquote>“{getReviewText(model, selectedPrompt)}”</blockquote></article>)}
    </div>
  );
}

export function ReviewsPage() {
  const [selectedPrompt, setSelectedPrompt] = useState(0);
  const prompt = REVIEW_PROMPTS[selectedPrompt];
  if (!prompt) throw new Error('REVIEW_PROMPT_SELECTION_MISSING');
  return (
    <SiteShell activeRoute="/reviews">
      <main className="reviews-page">
        <header className="reviews-header"><div><p className="kicker">Four model perspectives · five questions</p><h1>AI reviews<br />of <em>xln.</em></h1></div><p><strong>112k</strong><span>architecture tokens<br />submitted for review</span></p></header>
        <section className="reviews-workspace" aria-label="AI review transcript">
          <PromptSelector selectedPrompt={selectedPrompt} onSelect={setSelectedPrompt} />
          <div className="review-stage"><header><span>Prompt {String(selectedPrompt + 1).padStart(2, '0')} / {String(REVIEW_PROMPTS.length).padStart(2, '0')}</span><h2>{prompt.title}</h2></header><ReviewTranscript selectedPrompt={selectedPrompt} /></div>
        </section>
        <p className="reviews-disclaimer">These are real responses from GPT-4, Claude Opus, Sonnet 4, and Gemini 2.0. Prompts are available at <a href="/">xln.finance → 10 Expert Perspectives.</a></p>
      </main>
      <SiteFooter />
    </SiteShell>
  );
}
