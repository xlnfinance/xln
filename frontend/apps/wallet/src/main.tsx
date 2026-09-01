import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { WalletApp } from './wallet-app';
import { resolveWalletAppView } from './app-shell-model';
import { resolveWalletPage, walletPageMetadata } from './wallet-model';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('FRONTEND_REACT_ROOT_MISSING');

const page = resolveWalletPage(window.location.pathname);
const metadata = walletPageMetadata(page);
const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
if (!description) throw new Error('WALLET_DESCRIPTION_META_MISSING');
document.title = metadata.title;
description.content = metadata.description;

if (page.kind === 'app' && resolveWalletAppView(window.location.search, window.location.hash) === 'scenario-preview') {
  void import('./wallet-scenario-preview-runtime').then(module => module.startWalletScenarioPreviewRuntime());
}

createRoot(rootElement).render(
  <StrictMode>
    <WalletApp page={page} />
  </StrictMode>,
);
