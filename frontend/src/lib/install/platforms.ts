export type InstallStatus = 'available' | 'prepared' | 'distribution-pending';

export type InstallChannel = Readonly<{
  id: 'web' | 'cli' | 'desktop' | 'mobile' | 'extension';
  index: string;
  title: string;
  kicker: string;
  status: InstallStatus;
  statusLabel: string;
  summary: string;
  trustBoundary: string;
  platforms: readonly string[];
  pros: readonly string[];
  limits: readonly string[];
  href: string;
  action: string;
  command?: string;
  commandNote?: string;
}>;

export const INSTALL_CHANNELS: readonly InstallChannel[] = [
  {
    id: 'web',
    index: '01',
    title: 'Web app',
    kicker: 'Zero-install access',
    status: 'available',
    statusLabel: 'Available now',
    summary: 'Open the complete xln interface in a modern browser. Fastest for exploration and simnet use.',
    trustBoundary:
      'The server can deliver different JavaScript on any visit. A wallet loaded from a mutable origin cannot eliminate this risk.',
    platforms: ['Any modern browser', 'Desktop', 'Mobile'],
    pros: ['No installation', 'Always current', 'Works on nearly every device'],
    limits: [
      'Must trust the live server response',
      'Updates cannot be pinned locally',
      'Not recommended for value-bearing use',
    ],
    href: '/app',
    action: 'Open web app',
  },
  {
    id: 'cli',
    index: '02',
    title: 'Bun command',
    kicker: 'Pinned local install',
    status: 'distribution-pending',
    statusLabel: 'Registry pending',
    summary: 'The intended one-command path for technical users, with Bun as the only prerequisite.',
    trustBoundary:
      'A version-pinned package can be audited once and run locally, but the registry package and release provenance must exist first.',
    platforms: ['macOS', 'Windows', 'Linux'],
    pros: ['Short, scriptable install', 'Version can be pinned', 'Good fit for developers and operators'],
    limits: [
      'No xln package is published today',
      'Local package folders are placeholders',
      'Requires Bun and a terminal',
    ],
    href: 'https://github.com/xlnfinance/xln/tree/main/packages/npm',
    action: 'Inspect package source',
    command: 'bunx xlnfinance@0.1.15',
    commandNote: 'Target command — unavailable until the package is published.',
  },
  {
    id: 'desktop',
    index: '03',
    title: 'Desktop app',
    kicker: 'Electron, bundled locally',
    status: 'prepared',
    statusLabel: 'Build preview',
    summary: 'The existing web build runs from a loopback-only server inside a hardened Electron shell.',
    trustBoundary:
      'Packaged code is local and reviewable. Production still needs signed, notarized installers and a verified update channel.',
    platforms: ['macOS implemented', 'Windows planned', 'Linux planned'],
    pros: [
      'No live frontend substitution',
      'Native xln:// links and notifications',
      'Keys stay inside the local wallet runtime',
    ],
    limits: [
      'Current packager emits only an unsigned macOS .app',
      'No installer or auto-update feed',
      'Windows and Linux artifacts are not built yet',
    ],
    href: 'https://github.com/xlnfinance/xln/tree/main/native/desktop',
    action: 'Inspect desktop source',
  },
  {
    id: 'mobile',
    index: '04',
    title: 'Mobile apps',
    kicker: 'Capacitor native shells',
    status: 'prepared',
    statusLabel: 'Native shells ready',
    summary:
      'One static wallet build is already wrapped for iPhone, iPad, and Android with native deep links and notifications.',
    trustBoundary:
      'App-store signatures pin the installed bundle. Release signing, entitlements, privacy metadata, and store review remain.',
    platforms: ['iPhone & iPad', 'Android'],
    pros: ['Local packaged frontend', 'Native notifications and haptics', 'One shared wallet implementation'],
    limits: ['No TestFlight build yet', 'No Google Play release yet', 'Production signing is not configured'],
    href: 'https://github.com/xlnfinance/xln/blob/main/frontend/capacitor.config.ts',
    action: 'Inspect mobile source',
  },
  {
    id: 'extension',
    index: '05',
    title: 'Browser extension',
    kicker: 'Keyless companion',
    status: 'prepared',
    statusLabel: 'Developer preview',
    summary: 'A minimal MV3 companion can receive payment wakes and open xln:// links in the installed wallet.',
    trustBoundary:
      'Signing keys intentionally stay out of the extension until isolated signing and storage receive a dedicated audit.',
    platforms: ['Chrome', 'Edge', 'Chromium'],
    pros: [
      'Tiny permission surface',
      'Connects websites to the local wallet',
      'No wallet keys in browser-extension storage',
    ],
    limits: ['Unpacked installation only', 'Not a standalone wallet', 'No Firefox or Safari package yet'],
    href: 'https://github.com/xlnfinance/xln/tree/main/native/extension',
    action: 'Inspect extension source',
  },
] as const;

export const getInstallReadinessSummary = (channels: readonly InstallChannel[]) => ({
  total: channels.length,
  available: channels.filter(channel => channel.status === 'available').length,
  prepared: channels.filter(channel => channel.status === 'prepared').length,
  pending: channels.filter(channel => channel.status === 'distribution-pending').length,
});
