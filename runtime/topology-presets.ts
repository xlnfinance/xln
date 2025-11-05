/**
 * Topology Presets for Xlnomies
 * 5 economic models: STAR, MESH, TIERED, CORRESPONDENT, HYBRID
 * + Top 9 country presets with flags
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import type { XlnomyTopology, TopologyLayer, ConnectionRules } from './types';

/**
 * Country Economic Presets (Top 9 GDP)
 * Each maps to a real-world financial system topology
 */
export interface CountryPreset {
  name: string;
  flag: string; // Emoji flag
  topology: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid';
  centralBank: string;
  currency: string;
  color: string; // Primary color for visualization
}

export const COUNTRY_PRESETS: CountryPreset[] = [
  {
    name: 'United States',
    flag: '🇺🇸',
    topology: 'star',
    centralBank: 'Federal Reserve',
    currency: 'USD',
    color: '#FFD700' // Gold
  },
  {
    name: 'China',
    flag: '🇨🇳',
    topology: 'tiered',
    centralBank: 'PBOC',
    currency: 'CNY',
    color: '#FF0000' // Red
  },
  {
    name: 'Germany',
    flag: '🇩🇪',
    topology: 'mesh',
    centralBank: 'Bundesbank',
    currency: 'EUR',
    color: '#000000' // Black
  },
  {
    name: 'Japan',
    flag: '🇯🇵',
    topology: 'star',
    centralBank: 'Bank of Japan',
    currency: 'JPY',
    color: '#BC002D' // Red circle
  },
  {
    name: 'India',
    flag: '🇮🇳',
    topology: 'tiered',
    centralBank: 'Reserve Bank of India',
    currency: 'INR',
    color: '#FF9933' // Saffron
  },
  {
    name: 'United Kingdom',
    flag: '🇬🇧',
    topology: 'star',
    centralBank: 'Bank of England',
    currency: 'GBP',
    color: '#C8102E' // UK Red
  },
  {
    name: 'France',
    flag: '🇫🇷',
    topology: 'mesh',
    centralBank: 'Banque de France',
    currency: 'EUR',
    color: '#0055A4' // French Blue
  },
  {
    name: 'Italy',
    flag: '🇮🇹',
    topology: 'mesh',
    centralBank: 'Banca d\'Italia',
    currency: 'EUR',
    color: '#009246' // Italian Green
  },
  {
    name: 'Russia',
    flag: '🇷🇺',
    topology: 'star',
    centralBank: 'Central Bank of Russia',
    currency: 'RUB',
    color: '#FFFFFF' // White
  }
];

/**
 * STAR - USA/Canada Model
 * Fed-centric, no direct interbank, all routing through central hub
 */
export function createStarTopology(): XlnomyTopology {
  const layers: TopologyLayer[] = [
    {
      name: 'Federal Reserve',
      yPosition: 200,
      entityCount: 1,
      xzSpacing: 0,
      color: '#FFD700', // Gold
      size: 10.0,
      emissiveIntensity: 2.0,
      initialReserves: 100_000_000n, // $100M
      canMintMoney: true
    },
    {
      name: 'Commercial Banks',
      yPosition: 100,
      entityCount: 2, // MINIMAL: Reduced from 4 for performance testing
      xzSpacing: 100, // Distance from center
      color: '#00ff41', // Green
      size: 1.0,
      emissiveIntensity: 0.3,
      initialReserves: 1_000_000n, // $1M
      canMintMoney: false
    }
    // MINIMAL: Removed customers layer for performance testing (was 12 entities)
  ];

  const rules: ConnectionRules = {
    allowedPairs: [
      { from: 'Federal Reserve', to: 'Commercial Banks' },
      { from: 'Commercial Banks', to: 'Federal Reserve' }
      // MINIMAL: Removed customer connections
    ],
    allowDirectInterbank: false, // Star topology: no bank-to-bank
    requireHubRouting: true, // All interbank through Fed
    maxHops: 2, // MINIMAL: Reduced from 3
    defaultCreditLimits: new Map([
      ['Federal Reserve→Commercial Banks', 10_000_000n] // Fed can lend $10M
      // MINIMAL: Removed bank→customer limits
    ])
  };

  return {
    type: 'star',
    layers,
    rules,
    crisisThreshold: 0.20,
    crisisMode: 'star' // Stays star even in crisis
  };
}

/**
 * MESH - Eurozone Model
 * P2P interbank market, ECB rarely intervenes
 */
export function createMeshTopology(): XlnomyTopology {
  const layers: TopologyLayer[] = [
    {
      name: 'European Central Bank',
      yPosition: 200,
      entityCount: 1,
      xzSpacing: 0,
      color: '#8B7FB8', // Purple (Ethereum style)
      size: 8.0,
      emissiveIntensity: 1.5,
      initialReserves: 100_000_000n,
      canMintMoney: true
    },
    {
      name: 'Commercial Banks',
      yPosition: 100,
      entityCount: 4,
      xzSpacing: 100,
      color: '#00ff41',
      size: 1.0,
      emissiveIntensity: 0.3,
      initialReserves: 1_000_000n,
      canMintMoney: false
    },
    {
      name: 'Customers',
      yPosition: 0,
      entityCount: 12,
      xzSpacing: 25,
      color: '#0088FF',
      size: 0.5,
      emissiveIntensity: 0.1,
      initialReserves: 10_000n,
      canMintMoney: false
    }
  ];

  const rules: ConnectionRules = {
    allowedPairs: [
      { from: 'European Central Bank', to: 'Commercial Banks' },
      { from: 'Commercial Banks', to: 'European Central Bank' },
      { from: 'Commercial Banks', to: 'Commercial Banks' }, // FULL MESH
      { from: 'Commercial Banks', to: 'Customers' },
      { from: 'Customers', to: 'Commercial Banks' }
    ],
    allowDirectInterbank: true, // Mesh: banks trade P2P
    requireHubRouting: false, // ECB optional
    maxHops: 2,
    defaultCreditLimits: new Map([
      ['European Central Bank→Commercial Banks', 10_000_000n],
      ['Commercial Banks→Commercial Banks', 5_000_000n], // Interbank credit
      ['Commercial Banks→Customers', 100_000n]
    ])
  };

  return {
    type: 'mesh',
    layers,
    rules,
    crisisThreshold: 0.20,
    crisisMode: 'star' // Crisis → force through ECB
  };
}

/**
 * TIERED - China/Japan Model
 * Strict hierarchy, no tier jumping
 */
export function createTieredTopology(): XlnomyTopology {
  const layers: TopologyLayer[] = [
    {
      name: 'PBOC',
      yPosition: 240,
      entityCount: 1,
      xzSpacing: 0,
      color: '#FF0000', // Red (China)
      size: 12.0,
      emissiveIntensity: 2.5,
      initialReserves: 500_000_000n, // $500M
      canMintMoney: true
    },
    {
      name: 'Tier 1 Banks',
      yPosition: 180,
      entityCount: 2,
      xzSpacing: 80,
      color: '#00ff41',
      size: 1.5,
      emissiveIntensity: 0.5,
      initialReserves: 50_000_000n, // $50M
      canMintMoney: false
    },
    {
      name: 'Tier 2 Banks',
      yPosition: 120,
      entityCount: 4,
      xzSpacing: 100,
      color: '#FFFF00', // Yellow
      size: 1.0,
      emissiveIntensity: 0.3,
      initialReserves: 5_000_000n, // $5M
      canMintMoney: false
    },
    {
      name: 'Tier 3 Credit Unions',
      yPosition: 60,
      entityCount: 8,
      xzSpacing: 120,
      color: '#FFA500', // Orange
      size: 0.7,
      emissiveIntensity: 0.2,
      initialReserves: 500_000n, // $500K
      canMintMoney: false
    },
    {
      name: 'Customers',
      yPosition: 0,
      entityCount: 20,
      xzSpacing: 25,
      color: '#0088FF',
      size: 0.5,
      emissiveIntensity: 0.1,
      initialReserves: 10_000n,
      canMintMoney: false
    }
  ];

  const rules: ConnectionRules = {
    allowedPairs: [
      { from: 'PBOC', to: 'Tier 1 Banks' },
      { from: 'Tier 1 Banks', to: 'PBOC' },
      { from: 'Tier 1 Banks', to: 'Tier 2 Banks' },
      { from: 'Tier 2 Banks', to: 'Tier 1 Banks' },
      { from: 'Tier 2 Banks', to: 'Tier 3 Credit Unions' },
      { from: 'Tier 3 Credit Unions', to: 'Tier 2 Banks' },
      { from: 'Tier 3 Credit Unions', to: 'Customers' },
      { from: 'Customers', to: 'Tier 3 Credit Unions' }
    ],
    allowDirectInterbank: false, // Only adjacent tiers
    requireHubRouting: false,
    maxHops: 6, // Full ladder traversal
    defaultCreditLimits: new Map([
      ['PBOC→Tier 1 Banks', 100_000_000n],
      ['Tier 1 Banks→Tier 2 Banks', 10_000_000n],
      ['Tier 2 Banks→Tier 3 Credit Unions', 1_000_000n],
      ['Tier 3 Credit Unions→Customers', 50_000n]
    ])
  };

  return {
    type: 'tiered',
    layers,
    rules,
    crisisThreshold: 0.20,
    crisisMode: 'star' // Crisis → all through PBOC
  };
}

/**
 * CORRESPONDENT - Developing Countries Model
 * Chain topology via correspondent banks
 */
export function createCorrespondentTopology(): XlnomyTopology {
  const layers: TopologyLayer[] = [
    {
      name: 'IMF',
      yPosition: 240,
      entityCount: 1,
      xzSpacing: 0,
      color: '#FFFFFF', // White
      size: 15.0,
      emissiveIntensity: 3.0,
      initialReserves: 1_000_000_000n, // $1B
      canMintMoney: true
    },
    {
      name: 'JPMorgan Correspondent',
      yPosition: 180,
      entityCount: 1,
      xzSpacing: 0,
      color: '#FFD700', // Gold (gateway)
      size: 3.0,
      emissiveIntensity: 1.0,
      initialReserves: 100_000_000n,
      canMintMoney: false
    },
    {
      name: 'Local Banks',
      yPosition: 120,
      entityCount: 4, // Jamaica, Kenya, etc.
      xzSpacing: 150, // Spread wide (different countries)
      color: '#00ff41',
      size: 1.0,
      emissiveIntensity: 0.3,
      initialReserves: 1_000_000n,
      canMintMoney: false
    },
    {
      name: 'Customers',
      yPosition: 0,
      entityCount: 20, // 5 per country
      xzSpacing: 30,
      color: '#0088FF',
      size: 0.5,
      emissiveIntensity: 0.1,
      initialReserves: 10_000n,
      canMintMoney: false
    }
  ];

  const rules: ConnectionRules = {
    allowedPairs: [
      { from: 'IMF', to: 'JPMorgan Correspondent' },
      { from: 'JPMorgan Correspondent', to: 'IMF' },
      { from: 'JPMorgan Correspondent', to: 'Local Banks' },
      { from: 'Local Banks', to: 'JPMorgan Correspondent' },
      { from: 'Local Banks', to: 'Customers' },
      { from: 'Customers', to: 'Local Banks' }
    ],
    allowDirectInterbank: false, // Local banks use correspondent
    requireHubRouting: true, // All via JPMorgan
    maxHops: 4,
    defaultCreditLimits: new Map([
      ['IMF→JPMorgan Correspondent', 500_000_000n],
      ['JPMorgan Correspondent→Local Banks', 10_000_000n],
      ['Local Banks→Customers', 100_000n]
    ])
  };

  return {
    type: 'correspondent',
    layers,
    rules,
    crisisThreshold: 0.20,
    crisisMode: 'star'
  };
}

/**
 * HYBRID - XLN Native Model (RECOMMENDED)
 * Adaptive: Mesh in normal times, Star in crisis
 * Shows best of all worlds
 */
export function createHybridTopology(): XlnomyTopology {
  const layers: TopologyLayer[] = [
    {
      name: 'Federal Reserve',
      yPosition: 220,
      entityCount: 1,
      xzSpacing: 0,
      color: '#FFD700', // Gold (dormant) → explodes during crisis
      size: 10.0,
      emissiveIntensity: 1.0, // Lower when dormant, 3.0 in crisis
      initialReserves: 100_000_000n,
      canMintMoney: true
    },
    {
      name: 'Big Four Banks',
      yPosition: 140,
      entityCount: 4,
      xzSpacing: 100,
      color: '#00ff41',
      size: 1.5,
      emissiveIntensity: 0.5,
      initialReserves: 1_000_000n,
      canMintMoney: false
    },
    {
      name: 'Community Banks',
      yPosition: 80,
      entityCount: 8,
      xzSpacing: 120,
      color: '#FFFF00', // Yellow
      size: 0.8,
      emissiveIntensity: 0.2,
      initialReserves: 100_000n,
      canMintMoney: false
    },
    {
      name: 'Customers',
      yPosition: 0,
      entityCount: 8, // Reduced from 24 for performance
      xzSpacing: 25,
      color: '#0088FF',
      size: 0.5,
      emissiveIntensity: 0.1,
      initialReserves: 10_000n,
      canMintMoney: false
    }
  ];

  const rules: ConnectionRules = {
    allowedPairs: [
      // Fed emergency lines (inactive until crisis)
      { from: 'Federal Reserve', to: 'Big Four Banks' },
      { from: 'Big Four Banks', to: 'Federal Reserve' },
      // Big Four P2P mesh (active daily)
      { from: 'Big Four Banks', to: 'Big Four Banks' },
      // Big Four → Community (correspondent services)
      { from: 'Big Four Banks', to: 'Community Banks' },
      { from: 'Community Banks', to: 'Big Four Banks' },
      // Community P2P (when possible)
      { from: 'Community Banks', to: 'Community Banks' },
      // Banks → Customers
      { from: 'Big Four Banks', to: 'Customers' },
      { from: 'Community Banks', to: 'Customers' },
      { from: 'Customers', to: 'Big Four Banks' },
      { from: 'Customers', to: 'Community Banks' }
    ],
    allowDirectInterbank: true, // Normal mode: mesh
    requireHubRouting: false, // Crisis mode: switches to true
    maxHops: 4,
    defaultCreditLimits: new Map([
      ['Federal Reserve→Big Four Banks', 10_000_000n],
      ['Big Four Banks→Big Four Banks', 5_000_000n],
      ['Big Four Banks→Community Banks', 1_000_000n],
      ['Community Banks→Community Banks', 200_000n],
      ['Big Four Banks→Customers', 100_000n],
      ['Community Banks→Customers', 20_000n]
    ])
  };

  return {
    type: 'hybrid',
    layers,
    rules,
    crisisThreshold: 0.20, // Reserves < 20% deposits → CRISIS MODE
    crisisMode: 'star' // Morph to star during crisis
  };
}

/**
 * Get topology preset by type
 */
export function getTopologyPreset(type: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid'): XlnomyTopology {
  switch (type) {
    case 'star':
      return createStarTopology();
    case 'mesh':
      return createMeshTopology();
    case 'tiered':
      return createTieredTopology();
    case 'correspondent':
      return createCorrespondentTopology();
    case 'hybrid':
      return createHybridTopology();
    default:
      return createHybridTopology(); // Default to HYBRID
  }
}

/**
 * Get topology for a country preset with customizations
 * @param country Country preset configuration
 * @returns Customized topology with country-specific naming and colors
 */
export function getCountryTopology(country: CountryPreset): XlnomyTopology {
  const baseTopology = getTopologyPreset(country.topology);

  // Customize layer names and colors for this country
  const customLayers = baseTopology.layers.map((layer, idx) => {
    if (idx === 0) {
      // First layer = Central Bank
      return {
        ...layer,
        name: country.centralBank,
        color: country.color
      };
    }
    return layer;
  });

  return {
    ...baseTopology,
    layers: customLayers
  };
}
