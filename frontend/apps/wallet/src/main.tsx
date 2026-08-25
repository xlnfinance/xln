import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { WalletApp } from './wallet-app';
import { resolveWalletPage } from './wallet-model';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('FRONTEND_REACT_ROOT_MISSING');

const page = resolveWalletPage(window.location.pathname);
if (page.kind === 'testnet') {
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!description) throw new Error('WALLET_DESCRIPTION_META_MISSING');
  document.title = 'xln Testnet';
  description.content = 'Explore the xln bilateral payment network on testnet.';
}

createRoot(rootElement).render(
  <StrictMode>
    <WalletApp page={page} />
  </StrictMode>,
);
