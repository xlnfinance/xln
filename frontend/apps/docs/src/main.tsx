import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DocsApp } from './docs-app';
import './styles/docs.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('FRONTEND_REACT_ROOT_MISSING');

const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
if (!description) throw new Error('DOCS_DESCRIPTION_META_MISSING');
description.content = 'xln technical documentation — protocol theory, specifications, architecture, operations, and release status.';

createRoot(rootElement).render(<StrictMode><DocsApp /></StrictMode>);
