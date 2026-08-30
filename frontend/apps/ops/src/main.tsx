import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OpsApp } from './ops-app';
import { startOpsHealthRuntime } from './ops-health-runtime';
import { startOpsHltRuntime } from './ops-hlt-runtime';
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
if (page.kind === 'hlt') startOpsHltRuntime();

createRoot(rootElement).render(
  <StrictMode>
    <OpsApp page={page} />
  </StrictMode>,
);
