import type { Env } from '../types';

// ============================================================================
// SCENARIO REGISTRY - Used by runtime.ts exports and all-scenarios.ts
// ============================================================================

export interface ScenarioMetadata {
  id: string;
  name: string;
  description: string;
  tags: string[];
  run: (env: Env) => Promise<void>;
}

// Lazy-load scenarios - run is async callable that imports on first call
export const SCENARIOS: ScenarioMetadata[] = [
  {
    id: 'settle',
    name: 'Settlement Workspace',
    description: 'Settlement workspace negotiation: propose, update, approve, execute, reject',
    tags: ['settlement', 'core', 'bilateral'],
    run: async (env: Env) => { await (await import('./settle')).runSettleScenario(env); },
  },
  {
    id: 'ahb',
    name: 'Alice-Hub-Bob Triangle',
    description: 'Full bilateral consensus test with 6 phases, simultaneous payments, rollback verification',
    tags: ['consensus', 'core', 'bilateral'],
    run: async (env: Env) => (await import('./ahb')).ahb(env),
  },
  {
    id: 'lock-ahb',
    name: 'HTLC Multi-Hop (A→H→B)',
    description: '3-hop onion routed HTLC with encrypted envelopes, automatic secret propagation, fee collection',
    tags: ['htlc', 'routing', 'onion'],
    run: async (env: Env) => (await import('./lock-ahb')).lockAhb(env),
  },
  {
    id: 'htlc-4hop',
    name: 'HTLC 4-Hop Chain',
    description: '4-hop onion routed payment through 3 hubs, fee cascade verification',
    tags: ['htlc', 'routing'],
    run: async (env: Env) => (await import('./htlc-4hop')).htlc4hop(env),
  },
  {
    id: 'swap',
    name: 'Swap Orderbook',
    description: 'Bilateral swap orderbook with limit orders, partial fills, cancel',
    tags: ['swap', 'orderbook'],
    run: async (env: Env) => (await import('./swap')).swap(env),
  },
  {
    id: 'swap-market',
    name: 'Multi-Party Swap Market',
    description: '8 traders, 3 orderbooks, realistic market simulation',
    tags: ['swap', 'orderbook', 'stress'],
    run: async (env: Env) => (await import('./swap-market')).swapMarket(env),
  },
  {
    id: 'multi-sig',
    name: 'Multi-Signer BFT',
    description: '2-of-3 threshold consensus, byzantine tolerance, offline validator simulation',
    tags: ['consensus', 'bft', 'multi-sig'],
    run: async (env: Env) => (await import('./multi-sig')).multiSig(env),
  },
  {
    id: 'rapid-fire',
    name: 'Rapid-Fire Stress Test',
    description: '200 payments in 10s, bidirectional high-load, rollback handling',
    tags: ['stress', 'bilateral'],
    run: async (env: Env) => (await import('./rapid-fire')).rapidFire(env),
  },
  {
    id: 'processbatch',
    name: 'ProcessBatch Smoke',
    description: 'Isolated hub R→C batch build + j_broadcast + on-chain event finalization',
    tags: ['j-batch', 'rebalance', 'rpc'],
    run: async (env: Env) => (await import('./processbatch')).runProcessBatchScenario(env),
  },
  {
    id: 'dispute-lifecycle',
    name: 'Dispute Lifecycle',
    description: 'Unilateral dispute lifecycle: start -> finalize -> resume, without bilateral j_event_claim flow',
    tags: ['dispute', 'safety', 'rpc'],
    run: async (env: Env) => (await import('./dispute-lifecycle')).runDisputeLifecycle(env),
  },
];

export function getScenario(id: string): ScenarioMetadata | undefined {
  return SCENARIOS.find(s => s.id === id);
}

export function getScenariosByTag(tag: string): ScenarioMetadata[] {
  return SCENARIOS.filter(s => s.tags.includes(tag));
}

// ============================================================================
// CODEX-STYLE REGISTRY (for all-scenarios.ts lazy loading)
// ============================================================================

export type ScenarioEntry = {
  key: string;
  name: string;
  load: () => Promise<(env: Env) => Promise<void>>;
  requiresStress?: boolean;
};

export const scenarioRegistry: ScenarioEntry[] = [
  { key: 'settle', name: 'Settlement', load: async () => {
    const { runSettleScenario } = await import('./settle');
    return async (env: Env): Promise<void> => { await runSettleScenario(env); };
  }},
  { key: 'ahb', name: 'AHB', load: async () => (await import('./ahb')).ahb },
  { key: 'lock-ahb', name: 'HTLC AHB', load: async () => (await import('./lock-ahb')).lockAhb },
  { key: 'htlc-4hop', name: 'HTLC 4-Hop', load: async () => (await import('./htlc-4hop')).htlc4hop },
  { key: 'swap', name: 'Swap Trading', load: async () => (await import('./swap')).swap },
  { key: 'swap-market', name: 'Swap Market', load: async () => (await import('./swap-market')).swapMarket },
  { key: 'grid', name: 'Grid', load: async () => (await import('./grid')).grid },
  { key: 'multi-sig', name: 'Multi-Sig', load: async () => (await import('./multi-sig')).multiSig },
  {
    key: 'rapid-fire',
    name: 'Rapid Fire',
    requiresStress: true,
    load: async () => (await import('./rapid-fire')).rapidFire,
  },
  {
    key: 'processbatch',
    name: 'ProcessBatch Smoke',
    load: async () => (await import('./processbatch')).runProcessBatchScenario,
  },
  {
    key: 'dispute-lifecycle',
    name: 'Dispute Lifecycle',
    load: async () => (await import('./dispute-lifecycle')).runDisputeLifecycle,
  },
];
