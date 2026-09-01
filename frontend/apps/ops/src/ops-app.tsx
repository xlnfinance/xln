import { lazy, Suspense } from 'react';

import { CandidateShell } from '../../../packages/ui/src/candidate-shell';
import { OpsHealthPage } from './ops-health';
import type { OpsPage } from './ops-model';

const OpsHltPage = lazy(async () => {
  const module = await import('./ops-hlt');
  return { default: module.OpsHltPage };
});

const OpsQaPage = lazy(async () => {
  const module = await import('./ops-qa');
  return { default: module.OpsQaPage };
});

const OpsRunsPage = lazy(async () => {
  const module = await import('./ops-runs');
  return { default: module.OpsRunsPage };
});

const OpsScenariosPage = lazy(async () => {
  const module = await import('./ops-scenarios');
  return { default: module.OpsScenariosPage };
});

const OpsAiPage = lazy(async () => {
  const module = await import('./ops-ai');
  return { default: module.OpsAiPage };
});

export function OpsApp({ page }: Readonly<{ page: OpsPage }>) {
  if (page.kind === 'health') return <OpsHealthPage />;
  if (page.kind === 'qa') {
    return <Suspense fallback={<main className="candidate-shell">Loading QA evidence…</main>}><OpsQaPage /></Suspense>;
  }
  if (page.kind === 'hlt') {
    return <Suspense fallback={<main className="candidate-shell">Loading HLT controls…</main>}><OpsHltPage /></Suspense>;
  }
  if (page.kind === 'runs') {
    return <Suspense fallback={<main className="candidate-shell">Loading run evidence…</main>}><OpsRunsPage /></Suspense>;
  }
  if (page.kind === 'scenarios') {
    return <Suspense fallback={<main className="candidate-shell">Loading deterministic scenarios…</main>}><OpsScenariosPage /></Suspense>;
  }
  if (page.kind === 'ai') {
    return <Suspense fallback={<main className="candidate-shell">Loading AI console…</main>}><OpsAiPage /></Suspense>;
  }
  return (
    <CandidateShell
      copy={{
        eyebrow: 'Operator surface',
        title: 'Ops, independently built.',
        summary: `${page.pathname} remains on the canonical Svelte operator surface while its React workflow is migrated.`,
      }}
      surfaceId="ops"
    />
  );
}
