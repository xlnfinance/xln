import packageJson from '../../../package.json';

export type InstallChannel = Readonly<{
  id: 'web' | 'cli' | 'desktop' | 'mobile' | 'extension';
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

const launcherVersion = packageJson.version;
const launcherUrl = `https://github.com/xlnfinance/xln/releases/download/v${launcherVersion}/xlnfinance-${launcherVersion}.tgz`;
export const LOCAL_RUNTIME_COMMAND = `bunx --bun xlnfinance@${launcherUrl}`;

export const INSTALL_CHANNELS: readonly InstallChannel[] = [
  {
    id: 'cli',
    title: 'Local runtime',
    label: 'Recommended',
    summary: 'One command starts xln as a background service and opens the wallet in your browser.',
    platforms: ['macOS', 'Windows', 'Linux'],
    benefit: 'Runtime survives the browser and grants the local wallet full admin control.',
    tradeoff: 'Requires Bun and a terminal.',
    href: 'https://www.npmjs.com/package/xlnfinance',
    action: 'Package details',
    command: LOCAL_RUNTIME_COMMAND,
  },
  {
    id: 'web',
    title: 'Web',
    label: 'Instant',
    summary: 'Open xln immediately. Nothing to install.',
    platforms: ['Any browser'],
    benefit: 'Fastest way to try the complete app.',
    tradeoff: 'The server can replace the code you receive. This is fundamental and cannot be fixed.',
    href: '/app',
    action: 'Open xln',
  },
  {
    id: 'desktop',
    title: 'Desktop',
    label: 'Electron',
    summary: 'A pinned local build with native links and notifications.',
    platforms: ['macOS', 'Windows', 'Linux'],
    benefit: 'Local code, native window, background operation and native links.',
    tradeoff: 'OS trust requires signed installers.',
    href: 'https://github.com/xlnfinance/xln/releases/latest',
    action: 'Desktop downloads',
  },
  {
    id: 'mobile',
    title: 'Mobile',
    label: 'Capacitor',
    summary: 'The same wallet packaged for phone and tablet.',
    platforms: ['iPhone & iPad', 'Android'],
    benefit: 'Native deep links, notifications and local app bundle.',
    tradeoff: 'iOS ships through TestFlight; Android through an APK or Google Play.',
    href: 'https://github.com/xlnfinance/xln/releases/latest',
    action: 'Mobile builds',
  },
  {
    id: 'extension',
    title: 'Chrome',
    label: 'Extension',
    summary: 'The complete xln wallet in a Chrome tab.',
    platforms: ['Google Chrome'],
    benefit: 'Pinned packaged frontend with one-click access and invoice links.',
    tradeoff: 'Unsigned builds use Developer mode; automatic updates require Chrome Web Store.',
    href: 'https://github.com/xlnfinance/xln/releases/latest',
    action: 'Download extension',
  },
] as const;
