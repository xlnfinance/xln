export const FEATURED_DOC_IDS = [
  'readme',
  'constraints',
  'intro',
  'core/12_invariant',
  'core/rjea-architecture',
  'status',
  'mainnet',
  'roadmap',
  'implementation/payment-spec',
  'recovery-watchtower-protocol',
];

export const READING_PATHS = [
  {
    id: 'new-to-xln',
    title: 'New to XLN',
    description: 'Problem, invariant, architecture, then the current truth.',
    items: [
      'readme',
      'constraints',
      'intro',
      'core/12_invariant',
      'core/rjea-architecture',
      'status',
    ],
  },
  {
    id: 'launch-and-risk',
    title: 'Launch and Risk',
    description: 'What blocks launch, what the release bar is, and where recovery fits.',
    items: [
      'status',
      'mainnet',
      'consensus-invariants',
      'implementation/payment-spec',
      'recovery-watchtower-protocol',
      'deployment/deployment',
      'deployment/ops-runbook',
    ],
  },
  {
    id: 'runtime-and-storage',
    title: 'Runtime and Storage',
    description: 'Core implementation surfaces for state, transport, and proofs.',
    items: [
      'core/rjea-architecture',
      'merkle',
      'radapter',
      'implementation/payment-spec',
      'debug',
    ],
  },
];

const SECTION_DEFS = [
  {
    id: 'start-here',
    title: 'Start Here',
    description: 'The shortest path to understanding XLN and the current project state.',
    kind: 'live',
    order: 0,
    items: [
      'readme',
      'constraints',
      'intro',
      'core/12_invariant',
      'core/rjea-architecture',
      'status',
      'mainnet',
      'roadmap',
    ],
  },
  {
    id: 'theory',
    title: 'Theory and Narrative',
    description: 'Core theory, conceptual models, and long-form explanation.',
    kind: 'live',
    order: 1,
    items: [
      'core/00_QA',
      'core/10_UFT',
      'core/11_Jurisdiction_Machine',
      'essay',
      'insights/bilateral',
      'architecture/bilaterality',
      'architecture/why-evm',
    ],
  },
  {
    id: 'architecture',
    title: 'Architecture',
    description: 'Protocol structure, contract surface, durable state, and runtime boundaries.',
    kind: 'live',
    order: 2,
    items: [
      'architecture/contracts',
      'architecture/hanko',
      'merkle',
      'radapter',
    ],
  },
  {
    id: 'specs',
    title: 'Specifications',
    description: 'Mechanism-level specs for payments, custody, rebalance, recovery, and code safety.',
    kind: 'live',
    order: 3,
    items: [
      'implementation/payment-spec',
      'custody',
      'rebalance',
      'recovery-watchtower-protocol',
      'fintech-type-safety-protocol',
      'native-wallet-product-plan',
    ],
  },
  {
    id: 'ops',
    title: 'Ops and Debugging',
    description: 'Consensus footguns, debug surfaces, E2E triage, deployment, and operator guidance.',
    kind: 'live',
    order: 4,
    items: [
      'consensus-invariants',
      'debug',
      'debugging/consensus-debugging-guide',
      'e2e-debug-protocol',
      'deployment/deployment',
      'deployment/ops-runbook',
      'code-cleanup-plan',
    ],
  },
  {
    id: 'archive-guide',
    title: 'Archive Guide',
    description: 'What the archive is for and how to use it without treating it as live truth.',
    kind: 'archive',
    order: 10,
    items: ['archive/README'],
  },
  {
    id: 'archive-history',
    title: 'Archive: History',
    description: 'Historical explanations, evolution notes, and superseded reference material.',
    kind: 'archive',
    order: 11,
    items: [
      'archive/evolution-analysis-2019-2025',
      'archive/fixed-supply-analysis',
      'archive/htlc-onion-routing',
      'archive/insurance',
      'archive/novelty',
      'archive/transaction-flow-specification',
      'archive/visual-debugger',
      'archive/architecture/unified-server-design',
    ],
  },
  {
    id: 'archive-planning',
    title: 'Archive: Planning Snapshots',
    description: 'Older status, MVP, launch, and roadmap snapshots preserved for context.',
    kind: 'archive',
    order: 12,
    prefixes: [
      'archive/planning/',
      'archive/old-planning/',
    ],
  },
  {
    id: 'archive-research',
    title: 'Archive: Research',
    description: 'Older research branches, insurance explorations, and rollup/depository position notes.',
    kind: 'archive',
    order: 13,
    prefixes: ['archive/old-research/'],
  },
  {
    id: 'archive-philosophy',
    title: 'Archive: Philosophy',
    description: 'Brand voice, positioning, and old philosophical narratives.',
    kind: 'archive',
    order: 14,
    prefixes: ['archive/old-philosophy/'],
  },
  {
    id: 'archive-deployment',
    title: 'Archive: Deployment',
    description: 'Legacy deploy guides preserved for exact old wording.',
    kind: 'archive',
    order: 15,
    prefixes: ['archive/deployment/'],
  },
  {
    id: 'archive-audits',
    title: 'Archive: Audits and Logs',
    description: 'Historical audits, done logs, and session-level operational records.',
    kind: 'archive',
    order: 16,
    prefixes: [
      'archive/audits/',
      'archive/logs/',
    ],
  },
];

const SECTION_BY_ID = new Map(SECTION_DEFS.map((section) => [section.id, section]));
const DOC_TO_SECTION = new Map();
const DOC_ORDER = new Map();

for (const section of SECTION_DEFS) {
  if (!section.items) continue;
  section.items.forEach((docId, index) => {
    DOC_TO_SECTION.set(docId, section.id);
    DOC_ORDER.set(docId, index);
  });
}

export function normalizeDocId(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.md$/i, '')
    .replace(/^docs\//, '');
}

export function getSectionMeta(sectionId) {
  return SECTION_BY_ID.get(sectionId) || null;
}

export function getSectionOrder(sectionId) {
  return getSectionMeta(sectionId)?.order ?? 999;
}

export function getSectionTitle(sectionId) {
  return getSectionMeta(sectionId)?.title || 'Other';
}

export function getSectionKind(sectionId) {
  return getSectionMeta(sectionId)?.kind || 'live';
}

export function getDocOrder(docId) {
  return DOC_ORDER.get(docId) ?? 999;
}

export function isFeaturedDoc(docId) {
  return FEATURED_DOC_IDS.includes(docId);
}

export function classifyDoc(docId) {
  const normalized = normalizeDocId(docId);
  if (DOC_TO_SECTION.has(normalized)) {
    return DOC_TO_SECTION.get(normalized);
  }

  for (const section of SECTION_DEFS) {
    if (!section.prefixes) continue;
    if (section.prefixes.some((prefix) => normalized.startsWith(prefix))) {
      return section.id;
    }
  }

  if (normalized.startsWith('archive/')) return 'archive-history';
  return 'ops';
}

export function getSectionDefinitions() {
  return SECTION_DEFS.map((section) => ({ ...section }));
}
