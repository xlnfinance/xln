export type OpsPage =
  | Readonly<{ kind: 'health'; pathname: '/health' }>
  | Readonly<{ kind: 'pending'; pathname: string }>;

export const OPS_LINKS = [
  { href: '/health', label: 'Health' },
  { href: '/qa', label: 'QA' },
  { href: '/qa/hlt', label: 'HLT' },
  { href: '/runs', label: 'Runs' },
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/ai', label: 'AI' },
  { href: '/embed', label: 'Workspace' },
] as const;

export const resolveOpsPage = (pathname: string): OpsPage =>
  pathname === '/health' ? { kind: 'health', pathname } : { kind: 'pending', pathname };

export const opsPageMetadata = (page: OpsPage): Readonly<{ title: string; description: string }> =>
  page.kind === 'health'
    ? {
      title: 'xln System Health',
      description: 'Live Runtime, relay, process, storage, and RPC readiness for xln operators.',
    }
    : {
      title: 'xln Ops Candidate',
      description: 'The isolated React candidate for xln operator workflows.',
    };
