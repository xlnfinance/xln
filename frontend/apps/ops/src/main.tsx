import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OpsApp } from './ops-app';
import { startOpsHealthRuntime } from './ops-health-runtime';
import { opsPageMetadata, resolveOpsPage } from './ops-model';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('FRONTEND_REACT_ROOT_MISSING');

const page = resolveOpsPage(window.location.pathname);
const metadata = opsPageMetadata(page);
const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
if (!description) throw new Error('OPS_DESCRIPTION_META_MISSING');
document.title = metadata.title;
description.content = metadata.description;

if (page.kind === 'health') startOpsHealthRuntime();
if (page.kind === 'qa') void import('./ops-qa-runtime').then(module => module.startOpsQaRuntime());
if (page.kind === 'hlt') void import('./ops-hlt-runtime').then(module => module.startOpsHltRuntime());
if (page.kind === 'runs') void import('./ops-runs-runtime').then(module => module.startOpsRunsRuntime());
if (page.kind === 'scenarios') void import('./ops-scenarios-runtime').then(module => module.startOpsScenariosRuntime());
if (page.kind === 'ai') void import('./ops-ai-runtime').then(module => module.startOpsAiRuntime());
if (page.kind === 'workspace') {
  void import('./ops-entity-workspace-runtime').then(module => module.startOpsEntityWorkspaceRuntime());
}

createRoot(rootElement).render(
  <StrictMode>
    <OpsApp page={page} />
  </StrictMode>,
);
