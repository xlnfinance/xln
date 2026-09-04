import type { RuntimeReplica } from '../../runtime/types';

type BrowserAvailability =
  | { browserSafe: true; browserUnsafeReason?: never }
  | { browserSafe: false; browserUnsafeReason: string };

export type ScenarioMetadata = BrowserAvailability & {
  id: string;
  name: string;
  description: string;
  tags: string[];
  run: (env: RuntimeReplica) => Promise<RuntimeReplica | void>;
  provePersistence?: boolean;
  requiresStress?: boolean;
};

export const SCENARIOS: ScenarioMetadata[] = [
  {
    id: 'rebalance', name: 'Reserve Rebalance',
    description: 'Reserve rebalancing through the settlement pipeline', tags: ['settlement', 'rebalance'],
    browserSafe: false, browserUnsafeReason: 'Requires the external RPC settlement adapter.',
    run: async () => (await import('../settlement/rebalance')).runRebalanceScenario(),
  },
  {
    id: 'lock-ahb', name: 'HTLC Multi-Hop (A→H→B)',
    description: 'Onion-routed HTLC with secret propagation and fee collection', tags: ['htlc', 'routing', 'onion'],
    browserSafe: true, run: async (env) => (await import('../payments/lock-ahb')).lockAhb(env),
  },
  {
    id: 'htlc-lazy', name: 'Lazy-Entity HTLC',
    description: 'HTLC over lazy 1-of-1 entities on TS and Rust authority', tags: ['htlc', 'routing', 'rscore'],
    browserSafe: false, browserUnsafeReason: 'Requires the native Rust authority process.',
    run: async (env) => (await import('../payments/htlc-lazy')).htlcLazy(env),
  },
  {
    id: 'ahb', name: 'Alice-Hub-Bob Triangle',
    description: 'Bilateral consensus, payments, settlement, rollback, and dispute lifecycle', tags: ['consensus', 'core', 'bilateral'],
    browserSafe: true, run: async (env) => { await (await import('../consensus/ahb')).ahb(env); },
  },
  {
    id: 'swap', name: 'Swap Orderbook',
    description: 'Bilateral orderbook with limit orders, partial fills, and cancellation', tags: ['swap', 'orderbook'],
    browserSafe: true, run: async (env) => (await import('../market/swap')).runSwapScenario(env),
  },
  {
    id: 'settle', name: 'Settlement Workspace',
    description: 'Settlement negotiation from proposal through execution or rejection', tags: ['settlement', 'core', 'bilateral'],
    browserSafe: true, run: async (env) => { await (await import('../settlement/settle')).runSettleScenario(env); },
  },
  {
    id: 'htlc-4hop', name: 'HTLC 4-Hop Chain',
    description: 'Four-hop onion payment with fee cascade verification', tags: ['htlc', 'routing'],
    browserSafe: false, browserUnsafeReason: 'Browser adapter coverage is not established for this four-hop runner.',
    run: async (env) => (await import('../payments/htlc-4hop')).htlc4hop(env),
  },
  {
    id: 'grid', name: 'Grid',
    description: 'Multi-entity topology and bilateral consensus grid', tags: ['consensus', 'topology'],
    browserSafe: true, run: async (env) => (await import('../consensus/grid')).grid(env),
  },
  {
    id: 'swap-market', name: 'Multi-Party Swap Market',
    description: 'Eight traders across three orderbooks', tags: ['swap', 'orderbook', 'stress'],
    browserSafe: true, run: async (env) => (await import('../market/swap-market')).swapMarket(env),
  },
  {
    id: 'swap-tps', name: 'Swap TPS Benchmark',
    description: 'Native orderbook throughput benchmark', tags: ['swap', 'orderbook', 'benchmark'],
    browserSafe: false, browserUnsafeReason: 'Benchmark uses Node-only timing and throughput gates.', requiresStress: true,
    run: async (env) => (await import('../market/swap-tps')).swapTps(env),
  },
  {
    id: 'multi-sig', name: 'Multi-Signer BFT',
    description: 'Two-of-three threshold consensus with offline-validator simulation', tags: ['consensus', 'bft', 'multi-sig'],
    browserSafe: false, browserUnsafeReason: 'Browser adapter coverage is not established for threshold-signature setup.',
    run: async (env) => (await import('../consensus/multi-sig')).multiSig(env),
  },
  {
    id: 'company-ipo', name: 'Company IPO Lifecycle',
    description: 'Company formation, share custody, trading, payment, and buyback', tags: ['company', 'governance', 'orderbook'],
    browserSafe: false, browserUnsafeReason: 'Requires the durable persistence proof after execution.', provePersistence: true,
    run: async (env) => (await import('../company-ipo')).companyIpo(env),
  },
  {
    id: 'rapid-fire', name: 'Rapid-Fire Stress Test',
    description: 'Bidirectional high-load payments and rollback handling', tags: ['stress', 'bilateral'],
    browserSafe: true, requiresStress: true,
    run: async (env) => (await import('../consensus/rapid-fire')).rapidFire(env),
  },
  {
    id: 'settle-rebalance', name: 'Settlement Rebalance',
    description: 'Settlement followed by reserve rebalance', tags: ['settlement', 'rebalance'],
    browserSafe: false, browserUnsafeReason: 'Requires the external RPC settlement adapter.',
    run: async (env) => (await import('../settlement/settle-rebalance')).runSettleRebalance(env),
  },
  {
    id: 'processbatch', name: 'ProcessBatch Smoke',
    description: 'Hub batch build, broadcast, and on-chain finalization', tags: ['j-batch', 'rebalance', 'rpc'],
    browserSafe: false, browserUnsafeReason: 'Requires RPC contract deployment and on-chain finalization.',
    run: async (env) => (await import('../settlement/processbatch')).runProcessBatchScenario(env),
  },
  {
    id: 'dispute-lifecycle', name: 'Dispute Lifecycle',
    description: 'Unilateral dispute start, timeout, finalization, and resume', tags: ['dispute', 'safety'],
    browserSafe: true, run: async (env) => (await import('../disputes/lifecycle')).runDisputeLifecycle(env),
  },
  {
    id: 'dispute-transformer', name: 'Programmable Dispute Transformer',
    description: 'Depository dispute with payment, HTLC, swaps, freeze, and late ACK', tags: ['dispute', 'htlc', 'swap', 'rpc'],
    browserSafe: false, browserUnsafeReason: 'Requires a real Depository RPC contract.',
    run: async (env) => (await import('../disputes/transformer')).runDisputeTransformer(env),
  },
  {
    id: 'cross-j', name: 'Cross-Jurisdiction Swap',
    description: 'Swap routed across jurisdiction adapters', tags: ['swap', 'cross-j', 'rpc'],
    browserSafe: false, browserUnsafeReason: 'Requires multiple external jurisdiction adapters.',
    run: async (env) => (await import('../cross-j')).crossJ(env),
  },
  {
    id: 'mm-mesh', name: 'Market-Maker Mesh',
    description: 'Multi-process market-maker mesh scenario', tags: ['market-maker', 'mesh', 'rpc'],
    browserSafe: false, browserUnsafeReason: 'Requires managed OS processes and RPC services.', requiresStress: true,
    run: async (env) => (await import('../cross-j/mm-mesh')).mmMesh(env),
  },
];

export const getScenario = (id: string): ScenarioMetadata | undefined =>
  SCENARIOS.find((scenario) => scenario.id === id);

export const getScenariosByTag = (tag: string): ScenarioMetadata[] =>
  SCENARIOS.filter((scenario) => scenario.tags.includes(tag));

export const getBrowserScenarios = (): ScenarioMetadata[] =>
  SCENARIOS.filter((scenario) => scenario.browserSafe);
