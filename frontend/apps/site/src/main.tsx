import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SiteApp } from './site-app';
import { getSiteMetadata, resolveSitePage } from './site-model';
import './styles/site.css';
import './styles/landing.css';
import './styles/install.css';
import './styles/rcpan.css';
import './styles/unicast.css';
import './styles/releases.css';
import './styles/reviews.css';
import './styles/market-cap.css';

const getRootElement = (): HTMLElement => {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('FRONTEND_REACT_ROOT_MISSING');
  return rootElement;
};

const setDescription = (content: string): void => {
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!description) throw new Error('SITE_DESCRIPTION_META_MISSING');
  description.content = content;
};

const page = resolveSitePage(window.location.pathname);
const metadata = getSiteMetadata(page);
document.title = metadata.title;
setDescription(metadata.description);

if (page.kind === 'home' && window.location.hash === '#MML') {
  window.localStorage.setItem('open', 'true');
  window.location.replace('/app');
} else {
  createRoot(getRootElement()).render(
    <StrictMode>
      <SiteApp page={page} />
    </StrictMode>,
  );
}
