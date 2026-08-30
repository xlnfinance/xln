import { lazy, Suspense } from 'react';

import { CandidateShell } from '../../../packages/ui/src/candidate-shell';
import { OpsHealthPage } from './ops-health';
import type { OpsPage } from './ops-model';

const OpsHltPage = lazy(async () => {
  const module = await import('./ops-hlt');
  return { default: module.OpsHltPage };
});

export function OpsApp({ page }: Readonly<{ page: OpsPage }>) {
  if (page.kind === 'health') return <OpsHealthPage />;
  if (page.kind === 'hlt') {
    return <Suspense fallback={<main className="candidate-shell">Loading HLT controls…</main>}><OpsHltPage /></Suspense>;
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
