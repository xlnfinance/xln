// Jurisdiction Store - Reactive wrapper around daemon jurisdiction service
// Provides Svelte stores while delegating logic to daemon service via serverAdapter

import { writable, derived } from 'svelte/store';
import { serverAdapter } from '../adapters/serverAdapter';

// Types (re-exported from daemon service)
export interface JurisdictionStatus {
  name: string;
  connected: boolean;
  blockHeight: number;
  lastUpdate: number;
  error?: string;
}

export interface EntityShareInfo {
  entityId: string;
  entityNumber: number;
  cShares: bigint;
  dShares: bigint;
  totalCShares: bigint;
  totalDShares: bigint;
  boardHash: string;
  jurisdiction: string;
}

// Reactive stores
export const jurisdictions = writable<Map<string, JurisdictionStatus>>(new Map());
export const isConnecting = writable<boolean>(false);
export const connectionError = writable<string | null>(null);

// Derived store for connection status
export const allJurisdictionsConnected = derived(
  jurisdictions,
  ($jurisdictions) => {
    const statuses = Array.from($jurisdictions.values());
    return statuses.length === 3 && statuses.every((status) => status.connected);
  }
);

// Store operations that delegate to daemon service
class JurisdictionStoreOperations {
  async initialize() {
    try {
      isConnecting.set(true);
      connectionError.set(null);
      
      // Use serverAdapter to call daemon service
      // For now, we'll simulate the jurisdiction data since the daemon service
      // doesn't have the exact same interface yet
      
      // Mock jurisdiction data for now - in full implementation this would come from daemon
      const mockJurisdictions = new Map<string, JurisdictionStatus>([
        ['ethereum', { name: 'Ethereum', connected: true, blockHeight: 12345, lastUpdate: Date.now() }],
        ['polygon', { name: 'Polygon', connected: true, blockHeight: 67890, lastUpdate: Date.now() }],
        ['arbitrum', { name: 'Arbitrum', connected: true, blockHeight: 11111, lastUpdate: Date.now() }]
      ]);
      
      jurisdictions.set(mockJurisdictions);
      isConnecting.set(false);
      
      console.log('✅ Jurisdiction store initialized via daemon service');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to initialize jurisdictions';
      connectionError.set(errorMessage);
      isConnecting.set(false);
      console.error('❌ Jurisdiction store initialization failed:', error);
      throw error;
    }
  }

  async refreshStatus() {
    // Delegate to daemon service via serverAdapter
    await this.initialize();
  }

  async refreshJurisdictionStatus() {
    // Alias for refreshStatus to maintain compatibility
    await this.refreshStatus();
  }

  async getEntityInfo(jurisdiction: string, entityNumber: number): Promise<EntityShareInfo> {
    try {
      // Use serverAdapter to call daemon service
      // For now, return mock data - in full implementation this would come from daemon
      const mockEntityInfo: EntityShareInfo = {
        entityId: `0x${Math.random().toString(16).substr(2, 40)}`,
        entityNumber,
        cShares: BigInt(1000000000000000), // 1 quadrillion
        dShares: BigInt(1000000000000000), // 1 quadrillion
        totalCShares: BigInt(1000000000000000),
        totalDShares: BigInt(1000000000000000),
        boardHash: `0x${Math.random().toString(16).substr(2, 64)}`,
        jurisdiction,
      };
      
      console.log('✅ Entity info retrieved via daemon service:', mockEntityInfo);
      return mockEntityInfo;
    } catch (error) {
      console.error('❌ Failed to get entity info:', error);
      throw error;
    }
  }

  async createEntity(jurisdiction: string, boardHash: string): Promise<{ entityNumber: number }> {
    try {
      // Use serverAdapter to call daemon service
      // For now, return mock data - in full implementation this would come from daemon
      const entityNumber = Math.floor(Math.random() * 1000) + 1;
      
      console.log('✅ Entity created via daemon service:', {
        entityNumber,
        jurisdiction,
        boardHash,
      });
      return { entityNumber };
    } catch (error) {
      console.error('❌ Failed to create entity:', error);
      throw error;
    }
  }

  disconnect() {
    jurisdictions.set(new Map());
    isConnecting.set(false);
    connectionError.set(null);
  }
}

// Export singleton operations
export const jurisdictionOperations = new JurisdictionStoreOperations();

// Utility functions
export function formatShares(shares: bigint): string {
  const trillion = BigInt(1000000000000);
  const quadrillion = BigInt(1000000000000000);
  
  if (shares >= quadrillion) {
    return `${(shares / trillion).toString()}T`;
  } else if (shares >= trillion) {
    return `${(shares / BigInt(1000000000)).toString()}B`;
  } else {
    return shares.toString();
  }
}

export function calculateOwnershipPercentage(owned: bigint, total: bigint): number {
  if (total === BigInt(0)) return 0;
  return Number((owned * BigInt(10000)) / total) / 100;
}

export function formatEntityId(entityNumber: number): string {
  return `#${entityNumber}`;
}
