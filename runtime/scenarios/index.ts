/**
 * XLN Scenario Registry
 * Central export of all scenarios with metadata for frontend integration
 */

import type { Env } from '../types';

export interface ScenarioMetadata {
  id: string;
  name: string;
  description: string;
  tags: string[];
  run: (env: Env) => Promise<void>;
}

// Import scenario functions
import { ahb } from './ahb';
import { lockAhb } from './lock-ahb';
import { swap } from './swap';
import { swapMarket } from './swap-market';
import { rapidFire } from './rapid-fire';
import { multiSig } from './multi-sig';
import { htlc4hop } from './htlc-4hop';

/**
 * All registered scenarios
 * Auto-wired to frontend ArchitectPanel dropdown
 */
export const SCENARIOS: ScenarioMetadata[] = [
  {
    id: 'ahb',
    name: 'Alice-Hub-Bob Triangle',
    description: 'Full bilateral consensus test with 6 phases, simultaneous payments, rollback verification',
    tags: ['consensus', 'core', 'bilateral'],
    run: ahb,
  },
  {
    id: 'lock-ahb',
    name: 'HTLC Multi-Hop (A→H→B)',
    description: '3-hop onion routed HTLC with encrypted envelopes, automatic secret propagation, fee collection',
    tags: ['htlc', 'routing', 'onion'],
    run: lockAhb,
  },
  {
    id: 'htlc-4hop',
    name: 'HTLC 4-Hop Chain',
    description: 'Extended routing path testing envelope forwarding and fee accumulation',
    tags: ['htlc', 'routing'],
    run: htlc4hop,
  },
  {
    id: 'swap',
    name: 'Swap Market (Simple)',
    description: 'Basic swap orderbook with limit orders, fills, cancels',
    tags: ['swap', 'orderbook'],
    run: swap,
  },
  {
    id: 'swap-market',
    name: 'Multi-Party Swap Market',
    description: '8 traders, 3 orderbooks (USDC/ETH, USDC/BTC, USDC/DAI), realistic market simulation',
    tags: ['swap', 'orderbook', 'stress'],
    run: swapMarket,
  },
  {
    id: 'rapid-fire',
    name: 'Rapid-Fire Stress Test',
    description: '200 payments in 10 seconds, bidirectional high-load consensus testing',
    tags: ['stress', 'bilateral'],
    run: rapidFire,
  },
  {
    id: 'multi-sig',
    name: 'Multi-Signer BFT (2-of-3)',
    description: 'Byzantine fault tolerance with threshold consensus, negative tests, offline validator simulation',
    tags: ['consensus', 'bft', 'multi-sig'],
    run: multiSig,
  },
];

/**
 * Get scenario by ID
 */
export function getScenario(id: string): ScenarioMetadata | undefined {
  return SCENARIOS.find(s => s.id === id);
}

/**
 * Get scenarios by tag
 */
export function getScenariosByTag(tag: string): ScenarioMetadata[] {
  return SCENARIOS.filter(s => s.tags.includes(tag));
}
