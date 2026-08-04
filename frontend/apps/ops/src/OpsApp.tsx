import { lazy, Suspense } from 'react';
import { OpsShell } from './OpsShell';
import { resolveOpsRoute } from './ops-route-capabilities';

const pages = {
  health: lazy(() => import('../pages/HealthPage').then(module => ({ default: module.HealthPage }))),
  qa: lazy(() => import('../pages/QaPage').then(module => ({ default: module.QaPage }))),
  runs: lazy(() => import('../pages/RunsPage').then(module => ({ default: module.RunsPage }))),
  scenarios: lazy(() => import('../pages/ScenariosPage').then(module => ({ default: module.ScenariosPage }))),
  ai: lazy(() => import('../pages/AiPage').then(module => ({ default: module.AiPage }))),
  embed: lazy(() => import('../pages/EmbedPage').then(module => ({ default: module.EmbedPage }))),
} as const;

export const OpsApp = () => {
  const route = resolveOpsRoute(window.location.pathname);
  const Page = pages[route.id];
  return (
    <OpsShell route={route}>
      <Suspense fallback={<div className="ops-loading" role="status">Loading {route.id} capability…</div>}>
        <Page />
      </Suspense>
    </OpsShell>
  );
};
