export const FEATURED_DOC_IDS = [
  'readme',
  'constraints',
  'competitors',
  'intro',
  'core/12_invariant',
  'core/rjea-architecture',
  'implementation/payment-spec',
  'recovery-watchtower-protocol',
];

export const READING_PATHS = [
  {
    id: 'new-to-xln',
    title: 'New to xln',
    description: 'Constraints, comparison, invariant, then the implementation cascade.',
    items: [
      'readme',
      'constraints',
      'competitors',
      'intro',
      'core/12_invariant',
      'core/rjea-architecture',
    ],
  },
  {
    id: 'launch-and-risk',
    title: 'Launch and risk',
    description: 'Current blockers and release gates, separate from architecture scoring.',
    items: ['status', 'mainnet', 'mainnet-acceptance-gate', 'testnet-flow-coverage'],
  },
  {
    id: 'runtime-and-storage',
    title: 'Runtime and storage',
    description: 'Deterministic execution, persistence, transport, and proofs.',
    items: ['core/rjea-architecture', 'runtime/overview', 'merkle', 'wal', 'radapter'],
  },
];

const SECTION_DEFS = [
  {
    id: 'start-here',
    title: 'Start here',
    description: 'The shortest architecture-first path into xln.',
    kind: 'live',
    order: 0,
    items: ['readme', 'constraints', 'intro', 'core/12_invariant', 'core/rjea-architecture'],
  },
  {
    id: 'theory',
    title: 'Theory',
    description: 'Economic constraints, RCPAN, bilaterality, and jurisdiction theory.',
    kind: 'live',
    order: 1,
    items: [
      'competitors',
      'core/00_QA',
      'core/10_UFT',
      'core/11_Jurisdiction_Machine',
      'architecture/bilaterality',
      'architecture/why-evm',
    ],
  },
  {
    id: 'architecture',
    title: 'Architecture',
    description: 'The canonical cascade, authority, contracts, and durable commitments.',
    kind: 'live',
    order: 2,
    items: [
      'architecture/runtime-reaj',
      'architecture/contracts',
      'architecture/hanko',
      'merkle',
      'protocol-codecs',
      'parallel',
    ],
  },
  {
    id: 'specs',
    title: 'Specifications',
    description: 'Mechanism-level financial and protocol specifications.',
    kind: 'live',
    order: 3,
    items: [
      'implementation/payment-spec',
      'counterfactual-transformers',
      'hashladder-registry-spec',
      'custody',
      'rebalance',
      'lend',
      'recovery-watchtower-protocol',
      'watchtower-services',
      'fintech-type-safety-protocol',
      'fints',
    ],
  },
  {
    id: 'runtime',
    title: 'Runtime and client',
    description: 'Runtime state, networking, storage, adapters, and client boundaries.',
    kind: 'live',
    order: 4,
    items: [
      'runtime/overview',
      'runtime/runtime',
      'runtime/entity',
      'runtime/entity-transactions',
      'runtime/account',
      'runtime/account-transactions',
      'runtime/jurisdiction',
      'runtime/jadapter',
      'runtime/networking',
      'runtime/storage',
      'runtime/recovery',
      'runtime/watchtower',
      'runtime/server',
      'runtime/protocol',
      'runtime/extensions',
      'wal',
      'radapter',
      'external-wallet-state',
    ],
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Current invariants and security policy, not dated audit evidence.',
    kind: 'live',
    order: 5,
    items: [
      'consensus-invariants',
      'mainnet-engineering-principles',
      'security/dispute-two-arguments-spec',
      'security/frozen-core',
      'audit-protocol',
    ],
  },
  {
    id: 'ops',
    title: 'Operations and QA',
    description: 'Debugging, QA, deployment, and distribution surfaces.',
    kind: 'live',
    order: 6,
    items: [
      'debug',
      'debugging/consensus-debugging-guide',
      'e2e-debug-protocol',
      'qa-cockpit',
      'deployment/deployment',
      'deployment/ops-runbook',
      'native-wallet-product-plan',
      'platform-distribution-plan',
    ],
  },
  {
    id: 'launch-and-risk',
    title: 'Launch and risk',
    description: 'Current launch state and release criteria; never an architecture score.',
    kind: 'live',
    order: 7,
    items: ['status', 'mainnet', 'mainnet-acceptance-gate', 'testnet-flow-coverage', 'roadmap'],
  },
  {
    id: 'evidence',
    title: 'Audit and release evidence',
    description: 'Dated or byte-specific evidence excluded from live architecture grounding.',
    kind: 'archive',
    order: 20,
    prefixes: ['audit/', 'releases/', 'security/'],
  },
  {
    id: 'uncatalogued',
    title: 'Uncatalogued reference',
    description: 'Documents require explicit classification before becoming live authority.',
    kind: 'archive',
    order: 21,
  },
];

const SECTION_BY_ID = new Map(SECTION_DEFS.map(section => [section.id, section]));
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

export function getSectionKind(sectionId) {
  return getSectionMeta(sectionId)?.kind || 'archive';
}

export function getDocOrder(docId) {
  return DOC_ORDER.get(docId) ?? 999;
}

export function isFeaturedDoc(docId) {
  return FEATURED_DOC_IDS.includes(docId);
}

const isDatedEvidence = docId => /(?:^|\/)[^/]*\d{4}-\d{2}(?:-\d{2})?(?:$|\/)/.test(docId);

export function classifyDoc(docId) {
  const normalized = normalizeDocId(docId);
  if (DOC_TO_SECTION.has(normalized)) return DOC_TO_SECTION.get(normalized);
  for (const section of SECTION_DEFS) {
    if (section.prefixes?.some(prefix => normalized.startsWith(prefix))) return section.id;
  }
  if (isDatedEvidence(normalized)) return 'evidence';
  return 'uncatalogued';
}

export function getSectionDefinitions() {
  return SECTION_DEFS.map(section => ({ ...section }));
}
