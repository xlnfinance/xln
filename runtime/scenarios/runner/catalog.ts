import type { RuntimeReplica } from '../../runtime/types';

// ============================================================================
// SCENARIO REGISTRY - Used by runtime.ts exports and all-scenarios.ts
// ============================================================================

export interface ScenarioMetadata {
  id: string;
  name: string;
  description: string;
  tags: string[];
  run: (env: RuntimeReplica) => Promise<RuntimeReplica | void>;
}

// Lazy-load scenarios - run is async callable that imports on first call
export const SCENARIOS: ScenarioMetadata[] = [
  {
    id: 'settle',
    name: 'Settlement Workspace',
    description: 'Settlement workspace negotiation: propose, update, approve, execute, reject',
    tags: ['settlement', 'core', 'bilateral'],
    run: async (env: RuntimeReplica) => { await (await import('../settlement/settle')).runSettleScenario(env); },
  },
  {
    id: 'ahb',
    name: 'Alice-Hub-Bob Triangle',
    description: 'Full bilateral consensus test with 6 phases, simultaneous payments, rollback verification',
    tags: ['consensus', 'core', 'bilateral'],
    run: async (env: RuntimeReplica) => { await (await import('../consensus/ahb')).ahb(env); },
  },
  {
    id: 'lock-ahb',
    name: 'HTLC Multi-Hop (A→H→B)',
    description: '3-hop onion routed HTLC with encrypted envelopes, automatic secret propagation, fee collection',
    tags: ['htlc', 'routing', 'onion'],
    run: async (env: RuntimeReplica) => { await (await import('../payments/lock-ahb')).lockAhb(env); },
  },
  {
    id: 'htlc-4hop',
    name: 'HTLC 4-Hop Chain',
    description: '4-hop onion routed payment through 3 hubs, fee cascade verification',
    tags: ['htlc', 'routing'],
    run: async (env: RuntimeReplica) => (await import('../payments/htlc-4hop')).htlc4hop(env),
  },
  {
    id: 'swap',
    name: 'Swap Orderbook',
    description: 'Bilateral swap orderbook with limit orders, partial fills, cancel',
    tags: ['swap', 'orderbook'],
    run: async (env: RuntimeReplica) => (await import('../market/swap')).swap(env),
  },
  {
    id: 'swap-market',
    name: 'Multi-Party Swap Market',
    description: '8 traders, 3 orderbooks, realistic market simulation',
    tags: ['swap', 'orderbook', 'stress'],
    run: async (env: RuntimeReplica) => (await import('../market/swap-market')).swapMarket(env),
  },
  {
    id: 'swap-tps',
    name: 'Swap TPS Benchmark',
    description: 'Pure orderbook matcher throughput gate: 100k swaps, minimum 10k TPS',
    tags: ['swap', 'orderbook', 'benchmark'],
    run: async (env: RuntimeReplica) => (await import('../market/swap-tps')).swapTps(env),
  },
  {
    id: 'multi-sig',
    name: 'Multi-Signer BFT',
    description: '2-of-3 threshold consensus, byzantine tolerance, offline validator simulation',
    tags: ['consensus', 'bft', 'multi-sig'],
    run: async (env: RuntimeReplica) => (await import('../consensus/multi-sig')).multiSig(env),
  },
  {
    id: 'rapid-fire',
    name: 'Rapid-Fire Stress Test',
    description: '200 payments in 10s, bidirectional high-load, rollback handling',
    tags: ['stress', 'bilateral'],
    run: async (env: RuntimeReplica) => (await import('../consensus/rapid-fire')).rapidFire(env),
  },
  {
    id: 'processbatch',
    name: 'ProcessBatch Smoke',
    description: 'Isolated hub R→C batch build + j_broadcast + on-chain event finalization',
    tags: ['j-batch', 'rebalance', 'rpc'],
    run: async (env: RuntimeReplica) => { await (await import('../settlement/processbatch')).runProcessBatchScenario(env); },
  },
  {
    id: 'dispute-lifecycle',
    name: 'Dispute Lifecycle',
    description: 'Unilateral dispute lifecycle: start -> finalize -> resume, without bilateral j_event_claim flow',
    tags: ['dispute', 'safety', 'rpc'],
    run: async (env: RuntimeReplica) => (await import('../disputes/lifecycle')).runDisputeLifecycle(env),
  },
  {
    id: 'dispute-transformer',
    name: 'Programmable Dispute Transformer',
    description: 'Real Depository dispute with payment, bilateral HTLC evidence, both swap directions, freeze, and late ACK',
    tags: ['dispute', 'safety', 'htlc', 'swap', 'rpc'],
    run: async (env: RuntimeReplica) => (await import('../disputes/transformer')).runDisputeTransformer(env),
  },
];

export function getScenario(id: string): ScenarioMetadata | undefined {
  return SCENARIOS.find(s => s.id === id);
}

export function getScenariosByTag(tag: string): ScenarioMetadata[] {
  return SCENARIOS.filter(s => s.tags.includes(tag));
}
