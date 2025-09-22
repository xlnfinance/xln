/**
 * XLN Utility Functions
 * Platform detection, crypto polyfills, logging, and helper functions
 */

import { toSvg } from 'jdenticon';

import { extractNumberFromEntityId } from './entity-factory';

// Global polyfills for browser compatibility
if (typeof global === 'undefined') {
  (globalThis as any).global = globalThis;
}

// Extend Window interface to include custom properties
declare global {
  interface Window {
    reinitializeAfterClear?: () => void;
  }
}

// Environment detection and compatibility layer
export const isBrowser = typeof window !== 'undefined';

// Simplified crypto compatibility
export const createHash = isBrowser
  ? (algorithm: string) => ({
      update: (data: string) => ({
        digest: (encoding?: string) => {
          // Create proper 32-byte hash for browser demo using Web Crypto API
          const encoder = new TextEncoder();
          const dataBuffer = encoder.encode(data);

          // Simple deterministic hash that produces 32 bytes
          let hash = 0;
          for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32bit integer
          }

          // Create a 32-byte buffer by repeating and expanding the hash
          const baseHash = Math.abs(hash).toString(16).padStart(8, '0');
          const fullHash = (baseHash + baseHash + baseHash + baseHash).slice(0, 64); // 32 bytes = 64 hex chars

          if (encoding === 'hex') {
            return fullHash;
          } else {
            // Return as Buffer (Uint8Array)
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
              bytes[i] = parseInt(fullHash.substr(i * 2, 2), 16);
            }
            return Buffer.from(bytes);
          }
        },
      }),
    })
  : // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('crypto').createHash;

export const randomBytes = isBrowser
  ? (size: number): Uint8Array => {
      const array = new Uint8Array(size);
      crypto.getRandomValues(array);
      return array;
    }
  : // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('crypto').randomBytes;

// Simplified Buffer polyfill for browser
const getBuffer = () => {
  if (isBrowser) {
    return {
      from: (data: any, encoding: string = 'utf8') => {
        if (typeof data === 'string') {
          return new TextEncoder().encode(data);
        }
        return new Uint8Array(data);
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('buffer').Buffer;
};

export const Buffer = getBuffer();

// Browser polyfill for Uint8Array.toString()
if (isBrowser) {
  (Uint8Array.prototype as any).toString = function (encoding: string = 'utf8') {
    return new TextDecoder().decode(this);
  };
  (window as any).Buffer = Buffer;
}

// Debug compatibility
const createDebug = (namespace: string) => {
  const shouldLog =
    namespace.includes('state') ||
    namespace.includes('tx') ||
    namespace.includes('block') ||
    namespace.includes('error') ||
    namespace.includes('diff') ||
    namespace.includes('info');
  return shouldLog ? console.log.bind(console, `[${namespace}]`) : () => {};
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const debug = isBrowser ? createDebug : require('debug');

// Configure debug logging with functional approach
export const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  info: debug('info:ℹ️'),
};

// Hash utility function
export const hash = (data: Buffer | string): Buffer => {
  const result = createHash('sha256').update(data.toString()).digest();
  // Ensure we always return a Buffer, regardless of what digest() returns
  return Buffer.from(result as any);
};

// Global debug flag
export const DEBUG = true;

// Function to clear the database and reset in-memory history
export const clearDatabase = async (db?: any) => {
  console.log('Clearing database and resetting history...');

  if (db) {
    // High-level: Use the provided database instance (Level polyfill)
    await db.clear();
    console.log('✅ Database cleared via provided instance');
  } else {
    // Fallback: Clear the correct database name based on environment
    if (typeof indexedDB !== 'undefined') {
      // Browser: Clear IndexedDB with the same name that Level polyfill uses
      const dbNames = ['db', 'level-js-db', 'level-db']; // Common Level.js database names

      try {
        // Clear all possible database names that Level.js might use
        const clearPromises = dbNames.map(dbName => {
          return new Promise<void>(resolve => {
            const deleteReq = indexedDB.deleteDatabase(dbName);
            deleteReq.onsuccess = () => {
              console.log(`✅ Cleared IndexedDB: ${dbName}`);
              resolve();
            };
            deleteReq.onerror = () => {
              console.log(`⚠️ Could not clear IndexedDB: ${dbName} (may not exist)`);
              resolve(); // Don't fail if database doesn't exist
            };
            deleteReq.onblocked = () => {
              console.log(`⚠️ IndexedDB deletion blocked: ${dbName}`);
              resolve();
            };
          });
        });

        await Promise.all(clearPromises);
        console.log('✅ All databases cleared, re-initializing...');

        // Database cleared successfully
        return;
      } catch (error) {
        console.log('❌ Error clearing IndexedDB:', error);
        return;
      }
    }
  }
  console.log('Database cleared.');
};

// === ENTITY DISPLAY HELPERS ===

/**
 * Format entity ID for display
 * @param entityId - The entity ID to format
 * @returns Human-readable entity name with icon
 */
export const formatEntityDisplay = (entityId: string): string => {
  if (!entityId) {
    return 'undefined';
  }
  
  const number = extractNumberFromEntityId(entityId);
  if (number !== null) {
    // Numbered entity: show just the number with entity icon
    return number.toString();
  } else {
    // Lazy entity: show the full hash
    return entityId;
  }
};

/**
 * Get entity display info with avatar
 * @param entityId - The entity ID
 * @returns Object with display name and avatar
 */
export const getEntityDisplayInfo = (entityId: string): { name: string; avatar: string; type: 'numbered' | 'lazy' } => {
  if (!entityId) {
    return {
      name: 'Entity (undefined)',
      avatar: '❓',
      type: 'numbered',
    };
  }
  
  const number = extractNumberFromEntityId(entityId);
  if (number !== null) {
    return {
      name: `Entity #${number}`,
      avatar: generateEntityAvatar(entityId),
      type: 'numbered',
    };
  } else {
    return {
      name: entityId,
      avatar: generateEntityAvatar(entityId),
      type: 'lazy',
    };
  }
};

// === SIGNER DISPLAY HELPERS ===

/**
 * Demo signer mappings (using Hardhat default addresses)
 */
export const DEMO_SIGNERS = {
  alice: {
    name: 'alice.eth',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  bob: {
    name: 'bob.eth',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  },
  carol: {
    name: 'carol.eth',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
  david: {
    name: 'david.eth',
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  },
  eve: {
    name: 'eve.eth',
    address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  },
};

/**
 * Format signer for display (name.eth with avatar indicator)
 * @param signerId - The signer ID to format
 * @returns Formatted signer display
 */
export const formatSignerDisplay = (signerId: string): string => {
  const signerInfo = DEMO_SIGNERS[signerId as keyof typeof DEMO_SIGNERS];
  if (signerInfo) {
    // Add avatar emoji as visual indicator (would be actual image in UI)
    return `👤 ${signerInfo.name}`;
  }
  // If not a demo signer, assume it's already an address
  return signerId;
};

/**
 * Format signer for display with address tooltip info
 * @param signerId - The signer ID to format
 * @returns Object with display name and address
 */
export const getSignerDisplayInfo = (signerId: string): { name: string; address: string; avatar: string } => {
  const signerInfo = DEMO_SIGNERS[signerId as keyof typeof DEMO_SIGNERS];
  if (signerInfo) {
    return {
      name: signerInfo.name,
      address: signerInfo.address,
      avatar: generateSignerAvatar(signerId),
    };
  }
  return {
    name: signerId,
    address: signerId,
    avatar: generateSignerAvatar(signerId),
  };
};

/**
 * Get address for demo signer
 * @param signerId - The signer ID
 * @returns Ethereum address
 */
export const getSignerAddress = (signerId: string): string => {
  const signerInfo = DEMO_SIGNERS[signerId as keyof typeof DEMO_SIGNERS];
  if (signerInfo) {
    return signerInfo.address;
  }
  // If not a demo signer, assume it's already an address
  return signerId;
};

// === AVATAR GENERATION ===

/**
 * Generate identicon avatar for entity
 * @param entityId - The entity ID to generate avatar for
 * @returns Base64 encoded SVG avatar
 */
export const generateEntityAvatar = (entityId: string): string => {
  try {
    // Use entity ID as seed for deterministic avatar
    const svg = toSvg(entityId, 40); // 40px size
    // Convert SVG to data URL (browser-compatible)
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch (error) {
    // Fallback: simple colored circle
    return generateFallbackAvatar(entityId);
  }
};

/**
 * Generate identicon avatar for signer
 * @param signerId - The signer ID to generate avatar for
 * @returns Base64 encoded SVG avatar
 */
export const generateSignerAvatar = (signerId: string): string => {
  try {
    // Use signer address for avatar generation
    const address = getSignerAddress(signerId);
    const svg = toSvg(address, 32); // 32px size for signers
    // Convert SVG to data URL (browser-compatible)
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch (error) {
    return generateFallbackAvatar(signerId);
  }
};

/**
 * Generate simple fallback avatar (colored circle)
 * @param seed - String to generate color from
 * @returns SVG data URL
 */
const generateFallbackAvatar = (seed: string): string => {
  // Simple hash to generate color
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) & 0xffffffff;
  }

  // Generate HSL color
  const hue = Math.abs(hash) % 360;
  const saturation = 70;
  const lightness = 50;

  const svg = `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
    <circle cx="16" cy="16" r="16" fill="hsl(${hue}, ${saturation}%, ${lightness}%)"/>
  </svg>`;

  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
};
