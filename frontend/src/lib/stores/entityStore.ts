// Entity Store - Reactive wrapper around daemon entity service
// Provides Svelte stores while delegating logic to daemon service via serverAdapter

import { writable } from 'svelte/store';
import { serverAdapter } from '../adapters/serverAdapter';

// Types
export interface EntityConfig {
  entityId: string;
  entityNumber?: number;
  name: string;
  validators: string[];
  threshold: number;
  jurisdiction: string;
  type: 'lazy' | 'numbered' | 'named';
}

// Reactive stores
export const entities = writable<Map<string, EntityConfig>>(new Map());
export const isCreatingEntity = writable<boolean>(false);
export const entityError = writable<string | null>(null);

// Store operations that delegate to daemon service
class EntityStoreOperations {
  async createNumberedEntity(
    name: string,
    validators: string[],
    threshold: number,
    jurisdiction: string
  ): Promise<EntityConfig> {
    try {
      isCreatingEntity.set(true);
      entityError.set(null);
      
      // Use serverAdapter to call daemon service
      const result = await serverAdapter.createNumberedEntity(
        name,
        validators,
        BigInt(threshold),
        jurisdiction
      );
      
      const entityConfig: EntityConfig = {
        entityId: result.entityNumber ? `#${result.entityNumber}` : `temp-${Date.now()}`,
        entityNumber: result.entityNumber,
        name,
        validators,
        threshold,
        jurisdiction,
        type: 'numbered'
      };
      
      // Update store
      entities.update(current => {
        const updated = new Map(current);
        updated.set(entityConfig.entityId, entityConfig);
        return updated;
      });
      
      isCreatingEntity.set(false);
      console.log('✅ Entity created via daemon service:', entityConfig);
      
      return entityConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create entity';
      entityError.set(errorMessage);
      isCreatingEntity.set(false);
      console.error('❌ Entity creation failed:', error);
      throw error;
    }
  }

  async createLazyEntity(
    name: string,
    validators: string[],
    threshold: number,
    jurisdiction?: string
  ): Promise<EntityConfig> {
    try {
      isCreatingEntity.set(true);
      entityError.set(null);
      
      // Use serverAdapter to call daemon service
      const result = await serverAdapter.createLazyEntity(
        name,
        validators,
        BigInt(threshold),
        jurisdiction
      );
      
      const entityConfig: EntityConfig = {
        entityId: result.config?.entityId || `lazy-${Date.now()}`,
        name,
        validators,
        threshold,
        jurisdiction: jurisdiction || 'local',
        type: 'lazy'
      };
      
      // Update store
      entities.update(current => {
        const updated = new Map(current);
        updated.set(entityConfig.entityId, entityConfig);
        return updated;
      });
      
      isCreatingEntity.set(false);
      console.log('✅ Lazy entity created via daemon service:', entityConfig);
      
      return entityConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create lazy entity';
      entityError.set(errorMessage);
      isCreatingEntity.set(false);
      console.error('❌ Lazy entity creation failed:', error);
      throw error;
    }
  }

  clearError() {
    entityError.set(null);
  }

  reset() {
    entities.set(new Map());
    isCreatingEntity.set(false);
    entityError.set(null);
  }
}

// Export singleton operations
export const entityOperations = new EntityStoreOperations();
