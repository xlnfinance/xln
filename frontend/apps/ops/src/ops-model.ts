export type OpsPage =
  | Readonly<{ kind: 'health'; pathname: '/health' }>
  | Readonly<{ kind: 'qa'; pathname: '/qa' }>
  | Readonly<{ kind: 'hlt'; pathname: '/qa/hlt' }>
  | Readonly<{ kind: 'runs'; pathname: '/runs' }>
  | Readonly<{ kind: 'scenarios'; pathname: '/scenarios' }>
  | Readonly<{ kind: 'ai'; pathname: string }>
  | Readonly<{ kind: 'workspace'; pathname: '/__app/ops/entity-workspace' }>
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
  pathname === '/health'
    ? { kind: 'health', pathname }
    : pathname === '/qa'
      ? { kind: 'qa', pathname }
    : pathname === '/qa/hlt'
      ? { kind: 'hlt', pathname }
    : pathname === '/runs'
      ? { kind: 'runs', pathname }
    : pathname === '/scenarios'
      ? { kind: 'scenarios', pathname }
    : pathname === '/ai' || pathname.startsWith('/ai/')
      ? { kind: 'ai', pathname }
    : pathname === '/__app/ops/entity-workspace'
      ? { kind: 'workspace', pathname }
      : { kind: 'pending', pathname };

export const opsPageMetadata = (page: OpsPage): Readonly<{ title: string; description: string }> => {
  if (page.kind === 'health') {
    return {
      title: 'xln System Health',
      description: 'Live Runtime, relay, process, storage, and RPC readiness for xln operators.',
    };
  }
  if (page.kind === 'hlt') {
    return {
      title: 'xln HLT Load Stand',
      description: 'Record, replay, and inspect authoritative xln high-load-test evidence.',
    };
  }
  if (page.kind === 'qa') {
    return {
      title: 'xln QA Cockpit',
      description: 'Inspect authoritative xln test runs, browser evidence, artifacts, and controlled recovery.',
    };
  }
  if (page.kind === 'runs') {
    return {
      title: 'xln Runs Ledger',
      description: 'Inspect authoritative xln run evidence across test, benchmark, scenario, and release surfaces.',
    };
  }
  if (page.kind === 'scenarios') {
    return {
      title: 'xln Scenario Player',
      description: 'Run deterministic xln Runtime scenarios and inspect their committed frames.',
    };
  }
  if (page.kind === 'ai') {
    return {
      title: 'xln AI Console',
      description: 'Local AI chat, council deliberation, agent tools, voice, and camera vision for xln operators.',
    };
  }
  if (page.kind === 'workspace') {
    return {
      title: 'xln Entity Workspace',
      description: 'Identity-first Entity workspace navigation for xln operators.',
    };
  }
  return {
    title: 'xln Ops Candidate',
    description: 'The isolated React candidate for xln operator workflows.',
  };
};
