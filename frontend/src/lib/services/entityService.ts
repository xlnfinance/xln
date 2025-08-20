// Entity Service - Real Entity Creation & Share Management
// Handles numbered entity creation with C/D shares and TradFi-like operations

import { writable, derived, get } from 'svelte/store';
import { jurisdictionService, type EntityShareInfo } from './jurisdictionService';
import { xlnOperations } from '../stores/xlnStore';

// Types for entity management
export interface EntityConfig {
  entityId: string;
  entityNumber: number;
  entityName: string;
  jurisdiction: string;
  validators: string[];
  threshold: number;
  boardHash: string;
  createdAt: number;
  transactionHash?: string;
}

export interface ShareOwnership {
  entityId: string;
  entityNumber: number;
  holder: string;
  cShares: bigint;
  dShares: bigint;
  cPercentage: number;
  dPercentage: number;
  lastUpdated: number;
}

export interface ShareTransfer {
  id: string;
  entityId: string;
  from: string;
  to: string;
  cShares: bigint;
  dShares: bigint;
  timestamp: number;
  transactionHash?: string;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface BoardVote {
  id: string;
  entityId: string;
  proposer: string;
  currentBoardHash: string;
  newBoardHash: string;
  votes: Map<string, 'yes' | 'no' | 'abstain'>;
  cSharesFor: bigint;
  cSharesAgainst: bigint;
  totalCShares: bigint;
  status: 'active' | 'passed' | 'failed' | 'executed';
  createdAt: number;
  executedAt?: number;
}

// Stores
export const entities = writable<Map<string, EntityConfig>>(new Map());
export const shareOwnerships = writable<Map<string, ShareOwnership[]>>(new Map());
export const shareTransfers = writable<ShareTransfer[]>([]);
export const boardVotes = writable<BoardVote[]>([]);
export const isCreatingEntity = writable<boolean>(false);
export const entityError = writable<string | null>(null);

// Derived stores
export const entitiesByJurisdiction = derived(
  entities,
  ($entities) => {
    const byJurisdiction = new Map<string, EntityConfig[]>();
    for (const entity of $entities.values()) {
      const existing = byJurisdiction.get(entity.jurisdiction) || [];
      existing.push(entity);
      byJurisdiction.set(entity.jurisdiction, existing);
    }
    return byJurisdiction;
  }
);

export const activeVotes = derived(
  boardVotes,
  ($votes) => $votes.filter(vote => vote.status === 'active')
);

// Entity Service Implementation
class EntityServiceImpl {
  private nextEntityId = 1;

  async createNumberedEntity(
    entityName: string,
    jurisdiction: string,
    validators: string[],
    threshold: number
  ): Promise<EntityConfig> {
    try {
      isCreatingEntity.set(true);
      entityError.set(null);

      console.log(`🏗️ Creating numbered entity "${entityName}" on ${jurisdiction}`);

      // Generate board hash from validators and threshold
      const boardHash = await this.generateBoardHash(validators, threshold);

      // Create entity on the selected jurisdiction
      const result = await jurisdictionService.createEntity(jurisdiction, boardHash);

      // Create entity configuration
      const entityConfig: EntityConfig = {
        entityId: `0x${result.entityNumber.toString(16).padStart(64, '0')}`,
        entityNumber: result.entityNumber,
        entityName,
        jurisdiction,
        validators,
        threshold,
        boardHash,
        createdAt: Date.now(),
        transactionHash: result.transactionHash
      };

      // Store entity configuration
      const $entities = get(entities);
      $entities.set(entityConfig.entityId, entityConfig);
      entities.set($entities);

      // Initialize share ownership (entity owns 100% of its own shares initially)
      await this.initializeShareOwnership(entityConfig);

      // Create E-machine replica for this entity
      await this.createEntityReplica(entityConfig);

      console.log(`✅ Entity created: ${entityName} (#${result.entityNumber}) on ${jurisdiction}`);
      
      isCreatingEntity.set(false);
      return entityConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create entity';
      entityError.set(errorMessage);
      isCreatingEntity.set(false);
      console.error('❌ Entity creation failed:', error);
      throw error;
    }
  }

  private async generateBoardHash(validators: string[], threshold: number): Promise<string> {
    // Generate a deterministic board hash from validators and threshold
    const data = JSON.stringify({ validators: validators.sort(), threshold });
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async initializeShareOwnership(entity: EntityConfig) {
    // Entity initially owns 100% of its own C and D shares (1 quadrillion each)
    const totalShares = BigInt('1000000000000000'); // 1 quadrillion
    
    const ownership: ShareOwnership = {
      entityId: entity.entityId,
      entityNumber: entity.entityNumber,
      holder: entity.entityName, // Entity owns its own shares initially
      cShares: totalShares,
      dShares: totalShares,
      cPercentage: 100,
      dPercentage: 100,
      lastUpdated: Date.now()
    };

    const $ownerships = get(shareOwnerships);
    $ownerships.set(entity.entityId, [ownership]);
    shareOwnerships.set($ownerships);

    console.log(`💰 Initialized share ownership for ${entity.entityName}: 1Q C-shares, 1Q D-shares`);
  }

  private async createEntityReplica(entity: EntityConfig) {
    try {
      // Create server transactions to import the entity replica for all validators
      const serverTxs = entity.validators.map((signerId, index) => ({
        type: 'importReplica',
        entityId: entity.entityId,
        signerId,
        data: {
          config: {
            validators: entity.validators,
            threshold: entity.threshold,
            shares: Object.fromEntries(entity.validators.map(v => [v, 1])),
            mode: 'proposer-based',
            jurisdiction: {
              name: entity.jurisdiction,
              chainId: 1337,
              entityNumber: entity.entityNumber
            }
          },
          isProposer: index === 0 // First validator is proposer
        }
      }));

      // Apply the server transactions through XLN operations
      await xlnOperations.applyServerInput({ serverTxs });

      console.log(`🔗 Created E-machine replicas for entity ${entity.entityName}`);
    } catch (error) {
      console.error('❌ Failed to create entity replica:', error);
      // Don't throw here - entity creation succeeded, replica creation is secondary
    }
  }

  async transferShares(
    entityId: string,
    from: string,
    to: string,
    cShares: bigint,
    dShares: bigint
  ): Promise<ShareTransfer> {
    try {
      console.log(`📈 Transferring shares for entity ${entityId}: ${from} → ${to}`);

      // Create transfer record
      const transfer: ShareTransfer = {
        id: `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        entityId,
        from,
        to,
        cShares,
        dShares,
        timestamp: Date.now(),
        status: 'pending'
      };

      // Add to transfers list
      const $transfers = get(shareTransfers);
      $transfers.push(transfer);
      shareTransfers.set($transfers);

      // Update ownership records
      await this.updateShareOwnership(entityId, from, to, cShares, dShares);

      // Mark transfer as confirmed (in real implementation, this would wait for blockchain confirmation)
      transfer.status = 'confirmed';
      transfer.transactionHash = `0x${Math.random().toString(16).substr(2, 64)}`;
      shareTransfers.set($transfers);

      console.log(`✅ Share transfer completed: ${transfer.id}`);
      return transfer;
    } catch (error) {
      console.error('❌ Share transfer failed:', error);
      throw error;
    }
  }

  private async updateShareOwnership(
    entityId: string,
    from: string,
    to: string,
    cShares: bigint,
    dShares: bigint
  ) {
    const $ownerships = get(shareOwnerships);
    const entityOwnerships = $ownerships.get(entityId) || [];

    // Find or create ownership records
    let fromOwnership = entityOwnerships.find(o => o.holder === from);
    let toOwnership = entityOwnerships.find(o => o.holder === to);

    if (!fromOwnership) {
      throw new Error(`Holder ${from} not found for entity ${entityId}`);
    }

    if (fromOwnership.cShares < cShares || fromOwnership.dShares < dShares) {
      throw new Error(`Insufficient shares for transfer`);
    }

    // Update from ownership
    fromOwnership.cShares -= cShares;
    fromOwnership.dShares -= dShares;
    fromOwnership.lastUpdated = Date.now();

    // Update or create to ownership
    if (!toOwnership) {
      const entity = get(entities).get(entityId);
      toOwnership = {
        entityId,
        entityNumber: entity?.entityNumber || 0,
        holder: to,
        cShares: BigInt(0),
        dShares: BigInt(0),
        cPercentage: 0,
        dPercentage: 0,
        lastUpdated: Date.now()
      };
      entityOwnerships.push(toOwnership);
    }

    toOwnership.cShares += cShares;
    toOwnership.dShares += dShares;
    toOwnership.lastUpdated = Date.now();

    // Recalculate percentages
    await this.recalculateOwnershipPercentages(entityId, entityOwnerships);

    $ownerships.set(entityId, entityOwnerships);
    shareOwnerships.set($ownerships);
  }

  private async recalculateOwnershipPercentages(entityId: string, ownerships: ShareOwnership[]) {
    const totalCShares = ownerships.reduce((sum, o) => sum + o.cShares, BigInt(0));
    const totalDShares = ownerships.reduce((sum, o) => sum + o.dShares, BigInt(0));

    for (const ownership of ownerships) {
      ownership.cPercentage = totalCShares > 0 ? Number((ownership.cShares * BigInt(10000)) / totalCShares) / 100 : 0;
      ownership.dPercentage = totalDShares > 0 ? Number((ownership.dShares * BigInt(10000)) / totalDShares) / 100 : 0;
    }
  }

  async proposeBoardHashReplacement(
    entityId: string,
    proposer: string,
    newBoardHash: string
  ): Promise<BoardVote> {
    try {
      const entity = get(entities).get(entityId);
      if (!entity) {
        throw new Error(`Entity ${entityId} not found`);
      }

      console.log(`🗳️ Proposing board hash replacement for ${entity.entityName}`);

      const vote: BoardVote = {
        id: `vote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        entityId,
        proposer,
        currentBoardHash: entity.boardHash,
        newBoardHash,
        votes: new Map(),
        cSharesFor: BigInt(0),
        cSharesAgainst: BigInt(0),
        totalCShares: BigInt('1000000000000000'), // 1 quadrillion
        status: 'active',
        createdAt: Date.now()
      };

      const $votes = get(boardVotes);
      $votes.push(vote);
      boardVotes.set($votes);

      console.log(`✅ Board hash replacement proposal created: ${vote.id}`);
      return vote;
    } catch (error) {
      console.error('❌ Failed to propose board hash replacement:', error);
      throw error;
    }
  }

  async castBoardVote(
    voteId: string,
    voter: string,
    choice: 'yes' | 'no' | 'abstain'
  ): Promise<void> {
    try {
      const $votes = get(boardVotes);
      const vote = $votes.find(v => v.id === voteId);
      
      if (!vote) {
        throw new Error(`Vote ${voteId} not found`);
      }

      if (vote.status !== 'active') {
        throw new Error(`Vote ${voteId} is not active`);
      }

      // Get voter's C-share ownership
      const $ownerships = get(shareOwnerships);
      const entityOwnerships = $ownerships.get(vote.entityId) || [];
      const voterOwnership = entityOwnerships.find(o => o.holder === voter);

      if (!voterOwnership || voterOwnership.cShares === BigInt(0)) {
        throw new Error(`Voter ${voter} has no C-shares in entity ${vote.entityId}`);
      }

      // Remove previous vote if exists
      const previousChoice = vote.votes.get(voter);
      if (previousChoice === 'yes') {
        vote.cSharesFor -= voterOwnership.cShares;
      } else if (previousChoice === 'no') {
        vote.cSharesAgainst -= voterOwnership.cShares;
      }

      // Add new vote
      vote.votes.set(voter, choice);
      if (choice === 'yes') {
        vote.cSharesFor += voterOwnership.cShares;
      } else if (choice === 'no') {
        vote.cSharesAgainst += voterOwnership.cShares;
      }

      // Check if vote passes (51% of C-shares)
      const requiredShares = (vote.totalCShares * BigInt(51)) / BigInt(100);
      if (vote.cSharesFor > requiredShares) {
        vote.status = 'passed';
        await this.executeBoardHashReplacement(vote);
      } else if (vote.cSharesAgainst > (vote.totalCShares - requiredShares)) {
        vote.status = 'failed';
      }

      boardVotes.set($votes);

      console.log(`🗳️ Vote cast by ${voter}: ${choice} on ${voteId}`);
    } catch (error) {
      console.error('❌ Failed to cast vote:', error);
      throw error;
    }
  }

  private async executeBoardHashReplacement(vote: BoardVote) {
    try {
      const $entities = get(entities);
      const entity = $entities.get(vote.entityId);
      
      if (!entity) {
        throw new Error(`Entity ${vote.entityId} not found`);
      }

      // Update entity board hash
      entity.boardHash = vote.newBoardHash;
      $entities.set(vote.entityId, entity);
      entities.set($entities);

      // Mark vote as executed
      vote.status = 'executed';
      vote.executedAt = Date.now();

      console.log(`✅ Board hash replacement executed for ${entity.entityName}`);

      // TODO: Update the blockchain contract with new board hash
      // TODO: Create E-machine proposal about the board hash change
    } catch (error) {
      console.error('❌ Failed to execute board hash replacement:', error);
      throw error;
    }
  }

  async getEntityInfo(entityId: string): Promise<EntityConfig | null> {
    const $entities = get(entities);
    return $entities.get(entityId) || null;
  }

  async getShareOwnership(entityId: string): Promise<ShareOwnership[]> {
    const $ownerships = get(shareOwnerships);
    return $ownerships.get(entityId) || [];
  }

  async getEntityTransfers(entityId: string): Promise<ShareTransfer[]> {
    const $transfers = get(shareTransfers);
    return $transfers.filter(t => t.entityId === entityId);
  }

  async getEntityVotes(entityId: string): Promise<BoardVote[]> {
    const $votes = get(boardVotes);
    return $votes.filter(v => v.entityId === entityId);
  }

  // Utility methods
  formatShares(shares: bigint): string {
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

  formatEntityDisplay(entityNumber: number): string {
    return `#${entityNumber}`;
  }

  calculateControlPercentage(cShares: bigint, totalCShares: bigint): number {
    if (totalCShares === BigInt(0)) return 0;
    return Number((cShares * BigInt(10000)) / totalCShares) / 100;
  }

  hasControllingInterest(cShares: bigint, totalCShares: bigint): boolean {
    return this.calculateControlPercentage(cShares, totalCShares) > 51;
  }
}

// Export singleton instance
export const entityService = new EntityServiceImpl();

// Export utility functions
export function formatEntityId(entityNumber: number): string {
  return `#${entityNumber}`;
}

export function formatShares(shares: bigint): string {
  return entityService.formatShares(shares);
}

export function calculateOwnershipPercentage(owned: bigint, total: bigint): number {
  if (total === BigInt(0)) return 0;
  return Number((owned * BigInt(10000)) / total) / 100;
}
