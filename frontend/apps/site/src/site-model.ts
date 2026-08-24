import packageJson from '../../../package.json';

export type SitePage =
  | Readonly<{ kind: 'home' }>
  | Readonly<{ kind: 'install' }>
  | Readonly<{ kind: 'rcpan' }>
  | Readonly<{ kind: 'unicast' }>
  | Readonly<{ kind: 'releases' }>
  | Readonly<{ kind: 'reviews' }>
  | Readonly<{ kind: 'pending'; pathname: string }>;

export type PageMetadata = Readonly<{
  title: string;
  description: string;
}>;

export type InstallChannel = Readonly<{
  id: 'cli' | 'web' | 'desktop' | 'mobile' | 'extension';
  sequence: string;
  title: string;
  label: string;
  summary: string;
  platforms: readonly string[];
  benefit: string;
  tradeoff: string;
  href: string;
  action: string;
  command?: string;
}>;

const normalizePathname = (pathname: string): string => {
  if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#')) {
    throw new Error('SITE_PATHNAME_INVALID');
  }
  return pathname === '/' ? pathname : pathname.replace(/\/+$/, '');
};

export const resolveSitePage = (pathname: string): SitePage => {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') return { kind: 'home' };
  if (normalized === '/install') return { kind: 'install' };
  if (normalized === '/rcpan') return { kind: 'rcpan' };
  if (normalized === '/unicast') return { kind: 'unicast' };
  if (normalized === '/releases') return { kind: 'releases' };
  if (normalized === '/reviews') return { kind: 'reviews' };
  return { kind: 'pending', pathname: normalized };
};

export const getSiteMetadata = (page: SitePage): PageMetadata => {
  if (page.kind === 'home') {
    return {
      title: 'xln — cross-local network',
      description: 'Credit-extended bilateral accounts with mechanical enforcement. Local state, unicast settlement, global reach.',
    };
  }
  if (page.kind === 'install') {
    return {
      title: 'Install xln',
      description: 'Run xln on web, desktop, mobile, Chrome, or as a persistent local runtime.',
    };
  }
  if (page.kind === 'rcpan') {
    return {
      title: 'RCPAN — provable bilateral accounts | xln',
      description: 'Explore bilateral account proofs, shared collateral, programmable disputes, and bounded counterparty risk.',
    };
  }
  if (page.kind === 'unicast') {
    return {
      title: 'Why broadcast dies at scale | xln',
      description: 'Visual proof of the O(n) broadcast bottleneck compared with O(1) unicast routing.',
    };
  }
  if (page.kind === 'releases') {
    return {
      title: 'Releases | xln',
      description: 'xln release history and verified codebase metrics.',
    };
  }
  if (page.kind === 'reviews') {
    return {
      title: 'AI Reviews of xln',
      description: 'Five xln architecture prompts reviewed from four frontier-model perspectives.',
    };
  }
  return {
    title: 'xln — React migration candidate',
    description: 'This public xln route remains on the canonical Svelte application during the React migration.',
  };
};

const launcherUrl = `https://github.com/xlnfinance/xln/releases/download/v${packageJson.version}/xlnfinance-${packageJson.version}.tgz`;
export const LOCAL_RUNTIME_COMMAND = `bunx --bun xlnfinance@${launcherUrl}`;

export const INSTALL_CHANNELS: readonly InstallChannel[] = [
  {
    id: 'cli',
    sequence: '01',
    title: 'Local runtime',
    label: 'Recommended',
    summary: 'One command starts xln as a background service and opens the wallet in your browser.',
    platforms: ['macOS', 'Windows', 'Linux'],
    benefit: 'Persistent runtime with full local wallet control.',
    tradeoff: 'Requires Bun and a terminal.',
    href: 'https://www.npmjs.com/package/xlnfinance',
    action: 'Package details',
    command: LOCAL_RUNTIME_COMMAND,
  },
  {
    id: 'web',
    sequence: '02',
    title: 'Web',
    label: 'Instant',
    summary: 'Open the complete xln application immediately. Nothing to install.',
    platforms: ['Any modern browser'],
    benefit: 'Fastest route into xln.',
    tradeoff: 'Hosted code can be replaced by the server.',
    href: '/app',
    action: 'Open xln',
  },
  {
    id: 'desktop',
    sequence: '03',
    title: 'Desktop',
    label: 'Electron',
    summary: 'A pinned local build with native links, notifications, and background operation.',
    platforms: ['macOS', 'Windows', 'Linux'],
    benefit: 'Local code in a native window.',
    tradeoff: 'OS trust requires signed installers.',
    href: 'https://github.com/xlnfinance/xln/releases/latest',
    action: 'Desktop downloads',
  },
  {
    id: 'mobile',
    sequence: '04',
    title: 'Mobile',
    label: 'Capacitor',
    summary: 'The same wallet packaged for phone and tablet with native deep links.',
    platforms: ['iPhone & iPad', 'Android'],
    benefit: 'Local app bundle with native notifications.',
    tradeoff: 'Distribution depends on each mobile platform.',
    href: 'https://github.com/xlnfinance/xln/releases/latest',
    action: 'Mobile builds',
  },
  {
    id: 'extension',
    sequence: '05',
    title: 'Chrome',
    label: 'Extension',
    summary: 'The complete xln wallet in a pinned Chrome package.',
    platforms: ['Google Chrome'],
    benefit: 'One-click access and invoice links.',
    tradeoff: 'Unsigned builds require Developer mode.',
    href: 'https://github.com/xlnfinance/xln/releases/latest',
    action: 'Download extension',
  },
] as const;
